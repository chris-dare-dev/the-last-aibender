/**
 * FE-5 controller tests — dispatch orchestration over the FE-2 port seam
 * (plan §9.2 FE-5; features 2 & 3 M2 slice).
 *
 *  positive — validated draft dispatches a frozen-valid launch request; an
 *             accepted result records history AND opens the transcript
 *             island on the returned session;
 *  negative — local validation refuses without touching the port; broker
 *             wire-errors and transport faults land in distinct phases;
 *             restricted accounts cannot be selected for the active mode;
 *             tampered DOM actions decode to nothing;
 *  edge     — invalid broker responses (id mismatch) are never rendered as
 *             truth; editing after a verdict returns the readout to idle.
 */

import { describe, expect, it } from 'vitest';

import { validateControlRequest } from '@aibender/protocol';
import type { ControlRequest, ControlResponse } from '@aibender/protocol';

import { LaunchController, parseLaunchAction, type LaunchAction } from './controller.ts';
import { withAccountCapabilities, stubFeatureDetect } from './featureDetect.ts';
import { LaunchHistoryStore } from './history.ts';
import type { LaunchControlPort } from './ports.ts';

class FakePort implements LaunchControlPort {
  readonly requests: ControlRequest[] = [];
  respond: (request: ControlRequest) => Promise<ControlResponse> = (request) =>
    Promise.resolve({
      kind: 'result',
      id: request.id,
      ok: true,
      result: { verb: 'launch', sessionId: 'ses_fake_1', state: 'spawning' },
    });

  dispatch(request: ControlRequest): Promise<ControlResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

interface Harness {
  controller: LaunchController;
  port: FakePort;
  opened: string[];
  history: LaunchHistoryStore;
}

const makeHarness = (detect = stubFeatureDetect()): Harness => {
  const port = new FakePort();
  const opened: string[] = [];
  const history = new LaunchHistoryStore({ now: () => 7 });
  const controller = new LaunchController({
    port,
    openTranscript: (sessionId) => opened.push(sessionId),
    history,
    detect,
    requestIds: { next: () => 'req_test_1' },
  });
  return { controller, port, opened, history };
};

const fillValidPrompt = (controller: LaunchController): void => {
  controller.apply({ kind: 'set-field', field: 'cwd', value: '/synthetic/workspace' });
  controller.apply({ kind: 'set-field', field: 'purpose', value: 'controller test' });
  controller.apply({ kind: 'set-field', field: 'prompt', value: 'synthesized prompt' });
};

describe('LaunchController (positive)', () => {
  it('dispatches a frozen-valid launch and opens the transcript island on the returned session', async () => {
    const { controller, port, opened, history } = makeHarness();
    fillValidPrompt(controller);
    controller.apply({ kind: 'select-account', label: 'MAX_B' });
    await controller.submit();

    expect(port.requests).toHaveLength(1);
    const request = port.requests[0];
    expect(request?.kind).toBe('launch');
    expect(validateControlRequest(request).ok).toBe(true);

    expect(controller.getState().dispatch).toEqual({
      phase: 'accepted',
      sessionId: 'ses_fake_1',
    });
    expect(opened).toEqual(['ses_fake_1']);

    const entry = history.list()[0];
    expect(entry?.outcome).toBe('accepted');
    expect(entry?.sessionId).toBe('ses_fake_1');
    expect(entry?.accountLabel).toBe('MAX_B');
  });

  it('dispatches a skill launch with the composed /skill prompt', async () => {
    const { controller, port } = makeHarness();
    controller.apply({ kind: 'set-mode', mode: 'skill' });
    controller.apply({ kind: 'set-field', field: 'cwd', value: '/synthetic/workspace' });
    controller.apply({ kind: 'set-field', field: 'skillText', value: '/deep-research topic' });
    await controller.submit();

    const request = port.requests[0];
    expect(request?.kind === 'launch' && request.params.prompt).toBe('/deep-research topic');
    expect(request?.kind === 'launch' && request.params.purpose).toBe('skill /deep-research');
  });

  it('notifies subscribers through the dispatch lifecycle', async () => {
    const { controller } = makeHarness();
    fillValidPrompt(controller);
    const phases: string[] = [];
    const unsubscribe = controller.subscribe((state) => phases.push(state.dispatch.phase));
    await controller.submit();
    unsubscribe();
    expect(phases).toEqual(['dispatching', 'accepted']);
  });
});

describe('LaunchController (negative)', () => {
  it('refuses locally without touching the port; records nothing', async () => {
    const { controller, port, history, opened } = makeHarness();
    await controller.submit(); // empty draft
    expect(controller.getState().dispatch.phase).toBe('refused');
    expect(port.requests).toEqual([]);
    expect(history.list()).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('ignores selecting an account restricted for the active mode', () => {
    const degraded = withAccountCapabilities(stubFeatureDetect(), 'ENT', {
      oneOffPrompts: false,
      skills: true,
      restrictedReason: 'managed-policy',
    });
    const { controller } = makeHarness(degraded);
    controller.apply({ kind: 'select-account', label: 'ENT' });
    expect(controller.getState().draft.account).toBe('MAX_A');
    // The same account IS selectable in a mode it is capable of.
    controller.apply({ kind: 'set-mode', mode: 'skill' });
    controller.apply({ kind: 'select-account', label: 'ENT' });
    expect(controller.getState().draft.account).toBe('ENT');
  });

  it('refuses at submit when a mode switch strands a restricted account', async () => {
    const degraded = withAccountCapabilities(stubFeatureDetect(), 'ENT', {
      oneOffPrompts: false,
      skills: true,
      restrictedReason: 'managed-policy',
    });
    const { controller, port } = makeHarness(degraded);
    controller.apply({ kind: 'set-mode', mode: 'skill' });
    controller.apply({ kind: 'select-account', label: 'ENT' });
    controller.apply({ kind: 'set-mode', mode: 'prompt' });
    fillValidPrompt(controller);
    await controller.submit();
    expect(controller.getState().dispatch.phase).toBe('refused');
    expect(port.requests).toEqual([]);
  });

  it('surfaces a broker wire-error with its frozen code and records it', async () => {
    const { controller, port, history, opened } = makeHarness();
    port.respond = (request) =>
      Promise.resolve({
        kind: 'result',
        id: request.id,
        ok: false,
        error: { code: 'internal', message: 'internal broker error while handling launch', retryable: false },
      });
    fillValidPrompt(controller);
    await controller.submit();
    const dispatch = controller.getState().dispatch;
    expect(dispatch.phase).toBe('wire-error');
    if (dispatch.phase === 'wire-error') expect(dispatch.error.code).toBe('internal');
    expect(history.list()[0]?.outcome).toBe('wire-error');
    expect(history.list()[0]?.errorCode).toBe('internal');
    expect(opened).toEqual([]);
  });

  it('lands transport rejection in a failed phase without trusting the message', async () => {
    const { controller, port, history } = makeHarness();
    // Runtime-built token-shaped marker (no scanner-shaped literal committed).
    const tokenish = ['sk', 'fake0secret0fake0'].join('-');
    port.respond = () => Promise.reject(new Error(`socket closed: token ${tokenish}`));
    fillValidPrompt(controller);
    await controller.submit();
    expect(controller.getState().dispatch).toEqual({ phase: 'failed', note: 'TRANSPORT FAULT' });
    expect(history.list()[0]?.outcome).toBe('failed');
    expect(history.list()[0]?.failureNote).toBe('transport');
    expect(JSON.stringify(controller.getState())).not.toContain(tokenish);
  });

  it('parseLaunchAction decodes only well-formed, untampered datasets', () => {
    expect(parseLaunchAction({ action: 'select-account', label: 'MAX_A' })).toEqual({
      kind: 'select-account',
      label: 'MAX_A',
    });
    // A DOM-injected non-placeholder label NEVER becomes a selection.
    expect(parseLaunchAction({ action: 'select-account', label: 'MAX_C' })).toBeUndefined();
    expect(parseLaunchAction({ action: 'select-account' })).toBeUndefined();
    expect(parseLaunchAction({ action: 'set-mode', mode: 'skill' })).toEqual({
      kind: 'set-mode',
      mode: 'skill',
    });
    expect(parseLaunchAction({ action: 'set-mode', mode: 'yolo' })).toBeUndefined();
    expect(parseLaunchAction({ action: 'set-field', field: 'prompt' }, 'text')).toEqual({
      kind: 'set-field',
      field: 'prompt',
      value: 'text',
    });
    expect(parseLaunchAction({ action: 'set-field', field: 'account' }, 'x')).toBeUndefined();
    expect(parseLaunchAction({ action: 'submit' })).toEqual({ kind: 'submit' });
    expect(parseLaunchAction({ action: 'clear-history' })).toEqual({ kind: 'clear-history' });
    expect(parseLaunchAction({ action: 'launch-missiles' })).toBeUndefined();
    expect(parseLaunchAction({})).toBeUndefined();
  });

  it('a tampered select action object fails closed inside apply too', () => {
    const { controller } = makeHarness();
    const tampered = { kind: 'select-account', label: 'EVIL' } as unknown as LaunchAction;
    controller.apply(tampered);
    expect(controller.getState().draft.account).toBe('MAX_A');
  });
});

describe('LaunchController (edge)', () => {
  it('treats a response answering a different request id as invalid, not truth', async () => {
    const { controller, history, opened } = makeHarness();
    const port = new FakePort();
    port.respond = () =>
      Promise.resolve({
        kind: 'result',
        id: 'req_someone_else',
        ok: true,
        result: { verb: 'launch', sessionId: 'ses_fake_9', state: 'spawning' },
      });
    const rewired = new LaunchController({
      port,
      openTranscript: (sessionId) => opened.push(sessionId),
      history,
      requestIds: { next: () => 'req_test_1' },
    });
    fillValidPrompt(rewired);
    await rewired.submit();
    expect(rewired.getState().dispatch).toEqual({ phase: 'failed', note: 'INVALID RESPONSE' });
    expect(history.list()[0]?.failureNote).toBe('invalid-response');
    expect(opened).toEqual([]);
    expect(controller.getState().dispatch.phase).toBe('idle');
  });

  it('editing a field after a verdict returns the readout to idle', async () => {
    const { controller } = makeHarness();
    await controller.submit();
    expect(controller.getState().dispatch.phase).toBe('refused');
    controller.apply({ kind: 'set-field', field: 'prompt', value: 'now valid' });
    expect(controller.getState().dispatch.phase).toBe('idle');
  });

  it('clear-history action empties the store', async () => {
    const { controller, history } = makeHarness();
    fillValidPrompt(controller);
    await controller.submit();
    expect(history.list()).toHaveLength(1);
    controller.apply({ kind: 'clear-history' });
    expect(history.list()).toEqual([]);
  });
});
