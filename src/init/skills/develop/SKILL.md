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

## If Skelcrew started you

Skelcrew starts a develop agent in the background with `--background` after the task number,
such as `/develop 12 --background`. If that's how you were started, nobody is watching this
conversation, and these steps change:

- Don't claim the task. You already hold it. Skip step 1. You work in the folder you started
  in: the task's worktree, on its branch.
- Run `skelcrew log 12` to read the spec you build from. It also shows why the task is back,
  if it is, such as a failed check or the developer's note.
- `SKELCREW_SESSION` is already set, so leave it out in front of commands.
- You may edit files in your worktree, commit, and run the checks in `.skelcrew/workflow.yml`.
  Anything else follows the developer's settings, and is refused if they don't allow it.
  Commit with `git add` and `git commit`, written just like that. A form such as
  `git -c … commit` is refused.
- Ask the developer with `skelcrew ask`, not in the conversation. Ask one question at a time,
  with two to four options, the one you recommend first:

  ```
  skelcrew ask 12 'Keep the old export too?' 'No, replace it (recommended)' 'Yes'
  ```

  Then end your turn and wait. The developer's answer arrives as your next message.
- Write your report as your last message. The developer reads it when they step into this
  session, or in the task's log.

Everything else in this skill holds.

## 1. Claim the task

First check that the task's spec is approved. Run:

```
skelcrew status
```

Find the task's line, such as `- #12 CSV export`. The heading above it names its phase. If it
is under Idea or Spec, don't claim it. A claim there would make you its spec writer, not its
builder. Tell the developer "#12 has no approved spec yet. Run `/spec 12` first." Then stop.

Otherwise, run `skelcrew claim` with the task number the developer gave, such as
`skelcrew claim 12`. This makes this session the one working on the task.

If the claim is refused, tell the developer why, in one sentence, and stop. For example, too
many agents may be working already.

If the claim says the task is in Spec, stop too, and tell the developer the same thing. Do no
work on it.

The claim prints your session. Every report you make needs it. Your harness may start each
shell command fresh, so setting it once may not last. Put
`SKELCREW_SESSION=<the session it printed>` in front of every `done` and `give-up`, as the
commands below show.

The claim's output tells you where to work. If it doesn't, stop and tell the developer.

## 2. Do the work

Work only where the claim told you to. Build what the spec asks for, and nothing more. If
something in the spec is unclear, ask the developer in the conversation and wait for the
answer. Don't guess.

Commit your work to the task's branch as you go.

### Understand first

Before you change anything:

- Read `AGENTS.md` or `CLAUDE.md`, if the repository has one. Its rules bind the work. If the
  spec asks you to break one, stop and tell the developer.
- Read the whole spec the claim printed, including what it leaves out. If the claim printed
  why the task is back, such as a failed check or merge, or a note from the developer, that
  comes first.
- Read the code the spec touches. Check the real data, types and tests, not the spec's
  description of them. If they disagree, tell the developer. Never change the spec yourself.
- Run `git status` and `git log` in the worktree. Work already there is an earlier attempt at
  this task. Build on it, and don't throw it away without asking.

### Test first

For each behaviour the spec asks for:

1. Write the failing test first. Run it, and check that it fails for the reason you meant. An
   import error or a typo is a broken test, not a failing one. If it passes at once, the
   behaviour is already there or the test checks nothing.
2. Write the smallest code that makes it pass. Then tidy up while it stays green.
3. Commit that behaviour, its test and its code together. The message says what changed and
   why.

Tests check what a user of the code sees, not private helpers. Follow the patterns of the
code around you. Don't refactor, rename or reformat what the spec didn't ask for. Don't add
structure for a need that doesn't exist yet.

A small choice the spec leaves open, such as a name or where a helper goes: make it, and list
it in your report. A choice that changes what a user sees, the scope or the design: ask.

If you notice work the spec didn't ask for, don't build it. Suggest it to the developer as a
new task.

## 3. Review your own diff

The checks Skelcrew runs at done catch what the commands in `.skelcrew/workflow.yml` catch,
such as a failing test. Reading the code against the spec is yours. So before you report
done, review what you built, as a senior engineer who didn't write it would.

If your harness can start a helper agent with a fresh context, let it review instead of you.
Someone who didn't write the code finds more. Give it the worktree, the spec and this
section. Tell it to report its findings and never edit a file.

Read every line of the diff against the main branch: `git diff main...HEAD` in the worktree,
or the `main_branch` that `.skelcrew/workflow.yml` names. Then look for:

- Code that doesn't do what the spec says, or meets a criterion in letter but not in fact.
- Each acceptance criterion: check it yourself against the code and tests. Being told it's
  met is not evidence.
- Existing behaviour the change breaks.
- Unsafe handling of outside input, secrets in code or logs, or data shown to someone who
  shouldn't see it.
- Wrong assumptions about real data, a library, or what existing code promises.
- Missing cases: empty, missing or malformed input, calls repeated or at the same time, and
  cases where doing nothing is right.
- Weak tests: an assertion too loose to fail, a test of a mock instead of the behaviour, or a
  behaviour with no test. Break the line a test is about, in a copy, and see the test fail.
- Complexity nothing needs, and anything unrelated in the diff.
- A mistake in the spec, built faithfully. That is a finding against the spec: tell the
  developer.

Then search the rest of the repository:

- **Already there:** for each constant, type or function the change adds, is there one
  elsewhere that does the same thing?
- **Now false:** a comment, doc or skill outside the diff that the change makes untrue.
- **Left behind:** anything the change stops using that nothing else uses now.

Any sentence in the spec or your change with *always*, *never*, *only* or *cannot*: run it,
if that takes minutes at most. A sentence you only read may be wrong.

Sort what you find. **Critical** is wrong behaviour, an unmet criterion, a security problem,
or a weakened test. **Important** is a real problem that should be fixed. **Minor** is small,
and goes in your report. A style you would have written differently is not a finding.

Fix each Critical and Important finding in its own commit, changing only what it names. If a
finding says a rule from the spec is too strict, re-read the spec first. Usually the code
has drifted from it. Then review again, this time the fixes only.

At most three rounds. If Critical or Important findings remain after the third, don't report
done. Tell the developer what remains and what each round tried, and wait.

## 4. Verify by running it

Run the checks yourself first: the commands under `checks` in `.skelcrew/workflow.yml`.
Skelcrew runs them again when you report done, and each failure there uses up an attempt.

Then establish each acceptance criterion by running something: the test that covers it, or
the code itself, used the way a user would use it. A criterion you can't establish is not
met. If the spec's own words give a criterion to the developer to check, it is theirs: say
what you checked in its place.

Check that every file in the diff is one the spec needs, and that no test, assertion or
fixture was weakened.

If a check fails or a criterion isn't met, fix it, and review the fix. That counts as one of
the three rounds.

## 5. Report it done

Run this, with your session and task number:

```
SKELCREW_SESSION=<session> skelcrew done 12
```

It waits while the checks run on your branch, then prints the result.

- If the checks pass, your part is over. Tell the developer.
- If a check fails, the result names it. Fix what it names, commit, and report done again.

### What you tell the developer

Start with the result in one sentence: done, done with a concern you name, or stuck. Then:

- each acceptance criterion, with what you ran that shows it holds;
- what you couldn't check, and what the developer still has to check themselves;
- the choices you made that they might disagree with, and any Minor findings left.

Never claim a check ran, or a criterion holds, unless you saw it. An honest partial report
beats a complete-looking one.

Write so it makes sense on the first read. The plain answer first. One idea per sentence,
about 20 words at most. The reader's words, not the code's. A small example where the
mechanism is hard to picture.

## If you cannot go on

If the task cannot be finished at all, give up with the reason, in one or two plain
sentences:

```
SKELCREW_SESSION=<session> skelcrew give-up 12 '<reason>'
```

Put the reason in single quotes, so the shell keeps it as it is. Write a single quote inside
it as `'\''`.

Then tell the developer.

## What you never do

These are never yours to do, even when they would get the checks to pass:

- Never push the branch, and never force push.
- Never use `--no-verify`, and never skip a hook in any other way.
- Never edit `.skelcrew/workflow.yml`, `.claude/settings.json`, or the skills in
  `.agents/skills/`. They set the rules you work under, such as which checks run and what
  needs the developer's approval. If one looks wrong, tell the developer.
- Never weaken a test or a check to make it pass.
- Never approve anything, and never send work back. Never run `skelcrew approve`, and never
  run `skelcrew reject`. Only the developer runs them.
- Never merge the branch. That is never your decision.

If a call is refused because the task was blocked or dropped, stop at once. Tell the
developer, and do nothing more for this task.
