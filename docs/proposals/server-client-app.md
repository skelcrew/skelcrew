# Proposal: server, client, app

Nov 26, 2026 · @Simon · a proposal from a brainstorm. Nothing here is decided.

This is not the spec. `docs/spec.md` still describes Skelcrew as built, and it wins where the two disagree. This document describes a possible next shape, so an audit can map today's code against it.

A note on words. "Your lead" is new here: your own harness, on your laptop. "Project lead" is the spec's lead, the one that knows the repository. Whether the unit is a repository or a project is an open question below.

## The idea in short

`sc` is both server and client. The server does the work, the client is your seat.

- **Server:** the factory. Runs task flows, holds the state, exposes the API, serves the web app.
- **Client:** a CLI that runs your harness as your lead, connects to a server (local or remote), and pushes the server's messages into the harness.

The same binary runs locally with no setup, or on a server shared by a team.

## Three layers of agents

1. **Your lead.** Your harness (pi, Claude Code, Codex), on your laptop. Knows you.
2. **Project leads.** One per project, in the factory, shared by the team. Know the project.
3. **Builders and reviewers.** Started by project leads, in the factory.

## Parts

### Server: `sc serve`

- Runs task flows: project leads, builders, reviewers, sandboxes, plugins.
- Holds all state in SQLite.
- Exposes one API plus an event stream. Everything else is a consumer of these.
- Serves the app on the same port.

### Client: `sc <harness>`

- Starts your harness in a pty and sits between it and your terminal. Everything passes straight through, so the harness looks and behaves as usual.
- The wrapper is there in every case, also inside tmux or herdr.
- Gives the lead the `sc` commands (`sc tasks`, `sc ask <project> "..."`, `sc start "..."`) and a short skill explaining how to act as a lead.
- Holds one connection to a server. No state of its own beyond which factory and who you are.
- Pushed events ("task 12 needs you") are written into the pty, as if you had typed them. This is the one way a push arrives.
- The wrapper sees your keystrokes, so it waits while you are typing. A harness hook says when the harness is idle. `docs/learnings.md` covers the traps of typing into a session.
- It catches one shortcut key before the harness does. The key is configurable.
- `sc open 12` opens a task in the app. `sc open 12/spec` opens one of its artifacts.

The wrapper is thin. It never keeps a virtual screen or draws the harness into part of the terminal. That would be a multiplexer.

### The wrapper talks, the multiplexer lays out

A multiplexer is your own choice, set in your own config, such as `~/.config/skelcrew/config.yaml`. It decides only where the sidebar goes.

| How you start | What you get |
| --- | --- |
| No session setting | The harness in the wrapper. The shortcut shows the task list as a full screen overlay. |
| `session: tmux`, started outside tmux | `sc` opens a tmux session, with the harness in one pane and the sidebar in another. |
| Started inside tmux | The harness runs in your current pane. The shortcut opens the sidebar as a split of your window. No nesting. |

- An adapter for a multiplexer has one job: open a split that runs `sc tasks --watch`. tmux is built in, and herdr is a few lines.
- `sc` never splits your window unasked. Inside an existing session the sidebar appears only when you press the shortcut.
- Inside tmux the split is offered even with no session setting.
- The spec's `session:` setting says where builders' sessions run. With a remote factory that is the server, and this setting is the laptop's. The two need telling apart, by file or by a second key.

### Sidebar

- `sc tasks --watch`, in a split or as the overlay.
- Read-only: a list of what is running, with status.
- Selecting a task opens it. One key attaches to the builder, another opens the task in the app.
- Reads the same API and event stream as the app, and holds no state of its own.
- The sidebar shows what is running. The app shows one task. Neither repeats the other.

### Who a message is for

Today builders' messages land in the chat you share with the lead. Here the server sorts each message before it reaches a session.

- **Status**, such as "PR opened": the task list only. Nobody's chat.
- **Questions an agent can answer:** the project lead.
- **Needs you:** your harness and the inbox, batched. Only this.

### App

- Server-rendered HTML, written as plain TypeScript functions. No framework and no build step.
- One small script listens to the event stream and refreshes what changed.
- Plain CSS in one file. Phone layout first.
- Screens: tasks, task (timeline, artifacts, PR links, attach command), inbox (questions and other things that need you), settings (projects, plugins and secrets, people).
- Every screen has a URL, so it works against a remote factory, on a phone and for teammates.
- Tests fetch a page and check the HTML.
- Deliberately absent: chat, diffs, log streaming, editing. Talking happens in the harness, reviews on GitHub.

### Artifacts

- Specs, review pages and questions are artifacts: files attached to a task and served by the server at a URL.
- An agent adds one with `sc artifact add 12 spec.html`.
- `sc open 12/spec` opens it in a normal browser window. A bare window, such as Chromium's `--app`, is an option.
- Questions also show in the inbox. PRs link to GitHub.

### Agent-written HTML is untrusted

An artifact is written by an agent, from text that may come from anywhere. If it ran with your login, it could act as you. So from day one:

- Artifacts are served from an origin of their own, apart from the app and the API.
- They are shown in a sandboxed frame, under a strict content security policy.
- An artifact can't call the API, read the session cookie or reach the network.

## Local and server

### Local: no server needed

- `sc <harness>` with no factory configured starts one in the background on the laptop. It connects over localhost, the way tmux or Docker start their own daemon.
- Closing the harness leaves the factory running. Running `sc <harness>` again reattaches and replays what was missed.
- `sc open` shows the app on localhost.
- First run is install, then `sc pi` in a repository. No join, no networking.
- Limitation to state on first run: tasks pause when the machine sleeps.

### What a server adds

- **Always on.** Tasks continue when the laptop sleeps. Scheduled and overnight work becomes possible.
- **A shared factory.** One set of project leads, roles, plugins and secrets for the team.
- **More parallelism.** The server carries many builders, and the laptop stays quiet.
- **Safer unattended agents.** Broad permissions on a box that holds only the code.
- **Any device.** Laptop, second machine, phone.
- **A stable address for integrations.** Webhooks from Slack and GitHub.
- **Consistency.** One environment instead of each person's laptop.

A server becomes worth it at three moments. Work should continue without you, you want more agents than a laptop can carry, or a second person joins.

### Moving from local to server

`sc serve` on a box, `sc join user@server` on the laptop. Nothing about the way of working changes, only where the factory lives.

### More than one factory

A client can know several factories, such as a local one for personal projects and a team one for work. Each project names its factory in the repository's config, so `sc <harness>` picks the right one by directory.

## Principles

- **One binary, one API.** Server and client are the same `sc`. Client, app, and any later MCP layer or relay all speak the same API.
- **CLI first, MCP later.** Every coding harness has a shell. MCP becomes a thin wrapper over the same commands, mainly for chat apps and phones.
- **Nothing in the open source requires a hosted service.** Test for every feature: could a team that never talks to our servers still use it?
- **Bun and TypeScript.** Same as today. Shared API types across server, client and app.

## Reaching a server

| Way | When | Notes |
| --- | --- | --- |
| localhost | Local mode, the default first run | Factory started automatically by the client |
| ssh | First version, default for remote | `sc join user@server`; `sc open` forwards the app port |
| Tailscale | Cheap extra, if detected | Publishes factory and app to the tailnet with HTTPS; tailnet identity can act as login |
| Relay | Later | Factory dials out to a hosted switchboard; no networking for the team |

## Feedback and trust

- Opt-in anonymous usage stats, asked on first run: install, first task started and finished, weekly counts, harnesses and plugins in use.
- Never sent: code, prompts, task titles, repository names, hostnames or usernames.
- `sc telemetry show` and `sc telemetry off`. `DO_NOT_TRACK` is respected.
- Optional email on first run.
- `sc feedback "..."`, usable by the lead with the user's approval.
- A privacy page listing every outbound connection the software can make.

## What changes from v6

- Client and server separate, talking over the API (localhost or network).
- You talk to your own agent, and it talks to the leads. Today you talk to a repository's lead.
- The sidebar becomes a read-only list you toggle: an overlay, or a split in your multiplexer.
- The web page shows a task, its artifacts and the inbox.

Everything else (flows, leads, builders, reviewers, plugins, sandboxes) stays.

## How to get there

Not from scratch. First an audit, then a transplant.

1. **Audit.** Map every v6 module to server, client, app or api. Mark each keep, repair or remove. Report tests per module and every place the engine depends on the screen. No code changes.
2. **Structure.** Set up `server`, `client`, `app` and `api`, with lint rules enforcing the boundaries and the API types as the contract.
3. **Transplant.** Move v6 modules in one at a time, as small reviewed pull requests. Build the new parts fresh against the API.

v6 keeps running throughout. If the audit shows the engine can't be separated from the screen, the server is written fresh, still API first and module by module.

## Suggested build order

1. Server API and event stream.
2. Message sorting, so status stops landing in chats. This can ship in v6 first.
3. A spike: can Bun run a harness in a pty, pass everything through and write a paste into it?
4. Client: `sc <harness>` in the wrapper, against a local factory.
5. Sidebar: `sc tasks --watch` as an overlay, and as a split in tmux. herdr after.
6. Client against a remote server over ssh (`sc join`).
7. Artifacts, served sandboxed, with the task page and the inbox.
8. The rest of the app: settings.
9. Opt-in usage stats and `sc feedback`.
10. Tailscale detection, if it is under half a day.
11. Relay, when a team asks to skip the networking.

## Open questions

- Is the unit a repository, as in the spec, or a project that can hold several repositories?
- Do project leads live forever in the factory, or wake per conversation?
- When two people's leads ask a project lead for conflicting things, how is that surfaced?
- If the pty spike fails on Bun, does `sc` fall back to a private tmux underneath?
- Which harnesses have hooks good enough to say "idle", and what happens for one that has none?
- May your agent answer a "needs you" itself, and which kinds must reach you word for word?
- Locally, with one person and one repository, is a project lead needed, or can your agent start builders?
- Where does identity live before the relay exists: ssh keys, tailnet users, or local accounts?
- Exact Tailscale Serve flags and identity headers need checking against current docs.
- How does a local factory's state move to a server when someone upgrades?
- Which parts of `docs/spec.md` would this change, and when does the spec get updated?
