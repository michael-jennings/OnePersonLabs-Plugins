---
name: "opsxx-implementation-order"
description: "Report the current implementation order for all **active** changes, derived live from each change's `proposal.md` `## Dependencies` section. Use this skill when the user wants to know what the implementation order is."
---

Report the current implementation order for all **active** changes, derived live from each change's `proposal.md` `## Dependencies` section.

**Source of truth**

Each active change's `## Dependencies` section (upstream edges only). **Do not re-implement the grammar in prose here** -- the one executable definition is the `$opsxx-dependency-audit` skill's `scripts/opsxx-deps.mjs` (the same parser the dependency-gate hook, `$opsxx-advance`, and `$opsxx-orchestrate` use). Run it and render its JSON:

```bash
node .agents/skills/opsxx-dependency-audit/scripts/opsxx-deps.mjs --graph
```

It emits `{ nodes, edges, archivedEdges, dangling, acyclic, cycles, backlogNodes, blockedByBacklog }`:

- `nodes` -- active change names.
- `edges` -- active upstream edges `{from (blocker), to (dependent), tier: "required"|"coherence", anchor}`. **Both tiers are real ordering edges**; a `coherence` edge orders work exactly like a `required` one (it differs only for the audit). The `anchor` is the symbol/file/contract justifying a required edge (may be null until backfilled).
- `archivedEdges` -- upstream already shipped (archived); it has cleared its edge.
- `dangling` -- a backticked kebab token resolving to neither active nor archive. If non-empty, report it loudly (the gate would normally have blocked it; a survivor predates the gate and needs fixing).
- `acyclic` / `cycles` -- if `acyclic` is false, report `cycles` loudly at the top (`## Cycle detected`) and stop ordering; a cycle is a modeling bug to resolve, not topo-sort around.
- `backlogNodes` -- backlog upstreams that are valid blockers but not implementable work.
- `blockedByBacklog` -- active changes blocked directly or transitively by backlog upstreams. Exclude these changes from the implementation sequence, dependency graph, and parallel-work recommendation sections.

**Steps**

1. **Run `node .agents/skills/opsxx-dependency-audit/scripts/opsxx-deps.mjs --graph`.** That JSON is the graph; you do not parse proposals yourself.
2. **If `acyclic` is false**, emit `## Cycle detected` with `cycles` and stop. **If `dangling` is non-empty**, report it and stop.
3. **Remove backlog-blocked changes** from the orderable set using `blockedByBacklog[].change`; render them separately.
4. **Topologically sort** the remaining active `edges` after filtering out edges whose `from` or `to` is backlog-blocked (archived edges are already excluded). No-active-deps first; then by depth. Within a tier, stable-sort by name.
5. **Group into phases by functional purpose.** Max 8 phases, single-level numbering (`Phase 1`, never `Phase 1a`/`1.1`). A phase title is a short functional label ("Foundation", "Recognition spine", "Cloud Mind"), not a depth or timing label. A phase holds 1+ changes.

**Output shape**

Render these sections **in this order, omitting any that do not apply** (no empty sections, no "N/A" filler):

- `## Required Implementation Sequence` -- always. One intro sentence, then `### Phase N: <Label>` groups. Each change as `**N. <kebab-name>** (<dep annotation>)` with 2-4 substantive bullets (purpose / produces / consumes / key package). `(No active dependencies)` or `(Depends on: add-foo, add-bar)` -- always kebab-names, never `#N`. Numbering is global and sequential across phases. No trailing periods on bullets.
- `## Backlog Blocked` -- only if `blockedByBacklog` is non-empty. List each blocked active change with the backlog blocker names from `blockedByBacklog[].blockedBy` and, when useful, the shortest path from the planner-provided `paths`; do not include these changes in the required sequence.
- `## Dependency Graph` -- only if at least one active edge exists. Fenced code block, kebab-names, `↓` / `→` arrows. No `#N`, no archived ancestors.
- `## Scheduler Ready Sets` -- only if 2+ changes can land independently. Render graph layers as ready sets
  using dependency state only, and label them as scheduler input rather than a promise that every member can
  run together; the parallel orchestrator still applies sync-overlap, dirty-target, interference, and worker-cap gates.
- `## Cleared by archive` -- only if an active change's declared upstream is already archived. One line per change: `add-foo -- upstream add-bar already shipped`.

Do **not** emit Key Dependencies / File Dependencies / Implementation Notes / CI sections unless the active set genuinely warrants them; this report carries only what the current graph supports.

**Guardrails**
- Writes no file. Output is the response only.
- Never edit a proposal's `## Dependencies` from this command -- it is read-only over the dependency data.
- Reference changes by kebab-name everywhere. `#N` numbers churn as changes archive.
