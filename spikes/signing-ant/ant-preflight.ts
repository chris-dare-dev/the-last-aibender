/**
 * SPIKE-E (viii) — `ant` profile experiment PREFLIGHT. QUARANTINED spike code.
 *
 * Strictly read-only. Run this before the owner-run 10-minute experiment in
 * docs/spikes/spike-e-signing-ant.md to confirm the machine is in a state
 * where the experiment's observations will be clean:
 *
 *   P1  is the `ant` CLI installed? (experiment step 0 installs it if not)
 *   P2  does ~/.config/anthropic (or $ANTHROPIC_CONFIG_DIR) already exist?
 *       If YES -> WARN: an implicit profile could already be interfering with
 *       claude/SDK auth on this machine, and the experiment must NOT assume a
 *       clean slate.
 *   P3  is `claude` installed, and does the installed binary contain the
 *       ANTHROPIC_PROFILE / active_config resolution logic? (string probe,
 *       read-only — no execution against any credential store)
 *   P4  are ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_PROFILE set
 *       in this shell? Any of these would poison the experiment's precedence
 *       observations (API key silently outranks every profile).
 *
 * It never logs in, never logs out, never reads credential values, never
 * writes anything. Exit 0 = ready; exit 1 = blocking condition (fix before
 * running the experiment).
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Status = "OK" | "WARN" | "BLOCK";
const findings: Array<{ check: string; status: Status; detail: string }> = [];
function report(check: string, status: Status, detail: string): void {
  findings.push({ check, status, detail });
  console.log(`[${status.padEnd(5)}] ${check} — ${detail}`);
}

function which(bin: string): string | null {
  const r = spawnSync("command", ["-v", bin], { encoding: "utf8", shell: "/bin/bash" });
  const p = (r.stdout ?? "").trim();
  return r.status === 0 && p ? p : null;
}

// P1 — ant CLI
const antPath = which("ant");
if (antPath) {
  const v = spawnSync(antPath, ["--version"], { encoding: "utf8" });
  const ver = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim().split("\n")[0];
  // Apache Ant (the Java build tool) also installs as `ant` — disambiguate.
  if (/apache/i.test(ver)) {
    report("P1 ant CLI", "WARN", `'ant' on PATH is Apache Ant (${ver}); install Anthropic's CLI via 'brew install anthropics/tap/ant' (it will shadow or conflict — check PATH order)`);
  } else {
    report("P1 ant CLI", "OK", `${antPath} (${ver})`);
  }
} else {
  report("P1 ant CLI", "WARN", "not installed — experiment step 0 installs it (brew install anthropics/tap/ant)");
}

// P2 — pre-existing profile state
const configDir = process.env.ANTHROPIC_CONFIG_DIR ?? join(homedir(), ".config", "anthropic");
if (existsSync(configDir)) {
  report(
    "P2 anthropic config dir",
    "WARN",
    `${configDir} already exists — profiles may already exist on this machine; an implicit active_config can interfere with claude auth TODAY (and with the experiment). Inventory it read-only before proceeding.`,
  );
} else {
  report("P2 anthropic config dir", "OK", `${configDir} does not exist — clean slate for the sandboxed experiment`);
}

// P3 — claude binary + profile-resolution logic
const claudePath = which("claude");
if (!claudePath) {
  report("P3 claude binary", "BLOCK", "claude not on PATH — the experiment's Claude-Code half cannot run");
} else {
  const real = realpathSync(claudePath);
  const v = spawnSync(claudePath, ["--version"], { encoding: "utf8" });
  const ver = `${v.stdout ?? ""}`.trim();
  // read-only string probe of the installed binary (grep -c on raw bytes)
  const g1 = spawnSync("grep", ["-ac", "ANTHROPIC_PROFILE", real], { encoding: "utf8" });
  const g2 = spawnSync("grep", ["-ac", "active_config", real], { encoding: "utf8" });
  const hasProfile = g1.status === 0 && parseInt((g1.stdout ?? "0").trim(), 10) > 0;
  const hasActive = g2.status === 0 && parseInt((g2.stdout ?? "0").trim(), 10) > 0;
  if (hasProfile && hasActive) {
    report("P3 claude binary", "OK", `${ver} at ${real} — contains ANTHROPIC_PROFILE + active_config resolution logic`);
  } else {
    report("P3 claude binary", "WARN", `${ver} at ${real} — profile-resolution strings NOT found (profile support may have been removed; re-verify before the experiment)`);
  }
}

// P4 — poisoning env vars
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"] as const) {
  if (process.env[name] !== undefined) {
    // Never print the value.
    report(`P4 env ${name}`, "BLOCK", "set in this shell — it outranks/derails profile resolution; unset it (not =\"\": empty still occupies the precedence slot) before the experiment");
  } else {
    report(`P4 env ${name}`, "OK", "not set");
  }
}

const blocks = findings.filter((f) => f.status === "BLOCK").length;
const warns = findings.filter((f) => f.status === "WARN").length;
console.log(`\npreflight: ${findings.length} checks, ${warns} warnings, ${blocks} blocking`);
process.exit(blocks > 0 ? 1 : 0);
