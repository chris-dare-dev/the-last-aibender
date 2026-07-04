/**
 * ENT capability feature-detection — STUB detector (plan FE-2: "ENT panels
 * feature-detect-degrade (stub detector)").
 *
 * Blueprint §3 rule 6: ENT is feature-detected at runtime (managed policy
 * may restrict headless use, telemetry, workflows, models); the UI degrades
 * per account. The REAL detection inputs (managed-settings probe results)
 * arrive with the M3 collector surfaces; until then every capability reads
 * `unknown` and the panel renders the honest degraded treatment — never a
 * fabricated "available".
 */

export type EntCapabilityState = 'available' | 'restricted' | 'unknown';

export interface EntCapabilities {
  /** Where this reading came from. The stub never claims live detection. */
  readonly source: 'stub' | 'live';
  readonly headless: EntCapabilityState;
  readonly telemetry: EntCapabilityState;
  readonly workflows: EntCapabilityState;
  readonly models: EntCapabilityState;
}

export const ENT_CAPABILITY_KEYS = ['headless', 'telemetry', 'workflows', 'models'] as const;

export type EntCapabilityKey = (typeof ENT_CAPABILITY_KEYS)[number];

/** Stub detector: everything unknown until the M3 probe surfaces exist. */
export function detectEntCapabilities(): EntCapabilities {
  return {
    source: 'stub',
    headless: 'unknown',
    telemetry: 'unknown',
    workflows: 'unknown',
    models: 'unknown',
  };
}

/** Capability keys the UI must degrade (hide/dim) — anything not available. */
export function entDegradedCapabilities(caps: EntCapabilities): readonly EntCapabilityKey[] {
  return ENT_CAPABILITY_KEYS.filter((key) => caps[key] !== 'available');
}
