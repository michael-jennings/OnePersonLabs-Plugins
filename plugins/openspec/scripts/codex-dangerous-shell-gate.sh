#!/bin/bash
# codex-dangerous-shell-gate.sh
#
# Blocks shell commands whose blast radius is too easy to get wrong by
# accident. This intentionally replaces "please be careful" with a workflow
# gate for destructive cases that should require explicit human handling.

set -uo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")

[[ -z "$CMD" ]] && exit 0

block() {
  local reason="$1"
  local match="$2"
  cat >&2 <<EOF
[dangerous-shell-gate] BLOCK: $reason

Matched:
  $match

Use a narrower, quoted target or perform this manually after reviewing it.
For destructive cleanup inside the repo, prefer explicit paths like:
  rm -rf ./path/to/generated-dir

This gate is intentionally conservative around recursive removal, parent
directory traversal, root/home targets, and destructive git history commands.
EOF
  exit 2
}

# Normalize line continuations so simple regexes can catch common command
# shapes. The hook is a guardrail, not a full shell parser.
NORMALIZED=$(printf '%s\n' "$CMD" | tr '\n' ' ')

# Preserve hard denies for commands that rewrite shared history or destroy state.
if [[ "$NORMALIZED" =~ (^|[[:space:];|&])git[[:space:]]+push([^;|&]*--force|-f)([[:space:];|&]|$) ]]; then
  block "force-push requires explicit human handling" "${BASH_REMATCH[0]}"
fi

if [[ "$NORMALIZED" =~ (^|[[:space:];|&])git[[:space:]]+reset[[:space:]]+--hard([[:space:];|&]|$) ]]; then
  block "git reset --hard is destructive" "${BASH_REMATCH[0]}"
fi

# Block network downloaders that bypass package-manager lockfiles and review.
if [[ "$NORMALIZED" =~ (^|[[:space:];|&])(wget|curl)[[:space:]]+ ]]; then
  block "raw downloader command is not auto-allowed" "${BASH_REMATCH[0]}"
fi

# Any rm that targets a parent directory, root, home, or uses recursive removal
# with risky globs is blocked. This catches the classic unquoted/empty-variable
# accident classes without blocking ordinary non-recursive deletes.
if [[ "$NORMALIZED" =~ (^|[[:space:];|&])rm[[:space:]] ]]; then
  RM_SEGMENTS=$(printf '%s\n' "$NORMALIZED" | grep -oE '(^|[;&|][[:space:]]*)rm[[:space:]][^;&|]*' || true)
  while IFS= read -r segment; do
    [[ -z "$segment" ]] && continue

    if [[ "$segment" =~ (^|[[:space:]])--no-preserve-root([[:space:]]|$) ]]; then
      block "rm --no-preserve-root is never safe for agent automation" "$segment"
    fi

    if [[ "$segment" =~ (^|[[:space:]])(-[A-Za-z]*r[A-Za-z]*|-[-]recursive)([[:space:]]|$) ]]; then
      if [[ "$segment" =~ (^|[[:space:]])(\.\.|\.\./|/|/\*|~|~/|\$HOME|\$\{HOME\})([[:space:]]|$|/) ]]; then
        block "recursive rm targets parent/root/home scope" "$segment"
      fi
      if [[ "$segment" =~ (^|[[:space:]])[^[:space:]]*/\*([[:space:]]|$) ]]; then
        block "recursive rm with path glob is too easy to mis-scope" "$segment"
      fi
      if [[ "$segment" =~ (^|[[:space:]])(\.|\.\/)([[:space:]]|$) ]]; then
        block "recursive rm targets the current directory" "$segment"
      fi
    fi

    if [[ "$segment" =~ (^|[[:space:]])\.\.(/|[[:space:]]|$) ]]; then
      block "rm targeting a parent directory is blocked" "$segment"
    fi
  done <<< "$RM_SEGMENTS"
fi

exit 0
