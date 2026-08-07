#!/bin/bash
# codex-openspec-archive-order-gate.sh
#
# PreToolUse hook on Bash. Blocks the `mv openspec/changes/<X>
# openspec/changes/archive/...` operation if any of <X>'s upstream
# dependencies still resolve to an active (non-archived) change.
#
# This is the structural guarantee that changes cannot be archived out of
# dependency order -- even if a parallel wave completes changes in a
# non-sequential order, this hook ensures the Tier-3 integrate step cannot
# bypass the "all upstreams archived first" invariant.
#
# Resolution delegates entirely to the dependency-audit skill's graph command.
# (the single source of truth for the dependency grammar). Edges in the
# returned `edges[]` array are ACTIVE upstream edges -- archived upstreams
# are already excluded from that array and appear only in `archivedEdges[]`.
# Therefore: if ANY edge has `to == <name>`, at least one active upstream
# remains, and the archive is blocked.
#
# Same segment-splitting and mv-detection logic as
# codex-openspec-archive-quality-gate.sh;
# both hooks fire on the same PreToolUse Bash event and must stay aligned.
#
# See openspec/specs/architecture-change-orchestration/spec.md.

set -uo pipefail

INPUT=$(cat)
if ! CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null); then
  if [[ "$INPUT" == *"openspec/changes/"* && "$INPUT" == *"openspec/changes/archive"* ]]; then
    echo "BLOCKED: OpenSpec archive hook input could not be decoded; refusing an archive-shaped command." >&2
    exit 2
  fi
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$HOOK_DIR/.." && pwd)}"
if [[ -f "$HOOK_DIR/codex-node-toolchain-path.sh" ]]; then
  # shellcheck source=codex-node-toolchain-path.sh
  source "$HOOK_DIR/codex-node-toolchain-path.sh"
fi
# shellcheck source=codex-archive-command.sh
source "$HOOK_DIR/codex-archive-command.sh"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  NODE_DIR="$(openspec_latest_node_bin)"
  if [[ -n "$NODE_DIR" ]]; then NODE_BIN="$NODE_DIR/node"; fi
fi
if [[ -z "$NODE_BIN" ]]; then
  if [[ "$CMD" == *"openspec/changes/"* && "$CMD" == *"openspec/changes/archive"* ]]; then
    echo "BLOCKED: OpenSpec archive command parser requires Node.js, but node is unavailable after hook toolchain normalization." >&2
    exit 2
  fi
  exit 0
fi
OPENSPEC_NODE_BIN="$NODE_BIN"
CHANGE_NAME=$(openspec_archive_change_from_command "$CMD")
PARSER_EXIT=$?
if [[ $PARSER_EXIT -eq 3 ]]; then exit 0; fi
if [[ $PARSER_EXIT -ne 0 ]]; then
  echo "BLOCKED: OpenSpec archive command parsing failed (exit $PARSER_EXIT)." >&2
  exit 2
fi
if [[ ! "$CHANGE_NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "BLOCKED: OpenSpec archive command parser returned a malformed change name." >&2
  exit 2
fi

PROJECT_DIR="${CODEX_PROJECT_DIR:-$(pwd)}"
if ! cd "$PROJECT_DIR"; then
  echo "BLOCKED: OpenSpec archive project root is unavailable: $PROJECT_DIR" >&2
  exit 2
fi

if [[ -f "$PROJECT_DIR/scripts/codex-node-toolchain-path.sh" ]]; then
  # shellcheck source=/dev/null
  source "$PROJECT_DIR/scripts/codex-node-toolchain-path.sh"
  openspec_normalize_node_toolchain_path
fi

# Run the parser to get the active dependency graph.
# Use absolute path to avoid any cwd or symlink resolution issues.
GRAPH_SCRIPT="$PROJECT_DIR/.agents/skills/opsxx-dependency-audit/scripts/opsxx-deps.mjs"
if [[ ! -f "$GRAPH_SCRIPT" ]]; then
  GRAPH_SCRIPT="$PLUGIN_ROOT/skills/opsxx-dependency-audit/scripts/opsxx-deps.mjs"
fi
GRAPH_JSON=$("$NODE_BIN" "$GRAPH_SCRIPT" --graph 2>/dev/null) || {
  echo "BLOCKED: OpenSpec archive dependency graph could not be evaluated." >&2
  exit 2
}

# Check if any active edge points TO the change being archived.
# An edge {from: X, to: CHANGE_NAME} means CHANGE_NAME depends on X (X is upstream).
# If such an edge exists and X is still active, we must block.
if ! ACTIVE_UPSTREAMS=$(echo "$GRAPH_JSON" | "$NODE_BIN" -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const g = JSON.parse(chunks.join(''));
    if (!g || !Array.isArray(g.edges)) {
      throw new Error('dependency graph must contain an edges array');
    }
    const name = process.argv[1];
    const blocking = g.edges
      .filter(e => e && typeof e === 'object' && e.to === name)
      .map(e => {
        if (typeof e.from !== 'string') throw new Error('dependency edge is missing from');
        return e.from;
      });
    process.stdout.write(blocking.join('\n'));
  });
" "$CHANGE_NAME" 2>/dev/null); then
  echo "BLOCKED: OpenSpec archive dependency graph output is malformed." >&2
  exit 2
fi

if [[ -z "$ACTIVE_UPSTREAMS" ]]; then
  exit 0
fi

{
  echo ""
  echo "BLOCKED: openspec archive gate (dependency-order)"
  echo ""
  echo "  change: $CHANGE_NAME"
  echo ""
  echo "Cannot archive '$CHANGE_NAME' -- the following upstream dependencies are"
  echo "still active (not yet archived):"
  echo ""
  while IFS= read -r upstream; do
    [[ -z "$upstream" ]] && continue
    echo "    - $upstream"
  done <<< "$ACTIVE_UPSTREAMS"
  echo ""
  echo "Archive upstreams first, in dependency order."
  echo 'Live ordering: $opsxx-implementation-order'
  echo "Rule: openspec/specs/architecture-change-orchestration/spec.md (archive-order gate)"
  echo ""
} >&2

exit 2
