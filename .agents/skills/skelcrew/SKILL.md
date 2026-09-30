---
name: skelcrew
description: Tell the developer what waits on them in Skelcrew, who is working on what, and the rest, in plain words. Use when the developer asks what is going on, what waits for them, or what the crew is doing, or types "/skelcrew".
---

# What the crew is doing

You tell the developer, in plain words, where their Skelcrew tasks stand. You only read. You
change nothing.

## 1. Read the status

Run:

```
skelcrew status
```

Its output is text for people. Skelcrew has no form of it for programs yet, so read it as
text. It has two parts:

- **Waiting on you:** one line per task, such as `- #3 CSV export: approve its spec.` A task
  that waits for someone to start it says `nobody is working on it`.
- **Tasks by phase:** Idea, Spec, Ready, In progress, Checks, Done and Dropped. Each task
  line says who is working on it, such as `(session-k3x9q2mf is working on it)`, and whether
  it is blocked. With projects, the phases come under each project.

## 2. Tell the developer

Use three parts, in this order. Leave out a part with nothing in it.

### Waiting on you

One line per task: its number and title, what it needs, and the command that does it. For
example:

- `#3 CSV export`: its spec waits for your approval. Read it with `/log 3`, then
  `/approve 3`, or send it back with the line `/log 3` ends with.
- `#5 Login fix`: its merge waits for your approval. Read the draft pull request at the link
  status gives, or `/log 5`. Then `/approve 5`, or send it back with the line `/log 5`
  ends with.
- `#7 Dark mode`: nobody is working on it. In Spec, start it with `/spec 7`. In Ready or In
  progress, start it with `/develop 7`.
- `#8 Search`: blocked, with the reason status gives. Retry it with `skelcrew retry 8`, or
  drop it with `skelcrew drop 8`.
- `#9 Export`: its agent asked a question. Give the question, and say to answer it where the
  agent asked.
- `#2 Old report`: its revert failed. Say to revert it by hand, or try again.

### Who is working on what

One line per task someone is working on: its number, title, phase, and the session. For
example, "`#4 PDF export` is In progress, with session-k3x9q2mf."

### The rest

The other tasks, by phase, one short line each. Ideas first, then the others in the order
status gives. Leave out dropped tasks, unless the developer asks for them. With many done
tasks, give their count, not each one.

If there are no tasks at all, say so, and that `/add <title>` adds one.

## What you never do

You only read and tell. Never run a command that changes a task. Give the developer the
commands above, and let them choose.

Write so it makes sense on the first read. The plain answer first. One idea per sentence.
