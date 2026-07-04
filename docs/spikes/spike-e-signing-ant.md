# SPIKE-E verdict — `ant` profile Max-subscription experiment (viii) + sidecar signing dry run (ix)

- **Spikes:** plan §8.2 M0 (viii) + (ix); blueprint §13.5 items (viii), (ix); blueprint §3 watch rung; SI-2 written promote/hold verdict; SI-6 signing dry-run follow-on
- **Harness:** `spikes/signing-ant/` (quarantined; measured log in `spikes/signing-ant/out/results.json`, gitignored)
- **Date / host:** 2026-07-04, macOS 26.6 (25G5028f), Apple Silicon (darwin arm64), Node v25.x, Xcode 26 toolchain, `claude` 2.1.193
- **Status:** (viii) is PROCEDURE-ONLY by design — no real accounts were touched; (ix) executed locally with ad-hoc identity; T3 items listed at the end of each part

---

# Part 1 — Spike (viii): can a Claude **Max subscription** back an `ant` `user_oauth` profile?

## Question

Blueprint §3 keeps `ant` CLI profiles / `ANTHROPIC_PROFILE` at the **watch rung** of the
multi-account fallback ladder: *"Promote to rung 1 if Max-subscription support is confirmed
(Stage-2 experiment)."* This spike must (a) establish the current documented state of `ant`
profiles, (b) write the exact ~10-minute experiment the owner can run to settle the question
empirically without endangering any real credential store, and (c) issue a written
**promote/hold** recommendation on documented evidence (SI-2 deliverable).

## Method

**Hard constraint honored: no real accounts, no logins/logouts, no keychain value reads, no
writes to `~/.claude` or `~/.config/anthropic`.** Everything below is (1) primary-source web
research dated 2026-07-04, (2) read-only string analysis of the installed `claude` 2.1.193
binary, and (3) a read-only preflight script (`spikes/signing-ant/ant-preflight.ts`) executed
on this host.

**Headless limitation (explicit):** the definitive answer requires an interactive browser
OAuth flow against a real Max-subscription identity. That cannot and must not be done by an
agent; it is written up below as the owner-run T3 experiment. This verdict is therefore a
*documented-evidence* verdict with the empirical confirmation deferred to T3.

Sources consulted (all fetched 2026-07-04):

- `ant` CLI quickstart + authentication docs, platform.claude.com (current; CLI v1.15/1.16 era)
- WIF reference (profile file schema, credential precedence), platform.claude.com
- Claude Code authentication docs, code.claude.com (current)
- `anthropics/anthropic-cli` GitHub releases (latest **v1.16.0, 2026-07-02**)
- String analysis of `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
  (v2.1.193, build 2026-06-25)

## Result

### R1 — `ant auth login` is a Claude **Console** flow, organization/workspace-scoped

The current CLI auth docs are unambiguous (quotes, 2026-07-04):

> "`ant auth login` … opens a browser-based OAuth flow **against the Claude Console** and
> stores the resulting credentials under `$ANTHROPIC_CONFIG_DIR`."

> "During the browser flow, you select an **organization** and then a **workspace**. The
> issued token is scoped to that workspace, so the CLI can only see resources that belong
> to it."

`ant auth status` sample output in the docs shows the credential as
`Profile (user_oauth) … sk-ant-oat01-EXA…` bound to a `wrkspc_01…` workspace. **Nowhere in
the CLI quickstart, authentication options page, WIF reference, or the v1.10.0→v1.16.0
release notes is there any mention of claude.ai consumer accounts, Pro/Max subscriptions,
or subscription-quota billing.** Workspace-scoped tokens are the Console/API billing plane
by construction.

### R2 — profile types are exactly `user_oauth` and `oidc_federation`

The WIF reference documents two `authentication.type` values: `user_oauth` (interactive
Console login; credentials file carries `access_token`, `expires_at`, `refresh_token`) and
`oidc_federation` (WIF). The `claude` 2.1.193 binary agrees — its error string enumerates
exactly these two: `authentication.type "…" is not a known authentication type`, and its
`user_oauth` handling requires `authentication.credentials_path` or profile-default
`<config_dir>/credentials/<profile>.json`.

### R3 — Claude Code 2.1.193 honors profiles, with measured precedence semantics

The WIF reference states: *"Claude Code and the Claude Agent SDK honor this same resolution
order, so a **federation** profile configured here also authenticates those tools without
additional setup"* — note the framing is federation/Console, not subscription. Binary string
analysis (read-only) confirms the machinery and its precedence:

- Resolution order in code: `ANTHROPIC_PROFILE` env → `<config_dir>/active_config` file →
  literal `default`. Auth-source labels in the binary: `profile-explicit`,
  `profile-implicit`, `env-quad` (WIF env vars), `credentials-file`.
- **Explicit profile beats a stored claude.ai login:** `"Using Anthropic profile auth
  (profile-explicit); this takes precedence over any stored claude.ai login"`.
- **Implicit `user_oauth` profile defers to a claude.ai login:** `"An Anthropic profile
  (~/.config/anthropic) is configured, but a claude.ai login exists — using the claude.ai
  login. Set ANTHROPIC_PROFILE=<name> to use the profile instead."` (telemetry marker
  `tengu_wif_implicit_profile_skipped_stored_login`).
- Claude Code's own authentication docs list a six-source precedence chain (cloud provider →
  `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` →
  subscription OAuth from `/login`) and **do not put profiles in the subscription path** —
  profile support is documented only from the WIF/Console side.

### R4 — direction of travel is against subscription tokens outside first-party surfaces

In April 2026 Anthropic cut off third-party harness access via Claude-subscription OAuth
(widely reported; e.g. OpenClaw's provider docs and ecosystem coverage). A Console-plane
profile mechanism gaining *subscription* backing would run opposite to that enforcement
direction. Weak signal, but it corroborates R1–R3.

### R5 — preflight executed on this host (measured)

`node spikes/signing-ant/ant-preflight.ts` (read-only, 6 checks):

| Check | Result on this host |
|---|---|
| P1 `ant` CLI installed | WARN — not installed (experiment step 0 installs it) |
| P2 `~/.config/anthropic` exists | OK — absent; clean slate |
| P3 `claude` binary has profile logic | OK — 2.1.193 contains `ANTHROPIC_PROFILE` + `active_config` resolution |
| P4 poisoning env vars | **BLOCK — `ANTHROPIC_API_KEY` was exported in the harness shell**; `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_PROFILE` unset |

The P4 hit is a live demonstration of the exact failure mode the docs warn about (*"If
`ANTHROPIC_API_KEY` is present in your environment, it overrides every profile"*) — and of
why blueprint §3 rule 3 (env-scrub per spawn) is mandatory. The preflight correctly fails
closed.

## The owner-run 10-minute experiment (T3, exact procedure)

Fully sandboxed: `ANTHROPIC_CONFIG_DIR` points the `ant` state at a scratch dir, and the
Claude Code probe uses a scratch `CLAUDE_CONFIG_DIR`, so **no real store is read or
written**. Run all steps in one shell.

```bash
# 0. Preflight (must exit 0; fix any BLOCK first — typically `unset ANTHROPIC_API_KEY`)
node spikes/signing-ant/ant-preflight.ts

# 1. Install the CLI (~1 min)
brew install anthropics/tap/ant

# 2. Sandbox the ant state — nothing touches ~/.config/anthropic
export ANTHROPIC_CONFIG_DIR="$(mktemp -d /tmp/ant-spike.XXXXXX)"

# 3. Attempt login under a scratch profile  ——  OBSERVATION A
ant auth login --profile scratch-max
```

**Observation A (the heart of the question):** in the browser flow, is there ANY path that
authenticates the claude.ai **Max** identity as such — or only a Console organization +
workspace picker? If the Max account has no Console org, does the flow dead-end? Note
carefully: if the owner's email has *both* a Max plan and a Console org, picking the org
proves nothing about Max — the test is whether a **subscription**, not an org, can back the
profile.

```bash
# 4. If login succeeded  ——  OBSERVATION B: credential plane
ant auth status                      # credential type + workspace binding
ls "$ANTHROPIC_CONFIG_DIR/credentials/"
python3 -c "import json,os; p=os.environ['ANTHROPIC_CONFIG_DIR']+'/credentials/scratch-max.json'; print(sorted(json.load(open(p)).keys()))"
# keys only — never print values

# 5. Claude Code probe: clean scratch config dir (no stored claude.ai login),
#    profile selected explicitly  ——  OBSERVATION C
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  CLAUDE_CONFIG_DIR="$(mktemp -d /tmp/claude-spike.XXXXXX)" \
  ANTHROPIC_PROFILE=scratch-max \
  claude auth status --json
```

**Observation C:** which credential source won, and does the JSON show a Max
`subscriptionType` — or an org/workspace identity (API plane)?

```bash
# 6. OPTIONAL, only if C is ambiguous  ——  OBSERVATION D: where does billing land?
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  CLAUDE_CONFIG_DIR="$(mktemp -d /tmp/claude-spike.XXXXXX)" \
  ANTHROPIC_PROFILE=scratch-max \
  claude -p "reply with the single word ok"
# If the bound workspace has no API credits and this fails with a billing error,
# the profile is definitively NOT subscription-backed. If it succeeds, check the
# Console usage page: usage appearing under the workspace = API-billed, not Max.

# 7. Cleanup — sandboxed, so this cannot touch real credentials
ant auth logout --all
rm -rf "$ANTHROPIC_CONFIG_DIR" /tmp/claude-spike.*
unset ANTHROPIC_CONFIG_DIR ANTHROPIC_PROFILE
```

**Decision matrix:**

| A: subscription-selectable path in browser? | C/D: inference draws on Max quota? | Decision |
|---|---|---|
| yes | yes | **PROMOTE** — start the rung-1 migration design (per-profile = per-account, file-based, cross-platform) |
| yes | no (API-billed) | HOLD — profile ≠ subscription quota; harness premise unmet |
| no (Console org only / dead-end) | — | HOLD — watch rung unchanged |

## Confidence

- **High** that the documented state is as described (primary Anthropic docs + current
  release notes + shipping-binary strings, all read 2026-07-04, all agreeing).
- **Medium** on the underlying capability question — undocumented behavior could exist; only
  the T3 experiment settles it. The recommendation below does not depend on that residual.

## Verdict — **HOLD: watch rung unchanged (blueprint §3)**

Promote condition — *"Max-subscription support is confirmed"* — is **not met** by any
documented evidence as of 2026-07-04. `ant` profiles remain Console-organization/workspace
credentials on the API billing plane; both profile types (`user_oauth`, `oidc_federation`)
resolve to `sk-ant-oat01-…` workspace-scoped tokens. Even a *successful* Console login from
a Max-owning email would be API-billed, which fails the harness's premise (spend the paid
subscription quotas of MAX_A/MAX_B).

**Go/fallback consequence (as the plan names it):** rung 1 stays per-account
`CLAUDE_CONFIG_DIR` + pinned `CLAUDE_SECURESTORAGE_CONFIG_DIR`; no code changes anywhere;
SI-2 keeps the watch experiment in its runbook with this doc as the procedure.

**Re-check trigger:** any `anthropic-cli` release note or docs change mentioning claude.ai /
subscription / Pro/Max login for profiles → re-run the 10-minute experiment above.

**Two hardening notes surfaced by this spike (for SI-2/BE-1 as notes, not files):**

1. The binary-confirmed implicit-profile resolution means a stray `~/.config/anthropic/`
   with an `active_config` can silently redirect auth for *any* claude/SDK process that
   isn't env-scrubbed. Blueprint §3 rule 3 (strip `ANTHROPIC_PROFILE` per spawn) is
   necessary but not sufficient for *implicit* profiles when no claude.ai login exists in
   the session's config dir; SI-2's doctor script should adopt preflight check P2
   (existence of `~/.config/anthropic`) as a standing WARN.
2. `ANTHROPIC_CONFIG_DIR` joins the env-hygiene strip list alongside `ANTHROPIC_PROFILE`
   (it relocates the profile store wholesale).

## What remains for live-host (T3) confirmation

1. The owner-run 10-minute experiment above (browser OAuth against a real Max identity —
   the only step this spike could not perform headlessly).
2. Re-run `ant-preflight.ts` in the owner's interactive shell (the harness shell's
   `ANTHROPIC_API_KEY` BLOCK may or may not apply there).
3. On every certified Claude Code version bump: re-grep for the profile-resolution strings
   (preflight P3 does this) — if profile precedence changes, the env-scrub list needs
   re-verification (SI-2 version gate).

---

# Part 2 — Spike (ix): sidecar signing dry run

## Question

The v0 ship is a Tauri app with `aibender-core` as an `externalBin` sidecar (blueprint §2,
§8). Locally-built personal use needs no notarization, but the *"sidecar-signing gotcha"*
(tauri-apps/tauri#11992) is the named risk for shared builds, and M6's DoD requires a
*"signed (dry-run) Tauri v0 sidecar build"*. What exactly does codesign enforce for a
sidecar inside a `.app` bundle — signing order, tamper/replacement behavior, hardened
runtime + entitlements — and what is the real Developer-ID path plus its gotchas?

## Method

`spikes/signing-ant/signing-dryrun.ts` (no dependencies, Node + system toolchain): compiles
two stub C binaries with clang (a "main app" and a "sidecar", 33,464 / 33,440 bytes), lays
them out exactly as `tauri build` lays out an externalBin —
`AibenderSpike.app/Contents/MacOS/aibender-core-stub-aarch64-apple-darwin` (Tauri's
`<name>-<target-triple>` renaming convention) — then runs 28 recorded codesign/spctl steps
covering positive, negative, and edge scenarios. All signing is **ad-hoc** (`-s -`): no
Apple account, no keychain writes, no notarization. Full measured log:
`spikes/signing-ant/out/results.json` (gitignored).

**Headless limitations (explicit):**

- **No Developer ID identity exists on this machine** (measured: `security find-identity -v
  -p codesigning` → `0 valid identities found`). The Developer-ID/notarization path is
  documented from primary sources, not executed.
- **No Gatekeeper first-launch UX**: locally-built binaries never receive the quarantine
  xattr, so the user-facing Gatekeeper flow is out of headless reach; `spctl --assess` is
  recorded as the proxy.
- Stub C binaries stand in for the real Node/Bun-compiled `aibender-core` (a real Node
  runtime binary is much larger and JIT-dependent — covered by the S7 entitlements scenario
  and listed as a T3 item).

## Result (measured, macOS 26.6 / Xcode 26 codesign)

| # | Scenario | Measured outcome |
|---|---|---|
| S6 | Sign the **outer app first** while the sidecar is unsigned | **codesign refuses**, exit 1: `code object is not signed at all / In subcomponent: …aibender-core-stub-aarch64-apple-darwin` → inside-out order is *enforced by the tool*, not just convention |
| S1 | Inside-out ad-hoc sign (sidecar → app), then `--verify --deep --strict` | **passes**; each sign step 7–10 ms, verify 6–7 ms |
| S2 | `codesign -dv --verbose=4` details | app: `Signature=adhoc`, `CodeDirectory v=20400 flags=0x2(adhoc)`, identifier `dev.aibender.spike.signing`; sidecar likewise with its own identifier |
| S3 | `spctl --assess --type exec` on the ad-hoc app | **`rejected`, exit 3** (expected: ad-hoc is never notarized). Irrelevant for v0 personal use — local builds carry no quarantine bit, so Gatekeeper never assesses them |
| S4 | Byte-append tamper of the signed sidecar | bundle deep-strict verify **fails** (`main executable failed strict validation / In subcomponent: …`); sidecar's own verify fails; **bonus finding: codesign refuses to re-sign the byte-appended Mach-O** (`main executable failed strict validation` at *signing* time) — a corrupted binary is not healable in place, it must be replaced by a valid build |
| S5 | **Replace** the sidecar with a freshly built, freshly ad-hoc-signed variant (the realistic "sidecar updated after the app was signed" case — the tauri#11992 gotcha class) | sidecar verifies fine on its own, but bundle verify **fails**: `file modified: …aibender-core-stub… / nested code is modified or invalid` — the outer seal pins the sidecar's cdhash. Healing = re-sign the outer app → deep-strict verify **passes** again |
| S7 | Hardened runtime + JIT entitlements on the sidecar (`--options runtime`, `com.apple.security.cs.allow-jit` + `allow-unsigned-executable-memory` — what a Node/Bun sidecar needs under notarization) | signs fine even ad-hoc: `flags=0x10002(adhoc,runtime)`, entitlements dump shows both keys; after re-signing the outer app, final deep-strict verify **passes** |
| S8 | Codesigning identities present | `0 valid identities found` — Developer-ID path is owner/T3 material |

28/28 recorded steps matched their expected invariants (exit 0 from the harness).

### The real Developer-ID path for shared builds (documented, not executed)

1. **Cert:** "Developer ID Application" certificate (paid Apple Developer account).
   `tauri build` signs when `APPLE_SIGNING_IDENTITY` (or `APPLE_CERTIFICATE` +
   `APPLE_CERTIFICATE_PASSWORD` in CI) is set; notarization runs with `APPLE_API_ISSUER` +
   `APPLE_API_KEY`(+`_PATH`), or `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`; then
   stapling (`--skip-stapling` exists for split pipelines).
2. **Notarization adds requirements ad-hoc doesn't have:** hardened runtime on *every*
   Mach-O including the sidecar (`bundle.macOS.hardenedRuntime: true` and/or explicit
   `--options runtime`), a secure timestamp (drop `--timestamp=none`), and JIT entitlements
   for a Node/Bun sidecar (S7 proved the mechanics).
3. **Gotchas, in the order they will bite:**
   - **tauri#11992** ("MacOS - Codesigning and notarization issue when using ExternalBin")
     is still open as of 2026-07: minimal repros notarize fine *without* `externalBin` and
     fail *with* it — Apple's service reports `The signature of the binary is invalid`
     (arm64). **Mitigation if hit:** stop trusting tauri-cli's automatic flow for the
     sidecar; post-build script re-signs inside-out — sidecar first with Developer ID +
     `--options runtime` + entitlements + timestamp, then the app — then submit to
     notarytool directly. This is exactly the S5 heal sequence with a real identity.
   - **Ordering is enforced** (S6): any pipeline that signs the app before the sidecar
     exists/is signed fails immediately.
   - **Any sidecar touch after the outer signature invalidates the bundle** (S5): CI must
     treat "re-sign sidecar ⇒ re-sign app" as an atomic pair.
   - **Do not use `--deep` for signing** (deprecated for distribution; hides per-binary
     entitlement/flag mistakes) — sign each Mach-O explicitly; `--deep` remains fine for
     *verification*.
   - **Sign the renamed artifact**: Tauri renames externalBin to `<name>-<target-triple>`
     inside `Contents/MacOS/` — signing the pre-copy source binary and letting Tauri copy
     it is fragile if anything rewrites it later (S5 again).

## Confidence

- **High** for the ad-hoc/v0 conclusions — directly measured on this host's toolchain
  (macOS 26.6, Xcode 26 codesign), deterministic, re-runnable in ~1 s.
- **Medium** for the shared-build path — documented from Tauri docs + the live issue
  tracker, but not executed (no Developer ID identity headlessly, by design).

## Verdict — **GO for v0 (ad-hoc sidecar signing works); shared-build path documented with named fallback**

The v0 posture in the blueprint (*"Locally-built personal use needs no notarization"*) is
confirmed and now has a measured procedure: inside-out ad-hoc signing of the sidecar-bearing
bundle verifies deep+strict, survives the tamper/replace edge cases with known heal steps,
and hardened-runtime + JIT entitlements are mechanically ready for the day notarization is
needed. SI-6's "sidecar signing dry-run automation (spike ix follow-on)" can wrap
`signing-dryrun.ts`'s sequence around the real `tauri build` output essentially unchanged.

**Go/fallback consequence (as the plan names it):** the sidecar-signing gotcha for shared
builds is real and still open (tauri#11992); if it fires during a future notarized build,
the fallback is the documented manual post-build sign-and-notarize script (S5 heal sequence
with a Developer ID identity) — and until then, shared builds simply aren't attempted; v0
remains personal/local ad-hoc, which this spike proved out end to end.

## What remains for live-host (T3) confirmation

1. Run the same sequence against the **real** `tauri build` output with the actual
   Node/Bun-compiled `aibender-core` sidecar (M6 DoD: signed dry-run build launches on a
   clean macOS user account — quarantine-free local launch expected to work per S1/S3
   reasoning).
2. The Developer-ID + notarytool end-to-end (requires the owner's Apple Developer
   credentials — external mutation, HARD-GATED to the owner).
3. Re-check tauri#11992 status against the then-current tauri-cli before any shared build.

---

## Sources

- ant CLI quickstart — https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart
- ant CLI authentication options — https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication
- WIF reference (profile schema, credential precedence, config dir) — https://platform.claude.com/docs/en/manage-claude/wif-reference
- Claude Code authentication (precedence chain, setup-token) — https://code.claude.com/docs/en/authentication
- anthropic-cli releases (v1.16.0, 2026-07-02) — https://github.com/anthropics/anthropic-cli/releases
- tauri#11992 externalBin notarization bug — https://github.com/tauri-apps/tauri/issues/11992
- Tauri v2 macOS signing docs — https://v2.tauri.app/distribute/sign/macos/
- Tauri sidecar/externalBin docs — https://v2.tauri.app/develop/sidecar/
- Findings baseline: `docs/research/findings/x1-parallel-multi-account.md` §(g), open question 1; `docs/research/findings/frontend-app-shell-stack.md` (sidecar-signing gotcha)
