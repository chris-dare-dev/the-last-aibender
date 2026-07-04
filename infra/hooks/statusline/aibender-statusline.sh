#!/usr/bin/env bash
# aibender-statusline.sh — SI-3 statusline quota tee (blueprint §6.1 "Claude quota").
#
# Registered per account as the settings.json statusLine command by
# infra/hooks/install-hook-settings.sh (which copies this file to
# $AIBENDER_HOME/bin/ — the settings entry references that machine-local
# copy, never the repo working tree).
#
# On every statusline render tick the CLI feeds one JSON object on stdin
# (session_id, model, cost, context_window, rate_limits.five_hour /
# rate_limits.seven_day with used_percentage + resets_at, ...). This script:
#
#   1. Tees the stdin JSON VERBATIM and atomically (tmp + rename, 0600) to
#      the per-account quota file $AIBENDER_HOME/quota/<LABEL>.json.
#      BE-5 ingests that file into quota_snapshots; the broker stamps
#      capturedAt itself (ws-protocol.md §11) — no wrapper shape invented.
#   2. Emits the status line: the user's ORIGINAL statusline command output
#      when a passthrough snippet was captured at install time, else a
#      minimal "<LABEL> 5h:NN% 7d:NN%" instrument line.
#
# Failure posture: this script must NEVER break a session's render tick —
# no `set -e`; every failure path still prints a line and exits 0.
#
# [X2]: the teed payload stays machine-local under $AIBENDER_HOME (0600).
# Nothing is POSTed, logged, or written anywhere else by this script.

set -u

LABEL=""
QUOTA_FILE=""
PASSTHROUGH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:-}"; shift 2 || break ;;
    --quota-file) QUOTA_FILE="${2:-}"; shift 2 || break ;;
    --passthrough) PASSTHROUGH="${2:-}"; shift 2 || break ;;
    *) shift ;;
  esac
done

# Read the whole tick payload from stdin (single JSON object).
PAYLOAD="$(cat 2>/dev/null || true)"

# --- 1. atomic verbatim tee ---------------------------------------------------
if [ -n "$QUOTA_FILE" ] && [ -n "$PAYLOAD" ]; then
  qdir="$(dirname "$QUOTA_FILE")"
  if mkdir -p "$qdir" 2>/dev/null; then
    chmod 700 "$qdir" 2>/dev/null || true
    tmp="$QUOTA_FILE.$$.tmp"
    if printf '%s' "$PAYLOAD" > "$tmp" 2>/dev/null; then
      chmod 600 "$tmp" 2>/dev/null || true
      mv -f "$tmp" "$QUOTA_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    else
      rm -f "$tmp" 2>/dev/null
    fi
  fi
fi

# --- 2. status line -------------------------------------------------------------
# Passthrough: run the user's pre-install statusline command (captured by the
# installer into an executable snippet) with the same stdin payload.
if [ -n "$PASSTHROUGH" ] && [ -x "$PASSTHROUGH" ]; then
  if out="$(printf '%s' "$PAYLOAD" | "$PASSTHROUGH" 2>/dev/null)"; then
    printf '%s\n' "$out"
    exit 0
  fi
fi

line="${LABEL:-aibender}"
if command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  five="$(printf '%s' "$PAYLOAD" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null || true)"
  seven="$(printf '%s' "$PAYLOAD" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null || true)"
  [ -n "$five" ] && line="$line 5h:${five}%"
  [ -n "$seven" ] && line="$line 7d:${seven}%"
fi
printf '%s\n' "$line"
exit 0
