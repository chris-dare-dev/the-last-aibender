/**
 * Collector error taxonomy (BE-5). Mirrors the BE-4 adapter pattern: every
 * live side effect (OAuth usage poll, AWS Cost Explorer / CloudWatch call)
 * sits behind an explicit opt-in flag with a TYPED refusal — nothing real
 * happens by accident in tests or by default composition (rule: pollers are
 * tested against fakes ONLY; live proofs are T3 pending-owner).
 */

export class CollectorError extends Error {
  override readonly name: string = 'CollectorError';
}

/**
 * Thrown when a live OAuth usage client is constructed without the explicit
 * `enableLiveOauth` opt-in. The idle-account usage poll hits an undocumented
 * endpoint with a Keychain-fetched token — owner-gated, never test-driven.
 */
export class LiveOauthDisabledError extends CollectorError {
  override readonly name = 'LiveOauthDisabledError';
  constructor() {
    super(
      'live OAuth usage polling is disabled: construct with enableLiveOauth: true ' +
        '(owner-gated, T3 pending-owner) — tests use a fake OauthUsageClient',
    );
  }
}

/**
 * Thrown when a live AWS client is constructed without the explicit
 * `enableLiveAws` opt-in. Cost Explorer charges $0.01/request and CloudWatch
 * calls hit the real account — live calls are forbidden in tests (plan §9.4;
 * SI-4 hard gate). Until SI-4 applies, BE-5 runs estimate-only.
 */
export class LiveAwsDisabledError extends CollectorError {
  override readonly name = 'LiveAwsDisabledError';
  constructor(surface: string) {
    super(
      `live AWS ${surface} polling is disabled: construct with enableLiveAws: true ` +
        '(owner-gated behind SI-4) — tests use fake clients ONLY',
    );
  }
}
