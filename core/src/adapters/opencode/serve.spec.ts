import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { startMockOpencodeServer } from '@aibender/testkit';
import { describe, expect, it } from 'vitest';

import { LiveServeDisabledError, ServeExitedError, ServeStartTimeoutError } from '../errors.js';
import { isServePasswordShaped } from './password.js';
import {
  createOpencodeServeSupervisor,
  parseListeningLine,
  pickFreePort,
  type ServeChild,
  type ServeExit,
  type SpawnServeCommand,
  type SpawnServeFn,
} from './serve.js';
import type { SecretFetcher } from './secrets.js';

const SENTINEL = 'SYNTH-BEDROCK-VALUE-77aa-NOT-A-REAL-SECRET';

// ---------------------------------------------------------------------------
// Fake serve child
// ---------------------------------------------------------------------------

interface FakeChildControls {
  readonly child: ServeChild;
  pushLine(line: string): void;
  exit(exit: ServeExit): void;
  readonly signals: string[];
}

function makeFakeChild(options: { pid?: number; exitOnTerm?: boolean } = {}): FakeChildControls {
  const queue: string[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  let resolveExit: (exit: ServeExit) => void = () => undefined;
  const exited = new Promise<ServeExit>((resolve) => {
    resolveExit = resolve;
  });
  const signals: string[] = [];

  const exit = (value: ServeExit): void => {
    if (ended) return;
    ended = true;
    resolveExit(value);
    notify?.();
  };

  return {
    signals,
    pushLine: (line) => {
      queue.push(line);
      notify?.();
    },
    exit,
    child: {
      pid: options.pid ?? 4242,
      lines: async function* (): AsyncGenerator<string> {
        for (;;) {
          const line = queue.shift();
          if (line !== undefined) {
            yield line;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = undefined;
        }
      },
      kill: (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') exit({ code: null, signal: 'SIGKILL' });
        else if (options.exitOnTerm !== false) exit({ code: 0, signal: 'SIGTERM' });
      },
      exited,
    },
  };
}

const portOf = (command: SpawnServeCommand): string => {
  const index = command.args.indexOf('--port');
  return command.args[index + 1] ?? '0';
};

/** Spawn fake that reports ready on the requested port after a microtask. */
function autoReadySpawn(records: SpawnServeCommand[], options: { exitOnTerm?: boolean } = {}): {
  spawnFn: SpawnServeFn;
  children: FakeChildControls[];
} {
  const children: FakeChildControls[] = [];
  return {
    children,
    spawnFn: (command) => {
      records.push(command);
      const controls = makeFakeChild(options);
      children.push(controls);
      queueMicrotask(() => {
        controls.pushLine('synthetic startup noise');
        controls.pushLine(`opencode server listening on http://127.0.0.1:${portOf(command)}`);
      });
      return controls.child;
    },
  };
}

const fakeFetcher = (values: Record<string, string>): SecretFetcher => ({
  fetch: async (item) => {
    const value = values[item];
    if (value === undefined) throw new Error(`no such synthetic item ${item}`);
    return value;
  },
});

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('createOpencodeServeSupervisor (BE-4; blueprint §4.2)', () => {
  // -- negative: the live gate ------------------------------------------------

  it('REFUSES construction without the explicit live opt-in', () => {
    expect(() =>
      createOpencodeServeSupervisor({ liveServeOptIn: false as unknown as true }),
    ).toThrow(LiveServeDisabledError);
  });

  // -- positive: random port + per-boot password (plan §9.2 row 1) ------------

  it('spawns argv-correct serve on 127.0.0.1 with a picked random port', async () => {
    const records: SpawnServeCommand[] = [];
    const { spawnFn } = autoReadySpawn(records);
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      spawnFn,
      portPicker: async () => 45123,
      executablePath: '/synthetic/bin/opencode',
    });
    const handle = await supervisor.start();
    expect(records).toHaveLength(1);
    expect(records[0]?.executable).toBe('/synthetic/bin/opencode');
    expect(records[0]?.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45123']);
    expect(handle.port).toBe(45123);
    expect(handle.url).toBe('http://127.0.0.1:45123');
    expect(handle.pid).toBe(4242);
    await handle.stop();
  });

  it('injects a fresh per-boot OPENCODE_SERVER_PASSWORD and reports it to the scrubber tap', async () => {
    const records: SpawnServeCommand[] = [];
    const secretTap: string[] = [];
    const { spawnFn } = autoReadySpawn(records);
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      spawnFn,
      onSecretValue: (value) => secretTap.push(value),
    });
    const first = await supervisor.start();
    const second = await supervisor.start();
    const pw1 = records[0]?.env['OPENCODE_SERVER_PASSWORD'];
    const pw2 = records[1]?.env['OPENCODE_SERVER_PASSWORD'];
    expect(isServePasswordShaped(pw1)).toBe(true);
    expect(isServePasswordShaped(pw2)).toBe(true);
    expect(pw1).not.toBe(pw2); // per-boot
    expect(secretTap).toContain(pw1);
    expect(secretTap).toContain(pw2);
    // authHeader() encodes the same password without exposing it as a field.
    expect(first.authHeader()).toBe(
      `Basic ${Buffer.from(`opencode:${pw1 ?? ''}`).toString('base64')}`,
    );
    await first.stop();
    await second.stop();
  });

  it('builds the child env from the explicit base only — never process.env', async () => {
    const records: SpawnServeCommand[] = [];
    const { spawnFn } = autoReadySpawn(records);
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      spawnFn,
      baseEnv: { PATH: '/synthetic/bin', HOME: '/synthetic/home', DROPPED: undefined },
    });
    const handle = await supervisor.start();
    const env = records[0]?.env ?? {};
    expect(env['PATH']).toBe('/synthetic/bin');
    expect(env['HOME']).toBe('/synthetic/home');
    expect(Object.keys(env).sort()).toEqual(['HOME', 'OPENCODE_SERVER_PASSWORD', 'PATH']);
    await handle.stop();
  });

  // -- positive: Bedrock env injected from the fetch at spawn time ------------

  it('fetches Bedrock env at SPAWN TIME and injects it into the child env', async () => {
    const records: SpawnServeCommand[] = [];
    const { spawnFn } = autoReadySpawn(records);
    let fetches = 0;
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      spawnFn,
      bedrock: {
        plainEnv: { AWS_PROFILE: 'synthetic-profile', AWS_REGION: 'us-east-1' },
        keychainEnv: [{ envVar: 'OPENAI_API_KEY', keychainItem: 'bedrock-openai-api-key' }],
      },
      secretFetcher: {
        fetch: async (item) => {
          fetches += 1;
          return fakeFetcher({ 'bedrock-openai-api-key': SENTINEL }).fetch(item);
        },
      },
    });
    expect(fetches).toBe(0); // construction never fetches — spawn time only
    const handle = await supervisor.start();
    expect(fetches).toBe(1);
    const env = records[0]?.env ?? {};
    expect(env['OPENAI_API_KEY']).toBe(SENTINEL);
    expect(env['AWS_PROFILE']).toBe('synthetic-profile');
    await handle.stop();
  });

  it('refuses a keychainEnv spec without a SecretFetcher (typed bad-request)', async () => {
    const { spawnFn } = autoReadySpawn([]);
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      spawnFn,
      bedrock: { keychainEnv: [{ envVar: 'OPENAI_API_KEY', keychainItem: 'x' }] },
    });
    await expect(supervisor.start()).rejects.toThrow(/SecretFetcher/);
  });

  // -- negative: fs-audit — credentials never written to disk (plan §9.2) -----

  it('fs-audit: the spawn modules import no fs API at all (structural guarantee)', async () => {
    // The strongest "never serialized to disk" proof: the entire spawn path
    // (serve/secrets/password) has NO filesystem import to write with.
    const dir = join(import.meta.dirname);
    for (const file of ['serve.ts', 'secrets.ts', 'password.ts']) {
      const source = await readFile(join(dir, file), 'utf8');
      expect(source, `${file} must not touch the filesystem`).not.toMatch(
        /from 'node:fs|require\(['"]fs|from "node:fs/,
      );
    }
  });

  it('fs-audit: handle/supervisor serialization exposes neither password nor fetched values', async () => {
    const records: SpawnServeCommand[] = [];
    const { spawnFn } = autoReadySpawn(records);
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      spawnFn,
      bedrock: { keychainEnv: [{ envVar: 'OPENAI_API_KEY', keychainItem: 'synthetic-item' }] },
      secretFetcher: fakeFetcher({ 'synthetic-item': SENTINEL }),
    });
    const handle = await supervisor.start();
    const password = records[0]?.env['OPENCODE_SERVER_PASSWORD'] ?? '';
    for (const dump of [JSON.stringify(supervisor), JSON.stringify(handle)]) {
      expect(dump).not.toContain(SENTINEL);
      expect(dump).not.toContain(password);
    }
    await handle.stop();
  });

  // -- edge: ready/exit/timeout races -----------------------------------------

  it('rejects with ServeExitedError when the child dies before the ready line', async () => {
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      spawnFn: () => {
        const controls = makeFakeChild();
        queueMicrotask(() => controls.exit({ code: 7, signal: null }));
        return controls.child;
      },
    });
    await expect(supervisor.start()).rejects.toThrow(ServeExitedError);
  });

  it('rejects with ServeStartTimeoutError (and SIGKILLs) when no ready line arrives', async () => {
    let controls: FakeChildControls | undefined;
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      readyTimeoutMs: 30,
      spawnFn: () => {
        controls = makeFakeChild();
        return controls.child;
      },
    });
    await expect(supervisor.start()).rejects.toThrow(ServeStartTimeoutError);
    expect(controls?.signals).toContain('SIGKILL');
  });

  it('refuses a child that binds a DIFFERENT port than requested', async () => {
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      portPicker: async () => 40001,
      spawnFn: () => {
        const controls = makeFakeChild();
        queueMicrotask(() =>
          controls.pushLine('opencode server listening on http://127.0.0.1:4096'),
        );
        return controls.child;
      },
    });
    await expect(supervisor.start()).rejects.toThrow(/4096/);
  });

  it('stop(): SIGTERM first, SIGKILL only after the grace window', async () => {
    const records: SpawnServeCommand[] = [];
    const { spawnFn, children } = autoReadySpawn(records, { exitOnTerm: false });
    const supervisor = createOpencodeServeSupervisor({
      liveServeOptIn: true,
      spawnFn,
      killGraceMs: 20,
    });
    const handle = await supervisor.start();
    const exit = await handle.stop();
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(exit.signal).toBe('SIGKILL');
    // Idempotent: a second stop() returns the same settled exit.
    expect(await handle.stop()).toEqual(exit);
  });

  // -- positive: health over a REAL http server -------------------------------

  it('health() answers via GET /global/health with basic auth', async () => {
    const mock = await startMockOpencodeServer({
      password: 'unused',
      acceptAnyBasicAuth: true,
      version: '1.17.13-synthetic',
    });
    try {
      const supervisor = createOpencodeServeSupervisor({
        liveServeOptIn: true,
        portPicker: async () => mock.port,
        spawnFn: (command) => {
          const controls = makeFakeChild();
          queueMicrotask(() =>
            controls.pushLine(
              `opencode server listening on http://127.0.0.1:${portOf(command)}`,
            ),
          );
          return controls.child;
        },
      });
      const handle = await supervisor.start();
      expect(await handle.health()).toEqual({ healthy: true, version: '1.17.13-synthetic' });
      await handle.stop();
    } finally {
      await mock.close();
    }
  });

  it('health() reports healthy:false when the server rejects the password', async () => {
    const mock = await startMockOpencodeServer({ password: 'a-different-password' });
    try {
      const supervisor = createOpencodeServeSupervisor({
        liveServeOptIn: true,
        portPicker: async () => mock.port,
        spawnFn: (command) => {
          const controls = makeFakeChild();
          queueMicrotask(() =>
            controls.pushLine(
              `opencode server listening on http://127.0.0.1:${portOf(command)}`,
            ),
          );
          return controls.child;
        },
      });
      const handle = await supervisor.start();
      expect((await handle.health()).healthy).toBe(false);
      await handle.stop();
    } finally {
      await mock.close();
    }
  });
});

describe('parseListeningLine (format verified live against v1.17.13)', () => {
  it('parses the exact observed line', () => {
    expect(parseListeningLine('opencode server listening on http://127.0.0.1:39271')).toEqual({
      url: 'http://127.0.0.1:39271',
      port: 39271,
    });
  });

  it('rejects non-loopback or non-matching lines', () => {
    expect(parseListeningLine('opencode server listening on http://0.0.0.0:39271')).toBeUndefined();
    expect(parseListeningLine('synthetic other output')).toBeUndefined();
    expect(parseListeningLine('')).toBeUndefined();
  });
});

describe('pickFreePort', () => {
  it('returns a bindable ephemeral port', async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe('adapters [X3] architectural guard', () => {
  it('no adapter module imports k8s/colima/infra surfaces', async () => {
    const roots = [join(import.meta.dirname, '..')];
    const offenders: string[] = [];
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir === undefined) break;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          roots.push(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = await readFile(path, 'utf8');
        if (/from ['"].*(kubernetes|k8s|colima|infra\/)/.test(source)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
