/**
 * fakeGatewayPorts double sanity suite (ICR-0007, moved with the promotion
 * from core/src/gateway/fakePorts.spec.ts) — the doubles must honor the port
 * contracts (core/src/gateway/ports.ts) their real BE-2 counterparts commit
 * to, or every suite built on them proves nothing.
 */

import type { ApprovalRequest } from '@aibender/protocol';
import { describe, expect, it } from 'vitest';

import {
  FakeApprovalBroker,
  FakePtyHost,
  FakePtySession,
  FakeTranscriptSource,
} from './fakeGatewayPorts.js';

const request = (approvalId: string): ApprovalRequest => ({
  kind: 'approval-request',
  approvalId,
  source: 'hook-floor',
  summary: 'synthesized policy-floor escalation',
  accountLabel: 'ENT',
  sessionId: 'ses_fake_1',
  toolName: 'Write',
});

describe('FakePtyHost', () => {
  it('replays already-live sessions to a late subscriber, then streams new ones', () => {
    const host = new FakePtyHost();
    const early = host.announce('ses_fake_a');
    const seen: string[] = [];
    host.onSession((sessionId) => seen.push(sessionId));
    expect(seen).toEqual(['ses_fake_a']);
    host.announce('ses_fake_b');
    expect(seen).toEqual(['ses_fake_a', 'ses_fake_b']);
    expect(host.session('ses_fake_a')).toBe(early);
  });

  it('unsubscribe stops announcements', () => {
    const host = new FakePtyHost();
    const seen: string[] = [];
    const unsubscribe = host.onSession((sessionId) => seen.push(sessionId));
    unsubscribe();
    host.announce('ses_fake_c');
    expect(seen).toEqual([]);
  });
});

describe('FakePtySession', () => {
  it('records writes/resizes and emits output/exit to subscribers', () => {
    const session = new FakePtySession();
    const chunks: string[] = [];
    let exited = false;
    session.onOutput((chunk) => chunks.push(new TextDecoder().decode(chunk)));
    session.onExit(() => {
      exited = true;
    });
    session.emitOutput('synthesized output');
    session.write(new TextEncoder().encode('ls\n'));
    session.resize(80, 24);
    session.pause();
    session.resume();
    session.emitExit();

    expect(chunks).toEqual(['synthesized output']);
    expect(session.writtenUtf8()).toEqual(['ls\n']);
    expect(session.resizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(session.pauseCount).toBe(1);
    expect(session.resumeCount).toBe(1);
    expect(exited).toBe(true);
    expect(session.exited).toBe(true);
  });
});

describe('FakeApprovalBroker (the idempotence discipline)', () => {
  it('first decision applies and resolves exactly once; the second is not-pending', async () => {
    const broker = new FakeApprovalBroker();
    const resolutions: string[] = [];
    broker.onResolved((resolved) => resolutions.push(resolved.outcome));
    broker.emitRequest(request('apr_fake_x'));

    const decision = { kind: 'approval-decision', approvalId: 'apr_fake_x', verdict: 'allow' } as const;
    expect(await broker.decide(decision)).toBe('applied');
    expect(await broker.decide(decision)).toBe('not-pending');
    expect(resolutions).toEqual(['allowed']);
    expect(broker.appliedDecisions).toHaveLength(1);
  });

  it('a decision after resolveWithout (expiry) is not-pending', async () => {
    const broker = new FakeApprovalBroker();
    broker.emitRequest(request('apr_fake_y'));
    broker.resolveWithout('apr_fake_y', 'expired');
    expect(broker.isPending('apr_fake_y')).toBe(false);
    expect(
      await broker.decide({ kind: 'approval-decision', approvalId: 'apr_fake_y', verdict: 'deny' }),
    ).toBe('not-pending');
  });

  it('a decision for an unknown id is not-pending', async () => {
    const broker = new FakeApprovalBroker();
    expect(
      await broker.decide({ kind: 'approval-decision', approvalId: 'apr_fake_z', verdict: 'allow' }),
    ).toBe('not-pending');
  });
});

describe('FakeTranscriptSource', () => {
  it('emits to subscribers and honors unsubscribe', () => {
    const source = new FakeTranscriptSource();
    const seen: Array<{ sessionId: string; message: unknown }> = [];
    const unsubscribe = source.onMessage((sessionId, message) => seen.push({ sessionId, message }));
    source.emit('ses_fake_1', { type: 'system' });
    expect(seen).toEqual([{ sessionId: 'ses_fake_1', message: { type: 'system' } }]);
    unsubscribe();
    source.emit('ses_fake_1', { type: 'system' });
    expect(seen).toHaveLength(1);
    expect(source.listenerCount).toBe(0);
  });
});
