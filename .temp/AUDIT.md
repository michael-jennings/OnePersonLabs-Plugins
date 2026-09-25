# Audit of the Original Setup

## Correct ideas retained

- Local persistent cache.
- SQLite FTS5 as the dependable retrieval core.
- Exact package-version awareness from lockfiles.
- MCP as the cross-agent access layer.
- Progressive disclosure.
- Error-triggered retrieval rather than unconditional retrieval.
- Repository and package-scoped agent guidance.

## Codex incompatibilities corrected

| Original assumption | Codex-native replacement |
|---|---|
| `.mcp.json` is the primary registration surface | Project-scoped `.codex/config.toml` with `[mcp_servers.doc_intel]` |
| `.claude/settings.json` PostToolUse hooks | `.codex/hooks.json` with Codex hook events and JSON output |
| Skill at `./skills/doc-intel/SKILL.md` | `.agents/skills/doc-intel/SKILL.md` |
| Hardcoded `/mnt/skills/examples/...` paths | Use built-in `$skill-creator`; use an MCP-builder skill only when actually installed |
| Shell hook prints prose as a Claude system message | Hook reads JSON on stdin and emits Codex-supported `hookSpecificOutput.additionalContext` |
| Create `AGENTS.md` in every package | Keep root guidance small; create nested guidance only for real policy differences |

## Architectural improvements

### 1. Replace the training-cutoff skip list

A mutable model cannot be reliably represented by a hand-authored table claiming that it knows a package through a particular version. It creates false confidence, requires perpetual maintenance, and changes when the active Codex model changes.

The replacement is evidence-triggered lookup:

- query when an exact external API matters;
- query when diagnostics indicate an API or version mismatch;
- query when the installed version or source hash changed;
- reuse the prior patch when the same package-version-query fingerprint recurs;
- negative-cache unhelpful lookups until the package version or source hash changes.

### 2. Make vector search optional

Documentation is rich in exact symbols, headings, import paths, error text, and type signatures. FTS5 plus a structured symbol index is cheaper, easier to install, easier to debug, and often more accurate than embedding search for this domain.

Vector retrieval is an optional reranker, loaded dynamically when configured. The server must remain fully functional without sqlite-vec or Ollama.

### 3. Remove mandatory generative summarization

Generating a summary for every chunk spends indexing time and can distort the very signatures the system exists to preserve. The default compressor is deterministic and extractive:

- retain heading path;
- retain signatures, parameter and return sections;
- retain import paths;
- retain warnings, deprecations, and migration notes;
- retain the smallest complete example;
- omit prose unrelated to the query.

Optional local summarization may be added as a reranking aid, never as the canonical source.

### 4. Stop typechecking after every edit

The original PostToolUse hook runs `tsc --noEmit` after every write. In a monorepo this is noisy, slow, and can repeatedly validate unrelated packages.

The replacement hooks:

- record changed files after `apply_patch`;
- observe validation commands Codex already runs;
- inspect failing validation output for external-API mismatch signatures;
- suggest a focused `docs_lookup` only when warranted;
- at turn stop, ask for one targeted validation pass if code changed and none ran;
- restore active documentation patches after context compaction.

### 5. Cache knowledge patches, not only source chunks

The source cache prevents network refetching. A second result cache prevents repeated search and reassembly.

A patch fingerprint includes:

```text
package + installed version + source hash + normalized request/diagnostic + response tier
```

The cached result stores selected chunk IDs, provenance, the compact patch, and whether a later validation appeared to resolve the diagnostic. Repeated work becomes a small local read rather than another retrieval and synthesis cycle.

### 6. Improve source authority

The original guessed URLs such as `https://{library}.dev/llms-full.txt`. The replacement uses an explicit resolver order:

1. Installed package metadata, bundled README/docs, type declarations, and source maps.
2. Lockfile-resolved npm package tarball.
3. Repository URL from package metadata at an exact tag or commit.
4. Explicit official documentation sources configured by the repository.
5. `llms.txt` or documentation pages discovered only from the verified official origin.

Every returned patch carries source URI, version/revision, and content hash.

### 7. Improve verification

Starting an MCP server and killing it proves little beyond Node's willingness to wait on stdin. The new specification requires:

- unit tests for chunking, FTS escaping, lockfile parsing, source resolution, budgets, and invalidation;
- fixture-based hook tests using real Codex hook JSON;
- an SDK client smoke test that initializes the server, lists tools, indexes fixture docs, and performs a lookup;
- an installation test in a temporary repository that verifies config merges rather than overwrites.