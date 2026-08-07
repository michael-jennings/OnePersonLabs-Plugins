#!/bin/bash
set -uo pipefail

source "$(dirname "$0")/codex-discipline-policy.sh"

allow_response_stop() {
  jq -n '{continue:true}'
  exit 0
}

if [[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]]; then allow_response_stop; fi
TRANSCRIPT_TAIL_LINES="${DISCIPLINE_TRANSCRIPT_TAIL_LINES:-200}"
TRANSCRIPT_SLICE="$(tail -n "$TRANSCRIPT_TAIL_LINES" "$TRANSCRIPT" 2>/dev/null || true)"
LAST_ASSISTANT_LINE=$(printf '%s\n' "$TRANSCRIPT_SLICE" | tac | while IFS= read -r LINE; do
  ROLE=$(echo "$LINE" | jq -r '(.message.role // .role) // empty' 2>/dev/null || echo "")
  if [[ "$ROLE" == "assistant" ]]; then
    echo "$LINE"
    break
  fi
done)
if [[ -z "$LAST_ASSISTANT_LINE" ]]; then allow_response_stop; fi

TEXT=$(echo "$LAST_ASSISTANT_LINE" | jq -r '
  (.message.content // .content // []) as $c
  | if ($c | type) == "array" then
      $c | map(select(type == "object" and .type == "text") | .text) | join("\n")
    elif ($c | type) == "string" then
      $c
    else
      ""
    end
' 2>/dev/null || echo "")
if [[ -z "$TEXT" ]]; then allow_response_stop; fi
if has_bypass_sentinel "$TEXT"; then allow_response_stop; fi

TEXT_NO_FENCES=$(echo "$TEXT" | awk '
  /^[[:space:]]*```/ { in_block = !in_block; next }
  !in_block { print }
')
declare -a MVP_HITS=()
declare -a DEFERRAL_HITS=()
declare -a FOLLOWUP_HITS=()
scan_mvp_text "$TEXT_NO_FENCES" MVP_HITS ""
scan_deferral_text "$TEXT_NO_FENCES" DEFERRAL_HITS ""
if [[ ${#MVP_HITS[@]} -eq 0 && ${#DEFERRAL_HITS[@]} -eq 0 ]]; then allow_response_stop; fi

reason="$(emit_block_report "response" "your last response" MVP_HITS DEFERRAL_HITS FOLLOWUP_HITS 2>&1)"
jq -n --arg r "$reason" '{decision:"block", reason:$r}'
