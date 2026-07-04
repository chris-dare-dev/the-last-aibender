# [X2] Secret hygiene for a PUBLIC repo, from the very first commit

Stage-1 discovery research for **the-last-aibender**. Research date: 2026-07-03.
All account identifiers in this document use the project placeholders **MAX_A**, **MAX_B**, **ENT**, **AWS_DEV_ACCOUNT_ID**. No real emails, account IDs, tokens, or key material appear anywhere below — by design, because this document itself lands in the public tree and must pass the very rules it recommends.

---

## TL;DR

1. GitHub's free secret scanning + push protection (default-on for public repos) catches **provider-issued tokens only** — it has **no pattern for 12-digit AWS account IDs or email addresses**, and custom patterns require a paid org plan. Our highest-risk leak class is therefore invisible to GitHub.
2. So enforcement must be local: **gitleaks (v8.30.x) as a pre-commit hook** with a **two-tier config** — generic rules committed in `.gitleaks.toml`, literal personal identifiers in a **private, non-committed** config layered on top (a literal deny-rule committed to the repo would itself be the leak).
3. **URGENT, found during research:** the repo's one existing commit was authored with a **work-domain email**, and repo-local `git config user.email` still points at it. Amend to the GitHub noreply address and force-push **before any other work**.
4. Runtime secrets: keep the owner's existing **macOS Keychain pattern** (`security find-generic-password`, item `bedrock-openai-api-key`) as the primary store; add a committed `.env.example` + gitignored `.env`; config interpolates env vars (OpenCode natively supports `{env:VAR}`).
5. **SOPS+age** (both already installed) is the right tool **if/when** X3's Colima+k3s path is taken (Flux/ksops); it is *deferred*, not adopted, for the host-native start — nothing encrypted needs to live in this repo yet.
6. CI backstop: **gitleaks-action** (free for personal accounts) on every push + **TruffleHog `--results=verified`** on schedule; remediation doctrine: **rotate first**, then `git-filter-repo`, then GitHub Support for cached views.
7. The exact first-commit checklist is in §5.3.

---

## 1. Current landscape (2025–2026)

### 1.1 What GitHub gives a free public repo — and what it doesn't

- **Secret scanning** runs automatically and free on all public repos; **push protection is enabled by default for users** pushing to public repos ("push protection for users") and blocks pushes containing detected secrets before they land ([GitHub docs — push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection), [about secret scanning](https://docs.github.com/code-security/secret-scanning/about-secret-scanning)).
- Coverage keeps widening — 2026 changelogs added Figma, Google, OpenVSX, PostHog, Cloudsmith, Meraki, Elastic, Slack, Supabase, DataDog and more push-protected patterns ([GitHub changelog 2026-03-31](https://github.blog/changelog/2026-03-31-github-secret-scanning-nine-new-types-and-more/), [byteiota June 2026 summary](https://byteiota.com/github-secret-scanning-june-2026-push-protection-gets-wider/)). GitHub also runs an AI "Copilot secret scanning" pass for generic passwords with a two-model verify step.
- **Hard limits that matter for us** ([GitGuardian analysis](https://blog.gitguardian.com/github-push-protection-enhancing-open-source-security-with-limitations-to-consider/), [supported patterns reference](https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns)):
  - Only **provider-issued, high-signal token formats** are push-protected (e.g. `AKIA…` AWS access key IDs, AWS session tokens, Anthropic/OpenAI/GitHub tokens). **No pattern exists for 12-digit AWS account IDs or for email addresses.**
  - **Custom patterns require GitHub Secret Protection on a paid org plan** — not available to free personal accounts even on public repos ([custom patterns doc](https://docs.github.com/en/code-security/secret-scanning/using-advanced-secret-scanning-and-push-protection-features/custom-patterns/defining-custom-patterns-for-secret-scanning), [community discussion #56073](https://github.com/orgs/community/discussions/56073)). `the-last-aibender` lives under a personal account, so this door is closed.
  - Push protection is **bypassable** by anyone with write access (choose a bypass reason, push proceeds), and does no historical scan of what's already in the tree.
- Consequence: GitHub is a useful *backstop for classic tokens* and nothing more. The identifier classes this project cares most about (account emails, AWS_DEV_ACCOUNT_ID, the MAX_A/MAX_B/ENT ↔ real-account mapping) must be enforced **client-side and in our own CI**.

### 1.2 The scanner ecosystem in 2026

- **gitleaks** — v8.30.1 (2026-03); rule-first regex+entropy scanner, milliseconds-fast, fully offline, official pre-commit hook, `.gitleaks.toml` custom rules with `[extend] useDefault = true`, per-rule allowlists, `.gitleaksignore` fingerprints, and a documented config precedence (`--config` flag → `GITLEAKS_CONFIG` env → `GITLEAKS_CONFIG_TOML` content → repo `.gitleaks.toml` → builtin) ([gitleaks README](https://github.com/gitleaks/gitleaks), [releases](https://github.com/gitleaks/gitleaks/releases)). The config-precedence detail is load-bearing for us (§4.J).
- **TruffleHog** — verification-first: finds candidates then **live-verifies them against provider APIs**, 800+ detectors; slower and network-dependent, so the consensus pattern is *gitleaks at pre-commit, TruffleHog in CI* ([appsecsanta benchmark](https://appsecsanta.com/secret-scanning-tools/gitleaks-vs-trufflehog), [Jit comparison](https://www.jit.io/resources/appsec-tools/trufflehog-vs-gitleaks-a-detailed-comparison-of-secret-scanning-tools), [rafter.so](https://rafter.so/blog/secrets/gitleaks-vs-trufflehog)).
- **git-secrets (awslabs)** — the original AWS-pattern pre-commit guard; effectively legacy (no release cadence, bash-based, AWS-centric). Superseded by gitleaks for new setups ([awslabs/git-secrets](https://github.com/awslabs/git-secrets)).
- **detect-secrets (Yelp)** — baseline-file-driven, audit-workflow oriented; installed on this machine (v1.5.0 under a Python 3.9 user install) but its baseline ritual is heavier than gitleaks for a solo repo ([comparison](https://devsecops.ae/secrets-scanners-comparison-2026/)).
- **gitleaks-action v2** — GitHub Action wrapper; **no license key needed for repos under a personal account** (org repos need a `GITLEAKS_LICENSE`, free for 1 repo) ([gitleaks-action](https://github.com/gitleaks/gitleaks-action), [v2 notes](https://github.com/gitleaks/gitleaks-action/blob/master/v2.md)).

### 1.3 Secret *injection* patterns (keeping values out of files entirely)

- **direnv** — auto-loads `.envrc` per directory; 2025-consensus layout: commit a template, gitignore the real thing, or better have `.envrc` contain only *fetch logic* (Keychain/1Password/SOPS calls) so it holds no values at all ([papermtn](https://www.papermtn.co.uk/secrets-management-managing-environment-variables-with-direnv/), [direnv#1434](https://github.com/direnv/direnv/issues/1434)).
- **macOS Keychain** — `security find-generic-password -s <item> -w` at shell/launch time. This is the owner's **already-working pattern**: the `oc-bedrock` zsh function does `aws sso login`, exports `AWS_PROFILE`/`AWS_REGION`, and pulls `OPENAI_API_KEY` from Keychain item `bedrock-openai-api-key` (verified read-only on this machine).
- **1Password CLI** — `op run --env-file=…` injects secrets for a subprocess's lifetime from committed-safe `op://vault/item/field` references; biometric unlock via the desktop app; 2025-2026 material explicitly targets keeping secrets out of AI-agent context ([op run reference](https://developer.1password.com/docs/cli/reference/commands/run/), [1Password blog](https://1password.com/blog/programmatically-read-environments-sdks-desktop), [op-env for Claude Code gist](https://gist.github.com/DAESA24/dc26fa5b63fcd6b4c688772c9d0eb5ca)). **Not installed** here; requires a 1Password subscription.
- **SOPS + age** — SOPS 3.13.0 and age 1.3.1 are **already installed** on this machine. Encrypt-in-repo with values-only encryption (keys stay readable, diffs stay reviewable); age key lives at `~/Library/Application Support/sops/age/keys.txt` (macOS default) or `~/.config/sops/age/keys.txt` with `SOPS_AGE_KEY_FILE`; k8s integration via Flux's native SOPS support, ksops, or helm-secrets ([Flux SOPS guide](https://fluxcd.io/flux/guides/mozilla-sops/), [oneuptime SOPS+age](https://oneuptime.com/blog/post/2026-02-09-sops-age-encryption-kubernetes-secrets/view), [helm-secrets](https://oneuptime.com/blog/post/2026-01-17-helm-secrets-sops-encryption/view)).

### 1.4 Ground truth on this machine (verified read-only, 2026-07-03)

| Item | State |
|---|---|
| Target repo | 1 commit ("first commit", README only) |
| **Commit author email** | **work-domain address — a personal-identifier leak already in public history**; repo-local `user.email` still set to it |
| pre-commit | 4.6.0 installed |
| sops / age | 3.13.0 / 1.3.1 installed |
| detect-secrets | 1.5.0 (Python 3.9 user install) |
| gitleaks, trufflehog, git-secrets, direnv, op (1Password) | **not installed** |
| Keychain pattern | `oc-bedrock` in `~/.zshrc` pulls the Bedrock API key from Keychain item `bedrock-openai-api-key`; **the AWS SSO profile name embeds the 12-digit account ID**, so even `AWS_PROFILE` values are AWS_DEV_ACCOUNT_ID-bearing and must never be committed |
| OpenCode config | `~/.config/opencode/opencode.jsonc` currently uses **zero** `{env:…}` interpolations — profile and endpoint values are literal in the (out-of-repo) user config; fine there, but the pattern must not be copied into the repo |

### 1.5 Threat model for this specific repo

Four leak classes, in descending order of "GitHub will NOT save us":

1. **Personal/config identifiers** — account emails for MAX_A/MAX_B/ENT, AWS_DEV_ACCOUNT_ID (12 digits, also embedded in SSO profile names and ARNs), employer-identifying domains, machine hostnames/usernames in absolute paths. *No native GitHub coverage. Custom rules only.*
2. **Git metadata** — commit author/committer email (already leaked once here), and potentially committer names. *Not scanned by anything by default; fixed by repo-local git config + GitHub email-privacy settings.*
3. **Runtime artifacts** — `~/.claude` transcripts (JSONL), `usage-data/`, `telemetry/`, `history.jsonl`, OpenCode session files: these are *saturated* with account emails, org IDs, OAuth tokens, and paths. The harness reads them by design (usage dashboards, context graph). One careless "commit the fixture" moment leaks everything at once.
4. **Classic credentials** — the Bedrock long-term API key, AWS SSO cache tokens (`~/.aws/sso/cache/*.json`), Claude OAuth/keychain credentials, any future GitHub PAT. *Partially covered by GitHub push protection, fully covered by gitleaks defaults.*

---

## 2. Options considered

### A. Layered `.env` strategy — gitignored `.env` + committed `.env.example`

**How it works.** `.gitignore` excludes `.env` and all `.env.*` variants except a committed `.env.example` that lists every variable with placeholder values (`CLAUDE_ACCOUNT_MAX_A_LABEL=MAX_A`, `AWS_DEV_PROFILE=<your-sso-profile>`, `LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1`). Real values live only in the local `.env`.

**Pros.** Universal, zero tooling, self-documenting onboarding; the example file doubles as the config contract; works with every runtime (Node `dotenv`, Python `python-dotenv`, direnv `dotenv_if_exists`).
**Cons.** The real `.env` is plaintext on disk; nothing *enforces* that a value never gets pasted into a committed file; `.env.example` placeholders drift from reality.
**Risks.** Classic failure mode is `git add -A` plus a mis-ordered `.gitignore` rule (`!.env.example` must come *after* the `.env*` exclusion). Mitigated by scanners (G/H). A subtle one for us: `AWS_PROFILE` looks harmless but embeds AWS_DEV_ACCOUNT_ID here — the `.env.example` placeholder must make that non-obvious trap explicit in a comment.

### B. Config schema that interpolates env vars

**How it works.** The harness's checked-in config (JSON/YAML/TOML) never holds sensitive values, only references: OpenCode already defines the idiom with `{env:VAR}` substitution in `opencode.jsonc`; the harness config does the same (e.g. `"apiKey": "{env:BEDROCK_OPENAI_API_KEY}"`, `"awsProfile": "{env:AWS_DEV_PROFILE}"`). The schema (zod/JSON-Schema) marks fields as `secret: true` / `identifier: true` so the harness can (a) refuse to serialize them into logs/exports, (b) validate presence at startup with actionable errors.

**Pros.** Makes "sensitive = env, structure = repo" a *type-level* property instead of a convention; enables a `doctor` command that verifies env completeness without printing values; the identifier taint can propagate into UI redaction (§6).
**Cons.** Homegrown interpolation is easy to get subtly wrong (escaping, defaults); must decide semantics for missing vars (fail hard for secrets, default for cosmetics).
**Risks.** Low. The main risk is *not* doing it and letting literals creep into committed config "temporarily".

### C. direnv

**How it works.** `brew install direnv`, hook into zsh; a per-directory `.envrc` runs on `cd` and exports the project env. Best 2025 practice: `.envrc` contains **logic, not values** — e.g. `export OPENAI_API_KEY=$(security find-generic-password -s bedrock-openai-api-key -w)` and `dotenv_if_exists .env` ([papermtn](https://www.papermtn.co.uk/secrets-management-managing-environment-variables-with-direnv/), [alexsavio](https://alexsavio.github.io/direnv-dotenv-envrc.html)).
**Pros.** Removes the "forgot to run `oc-bedrock`" failure; per-project isolation; composes with Keychain/1Password/SOPS as the fetch layer; `direnv allow` gate prevents drive-by `.envrc` execution.
**Cons.** One more shell hook; for *this* repo the `.envrc` cannot be committed even if it "holds no secrets," because the natural content (`export AWS_PROFILE=…`) embeds AWS_DEV_ACCOUNT_ID — so we'd commit `.envrc.example` and gitignore `.envrc`, same dance as `.env`.
**Risks.** Cosmetic. Worst case someone commits the real `.envrc`; the custom gitleaks rules (J) catch the account-ID-bearing line.

### D. Runtime fetch from macOS Keychain (the incumbent pattern)

**How it works.** Secrets are stored once with `security add-generic-password -a "$USER" -s <item> -w` and fetched at runtime with `security find-generic-password -s <item> -w`. Already proven here by `oc-bedrock`. The harness generalizes it: every backend adapter declares the Keychain item names it needs; a small resolver fetches them at session-spawn time and injects into the child process env. Item **names** are safe to commit; **values** never touch disk. (Never run the `-w` form in agent transcripts that get committed — the value would land in the transcript.)
**Pros.** Zero new dependencies or subscriptions; encrypted at rest by the OS, unlocked with login/Touch ID; survives the X3 fallback decision because it's host-native by definition; the owner already trusts and uses it.
**Cons.** Mac-only (fine — the harness is explicitly a macOS app); no versioning/sharing; CLI-created items are readable by other processes running as the user once the keychain is unlocked (first access from a new binary can prompt, but the `security` tool itself is pre-authorized) — acceptable for a single-user dev box, not a hard boundary.
**Risks.** If X3's k3s path is taken, **containers cannot reach the Keychain** — secrets must then be injected at deploy time (SOPS, F) or mounted from the host. This is the main conditional in the recommendation.

### E. 1Password CLI (`op run` / `op read` / `op inject`)

**How it works.** Secrets live in 1Password; files commit only `op://vault/item/field` references; `op run --env-file=.env -- <cmd>` resolves references into the subprocess env for its lifetime; biometric unlock piggybacks on the desktop app ([op run](https://developer.1password.com/docs/cli/reference/commands/run/), [biometric unlock](https://developer.1password.com/docs/cli/use-biometric-unlock/)).
**Pros.** Reference-style `.env` files become *committable*; masks secrets in stdout; strong multi-machine/team story; 2026 tooling explicitly targets keeping secrets out of AI-agent context windows ([1Password blog](https://1password.com/blog/programmatically-read-environments-sdks-desktop)).
**Cons.** Requires a 1Password subscription and desktop app; `op` is not installed here and nothing indicates the owner uses 1Password; adds a vendor to the trust boundary; per-invocation latency.
**Risks.** Adopting it *instead of* Keychain adds moving parts without removing any risk class the Keychain+scanners stack doesn't already cover. Rejected as primary; noted as the natural upgrade if multi-machine sync ever matters.

### F. SOPS + age

**How it works.** `age-keygen` once; `.sops.yaml` `creation_rules` map path globs to the age recipient; `sops encrypt` YAML/JSON/dotenv files encrypting **values only** (keys/structure stay diffable); decrypt at use time via `sops exec-env secrets.enc.yaml <cmd>` or `sops decrypt`. Private key at `~/Library/Application Support/sops/age/keys.txt` (macOS default; or `~/.config/sops/age/keys.txt` + `SOPS_AGE_KEY_FILE`), `chmod 600`, backed up outside the repo, **never committed** ([Flux guide](https://fluxcd.io/flux/guides/mozilla-sops/), [oneuptime](https://oneuptime.com/blog/post/2026-02-09-sops-age-encryption-kubernetes-secrets/view)).
**What to encrypt here (if adopted).** Only files that *must* exist in-repo yet hold sensitive values: e.g. a `config/accounts.enc.yaml` mapping MAX_A/MAX_B/ENT → real account emails/org IDs so the harness UI can show real labels locally while the repo stays clean; any future webhook tokens. Rule of thumb: **prefer "not in repo at all" (Keychain/env) over "in repo encrypted"** — encrypt-in-repo is for things that need versioning or cluster delivery.
**Standalone vs k8s.** Standalone: `sops exec-env` in the harness launcher; no cluster needed. k8s (X3): Flux has first-class SOPS decryption (`--decryption-provider=sops` with the age key in a cluster secret); ksops does it as a kustomize plugin; helm-secrets wraps Helm values ([helm-secrets guide](https://oneuptime.com/blog/post/2026-01-17-helm-secrets-sops-encryption/view), [Flux+age](https://major.io/p/encrypted-gitops-secrets-with-flux-and-age/)). Separate age keys per environment if environments ever diverge.
**Pros.** Already installed; the only option that survives the Colima+k3s pivot unchanged; git-diffable encrypted files; no cloud KMS dependency.
**Cons.** Key management ceremony for a repo that currently needs *zero* encrypted files; lost key = lost data; every encrypted file is one `sops -d` away from an accidental decrypted commit (name convention `*.enc.*` + a gitleaks path rule for decrypted twins mitigates).
**Risks.** Premature adoption creates process burden with no payload. **Defer until either (a) a file genuinely must be versioned-and-sensitive, or (b) X3 goes k3s.** Write the `.sops.yaml` the day one of those happens, not before.

### G. Pre-commit scanning

**How it works.** The `pre-commit` framework (already installed, 4.6.0) runs gitleaks against staged changes on every commit via the official hook:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.30.1
    hooks:
      - id: gitleaks
```

gitleaks reads the repo's `.gitleaks.toml` (see J for the two-tier layout). Findings block the commit in milliseconds, offline.
**Alternatives considered.** TruffleHog pre-commit: verification needs network, too slow at commit time — CI-only. git-secrets: legacy, AWS-only patterns, superseded. detect-secrets: baseline-audit workflow is heavier and its Python-3.9 install here is fragile; not worth a second scanner locally.
**Pros.** The only gate that fires *before* anything exists in history — the difference between "delete a line" and "rewrite history + rotate + contact GitHub Support".
**Cons.** Hooks are opt-in per clone (`pre-commit install` required — CI must backstop); `git commit --no-verify` bypasses (acceptable: the person bypassing is the owner).
**Risks.** False positives breed `--no-verify` habits — keep in-repo rules high-precision (keyword-scoped) and shunt broad literal matching to the private tier (J).

### H. CI scanning

**How it works.** Two GitHub Actions workflows:
1. **gitleaks-action v2** on `push` + `pull_request`, full-history scan; free because the repo is under a personal account ([gitleaks-action](https://github.com/gitleaks/gitleaks-action)). It picks up the committed `.gitleaks.toml` (generic rules only — the private tier can't run in CI, which is fine: by CI time the literal would already be public; CI's job is catching clones where pre-commit wasn't installed).
2. **TruffleHog** (`trufflesecurity/trufflehog@main`) with `--results=verified` on a weekly schedule + manual dispatch: live-verifies any leaked credential that is *currently active* — the highest-signal alarm possible ([TruffleHog](https://rafter.so/blog/secrets/gitleaks-vs-trufflehog)).
**Pros.** Covers the "hook not installed" and "web UI edit" paths; verified-only TruffleHog output is near-zero-noise.
**Cons.** Post-hoc by definition — anything CI catches is already public and must be treated as burned.
**Risks.** Minimal; keep workflow permissions read-only (`permissions: contents: read`) so the scanning workflow can't itself become an attack surface.

### I. GitHub push protection + secret scanning (native)

**How it works / pros / cons.** Covered in §1.1. On by default; keep it on; additionally enable **"Keep my email addresses private"** and **"Block command line pushes that expose my email"** in GitHub account settings — the latter makes GitHub *reject* pushes whose commits are authored with the real email, which is the only server-side enforcement available for leak class 2.
**Risks.** The trap is *believing* it covers identifiers. It does not (no AWS-account-ID or email patterns; no custom patterns on free personal accounts). Treat it strictly as the classic-token backstop.

### J. Personal identifiers as config-not-code + custom lint rules

**The self-referential trap.** A committed rule containing the literal value — `regex = '''<the-real-12-digit-id>'''` or `regex = '''<the-real-account-email>'''` — **is itself the leak** (note this doc won't even write a *fake* 12-digit example, because it would trip the very rule below). Therefore rules split into two tiers:

**Tier 1 — committed in `.gitleaks.toml` (generic, value-free):**

```toml
[extend]
useDefault = true   # keep all stock token rules

[[rules]]
id = "aws-account-id-in-context"
description = "12-digit number near AWS context (account IDs are config, not code)"
# keyword pre-filter keeps this high-precision; catches ARNs, profile names, sso config
regex = '''(?i)(?:aws|arn|account|profile|sso|bedrock)[^\n]{0,40}\b\d{12}\b'''
keywords = ["aws", "arn", "account", "profile", "sso", "bedrock"]

[[rules]]
id = "personal-email-provider"
description = "personal-provider email addresses (account emails are config, not code)"
regex = '''[A-Za-z0-9._%+-]+@(?:gmail|icloud|outlook|hotmail|yahoo|proton|protonmail)\.[A-Za-z]{2,}'''
  [[rules.allowlists]]
  regexes = ['''(?:example|test|placeholder|your[-_.]?email)''']

[[rules]]
id = "github-noreply-ok-real-emails-not"
description = "any email that is not a sanctioned placeholder domain"
regex = '''[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'''
  [[rules.allowlists]]
  regexes = [
    '''@users\.noreply\.github\.com''',
    '''@example\.(?:com|org|net)''',
    '''noreply@anthropic\.com''',
  ]
```

(The third rule is deliberately broad; if it proves too noisy in practice, demote it to CI-only or tighten to non-code file types. Precision tuning is a Stage-2 task — the *structure* is the finding here. Pattern references: [Typeform gitleaks-config](https://github.com/Typeform/gitleaks-config), [gitleaks README](https://github.com/gitleaks/gitleaks).)

**Tier 2 — private, NEVER committed:** `~/.config/the-last-aibender/gitleaks-private.toml` containing literal rules for the real MAX_A/MAX_B/ENT emails, the real AWS_DEV_ACCOUNT_ID, the employer domain, the real SSO profile name, and the machine username. Wire it in as a second pre-commit hook (`repo: local`) that runs only when the file exists, e.g. `bash -c 'test ! -f "$HOME/.config/the-last-aibender/gitleaks-private.toml" || gitleaks git --pre-commit --staged --redact --config "$HOME/.config/the-last-aibender/gitleaks-private.toml"'`. gitleaks' documented config precedence (`--config` flag > `GITLEAKS_CONFIG` env > repo file) makes this layering clean. **Always use `--redact`** in this tier so the hook's own output never echoes the literal into a terminal transcript that an agent might commit.

**Pros.** The only mechanism in this entire document that actually enforces "personal identifiers are config, not code". Tier 2 rules are exact-literal, i.e. zero false positives.
**Cons.** Tier 2 is per-machine setup that can't be bootstrapped from the repo itself (by design); document its *existence and schema* in the repo, its *contents* nowhere.
**Risks.** Forgetting to create Tier 2 on a new machine silently drops the strongest guard — mitigate with a harness `doctor` check that warns when the file is absent.

### K. Remediation when something leaks anyway

**Doctrine: rotate first.** Once a credential has touched a public remote, it is burned regardless of any history rewriting — secret-harvesting bots scrape public GitHub events in seconds. Rotate/revoke, *then* clean history for identifiers and tidiness ([GitHub removal guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository), [InstaTunnel guide](https://instatunnel.my/blog/ghosts-in-the-machine-how-to-permanently-purge-secrets-from-your-git-history)).
**Tools.** `git-filter-repo` is the officially recommended rewriter (`--replace-text expressions.txt` with `literal-old==>PLACEHOLDER`, or `--invert-paths --path <file>`); BFG is a faster blunt instrument for simple known-value cases (`--replace-text`, `--delete-files`) ([git-filter-repo](https://github.com/newren/git-filter-repo), [BFG](https://rtyley.github.io/bfg-repo-cleaner/), [Simon Willison's walkthrough](https://til.simonwillison.net/git/rewrite-repo-remove-secrets)). Choose git-filter-repo for repeatability; it auto-drops remotes after rewrite to force a deliberate re-add + force-push.
**GitHub-side residue.** Rewritten commits remain reachable via cached views, old PR diffs, and the activity API until GitHub garbage-collects; for non-rotatable data (personal identifiers — exactly our class 1), **contact GitHub Support to purge cached views and PR references**; merge/close open PRs before rewriting ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)). Forks and clones made before the rewrite keep the data forever — another reason the pre-commit gate is the real defense.

---

## 3. Recommendation (opinionated)

**Adopt: Keychain-primary + env-interpolated config + two-tier gitleaks (pre-commit and CI) + TruffleHog verified-only CI + native GitHub protections + git-filter-repo standing by. Defer SOPS+age until X3 forces it. Skip 1Password, git-secrets, detect-secrets, and committed-.envrc patterns.**

Reasoning in one paragraph: the repo's dominant risk is *identifiers, not tokens* — and every hosted protection is blind to identifiers on a free personal account, so the center of gravity must be local gitleaks rules with the literal values kept in a private out-of-repo tier. For runtime secrets the owner already has a working, zero-dependency Keychain pattern that is also the most X3-resilient choice on the host-native branch; adding 1Password or immediate SOPS ceremony would add surface without closing any open risk. SOPS+age is explicitly pre-approved as the k8s-branch mechanism (Flux native support) the day X3 tips that way — both binaries are already installed, so the pivot is one keygen away.

### 3.1 The concrete stack

| Layer | Choice | Trigger to revisit |
|---|---|---|
| Runtime secret store | macOS Keychain (`security find-generic-password`), generalized from `oc-bedrock` | Multi-machine sync need → 1Password; k3s adoption → SOPS |
| Config | Checked-in config with `{env:VAR}`-style interpolation; schema tags `secret`/`identifier` fields | — |
| Env loading | `.env` (gitignored) + `.env.example` (committed); direnv optional QoL, `.envrc` gitignored | — |
| Commit gate | pre-commit + gitleaks official hook + Tier-2 private-literals local hook | — |
| CI | gitleaks-action (push/PR, full history) + TruffleHog `--results=verified` (weekly) | — |
| Hosted | Push protection (default-on), secret scanning, email-privacy + email-blocking settings | — |
| Encrypted-in-repo | None now; SOPS+age with `.sops.yaml` when X3 goes k3s or a versioned-sensitive file appears | X3 decision |
| Remediation | Rotate → `git-filter-repo --replace-text` → force-push → GitHub Support for cached views | — |

### 3.2 Identifier policy (config-not-code)

- Canonical placeholders everywhere in the tree: **MAX_A, MAX_B, ENT, AWS_DEV_ACCOUNT_ID** (already the convention in this research series). The real mapping lives only in local env / Keychain / (later) a SOPS-encrypted file.
- Git identity: repo-local `git config user.email <id>+<username>@users.noreply.github.com`; enable GitHub's "Keep my email addresses private" + "Block command line pushes that expose my email".
- Documentation/screenshots rule: anything pasted into the repo (including this doc series and future issue text) uses placeholders; the Tier-1 email/account-ID rules lint exactly this.

### 3.3 First-commit checklist (exact, ordered)

Everything below lands in **one hygiene commit** (plus one history fix) *before any code*:

1. **Fix history now, while it's one commit:** set repo-local `git config user.name` and `git config user.email <id>+<username>@users.noreply.github.com`; `git commit --amend --reset-author --no-edit`; `git push --force origin main`. (The current sole commit carries a work-domain author email — this erases it from public history while nothing depends on the SHA.)
2. **GitHub account settings:** enable *Keep my email addresses private* and *Block command line pushes that expose my email*. Repo settings → Code security: confirm secret scanning + push protection are active.
3. **`.gitignore`** (order matters — negation after exclusion):
   ```gitignore
   .env
   .env.*
   !.env.example
   .envrc
   *.local.json
   .claude/settings.local.json
   secrets/
   *.pem
   *.key
   *.age
   keys.txt
   var/        # harness runtime data (transcripts, caches, usage snapshots)
   .DS_Store
   ```
4. **`.env.example`** — every variable, placeholder values only, with a comment warning that `AWS_PROFILE`-style values embed AWS_DEV_ACCOUNT_ID and must stay out of committed files.
5. **`.gitleaks.toml`** — Tier-1 rules from §2.J (`[extend] useDefault = true` + account-ID-in-context + email rules with placeholder allowlists).
6. **Tier-2 private config** — create `~/.config/the-last-aibender/gitleaks-private.toml` with literal rules for: real emails of MAX_A/MAX_B/ENT, AWS_DEV_ACCOUNT_ID, the SSO profile name, employer domain, machine username. `chmod 600`. Not in the repo, ever; its schema documented in `docs/`, its contents nowhere.
7. **`brew install gitleaks`**, then **`.pre-commit-config.yaml`** with (a) the official gitleaks hook, (b) the guarded Tier-2 local hook (with `--redact`); run `pre-commit install`.
8. **CI workflows:** `.github/workflows/secret-scan.yml` — gitleaks-action on push/PR (no license needed, personal account) + TruffleHog `--results=verified` on `schedule` + `workflow_dispatch`; `permissions: contents: read`.
9. **Prove the gate:** stage a file containing a fake AWS key (`AKIAIOSFODNN7EXAMPLE` — allowlisted upstream, so use a mutated one), a 12-digit number next to the word `aws`, and a `@gmail.com` address → commit must fail three ways. Then `gitleaks git -v` over full history → must be clean.
10. **Document the policy:** a short `docs/secret-hygiene.md` (placeholder table, Tier-2 setup instructions, remediation runbook pointer) so future agents inherit the rules. *(Steps 3–10 produce files — that is Stage-2 implementation work; this checklist is its specification.)*

---

## 4. Implications for the harness

1. **Runtime data is radioactive; the repo is the clean room.** The harness's core features (usage dashboards, context graph, workstreams) read `~/.claude/*` and OpenCode state — data saturated with real identifiers and tokens. Architectural rule: the repo holds **code and schemas only**; all ingested/derived data lives outside the tree (e.g. `~/Library/Application Support/the-last-aibender/`) or under a gitignored `var/`. Test fixtures must be *synthesized*, never copied from real transcripts — copying one real JSONL fixture would leak every class at once.
2. **Account labels are a UI-time join.** MAX_A/MAX_B/ENT are the persisted identity everywhere (DB, logs, exports, workstream metadata). The label→real-account mapping is resolved at runtime from env/Keychain and never serialized. This dovetails with X1: session pools keyed by opaque labels mean parallel-session plumbing never needs to write a real email to disk inside the repo.
3. **The config schema's `secret`/`identifier` tags become product features:** redaction in log output, an export scrubber (anything leaving the machine — bug reports, shared workstream handoffs — passes through placeholder substitution), and a `doctor` command that checks: Keychain items present, Tier-2 gitleaks file present, pre-commit installed, LM Studio reachability, `git config user.email` is a noreply address.
4. **Agents are commit authors here.** Claude Code sessions will write and commit in this repo; hook-level gitleaks (not agent diligence) is the enforcement, and `--redact` on scanner output matters because scanner output itself flows through agent transcripts. The Tier-2 hook design assumed exactly this.
5. **X3 branch-point is pre-decided:** host-native → Keychain injection at spawn; Colima+k3s → SOPS+age with Flux/ksops, age key on host only, cluster gets it as a one-time secret. No third pattern; LM Studio reachability (the X3 override) is unaffected by either secret path.
6. **Workstreams (X4) inherit the placeholder discipline:** lineage metadata will reference accounts/backends per session node — stored as labels, joined to real identity only in the UI layer.

---

## 5. Sources

**GitHub native protections**
- https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection
- https://docs.github.com/code-security/secret-scanning/about-secret-scanning
- https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns
- https://docs.github.com/en/code-security/secret-scanning/using-advanced-secret-scanning-and-push-protection-features/custom-patterns/defining-custom-patterns-for-secret-scanning
- https://github.com/orgs/community/discussions/56073
- https://github.blog/changelog/2026-03-31-github-secret-scanning-nine-new-types-and-more/
- https://byteiota.com/github-secret-scanning-june-2026-push-protection-gets-wider/
- https://blog.gitguardian.com/github-push-protection-enhancing-open-source-security-with-limitations-to-consider/

**Scanners**
- https://github.com/gitleaks/gitleaks and https://github.com/gitleaks/gitleaks/releases
- https://github.com/gitleaks/gitleaks-action and https://github.com/gitleaks/gitleaks-action/blob/master/v2.md
- https://appsecsanta.com/secret-scanning-tools/gitleaks-vs-trufflehog
- https://rafter.so/blog/secrets/gitleaks-vs-trufflehog
- https://www.jit.io/resources/appsec-tools/trufflehog-vs-gitleaks-a-detailed-comparison-of-secret-scanning-tools
- https://devsecops.ae/secrets-scanners-comparison-2026/
- https://github.com/awslabs/git-secrets
- https://github.com/Typeform/gitleaks-config
- https://oneuptime.com/blog/post/2026-01-25-secret-scanning-gitleaks/view

**Injection / encryption**
- https://developer.1password.com/docs/cli/reference/commands/run/
- https://developer.1password.com/docs/cli/use-biometric-unlock/
- https://1password.com/blog/programmatically-read-environments-sdks-desktop
- https://gist.github.com/DAESA24/dc26fa5b63fcd6b4c688772c9d0eb5ca
- https://www.papermtn.co.uk/secrets-management-managing-environment-variables-with-direnv/
- https://alexsavio.github.io/direnv-dotenv-envrc.html
- https://github.com/direnv/direnv/issues/1434
- https://fluxcd.io/flux/guides/mozilla-sops/
- https://oneuptime.com/blog/post/2026-02-09-sops-age-encryption-kubernetes-secrets/view
- https://oneuptime.com/blog/post/2026-01-17-helm-secrets-sops-encryption/view
- https://major.io/p/encrypted-gitops-secrets-with-flux-and-age/

**Remediation**
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository
- https://github.com/newren/git-filter-repo
- https://rtyley.github.io/bfg-repo-cleaner/
- https://til.simonwillison.net/git/rewrite-repo-remove-secrets
- https://instatunnel.my/blog/ghosts-in-the-machine-how-to-permanently-purge-secrets-from-your-git-history

---

## 6. Open questions

1. **Broad email rule precision** — does Tier-1's catch-all email rule (rule 3 in §2.J) generate unacceptable noise once real code lands (package metadata, license headers)? Stage-2 should tune with real commits; fallback is demoting it to CI-only.
2. **12-digit context window** — is 40 chars of context around `\b\d{12}\b` the right radius, and should ARN-shaped strings (`arn:aws:…:\d{12}:`) get their own always-on rule regardless of keyword distance?
3. **Tier-2 bootstrap UX** — should the harness `doctor`/init generate the private gitleaks file interactively (prompting for values that never echo), rather than documenting a manual step?
4. **Does anything actually need SOPS before k3s?** Candidate: an encrypted `accounts.enc.yaml` for real-label display in the UI. Alternative: keep the mapping in Keychain items too and never encrypt-in-repo at all. Decide when the UI account-registry design (frontend research thread) lands.
5. **Transcript-commit exposure** — if session transcripts/workstream artifacts are ever committed as project memory (X4 flirts with this), they need an automated scrub pass; is placeholder substitution reliable enough, or must transcripts stay out of the tree categorically?
6. **GitHub Support purge SLA** — for identifier (non-credential) leaks, how responsive is GitHub Support about clearing cached views in practice? Worth knowing before an incident, not during.
7. **`security` CLI ACL hardening** — is it worth creating Keychain items via a small signed helper (tighter ACL) instead of the `security` CLI (which grants the CLI broad access), given local-only threat model? Low priority.
