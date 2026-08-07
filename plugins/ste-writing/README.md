# STE Writing

Based on [The cure for AI slop is a 1986 aircraft manual - the kit](https://github.com/woosal1337/blog/tree/main/videos/ep01-the-cure-for-ai-slop).

This plugin packages one `ste-writing` skill and an optional Codex write hook.

The skill covers technical prose. The hook runs the bundled linter after documentation files are edited or written. It checks Markdown, text, XML, YAML, JSON, TOML, and similar documentation formats. Set `STE_LINT_MODE=flavored` for natural technical prose, or set `STE_LINT_MODE=off` to disable the check.

When it blocks a write, the hook reports the file, line, column, rule, matched text, and a rewrite hint so `$ste-writing` can make a focused correction.
