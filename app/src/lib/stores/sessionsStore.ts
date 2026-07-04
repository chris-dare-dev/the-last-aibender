/**
 * Session fleet read model — wire projections of resume-ledger rows as
 * reported by the `status` verb and launch/resume/kill results.
 */

import { createStore } from 'zustand/vanilla';
import type { ControlResult, SessionState, SessionStatus } from '@aibender/protocol';

export interface SessionsStoreState {
  readonly sessions: Readonly<Record<string, SessionStatus>>;
  /** Stable arrival order for fixed-position rendering (panels never reorder). */
  readonly order: readonly string[];
  applyStatuses(statuses: readonly SessionStatus[]): void;
  applyControlResult(result: ControlResult): void;
  markState(sessionId: string, state: SessionState): void;
  reset(): void;
}

export const sessionsStore = createStore<SessionsStoreState>()((set) => ({
  sessions: {},
  order: [],

  applyStatuses: (statuses) =>
    set((s) => {
      const sessions = { ...s.sessions };
      const order = [...s.order];
      for (const status of statuses) {
        if (!(status.sessionId in sessions)) order.push(status.sessionId);
        sessions[status.sessionId] = status;
      }
      return { sessions, order };
    }),

  applyControlResult: (result) =>
    set((s) => {
      switch (result.verb) {
        case 'status': {
          const sessions = { ...s.sessions };
          const order = [...s.order];
          for (const status of result.sessions) {
            if (!(status.sessionId in sessions)) order.push(status.sessionId);
            sessions[status.sessionId] = status;
          }
          return { sessions, order };
        }
        case 'launch':
        case 'resume':
        case 'kill': {
          const existing = s.sessions[result.sessionId];
          if (existing === undefined) return s; // full row arrives via status
          return {
            sessions: {
              ...s.sessions,
              [result.sessionId]: { ...existing, state: result.state },
            },
          };
        }
        default:
          return s;
      }
    }),

  markState: (sessionId, state) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (existing === undefined) return s;
      return { sessions: { ...s.sessions, [sessionId]: { ...existing, state } } };
    }),

  reset: () => set({ sessions: {}, order: [] }),
}));

export type SessionsStore = typeof sessionsStore;
