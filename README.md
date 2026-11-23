<img src="docs/logo.svg" width="96" alt="Skelcrew">

# Skelcrew

Skelcrew is a crew of coding agents, always on, in parallel and isolated, from issue to merged PR. Bring your own harness and model.

You run `sc` in a checkout and talk to that repository's lead, an agent that plans the work with you and starts threads. Each thread is a builder agent in its own branch, clone and sandbox. A fresh reviewer reviews its PR, and they go back and forth until it is ready. You merge.

## Getting started

Five steps take you from nothing to a first merged task.

### 1. Install

The script runs on macOS and Linux, needs no sudo, and puts `sc` in `~/.local/bin`. If that folder isn't on your PATH, the script says so and gives the line to add to your shell's startup file. Add it and open a new terminal, or `sc` won't be found. Then plain `sc` starts Skelcrew when you are ready to open a repository.

```sh
curl -fsSL https://skelcrew.dev/install.sh | sh
```

Plain `sc` checks for `tmux`, `git` and a sandbox (`bwrap` 0.11 or newer on Linux, `sandbox-exec` on a Mac). It names the command that fixes a missing tool or a sandbox that cannot start. It installs the background service and asks for a harness login when an agent needs one. No personal `config.yaml` is required.

### 2. Set up a repository

Go to a checkout of one of your GitHub repositories, switch to its default branch, such as `main`, and run `sc init`.

```sh
cd ~/code/app
git switch main
sc init
```

`sc init` asks which installed harnesses the lead, builders and reviewers use, offering the other harness for reviews as a second opinion. Each can name an optional model. It leaves the setup and test commands unset: the lead finds them in your repository and proposes them at its first start. It allows 3 builders at once, which you can change in `skelcrew.yaml`. It saves all of this in `skelcrew.yaml` and writes only repository files: `skelcrew.yaml`, `skelcrew.lock` with the GitHub plugin pinned, and `.agents/`, which holds the roles and flow agents follow.

Skelcrew's agents read these files only from the default branch, and `sc` stops until `skelcrew.yaml` is there. So `sc init` offers to commit only its own files and push them to your default branch. Say yes, or run the git commands it prints.

`sc init` then installs the plugins the files name, as `sc install` would. It asks before installing the GitHub plugin, `skelcrew/skelcrew-github`: say yes. The plugin signs you in to GitHub and installs Skelcrew's GitHub App on the repository, so Skelcrew acts on GitHub as `skelcrew[bot]`, never as you. It asks no machine questions and starts no service. It ends with `Run sc and tell your lead what to build.` Plain `sc` then adds the repository and opens its lead.

A clone with `skelcrew.yaml` already needs `sc install` for its plugins, then `sc` to open it. Every repository Skelcrew works on needs one, so run `sc init` in any other.

### 3. Meet the lead

The lead opens beside a sidebar of the repository's tasks. Run `sc` in the checkout to open it again.

### 4. Run a first task

Ask the lead in plain words, such as:

> Add a CSV export to the reports page.

It proposes a thread, with a title and a one-line summary, and starts it once you say yes. It files no issue unless you ask it to. Or add the `skelcrew` label to an issue on GitHub, and Skelcrew starts a thread on it within a minute or so.

Every task gets a name, such as `APP-12`, with its issue beside it, such as `#483`. An issue no task has yet goes by `APP#483`. Use your task's name where this page says `APP-12`.

The task shows in the sidebar. Your typing starts in the lead, so press Ctrl+\ to bring it to the sidebar. Then move to the task's row with the arrow keys and press Enter, or click the row, to see its builder at work beside the sidebar. Ctrl+\ brings your typing back to the sidebar from there too. Alt+Q leaves the screen, and the agents run on.

The builder submits each round, and a fresh reviewer reviews it. Only a P1 holds the PR back: a bug someone will hit, a security or data-loss problem, or the task not done. Smaller findings are listed on the PR, and filed in the backlog once it merges. After 3 rounds of changes, the task waits for you. `sc start APP-12` lets it go on.

When a thread needs you, the lead asks in Needs you, at the top of the sidebar: a short title, and how many options it has. Move to the item and press Enter to read it whole, then press a letter to answer, or `r` to type a reply. Your answer goes back to the lead.

When the PR is approved and green, merge it on GitHub, or with `m` on its row. Or arm it to merge once it is ready:

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

The install runs plugin-only `sc install` on the server for your checkout's remote. It leaves personal settings, locks and tokens on their own machines. It puts Skelcrew there first if missing, after asking. Then `sc --remote <host>` starts the service and opens that repository's lead, asking for an agent login when needed. Each machine keeps its own personal plugin lock.

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
| `sc notify --via <channel> "<subject>" "<text>"` | The lead's, to send you a message you asked for, such as by email or push, with your words in `--asked-file`. Your `notify:` in `~/.config/skelcrew/config.yaml` sends the daily digest and needs-you messages to notifier plugins too. |

`sc --help` lists every command and key.

## Status

Skelcrew is in beta. The design is in [docs/spec.md](docs/spec.md).

## License

Skelcrew is licensed under the [Apache License 2.0](LICENSE).
