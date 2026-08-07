#!/bin/bash
# codex-stock-openspec-guard.sh
#
# PreToolUse hook on Edit|Write. Blocks the assistant from hand-editing
# STOCK OpenSpec tooling -- the files the `openspec` CLI owns and replaces
# wholesale on upgrade. Editing them creates tweaks that the next
# `openspec update` silently clobbers (or that you must remember to
# re-apply), which is exactly the kind of invisible drift this guard
# exists to prevent.
#
# STOCK (blocked):
#   .agents/skills/openspec-*     -- OpenSpec CLI-generated skills
#   .agents/skills/opsx-*     -- OpenSpec CLI-generated skills
#
# EXTENSIONS (allowed -- your own, namespaced to stay separable):
#   .agents/skills/openspecx-*    -- project extension skills
#   .agents/skills/opsxx-*    -- project extension skills
#
# The extra `x` disambiguates extension skills from stock skills:
# `openspecx-` never matches the stock `openspec-*` pattern.
# `opsxx-` never matches the stock `opsx-*` pattern.
#
# SCOPE: only fires on the assistant's Edit/Write tool calls. It does NOT
# see files changed by `git pull`, `openspec update`, or any other Bash
# command -- those write through the filesystem, not the Edit/Write tools.
# So pulling newer stock files or letting the CLI regenerate them is
# unaffected; only a direct hand-edit is caught. If you ever genuinely
# must modify a stock file, do it deliberately via Bash (cp/sed) or
# temporarily disable this hook -- the friction is the point.

set -uo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

# Nothing to check (e.g. a tool variant without file_path) -> allow.
[[ -z "$FILE_PATH" ]] && exit 0

KIND=""
case "$FILE_PATH" in
  */.agents/skills/openspec-*) KIND="stock openspec-* skill" ;;
esac
case "$FILE_PATH" in
  */.agents/skills/opsx-*) KIND="stock opsx-* skill" ;;
esac

# Not a stock openspec file -> allow.
[[ -z "$KIND" ]] && exit 0

cat >&2 <<EOF
BLOCK: refusing to edit a $KIND.

  $FILE_PATH

This file belongs to the OpenSpec CLI. Any edit here is silently
clobbered on the next \`openspec update\`. Stock openspec tooling is
left unmodified by design (see memory: openspec_tooling_tiers).

To change behavior, add or edit an EXTENSION instead:
  - skill -> .agents/skills/opsxx-<name>/   (opsxx-<name>)

If you truly intend to modify a stock file, do it deliberately outside
the Edit/Write tools (Bash cp/sed) or disable this hook first.
EOF
exit 2
