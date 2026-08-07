---
name: "opsxx-audit"
description: "Use when current implementation may differ from live OpenSpec specs or a named active change, durable behavior may lack specification coverage, or specified behavior may have been removed."
---

# OPSXX Audit

Compare OpenSpec behavior contracts with implementation evidence in both directions. The default result is a read-only, decision-ready report; remediation occurs only when the user separately asks to reconcile or fix findings.

## Scope

- **Capability, package, file, or domain named:** audit that focused scope against current main specs.
- **Active change named:** read its proposal, complete delta specs, design, and tasks; compare implementation against both current main specs and the change-scoped expectations. Label the two contract layers separately.
- **No scope named:** audit all current main specs in capability batches.

Active change specs are otherwise out of scope. If a requested name could be either a capability or a change, resolve it with `openspec list --specs --json` and `openspec list --json`; ask only if both exist.

## Establish Structural Context

Run:

```bash
openspec validate --specs --strict --no-interactive
openspec doctor --json
node .agents/skills/opsxx-audit/scripts/spec_inventory.mjs --markdown
```

Use `--capability <slug>` for a focused inventory and `--json` for machine-readable output. Structural validation does not replace the semantic audit.

For a named change, also run:

```bash
openspec status --change "<name>" --json
openspec instructions apply --change "<name>" --json
```

Read every returned context file. A `MODIFIED` delta replaces the complete matching main requirement for comparison; `ADDED`, `REMOVED`, and `RENAMED` deltas alter the effective change-scoped contract according to OpenSpec semantics.

## Audit Method

1. **Inventory claims.** Record each capability, requirement, scenario, normative sentence, and source line.
2. **Map implementation owners.** Use frontmatter, requirement nouns, package exports, tests, workflows, docs, and targeted `rg -l` searches before reading likely owners. Tests show intent but are not implementation by themselves. For process requirements, include skills, generated instructions, validators, hooks, scripts, and CI.
3. **Check spec to implementation.** Trace every requirement and scenario through constants, branches, state transitions, validation, side effects, and externally observable behavior. Search alternate or indirect owners before claiming absence.
4. **Check implementation to spec.** Inspect durable public, cross-boundary, security-sensitive, release-affecting, or architecture-critical behavior for missing requirement or scenario coverage. Do not demand specs for incidental private helpers.
5. **Check history before declaring an orphan.** Use targeted history for removed or renamed owners. A move implies updated evidence; deliberate removal may justify removal; unexplained removal may be a regression.
6. **Classify evidence and propose a disposition independently.**

## Finding Classes and Dispositions

| Finding | Meaning |
| --- | --- |
| `DRIFT` | Covered behavior exists but materially differs from its effective contract. |
| `MISSING_IMPLEMENTATION` | A normative requirement or scenario has no verified implementation path. |
| `MISSING_SPEC` | Durable current behavior has no covering requirement. |
| `MISSING_SCENARIO` | A requirement exists but an important current branch lacks scenario coverage. |
| `ORPHANED_SPEC` | Specified behavior was removed or abandoned, based on ownership and history evidence. |
| `AMBIGUOUS` | Available evidence cannot prove the relationship. |

Every finding also receives one proposed disposition:

| Disposition | Use when |
| --- | --- |
| `UPDATE_SPEC` | Current implementation is accepted product truth. |
| `FIX_IMPLEMENTATION` | The existing or change-scoped contract remains authoritative. |
| `ADD_SCENARIO` | Behavior is covered at requirement level but an important branch is not. |
| `REMOVE_REQUIREMENT` | Product intent explicitly rejects the old behavior. |
| `INVESTIGATE` | Ownership, runtime behavior, or product intent remains unresolved. |

For a large replacement that cannot be traced cleanly as one `DRIFT`, report `ORPHANED_SPEC` for the old behavior and `MISSING_SPEC` for the new behavior.

## Evidence Standard

Every non-ambiguous finding must include:

- spec evidence: contract layer, capability, requirement/scenario, file, line, and short normative claim;
- implementation evidence: file, line, symbol or workflow, and observed behavior;
- generated evidence when applicable: command, arguments, summarized result, and owning surface;
- absence evidence for `MISSING_IMPLEMENTATION`, `MISSING_SPEC`, `MISSING_SCENARIO`, and `ORPHANED_SPEC`: targeted searches and alternate owners or covering contracts checked.

Use `AMBIGUOUS` when behavior moved behind adapters, depends on external services, is generated without a traceable owner, or otherwise cannot be proven.

## Decision Safeguards

- Implementation is evidence, not authority. For `DRIFT`, decide whether product intent changed or implementation regressed.
- A request to finish quickly or make specs match code authorizes remediation; it does not waive evidence, history, or unresolved-intent checks.
- Preserve aspirational requirements unless evidence establishes that intent changed.
- Never weaken `SHALL`/`MUST`, drop scenarios, or recommend `REMOVE_REQUIREMENT` merely because implementation is easier or a string search failed.
- Require explicit user direction before weakening or removing unresolved normative product intent.
- If implementation might satisfy a requirement indirectly, classify `AMBIGUOUS` rather than manufacture a gap.
- Requirements describe behavior. Put data structures, algorithms, and helper details in design or implementation notes.

## Report Contract

Lead with findings ordered by impact and confidence. Each finding has this shape:

```markdown
- [DRIFT → FIX_IMPLEMENTATION] <contract layer> / <capability> / <requirement>
  Spec: <file:line and short claim>
  Implementation: <file:line, symbol, and observed behavior>
  Impact: <why the difference matters>
  Evidence checked: <targeted surfaces or commands>
  Recommendation: <concrete next action>
```

Group coverage gaps, orphans, and ambiguous evidence separately. End with checks run, unaudited residual risk, and a remediation summary. If there are no findings, say so explicitly and still list residual risk.

## Remediation Routing

Do not mutate code, main specs, or change artifacts during an audit-only request.

When remediation was separately requested:

1. Resolve every `AMBIGUOUS` finding and every proposed normative weakening/removal with the user before editing.
2. For findings already owned by a named active change, refresh the relevant artifact instructions, revise that change's proposal/spec/design/tasks under their normal ownership, and use `$opsx-apply` for implementation work.
3. For accepted committed implementation not owned by an active change, use `$opsx-propose` with the audit evidence to create the delta change.
4. For accepted uncommitted implementation, use `$opsxx-reverse` so the dirty-worktree boundary and normal proposal workflow are preserved.
5. For authoritative specs that need code changes and have no suitable active change, use `$opsx-propose`, then `$opsx-apply`.
6. After remediation, rerun the affected audit scope. Use `$opsx-verify` and `$opsx-sync` on the owning change as appropriate.

Do not hand-author a new OpenSpec change inside this skill or duplicate task reconciliation owned by `$opsxx-reverse-apply`.
