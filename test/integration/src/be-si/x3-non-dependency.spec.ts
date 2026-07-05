/**
 * §9.3 BE↔SI — the [X3] non-dependency proof (synthetic/architectural half).
 *
 * The blueprint's [X3] verdict: the harness core is host-native; k3s/Colima is
 * a demoted, optional telemetry adjunct and NEVER a launch dependency. The
 * per-department guard (core/src/adapters/opencode/serve.spec.ts "adapters
 * [X3] architectural guard") proves it for the ADAPTERS subtree. THIS suite
 * strengthens it to the WHOLE `core/` tree — the daemon in its entirety — and
 * adds the explicit clause that the LM Studio adapter path carries no k3s
 * dependency (§9.3 BE↔SI #5: "Colima stopped entirely → LM Studio unaffected").
 *
 * The live half (Colima actually stopped, LM Studio still reachable) is T3 and
 * enumerated in live-check (asserted by the live-check meta-test). This is the
 * import-graph invariant that makes that live behavior possible by
 * construction — CI-cheap, always on (integration-suite.md §3).
 *
 * [X2]: reads source text only; no identity.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORE_SRC = join(REPO_ROOT, 'core/src');
const LMSTUDIO_SRC = join(CORE_SRC, 'adapters/lmstudio');

/** The forbidden import shapes: anything virtualization/orchestration or infra/. */
const FORBIDDEN_IMPORT = /from\s+['"][^'"]*(kubernetes|k8s|k3s|colima|lima|\.\.\/.*\/infra\/|infra\/)/;

async function tsFilesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (path.endsWith('.ts')) out.push(path);
    }
  }
  return out;
}

async function offendersUnder(root: string): Promise<string[]> {
  const files = await tsFilesUnder(root);
  const offenders: string[] = [];
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    // Scan import/export-from lines only (a comment mentioning colima is fine).
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (!(trimmed.startsWith('import ') || trimmed.startsWith('export ') || trimmed.includes('require('))) {
        continue;
      }
      if (FORBIDDEN_IMPORT.test(trimmed)) {
        offenders.push(`${relative(REPO_ROOT, path)}: ${trimmed}`);
      }
    }
  }
  return offenders;
}

describe('BE↔SI [X3] — core/ imports nothing from infra/ or any k3s/Colima surface', () => {
  it('the WHOLE core/ tree has zero infra/k8s/k3s/colima imports (not just adapters)', async () => {
    const offenders = await offendersUnder(CORE_SRC);
    expect(offenders).toEqual([]);
  });

  it('the guard actually scans a non-trivial tree (regression guard)', async () => {
    const files = await tsFilesUnder(CORE_SRC);
    // If this ever collapses to a handful, the "whole tree" claim is hollow.
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  it('the LM Studio adapter path has NO k3s/colima dependency ([X3] non-dependency)', async () => {
    const offenders = await offendersUnder(LMSTUDIO_SRC);
    expect(offenders).toEqual([]);
    // And the path exists + is non-trivial (guards a moved/emptied dir).
    const files = await tsFilesUnder(LMSTUDIO_SRC);
    expect(files.length).toBeGreaterThan(0);
  });

  it('core/ does not even reference an infra/ RELATIVE path in any import', async () => {
    // A relative escape into ../../infra would be the sneaky failure mode the
    // regex above catches; assert it explicitly as its own case.
    const files = await tsFilesUnder(CORE_SRC);
    const escapes: string[] = [];
    for (const path of files) {
      const source = await readFile(path, 'utf8');
      for (const line of source.split('\n')) {
        if (/from\s+['"](\.\.\/)+infra\//.test(line)) escapes.push(relative(REPO_ROOT, path));
      }
    }
    expect(escapes).toEqual([]);
  });
});
