#!/bin/bash
#
# PostToolUse hook on Edit|Write. If an edited file contains a backtick-wrapped
# known Agent Skill name, nudge the agent to use the native $skill-name sigil.
# Raw backticks are ambiguous to agents because they also denote local commands,
# scripts, and shell tokens.
#
# The gate scans agent-instruction and tooling surfaces where this failure
# mode appears: AGENTS.md, Markdown references, skill files, .codex config/hooks,
# and repo scripts. Ordinary app/package source edits exit before skill
# discovery.
#
# Skill names are discovered from repo and user skill folders. For each SKILL.md,
# prefer the frontmatter name field; if absent, fall back to the skill folder
# name. This keeps the gate aligned with the real local skill inventory instead
# of a copied list.

set -uo pipefail

INPUT=$(cat)
PROJECT_DIR="${CODEX_PROJECT_DIR:-$(pwd)}"
PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

[[ -z "$FILE_PATH" || ! -f "$FILE_PATH" ]] && exit 0

REL_PATH="$FILE_PATH"
case "$REL_PATH" in
  "$PROJECT_DIR"/*) REL_PATH="${REL_PATH#"$PROJECT_DIR"/}" ;;
  ./*) REL_PATH="${REL_PATH#./}" ;;
esac

is_stock_openspec_skill() {
  local path="$1"

  case "$path" in
    .agents/skills/opsx-*/SKILL.md) return 0 ;;
    */.agents/skills/opsx-*/SKILL.md) return 0 ;;
    *) return 1 ;;
  esac
}

codex_scan_surface() {
  local path="$1"
  local codex_skills_root="${CODEX_HOME:-$HOME/.codex}/skills"

  [[ "$path" == "AGENTS.md" ]] && return 0
  [[ "$path" =~ ^\.agents/references/.+\.md$ ]] && return 0
  [[ "$path" =~ ^\.agents/skills/[^/]+/SKILL\.md$ ]] && return 0
  [[ "$path" =~ ^\.agents/skills/[^/]+/agents/[^/]+\.(ya?ml|json|toml)$ ]] && return 0
  [[ "$path" =~ ^\.agents/skills/[^/]+/references/.+\.md$ ]] && return 0
  [[ "$path" =~ ^\.agents/skills/[^/]+/scripts/[^/]+\.(mjs|js|sh)$ ]] && return 0
  [[ "$path" == ".codex/hooks.json" ]] && return 0
  [[ "$path" == ".codex/config.toml" ]] && return 0
  [[ "$path" =~ ^scripts/[^/]+\.(mjs|js|sh)$ ]] && return 0
  [[ "$path" == "$HOME"/.agents/skills/* ]] && return 0
  [[ "$path" == "$codex_skills_root"/* ]] && return 0

  return 1
}

if is_stock_openspec_skill "$REL_PATH" || is_stock_openspec_skill "$FILE_PATH"; then
  exit 0
fi

SIGIL=""
SIGIL_NAME=""
if codex_scan_surface "$REL_PATH" || codex_scan_surface "$FILE_PATH"; then
  SIGIL='$'
  SIGIL_NAME="dollar-sigil"
else
  exit 0
fi

[[ -s "$FILE_PATH" ]] || exit 0
grep -Iq . "$FILE_PATH" 2>/dev/null || exit 0

# Cheap prefilter: most instruction/tooling files have no backticked kebab
# tokens at all, so don't build the dynamic skill inventory unless there is
# something a skill name could match.
grep -qE '`[a-z0-9][a-z0-9-]*-[a-z0-9][a-z0-9-]*([[:space:]][^`]*)?`' "$FILE_PATH" 2>/dev/null || exit 0

BYPASS='<!-- skill-reference-sigil-bypass -->'

skill_name_from_file() {
  local file="$1"
  local frontmatter_name

  frontmatter_name="$(
    awk '
      NR == 1 && $0 == "---" { in_frontmatter = 1; next }
      in_frontmatter && $0 == "---" { exit }
      in_frontmatter && $1 == "name:" {
        sub(/^name:[[:space:]]*/, "")
        gsub(/^["'\''"]|["'\''"]$/, "")
        print
        exit
      }
    ' "$file" 2>/dev/null
  )"

  if [[ "$frontmatter_name" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]; then
    printf '%s\n' "$frontmatter_name"
  else
    basename "$(dirname "$file")"
  fi
}

collect_skill_names() {
  local roots=(
    "$PLUGIN_ROOT/skills"
    "$PROJECT_DIR/.agents/skills"
    "${CODEX_HOME:-$HOME/.codex}/skills"
    "$HOME/.agents/skills"
    "/etc/codex/skills"
  )
  local root skill_file name

  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r skill_file; do
      name="$(skill_name_from_file "$skill_file")"
      [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || continue
      printf '%s\n' "$name"
    done < <(find "$root" -maxdepth 4 -name SKILL.md -type f 2>/dev/null)
  done | sort -u
}

mapfile -t SKILL_NAMES < <(collect_skill_names)
[[ "${#SKILL_NAMES[@]}" -gt 0 ]] || exit 0

NAME_PATTERN="$(printf '%s\n' "${SKILL_NAMES[@]}" | paste -sd '|' -)"
HITS="$(
  grep -nE "\`(${NAME_PATTERN})([[:space:]][^\`]*)?\`" "$FILE_PATH" 2>/dev/null \
    | grep -vF "$BYPASS" || true
)"

[[ -n "$HITS" ]] || exit 0

formatted_hits="$(
  printf '%s\n' "$HITS" \
    | sed -E 's/^/  /' \
    | head -n 20
)"

cat >&2 <<EOF
[skill-reference-sigil-gate] This edit left backtick-wrapped Agent Skill names in:

  $FILE_PATH

Matches:
$formatted_hits

If these are skill references or invocations, use the native $SIGIL_NAME form
instead, e.g. ${SIGIL}<skill-name>.

If a match is intentionally a literal non-skill token, add this same-line bypass
comment and leave the text unchanged:
  $BYPASS
EOF

exit 2
