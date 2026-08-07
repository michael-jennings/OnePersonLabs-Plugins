#!/bin/bash
set -uo pipefail

source "$(dirname "$0")/codex-discipline-policy.sh"

MATCHED=0
CHANGE_NAME=""
CHANGES_ROOT=""
ARCHIVE_ROOT=""
while IFS= read -r SEGMENT; do
  SEGMENT="${SEGMENT#"${SEGMENT%%[![:space:]]*}"}"
  if [[ ! "$SEGMENT" =~ ^mv[[:space:]] ]]; then continue; fi
  if [[ "$SEGMENT" =~ mv[[:space:]]+([^[:space:]]*openspec/changes/)([a-z][a-z0-9-]+)[[:space:]]+([^[:space:]]*openspec/changes/archive/) ]]; then
    CHANGE_NAME="${BASH_REMATCH[2]}"
    CHANGES_ROOT="${BASH_REMATCH[1]}"
    ARCHIVE_ROOT="${BASH_REMATCH[3]}"
    MATCHED=1
    break
  fi
done < <(echo "$CMD" | tr ';|' '\n\n' | sed 's/&&/\n/g' | sed 's/||/\n/g')

if [[ $MATCHED -eq 0 ]]; then exit 0; fi
CHANGE_DIR="${CHANGES_ROOT}${CHANGE_NAME}"
[[ -d "$CHANGE_DIR" ]] || exit 0
if dir_has_bypass_sentinel "$CHANGE_DIR"; then exit 0; fi

declare -a MVP_HITS=()
declare -a DEFERRAL_HITS=()
declare -a FOLLOWUP_HITS=()
while IFS= read -r MDFILE; do
  scan_md_file_all "$MDFILE" MVP_HITS DEFERRAL_HITS "${MDFILE}:"
done < <(find "$CHANGE_DIR" -type f -name '*.md')

declare -A KNOWN_CHANGE_NAMES=()
ARCHIVE_DIR="${ARCHIVE_ROOT%/}"
if [[ -d "$CHANGES_ROOT" ]]; then
  for ENTRY in "$CHANGES_ROOT"*/; do
    [[ -d "$ENTRY" ]] || continue
    BASE=$(basename "$ENTRY")
    [[ "$BASE" == "archive" ]] && continue
    KNOWN_CHANGE_NAMES["$BASE"]=1
  done
fi
if [[ -d "$ARCHIVE_DIR" ]]; then
  for ENTRY in "$ARCHIVE_DIR"/*/; do
    [[ -d "$ENTRY" ]] || continue
    BASE=$(basename "$ENTRY")
    STRIPPED=$(echo "$BASE" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}-//')
    KNOWN_CHANGE_NAMES["$STRIPPED"]=1
  done
fi
KNOWN_CHANGE_NAMES["$CHANGE_NAME"]=1

while IFS= read -r FILE; do
  while IFS=: read -r MATCH_LINE LINE; do
    for TOKEN in $(echo "$LINE" | grep -oE '[a-z][a-z0-9]+(-[a-z0-9]+){2,}' || true); do
      if ! resolve_followup_token "$TOKEN"; then
        FOLLOWUP_HITS+=("$TOKEN  (at $FILE:$MATCH_LINE)")
      fi
    done
  done < <(grep -nIiE "$FOLLOWUP_INDICATORS" "$FILE" 2>/dev/null || true)
done < <(find "$CHANGE_DIR" -type f -name "*.md" 2>/dev/null)

if [[ ${#MVP_HITS[@]} -eq 0 && ${#DEFERRAL_HITS[@]} -eq 0 && ${#FOLLOWUP_HITS[@]} -eq 0 ]]; then
  exit 0
fi

emit_block_report "archive" "archiving '$CHANGE_NAME'" MVP_HITS DEFERRAL_HITS FOLLOWUP_HITS
exit 2
