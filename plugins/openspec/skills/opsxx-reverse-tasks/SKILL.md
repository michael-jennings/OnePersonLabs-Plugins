---
name: opsxx-reverse-apply
description: Audit an OpenSpec change's tasks.md against the actual codebase state. Reports which tasks are completed-but-unchecked (silent landing), stale (referencing dead code or moved paths), and genuinely pending. Use when a change's task list is suspected of lagging code reality, before running opsx-apply or opsx-verify, or as part of close-down hygiene to catch silent completion drift.
license: MIT
metadata:
  author: openspec
  version: "1.0"
---

Reverse-audit a tasks.md file against the current codebase. Cross-check each task's references (files, symbols, type names, exports) against what exists today. Produce a report classifying every task into one of four buckets, then optionally edit tasks.md to mark verified-completed tasks `[x]` with a "(landed silently)" parenthetical.

This skill exists because OpenSpec changes accumulate silent completion drift: work lands in code via adjacent changes, refactors, or independent fixes without anyone updating the original change's tasks.md. The result is a tasks.md that looks 0% done when the code is 60% done. $opsx-apply against such a list re-does completed work and misses the actual gaps (registration, routing, tests).

## Input

The argument after $opsxx-reverse-apply is the change name (kebab-case). If omitted, ask the user after listing changes via `openspec list --json`.

Optional second argument: `--dry-run` (report only, don't update tasks.md).

## Steps

1. **Resolve the change directory** -- `openspec instructions apply --change "<name>" --json` returns the change dir + context. Read `proposal.md` (for the file references in Impact) and `tasks.md` (the audit target). Read `design.md` if present (it often clarifies which symbols a task expects to exist).

2. **Build the audit corpus** -- list every distinct symbol, file path, type name, exported function, exported class, and check-box description from `tasks.md`. For each task, extract:
   - File paths (e.g. `packages/foo/bar.ts`)
   - Symbol names (e.g. `ExpressionRecognizer`, `applySkillBonuses`, `IdbSkillStorage`)
   - Module exports the task claims to add
   - Test files the task claims to create

3. **For each task, run a targeted check** -- prefer `rg`/`grep` over `Read` for symbol existence. Heuristics:
   - **File-path task** ("create `apps/web/src/adapters/idb-skill-storage.ts`"): check the path exists via `ls` or `Bash test -f`.
   - **Symbol-creation task** ("add `applySkillBonuses` method to `Assessor`"): grep for the symbol name in the named file or directory.
   - **Routing task** ("wire `subdivision` into Groove coords in `fact-to-skillpoint.ts`"): grep the file for the field reference.
   - **Test-creation task**: check the test file exists and grep for the case description.
   - **Vague task** ("verify X is consistent"): mark as `unauditable` -- can't be reverse-checked without running the assertion.

4. **Classify each task** into one of four buckets:
   - **`done-silently`**: evidence in code matches what the task claims to produce. Recommend marking `[x]` with `(landed silently)` parenthetical. Two sub-variants are reported in this bucket but are **never auto-marked** (they need a human eye): `done-silently-with-drift` (the symbol exists, but in a different file/path than the task names -- note the real location) and `done-silently-with-semantic-drift` (the symbol exists but with divergent semantics -- quote the divergence). See Audit heuristics.
   - **`stale`**: the task references a file or symbol that no longer exists, OR the task's premise is contradicted by current code (e.g. "Break N: X is broken" but X has been fixed). Recommend rewording or removing.
   - **`pending`**: no evidence of completion; the task is real and uncontested.
   - **`unauditable`**: too vague to reverse-check, or depends on runtime behavior not statically observable.

5. **Generate the report** -- markdown table grouped by classification. Each row has:
   - Task ID (the section number from tasks.md)
   - One-line summary of the task
   - Classification
   - Evidence (file:line where you confirmed done-silently, or "no match for `<symbol>`" for stale, etc.)
   - Recommended action (mark `[x]`, reword, delete, or no action)

6. **If `--dry-run` was not supplied**: for every task classified plain `done-silently` (NOT the `-with-drift` or `-with-semantic-drift` sub-variants), edit tasks.md to:
   - Change `- [ ]` to `- [x]`
   - Append `(landed silently)` parenthetical at the end of the task line
   - DO NOT touch stale, pending, or drift-sub-variant tasks unless the user explicitly asked -- drift variants are reported for human review, never auto-checked
   - Prepend a "VALIDATION UPDATE YYYY-MM-DD" note at the top of tasks.md naming this skill's run

7. **Final assessment** -- one-paragraph summary: how much silent drift exists, the biggest stale claims, the genuine remaining-work count.

## Audit heuristics

- **Be conservative about marking done-silently.** A task that says "add X to Y" is done-silently only if X provably exists in Y. If the symbol exists in a different file than the task names, flag it as `done-silently-with-drift` and note the actual location.
- **Cross-reference the archive directory.** If a task references work that was supposed to happen in a different change, check `openspec/changes/archive/` for that change. If a sibling archived change covers the task, that's a strong done-silently signal.
- **Be specific about evidence.** "Done in code" is not a finding; "Done at `packages/kairos/src/recognizers/flow-grid.ts:23` -- `classifyMeterClass` exported" is a finding.
- **Don't second-guess the task's intent.** If a task says "implement X", and X exists but with subtly different semantics than the task describes, mark it `done-silently-with-semantic-drift` and quote the divergence. Don't auto-mark `[x]`.

## Output format

```markdown
## Reconcile-Tasks Audit: <change-name>

**Date:** YYYY-MM-DD
**Tasks total:** N
**Done silently:** A | **Stale:** B | **Pending:** C | **Unauditable:** D

### Done silently (recommend marking [x])

| Task | Summary | Evidence | Action |
|------|---------|----------|--------|
| 1.1  | Add classifyMeterClass to flow-grid | `packages/kairos/src/recognizers/flow-grid.ts:23` exports it | Mark `[x] (landed silently)` |
| ...  | ... | ... | ... |

### Stale (recommend rewording/removing)

| Task | Summary | Why stale | Action |
|------|---------|-----------|--------|
| 4.1  | Refactor evaluateActive timing logic | Conflicts with active `wire-challenge-target-accuracy`; this task's prescription is superseded | Reword to "Consume target-aware AttemptSummary" |
| ...  | ... | ... | ... |

### Pending (real remaining work)

| Task | Summary | Notes |
|------|---------|-------|
| 8.1  | Create before-after.test.ts | No file at `packages/kairos/src/__tests__/before-after.test.ts` | Genuinely undone |
| ...  | ... | ... |

### Unauditable

| Task | Summary | Why |
|------|---------|-----|
| 12.3 | Verify all skill spaces ship day one | Composite claim; requires runtime check | Skip |
| ...  | ... | ... |

## Summary

[One paragraph: silent-drift percentage, biggest stale finding, recommendation: apply-as-is / revise tasks.md / retire change.]
```

## When to skip

- If tasks.md doesn't exist for the change, this skill has nothing to do. Report and exit.
- If the change is `no-tasks` per `openspec list --json`, suggest $opsx-continue to generate tasks first.
- If the codebase has uncommitted in-progress changes touching the same files, surface a warning but proceed -- the audit reflects working-tree state.

## Integration with other commands

- **Before $opsx-apply <change>**: run $opsxx-reverse-apply first to avoid re-doing landed work.
- **Before $opsx-verify <change>**: run this to feed accurate completion state into verify's checks.
- **During close-down hygiene** (a session where you're shrinking the open-changes count): run this against every open change with no recent activity. Silent drift is highest after multi-week gaps.

## Worked example

The 2026-05-14 audit of `recognizer-enrichment` (126 tasks) found:
- 60% done silently (Gaps 1, 2, 5 producer-side fully landed; Gaps 3, 4 implementation landed but `ExpressionRecognizer` unregistered)
- 20% stale (Section 1 entirely superseded by archived changes)
- 20% pending (Gaps 6, 7, 8, 9 producer-side)

The resulting recommendation: RETIRE the monolith, refile as 3-4 narrower changes (which is exactly what landed in the 2026-05-14 session). Reverse-tasks made the retirement decision evidence-based rather than vibes-based.
