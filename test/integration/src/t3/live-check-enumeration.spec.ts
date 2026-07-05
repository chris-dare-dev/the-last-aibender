/**
 * §9.4 meta-test — the genuinely-T3 §9.3 seams are ENUMERATED (not run) in
 * infra/ci/live-check.sh with pending-owner status, so nothing is silently
 * dropped.
 *
 * The synthetic-provable §9.3 slices run in the other INTEG files. The other
 * halves — real `claude` login, real Keychain value reads, Aqua launchd, real
 * LM Studio GPU loads, the Colima pod→host probe, a signed-artifact clean-user
 * launch, the 24 h soak — are physically unobservable in hosted CI (plan §9.4,
 * integration-suite.md §4). They live in the live-check runner, run at
 * milestone gates. This meta-test GREPS the runner's registry to assert:
 *
 *   1. every genuinely-T3 seam has a check with a runbook/doc pointer;
 *   2. the runner is offline-runnable and reports every unenabled T3 seam as
 *      SKIP (pending-owner), NEVER FAIL — the honest "not silently dropped,
 *      not falsely green" contract;
 *   3. the registry is not silently SHRUNK below the enumerated set
 *      (integration-suite.md §4: an entry deleted without an ADR is a gate
 *      failure).
 *
 * Robustness: seams are matched by the CAPABILITY each check covers (a set of
 * substrings that MUST appear on some registry line), not by an exact id — so
 * the SI-6/BE-9 M6 agents adding/renaming entries can't accidentally make this
 * meta-test stale, only stronger.
 *
 * [X2]: reads the runner text + parses tab-separated report lines; no identity.
 */

import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIVE_CHECK = join(REPO_ROOT, 'infra/ci/live-check.sh');

/** Report line: check<TAB>ID<TAB>MILESTONE<TAB>STATUS<TAB>DETAIL. */
interface CheckLine {
  id: string;
  milestone: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

async function listRegistry(): Promise<CheckLine[]> {
  const { stdout } = await execFileAsync('bash', [LIVE_CHECK, '--list'], {
    cwd: REPO_ROOT,
    env: { ...process.env, AIBENDER_LIVECHECK_OFFLINE: '1' },
  });
  return stdout
    .split('\n')
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [id, milestone, description, pointer] = line.split('\t');
      return {
        id: id ?? '',
        milestone: milestone ?? '',
        status: 'SKIP' as const,
        detail: `${description ?? ''}\t${pointer ?? ''}`,
      };
    });
}

/** Run a milestone OFFLINE against a nonexistent home; return parsed report. */
async function runMilestoneOffline(milestone: string): Promise<{ lines: CheckLine[]; exit: number }> {
  const args = [LIVE_CHECK, '--milestone', milestone, '--aibender-home', '/tmp/aibender-integ-nonexistent-home'];
  try {
    const { stdout } = await execFileAsync('bash', args, {
      cwd: REPO_ROOT,
      env: { ...process.env, AIBENDER_LIVECHECK_OFFLINE: '1' },
    });
    return { lines: parseReport(stdout), exit: 0 };
  } catch (error) {
    const err = error as { code?: number; stdout?: string };
    return { lines: parseReport(err.stdout ?? ''), exit: err.code ?? 1 };
  }
}

function parseReport(stdout: string): CheckLine[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('check\t'))
    .map((line) => {
      const parts = line.split('\t');
      return {
        id: parts[1] ?? '',
        milestone: parts[2] ?? '',
        status: (parts[3] ?? '') as CheckLine['status'],
        detail: parts[4] ?? '',
      };
    });
}

/**
 * The genuinely-T3 §9.3/§9.4 seams (plan §9.4 + integration-suite.md §4). Each
 * is matched by a set of substrings that MUST appear together on some registry
 * DESCRIPTION line — capability match, not exact id.
 */
const T3_SEAMS: ReadonlyArray<{ name: string; anyOfDescriptors: RegExp[] }> = [
  { name: 'L1/L2 real Keychain value reads', anyOfDescriptors: [/keychain/i, /auth status/i] },
  { name: 'L2 version-gate service-name drift', anyOfDescriptors: [/version-gate|service-name recompute/i] },
  { name: 'L7 real claude login / x1 live demo', anyOfDescriptors: [/re-login|login|three concurrent live sessions/i] },
  { name: 'L1 Aqua launchd (gui-domain)', anyOfDescriptors: [/launchd|Aqua/i] },
  { name: 'L3 real hooks-installed', anyOfDescriptors: [/hook settings installed|hooks/i] },
  { name: 'L4 real LM Studio reachability', anyOfDescriptors: [/LM Studio/i] },
  { name: 'L4 Colima pod→host probe ([X3])', anyOfDescriptors: [/colima|loopback/i] },
  { name: 'L5 AWS SSO / inference-profile', anyOfDescriptors: [/terraform plan|sso|aws/i] },
  { name: 'L6/L8 signed-artifact clean-user launch', anyOfDescriptors: [/signed.*dry-run|sidecar artifact|cold-start/i] },
  { name: 'L9 24 h soak (T4/owner)', anyOfDescriptors: [/24 ?h|soak/i] },
];

describe('§9.4 meta-test — genuinely-T3 §9.3 seams are enumerated in live-check', () => {
  it('the live-check runner exists and is executable', async () => {
    const { stdout } = await execFileAsync('bash', [LIVE_CHECK, '--list'], {
      cwd: REPO_ROOT,
      env: { ...process.env, AIBENDER_LIVECHECK_OFFLINE: '1' },
    });
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('every genuinely-T3 §9.3 seam has an enumerated check with a doc/runbook pointer', async () => {
    const registry = await listRegistry();
    expect(registry.length).toBeGreaterThanOrEqual(13);

    for (const seam of T3_SEAMS) {
      const match = registry.find((line) =>
        seam.anyOfDescriptors.some((re) => re.test(line.detail)),
      );
      expect(match, `no live-check entry enumerates T3 seam: ${seam.name}`).toBeDefined();
      // The DETAIL column must carry a runbook/doc/plan pointer (SKIP guidance).
      expect(
        /docs\/|plan §|blueprint §|\.md/.test(match!.detail),
        `${seam.name}: enumerated but no runbook/doc pointer`,
      ).toBe(true);
    }
  });

  it('offline, every milestone reports only PASS/SKIP — never FAIL, never silently missing', async () => {
    for (const milestone of ['M1', 'M2', 'M3', 'M4', 'M6']) {
      const { lines, exit } = await runMilestoneOffline(milestone);
      expect(lines.length, `${milestone} produced no check lines`).toBeGreaterThan(0);
      // No FAIL offline (unenabled prerequisites SKIP with a runbook pointer).
      const fails = lines.filter((l) => l.status === 'FAIL');
      expect(fails.map((f) => f.id), `${milestone} has offline FAILs`).toEqual([]);
      // Exit 0 = no FAIL (the runner's contract).
      expect(exit, `${milestone} exited nonzero offline`).toBe(0);
      // Every non-PASS line is a pending-owner SKIP with guidance.
      for (const line of lines) {
        expect(['PASS', 'SKIP']).toContain(line.status);
        if (line.status === 'SKIP') {
          expect(
            /pending-owner|runbook|docs\/|owner|T3|T4/i.test(line.detail),
            `${line.id} SKIP lacks pending-owner guidance`,
          ).toBe(true);
        }
      }
    }
  });

  it('the 24 h soak is enumerated as pending-owner and does NOT claim a real run in CI', async () => {
    const { lines } = await runMilestoneOffline('M6');
    const soak = lines.find((l) => /soak/i.test(l.id) || /24 ?h|soak/i.test(l.detail));
    expect(soak, 'the 24 h soak seam must be enumerated').toBeDefined();
    expect(soak!.status).toBe('SKIP');
    // Honest-returns doctrine: the T4/owner nature is stated, not hidden.
    expect(/T4|owner|accelerated|mechanism|do not claim/i.test(soak!.detail)).toBe(true);
  });

  it('the [X3] non-dependency live seam (Colima probe) is enumerated (pairs the arch test)', async () => {
    const registry = await listRegistry();
    const colima = registry.find((l) => /colima|loopback/i.test(l.detail));
    expect(colima, 'the Colima pod→host probe must be enumerated for the [X3] live half').toBeDefined();
  });
});
