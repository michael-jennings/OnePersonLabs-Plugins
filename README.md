Plugin wrappers for Codex. Keeps the ~/.codex directory clean and allows for easy installation of plugins from the marketplace. Each plugin is installed in its own directory under ~/.codex/plugins. The plugin wrapper will automatically add the plugin to the marketplace and install it in the correct location.

Run `./install.sh` to register this local marketplace and reinstall every plugin listed in `.agents/plugins/marketplace.json`. The script requires the `codex` CLI and `jq`. Set `CODEX_BIN` to use a different Codex executable.
