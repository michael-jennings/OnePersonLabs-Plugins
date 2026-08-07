---
name: "opsxx-orchestrate"
description: "Complete dependency-ready OpenSpec changes concurrently in isolated Git worktrees, with serial root-owned verification and archive lifecycle. Use when the user asks to orchestrate or finish multiple OpenSpec changes in parallel."
---

Drive dependency-ready changes through isolated workers and serial parent closeout. The package script is the state authority:

```bash
node .agents/skills/opsxx-orchestrate/scripts/opsxx-orchestrate.mjs --dry-launch --json
```

1. Resolve every reported authoring event with its listed stock skill, then preview again.
2. Ask the operator for each reported dirty worktree. Pass an explicit `--resume-dirty-target <change>` or `--discard-dirty-target <change>`; never choose automatically.
3. From a clean primary checkout, launch admitted implementation workers with `--launch-workers`. The detached launches return immediately; changes reported as `closeoutOnly` skip worker launch.
   Set `OPENSPECX_WORKER_MODEL` and `OPENSPECX_WORKER_REASONING_EFFORT` when the operator requires an explicit worker cost/quality tier; otherwise workers inherit the Codex CLI configuration.
4. Poll persisted results with `--collect-workers`. Integrate each `done` worker immediately and serially with `--integrate-worker <change>` without waiting for unrelated workers. Preserve every non-success worktree, branch, log, and summary.
5. Run `$opsx-verify <change>`, `$adversarial-review`, feasible change-required smoke checks, and required validation. Record the successful gates:

```bash
node .agents/skills/opsxx-orchestrate/scripts/opsxx-orchestrate.mjs --checkpoint-archive <change> --gate opsx-verify --gate adversarial-review --gate smoke --gate validate
```

6. Run unchanged `$opsx-archive <change>`, then run the exact resume command emitted by the checkpoint operation.
7. Re-preview after each archived upstream so newly eligible work fills free slots. After the queue drains, run `--finalize-run`; aggregate validation must pass before successful worktrees and runtime evidence are cleaned.
