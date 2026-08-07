---
name: "opsxx-dependency-audit"
description: "Run the deterministic OpenSpec cross-change dependency audit and relay its advisory report. Use when the user asks for a dependency audit, anchor drift check, undeclared dependency triage, or coherence-edge reconfirmation."
---

Run the deterministic audit and relay its output verbatim. There is no reasoning, ranking, or guessing to add in the skill; that determinism is the whole point.

```bash
node .agents/skills/opsxx-dependency-audit/scripts/opsxx-deps.mjs --audit
```

It prints a ranked, **advisory** report. It always exits 0 and is never a gate:

- **ANCHOR_DRIFT** -- a `Required` edge whose upstream no longer produces the anchored symbol. This is the high-precision "act on this" finding: the anchor is stale or wrong.
- **PENDING** / **BACKLOG_BLOCKED** / **PASS** counts -- edges whose upstream is chartered-but-unlanded (PENDING, edge stands), valid but held by backlog status (BACKLOG_BLOCKED), vs landed-and-verified (PASS).
- **UNDECLARED_CANDIDATE** -- a dependent references a symbol some change is known to produce but declares no edge to it. This is a deterministic grep over the anchor symbol index, not inference. Treat it as triage material.
- **RECONFIRM** -- `Coherence` edges, which cannot be grep-verified. Re-affirm or retire them.

Relay the report as your response. Surface any ANCHOR_DRIFT findings loudly because they are actionable. Present UNDECLARED_CANDIDATE and RECONFIRM as triage lists. Do not edit any proposal from this command.

For the raw findings object, run:

```bash
node .agents/skills/opsxx-dependency-audit/scripts/opsxx-deps.mjs --audit --json
```

## Guardrails

- Writes no file. Output is the response only.
- Never edit a proposal's `## Dependencies` from this command -- it is read-only over dependency data.
- Reference changes by kebab-name everywhere.
