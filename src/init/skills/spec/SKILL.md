---
name: spec
description: Write the spec for a Skelcrew task together with the developer, then submit it for their approval. Use when the developer asks to spec a task, such as "/spec 12".
argument-hint: "[task number]"
disable-model-invocation: true
---

# Spec a Skelcrew task

You write the spec for task $ARGUMENTS with the developer, here in this conversation.

If you weren't given a task number, ask the developer which task, and wait. Don't run any
`skelcrew` command until you have one.

The commands below use 12 as the task number. Use the number the developer gave instead.

## 1. Claim the task

Run `skelcrew claim` with the task number the developer gave, such as `skelcrew claim 12`.
This makes this session the one working on the task.

If the claim is refused, tell the developer why, in one sentence, and stop. For example, the
task may not be waiting for a spec, or too many agents may be working already.

The claim prints your session. Submitting the spec needs it. Each shell command starts
fresh, so setting it once doesn't last. Put `SKELCREW_SESSION=<the session it printed>` in
front of the submit command, as shown below.

## 2. Work out the spec with the developer

Read the task and the code it touches. Then settle these with the developer:

- **Scope:** what the task changes, and what it leaves alone.
- **Acceptance criteria:** how anyone can tell the work is done. Each one is something a
  test or a person can check.
- **Open questions:** none may be left. Ask the developer each one in the conversation, one
  at a time, and wait for the answer. Don't guess an answer to fill a gap.

Keep the spec short and plain. Show the developer the finished spec before you submit it.

## 3. Submit it

First run `skelcrew submit --help`. It says what form the spec takes. Write the spec in that
form to a file, such as `spec.json`. Then run this, with your session and task number:

```
SKELCREW_SESSION=<session> skelcrew submit 12 --file spec.json
```

If it is refused because the spec is missing something, fix what it names and submit again.

Submitting is where your part ends. You never approve a spec. Only the developer does, by
running `skelcrew approve` themselves. You never run it.

## What you never do

- Never approve anything. Never run `skelcrew approve`. Only the developer runs it.
- Never edit `.skelcrew/workflow.yml`, `.claude/settings.json`, or the skills in
  `.claude/skills/`. They set the rules you work under, such as whether a spec needs the
  developer's approval. If one looks wrong, tell the developer.

## If you are refused

If a call is refused because the task was blocked or dropped, stop at once. Tell the
developer, and do nothing more for this task.
