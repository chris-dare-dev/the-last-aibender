# outputs.tf — SI-4 · consumed by BE-5 (pollers) and the OpenCode adapter (BE-4).
#
# Values are known only AFTER the hard-gated apply. Until then BE-5 runs in
# estimate-only mode with an honest freshness state (runbook §6).

output "application_inference_profile_arn" {
  description = <<-EOT
    ARN of the application inference profile. THIS is the wire model id for
    the OpenCode custom amazon-bedrock model (opaque suffix — no "claude"
    substring, so it dodges opencode's region-prefix mangling). Never
    substitute the system-profile ARN here.
  EOT
  value       = aws_bedrock_inference_profile.aibender_claude.arn
}

output "application_inference_profile_id" {
  description = "Opaque id of the application inference profile."
  value       = aws_bedrock_inference_profile.aibender_claude.id
}

output "poller_role_arn" {
  description = "ARN of the read-only telemetry poller role (BE-5 assumes this)."
  value       = aws_iam_role.poller.arn
}

output "poller_policy_arn" {
  description = "ARN of the read-only poller policy."
  value       = aws_iam_policy.poller_readonly.arn
}

output "cost_allocation_tag" {
  description = "Cost-allocation tag stamped on the profile (activate in Billing per runbook §5 before Cost Explorer can slice by it)."
  value = {
    key       = var.cost_allocation_tag_key
    value     = var.cost_allocation_tag_value
    activated = var.activate_cost_allocation_tag
  }
}

output "opencode_model_config" {
  description = <<-EOT
    Rendered custom-model stanza for opencode.jsonc under
    provider["amazon-bedrock"].models (opencode-serve-event-probe.md §6
    config shape). Two load-bearing properties, both enforced by variable
    validation upstream:
      * the key contains "claude" (feature gates key off it), and
      * an EXPLICIT cost block is present (without it opencode computes
        cost 0 for a custom model id, breaking the instant-estimate feed).
    Paste into the owner's machine-local opencode config — never commit it
    to this repo with a real ARN in it [X2].
  EOT
  value = {
    (var.opencode_model_key) = {
      id   = aws_bedrock_inference_profile.aibender_claude.arn
      name = "Claude (aibender attribution profile)"
      cost = {
        input  = var.model_cost_per_mtok.input
        output = var.model_cost_per_mtok.output
        cache = {
          read  = var.model_cost_per_mtok.cache_read
          write = var.model_cost_per_mtok.cache_write
        }
      }
    }
  }
}
