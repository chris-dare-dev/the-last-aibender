import { afterEach, describe, expect, it } from 'vitest';

import {
  ACTIVE_SESSION_STATES,
  IllegalTransitionError,
  KERNEL_FIELD_TAGS,
  KernelStoreError,
  LEGAL_TRANSITIONS,
  SessionNotFoundError,
  isLegalTransition,
  openKernelStore,
  type KernelStore,
  type NewResumeLedgerRow,
} from './index.js';

let stores: KernelStore[] = [];
const openStore = async (): Promise<KernelStore> => {
  let tick = 0;
  const store = await openKernelStore({
    path: ':memory:',
    nowIso: () => `2026-07-04T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  });
  stores.push(store);
  return store;
};

afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

const newRow = (overrides: Partial<NewResumeLedgerRow> = {}): NewResumeLedgerRow => ({
  id: 'ses_0001',
  accountLabel: 'MAX_A',
  backend: 'claude_code',
  cwd: '/work/repo',
  substrate: 'sdk',
  purpose: 'unit test',
  ...overrides,
});

describe('kernel migrations: 0001 seeds + 0005 account-registry relaxation', () => {
  it('seeds the five account profiles and reflects the M7 relaxation in schema_meta', async () => {
    const store = await openStore();
    // 0005 (M7 account-registry relaxation) bumps the kernel schema_meta.
    expect(store.schemaMeta.get('ddl_version')).toBe('5');
    expect(store.schemaMeta.get('frozen_milestone')).toBe('M7');
    // The SEED set is still the five originally provisioned placeholders — the
    // migration RELAXES validation, it does not seed new accounts.
    const profiles = store.accountProfiles.list();
    expect(profiles.map((p) => p.label).sort()).toEqual(['AWS_DEV', 'ENT', 'LOCAL', 'MAX_A', 'MAX_B']);
    expect(profiles.every((p) => p.configDir === null)).toBe(true);
    expect(store.accountProfiles.get('AWS_DEV')?.backend).toBe('opencode');
    expect(store.accountProfiles.get('LOCAL')?.backend).toBe('lmstudio');
  });

  it('admits a newly provisioned Max account (MAX_C) into the resume ledger (ICR-0013)', async () => {
    const store = await openStore();
    const row = store.resumeLedger.insertBeforeSpawn(
      newRow({ id: 'ses_maxc', accountLabel: 'MAX_C' as never, backend: 'claude_code' }),
    );
    expect(row.accountLabel).toBe('MAX_C');
    // The form is still a GATE: a non-sanctioned label is refused at the accessor.
    expect(() =>
      store.resumeLedger.insertBeforeSpawn(
        newRow({ id: 'ses_bad', accountLabel: 'HACKER' as never, backend: 'claude_code' }),
      ),
    ).toThrow();
    // And a newly provisioned Max account MUST still be claude_code (pairing).
    expect(() =>
      store.resumeLedger.insertBeforeSpawn(
        newRow({ id: 'ses_pair', accountLabel: 'MAX_C' as never, backend: 'opencode' }),
      ),
    ).toThrow();
  });
});

describe('resume_ledger: row-before-spawn', () => {
  // -- positive --------------------------------------------------------------

  it('insertBeforeSpawn creates a spawning row with no pid and no native id', async () => {
    const store = await openStore();
    const row = store.resumeLedger.insertBeforeSpawn(newRow({ workstreamHint: 'ws_1' }));
    expect(row.state).toBe('spawning');
    expect(row.pid).toBeNull();
    expect(row.spawnNonce).toBeNull();
    expect(row.nativeSessionId).toBeNull();
    expect(row.workstreamHint).toBe('ws_1');
    // injected clock (tick 0 goes to the migration ledger record):
    expect(row.createdAtIso).toMatch(/^2026-07-04T00:00:\d{2}\.000Z$/);
    expect(row.createdAtIso).toBe(row.updatedAtIso);
  });

  it('backfills pid + nonce after spawn, then native session id from the init message', async () => {
    const store = await openStore();
    store.resumeLedger.insertBeforeSpawn(newRow());
    const withPid = store.resumeLedger.backfillPid('ses_0001', 4242, 'nonce-abc');
    expect(withPid.pid).toBe(4242);
    expect(withPid.spawnNonce).toBe('nonce-abc');
    const withNative = store.resumeLedger.backfillNativeSessionId('ses_0001', 'native-uuid-1');
    expect(withNative.nativeSessionId).toBe('native-uuid-1');
    // idempotent same-value backfill:
    expect(
      store.resumeLedger.backfillNativeSessionId('ses_0001', 'native-uuid-1').nativeSessionId,
    ).toBe('native-uuid-1');
  });

  // -- negative --------------------------------------------------------------

  it('refuses label/backend pairing violations and pty on non-claude backends', async () => {
    const store = await openStore();
    expect(() =>
      store.resumeLedger.insertBeforeSpawn(newRow({ accountLabel: 'MAX_A', backend: 'opencode' })),
    ).toThrow(KernelStoreError);
    expect(() =>
      store.resumeLedger.insertBeforeSpawn(
        newRow({ accountLabel: 'AWS_DEV', backend: 'opencode', substrate: 'pty' }),
      ),
    ).toThrow(/claude_code-only/);
  });

  it('the DDL CHECKs enforce vocabulary even when the accessor is bypassed', async () => {
    const store = await openStore();
    expect(() =>
      store.driver
        .prepare(
          `INSERT INTO resume_ledger
             (id, account_label, backend, cwd, substrate, purpose, workstream_hint,
              native_session_id, state, pid, spawn_nonce, created_at_iso, updated_at_iso)
           VALUES ('x', 'MAX_A', 'opencode', '/w', 'sdk', 'p', NULL, NULL, 'spawning', NULL, NULL, 't', 't')`,
        )
        .run(),
    ).toThrow(); // pairing CHECK
    expect(() =>
      store.driver
        .prepare(
          `INSERT INTO resume_ledger
             (id, account_label, backend, cwd, substrate, purpose, workstream_hint,
              native_session_id, state, pid, spawn_nonce, created_at_iso, updated_at_iso)
           VALUES ('x', 'MAX_A', 'claude_code', '/w', 'sdk', 'p', NULL, NULL, 'zombie', NULL, NULL, 't', 't')`,
        )
        .run(),
    ).toThrow(); // state CHECK
  });

  it('refuses relative cwd, duplicate ids, bad pids, blank nonces, native-id overwrite', async () => {
    const store = await openStore();
    expect(() => store.resumeLedger.insertBeforeSpawn(newRow({ cwd: 'rel/path' }))).toThrow(
      /absolute/,
    );
    store.resumeLedger.insertBeforeSpawn(newRow());
    expect(() => store.resumeLedger.insertBeforeSpawn(newRow())).toThrow(); // PK violation
    expect(() => store.resumeLedger.backfillPid('ses_0001', 0, 'n')).toThrow(KernelStoreError);
    expect(() => store.resumeLedger.backfillPid('ses_0001', 1.5, 'n')).toThrow(KernelStoreError);
    expect(() => store.resumeLedger.backfillPid('ses_0001', 42, '  ')).toThrow(/nonce/i);
    store.resumeLedger.backfillNativeSessionId('ses_0001', 'native-1');
    expect(() => store.resumeLedger.backfillNativeSessionId('ses_0001', 'native-2')).toThrow(
      /write-once/,
    );
  });

  it('throws SessionNotFoundError for unknown sessions', async () => {
    const store = await openStore();
    expect(() => store.resumeLedger.backfillPid('ses_none', 42, 'n')).toThrow(SessionNotFoundError);
    expect(() => store.resumeLedger.transition('ses_none', 'running')).toThrow(SessionNotFoundError);
    expect(store.resumeLedger.get('ses_none')).toBeUndefined();
  });
});

describe('resume_ledger: state machine (SPIKE-D vii scenarios)', () => {
  const walk = async (states: readonly string[]): Promise<KernelStore> => {
    const store = await openStore();
    store.resumeLedger.insertBeforeSpawn(newRow());
    for (const state of states) {
      store.resumeLedger.transition('ses_0001', state as never);
    }
    return store;
  };

  // -- positive: the three spike scenarios ------------------------------------

  it('live orphan: spawning→running→orphan_detected→orphan_killed→resumed→exited', async () => {
    const store = await walk(['running', 'orphan_detected', 'orphan_killed', 'resumed', 'exited']);
    expect(store.resumeLedger.get('ses_0001')?.state).toBe('exited');
  });

  it('dead-resume: spawning→running→resumed→exited (no orphan rows on this path)', async () => {
    const store = await walk(['running', 'resumed', 'exited']);
    expect(store.resumeLedger.get('ses_0001')?.state).toBe('exited');
  });

  it('crash window: row stays spawning (no pid) and the SAME id re-enters running', async () => {
    const store = await openStore();
    const row = store.resumeLedger.insertBeforeSpawn(newRow());
    expect(row.state).toBe('spawning');
    expect(row.pid).toBeNull(); // the recoverable crash-window record
    const respawned = store.resumeLedger.transition('ses_0001', 'running');
    expect(respawned.state).toBe('running');
  });

  it('repeated dead-resume: resumed→resumed is legal', async () => {
    const store = await walk(['running', 'resumed', 'resumed']);
    expect(store.resumeLedger.get('ses_0001')?.state).toBe('resumed');
  });

  // -- negative: illegal transitions -------------------------------------------

  it('rejects illegal transitions with from/to detail', async () => {
    const store = await openStore();
    store.resumeLedger.insertBeforeSpawn(newRow());
    // spawning → resumed: cannot resume what never ran.
    try {
      store.resumeLedger.transition('ses_0001', 'resumed');
      expect.unreachable('transition should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).from).toBe('spawning');
      expect((error as IllegalTransitionError).to).toBe('resumed');
    }
  });

  it('rejects self-transitions except resumed→resumed, and anything from exited', async () => {
    expect(isLegalTransition('running', 'running')).toBe(false);
    expect(isLegalTransition('spawning', 'spawning')).toBe(false);
    expect(isLegalTransition('resumed', 'resumed')).toBe(true);
    for (const to of Object.keys(LEGAL_TRANSITIONS)) {
      expect(isLegalTransition('exited', to as never), `exited → ${to}`).toBe(false);
    }
    expect(isLegalTransition('orphan_detected', 'running')).toBe(false);
    expect(isLegalTransition('orphan_detected', 'exited')).toBe(false);
    expect(isLegalTransition('running', 'spawning')).toBe(false);
  });

  it('rejects unknown target states before touching the row', async () => {
    const store = await openStore();
    store.resumeLedger.insertBeforeSpawn(newRow());
    expect(() => store.resumeLedger.transition('ses_0001', 'zombie' as never)).toThrow(
      KernelStoreError,
    );
    expect(store.resumeLedger.get('ses_0001')?.state).toBe('spawning');
  });

  // -- edge --------------------------------------------------------------------

  it('unreconciled() returns exactly the non-terminal sessions', async () => {
    const store = await openStore();
    store.resumeLedger.insertBeforeSpawn(newRow({ id: 'ses_a' }));
    store.resumeLedger.insertBeforeSpawn(newRow({ id: 'ses_b' }));
    store.resumeLedger.insertBeforeSpawn(newRow({ id: 'ses_c' }));
    store.resumeLedger.transition('ses_b', 'running');
    store.resumeLedger.transition('ses_c', 'running');
    store.resumeLedger.transition('ses_c', 'exited');
    const open = store.resumeLedger.unreconciled();
    expect(open.map((r) => r.id).sort()).toEqual(['ses_a', 'ses_b']);
    expect(ACTIVE_SESSION_STATES).not.toContain('exited');
  });

  it('list filters by state and updated_at advances on transition', async () => {
    const store = await openStore();
    store.resumeLedger.insertBeforeSpawn(newRow());
    const before = store.resumeLedger.get('ses_0001');
    const after = store.resumeLedger.transition('ses_0001', 'running');
    expect(after.updatedAtIso > (before?.updatedAtIso ?? '')).toBe(true);
    expect(store.resumeLedger.list({ states: ['running'] }).map((r) => r.id)).toEqual(['ses_0001']);
    expect(store.resumeLedger.list({ states: ['exited'] })).toEqual([]);
    expect(store.resumeLedger.list().length).toBe(1);
  });
});

describe('account_profiles + schema_meta accessors', () => {
  it('setConfigDir stores a machine-local absolute path (runtime-only value)', async () => {
    const store = await openStore();
    // Path is synthetic — the REAL config dir never appears in committed files [X2].
    const updated = store.accountProfiles.setConfigDir('MAX_A', '/machine-local/accounts/max-a');
    expect(updated.configDir).toBe('/machine-local/accounts/max-a');
    expect(store.accountProfiles.get('MAX_A')?.configDir).toBe('/machine-local/accounts/max-a');
  });

  it('rejects relative config dirs, non-sanctioned labels, and known-but-unseeded labels', async () => {
    const store = await openStore();
    expect(() => store.accountProfiles.setConfigDir('MAX_A', 'relative/dir')).toThrow(/absolute/);
    // A NON-sanctioned label fails the form gate outright.
    expect(() => store.accountProfiles.setConfigDir('HACKER' as never, '/x')).toThrow(
      /unknown account label/,
    );
    // MAX_C IS a sanctioned label now (ICR-0013), but no profile row was seeded
    // for it — the accessor refuses the update with "not found", not silently.
    expect(() => store.accountProfiles.setConfigDir('MAX_C' as never, '/x')).toThrow(/not found/);
  });

  it('schema_meta get/set/all round-trips and upserts', async () => {
    const store = await openStore();
    store.schemaMeta.set('kernel_boot_count', '1');
    store.schemaMeta.set('kernel_boot_count', '2');
    expect(store.schemaMeta.get('kernel_boot_count')).toBe('2');
    expect(store.schemaMeta.get('missing')).toBeUndefined();
    expect(store.schemaMeta.all()['ddl_version']).toBe('5');
    expect(() => store.schemaMeta.set('  ', 'x')).toThrow(KernelStoreError);
  });

  it('KERNEL_FIELD_TAGS marks exactly the path-bearing columns as identifiers', () => {
    expect(KERNEL_FIELD_TAGS['cwd']).toEqual(['identifier']);
    expect(KERNEL_FIELD_TAGS['config_dir']).toEqual(['identifier']);
    // labels are placeholders, never tagged:
    expect(KERNEL_FIELD_TAGS['account_label']).toBeUndefined();
  });
});
