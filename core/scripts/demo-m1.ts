/**
 * demo-m1 — THE synthetic X1 demo (plan §8.2 M1 acceptance, synthetic edition).
 *
 * Boots the FULL M1 broker (composeBroker: kernel → adaptSessionKernel → WS
 * control-channel gateway) with the three synthetic Claude profiles in a
 * throwaway $AIBENDER_HOME, drives it over the wire exactly like a cockpit
 * client would (bootstrap-file discovery → token auth → frozen control verbs),
 * with the ONE substitution the synthetic edition allows: the QueryRunner is
 * `@aibender/testkit`'s FakeQueryRunner instead of the live SDK spawn path
 * (the live path stays owner-gated — docs/runbooks/kernel-live-spawn.md).
 *
 * What it proves (TAP-style `ok N - …` per assertion; exit 0 only if all hold):
 *   1. bootstrap discovery — the client finds port+token via the 0600 file;
 *   2. three CONCURRENT sessions, one per account label (MAX_A/MAX_B/ENT);
 *   3. per-session env isolation — three distinct CLAUDE_CONFIG_DIR and
 *      CLAUDE_SECURESTORAGE_CONFIG_DIR values, each the label's own dir, and
 *      the provider-hijack scrub held (no ANTHROPIC_API_KEY in any spawn env);
 *   4. ROW BEFORE SPAWN — at QueryRunner.start time every session's ledger
 *      row already exists (state `spawning`) with created_at ≤ spawn time;
 *   5. all three complete and settle at `exited` in the on-disk ledger;
 *   6. un-forked double-resume of a live session is BLOCKED
 *      (`double-resume-blocked`, blueprint §5);
 *   7. one resume+fork works — a continuation child forked from a settled
 *      parent, resuming the parent's native session id;
 *   8. teardown — broker close retracts the bootstrap file.
 *
 * X2: everything here is synthetic — temp dirs, fake runner, placeholder
 * labels. Output scrubs the operator home to $HOME and the temp harness home
 * to $AIBENDER_HOME so the captured transcript stays identifier-free.
 *
 * Run:  pnpm -F aibender-core demo:m1
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateControlResponse,
  type ControlRequest,
  type ControlResponse,
  type Envelope,
} from '@aibender/protocol';
import type { ResumeLedgerStore } from '@aibender/schema';
import { createLogger } from '@aibender/shared';
import { FakeQueryRunner } from '@aibender/testkit';
import { WebSocket as WsClient } from 'ws';

import { readBootstrapFile } from '../src/gateway/index.js';
import { composeBroker } from '../src/main/index.js';

// ---------------------------------------------------------------------------
// Output plumbing — every line is scrubbed before it leaves the process [X2]
// ---------------------------------------------------------------------------

const scrubTargets: Array<{ readonly literal: string; readonly placeholder: string }> = [];

function scrub(line: string): string {
  let out = line;
  for (const { literal, placeholder } of scrubTargets) {
    out = out.split(literal).join(placeholder);
  }
  return out;
}

function say(line: string): void {
  console.log(scrub(line));
}

let assertions = 0;
let failures = 0;

function check(condition: boolean, description: string, detail?: string): void {
  assertions += 1;
  if (condition) {
    say(`ok ${assertions} - ${description}`);
  } else {
    failures += 1;
    say(`not ok ${assertions} - ${description}${detail !== undefined ? ` :: ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Minimal frozen-protocol WS client (mirrors the composition-spec WireClient)
// ---------------------------------------------------------------------------

class WireClient {
  private seq = 0;
  private readonly pending = new Map<string, (response: ControlResponse) => void>();

  private constructor(private readonly ws: WsClient) {
    ws.on('message', (data) => {
      const envelope = JSON.parse(String(data)) as Envelope;
      if (envelope.channel !== 'control') return;
      // Golden cross-check: every broker response must pass the FROZEN
      // client-side validator before the demo accepts it.
      const parsed = validateControlResponse(envelope.payload);
      if (!parsed.ok) return;
      const resolve = this.pending.get(parsed.value.id);
      if (resolve !== undefined) {
        this.pending.delete(parsed.value.id);
        resolve(parsed.value);
      }
    });
    ws.on('error', () => {
      /* teardown close races are expected */
    });
  }

  static async connect(url: string, token: string): Promise<WireClient> {
    const ws = new WsClient(`${url}/?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new WireClient(ws);
  }

  async request(request: ControlRequest, timeoutMs = 5000): Promise<ControlResponse> {
    const response = new Promise<ControlResponse>((resolve, reject) => {
      this.pending.set(request.id, resolve);
      setTimeout(() => {
        if (this.pending.delete(request.id)) {
          reject(new Error(`timed out awaiting a response to ${request.id}`));
        }
      }, timeoutMs).unref();
    });
    const envelope: Envelope = {
      stream: 'control',
      channel: 'control',
      seq: this.seq++,
      payload: request,
    };
    this.ws.send(JSON.stringify(envelope));
    return response;
  }

  close(): void {
    this.ws.close();
  }
}

let requestCounter = 0;
const nextId = (): string => `req_demo_${++requestCounter}`;

function okResult(response: ControlResponse): Extract<ControlResponse, { ok: true }>['result'] {
  if (!response.ok) {
    throw new Error(`expected ok response, got error ${JSON.stringify(response.error)}`);
  }
  return response.result;
}

function errDetail(response: ControlResponse): Extract<ControlResponse, { ok: false }>['error'] {
  if (response.ok) throw new Error('expected an error response, got ok');
  return response.error;
}

/** Poll the ledger until the row reaches `state` (the pump settles async). */
async function awaitLedgerState(
  ledger: ResumeLedgerStore,
  sessionId: string,
  state: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ledger.get(sessionId)?.state === state) return;
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} never reached ${state}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// The demo
// ---------------------------------------------------------------------------

const LABELS = ['MAX_A', 'MAX_B', 'ENT'] as const;
const ACCOUNT_DIRS: Record<(typeof LABELS)[number], string> = {
  MAX_A: 'max-a',
  MAX_B: 'max-b',
  ENT: 'ent',
};

interface SpawnRecord {
  readonly sessionId: string;
  readonly rowStateAtSpawn: string | undefined;
  readonly rowCreatedAtIso: string | undefined;
  readonly spawnAtIso: string;
}

async function run(): Promise<number> {
  say('# demo-m1 — synthetic X1: three accounts, one broker (plan §8.2 M1)');

  // Throwaway harness home: three synthetic per-account profile dirs.
  const home = await mkdtemp(join(tmpdir(), 'aibender-demo-m1-'));
  scrubTargets.push({ literal: home, placeholder: '$AIBENDER_HOME' });
  scrubTargets.push({ literal: homedir(), placeholder: '$HOME' });

  try {
    for (const label of LABELS) {
      await mkdir(join(home, 'accounts', ACCOUNT_DIRS[label]), { recursive: true, mode: 0o700 });
    }
    await mkdir(join(home, 'db'), { recursive: true, mode: 0o700 });
    say(`# harness home: $AIBENDER_HOME (accounts/{max-a,max-b,ent}, db/)`);

    // The fake runner records every QuerySpec; the onStart hook observes the
    // ledger AT SPAWN TIME — that is the row-before-spawn proof.
    let ledger: ResumeLedgerStore | undefined;
    const spawnRecords: SpawnRecord[] = [];
    const runner = new FakeQueryRunner({
      mode: 'manual',
      providePids: true,
      onStart: (spec) => {
        const row = ledger?.get(spec.sessionId);
        spawnRecords.push({
          sessionId: spec.sessionId,
          rowStateAtSpawn: row?.state,
          rowCreatedAtIso: row?.createdAtIso,
          spawnAtIso: new Date().toISOString(),
        });
      },
    });

    // Boot the broker: real kernel, real on-disk SQLite ledger, real WS
    // gateway + bootstrap file — fake spawn path only.
    const broker = await composeBroker({
      storePath: join(home, 'db', 'kernel.db'),
      profiles: { aibenderHome: home },
      runner,
      baseEnv: {
        PATH: '/usr/bin',
        // Provider-hijack scrub input: must NOT survive into any spawn env.
        ANTHROPIC_API_KEY: 'SYNTHETIC-SCRUB-ME-NOT-A-KEY',
      },
      gateway: {
        aibenderHome: home,
        // Route gateway log lines through the demo's scrubbed sink [X2].
        logger: createLogger({ sink: (record) => say(JSON.stringify(record)) }),
      },
    });
    ledger = broker.store.resumeLedger;

    try {
      // 1 — bootstrap discovery, the way a real client finds the broker.
      const advertised = await readBootstrapFile({ aibenderHome: home });
      check(
        advertised !== undefined &&
          advertised.port === broker.gateway.port &&
          advertised.token === broker.gateway.token,
        'bootstrap file advertises this boot (port + per-boot token discovered)',
      );
      const client = await WireClient.connect(
        `ws://127.0.0.1:${advertised?.port ?? broker.gateway.port}`,
        advertised?.token ?? broker.gateway.token,
      );

      try {
        // 2 — three CONCURRENT launches, one per account label, over the wire.
        const launches = await Promise.all(
          LABELS.map(async (accountLabel) =>
            okResult(
              await client.request({
                kind: 'launch',
                id: nextId(),
                params: {
                  accountLabel,
                  backend: 'claude_code',
                  substrate: 'sdk',
                  cwd: '/synthetic/workspace',
                  purpose: `synthetic X1 demo (${accountLabel})`,
                  prompt: `synthesized demo prompt for ${accountLabel}`,
                },
              }),
            ),
          ),
        );
        const sessionByLabel = new Map<string, string>();
        for (const [i, result] of launches.entries()) {
          if (result.verb !== 'launch') throw new Error('expected a launch result');
          sessionByLabel.set(LABELS[i] as string, result.sessionId);
          say(`# launched ${LABELS[i]} -> ${result.sessionId} (state ${result.state})`);
        }
        const sessionIds = [...sessionByLabel.values()];
        check(
          launches.every((l) => l.verb === 'launch' && l.state === 'running') &&
            new Set(sessionIds).size === 3,
          'three sessions launched, one per account label, all running',
        );
        check(
          sessionIds.every((id) => broker.kernel.isLive(id)),
          'all three sessions are live in the broker AT THE SAME TIME',
        );

        // 3 — per-session env isolation from the recorded spawn specs.
        const configDirs = new Set<string>();
        const secureDirs = new Set<string>();
        let envPerLabelOk = true;
        let scrubHeld = true;
        for (const spec of runner.starts) {
          const row = ledger.get(spec.sessionId);
          const label = row?.accountLabel as (typeof LABELS)[number];
          const expectedDir = join(home, 'accounts', ACCOUNT_DIRS[label]);
          const configDir = spec.env['CLAUDE_CONFIG_DIR'];
          const secureDir = spec.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'];
          if (configDir !== expectedDir || secureDir !== expectedDir) envPerLabelOk = false;
          if (configDir !== undefined) configDirs.add(configDir);
          if (secureDir !== undefined) secureDirs.add(secureDir);
          if ('ANTHROPIC_API_KEY' in spec.env) scrubHeld = false;
          say(`#   ${label} env CLAUDE_CONFIG_DIR=${configDir ?? '<missing>'}`);
          say(`#   ${label} env CLAUDE_SECURESTORAGE_CONFIG_DIR=${secureDir ?? '<missing>'}`);
        }
        check(
          configDirs.size === 3 && secureDirs.size === 3,
          'three DISTINCT CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR values',
        );
        check(envPerLabelOk, "each session's dirs are its own account's profile dirs");
        check(scrubHeld, 'provider-hijack scrub held: no ANTHROPIC_API_KEY in any spawn env');

        // 4 — row before spawn (SPIKE-D vii discipline).
        check(
          spawnRecords.length === 3 &&
            spawnRecords.every((r) => r.rowStateAtSpawn === 'spawning'),
          'at spawn time every ledger row already existed in state `spawning`',
        );
        check(
          spawnRecords.every(
            (r) =>
              r.rowCreatedAtIso !== undefined &&
              Date.parse(r.rowCreatedAtIso) <= Date.parse(r.spawnAtIso),
          ),
          'every ledger row was written BEFORE its spawn timestamp',
        );

        // 6 (before completion, while the session is provably live) —
        // un-forked double-resume of a RUNNING session is blocked.
        const parentLabel = 'MAX_A';
        const parentId = sessionByLabel.get(parentLabel);
        if (parentId === undefined) throw new Error('missing parent session');
        const blocked = errDetail(
          await client.request({
            kind: 'resume',
            id: nextId(),
            params: { sessionId: parentId, prompt: 'synthesized illegal double-resume' },
          }),
        );
        check(
          blocked.code === 'double-resume-blocked',
          `un-forked resume of the live ${parentLabel} session is BLOCKED (${blocked.code})`,
        );

        // 5 — complete all three; the pump settles each row at `exited`.
        for (const id of sessionIds) {
          runner.session(id).complete();
        }
        for (const id of sessionIds) {
          await awaitLedgerState(ledger, id, 'exited');
        }
        check(
          sessionIds.every(
            (id) => ledger?.get(id)?.state === 'exited' && !broker.kernel.isLive(id),
          ),
          'all three sessions completed and settled at `exited` in the ledger',
        );

        // 7 — one resume+fork: continuation child from the settled parent.
        const forked = okResult(
          await client.request({
            kind: 'resume',
            id: nextId(),
            params: { sessionId: parentId, fork: true, prompt: 'synthesized branch prompt' },
          }),
        );
        if (forked.verb !== 'resume') throw new Error('expected a resume result');
        say(`# resume+fork ${parentLabel} ${parentId} -> child ${forked.sessionId}`);
        const forkSpec = runner.starts.at(-1);
        const parentNativeId = ledger.get(parentId)?.nativeSessionId;
        check(
          forked.forkedFrom === parentId &&
            forked.sessionId !== parentId &&
            forkSpec?.forkSession === true &&
            parentNativeId !== null &&
            forkSpec?.resumeNativeSessionId === parentNativeId,
          "resume+fork works: continuation child resumes the parent's native session",
        );
        runner.session(forked.sessionId).complete();
        await awaitLedgerState(ledger, forked.sessionId, 'exited');
        check(
          ledger.get(forked.sessionId)?.state === 'exited' &&
            ledger.list().length === 4,
          'fork child completed; ledger holds exactly 4 settled rows (3 parents + 1 fork)',
        );
      } finally {
        client.close();
      }

      // 8 — teardown: the broker retracts its bootstrap advertisement.
      await broker.close();
      check(
        (await readBootstrapFile({ aibenderHome: home })) === undefined,
        'broker close retracted the bootstrap discovery file',
      );
    } catch (cause) {
      await broker.close().catch(() => undefined);
      throw cause;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  say(`# assertions: ${assertions}, failures: ${failures}`);
  say(failures === 0 ? '# DEMO RESULT: PASS' : '# DEMO RESULT: FAIL');
  return failures === 0 ? 0 : 1;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause) => {
    say(`# DEMO RESULT: ERROR — ${(cause as Error).message}`);
    process.exitCode = 1;
  });
