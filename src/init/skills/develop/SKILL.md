---
name: develop
description: Build a Skelcrew task whose spec is approved, while the developer watches, and report it done. Use when the developer asks to build a task, such as "/develop 12".
argument-hint: "[task number]"
---

# Build a Skelcrew task

You build task $ARGUMENTS from its approved spec, here in this conversation.

## 1. Claim the task

Run `skelcrew claim $ARGUMENTS`. This makes this session the one working on the task. The
claim tells you the worktree to work in: a separate folder on the task's own branch.

If the claim is refused, tell the developer why, in one sentence, and stop. For example, the
spec may not be approved yet, or too many agents may be working already.

## 2. Do the work

Work only in the worktree the claim gave you. Build what the spec asks for, and nothing
more. If something in the spec is unclear, ask the developer in the conversation and wait
for the answer. Don't guess.

Commit your work to the task's branch as you go.

## 3. Report it done

Run `skelcrew done`. It waits while the checks run on your branch, then prints the result.

- If the checks pass, your part is over. Tell the developer.
- If a check fails, the result names it. Fix what it names, commit, and run `skelcrew done`
  again.

Never weaken a test or a check to make it pass.

## If you cannot go on

If the task cannot be finished at all, run `skelcrew give-up` with the reason, in one or two
plain sentences. Then tell the developer.

## What you never do

You never merge, and you never approve. The developer approves a merge by running
`skelcrew approve` themselves.

If a call is refused because the task was let go, because it was blocked or dropped, stop
at once. Tell the developer, and do nothing more for this task.
