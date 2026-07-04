/**
 * BE-6 correction-intent classifier tests (plan §4/BE-6 item 4): the queue
 * drains through BE-4's LM Studio adapter, down-as-state (jobs survive a
 * down server and drain when it returns), hard errors drop after the attempt
 * cap, and rates only exist once something classified. Fake-tested twice:
 * a hand-rolled port fake for the state machine, and the REAL BE-4 client
 * against the testkit fake LM Studio server (ICR-0008) for the wire path.
 *
 * FIXTURE POLICY [X2]: synthesized follow-up texts and model keys only.
 */

import { startFakeLmStudioServer } from '@aibender/testkit';
import { describe, expect, it } from 'vitest';

import {
  createLmStudioClient,
  type LmStudioChatResult,
  type LmStudioClient,
} from '../adapters/lmstudio/index.js';

import { createCorrectionIntentClassifier, parseVerdict } from './classification.js';

function scriptedClient(script: LmStudioChatResult[]): LmStudioClient & {
  readonly calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    chat: async () => {
      calls += 1;
      const next = script.shift();
      if (next === undefined) throw new Error('script exhausted (test bug)');
      return next;
    },
  };
}

const ok = (content: string): LmStudioChatResult => ({
  state: 'ok',
  value: { content, model: 'synth-local-1', durationMs: 5, ttlSeconds: 1800 },
});

describe('parseVerdict', () => {
  it('reads a leading CORRECTION (any case) as correction, everything else as accept', () => {
    expect(parseVerdict('CORRECTION')).toBe('correction');
    expect(parseVerdict('  correction — the file was wrong')).toBe('correction');
    expect(parseVerdict('ACCEPT')).toBe('accept');
    expect(parseVerdict('the user said correction later')).toBe('accept');
    expect(parseVerdict('')).toBe('accept');
  });
});

describe('classifier queue — state machine (port fake)', () => {
  it('drains classified jobs into per-skill tallies and rates', async () => {
    const client = scriptedClient([ok('CORRECTION'), ok('ACCEPT'), ok('ACCEPT')]);
    const classifier = createCorrectionIntentClassifier({ client, model: 'synth-local-1' });
    classifier.enqueue({ skillName: 'skill-a', text: 'synthesized: please redo this' });
    classifier.enqueue({ skillName: 'skill-a', text: 'synthesized: looks good' });
    classifier.enqueue({ skillName: 'skill-b', text: 'synthesized: thanks' });

    const outcome = await classifier.drain();
    expect(outcome).toEqual({ state: 'drained', classified: 3, dropped: 0 });
    expect(classifier.pendingCount()).toBe(0);
    expect(classifier.tallies().get('skill-a')).toEqual({ classified: 2, corrections: 1 });
    expect(classifier.correctionRatePctBySkill().get('skill-a')).toBe(50);
    expect(classifier.correctionRatePctBySkill().get('skill-b')).toBe(0);
  });

  it('DOWN-AS-STATE: a down answer stops the drain, keeps jobs queued, and the queue drains when up', async () => {
    const client = scriptedClient([
      ok('ACCEPT'),
      { state: 'down', reason: 'unreachable' },
      ok('CORRECTION'),
    ]);
    const classifier = createCorrectionIntentClassifier({ client, model: 'synth-local-1' });
    classifier.enqueue({ skillName: 'skill-a', text: 'synthesized 1' });
    classifier.enqueue({ skillName: 'skill-a', text: 'synthesized 2' });

    const first = await classifier.drain();
    expect(first).toEqual({ state: 'lmstudio-down', classified: 1, dropped: 0, remaining: 1 });
    expect(classifier.pendingCount()).toBe(1); // the job SURVIVED the outage

    const second = await classifier.drain(); // model back up
    expect(second).toEqual({ state: 'drained', classified: 1, dropped: 0 });
    expect(classifier.tallies().get('skill-a')).toEqual({ classified: 2, corrections: 1 });
  });

  it('rates are ABSENT (not zero) before anything classified', async () => {
    const client = scriptedClient([{ state: 'down', reason: 'timeout' }]);
    const classifier = createCorrectionIntentClassifier({ client, model: 'synth-local-1' });
    classifier.enqueue({ skillName: 'skill-a', text: 'synthesized' });
    await classifier.drain();
    expect(classifier.correctionRatePctBySkill().get('skill-a')).toBeUndefined();
  });

  it('hard errors retry up to the cap, then drop WITHOUT polluting the tallies', async () => {
    const client = scriptedClient([
      { state: 'error', status: 400, message: 'synthetic bad request' },
      { state: 'error', status: 400, message: 'synthetic bad request' },
      ok('ACCEPT'),
    ]);
    const classifier = createCorrectionIntentClassifier({
      client,
      model: 'synth-local-1',
      maxAttemptsPerJob: 2,
    });
    classifier.enqueue({ skillName: 'skill-a', text: 'synthesized broken job' });
    classifier.enqueue({ skillName: 'skill-a', text: 'synthesized fine job' });

    const outcome = await classifier.drain();
    expect(outcome).toEqual({ state: 'drained', classified: 1, dropped: 1 });
    expect(classifier.tallies().get('skill-a')).toEqual({ classified: 1, corrections: 0 });
  });
});

describe('classifier — through the REAL BE-4 adapter against the testkit fake server', () => {
  it('routes /v1 chat completions locally and tallies the verdicts', async () => {
    const server = await startFakeLmStudioServer();
    try {
      server.addModel({ key: 'synth-local-1', state: 'not-loaded' });
      server.setCompletionText('CORRECTION');
      const client = createLmStudioClient({ baseUrl: server.url });
      const classifier = createCorrectionIntentClassifier({ client, model: 'synth-local-1' });
      classifier.enqueue({ skillName: 'skill-a', text: 'synthesized: fix it please' });

      const outcome = await classifier.drain();
      expect(outcome.state).toBe('drained');
      expect(classifier.correctionRatePctBySkill().get('skill-a')).toBe(100);
      // The dispatch really went through the adapter (TTL rode the request —
      // the JIT policy BE-4 owns).
      expect(server.chatRequests).toHaveLength(1);
      expect(server.chatRequests[0]?.model).toBe('synth-local-1');
      expect(server.chatRequests[0]?.ttl).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('DOWN mid-request via the real adapter: job stays queued (down-as-state)', async () => {
    const server = await startFakeLmStudioServer();
    try {
      server.addModel({ key: 'synth-local-1', state: 'loaded' });
      server.failNextChat('socket');
      const client = createLmStudioClient({ baseUrl: server.url });
      const classifier = createCorrectionIntentClassifier({ client, model: 'synth-local-1' });
      classifier.enqueue({ skillName: 'skill-a', text: 'synthesized' });

      const outcome = await classifier.drain();
      expect(outcome.state).toBe('lmstudio-down');
      expect(classifier.pendingCount()).toBe(1);

      // Server healthy again → the SAME queue drains.
      server.setCompletionText('ACCEPT');
      const second = await classifier.drain();
      expect(second.state).toBe('drained');
      expect(classifier.pendingCount()).toBe(0);
    } finally {
      await server.close();
    }
  });
});
