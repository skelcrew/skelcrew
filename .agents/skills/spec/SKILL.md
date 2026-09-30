---
name: spec
description: Write the spec for a Skelcrew task together with the developer, then submit it for their approval. Use when the developer asks to spec a task, such as when the developer asks to spec task 12, or to spec a new task called "CSV export", or types "/spec 12".
disable-model-invocation: true
---

# Spec a Skelcrew task

You write the spec for the task the developer named, such as 12, with the developer, here in
this conversation. The developer may name a new task by its title instead, such as
`CSV export`.

If you weren't given a task number or a title, ask the developer which task, and wait. Don't
run any `skelcrew` command until you have one.

Starting this skill is the developer's ask for a spec. Don't ask the developer to confirm
first.

The commands below use 12 as the task number. Use the task's own number instead.

## 1. Claim the task

First tell a number from a title. It is a task number when it is only digits, with or without a # in front, such as 12 or #12.
Anything else is a title, such as `CSV export` or `Fix the 404 on login`. So `404` alone is a
number. To start a task with a title of only digits, the developer adds a word.

**With a title**, add the task and ask for its spec in one step:

```
skelcrew add "<title>" --spec
```

Put the developer's title where `<title>` is, in quotes, so it stays one piece. It prints the
new number, such as "Added #12: CSV export." Tell the developer that number, and use it from
here on.

**Then claim it.** Run `skelcrew claim` with the task number the developer gave, or the one
`skelcrew add` printed, such as `skelcrew claim 12`. This makes this session the one working
on the task.

If the claim is refused because the task is in Idea, ask for its spec yourself, then claim
again:

```
skelcrew spec 12
skelcrew claim 12
```

If the claim is refused for any other reason, tell the developer why, in one sentence, and
stop. For example, the task may already have a spec, or too many agents may be working
already.

The claim prints your session. Submitting the spec needs it. Your harness may start each
shell command fresh, so setting it once may not last. Put
`SKELCREW_SESSION=<the session it printed>` in front of the submit command, as shown below.

## 2. Work out the spec with the developer

Read the task and the code it touches. Then settle these with the developer:

- **Scope:** what the task changes, and what it leaves alone.
- **Acceptance criteria:** how anyone can tell the work is done. Each one is something a
  test or a person can check.
- **Open questions:** none may be left. Ask the developer in the conversation, as the steps
  below say, and wait for the answers. Don't guess an answer to fill a gap.

Keep the spec short and plain. Show the developer the finished spec before you submit it.

Don't change the code while you spec. The spec is the only thing you write.

### Ground it in the code first

Before you form a view of the design:

- Read `AGENTS.md` or `CLAUDE.md`, if the repository has one. Its rules bind the spec. If the
  task asks you to break one, tell the developer.
- Run `skelcrew log 12` to see the task's title and what has happened to it so far. If the
  claim printed a note from the developer, or a spec so far, start from those.
- Read the code and files the task touches: the real files, data and tests. If the task's
  wording disagrees with the code, the code wins, and the spec says so.
- Look at how the repository already does similar things, and at `git log` for recent work
  nearby.

If the task is already done, or makes no sense against the code, tell the developer and wait.
Don't write a spec for work that doesn't need doing.

### Ask once, with your answers

List for yourself the decisions the task forces. Settle each one from the repository first:
`AGENTS.md`, an existing pattern, or a test that only passes one way.

Ask the developer only about what is left and changes what a user sees, the scope, or the
design. Ask in one message, each question with the answer you recommend first. Then wait.
Never ask about a name, or a place that follows an existing pattern, or anything `AGENTS.md`
already answers. If nothing that matters is open, ask nothing.

### The spec's shape

When you submit, the spec's text goes in `scope`, in these parts, in this order:

- **Goal:** what the task makes possible, and why, in a few sentences. If you can't say why,
  ask.
- **Today:** what the code does now, with paths like `src/report.ts:42`. "This doesn't exist
  yet" is a fine answer, with what stands in for it.
- **Change:** what a user, a caller or a test sees once the task is built.
- **Approach:** the files to change or add, and the decisions you settled, with why. Stop where
  the builder should choose. Show a signature or a data shape only where it removes doubt.
- **Tests:** what must be covered, which tests cover it already, and the inputs the task
  implies but doesn't state, such as empty, missing or repeated ones.
- **Out of scope:** nearby work left out, one line each. If one is clearly needed, suggest it
  to the developer as a new task.

The acceptance criteria go in `acceptance`, one check each, that a newcomer with the
repository can make. Prefer checks a test or a command settles.

Keep it small. The builder commits one behaviour at a time, about 200 changed lines each,
tests aside. If the approach needs more than about five such commits, spec the smallest slice
that is useful on its own, and name the rest under Out of scope.

If the task grants a permission, such as an allowlist, a path a process may write, or a
command it may run: list what each grant can reach, including every flag of a command. Then
list what two grants reach together. Run the real thing that enforces them on the actual
text. Write what you checked, and what is still open, under Approach.

### Check every sentence about today

You believe every sentence you wrote, so reading them back finds little. Run them instead.
For each sentence about what exists today, run the command or read the line that shows it.
That covers a path and line, a command and what it prints, a count, a name, and any sentence
with *always*, *never*, *only* or *cannot*. Fix each sentence the run disagrees with. If you
can't run one, say why in the spec, such as "from the docs, not run".

Then read the parts against each other. A rule said two ways, such as "before the claim" in
one part and "after the claim" in another, is a mistake to fix.

If your harness can start a helper agent with a fresh context, let it do this check instead.
It didn't write the spec, so it believes none of it. Give it the spec and ask it to run each
claim and report each as holds, fails or not run, without editing anything. Fix what it
found. Then have a fresh helper check only the sentences you fixed. After two rounds, tell the
developer about anything that still fails.

When you show the developer the spec, name first the decisions they might disagree with, and
any sentence you couldn't check.

### Write for the developer

The developer reads the spec and your questions. Each must make sense on the first read.

- The plain answer first, then the detail.
- One idea per sentence, about 20 words at most.
- The reader's words, not the code's. Name code only where the reader needs to find it.
- A small example where the mechanism is hard to picture.

## 3. Submit it

First show the developer the finished spec, and wait for them to say it can go. Submitting
before they have read it skips their say in it. If they ask for changes, make them and show
the spec again.

Then run `skelcrew submit --help`. It says what form the spec takes. Pass the spec in that
form on standard input, so no file is left behind in the repository. Run this, with your
session and task number:

```
SKELCREW_SESSION=<session> skelcrew submit 12 --file - <<'SPEC'
<the spec, in the form the help describes>
SPEC
```

If it is refused because the spec is missing something, fix what it names and submit again.

Submitting is where your part ends. You never approve a spec, and you never send one back.
Only the developer does either.

## What you never do

- Never approve anything, and never send work back. Never run `skelcrew approve`, and never
  run `skelcrew reject`. Only the developer runs them.
- Never edit `.skelcrew/workflow.yml`, `.claude/settings.json`, or the skills in
  `.agents/skills/`. They set the rules you work under, such as whether a spec needs the
  developer's approval. If one looks wrong, tell the developer.

## If you are refused

If a call is refused because the task was blocked or dropped, stop at once. Tell the
developer, and do nothing more for this task.
