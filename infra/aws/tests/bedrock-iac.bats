#!/usr/bin/env bats
# bedrock-iac.bats — SI-4 tests (plan §9.2 SI-4 row).
#
#   positive — fmt/validate green; the (would-be) plan renders a profile with
#              a cost-allocation tag + a claude-containing OpenCode config key
#              + an explicit cost block; IAM is read-only by construction
#   negative — a literal 12-digit id anywhere in infra/aws source fails the
#              hygiene grep (all-zeros placeholder exempt, detector proven
#              against a seeded literal); apply is absent from CI by
#              construction
#   edge     — plan against missing credentials → clear failure, no partial
#              state (the SSO-session-missing case, run with scrubbed env +
#              IMDS disabled so no live AWS call is possible)
#
# Fully headless: no credentials, no AWS API calls, no `terraform apply`
# anywhere. terraform-dependent tests skip when terraform or the provider
# plugins (network) are unavailable.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  AWS_DIR="$REPO_ROOT/infra/aws"
}

have_terraform() { command -v terraform >/dev/null 2>&1; }

# Providers present? (init -backend=false downloads plugins — network — so we
# only *use* an existing .terraform, never create one from the suite.)
have_providers() { [ -d "$AWS_DIR/.terraform/providers" ]; }

# The hygiene detector shared by the negative tests: prints every run of 12+
# consecutive digits that is NOT all zeros, found in IaC source files under
# $1. Scope mirrors what gitleaks scans (tracked source), so the generated
# .terraform/ tree and the .terraform.lock.hcl hash blobs are excluded.
find_nonzero_12digit() {
  local dir="$1"
  find "$dir" \
    -path '*/.terraform' -prune -o \
    -type f \( -name '*.tf' -o -name '*.md' -o -name '*.example' -o -name '*.bats' -o -name '*.sh' -o -name '.gitignore' \) \
    -print0 |
    xargs -0 grep -rEoh '[0-9]{12,}' 2>/dev/null |
    grep -Ev '^0+$' || true
}

# --- positive ----------------------------------------------------------------

@test "terraform fmt -check is clean" {
  have_terraform || skip "terraform not installed"
  run terraform fmt -check -recursive "$AWS_DIR"
  [ "$status" -eq 0 ]
}

@test "terraform validate is green (no cloud calls)" {
  have_terraform || skip "terraform not installed"
  have_providers || skip "provider plugins not initialized — run: terraform -chdir=infra/aws init -backend=false"
  run terraform -chdir="$AWS_DIR" validate
  [ "$status" -eq 0 ]
  grep -q 'valid' <<<"$output"
}

@test "OpenCode config key contains 'claude' and is validation-enforced" {
  # Default value carries the substring...
  run grep -A3 'variable "opencode_model_key"' "$AWS_DIR/variables.tf"
  # ...and a validation block pins it for any override (feature gates key off
  # the substring — opencode-serve-event-probe.md §6).
  grep -q 'regex("claude", var.opencode_model_key)' "$AWS_DIR/variables.tf"
  # -A30 spans the heredoc description down to the default line.
  grep -Eq 'default[[:space:]]*=[[:space:]]*"[^"]*claude[^"]*"' <(grep -A30 'variable "opencode_model_key"' "$AWS_DIR/variables.tf")
}

@test "rendered OpenCode model stanza carries an explicit cost block" {
  # Without a cost block opencode computes cost 0 for a custom model id.
  grep -q 'opencode_model_config' "$AWS_DIR/outputs.tf"
  grep -q 'cost = {' "$AWS_DIR/outputs.tf"
  grep -q 'input ' "$AWS_DIR/outputs.tf"
  grep -q 'output ' "$AWS_DIR/outputs.tf"
  grep -q 'read ' "$AWS_DIR/outputs.tf"
  grep -q 'write ' "$AWS_DIR/outputs.tf"
}

@test "inference profile carries the cost-allocation tag; system ARN is copy_from only" {
  grep -q 'resource "aws_bedrock_inference_profile"' "$AWS_DIR/main.tf"
  grep -q 'copy_from' "$AWS_DIR/main.tf"
  # The explicit tag block on the profile (AWS-side cost attribution).
  grep -q 'var.cost_allocation_tag_key' "$AWS_DIR/main.tf"
  # Region-prefix-mangling guard: the system profile id must never leak into
  # the outputs — only the application profile ARN is a wire model id.
  ! grep -q 'source_inference_profile' "$AWS_DIR/outputs.tf"
}

@test "IAM is read-only: exactly the two poller actions plus sts:AssumeRole" {
  # Collect every quoted action literal in iam.tf.
  run grep -Eoh '"(sts|ce|cloudwatch|iam|s3|ec2|bedrock)[^"]*"' "$AWS_DIR/iam.tf"
  actions="$(grep -Eoh '"[a-z0-9-]+:[A-Za-z*]+"' "$AWS_DIR/iam.tf" | sort -u)"
  expected='"ce:GetCostAndUsage"
"cloudwatch:GetMetricData"
"cloudwatch:namespace"
"sts:AssumeRole"'
  [ "$actions" = "$expected" ]
  # No wildcard actions, no mutating verbs anywhere in the policy file.
  ! grep -Eq '"[a-z0-9-]+:\*"' "$AWS_DIR/iam.tf"
  ! grep -Eq ':(Put|Create|Delete|Update|Write|Attach|Tag|Untag)[A-Za-z]*"' "$AWS_DIR/iam.tf"
}

@test "GetMetricData is namespace-scoped to AWS/Bedrock by default" {
  grep -q 'cloudwatch:namespace' "$AWS_DIR/iam.tf"
  grep -q 'AWS/Bedrock' "$AWS_DIR/variables.tf"
  # Scoping defaults ON (fallback is an explicit tfvars decision, runbook §4).
  grep -A20 'variable "restrict_cloudwatch_namespace"' "$AWS_DIR/variables.tf" | grep -Eq 'default[[:space:]]*=[[:space:]]*true'
}

@test "every identifier is a variable: account id and region never literal in resources" {
  # No hardcoded account id or region inside resource/data/locals blocks —
  # main.tf/iam.tf/outputs.tf must only reference var.aws_account_id /
  # var.aws_region. (variables.tf holds the documented placeholder defaults.)
  for f in main.tf iam.tf outputs.tf; do
    ! grep -E '[0-9]{12}' "$AWS_DIR/$f"
    ! grep -E '"(us|eu|ap|ca|sa)-[a-z]+-[0-9]"' "$AWS_DIR/$f"
  done
  grep -q 'var.aws_account_id' "$AWS_DIR/main.tf"
  grep -q 'var.aws_account_id' "$AWS_DIR/iam.tf"
}

# --- negative ----------------------------------------------------------------

@test "hygiene: no non-zero 12-digit literal anywhere in infra/aws source" {
  found="$(find_nonzero_12digit "$AWS_DIR")"
  if [ -n "$found" ]; then
    echo "forbidden 12-digit literal(s) found: $found" >&2
    return 1
  fi
}

@test "hygiene detector actually catches a seeded literal (self-test)" {
  seeded="$BATS_TEST_TMPDIR/seeded"
  mkdir -p "$seeded"
  # Assemble the synthesized id at runtime from two 6-digit halves so the
  # 12-digit run never appears verbatim in this file (it would trip the
  # hygiene grep above and the gitleaks backstop [X2]).
  fake_id="$(printf '%s%s' '123456' '789012')"
  printf 'aws_account_id = "%s" # synthesized, not a real account\n' "$fake_id" > "$seeded/leak.tf"
  found="$(find_nonzero_12digit "$seeded")"
  [ "$found" = "$fake_id" ]
  # ...and the documented all-zeros placeholder passes.
  printf 'aws_account_id = "000000000000"\n' > "$seeded/leak.tf"
  found="$(find_nonzero_12digit "$seeded")"
  [ -z "$found" ]
}

@test "apply is absent from CI and test tooling by construction" {
  # Strip comment lines the way the SI-6 hygiene test does, then prove no
  # non-comment line anywhere in CI or the infra test runners invokes apply.
  files=$(find "$REPO_ROOT/.github/workflows" "$REPO_ROOT/infra/ci" "$REPO_ROOT/infra/aws/tests" \
    -type f \( -name '*.yml' -o -name '*.yaml' -o -name '*.sh' -o -name '*.bats' \) 2>/dev/null)
  for f in $files; do
    if grep -vE '^[[:space:]]*#' "$f" | grep -Eq 'terraform[[:space:]]+apply'; then
      echo "apply invocation found in: $f" >&2
      return 1
    fi
  done
}

@test "real tfvars are gitignored; only the placeholder example is tracked" {
  grep -q '^\*.tfvars$' "$AWS_DIR/.gitignore"
  [ -f "$AWS_DIR/terraform.tfvars.example" ]
  # The example must carry the documented placeholder, not a real-looking id.
  grep -q '000000000000' "$AWS_DIR/terraform.tfvars.example"
  # git-level proof where a repo is available (worktree layouts may differ).
  if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    run git -C "$REPO_ROOT" check-ignore -q infra/aws/terraform.tfvars
    [ "$status" -eq 0 ]
    run git -C "$REPO_ROOT" check-ignore -q infra/aws/terraform.tfvars.example
    [ "$status" -ne 0 ]
  fi
}

# --- edge --------------------------------------------------------------------

@test "plan against missing SSO session: clear failure, no partial state" {
  have_terraform || skip "terraform not installed"
  have_providers || skip "provider plugins not initialized — run: terraform -chdir=infra/aws init -backend=false"
  # Scrubbed env + IMDS disabled: credential resolution must fail before any
  # network call can happen — this is the §9.2 SI-4 edge case run headless.
  run env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN -u AWS_DEFAULT_PROFILE \
    AWS_EC2_METADATA_DISABLED=true \
    AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    TF_IN_AUTOMATION=1 \
    terraform -chdir="$AWS_DIR" plan -input=false -no-color -lock=false
  [ "$status" -ne 0 ]
  grep -Eqi 'credential|IMDS|no valid' <<<"$output"
  [ ! -f "$AWS_DIR/terraform.tfstate" ]
  [ ! -f "$AWS_DIR/errored.tfstate" ]
}
