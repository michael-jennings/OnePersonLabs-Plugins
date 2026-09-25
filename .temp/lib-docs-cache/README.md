# Codex-adapted lib docs cache setup

I rebuilt the original setup package and specification rather than performing the ceremonial substitution of “Claude” with “Codex.”

Codex’s native surfaces are now used correctly: project MCP configuration in `.codex/config.toml`, repository skills in `.agents/skills`, layered `AGENTS.md` guidance, and structured lifecycle hooks in `.codex/hooks.json`.

The major improvements are:

- **Three MCP tools instead of four:** `docs_lookup`, `docs_index`, and `docs_status`.
- **FTS5 plus an exact symbol index by default.** Ollama and vectors are optional rerankers, not mandatory infrastructure shrubbery.
- **Deterministic extractive compression.** It preserves signatures, imports, parameters, caveats, and minimal examples without generating possibly distorted summaries for every chunk.
- **Two-layer caching:** content-addressed source storage plus reusable knowledge-patch and negative-result caches.
- **Evidence-based invalidation:** exact package version, source hash, and indexing-schema version replace the arbitrary 30-day timer and speculative “the model knows React through version X” tables.
- **Source authority order:** installed package declarations/docs, exact lockfile-resolved artifact, exact repository revision, then verified official documentation.
- **Error-driven retrieval without validation spam:** hooks observe validation Codex already runs and recommend documentation only for likely external-API mismatches.
- **One targeted validation gate at turn completion,** rather than running the whole monorepo typecheck after every edit.
- **Correct compaction recovery:** active documentation patches are restored through `SessionStart` with `source="compact"`, which Codex explicitly delivers to the immediate post-compaction continuation.
- **Small `AGENTS.md` footprint:** package-level files are created only for actual policy differences, not to duplicate dependency encyclopedias until the context window develops a smoking habit.

This directory contains:

- `PROMPT.md` — one-shot Codex setup prompt.
- `SPEC.md` — improved implementation specification.
- `AUDIT.md` — original-versus-new architecture audit.

The package was verified against its extracted archive with:

```text
Archive integrity: PASS
Package manifest: PASS
Hook syntax and JSON/TOML parsing: PASS
Hook fixture suite: PASS
Paths containing spaces: PASS
Files packaged: 18
ZIP SHA-256:
c6ae515f59524f8fb6294d97dc335cd3addb2579a19f0359b14ad2ac2d140535
```

This remains the same kind of deliverable as the original: a portable package that instructs Codex to build and safely integrate the actual MCP server into the target monorepo.
