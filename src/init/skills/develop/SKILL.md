---
name: develop
description: Build a Skelcrew task whose spec is approved, while the developer watches, and report it done. Use when the developer asks to build a task, such as when the developer asks to build task 12, or types "/develop 12".
disable-model-invocation: true
---

# Build a Skelcrew task

You build the task the developer named, such as 12, from its approved spec, here in this
conversation.

If you weren't given a task number, ask the developer which task, and wait. Don't run any
`skelcrew` command until you have one.

The commands below use 12 as the task number. Use the number the developer gave instead.

## 1. Claim the task

Run `skelcrew claim` with the task number the developer gave, such as `skelcrew claim 12`.
This makes this session the one working on the task.

If the claim is refused, tell the developer why, in one sentence, and stop. For example, the
spec may not be approved yet, or too many agents may be working already.

The claim prints your session. Every report you make needs it. Your harness may start each
shell command fresh, so setting it once may not last. Put
`SKELCREW_SESSION=<the session it printed>` in front of every `done` and `give-up`, as the
commands below show.

The claim's output tells you where to work. If it doesn't, stop and tell the developer.

## 2. Do the work

The spec is in your worktree, named like the branch, such as `docs/specs/12-csv-export.md`.
Read it, and don't edit it.

Work only where the claim told you to. Build what the spec asks for, and nothing more. If
something in the spec is unclear, ask the developer in the conversation and wait for the
answer. Don't guess.

Commit your work to the task's branch as you go.

## 3. Report it done

Run this, with your session and task number:

```
SKELCREW_SESSION=<session> skelcrew done 12
```

It waits while the checks run on your branch, then prints the result.

- If the checks pass, your part is over. Tell the developer.
- If a check fails, the result names it. Fix what it names, commit, and report done again.

## If you cannot go on

If the task cannot be finished at all, give up with the reason, in one or two plain
sentences:

```
SKELCREW_SESSION=<session> skelcrew give-up 12 "<reason>"
```

Then tell the developer.

## What you never do

These are never yours to do, even when they would get the checks to pass:

- Never push the branch, and never force push.
- Never use `--no-verify`, and never skip a hook in any other way.
- Never edit `.skelcrew/workflow.yml`, `.claude/settings.json`, or the skills in
  `.agents/skills/`. They set the rules you work under, such as which checks run and what
  needs the developer's approval. If one looks wrong, tell the developer.
- Never weaken a test or a check to make it pass.
- Never approve anything. Never run `skelcrew approve`. Only the developer runs it.
- Never merge the branch. That is never your decision.

If a call is refused because the task was blocked or dropped, stop at once. Tell the
developer, and do nothing more for this task.
