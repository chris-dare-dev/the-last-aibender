/**
 * SessionIdResolver (ws-protocol.md §15.2, frozen semantics): harness id
 * where known (lineage node first, resume ledger second), input VERBATIM to
 * relay, undefined only for unusable inputs.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { openKernelStore, type KernelStore } from '@aibender/schema';

import { createSessionIdResolver } from './resolver.js';

const stores: KernelStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function harness() {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const resolve = createSessionIdResolver({
    store: store.lineage,
    resumeLedger: store.resumeLedger,
  });
  return { store, resolve };
}

describe('createSessionIdResolver', () => {
  it('maps a native id to its lineage node (harness id)', async () => {
    const { store, resolve } = await harness();
    store.lineage.nodes.insert({
      id: 'ses_known',
      backend: 'claude_code',
      account: 'MAX_A',
      nativeSessionId: 'native-mapped',
      state: 'idle',
      origin: 'harness',
      confidence: 'recorded',
    });
    expect(resolve('native-mapped')).toBe('ses_known');
  });

  it('falls back to the resume ledger for kernel sessions without a lineage node', async () => {
    const { store, resolve } = await harness();
    store.resumeLedger.insertBeforeSpawn({
      id: 'ses_ledgeronly',
      accountLabel: 'MAX_B',
      backend: 'claude_code',
      cwd: '/synthetic/workspace',
      substrate: 'sdk',
      purpose: 'resolver fixture',
    });
    store.resumeLedger.backfillNativeSessionId('ses_ledgeronly', 'native-ledger');
    expect(resolve('native-ledger')).toBe('ses_ledgeronly');
  });

  it('relays UNKNOWN native ids verbatim (the frozen relay rule) and drops empty input', async () => {
    const { resolve } = await harness();
    expect(resolve('native-external-unknown')).toBe('native-external-unknown');
    expect(resolve('')).toBeUndefined();
  });

  it('the lineage node wins over the ledger when both know the id', async () => {
    const { store, resolve } = await harness();
    store.resumeLedger.insertBeforeSpawn({
      id: 'ses_row',
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      cwd: '/synthetic/workspace',
      substrate: 'sdk',
      purpose: 'resolver fixture',
    });
    store.resumeLedger.backfillNativeSessionId('ses_row', 'native-both');
    store.lineage.nodes.insert({
      id: 'ses_row', // same harness id — one id per session across surfaces
      backend: 'claude_code',
      account: 'MAX_A',
      nativeSessionId: 'native-both',
      state: 'running',
      origin: 'harness',
      confidence: 'recorded',
    });
    expect(resolve('native-both')).toBe('ses_row');
  });
});
