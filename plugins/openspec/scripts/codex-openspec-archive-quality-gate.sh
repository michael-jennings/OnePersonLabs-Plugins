#!/bin/bash
# codex-openspec-archive-quality-gate.sh
#
# PreToolUse hook on Bash. Blocks the `mv openspec/changes/<X>
# openspec/changes/archive/...` operation if `pnpm run validate` exits non-zero.
# Validate is the canonical workspace quality gate:
#   - root eslint (root *.{js,ts,mjs,cjs} + scripts/**)
#   - `turbo run lint` (every workspace package's lint)
#   - `turbo run typecheck` (every workspace package's typecheck with its
#     own tsconfig, all inheriting the shared strict base; the root tsconfig is
#     the IDE umbrella rather than a package build program)
#   - repository-owned validators discovered by `scripts/run-validators.mjs`
#
# Failure modes this catches: an opsx-archive being declared "ready" on
# the basis of unit-test pass counts or partial checks while the workspace
# typecheck or any lint surface real errors.
#
# Performance: validate's lint + typecheck both use turbo's cache. Warm
# cache is sub-second; cold cache is ~10-20s. Acceptable for once-per-
# archive frequency.
#
# Bypass: there is no environment-variable bypass on purpose. If the gate
# is wrong about your specific change, fix the rule or the hook -- do not
# add a one-off escape hatch that future sessions will discover and abuse.

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
ARCHIVE_CHANGE=$(openspec_archive_change_from_command "$CMD")
PARSER_EXIT=$?
if [[ $PARSER_EXIT -eq 3 ]]; then exit 0; fi
if [[ $PARSER_EXIT -ne 0 ]]; then
  echo "BLOCKED: OpenSpec archive command parsing failed (exit $PARSER_EXIT)." >&2
  exit 2
fi
if [[ ! "$ARCHIVE_CHANGE" =~ ^[a-z][a-z0-9-]*$ ]]; then
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

PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
if [[ -z "$PNPM_BIN" ]]; then
  echo "BLOCKED: openspec archive gate (quality-gate)" >&2
  echo "" >&2
  echo "Cannot run validation: pnpm is not on PATH after hook toolchain normalization." >&2
  exit 2
fi

VALIDATE_LOG=$(mktemp -t openspec-archive-quality-validate.XXXXXX)
trap 'rm -f "$VALIDATE_LOG"' EXIT

VALIDATE_EXIT=0
"$PNPM_BIN" run validate > "$VALIDATE_LOG" 2>&1 || VALIDATE_EXIT=$?

if [[ $VALIDATE_EXIT -ne 0 ]]; then
  {
    echo ""
    echo "BLOCKED: openspec archive gate (quality-gate)"
    echo ""
    echo "pnpm run validate failed (exit $VALIDATE_EXIT). Last 50 lines:"
    echo ""
    tail -50 "$VALIDATE_LOG" | sed 's/^/  /'
    echo ""
  } >&2
  exit 2
fi

exit 0
