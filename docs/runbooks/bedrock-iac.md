# Runbook: Bedrock cost-attribution IaC (SI-4) — owner plan/apply sequence

**Status: PENDING-OWNER.** The stack in `infra/aws/` is authored, validated
locally (fmt + validate + bats, no cloud calls), and **hard-gated**:
`terraform plan` is owner-run, and `terraform apply` requires the owner's
**explicit verbal OK per the External System Write Policy**. No script, CI
job, or agent ever runs plan-with-credentials or apply — the SI-4 bats suite
asserts apply is absent from CI by construction, and
`infra/ci/live-check.sh --check aws-sso-plan` reports SKIP(pending-owner)
pointing here until the owner completes this sequence.

[X2]: this runbook uses placeholders only (`AWS_DEV_ACCOUNT_ID`,
`<sso-profile>`). Real values live exclusively in the owner's untracked
`infra/aws/terraform.tfvars` (gitignored) and shell.

## 0. What the stack creates (review target)

1. **Application inference profile** (`aws_bedrock_inference_profile`) copied
   from a system `us.anthropic.claude-*` profile, tagged with the
   cost-allocation tag (`aibender-project = the-last-aibender` by default).
   Its **opaque ARN** is the OpenCode wire model id — the system-profile ARN
   must never be used on the wire (opencode region-prefix-mangles ids
   containing `claude`; findings `opencode-serve-event-probe.md` §6).
2. **Read-only telemetry IAM**: policy + role granting exactly
   `ce:GetCostAndUsage` and `cloudwatch:GetMetricData`
   (namespace-conditioned to `AWS/Bedrock`), the policy doubling as the
   role's permissions boundary.
3. **Optionally** (`activate_cost_allocation_tag = true`, second apply):
   Billing-side activation of the cost-allocation tag key
   (`aws_ce_cost_allocation_tag`).

## 1. Local validation (anyone, no credentials — already green at M3)

```sh
terraform -chdir=infra/aws init -backend=false   # provider download only
terraform -chdir=infra/aws validate
terraform fmt -check -recursive infra/aws
bash infra/aws/tests/run.sh
```

Recorded at build time: validate green on hashicorp/aws v6.53.0; a
credential-scrubbed plan attempt fails cleanly with a credential-resolution
error and **no partial state** (this is the expected pre-owner outcome and is
pinned as a bats edge test).

## 2. Pre-plan checks (owner)

1. `aws sso login --profile <sso-profile>` — **interactive, owner-run only.**
2. Confirm the system inference profile id to copy from:

   ```sh
   aws --profile <sso-profile> --region us-east-1 bedrock list-inference-profiles \
     --query 'inferenceProfileSummaries[].inferenceProfileId'
   ```

   Pick the `us.anthropic.claude-*` id matching the model the harness routes
   to Bedrock, and set `source_inference_profile_id` in tfvars.
3. Create the tfvars:

   ```sh
   cp infra/aws/terraform.tfvars.example infra/aws/terraform.tfvars
   $EDITOR infra/aws/terraform.tfvars   # real AWS_DEV_ACCOUNT_ID, profile id, prices
   ```

   `terraform.tfvars` is gitignored; never commit it. Pin
   `model_cost_per_mtok` to the current Bedrock prices for the chosen model
   (the defaults are Opus-tier sticker seeds).

## 3. Plan → review → STOP

```sh
cd infra/aws
AWS_PROFILE=<sso-profile> terraform plan -input=false -out=plan.out
```

(`plan.out` is gitignored.) Review checklist:

- [ ] Exactly the resources in §0 — nothing else, nothing destroyed.
- [ ] Profile `model_source.copy_from` names the intended system profile in
      the intended account/region.
- [ ] Profile tags carry the cost-allocation key/value.
- [ ] IAM policy shows only the two read actions; `GetMetricData` carries the
      `cloudwatch:namespace = AWS/Bedrock` condition.
- [ ] Assume-role trust is the account root (or the narrowed SSO role ARN if
      set in tfvars).

**STOP HERE.** Apply proceeds only on the owner's explicit verbal OK for this
specific plan.

## 4. Apply (owner, after verbal OK) and verify

```sh
terraform apply plan.out
terraform output application_inference_profile_arn
terraform output -json opencode_model_config
```

Verify the poller grants with a **read-only** probe (assume the poller role,
then one `GetMetricData` call against `AWS/Bedrock` and one `GetCostAndUsage`
call — note Cost Explorer bills ~$0.01 per request, so once is enough).

**Fallback (documented caveat):** if `GetMetricData` returns AccessDenied
under the namespace condition, the IAM engine is not honoring the
`cloudwatch:namespace` key for that action — set
`restrict_cloudwatch_namespace = false` in tfvars and re-run the plan → verbal
OK → apply loop (the action remains read-only without the condition).

## 5. Cost-allocation tag activation (second gated apply)

AWS lists a user-defined tag key as activatable only after it appears on
billed usage (up to ~24 h). After the first Bedrock traffic through the
profile:

1. Set `activate_cost_allocation_tag = true` in tfvars.
2. Re-run §3 (plan shows only the `aws_ce_cost_allocation_tag` add) → verbal
   OK → apply.

Until activation, Cost Explorer cannot slice by the tag and **AWS-side
attribution reads 0** — this is expected, not a poller bug.

## 6. Estimate-only mode until apply (BE-5 wiring)

Until the applies in §4–§5 land:

- **BE-5 runs estimate-only.** `cost_estimated_usd` (client-side prices
  table + OpenCode cost blocks) is the only cost feed;
  `cost_actual_usd` stays absent — never zero-filled.
- The Bedrock USD dashboard lead (blueprint §6.3) renders the client-side
  estimate overlay with an **honest freshness state** — the actuals source
  reports not-provisioned/SSO-expired as a first-class freshness state, never
  as an error (blueprint §6.3 last paragraph).
- AWS pollers are exercised against fakes only; **no live AWS API calls in
  tests** (Cost Explorer charges per request).

After apply, wire the outputs:

1. Paste `opencode_model_config` into the owner's machine-local opencode
   config (never into this repo — the rendered stanza contains the real
   profile ARN [X2]). The key contains `claude` and carries the explicit
   `cost` block by construction.
2. Point BE-5's poller config at `poller_role_arn`; Cost Explorer polls 1–2x
   per day, CloudWatch `AWS/Bedrock` every 5–15 min while active (blueprint
   §6.1).
3. Re-run `infra/ci/live-check.sh --check aws-sso-plan` — it stays a SKIP
   until SI-6 wires a post-apply liveness probe; the milestone record of the
   plan/apply belongs in the M3 DoD notes.

## 7. Change management

Any later edit to `infra/aws/` repeats the full loop: local validate + bats →
owner plan → review → **verbal OK** → apply. There is no standing
authorization.
