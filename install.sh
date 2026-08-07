#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_BIN="${CODEX_BIN:-codex}"
MARKETPLACE_MANIFEST="$REPO_ROOT/.agents/plugins/marketplace.json"

if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  printf 'error: Codex CLI not found: %s\n' "$CODEX_BIN" >&2
  exit 127
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'error: jq is required to read %s\n' "$MARKETPLACE_MANIFEST" >&2
  exit 127
fi

MARKETPLACE_NAME="$(jq -er '.name' "$MARKETPLACE_MANIFEST")"
mapfile -t PLUGIN_NAMES < <(jq -er '.plugins[].name' "$MARKETPLACE_MANIFEST")

printf 'Reinstalling %d plugins from %s\n' "${#PLUGIN_NAMES[@]}" "$MARKETPLACE_NAME"

for plugin in "${PLUGIN_NAMES[@]}"; do
  "$CODEX_BIN" plugin remove "$plugin@$MARKETPLACE_NAME" >/dev/null 2>&1 || true
done

"$CODEX_BIN" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
"$CODEX_BIN" plugin marketplace add "$REPO_ROOT"

for plugin in "${PLUGIN_NAMES[@]}"; do
  printf 'Installing %s@%s\n' "$plugin" "$MARKETPLACE_NAME"
  "$CODEX_BIN" plugin add "$plugin@$MARKETPLACE_NAME"
done

printf 'Plugin installation complete.\n'
