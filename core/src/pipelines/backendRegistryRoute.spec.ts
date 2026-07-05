/**
 * OS-1 / ICR-0016 — a SYNTHETIC 4th backend routes end-to-end through the
 * frozen backend REGISTRY with NO branch edit anywhere in core/src.
 *
 * The finding (docs/reviews/optimization-scalability.md, OS-1): before the
 * registry, adding a backend beyond the built-in three was a ~42-site
 * cross-codebase fork — every dispatch seam branched on the closed literals
 * `claude_code`/`opencode`/`lmstudio`. This spec is the counter-proof: a 2nd
 * OpenAI-compatible local server (the synthetic descriptor `synthbackend`,
 * serving label `SYNTH_L`, feeding the local `lmstudio` events source) is
 * introduced by ONE `registerBackend()` call and rides EVERY core dispatch seam
 * with byte-identical mechanism to the built-ins:
 *
 *   1. vocab resolution — backendForLabel / sourceForBackend / isBackend /
 *      isAccountLabel all admit + route it through the registry;
 *   2. the pipeline cost dispatch (pipelines/lineageCost.ts) — a run on
 *      `SYNTH_L` lands an events row keyed to `synthbackend` with the source its
 *      descriptor declares, resolved through the registry `sourceForBackend`
 *      (NOT a local if-chain over the three);
 *   3. the read-model dispatch (readmodels/projections.ts) — the local-offload
 *      ratio counts the synthetic backend's tokens as LOCAL because its
 *      descriptor feeds the local source, resolved through the registry (NOT
 *      `row.backend === 'lmstudio'`).
 *
 * [X2]: the id + label are generic synthesized identifiers (from the testkit),
 * never a real backend name or credential.
 *
 * The descriptor is registered per-suite and unregistered in cleanup so the
 * global registry never leaks the synthetic backend into other specs.
 */

import {
  backendForLabel,
  isAccountLabel,
  isBackend,
  registerBackend,
  sourceForBackend,
  substrateLegalFor,
  unregisterBackend,
  type AccountLabel,
  type Backend,
  type DagDocument,
  type EventSource,
} from '@aibender/protocol';
import { openEventsStore, openKernelStore } from '@aibender/schema';
import { SYNTHETIC_BACKEND_DESCRIPTOR } from '@aibender/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localOffloadData } from '../readmodels/projections.js';
import { createPipelineEngine } from './engine.js';
import { createPipelineLineageCost } from './lineageCost.js';
import { FakeStepExecutor } from './testSupport.js';

const NOW = 1_700_000_000_000;
const noSleep = (): Promise<void> => Promise.resolve();

// The testkit's generic synthetic descriptor: id `synthbackend`, serves label
// `SYNTH_L`, feeds the local `lmstudio` events source, sdk-only, non-builtin.
const SYNTH = SYNTHETIC_BACKEND_DESCRIPTOR;

// These three are RUNTIME-registered values, not members of the compile-time
// seed unions (Backend/AccountLabel/EventSource). The `as` casts here mirror the
// production `as Backend` widening in vocab.ts backendForLabel — the runtime
// gates (isBackend/isAccountLabel/isEventSource) are authoritative, and the
// registry admits these once SYNTH is registered. Casting once keeps the test
// bodies clean.
const SYNTH_LABEL = 'SYNTH_L' as AccountLabel;
const SYNTH_BACKEND = SYNTH.id as Backend;
const SYNTH_SOURCE = SYNTH.sourceName as EventSource;

describe('OS-1: a registered 4th backend routes through core dispatch with no branch edit', () => {
  beforeEach(() => {
    registerBackend(SYNTH);
  });
  afterEach(() => {
    unregisterBackend(SYNTH.id);
  });

  it('vocab: the registry resolves the synthetic backend + its label like a built-in', () => {
    // The label the descriptor serves is now a sanctioned account label...
    expect(isAccountLabel('SYNTH_L')).toBe(true);
    // ...it pairs with the synthetic backend id through backendForLabel...
    expect(backendForLabel(SYNTH_LABEL)).toBe(SYNTH.id);
    // ...the id is a registered backend...
    expect(isBackend(SYNTH.id)).toBe(true);
    // ...its events source comes from the descriptor (here, the local source)...
    expect(sourceForBackend(SYNTH.id)).toBe(SYNTH.sourceName);
    // ...and the substrate rule is descriptor-driven (sdk-only, no pty).
    expect(substrateLegalFor('sdk', SYNTH.id)).toBe(true);
    expect(substrateLegalFor('pty', SYNTH.id)).toBe(false);
  });

  it('vocab: unregistering restores the pre-registration verdicts (real gate, no leak)', () => {
    unregisterBackend(SYNTH.id);
    expect(isBackend(SYNTH.id)).toBe(false);
    expect(isAccountLabel('SYNTH_L')).toBe(false);
    // The built-in three are unaffected by register/unregister of a 4th.
    expect(backendForLabel('MAX_A')).toBe('claude_code');
    expect(backendForLabel('AWS_DEV')).toBe('opencode');
    expect(backendForLabel('LOCAL')).toBe('lmstudio');
    // Re-register so afterEach's unregister is symmetric teardown.
    registerBackend(SYNTH);
  });

  it('pipeline cost dispatch: landCost on the 4th-backend label routes through the registry', async () => {
    const kernel = await openKernelStore({ path: ':memory:' });
    const events = await openEventsStore({ path: ':memory:' });

    const lineageCost = createPipelineLineageCost({
      lineage: kernel.lineage,
      events: events.events,
      newNodeId: () => 'sn_synth',
      nowMs: () => NOW,
    });

    // registerStepNode + landCost with a SYNTH_L account. Both resolve the wire
    // backend through backendForLabel(account) (the registry) — NO branch on the
    // id — and landCost derives the events `source` through the registry
    // sourceForBackend (pipelines/lineageCost.ts, the refactored seam), NOT a
    // closed if-chain over the three literals.
    const attempt = {
      runId: 'run_synth',
      stepId: 'infer',
      iteration: 0,
      account: SYNTH_LABEL,
      costEstimatedUsd: 0.05,
      tokensIn: 300,
      tokensOut: 120,
      ok: true,
    };

    const node = lineageCost.registerStepNode(attempt);
    lineageCost.landCost(attempt);

    // The session_node landed keyed to the synthetic backend id (lineage store
    // relaxed by migration 0007).
    expect(node?.sessionId).toBe('sn_synth');
    const lineageNode = kernel.lineage.nodes.get('sn_synth');
    expect(lineageNode?.backend).toBe(SYNTH.id);
    expect(lineageNode?.account).toBe('SYNTH_L');

    // The cost row landed keyed to the synthetic backend id, and its `source` is
    // the descriptor's sourceName — proof landCost resolved both through the
    // registry with no id-specific branch (events store relaxed by 0008).
    const row = events.events.getByRawRef(SYNTH_BACKEND, 'pipeline:run_synth:infer:0');
    expect(row).toBeDefined();
    expect(row?.backend).toBe(SYNTH.id);
    expect(row?.source).toBe(SYNTH.sourceName);
    expect(row?.account).toBe('SYNTH_L');
    expect(row?.costEstimatedUsd).toBeCloseTo(0.05);
  });

  it('pipeline runner dispatch: the [X1] per-step routing key resolves the 4th backend with no branch', async () => {
    // The full engine run now COMPLETES for a 4th-backend account with NO core
    // edit. Migration 0007 relaxed the kernel `backend`-carrying tables and 0008
    // the events table; the step_attempt JOURNAL was the last table still pinned
    // to the built-in account form (0007 skipped it on the "no backend column"
    // reasoning, overlooking that its account CHECK needed the registered-backend
    // clause). Migration 0009 (kernel-DB, ICR-0016 step_attempt amendment)
    // relaxes step_attempt.account exactly as 0008 relaxed events.account —
    // keyed on the label FORM since the table carries no backend column. With
    // that landed, resolveBackend routes SYNTH_L through the registry (no id
    // branch) AND the journal write accepts the label, so the run walks to
    // completion. This test proves the full [X1] end-to-end path.
    const kernel = await openKernelStore({ path: ':memory:' });
    const document: DagDocument = {
      schemaVersion: 1,
      id: 'wf_synth',
      name: 'wf_synth',
      defaults: { account: SYNTH_LABEL },
      steps: [{ kind: 'prompt', id: 'infer', prompt: 'run on the 4th backend' }],
    };
    const executor = new FakeStepExecutor({
      steps: { infer: { costEstimatedUsd: 0.05, tokensIn: 300, tokensOut: 120 } },
    });
    const engine = createPipelineEngine({
      store: kernel.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });

    const { runId, done } = engine.launch({ document });

    // The run completes — no backend-literal branch in core, and no schema
    // refusal at the journal (migration 0009). The single step ran on the 4th
    // backend's account and its attempt landed in the journal keyed to SYNTH_L,
    // proving the [X1] per-step routing + the durable journal both admit a
    // registered backend with zero core edits.
    const result = await done;
    expect(result.outcome).toBe('completed');
    expect(result.stepStates['infer']).toBe('completed');
    const attempts = kernel.pipelines.stepAttempts.listByRun(runId);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a) => a.account === SYNTH_LABEL)).toBe(true);
    kernel.close();
  });

  it('read-model dispatch: the 4th backend counts as LOCAL in the offload ratio', async () => {
    const events = await openEventsStore({ path: ':memory:' });
    const stores = {
      events: events.events,
      // localOffloadData only touches `events`; the other stores are unused here.
      quotaSnapshots: undefined as never,
      sessionOutcomes: undefined as never,
      prices: undefined as never,
    };

    // A claude_code row (NON-local) + a synthetic-4th-backend row (LOCAL). The
    // projection's local classification is descriptor-driven (its descriptor
    // feeds the local `lmstudio` source), so the synthetic tokens count local
    // WITHOUT a `=== 'lmstudio'` branch edit in projections.ts.
    events.events.insert({
      tsMs: NOW - 60_000,
      backend: 'claude_code',
      account: 'MAX_A',
      source: 'claude-jsonl',
      eventType: 'api_request',
      rawRef: 'claude:1',
      inputTokens: 400,
      outputTokens: 100,
    });
    events.events.insert({
      tsMs: NOW - 30_000,
      backend: SYNTH_BACKEND,
      account: SYNTH_LABEL,
      source: SYNTH_SOURCE,
      eventType: 'api_request',
      rawRef: 'synth:1',
      inputTokens: 200,
      outputTokens: 100,
    });

    const data = localOffloadData(stores, NOW, 30);
    // claude row = 500 tokens (non-local), synth row = 300 tokens (local).
    expect(data.totalTokens).toBe(800);
    expect(data.localTokens).toBe(300);
    expect(data.offloadRatioPct).toBeCloseTo((300 / 800) * 100);
  });

  it('read-model dispatch: local classification is SOURCE-driven, not count-everything', async () => {
    const events = await openEventsStore({ path: ':memory:' });
    const stores = {
      events: events.events,
      quotaSnapshots: undefined as never,
      sessionOutcomes: undefined as never,
      prices: undefined as never,
    };

    // A NON-local built-in (opencode → the SSE source) alongside the synthetic
    // 4th backend (→ the local lmstudio source). Only the synthetic tokens are
    // local, proving the projection classifies by the descriptor's SOURCE (the
    // registry), not by counting every non-claude row.
    events.events.insert({
      tsMs: NOW - 60_000,
      backend: 'opencode',
      account: 'AWS_DEV',
      source: 'opencode-sse',
      eventType: 'api_request',
      rawRef: 'opencode:1',
      inputTokens: 500,
      outputTokens: 100,
    });
    events.events.insert({
      tsMs: NOW - 30_000,
      backend: SYNTH_BACKEND,
      account: SYNTH_LABEL,
      source: SYNTH_SOURCE,
      eventType: 'api_request',
      rawRef: 'synth:2',
      inputTokens: 200,
      outputTokens: 100,
    });

    const data = localOffloadData(stores, NOW, 30);
    // opencode row = 600 (non-local), synth row = 300 (local).
    expect(data.totalTokens).toBe(900);
    expect(data.localTokens).toBe(300);
  });
});
