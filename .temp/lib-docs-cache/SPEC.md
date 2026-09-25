# Doc Intelligence MCP for Codex — Implementation Specification

## 1. Goal

Build a local-first documentation intelligence layer that gives Codex the smallest trustworthy context patch needed to use external libraries correctly.

The system must minimize:

- repeated network retrieval;
- repeated search over unchanged documentation;
- prompt and tool-schema bloat;
- irrelevant documentation in model context;
- false confidence caused by model-training assumptions;
- validation work triggered after every tiny edit.

The system must maximize:

- exact-version correctness;
- source provenance;
- deterministic behavior;
- cache reuse;
- focused recovery from compiler, linter, test, and build diagnostics;
- compatibility with Codex CLI, the Codex IDE extension, and other MCP clients.

## 2. Non-goals

Do not build:

- a general-purpose internet search engine;
- a chat-with-all-docs RAG application;
- a mandatory vector database service;
- a mandatory local-LLM summarization pipeline;
- a static table claiming what the current model already knows;
- an agent that runs a full monorepo validation command after every edit;
- package-level `AGENTS.md` files generated merely because package directories exist.

## 3. Codex-native integration surfaces

Install and merge these repository-local surfaces:

```text
.codex/config.toml
.codex/hooks.json
.codex/hooks/hooklib.py
.codex/hooks/activity_tracker.py
.codex/hooks/post_tool_diagnostics.py
.codex/hooks/stop_validation.py
.codex/hooks/session_start_patches.py
.agents/skills/doc-intel/SKILL.md
.agents/skills/doc-intel/agents/openai.yaml
AGENTS.md
.doc-intel/config.json
```

Rules:

1. Never overwrite an existing configuration file wholesale.
2. Parse and merge JSON structurally.
3. Merge TOML conservatively. Preserve comments when practical; otherwise create a timestamped backup before rewriting and report the rewrite.
4. Keep the `AGENTS.md` insertion under 250 words.
5. Create nested `AGENTS.md` or `AGENTS.override.md` only for a real package-specific policy or command difference.
6. Put the reusable workflow in `.agents/skills`, not in a giant root prompt.

## 4. Runtime architecture

```text
Codex
  ├── AGENTS.md: tiny routing policy
  ├── doc-intel skill: lookup protocol
  ├── Codex hooks: observe edits, validation, diagnostics, compaction
  └── MCP: docs_lookup / docs_index / docs_status
          │
          ▼
Doc Intelligence Server
  ├── package context resolver
  ├── exact-version source resolver
  ├── source CAS (content-addressed blobs)
  ├── deterministic Markdown/API chunker
  ├── SQLite FTS5 + symbol index
  ├── optional vector reranker
  ├── patch assembler + token budgeter
  ├── patch/result cache
  └── provenance + staleness manager
```

## 5. Repository layout

Create the MCP package with focused modules:

```text
tools/doc-intel-mcp-server/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                 # stdio entry point only
│   ├── server.ts                # MCP server, instructions, tool registration
│   ├── config.ts                # env + .doc-intel/config.json resolution
│   ├── errors.ts                # typed errors and MCP result conversion
│   ├── context/
│   │   ├── workspace.ts         # repo/package discovery
│   │   ├── lockfiles.ts         # pnpm/npm exact-version parsing
│   │   └── package-context.ts   # package name/version/dir resolution
│   ├── sources/
│   │   ├── resolver.ts          # ordered source strategy
│   │   ├── installed.ts         # node_modules, types, README, bundled docs
│   │   ├── npm-tarball.ts       # lockfile-resolved package artifact
│   │   ├── repository.ts        # exact tag/commit source
│   │   ├── official-docs.ts     # explicit configured official origins
│   │   └── types.ts
│   ├── index/
│   │   ├── database.ts          # SQLite schema and migrations
│   │   ├── blob-store.ts        # SHA-256 content-addressed files
│   │   ├── chunker.ts           # deterministic Markdown/code chunking
│   │   ├── symbols.ts           # signature and symbol extraction
│   │   ├── fts.ts               # safe FTS5 queries
│   │   ├── vectors.ts           # optional runtime adapter
│   │   └── indexer.ts
│   ├── lookup/
│   │   ├── request.ts           # normalization/fingerprinting
│   │   ├── diagnostics.ts       # diagnostic classification and symbols
│   │   ├── retrieve.ts          # lexical + symbol + optional vector retrieval
│   │   ├── patch.ts             # deterministic knowledge patch assembly
│   │   ├── budget.ts            # token ceilings
│   │   └── cache.ts             # patch and negative cache
│   └── tools/
│       ├── lookup.ts
│       ├── index.ts
│       └── status.ts
└── test/
    ├── fixtures/
    ├── unit/
    ├── integration/
    └── mcp-smoke.test.ts
```

Prefer files under roughly 250 lines. Split by responsibility rather than technical fashion.

## 6. MCP server contract

Use `@modelcontextprotocol/sdk` and `StdioServerTransport`.

The MCP server initialization `instructions` field must begin with a self-contained message under 512 characters:

> Cache-first external-library documentation. Use `docs_lookup` only when exact package API evidence, version drift, or an API-related diagnostic matters. Default to `detail="patch"` and the installed package version. Reuse cached patches; escalate to evidence/source only when the patch is insufficient. `docs_index` may access configured official sources.

Expose exactly three tools. This deliberately reduces tool-definition and decision overhead.

### 6.1 `docs_lookup`

Purpose: retrieve or reuse a minimal versioned knowledge patch.

Input schema:

```ts
type DocsLookupInput = {
  request: string;
  kind?: "auto" | "question" | "symbol" | "diagnostic";
  package?: string;
  packageDir?: string;
  detail?: "patch" | "evidence" | "source";
  maxTokens?: number;
};
```

Defaults:

```text
kind = auto
detail = patch
maxTokens = 700
```

Hard limits:

```text
patch: default 700, maximum 900
evidence: default 1400, maximum 2400
source: default 3000, maximum 6000
```

Behavior:

1. Resolve repository and package context.
2. Resolve exact installed version from the nearest relevant workspace package and lockfile.
3. Normalize the request and compute a fingerprint.
4. Return an unchanged cached patch when package version and source hashes still match.
5. If a valid negative-cache entry exists, return a compact explanation and the evidence that caused the negative cache.
6. If material is indexed, retrieve it.
7. If no indexed source covers the request, return a structured `needsIndex` response. Do not silently fetch the network from a read-only lookup.
8. Assemble a deterministic patch.
9. Persist the patch and selected chunk IDs.
10. Return structured content plus concise model-readable text.

Output data shape:

```ts
type DocsLookupResult = {
  status: "hit" | "negative-hit" | "needs-index" | "no-match";
  package: string | null;
  version: string | null;
  requestFingerprint: string;
  detail: "patch" | "evidence" | "source";
  patch: string;
  evidence: Array<{
    title: string;
    sectionPath: string;
    sourceUri: string;
    sourceRevision: string | null;
    sourceHash: string;
    chunkId: number;
    score: number;
  }>;
  tokenEstimate: number;
  needsIndex?: {
    package: string;
    version: string | null;
    suggestedSources: string[];
  };
};
```

Annotations:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

### 6.2 `docs_index`

Purpose: index or refresh exact-version documentation from approved source strategies.

Input schema:

```ts
type DocsIndexInput = {
  package: string;
  packageDir?: string;
  version?: string;
  source?: {
    type: "auto" | "installed" | "npm" | "repository" | "official-url";
    value?: string;
  };
  refresh?: "if-stale" | "force";
};
```

Defaults:

```text
source.type = auto
refresh = if-stale
```

Behavior:

1. Resolve exact version when omitted.
2. Apply source resolver order from section 8.
3. Enforce configured allowed origins for remote URLs.
4. Fetch or read source material.
5. Hash source bytes before parsing.
6. Skip indexing when the same package/version/source/hash already exists.
7. Write raw material to the content-addressed blob store.
8. Deterministically chunk and extract symbols.
9. Update the DB transactionally.
10. Invalidate dependent patch/negative-cache entries only when their source hash set changed.
11. Optionally generate embeddings when the runtime adapter is enabled.

Output includes source provenance, counts, unchanged/refreshed status, and warnings.

Annotations:

```text
readOnlyHint: false
destructiveHint: false
idempotentHint: true
openWorldHint: true
```

### 6.3 `docs_status`

Purpose: inspect indexed coverage and cache validity without dumping docs.

Input schema:

```ts
type DocsStatusInput = {
  package?: string;
  packageDir?: string;
  includeTopics?: boolean;
};
```

Return:

- indexed packages and exact versions;
- source URIs, revisions, and hashes;
- chunk/symbol counts;
- stale/valid status and reason;
- patch cache hit counts;
- negative-cache entries and invalidation keys;
- whether optional vector retrieval is available.

Default response ceiling: 600 tokens.

Annotations:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

## 7. Configuration

Create committed `.doc-intel/config.json`:

```json
{
  "schemaVersion": 1,
  "lookupPolicy": "evidence-triggered",
  "defaultPatchTokens": 700,
  "maxPatchTokens": 900,
  "defaultEvidenceTokens": 1400,
  "maxEvidenceTokens": 2400,
  "defaultSourceTokens": 3000,
  "maxSourceTokens": 6000,
  "sourceOrder": [
    "installed",
    "npm",
    "repository",
    "official-url"
  ],
  "allowedOfficialOrigins": [],
  "vectorSearch": {
    "enabled": false,
    "provider": "ollama",
    "model": "nomic-embed-text",
    "baseUrl": "http://127.0.0.1:11434"
  },
  "hooks": {
    "requireValidationAfterCodeEdit": true,
    "maxDiagnosticLines": 6,
    "maxCompactionPatchTokens": 700
  }
}
```

Environment overrides:

```text
DOC_INTEL_REPO_ROOT
DOC_INTEL_CONFIG_PATH
DOC_INTEL_CACHE_DIR
DOC_INTEL_DB_PATH
DOC_INTEL_STATE_DIR
DOC_INTEL_VECTOR_ENABLED
OLLAMA_BASE_URL
OLLAMA_EMBED_MODEL
```

Paths default under `<repo>/.doc-intel/`.

## 8. Source authority and resolution

Use this order for `source.type = auto`.

### 8.1 Installed source

Inspect the exact installed package under the workspace's package manager layout.

Candidate material:

- `package.json` metadata and exports;
- README and bundled Markdown docs;
- `.d.ts` declarations;
- source files only when declarations/docs are insufficient;
- source maps that identify upstream source revision;
- package changelog and migration files.

Do not recursively index `node_modules` indiscriminately. Index only the requested package and referenced documentation files.

### 8.2 npm artifact

Resolve the exact version from the lockfile, then obtain that version's package metadata/tarball. Verify package name and version after extraction. Store artifact integrity metadata when available.

### 8.3 Repository source

Use the repository URL from verified package metadata. Resolve an exact tag or commit corresponding to the installed version. Do not index an unpinned default branch while claiming exact-version authority.

### 8.4 Official documentation URL

Use explicit repository configuration or a verified official origin derived from package metadata. Enforce `allowedOfficialOrigins` when non-empty.

An `llms.txt` file is a convenient source format, not proof of authority. It is trusted only when served by a verified official origin.

## 9. Storage model

### 9.1 Blob store

Store source bytes at:

```text
.doc-intel/cache/blobs/sha256/<first-two>/<full-hash>
```

Write atomically with temp file + rename.

### 9.2 SQLite

Use WAL mode and foreign keys.

Required tables:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE packages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  package_dir TEXT,
  UNIQUE(name, version, package_dir)
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  source_revision TEXT,
  source_hash TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE(package_id, source_uri, source_revision, source_hash)
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  section_path TEXT NOT NULL,
  content TEXT NOT NULL,
  extractive_patch TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  UNIQUE(source_id, ordinal)
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title,
  section_path,
  content,
  extractive_patch,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61 porter'
);

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  normalized_symbol TEXT NOT NULL,
  signature TEXT,
  kind TEXT,
  UNIQUE(chunk_id, normalized_symbol, signature)
);

CREATE INDEX symbols_lookup
  ON symbols(package_id, normalized_symbol);

CREATE TABLE patch_cache (
  fingerprint TEXT PRIMARY KEY,
  package_id INTEGER,
  source_hashes_json TEXT NOT NULL,
  detail TEXT NOT NULL,
  patch TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT
);

CREATE TABLE negative_cache (
  fingerprint TEXT PRIMARY KEY,
  package_id INTEGER,
  source_hashes_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0
);
```

Use triggers or explicit transactions to keep the FTS table synchronized. Test delete/update behavior.

Optional vector tables must be created only when the adapter loads successfully.

## 10. Deterministic indexing

### 10.1 Chunking

Chunk Markdown by semantic heading boundaries.

Requirements:

- preserve heading breadcrumb;
- preserve fenced code blocks intact;
- split oversized sections at paragraphs or declaration boundaries;
- target 700–1400 estimated tokens per chunk;
- never split a function signature from its parameter table or immediate example when avoidable;
- retain source line/offset metadata in `metadata_json`.

### 10.2 Symbol extraction

Extract from:

- Markdown headings such as `useQuery()` or `class Synth`;
- TypeScript/JavaScript declaration syntax;
- export statements;
- fenced API signatures;
- fully qualified names such as `Tone.Synth`;
- import paths.

Normalize case and punctuation for lookup, but preserve original spelling.

### 10.3 Extractive patch generation

At index time, generate an extractive representation without an LLM:

1. heading path;
2. signatures and imports;
3. parameter/return blocks;
4. warnings, deprecations, migration notes, version constraints;
5. smallest complete code example;
6. first concise explanatory paragraph if needed.

Never treat generated text as canonical documentation.

## 11. Retrieval and ranking

### 11.1 Candidate generation

Combine:

- exact normalized symbol matches;
- prefix and qualified-symbol matches;
- FTS5 BM25 matches;
- diagnostic-extracted package, symbol, method, property, import, and error-code terms;
- optional vector candidates.

### 11.2 Ranking

Use deterministic weighted reciprocal-rank fusion.

Suggested weights:

```text
exact symbol: 4.0
qualified/prefix symbol: 2.5
FTS title/section: 2.0
FTS content: 1.0
diagnostic term overlap: 1.5
optional vector: 0.75
same exact package version: required filter, not a score
```

Do not mix different package versions unless `detail = source` and the result is explicitly labeled as migration evidence.

### 11.3 FTS safety

Never pass raw user input directly as an FTS5 query. Tokenize, quote terms, cap term count, and fall back to a simple OR expression. Unit-test punctuation-heavy symbols such as:

```text
@tanstack/react-query
foo.bar<T>()
node:fs/promises
C#-style names
```

## 12. Knowledge patch format

Default `detail = patch` text should look like:

```markdown
[doc-intel patch]
Package: tone@15.1.22
Request: construct a poly synth with a custom voice
Authority: installed package declarations + bundled docs

Use:
- `new Tone.PolySynth(Tone.Synth, options)`
- `options` configures the voice; do not pass a preconstructed voice instance.

Signature:
```ts
new PolySynth<Voice>(voice: VoiceConstructor<Voice>, options?: RecursivePartial<VoiceOptions<Voice>>)
```

Minimal example:
```ts
const synth = new Tone.PolySynth(Tone.Synth).toDestination();
```

Caveat: [only when supported by evidence]
Sources: [2 compact provenance entries]
[/doc-intel patch]
```

Patch rules:

- lead with the correction or usable API;
- include only evidence necessary for the request;
- preserve exact signatures;
- include at most one minimal example by default;
- distinguish fact from inference;
- include compact provenance;
- never claim a diagnostic is solved before validation.

## 13. Request and cache fingerprinting

Normalize:

- package name;
- exact installed version;
- package directory identity;
- request kind;
- diagnostic code and normalized message;
- symbols/import paths;
- detail tier;
- active source hash set.

Hash the canonical JSON representation with SHA-256.

Patch cache invalidation occurs only when:

- installed package version changes;
- one of the selected source hashes changes;
- extraction/ranking schema version changes;
- repository policy explicitly forces refresh.

Negative-cache entries use the same invalidation rules. Do not use a 30-day timer as the primary validity rule.

## 14. Diagnostic handling

Support common external-API mismatch signatures without assuming TypeScript only.

Examples:

- missing export/member/property;
- wrong argument count or type;
- cannot resolve module/import path;
- deprecated API or replacement hint;
- Python import/attribute/signature errors;
- Rust unresolved import/method and trait-bound errors;
- C# missing member/type/namespace and overload errors.

`kind = diagnostic` must:

1. extract package and symbols conservatively;
2. prefer exact symbol and import evidence;
3. state when the package cannot be inferred;
4. avoid retrieving generic language tutorials;
5. return `needs-index` when authoritative material is absent.

## 15. Codex hooks

Install the templates, adapting only paths and repository-native command patterns.

### 15.1 Activity tracker: PostToolUse

Observe:

- `apply_patch` / `Edit` / `Write` to record changed code paths;
- `Bash` to record validation commands and outcomes;
- `mcp__*__docs_lookup` to retain compact active patches for compaction recovery.

The tracker writes only under `.doc-intel/state/`. It emits no model context in ordinary successful cases.

### 15.2 Diagnostic advisor: PostToolUse Bash

Inspect `tool_input.command` and `tool_response`.

Only react when:

- the command resembles build, typecheck, lint, or test validation; and
- output matches likely external API/version mismatch patterns; and
- the same normalized diagnostic was not already advised in the current session.

Return `hookSpecificOutput.additionalContext` with at most six compact diagnostic lines and an instruction to call `docs_lookup(kind="diagnostic")` before guessing.

Do not run validation itself.

### 15.3 Validation gate: Stop

When code changed after the last observed validation command, request one targeted validation pass by returning:

```json
{
  "decision": "block",
  "reason": "Code changed after the last validation. Run the narrowest repository-native typecheck/test/build that covers the changed package, then address any failures before stopping."
}
```

Avoid loops:

- if `stop_hook_active` is true, do not block again;
- do not block for docs, Markdown, images, or configuration explicitly marked non-code;
- record that the turn was prompted.

### 15.4 Patch recovery: SessionStart after compaction

Use a `SessionStart` hook with matcher `compact`. Codex explicitly delivers this event's `hookSpecificOutput.additionalContext` to the immediate continuation after compaction. Do not rely on `PostCompact` for model-context reinjection.

Inject only the active patch summaries recorded from prior `docs_lookup` calls in the current session.

- cap total near `.doc-intel/config.json` `maxCompactionPatchTokens`;
- include package/version and request fingerprints;
- exclude full evidence/source text;
- return no context when no patches exist.

## 16. Companion skill

Install the supplied template under `.agents/skills/doc-intel/`.

The skill description must front-load trigger conditions because Codex may shorten skill descriptions in a large skill inventory.

The workflow must be cache-first and use progressive disclosure:

```text
patch -> evidence -> source
```

The skill must explicitly say not to invoke for repository-local logic or an API already verified in the current session.

## 17. AGENTS.md policy

Merge this concept into the nearest applicable root `AGENTS.md`:

```markdown
## External library documentation

Use the `doc-intel` skill and MCP tools only when exact external API evidence, version drift, or an API-related diagnostic matters. Start with `docs_lookup` at `detail="patch"`; index the exact installed package version only when lookup reports missing coverage. Reuse the returned patch and validate the code before escalating. Do not fetch generic docs for repository-local logic, routine refactors, or APIs already verified in this session.
```

Do not list every dependency. The server resolves package context from the repository.

## 18. Codex MCP configuration

Merge a project-scoped config equivalent to:

```toml
[mcp_servers.doc_intel]
command = "node"
args = ["__ABSOLUTE_REPO_ROOT__/tools/doc-intel-mcp-server/dist/index.js"]
cwd = "__ABSOLUTE_REPO_ROOT__"
startup_timeout_sec = 15
tool_timeout_sec = 90
enabled = true
required = false
enabled_tools = ["docs_lookup", "docs_index", "docs_status"]
default_tools_approval_mode = "auto"

[mcp_servers.doc_intel.env]
DOC_INTEL_REPO_ROOT = "__ABSOLUTE_REPO_ROOT__"
DOC_INTEL_CONFIG_PATH = "__ABSOLUTE_REPO_ROOT__/.doc-intel/config.json"
DOC_INTEL_CACHE_DIR = "__ABSOLUTE_REPO_ROOT__/.doc-intel/cache"
DOC_INTEL_STATE_DIR = "__ABSOLUTE_REPO_ROOT__/.doc-intel/state"
```

Use absolute paths because Codex may launch from nested package directories.

## 19. Git ignore policy

Commit:

```text
.doc-intel/config.json
```

Ignore:

```gitignore
.doc-intel/cache/
.doc-intel/state/
```

Do not ignore the entire `.doc-intel/` directory.

## 20. Optional vector adapter

Vector search is disabled by default.

When enabled:

- dynamically load sqlite-vec;
- use Ollama `nomic-embed-text` unless configured otherwise;
- embed deterministic extractive patches, not giant raw chunks;
- record model name and embedding dimension in DB metadata;
- rebuild only vector rows when the embedding model changes;
- degrade to lexical/symbol retrieval on any adapter error;
- never fail lookup merely because Ollama is unavailable.

Do not add local-LLM generative summarization to the initial implementation.

## 21. Security and reliability

- Restrict indexing to the repository, package-manager cache, explicit temporary extraction directories, and approved network origins.
- Protect against path traversal in package tarballs.
- Apply response size limits before building MCP content arrays.
- Use request timeouts, redirect limits, and maximum source byte limits.
- Never log secrets, auth headers, or full environment values.
- Send logs to stderr only; stdout is reserved for MCP stdio.
- Use atomic writes for blobs and state.
- Use transactions for index replacement.
- Return typed error codes such as `PACKAGE_NOT_RESOLVED`, `SOURCE_NOT_ALLOWED`, `SOURCE_TOO_LARGE`, `INDEX_MISSING`, and `VECTOR_UNAVAILABLE`.

## 22. Test requirements

### 22.1 Unit tests

Cover:

- pnpm lockfile exact version parsing, including aliases and peers;
- package-lock parsing;
- workspace/package context resolution;
- source resolver ordering and authority labels;
- tarball path traversal rejection;
- Markdown chunking with code fences;
- symbol extraction;
- FTS query escaping;
- token budget hard ceilings;
- request fingerprint stability;
- patch and negative-cache invalidation;
- optional vector fallback.

### 22.2 Hook fixture tests

Feed JSON to each Python hook and assert JSON output/state behavior for:

- code edit;
- docs-only edit;
- successful validation;
- external API diagnostic;
- duplicate diagnostic in same session;
- Stop with unvalidated code;
- Stop after validation;
- Stop re-entry with `stop_hook_active`;
- SessionStart with `source="compact"`, with and without active patches.

### 22.3 MCP integration smoke test

Use an MCP SDK client, not a killed waiting process.

The test must:

1. initialize the server over stdio;
2. list exactly three tools;
3. index fixture documentation from an installed fixture package;
4. query an exact symbol;
5. query a diagnostic;
6. confirm cache hit on repeat;
7. modify the fixture source hash and confirm invalidation;
8. verify `docs_status` provenance.

### 22.4 Repository verification

Use repository-native package manager and commands. At minimum:

```text
build
typecheck
unit tests
integration tests
hook tests
MCP smoke test
```

## 23. Completion report

Write `docs/doc-intel/INSTALL_REPORT.md` with:

- architecture actually implemented;
- files created/modified;
- config merge behavior;
- exact verification commands and outcomes;
- sample `docs_lookup` response token estimate;
- optional vector status;
- hook trust instructions;
- limitations supported by evidence;
- no unsupported claims of production readiness.