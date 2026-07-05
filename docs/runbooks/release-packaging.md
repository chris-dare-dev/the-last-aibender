# Runbook — release & packaging: dry-run → sign → notarize → clean-account launch

**Status:** live for the **dry-run / local build** (SI-6, M6) · **real signing,
notarization, and LaunchAgent install are T3, owner-gated** (External System
Write Policy — they touch a paid Apple Developer identity and the real login
session)
**Sources of record:** [spike-e](../spikes/spike-e-signing-ant.md) (the measured
ad-hoc + documented Developer-ID procedure, incl. tauri#11992),
`app/src-tauri/tauri.conf.json` (the v0 bundle config),
`app/src-tauri/entitlements.plist` (hardened-runtime JIT keys),
`app/src-tauri/scripts/build-sidecar.sh` (produces the sidecar),
`infra/ci/verify-bundle-config.sh` (static bundle-shape gate),
[launchd.md](launchd.md) (the v1 broker LaunchAgent, if flipped).

The v0 ship is a Tauri app with `aibender-core` bundled as an `externalBin`
**sidecar**. v0 posture (blueprint §8): **locally-built personal use needs no
notarization** — a local build carries no quarantine bit, so Gatekeeper never
assesses it, and ad-hoc signing verifies deep+strict (spike-e S1/S3). The
Developer-ID + notarization path is documented here for the day a **shared**
build is wanted; it is owner-run and hard-gated.

---

## 0. The four stages (and which the harness performs)

| Stage | Who runs it | External mutation? |
|---|---|---|
| 1. **Dry-run** — config validation + local debug proof | harness (CI + this runbook) | no |
| 2. **Local ad-hoc bundle** — real `.app` with an ad-hoc-signed sidecar | owner, local | no (ad-hoc `-s -`, no identity) |
| 3. **Real sign + notarize** — Developer-ID identity + `notarytool` | owner only, **HARD-GATED** | **yes** — paid Apple identity, Apple notary service |
| 4. **Clean-user-account launch** — install/launch on a pristine account | owner only | installs into a real account |

The harness does **stage 1** in CI and never attempts stages 2–4 on its own.
Stages 2–4 are the exact commands below, run by the owner.

---

## 1. Stage 1 — dry-run (what CI + the debug gate prove, no signing)

These run offline, in CI, with no Apple identity — they are the M6 gate:

```sh
# a. Bundle-config shape is v0-correct (active, externalBin sidecar,
#    signingIdentity=null → DRY-RUN, entitlements JIT keys present).
bash infra/ci/verify-bundle-config.sh

# b. The crate compiles + the headless boot proof exits 0 (M2 gate parity).
cargo build --manifest-path app/src-tauri/Cargo.toml
./app/src-tauri/target/debug/aibender-app --smoke-test    # exit 0

# c. The bootstrap validation matrix.
cargo test --manifest-path app/src-tauri/Cargo.toml
```

`signingIdentity` in the committed config is `null` — no real identity is ever
baked into the tree ([X2]). The debug build drops a tiny valid **placeholder**
sidecar (`ensure-sidecar-placeholder.sh`, a `/usr/bin/true` copy) purely to
satisfy tauri-build's externalBin existence check; it is gitignored and is
**never** the shipped artifact.

---

## 2. Stage 2 — local ad-hoc bundle (owner, local, no identity)

This produces a real `.app` (and `.dmg`) with the **real** aibender-core
sidecar, ad-hoc signed. Proven mechanically in spike-e; this is the command the
owner runs to get a working local build:

```sh
# From the repo root. beforeBundleCommand runs scripts/build-sidecar.sh, which
# bundles core/src/main/index.ts (esbuild), makes the Node-SEA launcher
# `binaries/aibender-core-<triple>`, co-locates the node-pty addon, and
# ad-hoc-signs the sidecar.
pnpm -F aibender-app tauri build

# Output (Tauri default): app/src-tauri/target/release/bundle/
#   macos/the-last-aibender.app
#   dmg/the-last-aibender_<ver>_<arch>.dmg
```

Verify the ad-hoc bundle (spike-e S1 — inside-out order is enforced by
codesign, so the sidecar is signed before the app automatically):

```sh
APP="app/src-tauri/target/release/bundle/macos/the-last-aibender.app"
codesign --verify --deep --strict --verbose=2 "$APP"        # expect: valid on disk
codesign -dv --verbose=4 "$APP" 2>&1 | grep -i 'Signature'  # Signature=adhoc (expected for v0)
# spctl --assess REJECTS an ad-hoc app (exit 3) — expected and irrelevant for
# local use: no quarantine bit, so Gatekeeper never assesses a local build.
```

**This is the v0 deliverable.** For personal/local use, stop here — the app
launches, discovers the broker via the bootstrap file, and runs.

---

## 3. Stage 3 — real sign + notarize (owner only, HARD-GATED)

Only for a **shared** build (giving the `.app`/`.dmg` to another machine, where
the quarantine bit will make Gatekeeper assess it). Requires a paid Apple
Developer account. **Do not run any of this on assumption — it uses a real
signing identity and calls Apple's notary service.**

### 3.1 Prerequisites (owner supplies; never committed [X2])

- A **"Developer ID Application"** certificate in the login keychain.
  Confirm it exists: `security find-identity -v -p codesigning`
  (spike-e measured `0 valid identities found` on the build host — that is why
  this stage is owner-only).
- Either an **App Store Connect API key** (`APPLE_API_ISSUER`, `APPLE_API_KEY`,
  `APPLE_API_KEY_PATH`) or **Apple-ID app-specific password**
  (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`).

### 3.2 Flip the config for a real build (a local edit, NOT committed)

In `app/src-tauri/tauri.conf.json`, for the signed build only:

```jsonc
"bundle": {
  "macOS": {
    "signingIdentity": "Developer ID Application: <Your Name> (<TEAMID>)",
    "hardenedRuntime": true,          // already true — required for notarization
    "entitlements": "entitlements.plist"  // already carries allow-jit + allow-unsigned-executable-memory (spike-e S7)
  }
}
```

Keep this edit **local** — the committed config stays `signingIdentity: null`
([X2]; the `verify-bundle-config.sh` gate enforces that on the tree).

### 3.3 Build, sign, notarize

Tauri signs when `APPLE_SIGNING_IDENTITY` is set and notarizes when the notary
credentials are present:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Your Name> (<TEAMID>)"
# API-key auth (preferred):
export APPLE_API_ISSUER="<issuer-uuid>" APPLE_API_KEY="<key-id>" APPLE_API_KEY_PATH="/path/AuthKey_<key-id>.p8"
pnpm -F aibender-app tauri build     # signs (Developer ID) + submits to notarytool + staples
```

### 3.4 If tauri#11992 bites (the named externalBin fallback)

tauri#11992 is **still open**: minimal repros notarize fine *without*
`externalBin` and fail *with* it (`The signature of the binary is invalid`,
arm64). If notarization fails on the sidecar, drop out of tauri-cli's automatic
flow and re-sign **inside-out manually** (the spike-e S5 heal sequence with a
real identity), then submit directly:

```sh
APP="app/src-tauri/target/release/bundle/macos/the-last-aibender.app"
SIDECAR="$APP/Contents/MacOS/aibender-core-<target-triple>"
ID="Developer ID Application: <Your Name> (<TEAMID>)"

# 1. Sidecar FIRST — hardened runtime + JIT entitlements + secure timestamp.
codesign --force --timestamp --options runtime \
  --entitlements app/src-tauri/entitlements.plist -s "$ID" "$SIDECAR"
# 2. Then the outer app (its seal pins the sidecar's cdhash — spike-e S5).
codesign --force --timestamp --options runtime \
  --entitlements app/src-tauri/entitlements.plist -s "$ID" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"          # must pass

# 3. Notarize the app (zip it first), then staple.
DITTO_ZIP="$(mktemp -d)/the-last-aibender.zip"
/usr/bin/ditto -c -k --keepParent "$APP" "$DITTO_ZIP"
xcrun notarytool submit "$DITTO_ZIP" \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
  --wait                                                       # blocks until Accepted/Invalid
xcrun stapler staple "$APP"                                    # staple the .app (and the .dmg if shipping that)
xcrun stapler validate "$APP"
```

**Signing rules that WILL bite if ignored** (spike-e, measured):

- **Inside-out order is enforced by codesign** (S6): sign the sidecar before the
  app or the sign fails outright.
- **Any sidecar touch after the app is signed invalidates the bundle** (S5):
  treat "re-sign sidecar ⇒ re-sign app" as an atomic pair.
- **Do NOT use `--deep` to *sign*** (deprecated; hides per-binary entitlement
  mistakes) — sign each Mach-O explicitly. `--deep` is fine for *verify*.
- **Sign the renamed artifact** `aibender-core-<target-triple>` inside
  `Contents/MacOS/`, not the pre-copy source binary.
- **A byte-corrupted Mach-O is not healable in place** (S4) — rebuild it.

---

## 4. Stage 4 — clean-user-account launch (owner, the acceptance test)

The M6 DoD acceptance: the signed (dry-run) build launches on a **clean macOS
user account** and discovers the broker via the bootstrap-file contract.

1. Create (or use) a pristine macOS user account with no `~/.aibender`, no
   `~/.claude`, no dev toolchain.
2. Copy the built `.app` over (for the shared/notarized build the quarantine
   xattr will be present — Gatekeeper assesses it; for the local ad-hoc build
   there is no quarantine bit and it launches directly).
3. Launch it. Expect: window opens (charcoal pre-paint), tray installs, the app
   reports its broker run mode. With no broker advertised yet it shows the
   honest "no broker" state (same as `--smoke-test`), never a crash.
4. Start the broker (v0: the app's bundled sidecar; v1: the owner-flipped
   LaunchAgent, [launchd.md](launchd.md)); the app discovers port + token from
   `~/.aibender/bootstrap/gateway.json` and connects over loopback.

This is enumerated as the T3 live check `signing-dryrun` (and the packaging
cold-start entries) in `infra/ci/live-check.sh` — SKIP-pending-owner until run
on the real clean account.

### 4b. LaunchAgent-v1 install (the v1 flip — separate owner gate)

Installing the broker LaunchAgent (so sessions outlive the app) is the v1 flip,
owner-gated and independent of signing. The plist is finalized v1-ready and
lint-validated but **not installed** by the harness. When flipping, follow
[launchd.md](launchd.md) — render, bootstrap into `gui/$UID`, and immediately
verify per-account keychain value access in the agent's own context.

---

## 5. What NOT to do

- **Never commit a real `signingIdentity`, certificate, API key, or notary
  password** — the committed config stays `signingIdentity: null`; real
  identities live in the owner's keychain/env only ([X2]; enforced by
  `verify-bundle-config.sh`).
- **Never notarize or sign for real from CI or an agent** — stage 3 is
  owner-only, hard-gated. CI only does stage 1.
- **Never ship the placeholder sidecar** — it is a build-check stub; a real
  ship goes through `tauri build` (stage 2/3), which overwrites it with the
  real SEA launcher.
- **Never sign the app before the sidecar exists** — codesign enforces the
  order; a pipeline that does this fails immediately (spike-e S6).
