#!/bin/bash
# codex-openspec-dependency-gate.sh
#
# PostToolUse hook on Edit|Write. Fires only when the written file is an
# ACTIVE change's proposal.md:
#   openspec/changes/<name>/proposal.md   (NOT under archive/)
#
# It enforces that every upstream dependency declared in that proposal's
# `## Dependencies` section resolves to a real change folder -- active OR
# archived. $opsxx-implementation-order derives the live ordering view from
# these same sections; $opsxx-advance selects and completes the next
# unblocked change, and $opsxx-orchestrate runs isolated worktree workers.
#
# The grammar is NOT parsed here. It lives in ONE executable definition,
# The skill-owned opsxx-deps.mjs module, which this hook, opsxx-implementation-order, opsxx-advance,
# and both orchestrators consume -- so they can never drift apart. This hook
# shells out to `--validate`; the script owns the section grammar (the
# three-tier Required/Coherence/Downstream labels, the `(via `anchor`)`
# token, resolution, and the BLOCKED message). See
# openspec/specs/architecture-change-dependency-graph/spec.md.
#
# Why block on an unresolved dep instead of warning:
#   A dangling upstream name is either (a) a typo, or (b) a producer that
#   does not exist yet. Case (b) is exactly the producer-gap the project
#   forbids papering over (AGENTS.md "Producer-gap"): file the producer as
#   its own change, THEN declare the dependency. Blocking forces that.
#
# Anchor enforcement: `Required` edges must carry a `(via `anchor`)`. The
# mode is set by OPENSPEC_DEPS_ANCHOR_ENFORCE (warn|block, default block now
# that every proposal's edges are backfilled with anchors). Set =warn only for
# a deliberate, temporary migration window.
#
# Bypass: none by design. A dangling dep is always either a typo to fix or
# a producer to file.

set -uo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

[[ -z "$FILE_PATH" ]] && exit 0

# Only active-change proposals. Archived proposals are frozen history.
case "$FILE_PATH" in
  */openspec/changes/archive/*) exit 0 ;;
  */openspec/changes/*/proposal.md) : ;;
  *) exit 0 ;;
esac

# File may not exist if the edit failed; nothing to validate.
[[ -f "$FILE_PATH" ]] || exit 0

PROJECT_DIR="${CODEX_PROJECT_DIR:-$(pwd)}"
PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCRIPT="$PROJECT_DIR/.agents/skills/opsxx-dependency-audit/scripts/opsxx-deps.mjs"
if [[ ! -f "$SCRIPT" ]]; then
  SCRIPT="$PLUGIN_ROOT/skills/opsxx-dependency-audit/scripts/opsxx-deps.mjs"
fi

if [[ -f "$PROJECT_DIR/scripts/codex-node-toolchain-path.sh" ]]; then
  # shellcheck source=/dev/null
  source "$PROJECT_DIR/scripts/codex-node-toolchain-path.sh"
  openspec_normalize_node_toolchain_path
fi

if [[ ! -f "$SCRIPT" ]]; then
  echo "BLOCKED: OpenSpec dependency parser is missing: $SCRIPT" >&2
  exit 2
fi

# The script prints any BLOCKED / NOTE message to stderr (inherited here) and
# exits 2 on an unresolved upstream, or on a missing anchor in block mode.
node "$SCRIPT" --validate "$FILE_PATH"
exit $?
