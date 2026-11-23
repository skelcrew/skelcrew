# Getting started

This guide takes you from nothing to a first merged pull request.

You need macOS or Linux, a GitHub repository of yours, and Claude Code or Codex.

## 1. Install Skelcrew

```sh
curl -fsSL https://skelcrew.dev/install.sh | sh
```

This puts `sc` in `~/.local/bin`. It needs no sudo.

If that folder isn't on your PATH, the script says so and gives you the line to add. Add it, then open a new terminal.

## 2. Set up your machine

```sh
sc install
```

It first checks for `tmux`, `git`, a sandbox and a coding agent. If one is missing, it tells you what to install, and stops. Install it and run `sc install` again.

Then it asks a few questions:

- Which coding agent your agents run on.
- Which one runs the reviews, if you have both. A second model catches what the first one misses.
- A sign-in for your agents. For Claude Code, it asks you to run `claude setup-token` in another terminal and paste the token.

It ends with:

```
Skelcrew is set up.
```

You can run it again at any time. It skips what is already done.

## 3. Set up a repository

Go to a checkout of your repository, on its default branch, and run `sc init`:

```sh
cd ~/code/app
git switch main
sc init
```

It asks which coding agent the lead, builders and reviewers use. Then it writes `skelcrew.yaml`, `skelcrew.lock` and an `.agents/` folder. These tell Skelcrew how agents work on this repository. It leaves the setup and test commands to the lead, and allows 3 builders at once, which you can change in `skelcrew.yaml`.

Skelcrew's agents read these files only from the default branch. So `sc init` offers to commit and push them. Say yes, or run the git commands it prints.

Then it installs the plugins the files name, such as the GitHub plugin. Running `sc init` is your yes, so it asks nothing. The plugin signs you in to GitHub and installs Skelcrew's GitHub App on the repository. From then on, Skelcrew acts on GitHub as `skelcrew[bot]`, never as you. It ends with:

```
Run sc and tell your lead what to build.
```

A teammate who clones the repository then needs only `sc install`.

## 4. Talk to the lead

```sh
sc
```

The screen opens. The lead is on the right, and your typing goes to it. The sidebar on the left lists the repository's tasks.

The lead is an agent that knows your repository. You tell it what you want, and it plans the work with you. It never starts anything without your yes.

Its first proposal finishes your setup. It reads your CI and fills in the commands builders use to set up and test the code. Say yes, and it starts that as your first task.

## 5. Your first task

Ask the lead in plain words:

> Add a CSV export to the reports page.

It proposes a task, with a title and a one-line summary. Say yes, and it starts it.

The task gets a name, such as `APP-12`. A builder agent starts work on it, in its own clone and sandbox. Your own checkout is never touched.

You can also start a task from GitHub. Add the `skelcrew` label to an issue, and Skelcrew starts it within a minute or so.

## 6. Merge it

The builder opens a pull request. A reviewer agent reviews it, and the builder fixes what the review asks. This goes on until the review approves it.

It doesn't go on forever. After 3 rounds of changes, by default, the task stops and waits for you under Needs you. [How a task goes](how-a-task-goes.md#6-the-round-limit) says what to do then.

Once it is approved and CI passes, the task waits for you to merge it. It shows under Needs you, at the top of the sidebar, and its row says `ready to merge`. Merge it on GitHub as you always do.

Or, in the sidebar, go to the task's row and press `m`. It asks before it merges:

```
Merge app#7 into main? y/n
```

Or tell Skelcrew to merge it once it is ready, and walk away:

```sh
sc merge --when-ready APP-12
```

## Leaving

Press Alt+Q to leave the screen. You see:

```
Your agents keep running. Run sc to come back.
```

They do. Run `sc` again to come back.

## Next

- [The screen](the-screen.md): how to move around.
- [How a task goes](how-a-task-goes.md): what happens between your yes and the merge.
