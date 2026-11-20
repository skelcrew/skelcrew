<img src="docs/logo.svg" width="96" alt="Skelcrew">

# Skelcrew

Skelcrew is a crew of coding agents, always on, in parallel and isolated, from issue to merged PR. Bring your own harness and model.

You run `sc` in a checkout and talk to that repository's lead, an agent that files issues and starts threads. Each thread is a builder agent in its own branch, clone and sandbox. A fresh reviewer reviews its PR, and they go back and forth until it is ready. You merge.

## Install

```sh
curl -fsSL https://skelcrew.dev/install.sh | sh
sc install
```

The script runs on macOS and Linux, needs no sudo, and puts `sc` in `~/.local/bin`.

`sc install` sets up the machine, and skips each step already done:

1. It checks for `tmux`, `git`, a sandbox (`bwrap` 0.11 or newer on Linux, `sandbox-exec` on a Mac) and a harness, Claude Code or Codex. If one is missing, it says what to install.
2. It asks which harness agents run on. With both installed, it asks which one runs reviews, offering the other first, as a second model sees what the first one misses.
3. It signs that harness in for Skelcrew's agents. For Claude Code you run `claude setup-token` in another terminal and paste the token. Codex gets a login of Skelcrew's own, apart from yours.
4. It installs the plugins your files name, each only after showing what it is and asking.

Plain `sc` runs these steps too, on a machine that isn't set up yet.

## First run

1. Run `sc` in a checkout of one of your GitHub repositories.
2. Say yes when it offers the GitHub plugin, `skelcrew/skelcrew-github`. It signs you in to GitHub and installs Skelcrew's GitHub App on the repository. Skelcrew then acts on GitHub as `skelcrew[bot]`, never as you.
3. The lead opens. Skelcrew works from the repository's GitHub issues, with nothing to write or push.

There are two ways to start work:

- **Ask the lead**, such as "add a CSV export". It files the issue and starts a thread, after asking you.
- **Add the `skelcrew` label** to an issue on GitHub. Skelcrew starts a thread on it within a minute or so, and the lead tells you.

Skelcrew needs two commands from the repository's `skelcrew.yaml`, and never guesses them. Skelcrew runs `setup:` in each builder's clone before the builder starts. Builders run only the tests near their change. The whole suite runs on review or in CI; see [docs/spec.md](docs/spec.md). The lead proposes them before its first thread. Or run `sc init`, which writes the standard setup: a starter `skelcrew.yaml`, a `skelcrew.lock` pinning your forge's plugin, and the default roles and flow in `.agents/`. Its `setup:` and `test:` lines are commented-out examples, and the lead's first proposal is a thread that fills them in. The files count once you push them to the default branch.

A repository's `.agents/` tells agents how to work, so Skelcrew shows it and asks you before using it, the first time and after each change. Until you approve a change with `sc repo trust <repo>`, new tasks run on the version you approved.

## Day to day

| Command | What it does |
| --- | --- |
| `sc` | Opens the lead of the repository you are in, with the sidebar of its tasks. |
| `sc --list` | Shows the repository as a list. Enter does what the row offers, such as opening an agent or a PR. Ctrl+\ comes back to the list from an agent. |
| `sc ls` | Lists the tasks, with each one's stage, status, PR, CI and review. |
| `sc show <task>` | Shows one task: its description, threads, PR, checks and review. |
| `sc ps` | Lists the threads, with their status and which need you. |
| `sc attach <thread>` | Opens a thread's builder full screen, with no sidebar. Ctrl+\ detaches back to your shell. |
| `sc start <issue>` | Starts a thread on an issue, resumes a stopped one, or lets one go on past the round limit. |
| `sc stop <thread>` | Ends a thread's agent and keeps its clone, branch and PR. |
| `sc merge --when-ready <thread>` | Merges the PR once it is approved and green. `--cancel` disarms it. |

A task is named after its issue, such as `app-12`. In the screen, Alt+Q quits and the agents run on. From an agent opened in the list or with `sc attach`, Ctrl+\ steps back. `sc --help` lists every command and key.

## On a server

Skelcrew can run on a server of your own, so the work carries on after you close the laptop:

```sh
sc --remote <host> install   # such as simon@workbox
sc --remote <host>
```

The install sends your settings, plugins and the agents' Claude Code token there, puts Skelcrew there if it is missing, and runs `sc install` there. Then `sc --remote <host>` opens the server's lead, over `ssh -t`. The engine runs there as a background service, under systemd or launchd, as `sc up --bg` does, so it survives logging out and reboots. Run the install again whenever you change your settings or plugins.

## Plugins

Plugins bring in work and change where agents run. They run as you, so Skelcrew never installs one without showing it and asking.

| Command | What it does |
| --- | --- |
| `sc add <owner/repo>` | Adds a plugin to this repository's `skelcrew.yaml` and `skelcrew.lock`. |
| `sc add -g <owner/repo>` | Adds a plugin of your own, in `~/.config/skelcrew/`. |
| `sc plugins` | Lists your plugins, and what `sc install` would change. |
| `sc install` | Installs the plugins the files name, after asking. |

Agents run in tmux by default. As an option, herdr can host them through its runtime plugin, `skelcrew/skelcrew-herdr`: add it with `sc add -g skelcrew/skelcrew-herdr`, then set `session: herdr` in your `config.yaml`.

## How it works

Each thread gets its own agent, in its own clone and sandbox, with no tokens inside. A fresh reviewer reviews each round, on the other harness if you chose it. Only the engine, outside the sandbox, pushes and talks to GitHub. The lead, builders and reviewers run on Claude Code or Codex, as your `config.yaml` and the repository's `.agents/` say.

## Status

Skelcrew is in beta. The full design is in [docs/spec.md](docs/spec.md).

## License

Skelcrew is licensed under the [Apache License 2.0](LICENSE).
