You are working in a worktree dedicated to one OpenSpec change: `$CHANGE-NAME`.

Implement only that change with `$opsx-apply $CHANGE-NAME`, run focused checks for touched surfaces, and commit the branch with the change name in the message.

Do not sync main specs, archive changes, create changes, run repository-global validation, perform final review, or mutate parent lifecycle state. Do not use destructive Git commands. If blocked, preserve the worktree and report the evidence.

Report any out-of-scope bug in `bubbledSideEffects`; the parent owns deduplication and follow-up workflow.

Return only JSON:

- success: `{ "change": "$CHANGE-NAME", "status": "done", "filesTouched": [], "commit": "<sha>", "checkStatus": "<focused checks>", "bubbledSideEffects": [], "notes": "<summary>" }`
- non-success: `{ "change": "$CHANGE-NAME", "status": "blocked|conflicted|failed", "filesTouched": [], "reason": "<evidence>", "notes": "<summary>" }`
