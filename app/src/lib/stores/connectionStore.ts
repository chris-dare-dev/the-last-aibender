/**
 * Gateway connection read model. [X2]: carries NO token — only the
 * identifier-free broker facts (port/pid/startedAt) and phase/violation
 * counters the chrome renders.
 */

import { createStore } from 'zustand/vanilla';
import type { ErrorCode } from '@aibender/protocol';
import type { ClientPhase, ProtocolViolation } from '../ws/wsClient.ts';

export interface ConnectionState {
  readonly phase: ClientPhase;
  readonly port: number | undefined;
  readonly pid: number | undefined;
  readonly startedAt: string | undefined;
  readonly violationCount: number;
  readonly lastViolation: ProtocolViolation | undefined;
  readonly lastPushedError: { code: ErrorCode; message: string } | undefined;
  readonly duplicateDrops: number;
  readonly brokerRestarts: number;
  setPhase(phase: ClientPhase): void;
  setBroker(info: { port: number; pid: number; startedAt: string } | undefined): void;
  recordViolation(violation: ProtocolViolation): void;
  recordPushedError(code: ErrorCode, message: string): void;
  recordDuplicateDrop(): void;
  recordBrokerRestart(): void;
  reset(): void;
}

const initial = {
  phase: 'idle' as ClientPhase,
  port: undefined,
  pid: undefined,
  startedAt: undefined,
  violationCount: 0,
  lastViolation: undefined,
  lastPushedError: undefined,
  duplicateDrops: 0,
  brokerRestarts: 0,
};

export const connectionStore = createStore<ConnectionState>()((set) => ({
  ...initial,
  setPhase: (phase) => set({ phase }),
  setBroker: (info) =>
    set(
      info === undefined
        ? { port: undefined, pid: undefined, startedAt: undefined }
        : { port: info.port, pid: info.pid, startedAt: info.startedAt },
    ),
  recordViolation: (violation) =>
    set((s) => ({ violationCount: s.violationCount + 1, lastViolation: violation })),
  recordPushedError: (code, message) => set({ lastPushedError: { code, message } }),
  recordDuplicateDrop: () => set((s) => ({ duplicateDrops: s.duplicateDrops + 1 })),
  recordBrokerRestart: () => set((s) => ({ brokerRestarts: s.brokerRestarts + 1 })),
  reset: () => set(initial),
}));

export type ConnectionStore = typeof connectionStore;
