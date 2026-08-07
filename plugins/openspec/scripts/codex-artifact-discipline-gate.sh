#!/bin/bash
set -uo pipefail

source "$(dirname "$0")/codex-discipline-policy.sh"

SCAN_TEXT="$NEW_STRING"$'\n'"$CONTENT"
if [[ -z "${SCAN_TEXT//[[:space:]]/}" ]]; then exit 0; fi
if has_bypass_sentinel "$SCAN_TEXT"; then exit 0; fi
if [[ -f "$FILE_PATH" ]] && has_bypass_sentinel "$(cat "$FILE_PATH" 2>/dev/null)"; then exit 0; fi

declare -a MVP_HITS=()
declare -a DEFERRAL_HITS=()
declare -a FOLLOWUP_HITS=()
scan_mvp_text "$SCAN_TEXT" MVP_HITS ""

if [[ "$FILE_PATH" == *openspec/changes/* \
      && "$FILE_PATH" != *openspec/changes/archive/* \
      && "$FILE_PATH" == *.md ]]; then
  scan_deferral_text "$SCAN_TEXT" DEFERRAL_HITS ""
fi

if [[ ${#MVP_HITS[@]} -eq 0 && ${#DEFERRAL_HITS[@]} -eq 0 ]]; then exit 0; fi
emit_block_report "edit" "your edit to: $FILE_PATH" MVP_HITS DEFERRAL_HITS FOLLOWUP_HITS
exit 2
