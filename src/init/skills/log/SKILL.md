---
name: log
description: Show where one Skelcrew task stands, with its spec and history, and what the developer has to decide. Use when the developer asks where task 12 stands, or what its spec or merge holds, or types "/log 12". Also use it when you need a task's state yourself.
---

# Show a Skelcrew task

You show the developer where the task the developer named, such as 12, stands. You only
read. You change nothing.

If you weren't given a task number, ask the developer which task, and wait.

The commands below use 12 as the task number. Use the number the developer gave instead.

## 1. Read it

Run both:

```
skelcrew status
skelcrew log 12
```

From `skelcrew status`, take the task's line. Its output is text for people, so read it as
text. The line under "Waiting on you" says what the task needs from the developer, if
anything. For a merge that waits, it gives the link to the draft pull request, or why there
is none. The line under the task's phase says who is working on it, and whether it is
blocked.

From `skelcrew log 12`, take the task's title, its history, and its spec. The newest line
that says "sent a spec" or "written by hand" holds the spec: its scope, then its acceptance
criteria. A line that says the worktree was made names the task's branch, such as
`task/12-csv-export`.

## 2. Tell the developer

Start with one sentence: the task, its phase, and what happens next. For example: "#12 CSV
export is in Checks, and its merge waits for your approval."

Then, in short parts:

- **Who works on it:** the session, or nobody.
- **The spec:** its scope and acceptance criteria, in full. If it has none yet, say so.
- **History:** the few events that matter, such as a send-back and its note, or a failed
  check. Not every line of the log.
- **Blocked:** if it is, the reason, and the two ways on: `skelcrew retry 12` or
  `skelcrew drop 12`. Never run them yourself.

## 3. When it waits on the developer

### A spec that waits for approval

Show the whole spec. Then name the decisions in it the developer might disagree with: what
it leaves out, a choice between two ways, or a rule it adds. Name anything vague, such as a
criterion nobody could check.

### A merge that waits for approval

Tell the developer each of these:

- **Where to read it:** the draft pull request's link from status, or why there is none.
- **What changed:** run `git diff --stat main...task/12-csv-export`, with the task's branch
  from the log, and the main branch that `.skelcrew/workflow.yml` names, if it names one.
  Read the diff itself too. Then say in a few plain sentences what the change does, against
  the spec.
- **The checks:** what the log says about them, such as "The local checks passed."
- **Each acceptance criterion:** whether it holds, and the evidence. Use what the agent
  reported, if its report is in this conversation. Skelcrew doesn't keep that report. So if
  you don't have it, say no evidence was reported, and name the test in the diff that covers
  the criterion, if there is one.
- **Worth a closer look:** files outside the spec's scope, changed tests or fixtures,
  especially a weakened assertion, and critical files. The log names the critical files the
  merge changes. Changes to `.skelcrew/workflow.yml`, `.claude/settings.json`, the skills in
  `.agents/skills/`, or what the checks run also belong here.

Don't claim a criterion holds unless you saw the evidence. Say what you couldn't check.

## 4. End with the developer's two commands

When the task waits for the developer's approval, end with these two lines, with the task's
number:

```
! skelcrew approve 12
! skelcrew reject 12 "<note>"
```

Say that the developer types one of them. In Claude Code, a line that starts with `!` runs
as the developer's own command. In another harness, they type it in a terminal, without
the `!`. They can also approve with `/approve 12`.

Showing is all this skill does.
You never run `skelcrew approve` or `skelcrew reject` yourself.

Write so it makes sense on the first read. The plain answer first. One idea per sentence.
