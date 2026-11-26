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
- Serves the app as static files on the same port.

### Client: `sc <harness>`

- Wraps the harness in a pty, so messages can be pushed into it.
- Gives the lead the `sc` commands (`sc tasks`, `sc ask <project> "..."`, `sc start "..."`) and a short skill explaining how to act as a lead.
- Holds one connection to a server. No state of its own beyond which factory and who you are.
- Delivers pushed events ("task 12 needs you") by typing them into the harness when it is idle. They are clearly prefixed, batched, and filtered by what is worth a turn.
- `sc open` opens the app in the browser, logged in via a one-time link. `sc open 12` deep links to a task.

### App

- Static single page app, embedded in the `sc` binary, served by the server.
- Reads JSON from the API, live updates over Server-Sent Events.
- Four screens: tasks, task (timeline, PR links, attach command), inbox (things that need you), settings (projects, plugins and secrets, people).
- Phone layout first. Every screen has a URL.
- Deliberately absent: chat, diffs, log streaming, editing. Talking happens in the harness, reviews on GitHub.

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
- The harness wrapper replaces the screen.
- The web page replaces the sidebar.

Everything else (flows, leads, builders, reviewers, plugins, sandboxes) stays.

## How to get there

Not from scratch. First an audit, then a transplant.

1. **Audit.** Map every v6 module to server, client, app or api. Mark each keep, repair or remove. Report tests per module and every place the engine depends on the screen. No code changes.
2. **Structure.** Set up `server`, `client`, `app` and `api`, with lint rules enforcing the boundaries and the API types as the contract.
3. **Transplant.** Move v6 modules in one at a time, as small reviewed pull requests. Build the new parts fresh against the API.

v6 keeps running throughout. If the audit shows the engine can't be separated from the screen, the server is written fresh, still API first and module by module.

## Suggested build order

1. Server API and event stream.
2. Client: `sc <harness>` against a local factory, started automatically.
3. Client against a remote server over ssh (`sc join`).
4. App: tasks and inbox first, settings after.
5. Opt-in usage stats and `sc feedback`.
6. Tailscale detection, if it is under half a day.
7. Relay, when a team asks to skip the networking.

## Open questions

- Is the unit a repository, as in the spec, or a project that can hold several repositories?
- Do project leads live forever in the factory, or wake per conversation?
- When two people's leads ask a project lead for conflicting things, how is that surfaced?
- Is Bun's terminal support solid enough for wrapping a full harness? Needs a spike.
- Where does identity live before the relay exists: ssh keys, tailnet users, or local accounts?
- Exact Tailscale Serve flags and identity headers need checking against current docs.
- How does a local factory's state move to a server when someone upgrades?
- Which parts of `docs/spec.md` would this change, and when does the spec get updated?
