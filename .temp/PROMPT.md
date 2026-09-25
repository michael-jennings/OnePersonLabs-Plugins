# Codex Build Prompt — Paste This Entire Block

Build and install the Codex-native documentation intelligence system specified in:

`DOC_INTEL_SETUP_DIR/SPEC.md`

Replace `DOC_INTEL_SETUP_DIR` with the absolute path where this setup package was unzipped.

## Operating mode

Work from the target repository root. Complete the implementation in this run. Do not merely produce a plan or scaffold. Preserve existing repository conventions and existing configuration.

Use the built-in `$skill-creator` skill for the companion skill. Use an installed MCP-builder skill if one is available and relevant, but do not assume hardcoded skill paths exist. The specification is authoritative when no builder skill is installed.

## Required sequence

1. Inspect the repository before editing:
   - package manager and workspace layout;
   - existing `AGENTS.md` / `AGENTS.override.md` chain;
   - existing `.agents/skills`;
   - existing `.codex/config.toml` and `.codex/hooks.json`;
   - existing validation scripts and monorepo task runner;
   - current `.gitignore`.

2. Read all of `DOC_INTEL_SETUP_DIR/SPEC.md`, then read every file under `DOC_INTEL_SETUP_DIR/templates/`.

3. Write an implementation plan to `docs/doc-intel/IMPLEMENTATION_PLAN.md`, then execute it immediately. Track progress in the plan. Do not stop for approval unless a destructive or genuinely non-resolvable conflict exists.

4. Implement the TypeScript MCP server at `tools/doc-intel-mcp-server/` using tests first. It must expose exactly:
   - `docs_lookup`
   - `docs_index`
   - `docs_status`

5. Use SQLite FTS5 and a structured symbol index as the mandatory retrieval core. Treat sqlite-vec and Ollama as optional accelerators loaded at runtime. The server must build, index, search, and pass tests when neither is installed.

6. Implement content-addressed source storage, exact-version provenance, deterministic extractive compression, result-patch caching, source-hash invalidation, and negative caching exactly as described in the spec.

7. Install the Codex workflow surfaces by safely merging rather than overwriting. If the sandbox protects `.codex/`, request the narrow approval needed for those files and continue; do not move project configuration to an unrelated location:
   - `.agents/skills/doc-intel/`
   - `.codex/config.toml`
   - `.codex/hooks.json`
   - `.codex/hooks/*.py`
   - the concise documentation-intelligence section in the nearest applicable `AGENTS.md`
   - `.doc-intel/config.json`
   - `.gitignore` entries for cache and state only

8. Do **not** create an `AGENTS.md` in every package. Add nested guidance only where an existing package has materially different documentation policy or validation commands. Dependency discovery belongs in code, not in thousands of repeated prompt tokens.

9. Do **not** implement a static model-training-cutoff skip list. Do **not** run a full typecheck after every edit. Do **not** require generative summarization.

10. Configure the MCP server in the project `.codex/config.toml` using an absolute repository path, project-local environment variables, explicit startup/tool timeouts, and only the three allowed tools. Preserve all existing TOML entries.

11. Verify with evidence:
   - unit and integration tests;
   - hook fixture tests;
   - MCP SDK client smoke test that initializes, lists tools, indexes fixture docs, and looks up a symbol and a diagnostic;
   - production build;
   - lint/typecheck using repository-native commands;
   - `codex mcp list` when Codex CLI is available;
   - a final diff review for overwritten config or unnecessary generated files.

12. Write `docs/doc-intel/INSTALL_REPORT.md` containing:
   - files created and modified;
   - exact verification commands and outcomes;
   - whether optional embeddings are enabled;
   - hook trust step (`/hooks`) if still required;
   - any remaining limitation supported by evidence.

## Completion constraints

- No TODOs, stubs, or placeholder implementations.
- No fabricated claims about source authority or package versions.
- No network dependency during normal lookup of already indexed material.
- Indexing must prefer installed and exact-version sources before web sources.
- Default lookup response target: 700 tokens; hard default ceiling: 900 tokens.
- Larger evidence/source responses require explicit escalation.
- Tool errors must be structured, actionable, and non-destructive.
- All paths must work in WSL/Linux and tolerate spaces.
- Do not commit unless the repository instructions explicitly require it.