/**
 * §9.3 BE↔FE #4 — the approval round-trip, END-TO-END over the real wire,
 * proving BOTH sources land in the SAME single inbox and resume the same way:
 *   - M2  `can-use-tool` escalation → inbox → decision → the awaiting promise
 *     resolves (a session would proceed);
 *   - M5  workflow `approval` gate PAUSE → the SAME approvals channel → the
 *     SAME `approval-decision` → the gate RESUMES.
 *
 * core/src/main/m2ApprovalRoundTrip.spec.ts already proves the M2 half through
 * the kernel's canUseTool relay. THIS suite's cross-department contribution is
 * the §9.3 clause "workflow `approval` gate pause/resume via the SAME inbox" —
 * the M2+M5 tie the contract-of-record note (integration-suite.md §2 item 4)
 * calls out. We assemble the REAL ApprovalBroker + REAL BE-3 gateway and drive
 * the pipeline gate adapter EXACTLY as composeBroker's `approvalGateFromBroker`
 * does (workflow-gate source, runId/stepId), so the pause/resume rides the one
 * M2 inbox with no new gate wire.
 *
 * The broker is the real BE-2 ApprovalBroker (no fakes on the approval path);
 * only the account/SDK substrate is out of scope here (T3).
 *
 * [X2]: every summary/label/id is synthesized and identifier-free.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { CHANNEL, type ApprovalRequest, type ApprovalResolved } from '@aibender/protocol';

import { startGateway, type GatewayHandle } from '../../../../core/src/gateway/server.ts';
import {
  createApprovalBroker,
  toApprovalBrokerGatewayPort,
  type ApprovalBroker,
} from '../../../../core/src/kernel/index.ts';
import type {
  GateOutcome,
  PipelineApprovalGate,
} from '../../../../core/src/pipelines/index.ts';

import { WireClient, waitFor } from '../support/wireClient.ts';

/**
 * The composeBroker adapter, inlined here so the seam is exercised exactly as
 * the daemon does (core/src/main/index.ts `approvalGateFromBroker`): a
 * pipeline `approval` step becomes a `workflow-gate` broker request that rides
 * the M2 approvals channel.
 */
function approvalGateFromBroker(broker: ApprovalBroker): PipelineApprovalGate {
  return {
    request: (input) => {
      const handle = broker.request({
        source: 'workflow-gate',
        summary: input.summary,
        accountLabel: input.accountLabel,
        runId: input.runId,
        stepId: input.stepId,
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      });
      return { resolution: handle.resolution.then((r) => ({ outcome: r.outcome })) };
    },
  };
}

let broker: ApprovalBroker;
let handle: GatewayHandle;
let home: string;
const clients: WireClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await handle?.close();
  broker?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

async function harness(): Promise<void> {
  broker = createApprovalBroker();
  home = await mkdtemp(join(tmpdir(), 'aibender-integ-approve-'));
  handle = await startGateway({
    kernel: {
      // A minimal GatewayKernel: this suite drives the approvals channel only,
      // never launches; the control channel is unused here.
      launch: () => Promise.reject(new Error('not used')),
      resume: () => Promise.reject(new Error('not used')),
      status: () => [],
      kill: () => Promise.reject(new Error('not used')),
    } as unknown as Parameters<typeof startGateway>[0]['kernel'],
    approvals: toApprovalBrokerGatewayPort(broker),
    aibenderHome: home,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

function inbox(): { requests: ApprovalRequest[]; resolved: ApprovalResolved[] } {
  const requests: ApprovalRequest[] = [];
  const resolved: ApprovalResolved[] = [];
  return { requests, resolved };
}

async function connectInbox(collector: {
  requests: ApprovalRequest[];
  resolved: ApprovalResolved[];
}): Promise<WireClient> {
  const client = await WireClient.connect(handle.url, handle.token, {
    onEnvelope: (envelope) => {
      if (envelope.channel !== CHANNEL.APPROVALS) return;
      const payload = envelope.payload as { kind?: string };
      if (payload.kind === 'approval-request') collector.requests.push(payload as ApprovalRequest);
      if (payload.kind === 'approval-resolved') collector.resolved.push(payload as ApprovalResolved);
    },
  });
  clients.push(client);
  return client;
}

describe('BE↔FE #4 — approval round-trip: M2 canUseTool AND M5 workflow gate, one inbox', () => {
  it('M2 can-use-tool: request → inbox → decision over the same socket → promise resolves', async () => {
    await harness();
    const collector = inbox();
    const client = await connectInbox(collector);

    // A canUseTool-source escalation (what the kernel raises for an SDK tool).
    const pending = broker.request({
      source: 'can-use-tool',
      summary: 'run a synthesized tool',
      accountLabel: 'MAX_A',
      sessionId: 'ses_fake_integ_1',
      toolName: 'Read',
      toolUseId: 'toolu_integ_1',
    });

    await waitFor(() => collector.requests.length === 1);
    const request = collector.requests[0]!;
    expect(request.source).toBe('can-use-tool');
    expect(request.toolName).toBe('Read');

    // The FE answers over the SAME socket (the single inbox).
    client.send(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: request.approvalId,
      verdict: 'allow',
    });

    const outcome = await pending.resolution;
    expect(outcome.outcome).toBe('allowed');
    await waitFor(() => collector.resolved.length === 1);
    // The resolution fanned out on the SAME channel carries the outcome.
    expect(collector.resolved[0]!.outcome).toBe('allowed');
    expect(collector.resolved[0]!.approvalId).toBe(request.approvalId);
  });

  it('M5 workflow gate: pause → the SAME approvals inbox → decision → gate resumes', async () => {
    await harness();
    const collector = inbox();
    const client = await connectInbox(collector);

    // Drive the pipeline gate adapter — a workflow `approval` step PAUSES the
    // walk by raising a workflow-gate request on the M2 approvals channel.
    const gate = approvalGateFromBroker(broker);
    const gateHandle = gate.request({
      runId: 'run_integ_1',
      stepId: 'gate_1',
      summary: 'approve step gate_1 before proceeding',
      accountLabel: 'MAX_B',
    });

    // It rides the SAME inbox, tagged workflow-gate with run/step refs and NO
    // tool fields (the frozen §10.1 per-source matrix).
    await waitFor(() => collector.requests.length === 1);
    const request = collector.requests[0]!;
    expect(request.source).toBe('workflow-gate');
    expect(request.runId).toBe('run_integ_1');
    expect(request.stepId).toBe('gate_1');
    expect(request.toolName).toBeUndefined();

    // Still pending until the owner decides (pause holds).
    let settled = false;
    void gateHandle.resolution.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    // The owner approves through the SAME single inbox → the gate RESUMES.
    client.send(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: request.approvalId,
      verdict: 'allow',
    });

    const resolution: { outcome: GateOutcome } = await gateHandle.resolution;
    expect(resolution.outcome).toBe('allowed');
    await waitFor(() => collector.resolved.length === 1);
  });

  it('a DENY at the workflow gate resolves the gate as denied (abort path)', async () => {
    await harness();
    const collector = inbox();
    const client = await connectInbox(collector);

    const gate = approvalGateFromBroker(broker);
    const gateHandle = gate.request({
      runId: 'run_integ_2',
      stepId: 'gate_2',
      summary: 'deny this step',
      accountLabel: 'MAX_A',
    });

    await waitFor(() => collector.requests.length === 1);
    const request = collector.requests[0]!;
    client.send(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: request.approvalId,
      verdict: 'deny',
    });

    const resolution = await gateHandle.resolution;
    expect(resolution.outcome).toBe('denied');
  });
});
