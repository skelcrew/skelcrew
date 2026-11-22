# How a task goes

A task is a piece of work you want done. This guide follows one from your first words to its merge.

## 1. The lead proposes

You tell the lead what you want, in plain words:

> The login page sends people to a 404 after they sign in. Can you fix it?

The lead proposes a task: a title, a one-line summary, and what it will do.

It files no GitHub issue unless you ask for one. Work for later goes in Skelcrew's backlog instead.

## 2. You say yes

Nothing starts without your yes. Once you say it, the lead starts the task, and it gets a name, such as `APP-12`.

You can start a task yourself too:

```sh
sc start app#483        # an issue on GitHub
sc add app "Fix the login redirect" "Sign-in lands on a 404." --start
```

Or add the `skelcrew` label to an issue on GitHub.

If the repository already has as many builders at work as its limit allows, the task waits in the Task queue. It starts once a builder is free.

## 3. The builder builds

A builder is an agent of its own. It works in its own clone, on its own branch, in a sandbox. It never sees your GitHub token.

When it has something to show, it hands in a round. Skelcrew pushes its branch and opens a pull request.

If the builder has a question, it asks the lead. The lead answers it, or brings it to you in [Needs you](needs-you.md).

## 4. The reviewer reviews

Each round gets a fresh reviewer, in the default flow.

A repository can add a flow with no review, for changes too small to need one, such as a typo. The lead tells you when it picks one. Such a task skips this step and goes straight to CI. Its row says `not reviewed`, never `approved`, so you know nobody reviewed it.

The reviewer reads the change with fresh eyes, as it never saw the builder's work in progress. If you chose a second coding agent for reviews, it runs on that one.

It either approves, or asks for changes. Its review shows on the pull request, from `skelcrew[bot]`.

Only serious problems hold a pull request back. These are called P1s: a bug people will hit, a security or data-loss problem, or the task not done.

Everything else is P2 or below: wording, style, naming, unlikely edge cases. Those never block. The review lists them as not blocking, and approves.

After a few rounds, 3 by default, the review gets less strict. A P1 then blocks only when this change brought it. A problem that was already there gets listed, not blocked on. A repository can set that number in its flow, in `.agents/flows/`.

When the task merges, Skelcrew files the not-blocking findings as one task in the backlog, so nothing is lost.

## 5. Back to the builder

When the review asks for changes, Skelcrew types it into the builder. The builder fixes it and hands in another round. The reviewer reviews again.

Other things wake the builder too:

- A CI check that fails. The builder gets the failing check and its log.
- A comment or review you leave on the pull request.
- A conflict with the main branch.

## 6. The round limit

A builder and a reviewer could go back and forth for a long time. So after a number of rounds of changes, 3 by default, Skelcrew stops sending reviews to the builder, and the task needs you.

It shows under Needs you, and the lead tells you, such as:

```
APP-12 needs you: changes asked for after 3 rounds of changes, so the round limit is reached
```

The repository's flow can set another limit. So can you, with `rounds:` in `~/.config/skelcrew/config.yaml`.

You decide what happens next:

- Let it go on, with `sc start APP-12`.
- Merge it anyway, if what is left doesn't matter to you. `sc merge --skip-review APP-12` merges it once CI passes, without Skelcrew's approval.
- Drop it, with `sc rm APP-12`.

Your own comments on the pull request always reach the builder, even past the limit.

## 7. CI

Once the review approves, the task waits for CI under Checks. When every check passes, it is ready to merge. It then waits for you under Needs you, as `ready to merge`. One with a merge armed shows under Ready, and merges by itself.

A task on a flow with no review waits for CI the same way. Once CI passes, its row says `ready to merge, not reviewed`.

## 8. You merge

Only you merge. You have three ways:

- On GitHub, as usual.
- With `m` on its row in the sidebar.
- With a merge armed in advance, which waits for the approval and green CI:

```sh
sc merge --when-ready APP-12
```

It asks first:

```
Merge #7 (APP-12 Fix the login redirect) when it's approved and green? [y/N]
```

Only `y` arms it. You can also ask the lead, such as "merge it when it's ready".

Once it merges, Skelcrew ends the builder, cleans up its clone and tells the lead. The task moves to Done.

## Other commands

```sh
sc ls              # every task, with its stage, PR, CI and review
sc show APP-12     # one task in full
sc ps              # the threads at work, and which need you
sc stop APP-12     # pause the builder, keeping its branch and PR
sc rm APP-12       # drop the task, closing its PR and its issue
```
