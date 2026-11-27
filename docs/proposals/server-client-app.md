# Proposal: server, client, app

Nov 26, 2026 · @Simon · a proposal from a brainstorm. Nothing here is decided.

This is not the spec. `docs/spec.md` still describes Skelcrew as built, and it wins where the two disagree. This document describes a possible next shape, so an audit can map today's code against it.

A note on words. "Your lead" is new here: your own harness, on your laptop. "Project lead" is the spec's lead, here knowing a whole project: a home repository and the repositories listed in it. "Factory" means the server.

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

- A human review needs something to read. Specs, PR pages and questions are artifacts: files attached to a task and served by the server at a URL.
- An agent writes an artifact as markdown, with images. The server renders it to HTML with one stylesheet.
- An agent adds one with `sc artifact add 12 spec.md`.
- `sc open 12/spec` opens it in a normal browser window. A bare window, such as Chromium's `--app`, is an option.
- Questions also show in the inbox. PRs link to GitHub.

**The spec artifact** is the spec itself, nicely formatted.

**The PR page** explains the reasoning behind the code, in a fixed shape:

1. What changed and why.
2. How it maps to the spec: each point done, changed or left out.
3. Decisions and trade-offs.
4. How it was checked: which tests ran, and their result.
5. What the reviewer found, and how each finding was resolved.
6. Where to look: the one or two files worth your eyes.
7. Screenshots, when the change is visual.

- Screenshots come from running the code, taken by a tool. A repository that wants them names a `preview:` command next to `setup` and `test`.
- The same text goes on the PR on GitHub, with a link to the page.
- The two shapes are skills in the project's `.agents/skills/`, so a project can adjust them.

### Agent-written HTML is untrusted

Markdown rendered by the server is not code, so most artifacts need nothing more. An artifact that is real HTML is written by an agent, from text that may come from anywhere. If it ran with your login, it could act as you. So from day one:

- HTML artifacts are served from an origin of their own, apart from the app and the API.
- They are shown in a sandboxed frame, under a strict content security policy.
- An artifact can't call the API, read the session cookie or reach the network.

## Projects and configuration

Configuration has three homes, sorted by who owns it.

| Home | Where | What |
| --- | --- | --- |
| Yours | `~/.config/skelcrew/config.yaml` on your computer | How you sit at the server: multiplexer, shortcut, harness, which servers you joined, how you are notified |
| The server's | On the server | Which projects it serves, who has a seat, secrets, the machine's limits |
| The project's | The project's home repository | Roles, skills, plugins, limits, member repositories, risky paths |

Your own config never changes how agents work. The project's setup never holds a secret.

### A project has a home repository

A project's setup lives in one repository, its home. Other repositories join the project by being listed there, and need no Skelcrew files of their own.

```yaml
# skelcrew/skelcrew.yaml
setup: [bun install]
test: [bun run check]
limits: { threads: 5 }
plugins: [skelcrew/skelcrew-github]
risky: [src/db.ts, src/machine/**, src/sandbox/**]

repos:
  skelcrew/skelcrew-website:
    setup: [npm ci]
    test: [npm run lint, npm run build]
  skelcrew/skelcrew-github:
    setup: [bun install]
    test: [bun test]
```

- A member repository carries its own `setup`, `test`, `preview` and `risky`. Roles, skills, plugins and the lead come from the home repository.
- One lead knows the whole project, so a change across two repositories is one task.
- How to write code in a member repository stays in that repository's own `AGENTS.md`.
- An unrelated project has a home repository of its own. One server can serve both.
- The server reads a project's setup from the main branch only. A builder can propose a change to it, and it takes effect once a human merges it.
- `sc repo add` could have the lead read a repository, propose its entry and open a PR on the home repository.

### Roles and skills

These stay as the spec has them: a role is a markdown file in `.agents/roles/`, and a skill is a folder in `.agents/skills/`. What changes is that both reach builders working in member repositories.

Three roles are enough: lead, builder and reviewer. There is no planner. A builder that writes the spec keeps what it learned when it starts to build.

## How a task goes

There are no flow files. Every task goes through one pipeline, and triage decides which phases it includes.

| Phase | Who | Can be skipped | Review |
| --- | --- | --- | --- |
| Triage | Project lead | No | None |
| Spec | Builder | Yes | You, when required |
| Build | Builder | No | Reviewer, and you when required |
| Ship | Server, and you merge | No | Checks must be green |

Triage picks one of three presets:

- **Small:** build, review by the reviewer, ship.
- **Normal:** spec, build, review by the reviewer, ship. Nothing waits for you.
- **Risky:** spec with your approval, build, review by the reviewer, your review, ship.

A builder that finds a task bigger than triaged says so, writes a spec and stops.

### The lead decides, the server guarantees

- The lead orchestrates: it triages, briefs the builder, answers its questions, judges the back and forth, and decides when something needs you.
- The server holds each task's state and the rules for moving on. The lead asks to advance, and the server refuses a move that is not allowed.
- What is mechanical and certain, the server does without asking: CI failed, so the builder is woken with the log.
- What needs judgement wakes the lead. What needs you is sent up by the lead, or by a floor.
- Deciding which moves are legal is pure, as `AGENTS.md` asks. The server no longer scripts the work. It only says what may happen next.

### Floors

Triage may add phases, and never removes a required one.

- **Risky paths.** The `risky` list is checked twice. At triage the lead predicts. At the PR the server compares the changed files with the list, which is a fact. A PR that touches a risky path needs your review before merge, whatever triage said.
- **Risky by default:** the setup file, the spec, CI config and dependency files. The list protects itself this way.
- **The project's own floors**, such as "the reviewer always reviews".
- The list starts short and grows from incidents.

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

### More than one server

A client can know several servers, such as a local one for personal projects and a team one for work. `sc <harness>` asks the servers you have joined which one serves this repository, so it picks the right one by directory.

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
- A project's setup reaches its member repositories. Today each repository needs a setup of its own.
- One pipeline with presets replaces flow files.
- A spec stage, and two artifacts for human review: the spec and the PR page.

Everything else (leads, builders, reviewers, roles, skills, plugins, sandboxes) stays.

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
7. Home and member repositories, so one setup serves a whole project.
8. The pipeline with presets and floors, with the `risky` check on PRs.
9. Artifacts, rendered from markdown, with the task page and the inbox.
10. The rest of the app: settings.
11. Opt-in usage stats and `sc feedback`.
12. Tailscale detection, if it is under half a day.
13. Relay, when a team asks to skip the networking.

## Open questions

- May a member repository override the home repository's setup, or is that refused?
- Is a listed repository with no `test` an error, or a warning?
- Does every agent get every skill, or does a role list its own?
- What does "ship" include: only the merge, or a deploy as well?
- May the reviewer's review ever be turned off, and for which changes?
- Should a very large change count as risky, by a line threshold?
- Do you ask for changes to a spec in words through your agent, or as comments on the page?
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
