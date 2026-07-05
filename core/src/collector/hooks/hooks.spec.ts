/**
 * BE-5 source 8 suite — the hooks-contract.md accepting endpoint, proven by
 * replaying the FROZEN golden hook-POST corpus (hooks-contract.md §6,
 * GOLDEN_HOOK_FIXTURES) against the REAL loopback HTTP handler, plus the
 * PermissionRequest → ApprovalBroker hook-floor relay against the REAL M2
 * broker (the approvals.spec.ts queue slot).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GOLDEN_HOOK_CORPUS_FREEZE, GOLDEN_HOOK_FIXTURES } from '@aibender/testkit';
import { openEventsStore, type EventsStore } from '@aibender/schema';

import { createApprovalBroker, type ApprovalBroker } from '../../kernel/approvals.js';
import { startHooksServer, type HooksServer } from './server.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

function postFixture(server: HooksServer, segment: string, bodyJson: string): Promise<Response> {
  return fetch(`${server.url}/hooks/v1/${segment}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyJson,
  });
}

const PERMISSION_REQUEST_BODY = JSON.stringify({
  hook_event_name: 'PermissionRequest',
  session_id: 'synth-native-2',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'toolu_synth_9',
});

describe('startHooksServer — golden corpus replay (FROZEN-M5)', () => {
  let store: EventsStore;
  let server: HooksServer;

  beforeEach(async () => {
    expect(GOLDEN_HOOK_CORPUS_FREEZE).toBe('FROZEN-M5');
    store = await openEventsStore({ path: ':memory:' });
    server = await startHooksServer({ events: store.events, port: 0, nowMs: () => 4242 });
    expect(server.state).toBe('listening');
  });
  afterEach(async () => {
    await server.close();
    store.close();
  });

  it('binds loopback-only', () => {
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('answers every golden fixture with its frozen status (bytes replayed verbatim)', async () => {
    let acceptedCount = 0;
    for (const fixture of GOLDEN_HOOK_FIXTURES) {
      const response = await postFixture(server, fixture.accountSegment, fixture.bodyJson);
      if (fixture.expect.accepted) {
        acceptedCount += 1;
        // No floor is wired in this suite → gating-capable accepts still
        // answer 204 (the contract DEFAULT: no opinion).
        expect(response.status, fixture.name).toBe(204);
      } else {
        expect(response.status, fixture.name).toBe(fixture.expect.httpStatus);
      }
    }
    // Every ACCEPTED post landed exactly one events row, source `hooks`.
    const rows = store.events.list();
    expect(rows).toHaveLength(acceptedCount);
    for (const row of rows) {
      expect(row.source).toBe('hooks');
      expect(row.tsMs).toBe(4242);
    }
    const stats = server.stats();
    expect(stats.accepted).toBe(acceptedCount);
    expect(stats.rejected404).toBe(
      GOLDEN_HOOK_FIXTURES.filter((f) => !f.expect.accepted && f.expect.httpStatus === 404).length,
    );
    expect(stats.rejected400).toBe(
      GOLDEN_HOOK_FIXTURES.filter((f) => !f.expect.accepted && f.expect.httpStatus === 400).length,
    );
  });

  it('normalizes hook rows with path-label attribution + tool/file extraction', async () => {
    await postFixture(
      server,
      'MAX_A',
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'synth-native-1',
        tool_name: 'Read',
        tool_input: { file_path: '/synthetic/file.ts' },
      }),
    );
    const rows = store.events.list();
    expect(rows[0]).toMatchObject({
      backend: 'claude_code',
      account: 'MAX_A',
      eventType: 'PreToolUse',
      nativeSessionId: 'synth-native-1',
      toolName: 'Read',
      fileRefs: ['/synthetic/file.ts'],
    });
  });

  it('unknown event names land as rows too (the vocabulary-bump rule)', async () => {
    await postFixture(
      server,
      'ENT',
      JSON.stringify({ hook_event_name: 'FutureEventFromMinorBump', session_id: 'synth-native-3' }),
    );
    expect(store.events.list()[0]?.eventType).toBe('FutureEventFromMinorBump');
  });

  it('non-POST and non-prefix paths answer 404', async () => {
    const get = await fetch(`${server.url}/hooks/v1/MAX_A`);
    expect(get.status).toBe(404);
    const wrong = await fetch(`${server.url}/other/path`, { method: 'POST', body: '{}' });
    expect(wrong.status).toBe(404);
  });

  it('handles port-in-use gracefully (state, not a crash)', async () => {
    const second = await startHooksServer({ events: store.events, port: server.port });
    expect(second.state).toBe('port-in-use');
    await second.close();
  });
});

describe('PermissionRequest → ApprovalBroker hook-floor relay (real M2 broker)', () => {
  let store: EventsStore;
  let broker: ApprovalBroker;

  beforeEach(async () => {
    store = await openEventsStore({ path: ':memory:' });
    broker = createApprovalBroker();
  });
  afterEach(() => {
    broker.close();
    store.close();
  });

  it('observe posture: relays into the hook-floor queue slot, answers 204', async () => {
    const server = await startHooksServer({
      events: store.events,
      approvals: broker,
      floorPosture: 'observe',
      port: 0,
    });
    const response = await postFixture(server, 'MAX_B', PERMISSION_REQUEST_BODY);
    expect(response.status).toBe(204); // no opinion until the T3 proof lands
    const pending = broker.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      source: 'hook-floor',
      accountLabel: 'MAX_B',
      sessionId: 'synth-native-2', // native id relayed when unmapped
      toolName: 'Bash',
      toolUseId: 'toolu_synth_9',
    });
    // The summary is identifier-free — built from the tool name alone [X2].
    expect(pending[0]?.summary).toBe('hook floor: session requests Bash');
    expect(server.stats().relaysRaised).toBe(1);
    await server.close();
  });

  it('maps the native session id to a harness id when the ledger knows one', async () => {
    const server = await startHooksServer({
      events: store.events,
      approvals: broker,
      sessionIdOfNative: (native) => (native === 'synth-native-2' ? 'ses_harness01' : undefined),
      port: 0,
    });
    await postFixture(server, 'MAX_B', PERMISSION_REQUEST_BODY);
    expect(broker.pending()[0]?.sessionId).toBe('ses_harness01');
    await server.close();
  });

  it('escalate posture: a human ALLOW in time answers 200 {permissionDecision:"allow"}', async () => {
    const server = await startHooksServer({
      events: store.events,
      approvals: broker,
      floorPosture: 'escalate',
      floorTimeoutMs: 2_000,
      port: 0,
    });
    const responsePromise = postFixture(server, 'MAX_A', PERMISSION_REQUEST_BODY);
    await waitFor(() => broker.pending().length === 1);
    const approvalId = broker.pending()[0]?.approvalId as string;
    broker.decide({ kind: 'approval-decision', approvalId, verdict: 'allow' });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ permissionDecision: 'allow' });
    await server.close();
  });

  it('escalate posture: a DENY relays the note as the decision reason', async () => {
    const server = await startHooksServer({
      events: store.events,
      approvals: broker,
      floorPosture: 'escalate',
      floorTimeoutMs: 2_000,
      port: 0,
    });
    const responsePromise = postFixture(server, 'MAX_A', PERMISSION_REQUEST_BODY);
    await waitFor(() => broker.pending().length === 1);
    const approvalId = broker.pending()[0]?.approvalId as string;
    broker.decide({
      kind: 'approval-decision',
      approvalId,
      verdict: 'deny',
      note: 'blocked by harness policy floor',
    });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: 'blocked by harness policy floor',
    });
    await server.close();
  });

  it('escalate posture: no decision in time expires → 204 (never stalls the session)', async () => {
    const server = await startHooksServer({
      events: store.events,
      approvals: broker,
      floorPosture: 'escalate',
      floorTimeoutMs: 50, // the broker ttl resolves the race as `expired`
      port: 0,
    });
    const response = await postFixture(server, 'MAX_A', PERMISSION_REQUEST_BODY);
    expect(response.status).toBe(204);
    expect(broker.pending()).toHaveLength(0); // expired, not leaked
    await server.close();
  });

  it('a PermissionRequest without tool_name is accepted but NOT relayed (nothing to summarize)', async () => {
    const server = await startHooksServer({
      events: store.events,
      approvals: broker,
      port: 0,
    });
    const response = await postFixture(
      server,
      'ENT',
      JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'synth-native-3' }),
    );
    expect(response.status).toBe(204);
    expect(broker.pending()).toHaveLength(0);
    expect(store.events.list()).toHaveLength(1); // the row still landed
    await server.close();
  });

  it('a gating opinion can never gate a non-gating event (SessionEnd stays 204)', async () => {
    const server = await startHooksServer({
      events: store.events,
      approvals: broker,
      floorPosture: 'escalate',
      port: 0,
    });
    const response = await postFixture(
      server,
      'MAX_A',
      JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'synth-native-1' }),
    );
    expect(response.status).toBe(204);
    await server.close();
  });
});
