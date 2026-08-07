---
name: "opsxx-advance"
description: "Select the first unblocked active OpenSpec change and drive it through the workflow. Serial, one change, hands-off. Use this skill when the user asks to advance the next unblocked OpenSpec change."
---

Advance the project by one change: **select** the first unblocked active change with incomplete tasks, then **complete** it.

**Input**: Optionally specify a change name.

**Steps**

1. **If no change name provided, select a change **

Pick the first unblocked active change using `$opsxx-implementation-order`.

If there are no unblocked active changes with incomplete tasks, report that and stop.

2. **Announce the selection**

```
Advancing change: **<name>**

<one line: why it's next -- "no active upstream" or "resuming, 7/12 tasks done">
Unblocks: <kebab-names it gates, or "nothing downstream">
```

3. **Finish the change**

Run `$opsxx-finish <selected-change-name>`.
