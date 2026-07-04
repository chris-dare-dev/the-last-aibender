/**
 * SPIKE-C (x) orchestrator — Bun.Terminal parity check vs node-pty.
 *
 * Runs three probes and prints a parity table:
 *   1. system bun (whatever `bun` on PATH is) — Terminal API present?
 *   2. node-pty 1.1.0 under the repo's node — the baseline (MUST pass)
 *   3. bun 1.3.14 (spike-local npm install) — Bun.Terminal round-trip
 *
 * The verdict consequence (plan/blueprint): the daemon stays on Node LTS +
 * node-pty either way; this spike only informs whether Bun.Terminal is a
 * credible future substitute. So: node-pty failure fails the spike;
 * Bun.Terminal failure is recorded, not fatal.
 *
 * Writes results/parity.json.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOCAL_BUN = path.join(ROOT, "node_modules", ".bin", "bun");
const RESULTS_DIR = path.join(ROOT, "results");

function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* not json, keep walking up */
    }
  }
  return null;
}

// -- landmine guard: node-pty's darwin prebuild ships spawn-helper without
//    the exec bit under pnpm; posix_spawnp fails until chmod +x. Recorded
//    in the verdict doc as a BE-2 install-step requirement.
function fixSpawnHelperExecBit(): boolean {
  try {
    const helper = execFileSync("node", [
      "-e",
      "console.log(require.resolve('node-pty/package.json'))",
    ], { cwd: ROOT, encoding: "utf8" }).trim();
    const dir = path.join(path.dirname(helper), "prebuilds", `${process.platform}-${process.arch}`);
    const bin = path.join(dir, "spawn-helper");
    if (existsSync(bin)) {
      chmodSync(bin, 0o755);
      return true;
    }
  } catch {
    /* non-darwin or built from source — nothing to fix */
  }
  return false;
}

interface ProbeRow {
  probe: string;
  ok: boolean;
  detail: Record<string, unknown> | null;
  note: string;
}

const rows: ProbeRow[] = [];

// ---------------------------------------------------------------- 1. system bun
{
  // strip node_modules/.bin entries so the spike-local bun 1.3.x does not
  // shadow whatever `bun` the machine actually has on PATH
  const systemPath = (process.env.PATH ?? "")
    .split(":")
    .filter((p) => !p.includes("node_modules"))
    .join(":");
  const r = spawnSync("bun", ["-e", 'console.log(JSON.stringify({version:Bun.version,hasTerminal:"Terminal" in Bun}))'], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, PATH: systemPath },
  });
  if (r.status === 0 && r.stdout) {
    const d = lastJsonLine(r.stdout);
    rows.push({
      probe: "system bun",
      ok: true,
      detail: d,
      note: d?.hasTerminal
        ? "Terminal API present"
        : `bun ${d?.version} predates Bun.Terminal (needs >= 1.3.5)`,
    });
  } else {
    rows.push({ probe: "system bun", ok: false, detail: null, note: "bun not on PATH" });
  }
}

// ---------------------------------------------------------------- 2. node-pty baseline
{
  const fixed = fixSpawnHelperExecBit();
  const r = spawnSync("node", ["--import", "tsx", path.join(HERE, "parity-node-pty.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20000,
  });
  const d = lastJsonLine(r.stdout ?? "");
  rows.push({
    probe: "node-pty 1.1.0",
    ok: r.status === 0 && d?.ok === true,
    detail: d,
    note:
      (fixed ? "[spawn-helper exec bit re-applied] " : "") +
      (d ? "" : `no JSON (stderr: ${String(r.stderr).slice(0, 200)})`),
  });
}

// ---------------------------------------------------------------- 3. spike-local bun 1.3.x
{
  if (existsSync(LOCAL_BUN)) {
    const r = spawnSync(LOCAL_BUN, [path.join(HERE, "parity-bun.ts")], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, SPIKE_NODE_BIN: process.execPath },
    });
    const d = lastJsonLine(r.stdout ?? "");
    rows.push({
      probe: "Bun.Terminal (local bun)",
      ok: r.status === 0 && d?.ok === true,
      detail: d,
      note: d ? "" : `no JSON (stderr: ${String(r.stderr).slice(0, 200)})`,
    });
  } else {
    rows.push({
      probe: "Bun.Terminal (local bun)",
      ok: false,
      detail: null,
      note: "spike-local bun binary missing — pnpm install did not place it",
    });
  }
}

// ---------------------------------------------------------------- report
console.log("\n=== SPIKE-C (x) Bun.Terminal parity vs node-pty ===\n");
for (const row of rows) {
  console.log(`--- ${row.probe}: ${row.ok ? "OK" : "NOT OK"} ${row.note ? "— " + row.note : ""}`);
  if (row.detail) console.log("   ", JSON.stringify(row.detail));
}

const nodePty = rows[1];
const bunTerm = rows[2];
if (nodePty.detail && bunTerm.detail) {
  const checks = ["ttySeen", "initialSize", "resizeSeen", "echoSeen"] as const;
  console.log("\nparity matrix (node-pty vs Bun.Terminal):");
  for (const c of checks) {
    const a = JSON.stringify(nodePty.detail[c]);
    const b = JSON.stringify(bunTerm.detail[c]);
    console.log(`  ${c.padEnd(12)} node-pty=${a}  bun=${b}  ${a === b ? "MATCH" : "DIFFER"}`);
  }
  const aExit = nodePty.detail.exitEvent ? "event" : "none";
  const bExit = bunTerm.detail.exitEvent ? "event" : "none";
  console.log(`  ${"exitEvent".padEnd(12)} node-pty=${aExit}  bun=${bExit}  ${aExit === bExit ? "MATCH" : "DIFFER"}`);
}

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(path.join(RESULTS_DIR, "parity.json"), JSON.stringify(rows, null, 2));

// node-pty is the production choice — it must pass. Bun.Terminal result is
// informational for the "stay on Node LTS vs move to Bun" question.
assert.equal(nodePty.ok, true, "node-pty baseline failed — BE-2 blocker, investigate");
console.log("\nspike (x) driver: node-pty baseline PASS; Bun.Terminal result recorded");
