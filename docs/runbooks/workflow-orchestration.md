# Runbook — multi-agent Workflow orchestration

> **Read [`docs/HANDOFF.md`](../HANDOFF.md) first.** This runbook is the *reusable machinery* for
> building each milestone with the `Workflow` tool. It carries the exact agent preamble, the JSON
> schemas, the five-phase skeleton, and a ready-to-adapt script for the remaining M2 work. Every
> milestone (M2-impl, M3, M4, M5, M6) is authored by copying this skeleton and swapping in that
> milestone's package briefs from the plan.

---

## 1. Why it is built this way

- **Parallelism without merge conflicts** comes from *exclusive directory ownership* per work package.
  Agents run concurrently; each writes only inside its owned dirs; cross-package needs go through
  `packages/*` exports or an **ICR** (interface change request) the steward lands.
- **Quality** comes from the phase shape: a **Freeze** locks the contracts a milestone depends on, then
  **Build** implements in parallel, then each department's **orchestrator reviews** its own diffs as a
  principal engineer and returns a `fixes` list, then **Fix** applies them, then a single serial **Gate**
  agent re-verifies everything and commits locally.
- **Safety** comes from: agents never commit (only the gate does, only locally, never push); every agent
  prompt embeds the [X2] placeholder rules and the hard-gate prohibitions; the gate runs gitleaks
  tier-1+tier-2 and the pre-commit hook on every commit.

## 2. The phase shape (every milestone)

```
Freeze  → BE-ORCH promotes/locks the contracts this milestone needs (packages/protocol, schema, testkit,
          docs/contracts/*). Skipped for M2-impl (M2 freeze already committed at 533cfb8).
Build   → parallel() of the milestone's implementer agents (2–4 per department), each schema'd.
ICR     → if any implementer returned icr_requests, BE-ORCH lands them in packages/* with tests.
Review  → parallel() of the 3 orchestrators (BE/FE/SI); each returns {verdict, fixes[]}.
Fix     → parallel() of one fixer per department that returned fixes_required.
Gate    → ONE serial committer agent: typecheck + tests + soaks + gitleaks + write mN-dod.md + commit.
```

Rules baked into the driver:
- `parallel()` is a barrier — fine here because Review needs all Build results and Gate needs all Fixes.
- Every `agent()` call uses a schema so the return is structured (see §4).
- The Gate agent is the **only** one told it may run `git add/commit` (never push, never `--no-verify`).

## 3. The `COMMON` preamble (paste into every agent prompt)

Every implementer/reviewer/gate prompt begins with this block (adjust the "Landed so far" line per
milestone). It encodes the non-negotiables so no agent can plausibly claim it wasn't told.

```
# Stage 2 · <MILESTONE> build agent — "the-last-aibender"
Repo: ~/Personal/SourceCode/the-last-aibender. Landed so far: <one line: M0/M1/M2-freeze...>.
READ the code you build against — do not re-invent existing surfaces.
NORMATIVE: docs/research/summaries/01-architecture-blueprint.md and 02-stage2-implementation-plan.md
(your package section + §9.2 test matrix). docs/contracts/*.md are FROZEN — amend only via the freeze
phase or an ICR note in your return. DESIGN.md is LOCKED: UI must pass `pnpm -F aibender-app lint:tokens`.
Deviations need an ADR in docs/adr/. Consult docs/spikes/*.md for prior-art contracts you must honor.

## Non-negotiable rules
1. [X2]: public repo. NEVER write real account emails, real AWS account IDs, tokens, or key material
   into ANY repo file. Placeholders MAX_A/MAX_B/ENT/AWS_DEV_ACCOUNT_ID only. Fixtures synthesized.
   The pre-commit hook enforces this — never bypass it.
2. GIT: you never commit/push; the serial gate agent commits.
3. EXTERNAL MUTATIONS FORBIDDEN: no `claude /login`/logout; ~/.claude READ-ONLY; no Keychain writes,
   never `security ... -w`; no terraform apply; no colima ops; no GitHub mutations; no push; do NOT
   start LM Studio. EXCEPTION: you MAY spawn a temporary local `opencode serve` for adapter integration
   tests IF the binary exists — health/list/event endpoints only, NEVER message/inference calls (they
   cost money); kill it when done. Real-account/real-TUI runs are T3 pending-owner: implement, script,
   document, and list them in pending_owner_items.
4. OWNERSHIP: write ONLY inside your assigned directories. Missing @aibender/* exports → icr_requests in
   your return; do not edit other packages.
5. QUALITY: TS strict, vitest, positive/negative/edge per plan §9.2 for YOUR package. Run pnpm install +
   your tests before returning. Prefer node:sqlite behind the @aibender/schema adapter.
6. Honest returns only: tests_passed=false with notes beats a false green.
```

## 4. The JSON schemas

```js
const IMPL_SCHEMA = {
  type: 'object',
  required: ['summary', 'files_created', 'tests_passed'],
  properties: {
    summary: { type: 'string' },
    files_created: { type: 'array', items: { type: 'string' } },
    tests_passed: { type: 'boolean' },
    test_evidence: { type: 'string' },
    pending_owner_items: { type: 'array', items: { type: 'string' } },
    icr_requests: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'fixes'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'fixes_required'] },
    fixes: { type: 'array', items: { type: 'object',
      required: ['path', 'issue', 'required_change'],
      properties: { path: { type: 'string' }, issue: { type: 'string' }, required_change: { type: 'string' } } } },
    notes: { type: 'string' },
  },
}
// Gate schema: { commits[], gitleaks_clean, tests_green, <soak fields>, pending_owner_items[], notes }
```

## 5. Orchestrator review duty (paste into each reviewer)

```
# Department ORCHESTRATOR / principal engineer review (plan §1.1) of the uncommitted <MILESTONE> work.
Verify against blueprint/plan/contracts YOURSELF; run the tests YOURSELF; run gitleaks tier-1 YOURSELF.
Return only material fixes; nits go in notes. You fix nothing — you return the fixes list.
Scrutinize hardest: <the 4–6 things most likely to be wrong for these packages — name them explicitly>.
```

## 6. Gate duty (the serial committer)

The gate agent gets the `COMMON` preamble **with rule 2 replaced** by:
`2. GIT: YOU are the serial committer — git add/commit locally, never push or rewrite history; the
pre-commit hook always runs, never --no-verify (false positives: minimal tier-1 allowlist extension +
SECURITY.md note).`
Then it: (1) runs `pnpm install && pnpm -r typecheck && pnpm -r test && pnpm run test:infra &&
pnpm -F aibender-app lint:tokens` and any milestone-specific build/soak; (2) runs gitleaks tier-1 **and**
tier-2 (`~/.aibender/private/gitleaks-tier2.toml --redact`) full-tree; (3) runs the milestone's synthetic
acceptance demo; (4) writes `docs/runbooks/mN-dod.md` with **honest** per-item status (live proofs =
pending-owner); (5) lands grouped conventional commits; (6) returns SHAs + totals + consolidated
pending-owner items. Known-OK: tier-2 flags 12 `.git/logs` reflog echoes of the root-commit identity —
report as pre-existing pending-owner, not a working-tree leak (§HANDOFF-6).

## 7. Ready-to-adapt script — **M2-remaining** (`stage2-m2-impl`)

This is the next thing to run. Freeze is already committed, so this script starts at Build. Fill the
implementer briefs from plan §4 (BE-2/BE-3/BE-4), §5 (FE-2/FE-3/FE-5), §6 (SI-3/SI-6) — the HANDOFF §9.1
table is the condensed version. Structure (elided prose = paste the full plan brief):

```js
export const meta = {
  name: 'stage2-m2-impl',
  description: 'Stage 2 M2 remaining: 8 implementers + reviews + gate (freeze already committed 533cfb8)',
  phases: [
    { title: 'Build',  detail: '8 implementers in parallel across BE/FE/SI' },
    { title: 'Review', detail: 'three orchestrator principal-engineer reviews' },
    { title: 'Fix',    detail: 'apply required fixes per department' },
    { title: 'Gate',   detail: 'tests, 6-PTY soak, echo-latency, Tauri --smoke-test build, gitleaks, commits' },
  ],
}
const REPO = '/Users/chris.dare/Personal/SourceCode/the-last-aibender'
const COMMON = `<paste §3 preamble; "Landed so far: M0, M1, and the M2 protocol freeze (FROZEN-M2 at 533cfb8)">`
const IMPL_SCHEMA = /* §4 */; const REVIEW_SCHEMA = /* §4 */

phase('Build')
const built = await parallel([
  () => agent(COMMON + `\n## BE-2 · ptyHost — plan §4/BE-2 ...<full brief>`,  { label: 'BE-2:ptyhost',      phase: 'Build', schema: IMPL_SCHEMA }),
  () => agent(COMMON + `\n## BE-3 full · gateway streaming — plan §4/BE-3 ...`, { label: 'BE-3:gateway-full',  phase: 'Build', schema: IMPL_SCHEMA }),
  () => agent(COMMON + `\n## BE-4 · adapters — plan §4/BE-4 ...`,              { label: 'BE-4:adapters',      phase: 'Build', schema: IMPL_SCHEMA }),
  () => agent(COMMON + `\n## FE-2 · chrome/shell — plan §5/FE-2 ...`,          { label: 'FE-2:chrome-shell',  phase: 'Build', schema: IMPL_SCHEMA }),
  () => agent(COMMON + `\n## FE-3 · islands — plan §5/FE-3 ...`,               { label: 'FE-3:islands',       phase: 'Build', schema: IMPL_SCHEMA }),
  () => agent(COMMON + `\n## FE-5 · launchers (M2 slice) — plan §5/FE-5 ...`,  { label: 'FE-5:launchers',     phase: 'Build', schema: IMPL_SCHEMA }),
  () => agent(COMMON + `\n## SI-3 · hooks/launchd — plan §6/SI-3 ...`,         { label: 'SI-3:hooks-launchd', phase: 'Build', schema: IMPL_SCHEMA }),
  () => agent(COMMON + `\n## SI-6 · CI/live-check — plan §6/SI-6 ...`,         { label: 'SI-6:ci-livecheck',  phase: 'Build', schema: IMPL_SCHEMA }),
])
const [be2, be3, be4, fe2, fe3, fe5, si3, si6] = built

// ICR sweep
const icrs = built.filter(Boolean).flatMap(r => r.icr_requests || [])
let icr = null
if (icrs.length) icr = await agent(COMMON + `\n## BE-ORCH stewarding ICRs. Own packages/* (+ importing call-sites only for promoted exports). Land with tests:\n` + JSON.stringify(icrs,null,1), { label:'BE-ORCH:icr', phase:'Build', schema: IMPL_SCHEMA })

phase('Review')
const dg = r => r ? JSON.stringify({s:r.summary,f:r.files_created,t:r.tests_passed,p:r.pending_owner_items||[],n:r.notes||''}) : 'AGENT FAILED'
const RC = `# ORCHESTRATOR review (plan §1.1) of uncommitted M2 work at ${REPO}. Verify vs blueprint/plan/contracts YOURSELF; run tests YOURSELF; run gitleaks tier-1 YOURSELF. Material fixes only.`
const reviews = await parallel([
  () => agent(RC + `\n## BE-ORCH: review BE-2/BE-3/BE-4(+icr). ${dg(be2)} ${dg(be3)} ${dg(be4)} ${dg(icr)}\nScrutinize: flow-control boundedness under slow consumer; PTY bytes never parsed (arch test); approval double-decision idempotence; SecretFetcher never serialized + opt-in-gated (fs-audit); SSE dedupe on duplicate sync wrappers; credential-table guard blocks; golden corpus covers every invalid frame; no cost-incurring calls in tests.`, { label:'BE-ORCH:review', phase:'Review', schema: REVIEW_SCHEMA }),
  () => agent(RC + `\n## FE-ORCH: review FE-2/FE-3/FE-5. ${dg(fe2)} ${dg(fe3)} ${dg(fe5)}\nScrutinize: DESIGN.md conformance (run lint:tokens + eyeball inline styles); streaming discipline (render-count assertion real; ring buffers non-reactive); attachRenderer 8 clauses vs spike-A; follow-guard fidelity vs spike-C; approval-inbox decision races; picker can never render a raw identifier (audit test); locked-dep pins; --smoke-test exits 0 headless.`, { label:'FE-ORCH:review', phase:'Review', schema: REVIEW_SCHEMA }),
  () => agent(RC + `\n## SI-ORCH: review SI-3/SI-6. ${dg(si3)} ${dg(si6)}\nScrutinize: hook installer merge-never-overwrite (hostile fixture); plists lint + Aqua session type + KeepAlive; statusline tee vs synthetic stdin; CI runs on CURRENT tree (verify locally); live-check honestly SKIPs pending-owner with runbook pointers; no real identity anywhere; workflow permissions contents:read.`, { label:'SI-ORCH:review', phase:'Review', schema: REVIEW_SCHEMA }),
])
const [beRev, feRev, siRev] = reviews

phase('Fix')
const jobs = []
if (beRev?.verdict==='fixes_required' && beRev.fixes.length) jobs.push({d:'BE',fixes:beRev.fixes,scope:'packages/* + core/src/{kernel,gateway,adapters} + docs/contracts'})
if (feRev?.verdict==='fixes_required' && feRev.fixes.length) jobs.push({d:'FE',fixes:feRev.fixes,scope:'app/ (theme changes need an ADR)'})
if (siRev?.verdict==='fixes_required' && siRev.fixes.length) jobs.push({d:'SI',fixes:siRev.fixes,scope:'infra/{launchd,hooks,ci} + .github/workflows + docs/runbooks'})
let fixes = []
if (jobs.length) fixes = (await parallel(jobs.map(j => () => agent(COMMON + `\n## ${j.d} fix implementer. Apply EVERY fix within scope (${j.scope}), re-run relevant tests, report honestly.\n` + JSON.stringify(j.fixes,null,1), { label:'fix:'+j.d, phase:'Fix', schema: IMPL_SCHEMA })))).filter(Boolean)

phase('Gate')
const gate = await agent(
  COMMON.replace('2. GIT: you never commit/push; the serial gate agent commits.',
    '2. GIT: YOU are the serial committer — git add/commit locally, never push/rewrite history; pre-commit hook always runs, never --no-verify (false positives: minimal tier-1 allowlist + SECURITY.md note).')
  + `\n## M2 GATE agent.\n1. pnpm install; -r typecheck; -r test; run test:infra; lint:tokens; pnpm -F aibender-app build.\n2. Tauri smoke: cargo build app/src-tauri (debug) + run binary --smoke-test; report honestly (broken build = FAILURE to report, not hide).\n3. Integration (plan §9.3 runnable now): golden corpus vs BOTH FE client and BE gateway; 6-PTY flow-control soak vs REAL gateway+ptyHost with synthetic TUIs (bounded memory, zero byte loss, one slow consumer); approval round-trip (canUseTool→inbox→decision→proceed); echo-latency p95 (synthetic PTY).\n4. gitleaks tier-1 + tier-2 (--redact) full-tree; note the known .git/logs reflog echoes as pre-existing pending-owner.\n5. Write docs/runbooks/m2-dod.md (plan §8.2 M2, honest; real login/TUI/echo-under-load = T3 pending-owner).\n6. Serial conventional commits grouped: (a) feat: ptyHost with flow-controlled attended sessions and approval broker; (b) feat: gateway streaming with reconnect replay and approvals; (c) feat: opencode and lm-studio adapters with residency policy; (d) feat: tauri shell, cockpit chrome, ws client and state layer; (e) feat: terminal and transcript islands; (f) feat: one-off prompt and skill launchers; (g) chore: hooks, launchd templates, CI expansion and live-check runner; (h) docs: M2 DoD record.\n7. Return SHAs, test totals, soak/latency numbers, consolidated pending-owner.`,
  { label:'M2:gate-committer', phase:'Gate', schema: {
    type:'object', required:['commits','gitleaks_clean','tests_green','soak_passed','tauri_smoke','pending_owner_items'],
    properties:{ commits:{type:'array',items:{type:'string'}}, gitleaks_clean:{type:'boolean'}, tests_green:{type:'boolean'}, soak_passed:{type:'boolean'}, tauri_smoke:{type:'string'}, test_evidence:{type:'string'}, pending_owner_items:{type:'array',items:{type:'string'}}, notes:{type:'string'} } } })

return { built: built.map(b=>b&&b.summary), reviews:{BE:beRev,FE:feRev,SI:siRev}, fixes:fixes.map(f=>f.summary), gate }
```

## 8. After the workflow returns — YOUR verification (do not skip)

1. Read the gate's structured return + the `<taskid>.output` file. Confirm `gitleaks_clean`,
   `tests_green`, `soak_passed`, and a non-empty `commits[]`.
2. Independently: `git log --oneline`, `git status` (expect clean), `pnpm -r test`,
   `gitleaks dir . --config .gitleaks.toml`.
3. Read `docs/runbooks/m2-dod.md` for honesty — every "done" should cite evidence; live proofs should be
   marked pending-owner, not silently claimed.
4. If the workflow **died mid-run** (usage/session limit): check `git status` for uncommitted survivor
   work; verify it (typecheck+tests+gitleaks) and commit it by hand with the message the gate would have
   used; then author a follow-up workflow for the phases that didn't run. (You cannot `resumeFromRunId`
   across sessions.)
5. Update `docs/HANDOFF.md` §3 (status ledger) and the program memory so the *next* handoff is accurate.

## 9. Sizing note

Each milestone is ~10–16 agents and can run ~1–2 hours. To reduce the blast radius of a mid-run limit,
keep one Workflow per milestone (never chain two milestones in one run), and let the serial gate commit
at the end so committed progress is never lost.
