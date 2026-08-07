---
name: "opsxx-finish"
description: "Finishes a new or active OpenSpec change. Use when the user asks to finish a change end to end."
---

Run the complete finish pipeline for an OpenSpec change. Execute the steps in sequence, stopping if any step surfaces unresolvable issues.

**Input**: Optionally specify a change folder name (e.g., `$opsxx-finish add-auth`). If omitted, infer from conversation context or prompt the user to select.

**Steps**

1. **Resolve the change**

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `openspec list --json` to get available changes and ask the user to select one

   Always announce: "Finishing change: **<name>**"

   Store the resolved name -- every subsequent step uses it.

   Before artifact creation, record `newChange`:
   - Set it to `true` only when current-workflow evidence establishes that the exact change was created during the current user-request workflow and has not entered apply. This includes a target that is absent before step 2 and created by `$opsx-ff`.
   - Set it to `false` for every pre-existing or ambiguous change. Do not infer newness from timestamps, Git status, task counts, or incomplete artifacts.

2. **Fast-forward artifact creation**

   Run ``$opsx-ff <name>`.

3. **Reconcile tasks**

   If `newChange` is `true`, skip this step: a new change has no historical task drift.

   Otherwise, run `$opsxx-reverse-apply <name>`.

4. **Apply**

   Run `$opsx-apply <name>`.

   **Gate**: Keep `$opsx-apply` running while any executable task remains. Stop only when Apply identifies a concrete unresolved blocker and explains why no safe in-scope work can proceed. Incomplete tasks mean Apply is unfinished; they are not themselves a reason to stop. Do not continue the finish pipeline until every task is complete.

5. **Audit implementation/spec truth**

   If `newChange` is `true`, skip this step: review and verification own any disagreement introduced by the first apply.

   Otherwise, run `$opsxx-audit <name>` confined to specs and code within the blast radius of this change, and with remediation authorized by this finish request. Resolve findings owned by the named change through that change before review; route unrelated findings through `$opsxx-audit` without expanding the change's single intent. Do not weaken or remove unresolved normative product intent without explicit user direction.

6. **Review**

   Run `$adversarial-review` on the change artifacts (`proposal.md`, `design.md`, `tasks.md`, and `specs/*/spec.md`if found) and  files modified during `opsx-apply`.

   **You MUST fix all FAIL and WARN findings before continuing.**

   **Gate**: If any FAIL finding cannot be resolved, stop and report with `❗STOPPED: {message}`. Do not continue with known failures.

7. **Verify change**

   Run `$opsx-verify <name>`.

   Do not run, require, inspect, or refresh E2E during generic finish verification. A change-specific E2E belongs only to an explicit implementation task executed during apply.

   **Gate**: If verification reports any issues, fix it and repeat step 7.

8. **Sync specs** -- if the change dir contains `specs/*/spec.md` files, sync the change's delta specs to main; otherwise, skip this step.

   Use `$opsx-sync <name>`.

9. **Archive change**

   Run `$opsx-archive <name>`.

10. **Report**

After all steps succeed, report:

Include exactly one reconciliation line and one sync line. Do not mark a skipped stage as completed.

```
## Finished: <name>

Pipeline complete:
- [x] Apply -- all tasks implemented
- [x] Adversarial review -- no unresolved findings
- [x] Reconcile -- tasks reconciled with code state and specs reconciled with implementation (existing changes only)
- Reconcile -- skipped because this change was created in the current workflow (new changes only)
- [x] Verify -- implementation matches artifacts
- [x] Sync -- delta specs merged to main specs (when delta specs exist)
- Sync -- skipped because the change has no delta specs (when no delta specs exist)
- [x] Archive -- moved to openspec/changes/archive/YYYY-MM-DD-<name>/
```

**Error handling**

If any step fails or surfaces unresolvable issues:
1. Stop the pipeline immediately
2. Report which step failed and why
3. Show remaining steps that were not executed
4. Suggest the specific command to resume from (e.g., "Fix the issues, then run `$adversarial-review` followed by the remaining steps, or re-run `$opsxx-finish` to retry from the top")
