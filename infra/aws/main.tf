# main.tf — SI-4 · Bedrock application inference profile for cost attribution.
#
# HARD GATE (External System Write Policy, plan §6/SI-4): this stack is
# plan-then-STOP. `terraform apply` runs ONLY after the owner's explicit
# verbal OK. Runbook: docs/runbooks/bedrock-iac.md. Until applied, BE-5 runs
# in estimate-only mode with an honest freshness state.
#
# Why an APPLICATION inference profile (opencode-serve-event-probe.md §6,
# blueprint §4.2):
#   * Cost attribution — the application profile carries our cost-allocation
#     tag, so Cost Explorer can segregate harness Bedrock spend from all other
#     traffic in the account.
#   * Region-prefix mangling — opencode's getModel() prepends us./eu./jp./...
#     when the model id CONTAINS "claude". A system-profile ARN
#     (…:inference-profile/us.anthropic.claude-…) contains "claude" and gets
#     mangled to "us.arn:…"; the application-profile ARN
#     (…:application-inference-profile/<opaque-id>) does not. The system
#     profile is therefore used ONLY as the copy_from source below, never as
#     the wire model id.

provider "aws" {
  region = var.aws_region

  # Wrong-account guard: with the placeholder default ("000000000000") any
  # accidental plan against live credentials fails fast instead of planning
  # into an unintended account. The owner's tfvars sets the real id.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = var.default_tags
  }
}

locals {
  # System (cross-region) inference profile ARN used strictly as the copy
  # source for the application profile. See the variable docs for why this id
  # never appears in any OpenCode config.
  source_inference_profile_arn = "arn:aws:bedrock:${var.aws_region}:${var.aws_account_id}:inference-profile/${var.source_inference_profile_id}"
}

resource "aws_bedrock_inference_profile" "aibender_claude" {
  name        = var.inference_profile_name
  description = var.inference_profile_description

  model_source {
    copy_from = local.source_inference_profile_arn
  }

  # EXPLICIT cost-allocation tag — the AWS-side half of cost attribution.
  # Cost Explorer only slices by this key once it is activated
  # (aws_ce_cost_allocation_tag below); the client-side half is the cost
  # block in the opencode_model_config output.
  tags = {
    (var.cost_allocation_tag_key) = var.cost_allocation_tag_value
  }
}

# Billing-side activation of the cost-allocation tag key. Gated behind a
# variable because AWS only accepts activation after the key has appeared on
# billed usage (~24 h lag) — first apply runs with this off; see runbook §5.
resource "aws_ce_cost_allocation_tag" "aibender_project" {
  count = var.activate_cost_allocation_tag ? 1 : 0

  tag_key = var.cost_allocation_tag_key
  status  = "Active"
}
