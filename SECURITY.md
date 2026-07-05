# SECURITY.md — the-last-aibender secret & identifier hygiene ([X2])

This is the **committed half** of the repo's hygiene doctrine. The other half —
the exact private identifier literals — lives out-of-repo on the owner's
machine and is described here only by shape, never by value.

Normative sources: blueprint §10 and the [X2 findings doc](docs/research/findings/x2-secret-hygiene.md)
(§3.3 checklist). Operator procedures: [docs/runbooks/hygiene.md](docs/runbooks/hygiene.md).

---

## 1. Placeholder policy

This is a **public** repo. The dominant risk class is *identifiers, not
tokens* — and hosted scanning is blind to identifiers, so placeholder
discipline plus local scanning is the enforcement.

| Real thing | Only form allowed anywhere in this tree |
|---|---|
| Any Claude **Max** account (arbitrarily many) | `MAX_<X>` — `MAX_` + a single uppercase letter, i.e. `^MAX_[A-Z]$` (`MAX_A`, `MAX_B`, `MAX_C`, `MAX_D`, … `MAX_Z`) |
| Claude enterprise/work account | `ENT` |
| The two fixed backend labels (not accounts) | `AWS_DEV`, `LOCAL` |
| AWS dev account (12-digit ID, SSO profile name, ARNs) | `AWS_DEV_ACCOUNT_ID` |
| Any human email | `*@example.com|org|net`, `*@users.noreply.github.com`, or `noreply@anthropic.com` |
| Git author identity | `<id>+<username>@users.noreply.github.com` |

**The Max-account form is OPEN by design ([X1] scalability, ICR-0013).** The
owner may provision arbitrarily many Claude Max subscriptions; each new one is a
new sanctioned placeholder of the shape `MAX_<X>` — using it in code, fixtures,
or docs is fine (it is the SAME class as `MAX_A`/`MAX_B`). `MAX_C` and `MAX_D`
are already provisioned and first-class. The single machine-checkable regex of
record is `CLAUDE_ACCOUNT_LABEL_RE = ^MAX_[A-Z]$` (packages/protocol/vocab.ts);
`ENT` is the one exact enterprise literal. What stays out of the tree is the
label→**real account** mapping, never the label form itself.

Rules:

- The label→real-account mapping exists only in machine-local files (under
  `~/.aibender/`, keyed by the `MAX_<X>`/`ENT`/backend-label form) and the
  owner's head. It is never serialized into the tree, the DBs, logs, or exports
  (UI-time join only). Adding a newly provisioned Max account is a new
  machine-local KEY under the sanctioned form — never a tree change.
- `AWS_PROFILE`-style values **embed the AWS account ID** (SSO profile names
  are `<account-id>_<RoleName>`), so real profile names are treated as the
  account ID itself. See the warning in `.env.example`.
- Test fixtures are **synthesized**, never copied from real transcripts —
  one copied JSONL fixture would leak every identifier class at once.
- Runtime/ingested data (transcripts, usage snapshots, quota files, ledgers)
  never lives in the tree: machine-local under `~/.aibender/` or gitignored
  `var/` in dev mode.

## 2. The two-tier scanning model

**Tier 1 — committed, generic, value-free** (`.gitleaks.toml`): the full
gitleaks default ruleset plus three custom rules — 12-digit-number-near-AWS
context, personal-email-provider addresses, and a deliberately broad
catch-all email rule with an explicit allowlist for the sanctioned
placeholder forms above. Tier-1 rules never contain a literal: **a committed
rule containing the real value *is* the leak** (this is why the tiers exist).

**Tier 2 — private, out-of-repo, never committed**
(`~/.aibender/private/gitleaks-tier2.toml`, chmod 600): exact-literal rules
for the real identifiers (work-domain email, real AWS account ID, personal
emails). Zero false positives by construction. Its **schema** is documented
in [docs/runbooks/hygiene.md](docs/runbooks/hygiene.md); its **contents**
nowhere in any repo, issue, or transcript.

**Enforcement points:**

1. **Local pre-commit hook** (`.git/hooks/pre-commit`, installed by
   `infra/scripts/install-hooks.sh`): runs Tier 1, then Tier 2 with
   `--redact` (so the hook's own output never echoes a literal into a
   terminal transcript an agent might commit). The hook **fails closed** —
   missing gitleaks or a missing Tier-2 file blocks the commit. Agents are
   commit authors in this repo; hook-level scanning, not agent diligence, is
   the enforcement.
2. **CI backstop** (`.github/workflows/`): gitleaks-action on every push/PR
   (Tier 1, full history) + weekly TruffleHog `--results=verified`. Both run
   with `permissions: contents: read`.
3. **GitHub native**: secret scanning + push protection enabled on the repo
   (see ledger §5).

The gate was proven by deliberately seeding three fake-leak classes and
recording the three blocked commits — see
[docs/runbooks/hygiene.md](docs/runbooks/hygiene.md).

**Tier-1 allowlist tuning log** (every entry must stay value-free):

- *2026-07-04 (M3 build, ratified by BE-ORCH stewarding):* the
  `aws-account-id-in-context` rule gained a match-target allowlist for the
  **all-zeros 12-digit run** (`\b0{12}\b`). The SI-4 Bedrock IaC brief
  mandates a syntactically valid all-zeros stand-in for `AWS_DEV_ACCOUNT_ID`
  (variables.tf default, tfvars.example, runbook, bats), which the rule
  flagged sixfold on mandated content. The exception is value-free by
  construction — all-zeros is not an assignable AWS account id — and every
  NON-zero 12-digit literal still fails the rule; the SI-4 bats hygiene
  tests enforce the same all-zeros-only invariant independently, so the
  invariant is double-covered rather than weakened.
- *2026-07-04 (M2 gate follow-up):* added a **global path allowlist** for
  `app/src-tauri/target/` (cargo build output, gitignored, never tracked).
  Rust `.rmeta` artifacts embed third-party crate-author emails (tokio,
  serde, zerocopy, …), tripping the email rules on any machine that has
  built the Tauri shell (M2 DoD §4 D4 / §5 item 6). Unlike the M0 PixiJS
  case below there is no stable value-shape to allowlist — the content is
  upstream-generated and churns on every build/bump — and naming third-party
  identities in a committed rule would itself violate the value-free
  doctrine. The path rule is value-free and the coverage loss is nil for
  commits: the directory is gitignored (never stageable, so the pre-commit
  staged scan is unaffected) and CI scans fresh checkouts that have no
  `target/`. Replaces the `cargo clean` pre-gate mitigation that was
  documented in `app/src-tauri/README.md`. Re-proof on landing: full-dir
  Tier-1 scan clean with the shell build present; a seeded fabricated
  personal email outside `target/` still fired both email rules in the dir
  scan AND was blocked by the staged pre-commit hook.
- *2026-07-04 (M0 gate):* added `@\dx\.(png|webp|…)$` to the catch-all email
  rule's allowlist. Retina-suffix asset filenames (`bar@2x.webp`) in the
  vendored PixiJS JSDoc inside the spike bundle
  `spikes/graph-perf/browser/dist/pixi-soak.js` matched the email shape.
  The bundle is gitignored (`dist/`), so this never reached a commit — but
  the M0 gate's full-tree `gitleaks dir` scan sees ignored files too and must
  be clean. A filename-extension suffix is not an identity form, so the
  exception is generic and value-free; the alternative (path-allowlisting the
  whole bundle) would have stopped scanning that file for real leaks.
- *2026-07-05 (M7 account-registry, ICR-0013):* **doctrine generalization, NO
  Tier-1 rule change.** The sanctioned placeholder for a Claude Max account was
  generalized from the fixed `MAX_A`/`MAX_B` to the OPEN form `^MAX_[A-Z]$`
  (§1 table above), promoting `MAX_C`/`MAX_D` to first-class placeholders. A
  `MAX_<X>` label is not secret-shaped (no 12-digit run, no `@`), so no gitleaks
  rule was added or relaxed — verified: none of the three Tier-1 rules
  (`aws-account-id-in-context`, `personal-email-provider`,
  `email-not-a-sanctioned-placeholder`) matches a `MAX_<X>` literal. This entry
  records the *doctrine of record* only; the enforcement surface is unchanged.

## 3. Remediation doctrine (when something leaks anyway)

**Rotate first.** Once a credential touches a public remote it is burned
regardless of history rewriting — harvesting bots scrape public GitHub
events in seconds. Rotate/revoke, *then* clean history:

1. **Rotate/revoke** the credential (or accept that an identifier is
   exposed and proceed to containment).
2. **Rewrite history** with `git-filter-repo --replace-text expressions.txt`
   (`literal-old==>PLACEHOLDER` lines; the literal goes in a machine-local
   expressions file, never in the tree). git-filter-repo drops remotes after
   rewriting to force a deliberate re-add + force-push.
3. **Contact GitHub Support** to purge cached views, old PR diffs, and
   activity-API references — rewritten commits stay reachable until GitHub
   garbage-collects. Merge/close open PRs before rewriting. Forks and clones
   made before the rewrite keep the data forever — the pre-commit gate is
   the real defense.

## 4. Deliberate deviations from the X2 §3.3 checklist

Recorded per the Stage-2 build brief; the *intent* of every step is honored.

| §3.3 step | Deviation | Why |
|---|---|---|
| 1 (history amend + force-push) | **Not executed** — documented as pending-owner in §5.1 | History rewrites and pushes are owner-gated; a prior attempt was blocked by policy. Work stays local-only until executed. |
| 6 (Tier-2 path) | `~/.aibender/private/gitleaks-tier2.toml` instead of `~/.config/the-last-aibender/gitleaks-private.toml` | Consolidates all machine-local private state under the harness home `~/.aibender/`. |
| 7 (pre-commit framework) | Direct `.git/hooks/pre-commit` written by `infra/scripts/install-hooks.sh` — no `.pre-commit-config.yaml` / `pre-commit` dependency | One fewer toolchain; the installer is idempotent and the hook is the single enforcement artifact. Also: gitleaks ≥ 8.19 removed `protect --staged`; the hook uses the modern `gitleaks git --pre-commit --staged`. |
| 8 (one `secret-scan.yml`) | Split into `gitleaks.yml` (push/PR) and `trufflehog-weekly.yml` (schedule + dispatch), plus a guarded `ci.yml` placeholder | Independent failure surfaces and schedules; matches plan §2 layout. |
| 10 (`docs/secret-hygiene.md`) | This `SECURITY.md` + `docs/runbooks/hygiene.md` | Matches plan §2 repo layout, which names `SECURITY.md` as the policy doc. |

## 5. Pending-owner ledger

Items only the owner can execute. Nothing below blocks local development;
items 5.1–5.2 block *publishing* history beyond what already exists.

### 5.1 History rewrite of commit `62d11d0` (OPEN — owner-gated)

The repo's first commit carries **the work-domain email on commit `62d11d0`**
as author/committer identity (read it locally with
`git log --format=%ae 62d11d0 -1`; it is deliberately not written here).
The rewrite maps it to the GitHub noreply identity and force-pushes:

```bash
# 1. Read the literal locally (never write it into any repo file):
#      git log --format=%ae 62d11d0 -1
# 2. Rewrite every commit's author+committer identity that uses it:
git filter-repo --force --email-callback '
    return (b"234062931+chris-dare-dev@users.noreply.github.com"
            if email == b"<WORK_DOMAIN_EMAIL_FROM_STEP_1>" else email)
'
# 3. git-filter-repo removes remotes after a rewrite — re-add and force-push:
git remote add origin git@github.com:chris-dare-dev/the-last-aibender.git
git push --force origin main
# 4. Set the repo-local identity so it never recurs:
git config user.name  "chris-dare-dev"
git config user.email "234062931+chris-dare-dev@users.noreply.github.com"
```

**All work stays local-only until this is executed** — every SHA changes on
rewrite, so nothing may be built against the current public SHAs.

### 5.2 GitHub account email-privacy settings (OPEN — owner-gated)

Account-level settings (not repo-level, not API-reachable with this token):
enable **"Keep my email addresses private"** and **"Block command line
pushes that expose my email"** at <https://github.com/settings/emails>.

### 5.3 Repo push protection (CLOSED — done 2026-07-04)

`secret_scanning_push_protection` was enabled via one authorized
`gh api PATCH` on `chris-dare-dev/the-last-aibender`; `secret_scanning`
was already active. Verified in the API response
(`"secret_scanning_push_protection":{"status":"enabled"}`).

---

## Reporting a vulnerability or a suspected leak

Open a GitHub issue **without quoting the leaked value** (say which class:
token, account ID, email, profile name — and where), or use GitHub's private
vulnerability reporting on this repo. Then follow §3.
