<img src="docs/logo.svg" width="96" alt="Skelcrew">

# Skelcrew

Skelcrew is a crew of coding agents, always on, in parallel and isolated, from issue to merged PR. Bring your own harness and model.

You run `sc` in a checkout and talk to that repository's lead, an agent that plans the work with you and starts threads. Each thread is a builder agent in its own branch, clone and sandbox. A fresh reviewer reviews its PR, and they go back and forth until it is ready. You merge.

## Getting started

Five steps take you from nothing to a first merged task.

### 1. Install

The script runs on macOS and Linux, needs no sudo, and puts `sc` in `~/.local/bin`. If that folder isn't on your PATH, the script says so and gives the line to add to your shell's startup file. Add it and open a new terminal, or `sc` won't be found. Then `sc install` sets up the machine.

```sh
curl -fsSL https://skelcrew.dev/install.sh | sh
sc install
```

`sc install` checks for `tmux`, `git`, a sandbox (`bwrap` 0.11 or newer on Linux, `sandbox-exec` on a Mac) and a harness, Claude Code or Codex. If one is missing, it says what to install and stops. If `bwrap` is there but can't start a sandbox, as AppArmor can cause on Ubuntu 24.04 and later, it says what may block it, with the lines that allow it when AppArmor is the likely cause.

Then it asks:

- **The coding agent**, the harness agents run on.
- **The coding agent for reviews**, only when both are installed. It offers the other one first, as a second model sees what the first one misses. With one installed, reviews run on it.
- **A sign-in for Skelcrew's agents.** For Claude Code, you run `claude setup-token` in another terminal and paste the token. Codex gets a login of Skelcrew's own, apart from yours.

It ends with `Skelcrew is set up.` Running it again changes nothing that is done.

### 2. Set up a repository

Go to a checkout of one of your GitHub repositories, switch to its default branch, such as `main`, and run `sc init` there.

```sh
cd ~/code/app
git switch main
sc init
```

It writes `skelcrew.yaml`, `skelcrew.lock` with the GitHub plugin pinned, and `.agents/`, which holds the roles and flow agents follow. Say yes when it offers the GitHub plugin, `skelcrew/skelcrew-github`. The plugin signs you in to GitHub and installs Skelcrew's GitHub App on the repository, so Skelcrew acts on GitHub as `skelcrew[bot]`, never as you.

The files count once they are on the default branch, so commit and push them:

```sh
git add skelcrew.yaml skelcrew.lock .agents
git commit -m "Set up Skelcrew"
git push
```

### 3. Open the lead

```sh
sc
```

The lead opens, with a sidebar of the repository's tasks. Its first proposal is a thread that finishes the setup. It reads what your CI runs and fills in `setup:` and `test:` in `skelcrew.yaml`, the commands every builder uses. Say yes. The thread opens a PR, and once it is reviewed, merge it.

### 4. Run a first task

Ask the lead in plain words, such as:

> Add a CSV export to the reports page.

It proposes a thread, with a title and a one-line summary, and starts it once you say yes. It files no issue unless you ask it to. Or add the `skelcrew` label to an issue on GitHub, and Skelcrew starts a thread on it within a minute or so.

Watch it from another terminal:

```sh
sc --list         # the repository as a list. Enter opens an agent, Ctrl+\ comes back
sc ps             # the threads, with their status and which need you
sc show APP-12    # one task: its threads, PR, checks and review
```

Use your task's name where these say `APP-12`. The lead and `sc ls` show it: a task from an issue is named after it, such as `APP-12`, and one you asked the lead for is named like `APP-T100`. The builder submits each round, and a fresh reviewer reviews it. When the PR is approved and green, merge it on GitHub or with `m` in the list. Or arm it to merge once it is ready:

```sh
sc merge --when-ready APP-12
```

Or ask the lead, such as "merge it when it's ready". It still waits for the approval and green CI. To stop the lead arming merges, put `lead: { can_merge: false }` in `~/.config/skelcrew/config.yaml`.

### 5. Optional: run it on a server

Skelcrew can run on a server of your own, so the work carries on after you close the laptop:

```sh
sc --remote <host> install   # such as simon@workbox
sc --remote <host>
```

The install sends your settings, plugins and the agents' token there, puts Skelcrew there if it is missing, and runs `sc install` there. Then `sc --remote <host>` opens the server's lead over ssh. Skelcrew runs there as a background service, so it survives logging out and reboots. Run the install again whenever you change your settings or plugins.

## How it works

Each thread gets its own agent, in its own clone and sandbox, with no tokens inside. A fresh reviewer reviews each round, on the other harness if you chose it. Only Skelcrew itself, outside the sandbox, pushes and talks to GitHub.

A repository's `.agents/` tells agents how to work. So Skelcrew asks before using it, the first time and after each change. Until you approve a change with `sc repo trust <repo>`, new tasks run on the version you approved. Plugins run as you, so Skelcrew never installs one without showing it and asking.

## Key commands

| Command | What it does |
| --- | --- |
| `sc` | Opens the lead of the repository you are in, with the sidebar of its tasks. Alt+Q quits, and the agents run on. |
| `sc --list` | Shows the repository as a list. Enter opens a row, such as an agent or a PR. Ctrl+\ comes back from an agent. In a wide terminal, a pane beside the list shows the task you are on and its agent at work. |
| `sc ls` | Lists the tasks, with each one's stage, status, PR, CI and review. |
| `sc show <task>` | Shows one task: its description, threads, PR, checks and review. |
| `sc ps` | Lists the threads, with their status and which need you. |
| `sc start <task>` | Starts a task's builder, resumes a stopped one, or lets one go on past the round limit. |
| `sc add <repo> "<title>" "<body>"` | Files a task in the backlog. `--start` starts it at once instead. `--issue` files it as an issue in the tracker instead. |
| `sc stop <task>` | Ends a thread's agent and keeps its clone, branch and PR. |
| `sc rm <task>` | Ends the work on a task, closing its PR and its issue. `--keep-issue` keeps the issue open, to start over. |
| `sc merge --when-ready <task>` | Merges the PR once it is approved and green. `--cancel` disarms it. |
| `sc plugin add <owner/repo>` | Adds a plugin to this repository, after asking. `-g` adds one of your own. |

`sc --help` lists every command and key.

## Status

Skelcrew is in beta. The design is in [docs/spec.md](docs/spec.md).

## License

Skelcrew is licensed under the [Apache License 2.0](LICENSE).
