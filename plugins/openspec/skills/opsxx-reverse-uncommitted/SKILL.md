---
name: opsxx-reverse-uncommitted
description: Create a new OpenSpec change from existing uncommitted repository changes for historical archive purposes. Use when the user asks to reverse-engineer dirty worktree drift, bridge already-made implementation changes into OpenSpec history, or file a patch change from `git status`/`git diff`; rejects ghost deltas and delegates artifact creation to `$opsx-propose`.
---

# opsxx-reverse

Use this skill to turn already-present uncommitted repo changes into a proposed OpenSpec patch change without mutating those dirty files.

## Workflow

1. **Establish complete dirty worktree evidence**

   Run:

   ```bash
   git status --short
   git --no-pager diff --stat
   git --no-pager diff --cached --stat
   ```

   Then inspect the relevant file diffs with non-interactive commands such as:

   ```bash
   git --no-pager diff -- <path>
   git --no-pager diff --cached -- <path>
   ```

   Include untracked files only after reading enough content to understand their purpose. Treat staged
   files as evidence too; a reverse-engineered patch can be split across staged, unstaged, and untracked
   work.

2. **Classify scope before proposing**

   Identify:

   - files that clearly belong to one coherent historical patch,
   - surviving behavior or instruction changes that need a real OpenSpec delta,
   - ghost deltas whose only purpose would be to describe cleanup, archival hygiene, reference closure, or
     the reverse process itself,
   - stale references, renamed paths, dangling labels, or residue that must be repaired as part of the
     patch,
   - files that appear unrelated,
   - files whose ownership or purpose is ambiguous.

   Preserve unrelated and ambiguous files exactly as they are. Do not stage, revert, format, normalize, rename, or rewrite dirty files unless the user separately asks for that edit.

3. **Reject ghost deltas and incomplete residue**

   Do not propose OpenSpec requirements or scenarios whose only durable behavior is "we cleaned up the
   reverse bridge," "we preserved behavior," or "we removed stale references." Put that work in tasks,
   validation notes, or the final report instead.

   Use direct end-state deltas:

   - `REMOVED Requirements` only for behavior, ownership, paths, or policy that no longer exist.
   - `MODIFIED Requirements` only when the requirement remains valid and can be restated as a full updated
     requirement block without stale text.
   - `ADDED Requirements` only for durable product, tooling, or system behavior that now exists or is
     expected to exist.

   Before proposing, search affected active surfaces for stale residue from the dirty patch: active change
   artifacts, main specs touched by the patch, workflow docs, hook rules, validators, and implementation or
   config paths in scope. If the search reveals a real missed edit inside the coherent patch, include that
   edit in the implementation scope or call it out as a required task. If no legitimate spec delta remains
   after this audit, do not invent one; report that the reverse pass should be deleted or reduced to
   non-spec cleanup.

4. **Stop if the patch cannot be summarized safely**

   Ask the user for clarification when:

   - the dirty files appear to contain multiple unrelated changes,
   - a file's purpose cannot be inferred from status/diff/content,
   - the proposed OpenSpec capability or change name would be guesswork,
   - the workflow would need to stage or modify existing dirty files to proceed.

5. **Use `$opsx-propose` as the artifact boundary**

   Once the scope is coherent, invoke `$opsx-propose` with a prompt that includes:

   - a kebab-case change name,
   - the dirty files included in scope,
   - the relevant behavior inferred from the diffs,
   - the specs or capabilities likely affected,
   - stale references or residue found during the audit and how the change should handle them,
   - explicit instruction to avoid ghost requirements and keep cleanup-only work in tasks or validation,
   - explicit wording that this is a reverse-engineered historical patch bridge,
   - explicit wording that the already-uncommitted implementation is evidence, not proof of spec-first provenance.

   Do not hand-author `openspec/changes/**/proposal.md`, `design.md`, `tasks.md`, or delta specs outside an OpenSpec artifact-authoring skill.

6. **Validate and report the boundary clearly**

   After artifact creation, run the change validation command and targeted residue searches for stale paths,
   deleted change names, and rejected ghost labels that were in scope.

   Summarize:

   - the proposed change name and location,
   - which dirty files were included,
   - which dirty files were excluded or left ambiguous,
   - which ghost deltas were rejected, if any,
   - which residue searches and validations passed,
   - whether `$opsx-propose` completed all artifacts needed for implementation.

## Failure Handling

- If `$opsx-propose` is unavailable, stop and say that artifact creation is blocked. Do not bypass OpenSpec artifact instructions.
- If the worktree changes while you are inspecting it, rerun `git status --short` and re-check affected diffs before proposing.
- If the reverse-engineered proposal would need more than one coherent patch, recommend separate OpenSpec changes rather than folding unrelated drift into one archive.
