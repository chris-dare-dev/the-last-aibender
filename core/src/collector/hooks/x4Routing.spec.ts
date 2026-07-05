/**
 * [X4] automation routing through the REAL accepting endpoint (BE-7 narrow
 * wiring; hooks-contract.md §7.1): SessionEnd/PreCompact are POST-ACK
 * fire-and-forget; SessionStart rides the response, deadline-raced; absent
 * slots keep the M3 events-store-only behavior. Driven over real loopback
 * HTTP with the REAL WorkstreamHookAutomation over the REAL lineage store.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkstreamHookRouting } from '@aibender/protocol';
import { openEventsStore, openKernelStore, type EventsStore, type KernelStore } from '@aibender/schema';

import { createWorkstreamHookAutomation, type WorkstreamHookAutomation } from '../../workstreams/index.js';
import { startHooksServer, type HooksServer } from './server.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

interface Harness {
  readonly server: HooksServer;
  readonly events: EventsStore;
  readonly kernel: KernelStore;
  readonly automation: WorkstreamHookAutomation;
}

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.server.close();
    harness.events.close();
    harness.kernel.close();
  }
});

async function harness(
  options: {
    readonly routing?: WorkstreamHookRouting;
    readonly sessionStartTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const events = await openEventsStore({ path: ':memory:' });
  const kernel = await openKernelStore({ path: ':memory:' });
  const automation = createWorkstreamHookAutomation({ store: kernel.lineage });
  const server = await startHooksServer({
    events: events.events,
    port: 0,
    workstreams: options.routing ?? automation,
    ...(options.sessionStartTimeoutMs !== undefined
      ? { sessionStartTimeoutMs: options.sessionStartTimeoutMs }
      : {}),
  });
  expect(server.state).toBe('listening');
  const built = { server, events, kernel, automation };
  open.push(built);
  return built;
}

function insertNode(kernel: KernelStore, id: string, nativeSessionId: string): void {
  kernel.lineage.nodes.insert({
    id,
    backend: 'claude_code',
    account: 'MAX_A',
    nativeSessionId,
    cwd: '/synthetic/workspace',
    state: 'running',
    origin: 'harness',
    confidence: 'recorded',
  });
}

function post(server: HooksServer, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${server.url}/hooks/v1/MAX_A`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('SessionEnd routing (POST-ACK fire-and-forget)', () => {
  it('answers 204 and the auto continuation brief lands after the ack', async () => {
    const { server, kernel, automation } = await harness();
    insertNode(kernel, 'ses_live', 'native-rt-01');

    const response = await post(server, {
      hook_event_name: 'SessionEnd',
      session_id: 'native-rt-01',
    });
    expect(response.status).toBe(204);

    await automation.settle();
    await waitFor(() => kernel.lineage.briefs.list({ kinds: ['session-end'] }).length === 1);
    expect(server.stats().automationRouted).toBe(1);
  });

  it('duplicate posts stay idempotent through the wire (ONE brief)', async () => {
    const { server, kernel, automation } = await harness();
    insertNode(kernel, 'ses_live', 'native-rt-01');
    const body = { hook_event_name: 'SessionEnd', session_id: 'native-rt-01' };
    expect((await post(server, body)).status).toBe(204);
    expect((await post(server, body)).status).toBe(204);
    await automation.settle();
    await sleep(20);
    expect(kernel.lineage.briefs.list({ kinds: ['session-end'] })).toHaveLength(1);
  });

  it('a THROWING handler never fails the session (204 stands)', async () => {
    const routing: WorkstreamHookRouting = {
      onSessionEnd: () => {
        throw new Error('synthetic handler explosion');
      },
    };
    const { server } = await harness({ routing });
    const response = await post(server, {
      hook_event_name: 'SessionEnd',
      session_id: 'native-x',
    });
    expect(response.status).toBe(204);
  });
});

describe('PreCompact routing (snapshot + compact edge, post-ack)', () => {
  it('answers 204; the snapshot node and compact edge land after', async () => {
    const { server, kernel, automation } = await harness();
    insertNode(kernel, 'ses_live', 'native-rt-02');
    const response = await post(server, {
      hook_event_name: 'PreCompact',
      session_id: 'native-rt-02',
      trigger: 'auto',
    });
    expect(response.status).toBe(204);
    await automation.settle();
    await waitFor(() => kernel.lineage.edges.list({ edgeTypes: ['compact'] }).length === 1);
  });
});

describe('SessionStart routing (the ONE response-riding handler)', () => {
  it('answers 200 + the frozen HookSessionStartOutput with the latest brief on resume', async () => {
    const { server, kernel } = await harness();
    insertNode(kernel, 'ses_live', 'native-rt-03');
    kernel.lineage.briefs.insert({
      id: 'br_latest',
      kind: 'session-end',
      bodyMd: 'brief for /synthetic/workspace continuation',
      sourceNodes: ['ses_live'],
      provenance: 'local-draft',
    });

    const response = await post(server, {
      hook_event_name: 'SessionStart',
      session_id: 'native-rt-03',
      source: 'resume',
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(payload.hookSpecificOutput.additionalContext).toContain('brief for');
    expect(server.stats().injectionsAnswered).toBe(1);
  });

  it('startup source / unknown session / no brief → 204 (no injection)', async () => {
    const { server, kernel } = await harness();
    insertNode(kernel, 'ses_live', 'native-rt-04');
    for (const body of [
      { hook_event_name: 'SessionStart', session_id: 'native-rt-04', source: 'startup' },
      { hook_event_name: 'SessionStart', session_id: 'native-ghost', source: 'resume' },
      { hook_event_name: 'SessionStart', session_id: 'native-rt-04', source: 'resume' }, // no brief yet
    ]) {
      const response = await post(server, body);
      expect(response.status).toBe(204);
    }
  });

  it('a SLOW handler is deadline-raced to 204 — the ack never stalls', async () => {
    const routing: WorkstreamHookRouting = {
      onSessionStart: async () => {
        await sleep(500);
        return {
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'too late' },
        };
      },
    };
    const { server } = await harness({ routing, sessionStartTimeoutMs: 25 });
    const started = Date.now();
    const response = await post(server, {
      hook_event_name: 'SessionStart',
      session_id: 'native-slow',
      source: 'resume',
    });
    expect(response.status).toBe(204);
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe('unregistered routing (the M3 default)', () => {
  it('automation events answer 204 and stay events-store-only', async () => {
    const events = await openEventsStore({ path: ':memory:' });
    const kernel = await openKernelStore({ path: ':memory:' });
    const server = await startHooksServer({ events: events.events, port: 0 });
    try {
      const response = await fetch(`${server.url}/hooks/v1/MAX_A`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'native-m3' }),
      });
      expect(response.status).toBe(204);
      expect(server.stats().automationRouted).toBe(0);
      expect(server.stats().rowsInserted).toBe(1); // the M3 behavior exactly
    } finally {
      await server.close();
      events.close();
      kernel.close();
    }
  });
});
