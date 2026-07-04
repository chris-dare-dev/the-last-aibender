import { describe, expect, it } from 'vitest';

import { ResidencyDeniedError } from '../errors.js';
import {
  AMBER_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  createResidencyLedger,
  createResidencyPolicy,
  ttlForPressure,
  type LocalModelSpec,
  type ResidentEntry,
} from './residency.js';

const MODEL_8B: LocalModelSpec = {
  key: 'synthetic-8b-q4',
  server: 'lmstudio',
  paramsB: 8,
  quantBits: 4,
  estimatedResidentGb: 6,
};

const MODEL_12B: LocalModelSpec = {
  key: 'synthetic-12b-q4',
  server: 'lmstudio',
  paramsB: 12,
  quantBits: 4,
  estimatedResidentGb: 8,
};

const resident = (overrides: Partial<ResidentEntry> & { key: string }): ResidentEntry => ({
  server: 'lmstudio',
  estimatedResidentGb: 6,
  lastUsedAtMs: 0,
  expiresAtMs: 60_000,
  inUse: false,
  ...overrides,
});

describe('TTL policy (blueprint §4.3: 1800 s; 900 under amber)', () => {
  it('derives 1800 nominal, 900 amber, 900 red', () => {
    expect(ttlForPressure('nominal')).toBe(DEFAULT_TTL_SECONDS);
    expect(ttlForPressure('amber')).toBe(AMBER_TTL_SECONDS);
    expect(ttlForPressure('red')).toBe(AMBER_TTL_SECONDS);
  });
});

describe('residency policy — default cap and the 12–14B opt-in', () => {
  const policy = createResidencyPolicy();
  const emptyContext = { pressure: 'nominal' as const, residentSessionCount: 3, residents: [] };

  // -- positive ---------------------------------------------------------------

  it('allows an ≤8B Q4 model by default with the pressure-derived TTL', () => {
    const decision = policy.evaluateLoad(MODEL_8B, emptyContext);
    expect(decision).toEqual({ allow: true, ttlSeconds: DEFAULT_TTL_SECONDS, evict: [] });
  });

  it('TTL shortened under amber (plan §9.2 edge)', () => {
    const decision = policy.evaluateLoad(MODEL_8B, { ...emptyContext, pressure: 'amber' });
    expect(decision.allow && decision.ttlSeconds).toBe(AMBER_TTL_SECONDS);
  });

  it('allows 12–14B with opt-in while ≤6 sessions are resident', () => {
    const decision = policy.evaluateLoad(MODEL_12B, {
      ...emptyContext,
      residentSessionCount: 6,
      largeOptIn: true,
    });
    expect(decision.allow).toBe(true);
  });

  // -- negative ---------------------------------------------------------------

  it('refuses >8B without the opt-in', () => {
    const decision = policy.evaluateLoad(MODEL_12B, emptyContext);
    expect(!decision.allow && decision.reason).toBe('exceeds-default-cap');
  });

  it('refuses >4-bit quant without the opt-in (an 8B Q8 is not the default)', () => {
    const decision = policy.evaluateLoad(
      { ...MODEL_8B, quantBits: 8, estimatedResidentGb: 9 },
      emptyContext,
    );
    expect(!decision.allow && decision.reason).toBe('exceeds-default-cap');
  });

  it('refuses 12–14B opt-in when >6 sessions are resident', () => {
    const decision = policy.evaluateLoad(MODEL_12B, {
      ...emptyContext,
      residentSessionCount: 7,
      largeOptIn: true,
    });
    expect(!decision.allow && decision.reason).toBe('large-needs-fewer-sessions');
  });

  it('refuses >14B even WITH the opt-in', () => {
    const decision = policy.evaluateLoad(
      { key: 'synthetic-32b', server: 'lmstudio', paramsB: 32, quantBits: 4, estimatedResidentGb: 20 },
      { ...emptyContext, largeOptIn: true },
    );
    expect(!decision.allow && decision.reason).toBe('exceeds-large-cap');
  });

  it('requireLoad throws the typed denial (control-verb path)', () => {
    expect(() => policy.requireLoad(MODEL_12B, emptyContext)).toThrow(ResidencyDeniedError);
  });
});

describe('the GLOBAL resident budget line (LM Studio + Ollama together)', () => {
  const policy = createResidencyPolicy({ budgetGb: 12 });

  it('counts residents of BOTH servers against one budget', () => {
    const decision = policy.evaluateLoad(MODEL_8B, {
      pressure: 'nominal',
      residentSessionCount: 3,
      residents: [
        resident({ key: 'synthetic-ollama-7b', server: 'ollama', estimatedResidentGb: 5 }),
        resident({ key: 'synthetic-other-4b', estimatedResidentGb: 3, lastUsedAtMs: 10 }),
      ],
    });
    // 5 + 3 + 6 = 14 > 12 → must evict the OLDEST idle resident first.
    expect(decision.allow).toBe(true);
    if (!decision.allow) return;
    expect(decision.evict.map((entry) => entry.key)).toEqual(['synthetic-ollama-7b']);
  });

  it('never proposes evicting an in-use resident', () => {
    const decision = policy.evaluateLoad(MODEL_8B, {
      pressure: 'nominal',
      residentSessionCount: 3,
      residents: [
        resident({ key: 'busy-model', estimatedResidentGb: 8, inUse: true }),
        resident({ key: 'idle-model', estimatedResidentGb: 5, lastUsedAtMs: 5 }),
      ],
    });
    // Evicting idle (5) leaves 8 + 6 = 14 > 12 → denied, busy never a victim.
    expect(!decision.allow && decision.reason).toBe('budget-exhausted');
  });

  it('re-loading an already-resident model is not double-counted', () => {
    const decision = policy.evaluateLoad(MODEL_8B, {
      pressure: 'nominal',
      residentSessionCount: 3,
      residents: [resident({ key: MODEL_8B.key, estimatedResidentGb: 6 })],
    });
    expect(decision.allow).toBe(true);
    if (!decision.allow) return;
    expect(decision.evict).toEqual([]);
  });
});

describe('residency ledger (the budget line source of truth)', () => {
  it('registers, touches (TTL reset), sweeps expiries, and drops on verified unload', () => {
    const ledger = createResidencyLedger();
    ledger.register({
      key: 'synthetic-8b-q4',
      server: 'lmstudio',
      estimatedResidentGb: 6,
      ttlSeconds: 1800,
      nowMs: 0,
    });
    ledger.register({
      key: 'synthetic-ollama-7b',
      server: 'ollama',
      estimatedResidentGb: 5,
      ttlSeconds: 1800,
      nowMs: 0,
    });
    expect(ledger.totalResidentGb()).toBe(11);

    // Touch resets the TTL timer (JIT semantics).
    ledger.touch('lmstudio', 'synthetic-8b-q4', 1_000_000, 1800);
    expect(ledger.sweep(1_800_000).map((entry) => entry.key)).toEqual(['synthetic-ollama-7b']);

    // TTL shortened under amber: the next touch re-arms with 900 s.
    ledger.touch('lmstudio', 'synthetic-8b-q4', 1_000_000, AMBER_TTL_SECONDS);
    expect(ledger.sweep(1_000_000 + 900_000).map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['synthetic-8b-q4']),
    );

    // Only a VERIFIED unload drops the entry.
    ledger.markUnloaded('lmstudio', 'synthetic-8b-q4');
    ledger.markUnloaded('ollama', 'synthetic-ollama-7b');
    expect(ledger.residents()).toEqual([]);
    expect(ledger.totalResidentGb()).toBe(0);
  });

  it('in-use residents are never swept', () => {
    const ledger = createResidencyLedger();
    ledger.register({
      key: 'synthetic-8b-q4',
      server: 'lmstudio',
      estimatedResidentGb: 6,
      ttlSeconds: 1,
      nowMs: 0,
    });
    ledger.setInUse('lmstudio', 'synthetic-8b-q4', true);
    expect(ledger.sweep(10_000)).toEqual([]);
    ledger.setInUse('lmstudio', 'synthetic-8b-q4', false);
    expect(ledger.sweep(10_000)).toHaveLength(1);
  });

  it('touching or unloading an unknown model is a no-op', () => {
    const ledger = createResidencyLedger();
    ledger.touch('lmstudio', 'ghost', 0, 1800);
    ledger.markUnloaded('ollama', 'ghost');
    expect(ledger.residents()).toEqual([]);
  });
});
