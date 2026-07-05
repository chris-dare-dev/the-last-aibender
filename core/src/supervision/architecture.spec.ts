/**
 * BE-9 ARCHITECTURAL TESTS (the BE-2 "no parser imports" / BE-7 "no write
 * path" precedent — source-level scans that pin the non-negotiable rules):
 *
 *   1. NO COST-INCURRING / MODEL-INFERENCE PATH. No supervision module imports
 *      an SDK query surface, an LM Studio /v1 completion client, an OpenCode
 *      SDK, or an AWS/Bedrock client. The governor DECIDES; it never issues an
 *      inference or a billable call (Stage-2 rule 3 + BE-9 "NO cost-incurring
 *      calls"). The telemetry ports (sampler, probe) are injected interfaces.
 *   2. NO DIRECT PROCESS BLOAT / SPAWN FOR TELEMETRY. The only module allowed
 *      to reference child-process spawning is pressureProbe.ts, and only
 *      behind its injected `run` seam (never a top-level import that the
 *      governor calls). No module `spawn`s to MEASURE a footprint — the
 *      sampler is a FAKE in tests and a guarded reader at runtime.
 *   3. READ-ONLY FS. configMonitor.ts imports ONLY read-only fs members
 *      (statSync); it never reads file CONTENTS and never writes [X2].
 *
 * These are the invariants that keep the watchdog testable with a fake-process
 * harness and free of any real bloat or spend.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_FILES = readdirSync(HERE).filter(
  (entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'),
);

/** Cost-incurring / model-inference import surfaces — none may appear. */
const FORBIDDEN_COST_TOKENS = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@opencode-ai/sdk',
  '@aws-sdk/client-bedrock',
  'bedrock-runtime',
  "from '../kernel/sdkQueryRunner", // the SDK query() path (billable)
  '/v1/chat/completions',
  '/v1/completions',
];

describe('BE-9 no cost-incurring / model-inference path (source scan)', () => {
  it('lists the expected supervision module set', () => {
    expect(MODULE_FILES).toContain('governor.ts');
    expect(MODULE_FILES).toContain('scheduler.ts');
    expect(MODULE_FILES).toContain('watchdog.ts');
    expect(MODULE_FILES).toContain('pressureProbe.ts');
    expect(MODULE_FILES.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of MODULE_FILES) {
    it(`${file} imports no cost-incurring / inference surface`, () => {
      const source = readFileSync(join(HERE, file), 'utf8');
      for (const token of FORBIDDEN_COST_TOKENS) {
        expect(source, `${file} must not reference ${token}`).not.toContain(token);
      }
    });
  }
});

describe('BE-9 no direct process bloat / spawn for telemetry (source scan)', () => {
  const SPAWN_TOKENS = ['child_process', 'spawnSync', 'execSync', 'execFileSync', 'spawn('];

  for (const file of MODULE_FILES) {
    it(`${file} does not spawn a process to measure a footprint`, () => {
      const source = readFileSync(join(HERE, file), 'utf8');
      // pressureProbe.ts documents a spawn-BASED probe but reaches processes
      // ONLY through its injected `run` seam — it must not statically import
      // child_process (the composition root supplies the runner at runtime).
      for (const token of SPAWN_TOKENS) {
        expect(source, `${file} must not statically reference ${token}`).not.toContain(token);
      }
    });
  }
});

describe('BE-9 config monitor reads only file SIZE, read-only fs [X2]', () => {
  const FORBIDDEN_FS_TOKENS = [
    'writeFileSync',
    'writeFile(',
    'appendFileSync',
    'createWriteStream',
    'unlinkSync',
    'readFileSync', // size only — never the CONTENTS
    'readFile(',
    'fs/promises',
  ];

  it('configMonitor.ts imports no write-capable / content-reading fs API', () => {
    const source = readFileSync(join(HERE, 'configMonitor.ts'), 'utf8');
    for (const token of FORBIDDEN_FS_TOKENS) {
      expect(source, `configMonitor.ts must not reference ${token}`).not.toContain(token);
    }
    // The one fs member it DOES use is the read-only size stat.
    expect(source).toContain('statSync');
  });
});
