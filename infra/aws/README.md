# infra/aws — SI-4 · Bedrock cost-attribution IaC (HARD-GATED)

Terraform stack for the **application inference profile** that segregates
harness Bedrock traffic for cost attribution, plus the **read-only telemetry
IAM** (role + policy) for the BE-5 Cost Explorer / CloudWatch pollers.

Normative sources: plan §6/SI-4, blueprint §4.2 + §6.1,
`docs/research/findings/opencode-serve-event-probe.md` §6.

## The hard gate

**`terraform plan` is shown, then STOP.** `terraform apply` runs only after
the owner's explicit verbal OK (External System Write Policy). Nothing in this
directory, in CI, or in `infra/ci/live-check.sh` ever runs apply — the bats
suite asserts apply is absent from CI by construction. Owner sequence (SSO
login → plan → review → verbal OK → apply) is in
[`docs/runbooks/bedrock-iac.md`](../../docs/runbooks/bedrock-iac.md).
Until applied, **BE-5 runs estimate-only** with an honest freshness state.

## What it builds

| Resource | Why |
|---|---|
| `aws_bedrock_inference_profile.aibender_claude` | Application inference profile copied from a system `us.anthropic.claude-*` profile. Carries the cost-allocation tag; its opaque ARN is the OpenCode wire model id. |
| `aws_ce_cost_allocation_tag` (gated) | Billing-side activation of the tag key — off for the first apply (AWS lags ~24 h before a new key is activatable). |
| `aws_iam_policy.poller_readonly` | Exactly `ce:GetCostAndUsage` + `cloudwatch:GetMetricData` (namespace-conditioned to `AWS/Bedrock`). No writes, ever. |
| `aws_iam_role.poller` | Assume-gated role for BE-5, with the read-only policy doubling as its permissions boundary. |

Key design points (findings §6):

* **Application profile ARN, never the system ARN, is the wire model id** —
  opencode's `getModel()` region-prefix-mangles any model id containing
  `claude` (`us.arn:...`); the application ARN's opaque suffix passes clean.
  The system profile appears only as `model_source.copy_from`.
* **The OpenCode config key must contain `claude`** and **must carry an
  explicit `cost` block** (else client-side cost computes 0). Both are
  enforced by variable validation and rendered by the
  `opencode_model_config` output.

## [X2] identifier hygiene

Every identifier is a variable. `AWS_DEV_ACCOUNT_ID` is never literal in the
tree — the default `"000000000000"` is the documented all-zeros placeholder,
and the provider `allowed_account_ids` guard makes it refuse to plan against
any live account until the owner's untracked `terraform.tfvars` (gitignored
here) supplies the real id. `tests/bedrock-iac.bats` greps the tree: any
12-digit literal that is not all zeros fails the suite (gitleaks backstops in
CI).

## Local verification (no cloud calls, no credentials)

```sh
terraform -chdir=infra/aws init -backend=false   # provider download only
terraform -chdir=infra/aws validate
terraform fmt -check -recursive infra/aws
bash infra/aws/tests/run.sh                       # shellcheck + bats
```

`terraform plan` is NOT part of local verification — it requires live SSO
credentials and is owner-run (runbook §3). The bats suite includes a negative
proof that a credential-less plan fails cleanly with no partial state.
