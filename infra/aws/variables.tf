# variables.tf — SI-4 Bedrock cost-attribution stack.
#
# [X2] PUBLIC REPO RULE: EVERY identifier in this stack is a variable. No real
# AWS account id, ARN fragment, e-mail, or key material may ever appear as a
# literal anywhere under infra/aws/. Defaults below are syntactically valid but
# OBVIOUSLY FAKE placeholders ("000000000000" is the documented all-zeros
# placeholder for AWS_DEV_ACCOUNT_ID). Real values live ONLY in an untracked
# *.tfvars file (gitignored here; see terraform.tfvars.example) on the owner's
# machine. The bats suite (tests/bedrock-iac.bats) greps the tree to prove no
# other 12-digit literal exists.

# --- identity -----------------------------------------------------------------

variable "aws_account_id" {
  description = <<-EOT
    The AWS_DEV_ACCOUNT_ID. PLACEHOLDER DEFAULT: "000000000000" is the
    documented all-zeros stand-in and never a real account. The owner sets the
    real id in the untracked terraform.tfvars before running plan.
  EOT
  type        = string
  default     = "000000000000"

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be exactly 12 digits."
  }
}

variable "aws_region" {
  description = "Region for the application inference profile and IAM home region for the pollers."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must look like an AWS region id (e.g. us-east-1)."
  }
}

# --- application inference profile ---------------------------------------------

variable "inference_profile_name" {
  description = "Name of the application inference profile that segregates harness Bedrock traffic (blueprint §6.1 collection matrix)."
  type        = string
  default     = "aibender-claude-harness"
}

variable "inference_profile_description" {
  description = "Human-readable description stamped on the application inference profile."
  type        = string
  default     = "the-last-aibender harness traffic — cost attribution profile (SI-4)"
}

variable "source_inference_profile_id" {
  description = <<-EOT
    The SYSTEM-DEFINED (cross-region) inference profile id the application
    profile copies from, e.g. a "us.anthropic.claude-*" id. PLACEHOLDER
    DEFAULT: verify the exact id on the live account with
    `aws bedrock list-inference-profiles` before plan (runbook
    docs/runbooks/bedrock-iac.md §2). NOTE the split documented in
    docs/research/findings/opencode-serve-event-probe.md §6: the system
    profile is ONLY the copy_from source here — it must NEVER be used as the
    OpenCode wire model id, because ids containing "claude" get region-prefix
    mangled ("us.arn:...") by opencode's getModel(). The APPLICATION profile
    ARN (opaque suffix, no "claude" substring) is the wire id.
  EOT
  type        = string
  default     = "us.anthropic.claude-opus-4-8"

  validation {
    condition     = can(regex("^(us|eu|apac|jp|au)\\.", var.source_inference_profile_id))
    error_message = "source_inference_profile_id must be a cross-region system profile id (us./eu./apac./jp./au. prefix)."
  }
}

# --- cost allocation -------------------------------------------------------------

variable "cost_allocation_tag_key" {
  description = <<-EOT
    User-defined cost-allocation tag key stamped on the application inference
    profile. Cost Explorer can only slice Bedrock spend by this tag once the
    key is ACTIVATED as a cost-allocation tag (see activate_cost_allocation_tag)
    — without activation the harness's Cost Explorer poller filter matches
    nothing and actual USD reads 0 on the AWS side.
  EOT
  type        = string
  default     = "aibender-project"
}

variable "cost_allocation_tag_value" {
  description = "Value for the cost-allocation tag on the application inference profile."
  type        = string
  default     = "the-last-aibender"
}

variable "activate_cost_allocation_tag" {
  description = <<-EOT
    Whether to manage the Billing-side ACTIVATION of cost_allocation_tag_key
    (aws_ce_cost_allocation_tag). AWS only lists a tag key as activatable
    after it has appeared on billed usage (up to ~24 h lag), so the FIRST
    apply typically needs this false; flip to true in a follow-up apply once
    the key shows in the Billing console. Runbook §5.
  EOT
  type        = bool
  default     = false
}

# --- read-only telemetry IAM ------------------------------------------------------

variable "poller_role_name" {
  description = "Name of the read-only IAM role assumed by the Cost Explorer / CloudWatch pollers (BE-5)."
  type        = string
  default     = "aibender-telemetry-poller"
}

variable "poller_policy_name" {
  description = "Name of the read-only IAM policy attached to the poller role."
  type        = string
  default     = "aibender-telemetry-poller-readonly"
}

variable "poller_trusted_principal_arns" {
  description = <<-EOT
    Principals allowed to assume the poller role. Default [] falls back to the
    account root (arn:aws:iam::<aws_account_id>:root), which delegates the
    decision to IAM policies inside the account — the owner's SSO permission
    set can then assume it. Narrow this to the specific SSO role ARN in tfvars
    for tighter least privilege.
  EOT
  type        = list(string)
  default     = []
}

variable "restrict_cloudwatch_namespace" {
  description = <<-EOT
    When true (default), the cloudwatch:GetMetricData grant carries a
    StringEquals condition on the cloudwatch:namespace key, scoping reads to
    cloudwatch_metrics_namespace (AWS/Bedrock). CAVEAT (documented, unverified
    live — this stack is plan-gated): if the deployed IAM engine does not
    honor that condition key for GetMetricData, an Allow with the condition
    never matches and the poller gets AccessDenied. The runbook's plan/verify
    step (§4) covers this: on AccessDenied set this to false in tfvars
    (falling back to unconditioned GetMetricData — the action reads metric
    data only and remains read-only) and re-plan.
  EOT
  type        = bool
  default     = true
}

variable "cloudwatch_metrics_namespace" {
  description = "CloudWatch namespace the poller may read when restrict_cloudwatch_namespace is true."
  type        = string
  default     = "AWS/Bedrock"
}

# --- client-side estimate seed (OpenCode cost block) ------------------------------

variable "opencode_model_key" {
  description = <<-EOT
    Config key for the custom amazon-bedrock model entry rendered by the
    opencode_model_config output. MUST contain "claude": opencode's
    transform.ts gates prompt-caching (cachePoint) and other model-family
    features on the key containing claude — a key without it silently loses
    cache accounting (opencode-serve-event-probe.md §6).
  EOT
  type        = string
  default     = "claude-opus-aibender"

  validation {
    condition     = can(regex("claude", var.opencode_model_key))
    error_message = "opencode_model_key must contain the substring \"claude\" (feature gates key off it)."
  }
}

variable "model_cost_per_mtok" {
  description = <<-EOT
    USD-per-million-token seed for the EXPLICIT cost block in the rendered
    OpenCode model config. Without a cost block opencode computes cost 0 for
    a custom model id, breaking the instant-estimate feed (blueprint §6.2:
    cost_estimated_usd). These are estimate seeds only — BE-5's prices table
    (LiteLLM-seeded, pinned, overridable) stays authoritative, and Cost
    Explorer remains the actual-USD source. Defaults mirror the Opus-tier
    sticker (in 5 / out 25; cache read ~0.1x in, cache write ~1.25x in);
    the owner pins real Bedrock prices in tfvars at plan time.
  EOT
  type = object({
    input       = number
    output      = number
    cache_read  = number
    cache_write = number
  })
  default = {
    input       = 5.0
    output      = 25.0
    cache_read  = 0.5
    cache_write = 6.25
  }

  validation {
    condition = alltrue([
      var.model_cost_per_mtok.input >= 0,
      var.model_cost_per_mtok.output >= 0,
      var.model_cost_per_mtok.cache_read >= 0,
      var.model_cost_per_mtok.cache_write >= 0,
    ])
    error_message = "All model_cost_per_mtok entries must be >= 0."
  }
}

# --- tagging -----------------------------------------------------------------------

variable "default_tags" {
  description = "Tags applied to every resource in this stack via the provider default_tags block."
  type        = map(string)
  default = {
    "managed-by" = "terraform"
    "stack"      = "the-last-aibender/infra/aws"
    "owner"      = "aibender-si4"
  }
}
