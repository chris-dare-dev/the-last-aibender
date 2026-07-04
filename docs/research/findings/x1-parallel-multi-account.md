# X1 — Parallel Multi-Account Claude Code Sessions (MAX_A, MAX_B, ENT)

> Stage-1 discovery research record for **the-last-aibender**. Research date: 2026-07-03.
> Machine ground truth verified against Claude Code **v2.1.193** (Homebrew standalone binary) and
> v2.1.197 (Claude Desktop-managed install) on macOS 26.6 / Apple Silicon.
> Account placeholders used throughout per repo policy: **MAX_A**, **MAX_B** (Claude Max), **ENT** (Claude Enterprise).
> No real emails, org UUIDs, tokens, or key material appear in this document.

---

## TL;DR

1. Claude Code on macOS stores subscription OAuth credentials in the **login Keychain**, service name `Claude Code-credentials`, account attribute = `$USER`.
2. **Since ~2.1.x, the Keychain entry IS scoped per config dir**: with `CLAUDE_CONFIG_DIR` set, the service becomes `Claude Code-credentials-<first 8 hex of sha256(configDir)>` — verified in the shipping binary AND by a live suffixed entry in this machine's keychain.
3. Therefore **mechanism (a) — one `CLAUDE_CONFIG_DIR` per account — gives true parallel multi-account with zero logout/login cycling**, entirely with documented env vars. This is the primary recommendation.
4. A newer env var `CLAUDE_SECURESTORAGE_CONFIG_DIR` decouples the *credential store* from the *config dir* — many session config dirs can share one per-account credential store. Use it to pin stores explicitly.
5. OAuth refresh tokens are **single-use / rotating**; historically concurrent sessions sharing one store raced and dead-ended at 401 (issues #24317, #27933, #25609, #48786…). Current builds serialize refresh with an `.oauth_refresh.lock` + re-read-before-refresh; fixes landed across 2.1.0→2.1.136. Races are per-*store*: separate per-account stores never race with each other.
6. **Never let one account's credentials exist in two stores** (no copying, no hot-swapping keychain blobs) — rotation invalidates the sibling copy. Keychain-swap "account switchers" are rejected for this reason plus a 30 s in-process keychain cache.
7. `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` works for Max/Enterprise subscription auth, per-process, non-interactively (1-year static token, no rotation → no races), but has a known destructive bug (#37512: keychain entry deletion on exit) — contain it inside a per-account config dir.
8. Containers (Colima/docker/k3s) get the documented Linux file fallback `$CLAUDE_CONFIG_DIR/.credentials.json` (0600) — reliable and legitimate; login once per container volume; pair with `.claude.json` persistence or it re-onboards.
9. ToS: consumer terms prohibit *sharing* an account; they do **not** prohibit one person owning multiple paid accounts. Aug-2025 weekly limits target sharing/reselling/24-7 patterns. Keep each account self-owned, separately paid, and moderately concurrent; ENT usage is governed by the org's commercial terms and is admin-visible.
10. Fallback ladder (capability beats efficiency): **(1) per-account CLAUDE_CONFIG_DIR (+ pinned SECURESTORAGE dir) → (2) + setup-token env injection for headless workers → (3) Linux container per account (file creds) → (4) separate macOS user accounts → (5) ant-CLI profiles (watch; not yet proven for Max)**.

---

## Current landscape

### Where credentials actually live (verified on this machine + docs)

Official docs ([code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication)):

- **macOS**: "credentials are stored in the encrypted macOS Keychain."
- **Linux**: `~/.claude/.credentials.json`, mode `0600`.
- **Windows**: `%USERPROFILE%\.claude\.credentials.json`.
- "If you've set the `CLAUDE_CONFIG_DIR` environment variable on Linux or Windows, the `.credentials.json` file lives under that directory instead." (The macOS keychain-scoping behavior below is **not documented** — it was recovered from the binary and community sources.)

**Keychain naming — recovered from the v2.1.193 binary** (de-minified; the load-bearing logic):

```js
// service-name derivation (de-minified from the shipping binary)
function keychainServiceName(suffix /* "-credentials" */) {
  const ss = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const isDefault = ss !== undefined ? !ss : !process.env.CLAUDE_CONFIG_DIR;
  const dir = ss !== undefined ? ss.normalize("NFC") : resolvedConfigDir(); // CLAUDE_CONFIG_DIR or ~/.claude
  const hash = isDefault ? "" : "-" + sha256(dir).hex().substring(0, 8);
  return `Claude Code${OAUTH_FILE_SUFFIX}${suffix}${hash}`;   // OAUTH_FILE_SUFFIX = "" in prod builds
}
// account attribute for the keychain item:
//   process.env.USER || os.userInfo().username || "claude-code-user"
```

Consequences, all verified or directly derivable:

- Default state (no env vars): service `Claude Code-credentials`, account `$USER`, in the **login keychain**. Present on this machine.
- With `CLAUDE_CONFIG_DIR=/path/x`: service `Claude Code-credentials-<sha256("/path/x")[0:8]>`. A live suffixed entry (`Claude Code-credentials-fa8f5471`, created 2026-05-12) exists on this machine from an earlier non-default config-dir usage — empirical proof the suffixing ships and persists.
- **The hash is over the raw NFC-normalized string** — `~/.claude`, `/Users/<u>/.claude`, and a trailing-slash variant hash to *different* entries. The harness must pass byte-identical absolute paths every launch or the account silently "logs out" (actually: looks at a different, empty keychain slot).
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` (undocumented, present in 2.1.x): overrides *only* where credentials live. Empty string = force the default store. It is deliberately **forwarded to child sessions** (visible in the binary's env-forwarding lists) — this is how Claude Desktop gives per-session config dirs a *shared* login. Exactly the primitive a multi-session harness wants.
- Reads shell out to `/usr/bin/security find-generic-password -a "$USER" -w -s "<service>"` with a 2 s timeout and a **30-second in-process cache** (`cachedAt < 30000`). Writes/deletes use `add-generic-password`/`delete-generic-password`.
- A file-based fallback/companion exists even on macOS: `<securestorage-dir>/.credentials.json`; the binary watches its **mtime** and reloads credentials when it changes. One code path writes the file with `claudeAiOauth.refreshToken` **stripped** (access token only) — i.e. file copies on macOS may intentionally omit the refresh token.
- `~/.claude.json` (top-level, *outside* `~/.claude`) holds `oauthAccount` metadata (account UUID, org UUID, email, subscription type), onboarding state, and a `machineID`. With `CLAUDE_CONFIG_DIR` set, this file relocates into the config dir — each account dir gets its own identity metadata.
- `claude auth status --json` (new `claude auth` command group: `login|logout|status`) reports `loggedIn`, `authMethod` (`claude.ai`), `apiProvider`, `email`, `orgId`, `subscriptionType` (`max`) — a ready-made per-account health probe for the harness. `claude auth login` accepts `--claudeai` (default) / `--console` / `--email <prefill>` / `--sso`.

### Auth precedence chain (docs, current)

1. Cloud provider (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`); 2. `ANTHROPIC_AUTH_TOKEN`; 3. `ANTHROPIC_API_KEY`; 4. `apiKeyHelper` script (re-called after 5 min TTL or on 401; `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` tunes it); 5. `CLAUDE_CODE_OAUTH_TOKEN`; 6. subscription OAuth from `/login` (keychain/file). A signed-in Claude-apps-gateway session outranks all. `--bare` mode reads **only** `ANTHROPIC_API_KEY`/`apiKeyHelper` (never keychain, never `CLAUDE_CODE_OAUTH_TOKEN`).

A leaked `ANTHROPIC_API_KEY` in the environment silently outranks subscription auth — this session's own environment demonstrates the hazard (a desktop-injected `ANTHROPIC_API_KEY` coexisting with a Max login). The harness must sanitize provider env vars per spawned process.

### How we got here — the 2025→2026 history

- **Early–mid 2025 (≤ v1.0.x)**: credentials were a plain `~/.claude/.credentials.json` everywhere. `CLAUDE_CONFIG_DIR` respected "everywhere" from v1.0.6 (changelog). Multi-account was trivially file-scoped — and trivially racy.
- **Mid 2025**: macOS migrated to Keychain storage. Migration deleted/broke the file that Linux containers bind-mounted from the same home ([#10039](https://github.com/anthropics/claude-code/issues/10039)). SSH sessions to Macs broke because the Security framework needs a GUI session to unlock the login keychain ([#44089](https://github.com/anthropics/claude-code/issues/44089), [#9403](https://github.com/anthropics/claude-code/issues/9403) — v2.0.14 even wrote to `Claude Code-credentials` but read `Claude Code`).
- **Throughout 2025-2026, Anthropic declined to ship first-class multi-account switching** in Claude Code. Open/declined feature requests: [#20549](https://github.com/anthropics/claude-code/issues/20549), [#24963](https://github.com/anthropics/claude-code/issues/24963), [#35856](https://github.com/anthropics/claude-code/issues/35856), [#37554](https://github.com/anthropics/claude-code/issues/37554), [#44687](https://github.com/anthropics/claude-code/issues/44687), [#36151](https://github.com/anthropics/claude-code/issues/36151) (mobile). #20549 documents that programmatic keychain-blob swapping is *not* picked up by running sessions — explained by the 30 s in-process cache plus in-memory token state.
- **Quietly, in the 2.1.x line**, the per-config-dir keychain hash suffix appeared (no changelog entry found; community documentation of the sha256 derivation dates to ~April 2026: [KMJ-007 gist](https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2), [claude-profile blog](https://blog.wiredgeek.net/tools/claude-code/2026/04/06/managing-multiple-claude-code-profiles.html)). This flipped `CLAUDE_CONFIG_DIR` from "config-only isolation, shared keychain" to **full auth isolation on macOS**.
- **Refresh-race saga** (details next section): reported repeatedly from 2.1.37 onward, fixed incrementally: 2.1.0 (stale keychain-cache reads during concurrent refresh), 2.1.118 (MCP-refresh overwriting fresh OAuth token; `/login` no-op under `CLAUDE_CODE_OAUTH_TOKEN`), 2.1.126 (concurrent write clearing a valid refresh token), 2.1.133 ("parallel sessions all dead-ending at 401 after a refresh-token race wiped shared credentials"), 2.1.136 (login loop from concurrent credential write overwriting a freshly-rotated token). ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md))
- **2026: the `ant` CLI (anthropics/anthropic-cli) shipped first-class *profiles***: `ant auth login --profile <name>`, `ant profile activate`, `ANTHROPIC_PROFILE` env var; state under `~/.config/anthropic/` (`configs/<profile>.json`, `credentials/<profile>.json`, `active_config`). The Claude Code binary contains the matching resolution logic (profile types `user_oauth` / `oidc_federation`; explicit warning string: *"An Anthropic profile (~/.config/anthropic) is configured, but a claude.ai login exists — using the claude.ai login. Set ANTHROPIC_PROFILE=<name> to use the profile instead."*). Whether a **Max subscription** (vs Console org) can back a `user_oauth` profile is unverified — see Open questions.

### OAuth refresh semantics and the race, precisely

- Subscription OAuth uses **rotating, single-use refresh tokens** ([#24317](https://github.com/anthropics/claude-code/issues/24317)): refreshing returns a new access+refresh pair and invalidates the old refresh token server-side. Access tokens live ~8 h (community-observed).
- Failure mode with N processes sharing one store: A refreshes and persists the new pair; B still holds the old pair in memory → B's API call 401s → B tries to refresh with the *invalidated* token → 400/403 → B (historically) nuked or overwrote the shared store → **every** session dead-ends at "Please run /login". Reported as [#24317](https://github.com/anthropics/claude-code/issues/24317), [#27933](https://github.com/anthropics/claude-code/issues/27933), [#25609](https://github.com/anthropics/claude-code/issues/25609), [#43392](https://github.com/anthropics/claude-code/issues/43392), [#48786](https://github.com/anthropics/claude-code/issues/48786), [#54443](https://github.com/anthropics/claude-code/issues/54443), [#56339](https://github.com/anthropics/claude-code/issues/56339).
- **Current builds mitigate within one store**: the binary contains a proper-lockfile-style flow — acquire `.oauth_refresh.lock` (ELOCKED → up to 5 retries with 1–2 s jitter → `lock_timeout`), then **re-read the store**; if the access token changed since (`tengu_oauth_token_refresh_race_resolved`) return "refreshed" without a network call; only the lock-holder performs the rotation. The `.credentials.json` mtime-watcher propagates external refreshes into running sessions.
- **What locking cannot fix**: two *different stores* holding the same account's tokens (e.g., a copied `.credentials.json` in a container plus the host keychain). Each store refreshes independently; the first rotation invalidates the other store's refresh token. **Rule: one account = exactly one live credential store**, shared by all of that account's sessions on that host.
- Cross-account: zero interaction. MAX_A's store and MAX_B's store rotate independently against different accounts. The race problem is intra-account only.

### Community/ecosystem state

Multi-account tooling is a cottage industry, which confirms both demand and viability: [claude-profile](https://blog.wiredgeek.net/tools/claude-code/2026/04/06/managing-multiple-claude-code-profiles.html) (per-config-dir profiles), [claude-swap](https://github.com/realiti4/claude-swap), a [keychain-swap switcher gist](https://gist.github.com/fortunto2/b326e4727e32f9af1742f0710dcc5f75) (fragile — see rejected options), [AgentsRoom](https://agentsroom.dev/features/claude-multi-account) (per-project/per-agent accounts), plus recipes on [Medium](https://medium.com/@buwanekasumanasekara/setting-up-multiple-claude-code-accounts-on-your-local-machine-f8769a36d1b1), [dev.to](https://dev.to/ashishxcode/claude-code-multi-account-setup-without-losing-context-49nf), [emilwu.tw](https://emilwu.tw/en/resources/multi-account/), [madewithlove](https://madewithlove.com/blog/running-multiple-claude-accounts-without-logging-out/). Third parties even reuse Claude Code's credential store from other tools ([opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth)) — relevant later for the harness's OpenCode integration, and a reminder that whatever store we choose is readable by our own tooling too.

---

## Options considered

### (a) Separate `CLAUDE_CONFIG_DIR` per account — **primary**

**How it works.** One directory per account, e.g. `~/.claude-accounts/max-a`, `~/.claude-accounts/max-b`, `~/.claude-accounts/ent` (names are local-only; never in the repo). Every process launched for that account gets `CLAUDE_CONFIG_DIR=<abs path>` in its environment. On macOS each dir maps to its own keychain service (`Claude Code-credentials-<hash8>`); each dir contains its own `settings.json`, `.claude.json` (identity/onboarding), projects/transcripts, `history.jsonl`. One interactive `claude /login` (or `claude auth login --email <account-email>`) per dir, once; thereafter all sessions for all accounts run concurrently with no login churn.

```bash
# illustrative launcher shape (harness generates env, never hardcodes identities)
CLAUDE_CONFIG_DIR="$ACCOUNT_DIR" \
CLAUDE_SECURESTORAGE_CONFIG_DIR="$ACCOUNT_DIR" \
claude -p "..." --output-format stream-json
```

**Pros.** Fully parallel; no logout/login; uses only product-supported env vars; per-account usage telemetry, transcripts, settings cleanly separated (a gift for the harness's observability panel); refresh races impossible *across* accounts and lock-mitigated *within* one; keychain encryption retained; survives Claude Code updates.

**Cons.** The keychain suffixing is **undocumented** — Anthropic could change the derivation (they already changed storage location once in 2025); path-string sensitivity (byte-identical env values required); config duplication (plugins, settings must be synced per dir if you want parity); `~/.claude.json`-adjacent global caches are per-dir (some duplicated state).

**Risks.** Regression risk on the undocumented behavior (mitigate: pin/gate Claude Code versions in the harness; add a startup self-check that computes the expected service name and confirms the keychain item exists — `security find-generic-password -s <svc>` *without* `-w`); keychain ACL breakage after binary auto-updates ([#19456](https://github.com/anthropics/claude-code/issues/19456)) can force re-auth prompts — mitigate by standardizing on one install channel (Homebrew) and expecting occasional one-click keychain approvals.

### (a′) `CLAUDE_SECURESTORAGE_CONFIG_DIR` pinning — hardening layer on (a)

**How it works.** Set `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the account dir explicitly, independent of `CLAUDE_CONFIG_DIR`. Two payoffs: (1) the credential-store identity no longer depends on which config dir a session uses — the harness can give **each workstream its own config dir** (isolated settings/history) while all of a given account's workstreams share that account's single credential store (exactly the pattern Claude Desktop itself uses — the var is forwarded to child sessions); (2) it makes the store location explicit and auditable.

**Pros.** Decouples "session identity" from "account identity" — this is the architectural seam the-last-aibender's workstreams [X4] want. Prevents accidental store-forks when config dirs are created per session.
**Cons/Risks.** Even less documented than the config-dir suffix; verify per release (cheap: the self-check above).

### (b) Separate `HOME` per process

**How it works.** Spawn with `HOME=/path/fakehome-max-b`. `os.homedir()` follows `$HOME`, so the default config dir becomes `$HOME/.claude`.

**Analysis.** On macOS this is **strictly worse than (a)**: with `CLAUDE_CONFIG_DIR` unset, the no-suffix branch is taken → service stays `Claude Code-credentials` and the account attribute stays `$USER` → **both HOMEs collide on the same keychain item**. The macOS Security framework locates the login keychain via the real user record, not `$HOME`, so you don't even get a separate keychain. You'd have to *also* fake `USER` (which changes the keychain `acct` attribute — an accidental, fragile isolation) and would break every other tool reading `$HOME`. On Linux/containers, `HOME` isolation ≈ file isolation and works, but `CLAUDE_CONFIG_DIR` does the same thing with less collateral damage.
**Verdict.** Rejected on macOS; redundant elsewhere.

### (c) Separate macOS user accounts

**How it works.** Create `max-b`, `ent` macOS users; each gets its own login keychain, `~/.claude`, everything. Run sessions via `su`/`sudo -u`/SSH-to-localhost or fast user switching.

**Pros.** Strongest OS-level isolation; zero shared state; immune to every cross-account bug class; trivially legitimate.
**Cons.** Heavy: per-user app installs/updates, file-sharing friction with the primary user's workspaces (the whole point of the harness is workspace-scoped pipelines), notarization/permissions prompts per user.
**Risks.** The killer: **keychain unlock requires a GUI login session**. Launching via `sudo -u`/SSH hits the locked-keychain wall ([#44089](https://github.com/anthropics/claude-code/issues/44089)); `security unlock-keychain` needs the user's password in plaintext-adjacent handling — its own secret-hygiene problem. Workable only with all users GUI-logged-in via fast user switching (RAM cost on a 36 GB machine running LM Studio models). **Position: last-resort fallback.**

### (d) Linux containers (Docker/Colima, later k3s) — file-based credentials

**How it works.** Inside Linux, Claude Code uses `$CLAUDE_CONFIG_DIR/.credentials.json` (0600) — no keychain exists, and the fallback is not a hack: it's the documented Linux behavior and the basis of Anthropic's own [devcontainer reference](https://code.claude.com/docs/en/devcontainer). Per account: one image + one persistent volume holding the config dir; run `claude /login` once inside (paste-code flow works headless); token refresh rewrites the file in-volume. Community-verified persistence recipes note you must persist **both** `.credentials.json` and a minimal `.claude.json` (else onboarding re-triggers) ([eke.li](https://www.eke.li/vscode/2026/03/14/persist-claude-across-rebuilds.html), [field-notes](https://github.com/tfvchow/field-notes-public/issues/10)).

**Pros.** Reliable and legitimate; perfect isolation per container; no keychain at all; maps directly onto the conditional Colima+k3s adoption [X3] (credentials become SOPS-encrypted k8s secrets seeding a PVC, or just PVC state); horizontal scale for multi-agent workflows.
**Cons.** Resource overhead per the Colima VM; macOS-host integration friction (mounting workspaces, git identities); **LM Studio reachability** must cross the VM boundary (Colima: host reachable at `192.168.5.2` / `host.lima.internal`; k3s adds another hop) — [X3] says if this breaks, fall back host-native; slower cold starts.
**Risks.** Same-account **dual-store hazard** if the host also stays logged into that account: the container's copy and the host's copy rotate independently → mutual invalidation ([#10039](https://github.com/anthropics/claude-code/issues/10039) is the historical cross-boundary mess). Rule: an account lives EITHER on the host OR in a container store, never both. Also mind image/versions drift vs. the host binary.

### (e) One tty/tmux pane per account

**How it works (and why it doesn't).** A terminal/tmux pane is not a credential boundary — Claude Code scopes credentials by store (keychain service / file path), never by tty. Panes only matter as **env-var carriers**: a pane that exports `CLAUDE_CONFIG_DIR=<max-b dir>` is just mechanism (a) with manual ergonomics.
**Verdict.** Not an isolation mechanism; keep as a UX layer (the harness's session manager will do env injection programmatically anyway; tmux is useful for attach/observe).

### (f) `claude setup-token` + `CLAUDE_CODE_OAUTH_TOKEN` per process

**How it works.** `claude setup-token` (run once per account, interactive browser OAuth) prints a **1-year** OAuth token (`sk-ant-oat01-…`) that is *not stored anywhere* by the CLI; you export it as `CLAUDE_CODE_OAUTH_TOKEN` per process. Docs: works for **Pro/Max/Team/Enterprise** subscription auth, designed for CI/non-interactive use; scoped to inference only (no Remote Control); sits at precedence #5 (above stored login, below API keys/apiKeyHelper). Static token → no rotation → **no refresh races at all**.

**Pros.** Perfect per-process account selection with a single env var; non-interactive; deterministic (no keychain, no browser at runtime); ideal for burst-parallel headless workers and for the harness's "launch one-off prompt against account X" feature; officially documented.
**Cons.** Annual manual re-mint per account; the token is a **bearer secret the harness must store itself** (macOS Keychain custom item or SOPS — never the repo [X2]); counts against the same subscription limits; `--bare` ignores it; interactive `/login` interplay had bugs (fixed 2.1.117/2.1.118).
**Risks.** **[#37512](https://github.com/anthropics/claude-code/issues/37512)** (closed "not planned", reported v2.1.81): with `CLAUDE_CODE_OAUTH_TOKEN` set, exit-time cleanup can **silently delete the default keychain entry**, killing every other session's auth. Mitigation that fully contains it: never run env-token processes against the default store — always pair the token with that account's `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR` so any destructive write hits the account's own (or a scratch) store. Re-test per release.

### (g) `ant` CLI profiles / `ANTHROPIC_PROFILE` — emerging, watch closely

**How it works.** The official Anthropic CLI ([anthropics/anthropic-cli](https://github.com/anthropics/anthropic-cli/releases)) manages named profiles under `~/.config/anthropic/` (`configs/<name>.json`, `credentials/<name>.json`, `active_config`); `ANTHROPIC_PROFILE=<name>` selects per process; **Claude Code and the Agent SDK honor the same resolution** (confirmed in the binary; claude.ai `/login` currently outranks an *implicit* profile, explicit `ANTHROPIC_PROFILE` wins). File-based per-profile credentials on all platforms — architecturally exactly what multi-account needs, from Anthropic themselves.
**Pros.** First-class, supported, file-based, per-process selection; would collapse this whole problem.
**Cons/Risks.** Profiles appear **Console/org-oriented** (`user_oauth` bound to org+workspace, `oidc_federation` for WIF); it is **unverified whether a Max subscription can back a profile**; refresh tokens "hard-expire — re-run `ant auth login`" (per bundled docs); a set `ANTHROPIC_API_KEY` silently outranks profiles. **Verdict: not rung-1 today; run the verification experiment (Open questions) and promote if Max-compatible.**

### (h) Keychain hot-swap switchers — rejected

Swap the `Claude Code-credentials` blob per account before launch ([fortunto2 gist](https://gist.github.com/fortunto2/b326e4727e32f9af1742f0710dcc5f75), [claude-swap](https://github.com/realiti4/claude-swap)). Fails the parallelism requirement by construction (one active identity at a time), fights the 30 s keychain cache ([#20549](https://github.com/anthropics/claude-code/issues/20549): running sessions don't pick up swaps), and every swap of a stale blob after a rotation logs the account out. Superseded entirely by (a).

---

## ToS / legitimacy assessment (multiple self-owned accounts)

Primary sources: [Consumer Terms](https://www.anthropic.com/legal/consumer-terms); weekly-limits coverage ([TechCrunch](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/), [Anthropic on X](https://x.com/AnthropicAI/status/1949898502688903593), [mlq.ai](https://mlq.ai/news/anthropic-implements-weekly-rate-limits-on-claude-code-to-curb-heavy-usage/)); [Help Center: Claude + Console account](https://support.claude.com/en/articles/8987223-can-i-have-a-claude-account-and-a-console-account), [Account management FAQs](https://support.claude.com/en/articles/13325567-account-management-faqs).

- The Consumer Terms contain **no one-account-per-person clause**. They prohibit **sharing**: "You may not share your Account login information… with anyone else" / "You also may not make your Account available to anyone else." All three accounts here are used by their owner — compliant.
- Automated access is prohibited "**except… where we otherwise explicitly permit it**" — Claude Code, the Agent SDK, `setup-token` for CI, and headless `-p` are Anthropic's own explicitly-shipped automation surfaces. Using them under each account's own login is permitted use, not circumvention.
- The **Aug 28 2025 weekly rate limits** were introduced explicitly against "account sharing, reselling, and 24/7 background usage." One person paying for two Max plans and one Enterprise seat is none of those; each account's weekly quota is what was paid for. Residual risk is **heuristic misclassification** (same machine/IP running multiple accounts concurrently can resemble sharing patterns). Keep usage patterns humane: don't run all accounts 24/7 flat-out; keep per-account concurrency moderate; never resell or share output access.
- **ENT** is under the org's Commercial Terms and admin policies: usage is visible to org admins; managed settings may be pushed (`managed-settings.json`, `forceLoginOrgUUID`); Enterprise Compliance API can log usage. Treat ENT as "employer's account, employer's rules" — the harness should tag ENT sessions and respect any pushed policy; don't route personal work through it.
- Mechanism legitimacy ranking: (a)/(a′)/(f)/(d) use documented product features (env vars, setup-token, Linux file storage) — clean. (c) is OS-level, trivially clean. (h) manipulates Anthropic's credential store out-of-band — gray, and rejected anyway. Nothing here involves scraping, client spoofing, or limit evasion.
- Rate limits are **per account**; using MAX_A and MAX_B in parallel doesn't "evade" either one's limits — it consumes two paid quotas. (Anthropic's Help Center confirms same-email multi-org identities are supported constructs.)

---

## Recommendation (opinionated)

**Adopt a per-account credential-store architecture with env-injected process spawning. Priority rule in force: if any resource-efficiency concern conflicts with parallel multi-account capability, capability wins.**

### The fallback ladder (most → least robust; each rung is the fallback of the one above)

| Rung | Mechanism | Use for | Why this rank |
|---|---|---|---|
| **1** | Per-account `CLAUDE_CONFIG_DIR` + pinned `CLAUDE_SECURESTORAGE_CONFIG_DIR` (options a + a′) | All interactive + SDK sessions for MAX_A, MAX_B, ENT on the host | True parallelism, product-native, keychain-encrypted, race-free across accounts, lock-protected within an account |
| **2** | Rung 1 **plus** `CLAUDE_CODE_OAUTH_TOKEN` (setup-token) injected per process (option f) | Headless/burst workers, CI-like pipeline steps, deterministic account pinning | Static token kills residual refresh-race risk entirely; contained inside the account's own store dir to neutralize #37512 |
| **3** | Linux container per account (Colima → k3s) with volume-persisted `.credentials.json` (option d) | Scale-out multi-agent workflows; the [X3] k3s future | Documented Linux behavior, perfect isolation; costs VM overhead and LM Studio reachability checks; never dual-home an account host+container |
| **4** | Separate macOS user accounts (option c) | Break-glass if Anthropic removes config-dir keychain scoping AND containers are unacceptable | Bulletproof isolation but GUI-session/keychain-unlock friction and RAM cost |
| **5 (watch)** | `ant` profiles / `ANTHROPIC_PROFILE` (option g) | Promote to rung 1 if/when Max-subscription profiles are confirmed | Official long-term answer; unproven for consumer Max auth today |

Rejected: (b) HOME-per-process (keychain collision on macOS), (e) tty-per-account (not an isolation mechanism), (h) keychain swappers (anti-parallel, racy).

### Non-negotiable operating rules

1. **One account ↔ exactly one live credential store per host.** Never copy tokens between stores; never log the same account into host + container simultaneously.
2. **Byte-stable paths.** The launcher passes identical absolute `CLAUDE_CONFIG_DIR` strings forever; the store dir names are machine-local and env-derived (public repo never contains them) [X2].
3. **Env hygiene per spawn.** Strip/scope `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `CLAUDE_CODE_USE_*` so precedence can't hijack account selection; consider `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` inside sessions.
4. **Version-gate Claude Code.** The keychain suffix is undocumented; pin the binary version the harness certifies, and run the keychain self-check (service-name recompute + `security find-generic-password` presence probe, never `-w`) on upgrade.
5. **setup-token secrets** live in the macOS Keychain under harness-owned item names (or SOPS when k3s arrives), with a yearly rotation reminder surfaced in the frontend.

---

## Implications for the harness

- **Account registry**: a small local (gitignored/env-driven) manifest mapping `MAX_A|MAX_B|ENT → {configDir, secureStorageDir, oauthTokenKeychainItem?, kind: max|enterprise}`. The public repo ships only the schema + `*.example` with placeholders [X2].
- **Session spawner**: every Claude session (one-off prompt, skill launch, multi-agent workflow step) is `spawn(claude, env = base ⊕ account.env ⊕ workstream.env)`. Workstreams [X4] get per-workstream `CLAUDE_CONFIG_DIR` **only if** `CLAUDE_SECURESTORAGE_CONFIG_DIR` stays pinned to the account store — otherwise workstream dirs fork credential stores (the exact failure mode to design out). If a certified Claude Code version ever drops `CLAUDE_SECURESTORAGE_CONFIG_DIR`, fall back to one config dir per account (workstream state then lives in harness-side metadata, not config-dir separation).
- **Login bootstrap UX**: first-run wizard shells `claude auth login --email <account-email>` per account dir (browser hop, once per account per machine, ~yearly thereafter). Detect logged-out stores via `claude auth status --json` (cheap, non-interactive) and badge the account red in the UI.
- **Observability tie-in**: per-account config dirs give per-account `projects/` JSONL transcripts, `usage-data/`, `history.jsonl` — the usage/cost panel can attribute tokens/sessions/skills per account for free. `auth status --json` supplies `subscriptionType`/org identity for labeling (display placeholders, not raw emails, anywhere that can be screen-shared).
- **Refresh-race posture**: within an account, rely on the built-in `.oauth_refresh.lock`; stagger mass-parallel worker starts by a few seconds around token-expiry boundaries; prefer rung-2 static tokens for >5-way same-account parallelism. Monitor for 401-cascades in stream-json output and auto-pause an account's queue on auth failure instead of letting N workers stampede the refresh endpoint.
- **#37512 containment**: headless workers using `CLAUDE_CODE_OAUTH_TOKEN` always run with that account's (or a scratch) config/securestorage dir; a canary test on each Claude Code upgrade verifies the default keychain entry survives an env-token process exit.
- **Keychain prompts**: GUI-launched harness inherits an unlocked login keychain; if the harness ever runs as a LaunchAgent/daemon or over SSH, keychain reads fail ([#44089](https://github.com/anthropics/claude-code/issues/44089)) — plan for rung 2 (env tokens) or rung 3 (containers) in those contexts.
- **k3s/Colima decision [X3]**: containers are rung 3, not rung 1 — adopt only for scale-out, and gate on an LM Studio reachability probe (`http://host.lima.internal:1234/v1/models` from inside the VM) before migrating any account store into a container.
- **OpenCode/Bedrock is orthogonal**: SigV4/API-key auth has no keychain/OAuth coupling; nothing in this ladder constrains it (AWS_DEV_ACCOUNT_ID stays in env/SSO config, never in-repo).

---

## Sources

**Official docs / Anthropic**
- https://code.claude.com/docs/en/authentication (credential storage, precedence, setup-token, apiKeyHelper)
- https://code.claude.com/docs/en/devcontainer (container reference)
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (race fixes 2.1.0–2.1.136; `claude auth` group; v1.0.6 CLAUDE_CONFIG_DIR)
- https://www.anthropic.com/legal/consumer-terms (account sharing / automated access language)
- https://x.com/AnthropicAI/status/1949898502688903593 (weekly limits announcement)
- https://support.claude.com/en/articles/8987223-can-i-have-a-claude-account-and-a-console-account
- https://support.claude.com/en/articles/13325567-account-management-faqs
- https://github.com/anthropics/anthropic-cli/releases (`ant` profiles)

**GitHub issues (anthropics/claude-code)**
- Refresh races: https://github.com/anthropics/claude-code/issues/24317 · /27933 · /25609 · /43392 · /48786 · /54443 · /56339
- Keychain behavior: /19456 (ACL after updates) · /10039 (mac deletes .credentials.json) · /9403 (v2.0.14 service-name mismatch) · /44089 (SSH keychain) · /37512 (OAUTH_TOKEN deletes keychain entry; closed not-planned) · /20549 (swap not picked up)
- Multi-account feature requests: /24963 · /35856 · /37554 · /44687 · /36151

**Community / ecosystem**
- https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2 (sha256 keychain derivation)
- https://blog.wiredgeek.net/tools/claude-code/2026/04/06/managing-multiple-claude-code-profiles.html (claude-profile)
- https://gist.github.com/fortunto2/b326e4727e32f9af1742f0710dcc5f75 (keychain swapper — rejected pattern)
- https://github.com/realiti4/claude-swap · https://agentsroom.dev/features/claude-multi-account
- https://medium.com/@buwanekasumanasekara/setting-up-multiple-claude-code-accounts-on-your-local-machine-f8769a36d1b1
- https://dev.to/ashishxcode/claude-code-multi-account-setup-without-losing-context-49nf
- https://emilwu.tw/en/resources/multi-account/ · https://madewithlove.com/blog/running-multiple-claude-accounts-without-logging-out/
- https://usagebar.com/blog/can-i-use-multiple-accounts-with-claude-code
- https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/data-anthropic-cli.md (`ant` profile internals)
- https://github.com/griffinmartin/opencode-claude-auth (third-party reuse of Claude Code creds)
- Container persistence: https://www.eke.li/vscode/2026/03/14/persist-claude-across-rebuilds.html · https://github.com/tfvchow/field-notes-public/issues/10 · https://www.solberg.is/claude-devcontainer · https://nakamasato.medium.com/using-claude-code-safely-with-dev-containers-b46b8fedbca9
- Policy/limits coverage: https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/ · https://mlq.ai/news/anthropic-implements-weekly-rate-limits-on-claude-code-to-curb-heavy-usage/ · https://apidog.com/blog/weekly-rate-limits-claude-pro-max-guide/
- OAuth-vs-API-key background: https://lalatenduswain.medium.com/claude-code-on-claude-max-plan-understanding-oauth-token-vs-api-key-authentication-in-2026-96a6213d2cde

**Local ground truth (this machine, read-only)**
- `claude --version` (2.1.193), `claude --help`, `claude setup-token --help`, `claude auth login|status --help`, `claude auth status --json`
- Keychain metadata via `security find-generic-password -s …` / `security dump-keychain` (no `-w`; values never read): both `Claude Code-credentials` and `Claude Code-credentials-fa8f5471` present
- String analysis of `/opt/homebrew/bin/claude`: service-name derivation, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `.oauth_refresh.lock`, 30 s keychain cache, refresh-race telemetry markers, `ANTHROPIC_PROFILE` resolution + warning strings

---

## Open questions

1. **Can a Claude Max subscription back an `ant` `user_oauth` profile?** If yes, `ANTHROPIC_PROFILE` becomes the sanctioned rung-1 replacement. Experiment (stage 2, non-destructive): `ant auth login --profile scratch-test` with a throwaway flow → inspect `~/.config/anthropic/credentials/` shape → `ANTHROPIC_PROFILE=scratch-test claude auth status --json`.
2. **Which exact 2.1.x version introduced the keychain hash suffix?** No changelog entry found; only needed for setting the harness's minimum certified version — bisectable via old Homebrew bottles if it ever matters.
3. **Is #37512 (env-token keychain deletion) still reproducible on ≥2.1.19x?** Canary-test on the pinned version before enabling rung 2 broadly.
4. **Does regenerating `setup-token` revoke prior tokens for that account** (one live token per account vs. many)? Determines whether MAX_A can have separate tokens for separate machines/workers.
5. **Cross-account linkage risk**: `~/.claude.json` carries a `machineID`; per-config-dir copies may or may not share it. Does Anthropic's abuse heuristic treat N accounts on one machineID as sharing? No public data; keep concurrency humane and monitor account emails for warnings.
6. **ENT managed-policy collisions**: will ENT's org push `managed-settings.json` (or disable setup-token / force org login) in ways that constrain the harness? Check `/status` + policy files once ENT dir is bootstrapped.
7. **Weekly-limit telemetry per account**: best programmatic source for "remaining quota" per account (the `/usage` surface, `oauth/usage` endpoint used by community dashboards, or transcript-derived estimates) — feeds the observability requirement; belongs to the usage-observability research topic.
8. **`CLAUDE_SECURESTORAGE_CONFIG_DIR` stability**: undocumented; confirm each certified release still honors it (string-grep + functional probe in the harness's upgrade checklist).
