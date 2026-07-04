/**
 * SPIKE-E (ix) — Tauri sidecar ad-hoc codesign dry run. QUARANTINED spike code.
 *
 * Builds a tiny stub "sidecar" binary + a stub .app bundle laid out the way
 * `tauri build` lays out an externalBin sidecar (Contents/MacOS/<name>-<target-triple>),
 * then walks the signing scenarios that matter for the-last-aibender's v0 ship:
 *
 *   S1  inside-out ad-hoc signing (sidecar first, then app)   -> must VERIFY
 *   S2  codesign -dv detail extraction (adhoc marker, ident)  -> must show adhoc
 *   S3  spctl --assess on the ad-hoc app                      -> expected REJECT (recorded)
 *   S4  byte-append tamper of the sidecar after signing       -> bundle verify must FAIL;
 *       bonus finding: codesign refuses to even RE-SIGN a byte-appended Mach-O
 *       ("main executable failed strict validation") — corrupt != replaceable
 *   S5  REPLACE the sidecar with a freshly built, freshly signed variant
 *       (the realistic "sidecar updated after outer app was signed" case)
 *       -> bundle verify must STILL FAIL: the outer seal pins the sidecar cdhash
 *       (this is the tauri#11992 gotcha class); re-signing the app -> VERIFY again
 *   S6  sign the app while the sidecar is UNSIGNED            -> recorded (ordering probe)
 *   S7  hardened runtime + JIT entitlements on the sidecar    -> flags/entitlements must show
 *   S8  Developer ID identity presence probe (metadata only)  -> recorded (no secret reads)
 *
 * Everything is ad-hoc ("-" identity): no Apple account, no keychain writes, no
 * notarization. Real Developer-ID signing is documented in the verdict doc and
 * left as a live-host / owner item.
 *
 * Output: human summary on stdout + machine log at out/results.json (gitignored).
 * Exit code 0 only if every EXPECTED invariant held.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, statSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const appDir = join(out, "AibenderSpike.app");
const macosDir = join(appDir, "Contents", "MacOS");
// Tauri externalBin naming convention: <name>-<target triple>
const sidecarName = "aibender-core-stub-aarch64-apple-darwin";
const sidecar = join(macosDir, sidecarName);
const mainExe = join(macosDir, "AibenderSpike");
const entitlementsPlist = join(out, "sidecar.entitlements.plist");

interface StepResult {
  scenario: string;
  cmd: string;
  exitCode: number;
  durationMs: number;
  output: string;
  expected: string;
  pass: boolean;
}
const results: StepResult[] = [];

interface RunOutcome {
  exitCode: number;
  output: string;
  durationMs: number;
}

function run(cmd: string, args: string[]): RunOutcome {
  const t0 = performance.now();
  // spawnSync so we capture stderr even on success — codesign -dv prints to stderr.
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  return { exitCode: r.status ?? -1, output, durationMs: performance.now() - t0 };
}

function record(scenario: string, cmd: string, args: string[], expected: string, judge: (r: RunOutcome) => boolean): RunOutcome {
  const r = run(cmd, args);
  const pass = judge(r);
  results.push({
    scenario,
    cmd: [cmd, ...args].join(" "),
    exitCode: r.exitCode,
    durationMs: Math.round(r.durationMs * 10) / 10,
    output: r.output.slice(0, 2000),
    expected,
    pass,
  });
  const mark = pass ? "PASS" : "FAIL";
  console.log(`[${mark}] ${scenario} (${Math.round(r.durationMs)} ms, exit ${r.exitCode})`);
  if (!pass) console.log(`       expected: ${expected}\n       got: ${r.output.split("\n").slice(0, 4).join(" | ")}`);
  return r;
}

// ---------------------------------------------------------------- S0: build
rmSync(out, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });

const stubC = `
#include <stdio.h>
int main(void) { printf("aibender-core stub sidecar\\n"); return 0; }
`;
const stubV2C = `
#include <stdio.h>
int main(void) { printf("aibender-core stub sidecar v2 (replaced build)\\n"); return 0; }
`;
const mainC = `
#include <stdio.h>
int main(void) { printf("AibenderSpike stub app\\n"); return 0; }
`;
writeFileSync(join(out, "stub.c"), stubC);
writeFileSync(join(out, "stub-v2.c"), stubV2C);
writeFileSync(join(out, "main.c"), mainC);
const sidecarV2 = join(out, "sidecar-v2-build");

record("S0a compile sidecar stub (clang)", "clang", ["-O2", "-o", sidecar, join(out, "stub.c")], "exit 0", (r) => r.exitCode === 0);
record("S0b compile main stub (clang)", "clang", ["-O2", "-o", mainExe, join(out, "main.c")], "exit 0", (r) => r.exitCode === 0);
record("S0e compile sidecar v2 (the 'replaced build' for S5)", "clang", ["-O2", "-o", sidecarV2, join(out, "stub-v2.c")], "exit 0", (r) => r.exitCode === 0);

writeFileSync(
  join(appDir, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>AibenderSpike</string>
  <key>CFBundleIdentifier</key><string>dev.aibender.spike.signing</string>
  <key>CFBundleName</key><string>AibenderSpike</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
</dict></plist>
`,
);

const sidecarBytes = statSync(sidecar).size;
const mainBytes = statSync(mainExe).size;
console.log(`[info] sidecar ${sidecarBytes} bytes, main ${mainBytes} bytes`);

// clang/ld on Apple Silicon auto-ad-hoc-signs at link time; strip that so the
// signing scenarios start from a known state.
record("S0c strip linker ad-hoc signature from sidecar", "codesign", ["--remove-signature", sidecar], "exit 0", (r) => r.exitCode === 0);
record("S0d strip linker ad-hoc signature from main", "codesign", ["--remove-signature", mainExe], "exit 0", (r) => r.exitCode === 0);

// -------------------------------------- S6 first (needs the unsigned state):
// what happens if you sign the OUTER app while the nested sidecar is unsigned?
const s6 = record(
  "S6 sign app while sidecar UNSIGNED (ordering probe — recorded either way)",
  "codesign",
  ["--force", "--sign", "-", "--identifier", "dev.aibender.spike.signing", appDir],
  "recorded: does codesign refuse, or sign+seal anyway?",
  () => true, // observational
);
const s6verify = record(
  "S6v verify bundle after outer-first signing (recorded)",
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appDir],
  "recorded: strict verify outcome for outer-first order",
  () => true, // observational
);
console.log(`[info] S6: outer-first sign exit=${s6.exitCode}; deep-strict verify exit=${s6verify.exitCode}`);

// ------------------------------------------------ S1: inside-out ad-hoc sign
record(
  "S1a ad-hoc sign sidecar (inside-out step 1)",
  "codesign",
  ["--force", "--sign", "-", "--identifier", "dev.aibender.spike.sidecar", "--timestamp=none", sidecar],
  "exit 0",
  (r) => r.exitCode === 0,
);
record(
  "S1b ad-hoc sign app bundle (inside-out step 2)",
  "codesign",
  ["--force", "--sign", "-", "--identifier", "dev.aibender.spike.signing", "--timestamp=none", appDir],
  "exit 0",
  (r) => r.exitCode === 0,
);
record(
  "S1c deep+strict verify of the bundle",
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appDir],
  "exit 0 — inside-out ad-hoc signing must verify",
  (r) => r.exitCode === 0,
);
record(
  "S1d verify sidecar directly",
  "codesign",
  ["--verify", "--strict", "--verbose=2", sidecar],
  "exit 0",
  (r) => r.exitCode === 0,
);

// -------------------------------------------------------- S2: -dv inspection
record(
  "S2a codesign -dv on app shows adhoc",
  "codesign",
  ["-dv", "--verbose=4", appDir],
  "output contains Signature=adhoc + our identifier",
  (r) => r.output.includes("Signature=adhoc") && r.output.includes("dev.aibender.spike.signing"),
);
record(
  "S2b codesign -dv on sidecar shows adhoc",
  "codesign",
  ["-dv", "--verbose=4", sidecar],
  "output contains Signature=adhoc + sidecar identifier",
  (r) => r.output.includes("Signature=adhoc") && r.output.includes("dev.aibender.spike.sidecar"),
);

// ------------------------------------------------------------- S3: spctl
record(
  "S3 spctl --assess on ad-hoc app (Gatekeeper expectation)",
  "spctl",
  ["--assess", "--type", "exec", "--verbose", appDir],
  "non-zero exit / 'rejected' — ad-hoc is never notarized so Gatekeeper refuses it",
  (r) => r.exitCode !== 0,
);

// ---------------------------------------------- S4: byte-append corruption
appendFileSync(sidecar, Buffer.from([0x00]));
record(
  "S4a bundle verify after sidecar byte-append tamper",
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appDir],
  "non-zero exit — the outer seal must catch a modified sidecar",
  (r) => r.exitCode !== 0,
);
record(
  "S4b sidecar verify after tamper",
  "codesign",
  ["--verify", "--strict", "--verbose=2", sidecar],
  "non-zero exit — the sidecar's own signature must be broken",
  (r) => r.exitCode !== 0,
);
record(
  "S4c codesign refuses to re-sign the byte-appended Mach-O",
  "codesign",
  ["--force", "--sign", "-", "--identifier", "dev.aibender.spike.sidecar", "--timestamp=none", sidecar],
  "non-zero exit — 'main executable failed strict validation' (corrupt binary is not healable by re-signing)",
  (r) => r.exitCode !== 0,
);

// ----------------------- S5: the tauri#11992 gotcha class, reproduced locally
// Realistic case: the sidecar is REPLACED by a new build (e.g. a re-signed or
// rebuilt aibender-core) after the outer app was already signed.
copyFileSync(sidecarV2, sidecar);
record(
  "S5a strip linker sig + ad-hoc sign the replacement sidecar",
  "codesign",
  ["--force", "--sign", "-", "--identifier", "dev.aibender.spike.sidecar", "--timestamp=none", sidecar],
  "exit 0 — a fresh valid Mach-O signs fine",
  (r) => r.exitCode === 0,
);
record(
  "S5b sidecar verifies on its own",
  "codesign",
  ["--verify", "--strict", "--verbose=2", sidecar],
  "exit 0",
  (r) => r.exitCode === 0,
);
record(
  "S5c bundle verify with VALID re-signed sidecar but stale outer seal",
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appDir],
  "non-zero exit — outer seal pins the old sidecar cdhash (the shared-build gotcha)",
  (r) => r.exitCode !== 0,
);
record(
  "S5d re-sign the app bundle (outer seal refresh)",
  "codesign",
  ["--force", "--sign", "-", "--identifier", "dev.aibender.spike.signing", "--timestamp=none", appDir],
  "exit 0",
  (r) => r.exitCode === 0,
);
record(
  "S5e bundle verify after outer re-sign",
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appDir],
  "exit 0 — re-signing inside-out heals the bundle",
  (r) => r.exitCode === 0,
);

// --------------------- S7: hardened runtime + JIT entitlements (Node sidecar)
writeFileSync(
  entitlementsPlist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
`,
);
record(
  "S7a sign sidecar with hardened runtime + JIT entitlements",
  "codesign",
  ["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlementsPlist, "--identifier", "dev.aibender.spike.sidecar", "--timestamp=none", sidecar],
  "exit 0 — runtime option + entitlements are mechanically fine even ad-hoc",
  (r) => r.exitCode === 0,
);
record(
  "S7b -dv shows runtime flag on sidecar",
  "codesign",
  ["-dv", "--verbose=4", sidecar],
  "flags contain 'runtime'",
  (r) => /flags=.*runtime/.test(r.output),
);
record(
  "S7c entitlements dump contains allow-jit",
  "codesign",
  ["-d", "--entitlements", "-", sidecar],
  "entitlements output contains com.apple.security.cs.allow-jit",
  (r) => r.output.includes("com.apple.security.cs.allow-jit"),
);
record(
  "S7d re-sign app after sidecar re-sign, then final verify",
  "codesign",
  ["--force", "--sign", "-", "--identifier", "dev.aibender.spike.signing", "--timestamp=none", appDir],
  "exit 0",
  (r) => r.exitCode === 0,
);
record(
  "S7e final deep+strict verify",
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appDir],
  "exit 0",
  (r) => r.exitCode === 0,
);

// ------------------- S8: Developer ID identity presence (metadata list only)
record(
  "S8 codesigning identities present (metadata only, no secret reads)",
  "security",
  ["find-identity", "-v", "-p", "codesigning"],
  "recorded — Developer ID expected ABSENT on this machine",
  () => true, // observational
);

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.pass);
writeFileSync(
  join(out, "results.json"),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version },
      sizes: { sidecarBytes, mainBytes },
      results,
    },
    null,
    2,
  ),
);
console.log(`\n${results.length} steps, ${failed.length} failed. Full log: ${join(out, "results.json")}`);
if (failed.length > 0) process.exit(1);
