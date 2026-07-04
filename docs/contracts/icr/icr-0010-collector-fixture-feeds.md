# ICR-0010 — Promote BE-5's collector fixture feeds into @aibender/testkit

- Requesting lane: BE-E (BE-5 · collector), via the BE-5 M3 return
- Surface: `packages/testkit`
- Freeze state at request time: n/a (testkit "grows continuously", plan §3)

## Motivation

Plan §3's "still to come" testkit list pre-announced exactly these two
deliverables: the **fake statusline stdin feed** and the **fake OTLP
emitter**. BE-5 built both inline in its collector suites
(`core/src/collector/quota/quota.spec.ts`,
`core/src/collector/otlp/otlp.spec.ts`) per the ICR-0001 precedent and
flagged them for promotion in its return. They are pure generators — no
server component — so any suite that feeds a quota tee directory or an OTLP
`/v1/logs` receiver can share the same synthesized shapes.

## Change (landed 2026-07-04)

Two modules added to `packages/testkit/src/`:

- **`statuslineFeed.ts`** — `synthesizedStatuslinePayload()` (one statusline
  render-tick JSON, defaulting byte-for-byte to the SI-3 bats fixture shape
  in `infra/hooks/tests/hooks.bats` `statusline_fixture()`: `session_id`,
  `model`, `cwd`, `cost`, `context_window`, `rate_limits.five_hour/seven_day`
  with optional `seven_day_sonnet`, ISO or epoch `resets_at`) +
  `writeStatuslineTee()` (the aibender-statusline.sh tee semantics: verbatim
  write to `<quotaDir>/<label>.json`, optional pinned `mtimeMs` because the
  collector treats mtime as the capture instant).
- **`otlpEmitter.ts`** — `otlpAttr()` (OTLP JSON KeyValue encodings),
  `otlpLogsBatch()` (resourceLogs → scopeLogs envelope, scope
  `com.anthropic.claude_code`), `otlpApiRequestRecord()` (the `api_request`
  log record with the full attribution attribute set), plus the two
  runtime-joined identity drop probes `SYNTHETIC_OTLP_EMAIL` /
  `SYNTHETIC_OTLP_ACCOUNT_UUID` — identity-SHAPED by design (their job is
  proving ingest drops them [X2]), built at runtime so no committed fixture
  carries an identity-shaped literal, exempt from the generator screen and
  the only exemption.

Fixture policy [X2] honored: every other free-text input passes
`assertSynthesizedSafeText`. Zero new dependencies. Sanity suites
(`statuslineFeed.spec.ts`, `otlpEmitter.spec.ts`) landed with the promotion;
deep behavioral coverage stays in the consuming collector suites.

## Compatibility

Move semantics, per the ICR-0001 landing record: the inline builders were
deleted from `quota.spec.ts`/`otlp.spec.ts` and those suites switched to the
`@aibender/testkit` imports in the same change (both suites re-proven green).
No production code touched.

## Sign-off

- Owning orchestrator (BE-ORCH): **landed 2026-07-04**
- Counterpart orchestrator: n/a (test-only surface)
