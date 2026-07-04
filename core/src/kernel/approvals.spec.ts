/**
 * ApprovalBroker + canUseTool bridge + kernel wiring (plan §4/BE-2;
 * ws-protocol.md §10 FROZEN-M2; §9.3 BE↔FE #4 approval round-trip,
 * broker-side half).
 *
 * Golden-corpus discipline: every payload the broker EMITS must pass the
 * frozen validateApprovalsServerMessage, and the golden client `decision`
 * fixtures drive broker.decide verbatim (no parallel fixture corpus).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateApprovalsServerMessage,
  type ApprovalDecision,
  type ApprovalsServerPayload,
} from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import { FakeQueryRunner, GOLDEN_WS_FIXTURES } from '@aibender/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  approvalRelayFromBroker,
  createApprovalBroker,
  createCanUseToolBridge,
  DEFAULT_APPROVAL_TTL_MS,
} from './approvals.js';
import { KernelError } from './errors.js';
import { createProfileRegistry } from './profiles.js';
import { createSdkQueryRunner, type QueryFn, type SdkQueryLike } from './sdkQueryRunner.js';
import { createSessionKernel } from './sessionKernel.js';

const goldenPayload = (name: string): Record<string, unknown> => {
  const fixture = GOLDEN_WS_FIXTURES.find((entry) => entry.name === name);
  if (fixture === undefined || fixture.kind !== 'text') throw new Error(`missing golden ${name}`);
  return (JSON.parse(fixture.frame) as { payload: Record<string, unknown> }).payload;
};

const CAN_USE_TOOL_INPUT = {
  source: 'can-use-tool',
  summary: 'tool escalation: Bash',
  accountLabel: 'MAX_A',
  sessionId: 'ses_fake_1',
  toolName: 'Bash',
} as const;

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Broker — positive
// ---------------------------------------------------------------------------

describe('ApprovalBroker — positive', () => {
  it('queues a request, fans out a FROZEN-valid approval-request, resolves on allow', async () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const emitted: ApprovalsServerPayload[] = [];
    broker.subscribe((message) => emitted.push(message));

    const handle = broker.request({ ...CAN_USE_TOOL_INPUT, toolUseId: 'synthtool-9' });
    expect(broker.pending()).toEqual([handle.request]);
    expect(emitted).toEqual([handle.request]);
    // every broker emission passes the frozen validator (golden discipline)
    const validated = validateApprovalsServerMessage(handle.request);
    expect(validated.ok).toBe(true);

    const resolved = broker.decide({
      kind: 'approval-decision',
      approvalId: handle.approvalId,
      verdict: 'allow',
      updatedInput: { command: 'ls -la' },
    });
    expect(resolved).toEqual({
      kind: 'approval-resolved',
      approvalId: handle.approvalId,
      outcome: 'allowed',
    });
    expect(validateApprovalsServerMessage(resolved).ok).toBe(true);
    expect(emitted).toEqual([handle.request, resolved]);
    expect(broker.pending()).toEqual([]);

    await expect(handle.resolution).resolves.toEqual({
      outcome: 'allowed',
      updatedInput: { command: 'ls -la' },
    });
    broker.close();
  });

  it('replays the golden approval-decision fixtures verbatim against pinned ids', async () => {
    // allow + updatedInput (fixture approval-decision-allow → apr_fake_1)
    const allowDecision = goldenPayload('approval-decision-allow') as unknown as ApprovalDecision;
    const brokerA = createApprovalBroker({
      defaultTtlMs: null,
      newApprovalId: () => 'apr_fake_1',
    });
    const handleA = brokerA.request(CAN_USE_TOOL_INPUT);
    expect(handleA.approvalId).toBe('apr_fake_1');
    expect(brokerA.decide(allowDecision).outcome).toBe('allowed');
    await expect(handleA.resolution).resolves.toEqual({
      outcome: 'allowed',
      updatedInput: allowDecision.updatedInput,
    });
    brokerA.close();

    // deny + note (fixture approval-decision-deny-note → apr_fake_2)
    const denyDecision = goldenPayload('approval-decision-deny-note') as unknown as ApprovalDecision;
    const brokerB = createApprovalBroker({
      defaultTtlMs: null,
      newApprovalId: () => 'apr_fake_2',
    });
    const handleB = brokerB.request(CAN_USE_TOOL_INPUT);
    expect(brokerB.decide(denyDecision).outcome).toBe('denied');
    await expect(handleB.resolution).resolves.toEqual({
      outcome: 'denied',
      note: denyDecision.note,
    });
    brokerB.close();
  });

  it('accepts hook-floor and workflow-gate requests through the same queue (M3/M5 slots)', () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const floor = broker.request({
      source: 'hook-floor',
      summary: 'synthesized policy-floor escalation',
      accountLabel: 'ENT',
      sessionId: 'ses_fake_2',
      toolName: 'Write',
    });
    const gate = broker.request({
      source: 'workflow-gate',
      summary: 'synthesized pipeline gate',
      accountLabel: 'AWS_DEV',
      runId: 'run_fake_1',
      stepId: 'step_fake_2',
    });
    for (const handle of [floor, gate]) {
      expect(validateApprovalsServerMessage(handle.request).ok).toBe(true);
    }
    expect(broker.pending()).toHaveLength(2);
    broker.close();
  });
});

// ---------------------------------------------------------------------------
// Broker — negative
// ---------------------------------------------------------------------------

describe('ApprovalBroker — negative', () => {
  it('a decision for an unknown approval answers approval-not-pending', () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    try {
      broker.decide({ kind: 'approval-decision', approvalId: 'apr_unknown', verdict: 'allow' });
      expect.unreachable('decide must throw');
    } catch (cause) {
      expect(cause).toBeInstanceOf(KernelError);
      expect((cause as KernelError).code).toBe('approval-not-pending');
    }
    broker.close();
  });

  it('a second decision answers approval-not-pending (multi-window race is NORMAL)', () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const handle = broker.request(CAN_USE_TOOL_INPUT);
    broker.decide({ kind: 'approval-decision', approvalId: handle.approvalId, verdict: 'deny' });
    expect(() =>
      broker.decide({ kind: 'approval-decision', approvalId: handle.approvalId, verdict: 'allow' }),
    ).toThrow(KernelError);
    broker.close();
  });

  it('updatedInput with deny answers bad-request (frozen §10.2 rule, defense in depth)', () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const handle = broker.request(CAN_USE_TOOL_INPUT);
    try {
      broker.decide({
        kind: 'approval-decision',
        approvalId: handle.approvalId,
        verdict: 'deny',
        updatedInput: { command: 'rm -rf /synthetic' },
      });
      expect.unreachable('decide must throw');
    } catch (cause) {
      expect((cause as KernelError).code).toBe('bad-request');
    }
    expect(broker.pending()).toHaveLength(1); // request untouched by the bad decision
    broker.close();
  });

  it('enforces the frozen per-source field matrix at request time (programmer error)', () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    // can-use-tool without a session
    expect(() =>
      broker.request({
        source: 'can-use-tool',
        summary: 's',
        accountLabel: 'MAX_A',
        toolName: 'Bash',
      }),
    ).toThrow(RangeError);
    // workflow-gate carrying tool refs (golden approval-request-matrix-violation)
    expect(() =>
      broker.request({
        source: 'workflow-gate',
        summary: 'synthesized matrix violation',
        accountLabel: 'AWS_DEV',
        runId: 'run_fake_1',
        stepId: 'step_fake_2',
        toolName: 'Bash',
      }),
    ).toThrow(RangeError);
    // hook-floor without a tool
    expect(() =>
      broker.request({
        source: 'hook-floor',
        summary: 's',
        accountLabel: 'ENT',
        sessionId: 'ses_fake_2',
      }),
    ).toThrow(RangeError);
    expect(broker.pending()).toEqual([]);
    broker.close();
  });
});

// ---------------------------------------------------------------------------
// Broker — edge (timeout policy, supersede, close)
// ---------------------------------------------------------------------------

describe('ApprovalBroker — edge', () => {
  it('expiry resolves `expired`, fans out, and later decisions answer approval-not-pending', async () => {
    vi.useFakeTimers();
    const broker = createApprovalBroker({ defaultTtlMs: 1000 });
    const emitted: ApprovalsServerPayload[] = [];
    broker.subscribe((message) => emitted.push(message));

    const handle = broker.request(CAN_USE_TOOL_INPUT);
    expect(handle.request.expiresAt).toBe(Date.now() + 1000);

    await vi.advanceTimersByTimeAsync(1001);
    await expect(handle.resolution).resolves.toEqual({ outcome: 'expired' });
    expect(emitted.at(-1)).toEqual({
      kind: 'approval-resolved',
      approvalId: handle.approvalId,
      outcome: 'expired',
    });
    expect(() =>
      broker.decide({ kind: 'approval-decision', approvalId: handle.approvalId, verdict: 'allow' }),
    ).toThrow(KernelError);
    broker.close();
  });

  it('a decision BEFORE expiry wins and the timer is cancelled', async () => {
    vi.useFakeTimers();
    const broker = createApprovalBroker({ defaultTtlMs: 1000 });
    const handle = broker.request(CAN_USE_TOOL_INPUT);
    broker.decide({ kind: 'approval-decision', approvalId: handle.approvalId, verdict: 'allow' });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(handle.resolution).resolves.toEqual({ outcome: 'allowed' });
    broker.close();
  });

  it('supersedeSession resolves exactly that session’s pending approvals', async () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const mine = broker.request(CAN_USE_TOOL_INPUT);
    const other = broker.request({ ...CAN_USE_TOOL_INPUT, sessionId: 'ses_fake_2' });
    expect(broker.supersedeSession('ses_fake_1')).toBe(1);
    await expect(mine.resolution).resolves.toEqual({ outcome: 'superseded' });
    expect(broker.pending()).toEqual([other.request]);
    broker.close();
  });

  it('close supersedes everything and refuses new requests', async () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const handle = broker.request(CAN_USE_TOOL_INPUT);
    broker.close();
    await expect(handle.resolution).resolves.toEqual({ outcome: 'superseded' });
    expect(() => broker.request(CAN_USE_TOOL_INPUT)).toThrow(KernelError);
  });

  it('a throwing subscriber never wedges the queue', () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    broker.subscribe(() => {
      throw new Error('synthetic subscriber failure');
    });
    const seen: ApprovalsServerPayload[] = [];
    broker.subscribe((message) => seen.push(message));
    const handle = broker.request(CAN_USE_TOOL_INPUT);
    expect(seen).toEqual([handle.request]);
    broker.close();
  });

  it('default TTL is the documented timeout policy', () => {
    expect(DEFAULT_APPROVAL_TTL_MS).toBe(10 * 60 * 1000);
    const broker = createApprovalBroker();
    const handle = broker.request(CAN_USE_TOOL_INPUT);
    expect(handle.request.expiresAt).toBeDefined();
    broker.close();
  });
});

// ---------------------------------------------------------------------------
// canUseTool bridge
// ---------------------------------------------------------------------------

describe('createCanUseToolBridge', () => {
  const CTX = { sessionId: 'ses_fake_1', accountLabel: 'MAX_A' } as const;

  it('escalates with an identifier-free tool-name summary and applies allow + updatedInput', async () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const handler = createCanUseToolBridge(broker, CTX);

    const pending = handler(
      'Bash',
      { command: 'ls /Users/definitely-not-on-the-wire' },
      { toolUseId: 'tu_1' },
    );
    const request = broker.pending()[0];
    expect(request).toMatchObject({
      source: 'can-use-tool',
      sessionId: 'ses_fake_1',
      accountLabel: 'MAX_A',
      toolName: 'Bash',
      toolUseId: 'tu_1',
      summary: 'tool escalation: Bash',
    });
    // [X2]: the tool INPUT (which carries paths) never reaches the wire shape
    expect(JSON.stringify(request)).not.toContain('definitely-not-on-the-wire');

    broker.decide({
      kind: 'approval-decision',
      approvalId: request!.approvalId,
      verdict: 'allow',
      updatedInput: { command: 'ls' },
    });
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
    broker.close();
  });

  it('allow WITHOUT updatedInput echoes the original input (SDK contract)', async () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const handler = createCanUseToolBridge(broker, CTX);
    const pending = handler('Read', { file_path: '/synthetic/a' }, {});
    broker.decide({
      kind: 'approval-decision',
      approvalId: broker.pending()[0]!.approvalId,
      verdict: 'allow',
    });
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/synthetic/a' },
    });
    broker.close();
  });

  it('deny relays the note; expiry and supersede map to fail-safe denies', async () => {
    vi.useFakeTimers();
    const broker = createApprovalBroker({ defaultTtlMs: 500 });
    const handler = createCanUseToolBridge(broker, CTX);

    const denied = handler('Bash', {}, {});
    broker.decide({
      kind: 'approval-decision',
      approvalId: broker.pending()[0]!.approvalId,
      verdict: 'deny',
      note: 'synthesized denial rationale',
    });
    await expect(denied).resolves.toEqual({
      behavior: 'deny',
      message: 'synthesized denial rationale',
    });

    const expiring = handler('Bash', {}, {});
    await vi.advanceTimersByTimeAsync(501);
    await expect(expiring).resolves.toEqual({
      behavior: 'deny',
      message: 'approval expired with no decision',
    });

    const superseded = handler('Bash', {}, {});
    broker.supersedeSession('ses_fake_1');
    await expect(superseded).resolves.toEqual({
      behavior: 'deny',
      message: 'approval superseded (session or run ended)',
    });
    broker.close();
  });

  it('an aborted SDK operation supersedes its pending approval', async () => {
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const handler = createCanUseToolBridge(broker, CTX);
    const controller = new AbortController();
    const pending = handler('Bash', {}, { signal: controller.signal });
    expect(broker.pending()).toHaveLength(1);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(broker.pending()).toEqual([]);
    broker.close();
  });
});

// ---------------------------------------------------------------------------
// Kernel + SDK-runner wiring (the M1 lifecycle carries the relay)
// ---------------------------------------------------------------------------

describe('canUseTool wiring into the M1 SDK lifecycle', () => {
  const HOME = join(mkdtempSync(join(tmpdir(), 'aibender-approvals-')), 'home');
  const stores: KernelStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  async function makeKernel() {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    const broker = createApprovalBroker({ defaultTtlMs: null });
    const runner = new FakeQueryRunner({ mode: 'manual' });
    const kernel = createSessionKernel({
      ledger: store.resumeLedger,
      profiles: createProfileRegistry({ aibenderHome: HOME }),
      runner,
      baseEnv: { PATH: '/usr/bin' },
      approvals: approvalRelayFromBroker(broker),
    });
    return { store, broker, runner, kernel };
  }

  it('every SDK spawn carries a per-session handler; decisions flow through the broker', async () => {
    const { broker, runner, kernel } = await makeKernel();
    const session = await kernel.launch({
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/workspace',
      purpose: 'approval wiring',
      prompt: 'synthesized prompt',
    });

    // No cast: testkit's QuerySpec mirror carries canUseTool (ICR-0001 drift rule).
    const spec = runner.starts[0]!;
    expect(spec.canUseTool).toBeDefined();

    const pending = spec.canUseTool!('Bash', { command: 'ls' }, { toolUseId: 'tu_9' });
    const request = broker.pending()[0];
    expect(request).toMatchObject({
      source: 'can-use-tool',
      sessionId: session.sessionId, // the HARNESS id, never a native id
      accountLabel: 'MAX_A',
      toolName: 'Bash',
      toolUseId: 'tu_9',
    });

    broker.decide({
      kind: 'approval-decision',
      approvalId: request!.approvalId,
      verdict: 'allow',
      updatedInput: { command: 'ls -la' },
    });
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });

    runner.session(session.sessionId).complete();
    await session.waitForExit();
    broker.close();
  });

  it('session end supersedes that session’s pending approvals (waits never dangle)', async () => {
    const { broker, runner, kernel } = await makeKernel();
    const session = await kernel.launch({
      accountLabel: 'MAX_B',
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/workspace',
      purpose: 'supersede on exit',
      prompt: 'synthesized prompt',
    });
    // No cast: testkit's QuerySpec mirror carries canUseTool (ICR-0001 drift rule).
    const spec = runner.starts[0]!;
    const pending = spec.canUseTool!('Write', {}, {});
    expect(broker.pending()).toHaveLength(1);

    runner.session(session.sessionId).complete();
    await session.waitForExit();

    expect(broker.pending()).toEqual([]);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    broker.close();
  });

  it('without the approvals option the M1 spec shape is unchanged', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    const runner = new FakeQueryRunner();
    const kernel = createSessionKernel({
      ledger: store.resumeLedger,
      profiles: createProfileRegistry({ aibenderHome: HOME }),
      runner,
      baseEnv: { PATH: '/usr/bin' },
    });
    const session = await kernel.launch({
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'sdk',
      cwd: '/synthetic/workspace',
      purpose: 'm1 unchanged',
      prompt: 'synthesized prompt',
    });
    await session.waitForExit();
    expect(runner.starts[0]?.canUseTool).toBeUndefined();
    expect('canUseTool' in (runner.starts[0] as object)).toBe(false);
  });

  it('the SDK runner forwards the handler as query() canUseTool (toolUseID → toolUseId)', async () => {
    const captured: { options?: Record<string, unknown> }[] = [];
    const fakeQuery = (): SdkQueryLike => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'fake-native-9' };
        yield { type: 'result', subtype: 'success' };
      },
      interrupt: async () => undefined,
    });
    const queryFn: QueryFn = (params) => {
      captured.push(params);
      return fakeQuery();
    };
    const runner = createSdkQueryRunner({
      liveSpawnOptIn: true,
      pathToClaudeCodeExecutable: '/synthetic/sdk-bundled/claude',
      queryFn,
    });

    const contexts: unknown[] = [];
    await runner.start({
      sessionId: 'ses_fake_1',
      prompt: 'p',
      cwd: '/synthetic/workspace',
      env: { PATH: '/usr/bin' },
      abortController: new AbortController(),
      canUseTool: async (toolName, _input, context) => {
        contexts.push([toolName, context]);
        return { behavior: 'deny', message: 'synthetic deny' };
      },
    });

    const sdkCanUseTool = captured[0]?.options?.['canUseTool'] as
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: { signal?: AbortSignal; toolUseID?: string },
        ) => Promise<unknown>)
      | undefined;
    expect(sdkCanUseTool).toBeDefined();
    const signal = new AbortController().signal;
    await expect(
      sdkCanUseTool!('Bash', { command: 'ls' }, { signal, toolUseID: 'tu_42' }),
    ).resolves.toEqual({ behavior: 'deny', message: 'synthetic deny' });
    expect(contexts).toEqual([['Bash', { signal, toolUseId: 'tu_42' }]]);

    // absent handler → absent option (M1 shape preserved)
    await runner.start({
      sessionId: 'ses_fake_2',
      prompt: 'p',
      cwd: '/synthetic/workspace',
      env: { PATH: '/usr/bin' },
      abortController: new AbortController(),
    });
    expect(captured[1]?.options).not.toHaveProperty('canUseTool');
  });
});
