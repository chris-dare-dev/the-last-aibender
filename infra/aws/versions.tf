# versions.tf — SI-4 Bedrock cost-attribution stack (plan §6/SI-4, blueprint §4.2/§6.1).
#
# aws_bedrock_inference_profile requires hashicorp/aws >= 5.77.0; we allow the
# 6.x line (current) and pin below 7 so a major-version bump is a deliberate,
# owner-reviewed change (this stack is HARD-GATED: plan-then-STOP).

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.77.0, < 7.0.0"
    }
  }
}
