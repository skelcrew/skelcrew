---
name: approve
description: Approve the merge of a Skelcrew task that waits for the developer, or its spec when the repository asks for spec approval. Use only when the developer asks to approve task 12 themselves, or types "/approve 12".
disable-model-invocation: true
---

# Approve a Skelcrew task

The developer asked to approve the task the developer named, such as 12. You show it to them
first, then approve it. Usually that merges the task's work into main. In a repository where
specs wait for approval too, it can also approve a spec.

If you weren't given a task number, ask the developer which task, and wait.

The commands below use 12 as the task number. Use the number the developer gave instead.

## 1. Show the task

Show the task the way the log skill does, in `.agents/skills/log/SKILL.md`: read
`skelcrew status` and `skelcrew log 12`, then tell the developer where it stands. For a merge,
show where to read the draft pull request, what changed, the checks, each acceptance criterion
with its evidence, and what is worth a closer look. For a spec, show the spec and the
decisions they might disagree with.

If the task doesn't wait for the developer's approval, say so, and stop. Approving would be
refused anyway.

## 2. Approve it

Run exactly this, with the task's number:

```
skelcrew approve 12
```

Run it as written: the plain command, with nothing in front of it and nothing around it.
Never run it through `sh -c` or another shell, by a path to the program, through `bunx`,
`npx` or `env`, or with a variable set in front of it.

The plain form matters. The repository's settings make the harness ask the developer before
this command runs, and they only know the command as it is usually typed. Claude Code will
ask the developer to confirm. This is intended. The approval is the developer's, and their
answer to that question is it. Don't ask again in the conversation, and never look for a way
around the question.

If the developer says no, stop. Don't run it another way.

## 3. Tell the developer what happened

Give the command's answer in one sentence. For example:

- "Approved #12. It merged into main as a1b2c3d." for a merge.
- A merge that failed says why, and what to do next. Pass that on as it is.
- "Approved #12." for a spec. The task is Ready. It waits until someone builds it, such as
  with `/develop 12`.

If the developer changes their mind before approving, they can send it back instead. They
type this line themselves, with their note:

```
! skelcrew reject 12 '<note>'
```

The note goes in single quotes, so the shell keeps it as it is. A single quote inside it is
written `'\''`.
