/**
 * Gateway-port adapters — BE-2 surfaces onto BE-3's gateway ports
 * (core/src/gateway/ports.ts). The TYPE-ONLY import below is the cross-lane
 * compatibility assertion (plan §1.3): if either side's shape drifts, this
 * file stops compiling — in either lane's CI.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LaunchParams } from '@aibender/protocol';
import { FakePtyBackend, asciiBytes } from '@aibender/testkit';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import { afterEach, describe, expect, it } from 'vitest';

// TYPE-ONLY cross-lane import (erased at runtime; sanctioned for the
// contract assertion — production pty/ modules never import gateway/).
import type {
  ApprovalBrokerPort as Be3ApprovalBrokerPort,
  GatewayPtyHost as Be3GatewayPtyHost,
  GatewayPtySession as Be3GatewayPtySession,
} from '../../gateway/ports.js';

import { createApprovalBroker } from '../approvals.js';
import { createProfileRegistry } from '../profiles.js';
import { toApprovalBrokerGatewayPort, toGatewayPtyHostPort } from './gatewayPort.js';
import { createPtyHost, type PtyHost } from './ptyHost.js';

const HOME = join(mkdtempSync(join(tmpdir(), 'aibender-ptyport-')), 'home');

const LAUNCH: LaunchParams = {
  accountLabel: 'MAX_A',
  backend: 'claude_code',
  substrate: 'pty',
  cwd: '/synthetic/workspace',
  purpose: 'gateway port test',
};

const open: { store: KernelStore; host: PtyHost }[] = [];

async function makeHost(): Promise<{ host: PtyHost; backend: FakePtyBackend; store: KernelStore }> {
  const store = await openKernelStore({ path: ':memory:' });
  const backend = new FakePtyBackend();
  const host = createPtyHost({
    ledger: store.resumeLedger,
    profiles: createProfileRegistry({ aibenderHome: HOME }),
    backend,
    baseEnv: { PATH: '/usr/bin' },
  });
  open.push({ store, host });
  return { host, backend, store };
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.host.shutdown();
    entry.store.close();
  }
});

describe('type compatibility with gateway/ports.ts (compile-time contract)', () => {
  it('adapter outputs satisfy the BE-3 port types', async () => {
    const { host } = await makeHost();
    // These ASSIGNMENTS are the test: structural drift breaks the build.
    const ptyPort: Be3GatewayPtyHost = toGatewayPtyHostPort(host);
    const approvalsPort: Be3ApprovalBrokerPort = toApprovalBrokerGatewayPort(
      createApprovalBroker({ defaultTtlMs: null }),
    );
    expect(typeof ptyPort.onSession).toBe('function');
    expect(typeof approvalsPort.decide).toBe('function');
  });
});

describe('PtyHost → GatewayPtyHost adapter', () => {
  it('announces sessions before their first output; gateway byte 0 = host offset 0', async () => {
    const { host, backend } = await makeHost();
    const port = toGatewayPtyHostPort(host);

    const chunks: Uint8Array[] = [];
    let announcedId: string | undefined;
    let gatewaySession: Be3GatewayPtySession | undefined;
    port.onSession((sessionId, session) => {
      announcedId = sessionId;
      gatewaySession = session;
      session.onOutput((chunk) => chunks.push(chunk));
    });

    const attended = await host.launchAttended(LAUNCH);
    expect(announcedId).toBe(attended.sessionId); // announced synchronously
    expect(chunks).toHaveLength(0); // …before any output

    backend.latest().emitText('byte zero onward');
    expect(chunks.map((c) => String.fromCharCode(...c)).join('')).toBe('byte zero onward');
    // auto-ack keeps the host ring drained (no double buffering)
    expect(attended.producedOffset()).toBe(16);
    expect(() => attended.ack(16)).not.toThrow(); // floor already there or ahead

    // INPUT + resize + levers ride through
    gatewaySession?.write(asciiBytes('k'));
    expect(backend.latest().writes).toHaveLength(1);
    gatewaySession?.resize(100, 30);
    expect(backend.latest().resizes.at(-1)).toEqual({ cols: 100, rows: 30 });
    gatewaySession?.pause();
    expect(backend.latest().paused).toBe(true);
    gatewaySession?.resume();
    expect(backend.latest().paused).toBe(false);
  });

  it('replays already-live sessions to a late subscriber and signals exit', async () => {
    const { host, backend } = await makeHost();
    const attended = await host.launchAttended(LAUNCH);

    const port = toGatewayPtyHostPort(host);
    const seen: string[] = [];
    let exited = false;
    port.onSession((sessionId, session) => {
      seen.push(sessionId);
      session.onExit(() => {
        exited = true;
      });
    });
    expect(seen).toEqual([attended.sessionId]);

    backend.latest().exit(0);
    await attended.waitForExit();
    await Promise.resolve(); // onExit rides the settled promise
    expect(exited).toBe(true);
  });

  it('unsubscribing onExit before settlement suppresses the callback', async () => {
    const { host, backend } = await makeHost();
    const attended = await host.launchAttended(LAUNCH);
    const port = toGatewayPtyHostPort(host);
    let fired = false;
    port.onSession((_sessionId, session) => {
      const off = session.onExit(() => {
        fired = true;
      });
      off();
    });
    backend.latest().exit(0);
    await attended.waitForExit();
    await Promise.resolve();
    expect(fired).toBe(false);
  });
});

describe('ApprovalBroker → ApprovalBrokerPort adapter', () => {
  it('routes requests/resolutions and maps decisions to applied / not-pending', async () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const port = toApprovalBrokerGatewayPort(broker);

    const requests: string[] = [];
    const resolved: string[] = [];
    port.onRequest((request) => requests.push(request.approvalId));
    port.onResolved((message) => resolved.push(`${message.approvalId}:${message.outcome}`));

    const handle = broker.request({
      source: 'can-use-tool',
      summary: 'tool escalation: Bash',
      accountLabel: 'MAX_A',
      sessionId: 'ses_fake_1',
      toolName: 'Bash',
    });
    expect(requests).toEqual([handle.approvalId]);

    await expect(
      port.decide({ kind: 'approval-decision', approvalId: handle.approvalId, verdict: 'allow' }),
    ).resolves.toBe('applied');
    expect(resolved).toEqual([`${handle.approvalId}:allowed`]);

    // the multi-window race: the second decision answers not-pending
    await expect(
      port.decide({ kind: 'approval-decision', approvalId: handle.approvalId, verdict: 'deny' }),
    ).resolves.toBe('not-pending');
    await expect(
      port.decide({ kind: 'approval-decision', approvalId: 'apr_unknown', verdict: 'allow' }),
    ).resolves.toBe('not-pending');
    broker.close();
  });
});
