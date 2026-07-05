// @vitest-environment jsdom
/**
 * Work surface slot policy (M2 composition fix):
 * Positive: a pty-substrate session mounts the terminal island; an
 *           sdk-substrate session mounts the transcript island (the
 *           previously-unreachable slot).
 * Negative: no selected session ⇒ NO SIGNAL idle treatment, nothing mounts
 *           even with islands registered.
 * Edge:     substrate-unknown sessions default to the transcript slot and
 *           re-slot when the status row lands; unmount cleanup runs when the
 *           selection changes.
 *
 * Graph view (M4 chrome wiring — the FE-4 reachability ICR):
 * Positive: the GRAPH header toggle (and the palette verb) swap the surface
 *           to the graph island, which mounts session-independently.
 * Negative: graph view with no graph island registered ⇒ NO SIGNAL.
 * Edge:     selection changes never remount the graph scene; toggling back
 *           restores the substrate slot and unmounts the graph.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionStatus } from '@aibender/protocol';
import { sessionsStore } from '../lib/stores/sessionsStore.ts';
import { builtinCommands } from './commands.ts';
import { registerIsland, resetIslandsForTest, type IslandSlot } from './islandRegistry.ts';
import { uiStore } from './uiStore.ts';
import { WorkSurface, slotForSubstrate } from './WorkSurface.tsx';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function status(sessionId: string, substrate: SessionStatus['substrate']): SessionStatus {
  return {
    sessionId,
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    substrate,
    state: 'running',
    cwd: '/synth/dir',
    purpose: 'work surface spec',
  };
}

interface MountLog {
  mounts: { slot: IslandSlot; sessionId: string | undefined }[];
  unmounts: number;
}

function registerFakeIsland(slot: IslandSlot, log: MountLog): void {
  registerIsland(slot, {
    mount(_host, context) {
      log.mounts.push({ slot, sessionId: context.sessionId });
      return () => {
        log.unmounts += 1;
      };
    },
  });
}

describe('WorkSurface slot policy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetIslandsForTest();
    sessionsStore.getState().reset();
    uiStore.getState().selectSession(undefined);
    uiStore.getState().setWorkSurfaceView('session');
  });

  const render = () => act(() => root.render(<WorkSurface />));

  it('maps substrates to slots (pty → terminal, sdk/unknown → transcript)', () => {
    expect(slotForSubstrate('pty')).toBe('terminal');
    expect(slotForSubstrate('sdk')).toBe('transcript');
    expect(slotForSubstrate(undefined)).toBe('transcript');
  });

  it('mounts the terminal island for a pty session (positive)', () => {
    const log: MountLog = { mounts: [], unmounts: 0 };
    registerFakeIsland('terminal', log);
    registerFakeIsland('transcript', log);
    act(() => {
      sessionsStore.getState().applyStatuses([status('ses_fake_1', 'pty')]);
      uiStore.getState().selectSession('ses_fake_1');
    });
    render();
    expect(log.mounts).toEqual([{ slot: 'terminal', sessionId: 'ses_fake_1' }]);
    const host = container.querySelector('[data-testid="island-host"]');
    expect(host?.getAttribute('data-slot')).toBe('terminal');
  });

  it('mounts the transcript island for an sdk session — the slot is reachable (positive)', () => {
    const log: MountLog = { mounts: [], unmounts: 0 };
    registerFakeIsland('terminal', log);
    registerFakeIsland('transcript', log);
    act(() => {
      sessionsStore.getState().applyStatuses([status('ses_fake_2', 'sdk')]);
      uiStore.getState().selectSession('ses_fake_2');
    });
    render();
    // Regression pin: with both islands registered, the transcript slot must
    // NOT be shadowed by the terminal island (old `terminal ?? transcript`).
    expect(log.mounts).toEqual([{ slot: 'transcript', sessionId: 'ses_fake_2' }]);
  });

  it('renders NO SIGNAL and mounts nothing while no session is selected (negative)', () => {
    const log: MountLog = { mounts: [], unmounts: 0 };
    registerFakeIsland('terminal', log);
    registerFakeIsland('transcript', log);
    render();
    expect(log.mounts).toHaveLength(0);
    expect(container.textContent).toContain('NO SIGNAL');
    expect(container.textContent).toContain('NO SESSION SELECTED');
  });

  it('defaults substrate-unknown sessions to transcript, re-slots on status arrival (edge)', () => {
    const log: MountLog = { mounts: [], unmounts: 0 };
    registerFakeIsland('terminal', log);
    registerFakeIsland('transcript', log);
    act(() => uiStore.getState().selectSession('ses_fake_3'));
    render();
    expect(log.mounts).toEqual([{ slot: 'transcript', sessionId: 'ses_fake_3' }]);
    // Status lands: it is a pty session — the surface re-slots to terminal.
    act(() => sessionsStore.getState().applyStatuses([status('ses_fake_3', 'pty')]));
    expect(log.unmounts).toBe(1);
    expect(log.mounts.at(-1)).toEqual({ slot: 'terminal', sessionId: 'ses_fake_3' });
  });

  it('runs unmount cleanup when the selection changes (edge)', () => {
    const log: MountLog = { mounts: [], unmounts: 0 };
    registerFakeIsland('transcript', log);
    act(() => {
      sessionsStore.getState().applyStatuses([
        status('ses_fake_4', 'sdk'),
        status('ses_fake_5', 'sdk'),
      ]);
      uiStore.getState().selectSession('ses_fake_4');
    });
    render();
    act(() => uiStore.getState().selectSession('ses_fake_5'));
    expect(log.unmounts).toBe(1);
    expect(log.mounts.map((m) => m.sessionId)).toEqual(['ses_fake_4', 'ses_fake_5']);
  });

  it('shows NO ISLAND REGISTERED when the selected slot has no island (negative)', () => {
    act(() => {
      sessionsStore.getState().applyStatuses([status('ses_fake_6', 'pty')]);
      uiStore.getState().selectSession('ses_fake_6');
    });
    render();
    expect(container.textContent).toContain('NO ISLAND REGISTERED');
  });

  describe('graph view (M4 — the FE-4 reachability affordance)', () => {
    it('the header toggle swaps to the graph island, session-independently (positive)', () => {
      const log: MountLog = { mounts: [], unmounts: 0 };
      registerFakeIsland('graph', log);
      render();
      // No session selected — the graph is the whole session-artifact field.
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="work-view-toggle"]',
      );
      expect(toggle?.getAttribute('aria-pressed')).toBe('false');
      act(() => toggle?.click());
      expect(log.mounts).toEqual([{ slot: 'graph', sessionId: undefined }]);
      const host = container.querySelector('[data-testid="island-host"]');
      expect(host?.getAttribute('data-slot')).toBe('graph');
      expect(toggle?.getAttribute('aria-pressed')).toBe('true');
      expect(container.textContent).toContain('CONTEXT GRAPH');
    });

    it('the palette verb flips the view (DESIGN.md §6 kill-switch rule)', () => {
      const verb = builtinCommands().find((c) => c.id === 'chrome.work.graph.toggle');
      expect(verb?.title).toBe('toggle graph view');
      verb?.run({ client: undefined });
      expect(uiStore.getState().workSurfaceView).toBe('graph');
      verb?.run({ client: undefined });
      expect(uiStore.getState().workSurfaceView).toBe('session');
    });

    it('renders NO SIGNAL while no graph island is registered (negative)', () => {
      act(() => uiStore.getState().setWorkSurfaceView('graph'));
      render();
      expect(container.textContent).toContain('NO SIGNAL');
      expect(container.textContent).toContain('NO ISLAND REGISTERED');
    });

    it('selection changes never remount the graph scene (edge)', () => {
      const log: MountLog = { mounts: [], unmounts: 0 };
      registerFakeIsland('graph', log);
      act(() => {
        sessionsStore.getState().applyStatuses([
          status('ses_fake_7', 'pty'),
          status('ses_fake_8', 'sdk'),
        ]);
        uiStore.getState().selectSession('ses_fake_7');
        uiStore.getState().setWorkSurfaceView('graph');
      });
      render();
      expect(log.mounts).toEqual([{ slot: 'graph', sessionId: undefined }]);
      act(() => uiStore.getState().selectSession('ses_fake_8'));
      expect(log.unmounts).toBe(0);
      expect(log.mounts).toHaveLength(1);
    });

    it('toggling back unmounts the graph and restores the substrate slot (edge)', () => {
      const log: MountLog = { mounts: [], unmounts: 0 };
      registerFakeIsland('graph', log);
      registerFakeIsland('terminal', log);
      act(() => {
        sessionsStore.getState().applyStatuses([status('ses_fake_9', 'pty')]);
        uiStore.getState().selectSession('ses_fake_9');
        uiStore.getState().setWorkSurfaceView('graph');
      });
      render();
      expect(log.mounts.at(-1)).toEqual({ slot: 'graph', sessionId: undefined });
      act(() => uiStore.getState().toggleGraphView());
      expect(log.unmounts).toBe(1);
      expect(log.mounts.at(-1)).toEqual({ slot: 'terminal', sessionId: 'ses_fake_9' });
    });
  });

  describe('pipelines (builder) view (M5 — the FE-6 chrome+composition ICR)', () => {
    it('the BUILDER header toggle swaps to the pipelines deck, session-independently (positive)', () => {
      const log: MountLog = { mounts: [], unmounts: 0 };
      registerFakeIsland('pipelines', log);
      render();
      // No session selected — the builder + run monitor is the whole fleet.
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="work-view-toggle-pipelines"]',
      );
      expect(toggle?.getAttribute('aria-pressed')).toBe('false');
      act(() => toggle?.click());
      expect(log.mounts).toEqual([{ slot: 'pipelines', sessionId: undefined }]);
      const host = container.querySelector('[data-testid="island-host"]');
      expect(host?.getAttribute('data-slot')).toBe('pipelines');
      expect(toggle?.getAttribute('aria-pressed')).toBe('true');
      expect(container.textContent).toContain('PIPELINE BUILDER');
    });

    it('the palette verb flips the view (DESIGN.md §6 kill-switch rule)', () => {
      const verb = builtinCommands().find((c) => c.id === 'chrome.work.pipelines.toggle');
      expect(verb?.title).toBe('toggle builder view');
      verb?.run({ client: undefined });
      expect(uiStore.getState().workSurfaceView).toBe('pipelines');
      verb?.run({ client: undefined });
      expect(uiStore.getState().workSurfaceView).toBe('session');
    });

    it('renders NO SIGNAL (not "NO SESSION SELECTED") while no pipelines island is registered (negative)', () => {
      act(() => uiStore.getState().setWorkSurfaceView('pipelines'));
      render();
      expect(container.textContent).toContain('NO SIGNAL');
      // Session-independent: the idle treatment must NOT demand a selection.
      expect(container.textContent).toContain('NO ISLAND REGISTERED');
      expect(container.textContent).not.toContain('NO SESSION SELECTED');
    });

    it('selection changes never remount the pipelines deck (edge)', () => {
      const log: MountLog = { mounts: [], unmounts: 0 };
      registerFakeIsland('pipelines', log);
      act(() => {
        sessionsStore.getState().applyStatuses([
          status('ses_fake_10', 'pty'),
          status('ses_fake_11', 'sdk'),
        ]);
        uiStore.getState().selectSession('ses_fake_10');
        uiStore.getState().setWorkSurfaceView('pipelines');
      });
      render();
      expect(log.mounts).toEqual([{ slot: 'pipelines', sessionId: undefined }]);
      act(() => uiStore.getState().selectSession('ses_fake_11'));
      expect(log.unmounts).toBe(0);
      expect(log.mounts).toHaveLength(1);
    });

    it('toggling back unmounts the deck and restores the substrate slot (edge)', () => {
      const log: MountLog = { mounts: [], unmounts: 0 };
      registerFakeIsland('pipelines', log);
      registerFakeIsland('terminal', log);
      act(() => {
        sessionsStore.getState().applyStatuses([status('ses_fake_12', 'pty')]);
        uiStore.getState().selectSession('ses_fake_12');
        uiStore.getState().setWorkSurfaceView('pipelines');
      });
      render();
      expect(log.mounts.at(-1)).toEqual({ slot: 'pipelines', sessionId: undefined });
      act(() => uiStore.getState().togglePipelinesView());
      expect(log.unmounts).toBe(1);
      expect(log.mounts.at(-1)).toEqual({ slot: 'terminal', sessionId: 'ses_fake_12' });
    });
  });
});
