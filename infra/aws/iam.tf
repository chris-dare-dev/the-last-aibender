# iam.tf — SI-4 · read-only telemetry IAM for the BE-5 pollers.
#
# LEAST PRIVILEGE (plan §6/SI-4, §9.2 SI-4 row): the poller identity may do
# exactly two things —
#   1. ce:GetCostAndUsage            (Cost Explorer actual-USD poll, 1-2x/day)
#   2. cloudwatch:GetMetricData      (AWS/Bedrock tokens/TTFT/throttles poll)
# No writes, no wildcard actions, no Put*/Create*/Delete*/Update* anywhere in
# this file — the bats suite greps this file to keep it that way.
#
# Resource scoping notes (both statements use resources = ["*"]):
#   * ce:GetCostAndUsage supports no resource-level permissions — "*" is the
#     only valid resource for the action (AWS service authorization reference).
#   * cloudwatch:GetMetricData likewise supports no resource types; scoping is
#     attempted via the cloudwatch:namespace condition key instead, gated
#     behind var.restrict_cloudwatch_namespace (see the variable's caveat —
#     verified at the owner's plan/live step, fallback documented).

data "aws_iam_policy_document" "poller_assume_role" {
  statement {
    sid     = "AibenderPollerAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type = "AWS"
      # Default: account root — delegates assume permission to IAM inside the
      # account (the owner's SSO permission set). Narrow via
      # poller_trusted_principal_arns in tfvars for tighter scoping.
      identifiers = length(var.poller_trusted_principal_arns) > 0 ? var.poller_trusted_principal_arns : ["arn:aws:iam::${var.aws_account_id}:root"]
    }
  }
}

data "aws_iam_policy_document" "poller_readonly" {
  statement {
    sid       = "CostExplorerActualUsd"
    effect    = "Allow"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"] # action supports no resource-level permissions
  }

  statement {
    sid       = "CloudWatchBedrockMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:GetMetricData"]
    resources = ["*"] # action supports no resource types

    dynamic "condition" {
      for_each = var.restrict_cloudwatch_namespace ? [1] : []
      content {
        test     = "StringEquals"
        variable = "cloudwatch:namespace"
        values   = [var.cloudwatch_metrics_namespace]
      }
    }
  }
}

resource "aws_iam_policy" "poller_readonly" {
  name        = var.poller_policy_name
  description = "the-last-aibender BE-5 pollers: read-only Cost Explorer + AWS/Bedrock CloudWatch metrics (SI-4)"
  policy      = data.aws_iam_policy_document.poller_readonly.json
}

resource "aws_iam_role" "poller" {
  name               = var.poller_role_name
  description        = "the-last-aibender BE-5 telemetry poller role — read-only, assume-gated (SI-4)"
  assume_role_policy = data.aws_iam_policy_document.poller_assume_role.json

  # Belt-and-braces read-only ceiling: even if a broader policy is ever
  # attached to this role by mistake, the boundary caps it at the two poller
  # actions.
  permissions_boundary = aws_iam_policy.poller_readonly.arn
}

resource "aws_iam_role_policy_attachment" "poller_readonly" {
  role       = aws_iam_role.poller.name
  policy_arn = aws_iam_policy.poller_readonly.arn
}
