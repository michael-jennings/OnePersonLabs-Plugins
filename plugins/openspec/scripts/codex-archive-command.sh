#!/usr/bin/env bash

# Prints the active change name when a shell command contains a supported
# OpenSpec archive move. Parsing lives in the hook-owned Node module so quoted
# operators and paths are handled consistently by both archive gates.
openspec_archive_change_from_command() {
  local node_bin="${OPENSPEC_NODE_BIN:-}"
  if [[ -z "$node_bin" ]]; then
    node_bin="$(command -v node 2>/dev/null)" || return 127
  fi
  "$node_bin" "$HOOK_DIR/codex-archive-command.mjs" "$1"
}
