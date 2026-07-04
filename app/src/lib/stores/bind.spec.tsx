// @vitest-environment jsdom
/**
 * Full-stack streaming discipline (plan §9.2 FE-2):
 * Positive: store projections batch per rAF — one store notification per
 *           frame, not per token.
 * Edge:     per-token React state updates PROVABLY ABSENT — render-count
 *           assertion under a streaming fixture; reconnect rehydrates from
 *           the watermark without duplicate rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from 'zustand';
import { nullLogger } from '../log.ts';
import { FakeWsHub, ManualTimers, fakeBootstrap, flushAsync, manualFrames } from '../testing/fakes.ts';
import { encodeEnvelope } from '../ws/outbound.ts';
import { GatewayClient } from '../ws/wsClient.ts';
import { approvalsStore } from './approvalsStore.ts';
import { bindClientToStores } from './bind.ts';
import { connectionStore } from './connectionStore.ts';
import { contextGraphStore } from './contextGraphStore.ts';
import { quotaStore } from './quotaStore.ts';
import { sessionsStore } from './sessionsStore.ts';
import { transcriptStore } from './transcriptStore.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function resetStores(): void {
  transcriptStore.getState().reset();
  approvalsStore.getState().reset();
  quotaStore.getState().reset();
  contextGraphStore.getState().reset();
  sessionsStore.getState().reset();
  connectionStore.getState().reset();
}

function transcriptFrame(seq: number, text: string): string {
  return encodeEnvelope('transcript.ses_fake_1', seq, {
    kind: 'transcript-delta',
    sessionId: 'ses_fake_1',
    messageUuid: 'synthmsg-0',
    text,
  });
}

let renders = 0;

function Readout(): ReactNode {
  renders += 1;
  const text = useStore(
    transcriptStore,
    (s) => s.sessions['ses_fake_1']?.blocks.map((b) => b.text).join('') ?? '',
  );
  return <div data-testid="readout">{text}</div>;
}

describe('bindClientToStores streaming discipline', () => {
  let root: Root | undefined;
  let host: HTMLElement;

  beforeEach(() => {
    resetStores();
    renders = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
  });

  async function setup(): Promise<{
    hub: FakeWsHub;
    timers: ManualTimers;
    frames: ReturnType<typeof manualFrames>;
    client: GatewayClient;
  }> {
    const hub = new FakeWsHub();
    const timers = new ManualTimers();
    const frames = manualFrames();
    const client = new GatewayClient({
      bootstrapProvider: async () => fakeBootstrap(),
      wsFactory: hub.factory,
      timers,
      logger: nullLogger,
    });
    bindClientToStores(client, { schedule: frames.schedule, logger: nullLogger, now: () => 90100000 });
    client.start();
    await flushAsync();
    hub.latest.open();
    await flushAsync();
    return { hub, timers, frames, client };
  }

  it('per-token React state updates are provably absent (render-count assertion)', async () => {
    const { hub, frames } = await setup();

    root = createRoot(host);
    act(() => {
      (root as Root).render(<Readout />);
    });
    const rendersAfterMount = renders;

    // Streaming fixture: 300 wire deltas in three frame windows.
    const TOKENS = 300;
    let storeNotifications = 0;
    const unsub = transcriptStore.subscribe(() => {
      storeNotifications += 1;
    });
    for (let i = 0; i < TOKENS; i += 1) {
      hub.latest.receiveText(transcriptFrame(i, `tok${i} `));
      if (i % 100 === 99) {
        act(() => frames.frame()); // one projection per frame window
      }
    }
    unsub();

    // ONE store write per frame — three frames, three notifications.
    expect(storeNotifications).toBe(3);
    // Render count is bounded by frames, NEVER by tokens.
    expect(renders - rendersAfterMount).toBeLessThanOrEqual(3);
    expect(renders).toBeLessThan(10);
    // …and no data was lost on the way.
    const text = host.querySelector('[data-testid="readout"]')?.textContent ?? '';
    expect(text.split(' ').filter(Boolean)).toHaveLength(TOKENS);
  });

  it('reconnect rehydrates from the watermark without duplicate rows (edge)', async () => {
    const { hub, timers, frames } = await setup();

    for (let seq = 0; seq <= 5; seq += 1) hub.latest.receiveText(transcriptFrame(seq, `t${seq}`));
    frames.frame();

    hub.latest.serverClose(1006);
    timers.advance(500);
    await flushAsync();
    const socket = hub.latest;
    socket.open();
    await flushAsync();

    // Broker replays an overlapping retained window 3..8, then live 9.
    for (let seq = 3; seq <= 9; seq += 1) socket.receiveText(transcriptFrame(seq, `t${seq}`));
    frames.frame();

    const session = transcriptStore.getState().sessions['ses_fake_1'];
    expect(session?.blocks).toHaveLength(1); // same messageUuid ⇒ one document block
    expect(session?.blocks[0]?.text).toBe('t0t1t2t3t4t5t6t7t8t9'); // each row exactly once
  });

  it('routes approvals immediately and quota monotonically (positive)', async () => {
    const { hub } = await setup();

    hub.latest.receiveText(
      encodeEnvelope('approvals', 5, {
        kind: 'approval-request',
        approvalId: 'apr_fake_1',
        source: 'can-use-tool',
        summary: 'synthesized tool escalation',
        accountLabel: 'MAX_A',
        sessionId: 'ses_fake_1',
        toolName: 'Bash',
      }),
    );
    expect(approvalsStore.getState().order).toEqual(['apr_fake_1']);

    hub.latest.receiveText(
      encodeEnvelope('quota', 3, {
        kind: 'quota-snapshot',
        account: 'MAX_A',
        window: '5h',
        usedPct: 41.5,
        resetsAt: 90200000,
        capturedAt: 90100000,
        source: 'statusline',
      }),
    );
    expect(quotaStore.getState().snapshots['MAX_A/5h']?.usedPct).toBe(41.5);
  });
});
