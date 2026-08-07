#!/usr/bin/env bash
# Normalize hook PATH for Node-backed project tooling.
#
# Codex hook runners can start with a thinner PATH than an interactive
# shell. Prefer the user's WSL pnpm and nvm Node before any Windows npm shims so
# hooks run the same toolchain as ordinary repo commands.

openspec_prepend_path_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) PATH="$dir:$PATH" ;;
  esac
}

openspec_latest_node_bin() {
  local latest=""
  local candidate

  for candidate in \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin \
    "$HOME"/.nvm/versions/node/*/bin; do
    [[ -x "$candidate/node" ]] || continue
    if [[ -z "$latest" || "$(printf '%s\n%s\n' "$latest" "$candidate" | sort -V | tail -n 1)" == "$candidate" ]]; then
      latest="$candidate"
    fi
  done

  printf '%s\n' "$latest"
}

openspec_normalize_node_toolchain_path() {
  openspec_prepend_path_dir /usr/bin
  openspec_prepend_path_dir /usr/local/bin

  local node_bin
  node_bin="$(openspec_latest_node_bin)"
  [[ -n "$node_bin" ]] && openspec_prepend_path_dir "$node_bin"

  openspec_prepend_path_dir "$HOME/.local/share/pnpm"

  hash -r 2>/dev/null || true
  export PATH
}
