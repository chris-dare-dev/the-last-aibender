# Runbook — secret & identifier hygiene gate (X2 / SI-1)

Operator procedures for the two-tier gitleaks gate. Policy and doctrine live
in [SECURITY.md](../../SECURITY.md); this runbook is *how to set up, verify,
and re-prove* the gate on any machine that commits to this repo.

Toolchain proven against: **gitleaks 8.30.1** (note: `gitleaks protect` was
removed in ≥ 8.19; the modern staged-scan invocation is
`gitleaks git --pre-commit --staged`).

---

## 1. One-time machine setup

```bash
# 1. Install the scanner
brew install gitleaks

# 2. Install the pre-commit hook (idempotent; safe to re-run any time)
infra/scripts/install-hooks.sh

# 3. Create the Tier-2 private config (see §2) and lock it down
umask 0077                         # so nothing you create here is group/world-readable
mkdir -p ~/.aibender/private
chmod 700 ~/.aibender ~/.aibender/private
$EDITOR ~/.aibender/private/gitleaks-tier2.toml
chmod 600 ~/.aibender/private/gitleaks-tier2.toml
```

Until step 3 is done, **every commit on this machine is blocked** — the hook
fails closed when the Tier-2 file is absent. That is deliberate.

**The Tier-2 file MUST be mode `600` (SEC-4).** It holds exact private
identifier literals, so a group- or world-readable copy is itself an exposure.
The pre-commit hook now **fails closed on the permission bits too**: if
`~/.aibender/private/gitleaks-tier2.toml` is not exactly mode `600`, the hook
refuses to run it and blocks the commit with a `chmod 600` instruction — the
same fail-closed posture it already applies to a *missing* Tier-2 file. Set
`umask 0077` before creating any machine-local private file under `~/.aibender/`
so the mode is right from creation; the explicit `chmod 600` above is the
belt-and-braces. (Enforced by the SEC-4 assertion in
`infra/scripts/install-hooks.sh`; covered by
`infra/scripts/tests/hooks-install.bats`.)

## 2. Tier-2 config schema (contents documented NOWHERE)

`~/.aibender/private/gitleaks-tier2.toml` is a plain gitleaks config whose
rules are **exact literals** of this machine/owner's private identifiers.
One `[[rules]]` block per literal. Shape (values are yours to fill in — do
not copy them from anywhere in this repo, because they must not be here):

```toml
title = "the-last-aibender tier-2 private literals"

[[rules]]
id = "work-domain-email-literal"
description = "the work-domain author email on commit 62d11d0"
regex = '''<the literal email, dots escaped>'''

[[rules]]
id = "work-domain-literal"
description = "the work domain itself"
regex = '''(?i)@?<the literal domain, dots escaped>'''

[[rules]]
id = "aws-dev-account-id-literal"
description = "the real AWS dev account ID (12 digits)"
regex = '''<the literal 12 digits>'''

# ...one block per personal email address, same pattern.
```

Where to find the values on the owner's machine: the work email is the
author of commit `62d11d0` (`git log --format=%ae 62d11d0 -1`); the AWS
account ID is the 12-digit prefix of the SSO profile name used by the
`oc-bedrock` shell function. Personal emails are the owner's — you know
them; the repo must not.

Rules for this file, always:

- `chmod 600`, never committed, never pasted into an issue/PR/transcript.
- The hook runs it with `--redact` so even its *findings* never echo a
  literal.
- Losing the file does not weaken Tier 1 or CI, but the hook fails closed
  until it is restored.

## 3. What the gate runs

`.git/hooks/pre-commit` (installed by `infra/scripts/install-hooks.sh`):

1. `gitleaks git --pre-commit --staged --redact -v --config .gitleaks.toml`
   — Tier 1: gitleaks defaults + the three generic identifier rules.
2. Fail closed if `~/.aibender/private/gitleaks-tier2.toml` is missing.
3. `gitleaks git --pre-commit --staged --redact -v --config <tier-2 file>`
   — Tier 2: exact private literals.

CI backstop (`.github/workflows/`): `gitleaks.yml` re-runs Tier 1 over full
history on every push/PR; `trufflehog-weekly.yml` runs TruffleHog
`--results=verified` weekly. Tier 2 never runs in CI by design — its config
never leaves the owner's machine.

## 4. Gate proof — the three seeded failures (2026-07-04, gitleaks 8.30.1)

Per X2 §3.3 step 9, the gate was deliberately failed three ways. For each
class a scratch file `hygiene-gate-proof.tmp` was seeded with a **fabricated**
leak, staged, and the installed pre-commit hook executed; the seed was
deleted after each run. The transcripts below are verbatim hook output
(ANSI color and timestamps stripped). Findings appear as `REDACTED` because
the hook always runs `--redact` — recording unredacted output here would
itself trip the gate, which is the point.

The three seed classes (literals intentionally not reproduced here):

1. a fabricated 12-digit number adjacent to the word `aws` (verified ≠ the
   real account ID);
2. a fabricated `…@gmail.com` address;
3. a fabricated AWS access key ID — `AKIA` + 16 base32 characters, mutated
   so it is **not** AWS's allowlisted documentation example. (Gate-proof
   gotcha: gitleaks 8.30's `aws-access-token` rule requires `[A-Z2-7]{16}`
   after the prefix and an entropy floor — a lazy `AKIA…FAKEFAKE…` seed
   passes silently. Use a random base32 tail when re-proving.)

### Seed 1 — fabricated 12-digit number near AWS context → BLOCKED

```text
=== SEED 1: fabricated 12-digit number adjacent to AWS context ===
Finding:     deploy target REDACTED (fabricated for gat...
Secret:      REDACTED
RuleID:      aws-account-id-in-context
Entropy:     4.243856
File:        hygiene-gate-proof.tmp
Line:        1
Fingerprint: hygiene-gate-proof.tmp:aws-account-id-in-context:1

INF 0 commits scanned.
INF scanned ~68 bytes (68 bytes) in 26.5ms
WRN leaks found: 1

pre-commit: COMMIT BLOCKED — Tier-1 gitleaks scan found leaks in the staged changes.
  Fix or remove the flagged content. Placeholders (MAX_A/MAX_B/ENT/
  AWS_DEV_ACCOUNT_ID, *@example.com) are the only identities allowed in the
  tree. See docs/runbooks/hygiene.md and SECURITY.md.
exit_code=1
```

### Seed 2 — fabricated personal-provider email → BLOCKED (two rules)

```text
=== SEED 2: fabricated personal-provider email ===
Finding:     on-call contact: REDACTED (fabricated for gat...
Secret:      REDACTED
RuleID:      personal-email-provider
Entropy:     3.821312
File:        hygiene-gate-proof.tmp
Line:        1
Fingerprint: hygiene-gate-proof.tmp:personal-email-provider:1

Finding:     on-call contact: REDACTED (fabricated for gat...
Secret:      REDACTED
RuleID:      email-not-a-sanctioned-placeholder
Entropy:     3.821312
File:        hygiene-gate-proof.tmp
Line:        1
Fingerprint: hygiene-gate-proof.tmp:email-not-a-sanctioned-placeholder:1

INF 0 commits scanned.
INF scanned ~77 bytes (77 bytes) in 25.3ms
WRN leaks found: 2

pre-commit: COMMIT BLOCKED — Tier-1 gitleaks scan found leaks in the staged changes.
  Fix or remove the flagged content. Placeholders (MAX_A/MAX_B/ENT/
  AWS_DEV_ACCOUNT_ID, *@example.com) are the only identities allowed in the
  tree. See docs/runbooks/hygiene.md and SECURITY.md.
exit_code=1
```

### Seed 3 — fabricated AWS access key ID → BLOCKED

```text
=== SEED 3: fabricated AWS access key ID (base32-valid, NOT the allowlisted docs example) ===
Finding:     ...t AWS_ACCESS_KEY_ID=REDACTED
Secret:      REDACTED
RuleID:      aws-access-token
Entropy:     4.221928
File:        hygiene-gate-proof.tmp
Line:        1
Fingerprint: hygiene-gate-proof.tmp:aws-access-token:1

INF 0 commits scanned.
INF scanned ~46 bytes (46 bytes) in 24.1ms
WRN leaks found: 1

pre-commit: COMMIT BLOCKED — Tier-1 gitleaks scan found leaks in the staged changes.
  Fix or remove the flagged content. Placeholders (MAX_A/MAX_B/ENT/
  AWS_DEV_ACCOUNT_ID, *@example.com) are the only identities allowed in the
  tree. See docs/runbooks/hygiene.md and SECURITY.md.
exit_code=1
```

All three seeds were deleted after the proof; `git status` confirmed no
`hygiene-gate-proof.tmp` remained.

## 5. Re-proving and testing the gate

```bash
# Full SI-1 test matrix (positive / negative / edge, plan §9.2):
infra/scripts/test-hygiene.sh

# Manual scan of the PUBLISHABLE worktree (tracked + untracked non-ignored
# files), both tiers. Do not point `gitleaks dir` at the repo root directly:
# it walks .git/ internals, and until the SECURITY.md §5.1 history rewrite is
# executed the reflog (.git/logs/*) legitimately trips Tier-2 on the original
# commits' author identity — that is metadata, not tree content.
EXPORT=$(mktemp -d)
git ls-files --cached --others --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C "$EXPORT"
gitleaks dir "$EXPORT" --config .gitleaks.toml --redact --no-banner
gitleaks dir "$EXPORT" --config ~/.aibender/private/gitleaks-tier2.toml --redact --no-banner
rm -rf "$EXPORT"

# Full-history scan (diff content), both tiers:
gitleaks git . --config .gitleaks.toml --redact --no-banner
gitleaks git . --config ~/.aibender/private/gitleaks-tier2.toml --redact --no-banner
```

Gate-proof note: the negative seeds inside `infra/scripts/test-hygiene.sh`
are assembled at runtime from split string fragments — a committed test file
containing an intact fake leak would be blocked by the very gate it tests
(the self-referential trap from X2 §2.J). Keep it that way when editing.

Re-prove the three seeded failures (§4) after any gitleaks major/minor
upgrade or any edit to `.gitleaks.toml` — rule semantics have drifted before
(see the Seed-3 gotcha above).

## 6. Known tuning debt

- The Tier-1 catch-all email rule is deliberately broad. If it turns noisy
  once real code lands (package metadata, license headers), demote it to
  CI-only or restrict it to non-code file types — X2 findings §6.1.
- Consider an always-on ARN-shaped rule (`arn:aws:…`) independent of the
  40-char keyword radius — X2 findings §6.2.

## 7. If the gate fires on a real literal

Do not paste the finding anywhere. Replace the literal with its placeholder
(§1 of SECURITY.md), re-stage, re-commit. If a literal ever *lands in
history*, stop and follow the remediation doctrine in SECURITY.md §3.
