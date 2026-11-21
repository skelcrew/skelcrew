# Plugins and base modules

The plugin protocol in full, the GitHub and herdr plugins, the base modules' functions and quirks, the sandbox and what the database holds.

It describes how Skelcrew works today, in more detail than [the spec](spec.md). Builders keep it true to the code, changing it in the same pull request as the code. Where it and [docs/spec.md](spec.md) differ, the spec wins, and the code should follow the spec.

## Plugins

A plugin lives in a git repository of its own, with a `skelcrew-plugin.yaml` at its root. It is one of two kinds, and says in its manifest what it provides within that kind. Skelcrew's flow knows what a plugin provides, never which plugin provides it.

| Kind | What it is for | Provides | Examples |
| --- | --- | --- | --- |
| I/O | Work in and results out. In: issues become tasks, labels start them, comments and reviews reach builders. Out: PRs, reviews, checks, merges, closed issues and notifications | `tracker`, `forge`, `chat` | GitHub (tracker and forge), Linear, GitLab, Slack |
| Runtime | Where and how agents run | `sessions`, `transport`, `status`, `files`, `machine` | herdr. tmux and SSH are built in |

Messages and the sandbox stay in core, between the two. Work comes in through an I/O plugin, becomes a message, and reaches an agent through the runtime. No plugin can provide messages or the sandbox, so the rules about who may reach whom, and what an agent can touch, are Skelcrew's on every setup. Harnesses are never plugins: each is built into Skelcrew, one module per harness, because that module draws the sandbox boundary.

A runtime plugin is always personal, added with `sc add -g`, since how you run and watch your agents is yours. An I/O plugin is usually the repository's, in `plugins:`.

### The manifest

```yaml
name: github
version: 0.4.0          # the same as the tag it is installed from, v0.4.0
skelcrew: 0.6.0         # the oldest Skelcrew release it works with
about: Reads issues, opens pull requests and merges them on GitHub
kind: io
provides: [tracker, forge]
build: [[bun, install, --production]]
setup: [bun, setup.ts]
call: [bun, call.ts]
git_credentials: [bun, credentials.ts]
```

Each command is a list of words, run in the plugin's folder and never through a shell. `build` runs once, at install. `setup` runs in your terminal and asks for whatever the plugin needs, such as a sign-in. A command whose first word is `bun` runs on the Bun inside Skelcrew, so a plugin written for Bun needs nothing else installed. `about` is one line in plain words saying what the plugin is for, shown first when Skelcrew asks you to install it. A manifest with `jobs:` and no `kind:` is still read: tracker, forge and chat make it I/O, and machine makes it runtime.

Each command gets `SKELCREW_PLUGIN`, its name, and `SKELCREW_PLUGIN_CONFIG`, a folder in `~/.config/skelcrew/plugins/` for its settings and tokens, readable only by you, in a format of its own. `setup` also gets `SKELCREW_REMOTE`, the remote of the checkout `sc` ran in, when there is one.

### I/O plugins

A tracker or forge is asked by running its `call` command with one JSON question on stdin. It prints one JSON answer and exits within 60 seconds. If it exits with an error, its last line of stderr is the error. Exit code 2 means the plugin needs its setup again, such as after its sign-in lapsed, and Skelcrew's error names `sc setup <name>`. When `claims` exits with 2 while Skelcrew brings in a repository in your terminal, Skelcrew runs that plugin's setup there, handed the repository's remote, and then asks again, so the fix happens where you are. Ctrl-C stops it. Every answer is checked before Skelcrew uses it.

| Question | Provides | Answer |
| --- | --- | --- |
| `claims` with a remote, such as `git@github.com:simon/app.git` | Forge | The repository's key, short name, link and clone URL, whether you can push to it and whether it is a fork. Or `null` if it isn't this plugin's. |
| `changed` with a repository, whether the plugin is its tracker, its forge or both, the last `next` (or none), and PR numbers to watch | Tracker, forge | `items`, everything updated since, or everything open without a `next`, and the new `next` |
| `create task` with a repository, title and body | Tracker | The new issue |
| `took` with a repository and issue, before a labelled issue starts, and at each `sc start` on one | Tracker | `{ "took": true }` if this call took it, or `{ "took": false }` if someone already had. GitHub reacts with 👀, and a reaction already there means it was taken. `null`, from an older plugin, counts as taken. `sc start` doesn't look at the answer. |
| `assign` with a repository, issue, and on or off | Tracker | With on, `{ "assigned": true }` if this call assigned you, or `{ "assigned": false }` if you were already. With off, nothing. A tracker with no assignees answers `{ "assigned": false }` and does nothing. |
| `seen` with a repository, PR, kind (comment or review) and ID | Forge | Nothing. GitHub reacts with 👀 |
| `open pr` with a repository, branch, base, title and body | Forge | Its number, or the number of the PR already open from that branch |
| `merge pr` with a repository, PR and the commit you saw approved | Forge | Nothing, or why it couldn't merge. GitHub merges only if the PR's head is still that commit, with the first method the repository allows, of a merge commit, squash and rebase |
| `close pr` with a repository, PR, branch, and a comment or none | Forge | Nothing. GitHub posts the comment, closes the PR, and deletes the branch |
| `review` with a repository, PR, commit, verdict and body | Forge | The review's ID. The forge posts the body unchanged, HTML comments included, and `changed` gives it back unchanged, so Skelcrew can find its markers, such as the one a merge when ready's record carries |
| `edit review` with a repository, PR, review ID, verdict and body | Forge | `{ "edited": true }` once the forge changed that review to the new verdict and body, `{ "edited": false, "gone": true }` when the review no longer exists, such as one someone deleted, or `{ "edited": false }` if the forge can't edit it. `null`, from an older plugin, and an error count as can't, so the review still reaches the PR |
| `status` with a repository, commit, state and description | Forge | Nothing |
| `log` with a repository and check ID | Forge | What failed: the failing tests and their errors, from the check run's annotations and the failed step, or else the end of the job's log |

Skelcrew asks `changed` once per repository of each plugin that is its tracker or its forge, and keeps issues only from its tracker and PRs only from its forge.

An **item** is an issue or a PR: its kind, ID, title, body, state (`open`, `closed` or `merged`), author, labels, link, and when it was created and updated. An ID is the tracker's own, such as `12` on GitHub or `JOTT-12` on Linear. An issue adds the line a PR's body needs to close it on merge, such as `Closes #12`. A PR adds its branch, base, whether it conflicts with the base, its checks, and its reviews and comments. A check has a name, an ID if it has a log, and a state: `running`, `passed`, `failed`, or `cancelled`, which isn't the builder's to fix. A review or comment has an ID, its text and its author, and a review its verdict and its comments on lines. An author says whether it is a bot, whether it is you, and whether it can push to the repository.

Skelcrew runs git itself, for clones, fetches and pushes. `git_credentials` is a git credential helper, which Skelcrew hands to git for each command and never saves.

**The copy.** Skelcrew keeps a copy of each repository's open issues, from its tracker, and open PRs, from its forge. At each poll `changed` brings what changed since its last `next`. Each engine start begins with no `next`, so everything open comes again, and anything no longer there leaves the copy. A closed item leaves once no live task points to it. The list, `sc ls`, `sc show` and `sc ps` read the copy, so none of them waits on the tracker or forge. Only `sc show` asks the forge, for the logs of failed checks. `sc start` polls its repository first, so a builder never starts from an old body.

A chat plugin, such as Slack, would be where you hear that a task needs you and talk to a lead. None exists yet, so chat has no commands: they come with the first chat plugin.

### GitHub

The GitHub plugin, `skelcrew/skelcrew-github`, acts as Skelcrew's GitHub App, `skelcrew`, so every PR, review, comment, reaction and push shows as `skelcrew[bot]`. Skelcrew never acts on GitHub as you, so it is always clear whether you or Skelcrew speaks. Its setup takes two steps, asks you to paste nothing, and skips a step already done:

1. It signs you in with GitHub's device flow for the app. It shows a code, and Enter opens GitHub's page, where you enter it and click Authorize. That tells Skelcrew who you are. The plugin keeps the sign-in in its settings, and renews it through Skelcrew's service, since renewing needs the app's secret. A renewal cancels the sign-in before, so two machines can't share one: each machine signs in on its own.
2. It makes sure the app is installed on the repository `sc` ran in. If it isn't, Enter opens the app's install page, with the repository picked already when it is public. GitHub picks a repository only by its ID, which no one can read for a private repository before the app is on it, so there you pick it yourself. The plugin sees the install through your sign-in. Outside a checkout, setup waits until the app is installed anywhere.

On a remote, setup prints each link instead of opening it.

For each repository, the plugin asks the service for a token, with your sign-in. The service checks that you can reach the repository and the app is installed there, then makes a token for that repository alone, which lasts an hour. `claims` for a repository the app isn't installed on exits with 2, so `sc` there runs the setup, which goes straight to step 2. The app has contents, pull requests, issues and commit statuses to read and write, checks and actions to read, and metadata. It has no permission for workflows, so it can't push a change to `.github/workflows`. A builder that needs one says so, and you make it.

**Skelcrew's service.** The app is shared by everyone who uses Skelcrew, and its secrets can't ship inside Skelcrew. So a small service holds them, and does only what needs them: it makes GitHub tokens and renews your sign-in. It is open source, in `skelcrew/skelcrew-service`. The plugin's one setting is the service's address, `https://skelcrew.dev` unless you set another, and its setup never asks for it. To depend on no one, you run the service yourself, with a GitHub App of your own, and set its address: the same plugin, the same setup. The service is one small serverless function with no database. It sees who asked for a token for which repository, logs no request bodies, and code and issues never pass through it. While it is down, a token can't be renewed, so within the hour Skelcrew can't read, push or post on GitHub, and tasks wait. Once it is back, the next poll catches up. Skelcrew's core never needs the service.

### Runtime plugins

A runtime plugin says what it provides, out of five: the base modules `sessions`, `transport` and `status`, `files`, and `machine`. For the base modules, core uses its built-in for any it leaves out. Skelcrew uses a plugin's transport, status and files only for the sessions it hosts. Each function is a command, run as `call` is: one JSON question on stdin, one JSON answer on stdout. `attach` runs in your terminal, as `setup` does.

```yaml
name: herdr
version: 0.1.0
skelcrew: 0.6.0
about: Runs Skelcrew's agents in herdr-core, so herdr's apps show them
kind: runtime
provides: [sessions, transport, status, files]
session: [bun, session.ts]       # start, paste, keys, read, interrupt, end, list, rename, deliver, idle, status
attach: [bun, attach.ts]
```

**herdr** (`skelcrew/skelcrew-herdr`, https://github.com/herdrdev/herdr-core) provides sessions, transport, status and files. `start` maps onto `hc run`, `paste` and `keys` onto `hc send`, `read` onto `hc read`, `interrupt` onto `hc interrupt`, `attach` onto herdr-core's client, `end` onto ending the program, `list` onto herdr's labels, `rename` onto the tab's name, `deliver` onto `hc send --if idle`, `idle` onto `hc events`, `status` onto OSC 7501, written by the plugin's relay in the pane, as **Status** says, and `files` onto the folder where herdr saves what you drop on a session. herdr's own apps then show Skelcrew's leads and builders on your laptop, desktop and phone.

**Files.** A file you drop onto an agent in a host's apps, such as a screenshot, is saved by the host in a folder of that session's. The sandbox hides it, so a plugin that provides `files` lets its agents read that folder, and nothing else of the host's. For an agent starting on such a host, Skelcrew makes a placeholder, a path that never exists on the host, such as `/skelcrew-files-3f9c…`, 32 random hex digits long and new for each start. The sandboxed command gets a read-only mount of it at its own path, after every other mount but the agent's socket, and `start` is handed it as `files`, as `{ "ask": "start", …, "files": "/skelcrew-files-3f9c…" }`. The command comes as plain words, so the plugin finds it. Before the command runs, the plugin makes the session's folder and swaps the placeholder for that folder's path wherever it appears. The agent then reads its drops, read-only, at their real path, which is the path the host types when you drop a file, so it resolves inside the sandbox as typed. The placeholder is the only thing a host may change in the command, and the change can only say which folder that one read-only mount shows. So Skelcrew refuses `files` that isn't a placeholder of its own form, such as a real folder, and refuses a command that holds the placeholder anywhere but its mount, such as in a first message. Skelcrew can't see what a host then runs, on any host: a plugin runs as you, outside the sandbox, which is why you approve each plugin before it is installed. These rules are what a plugin that keeps to the protocol is held to. tmux has no files, and on a host without them the command has no such mount. On a Mac, an agent gets no dropped files yet: its sandbox's rules are in a profile Skelcrew writes to a file before the command runs, not in the command's words, so a host has no word to swap, and the rules can't name a folder only the host knows.

**Machines.** A runtime plugin that provides `machine` says how to reach a machine that runs Skelcrew, with three commands:

```yaml
name: sprite
kind: runtime
provides: [machine]
add: [bun, add.ts]
exec: [bun, exec.ts]
push: [bun, push.ts]
```

- `add <name>` checks that your laptop has what the machine needs, lists what is missing with the command that fixes it, asks before creating the machine, then readies it for Skelcrew.
- `exec <name> <word>…` runs the words on the machine, as `ssh -t` does, waking it if it sleeps, with your terminal when Skelcrew has one.
- `push <name> <file> <path>` copies a file to the machine, as `scp` does.

`exec` and `push` never create a machine, so a mistyped name creates nothing. `sc --remote <plugin>:<name>` reaches a machine through the machine plugin of that name, and a host with no plugin in front, such as `simon@workbox`, goes over SSH. A machine plugin is used on the laptop you run `--remote` from, never where the engine runs. With no machine plugin of that name, `--remote` refuses a `<plugin>:<name>` host rather than taking it for an SSH host.

## Base modules

How Skelcrew runs agents is split into five base modules. Each has a built-in default, and a runtime plugin can take over some of them, leaving core's built-ins for the rest. The flow speaks only to these modules, never to tmux or to a plugin by name. Each module is plain functions in a file of its own.

| Module | What it does | Built in | A plugin can provide it |
| --- | --- | --- | --- |
| Sessions | Runs each agent in a terminal session, lets you attach, and finds sessions again after a restart | tmux | Yes, such as herdr |
| Transport | Gets text into an agent, and knows when the agent is idle | Paste through the session, idle from Skelcrew's hooks and a screen check | Yes, such as herdr |
| Messages | Decides what is typed into which agent, when, and in what order | Core | No |
| Sandbox | Draws the boundary around every agent | Core: bubblewrap on Linux, `sandbox-exec` on a Mac | No |
| Status | Knows whether each agent works, idles, needs you, is ready or hit an error, and shows it | Core, from Skelcrew's hooks | Only the showing |

### Sessions

Every agent runs in a terminal session of its own: one for each repository's lead and one per builder. The rest of Skelcrew reaches a session only through this module, with plain data in and out.

| Function | What it does |
| --- | --- |
| `start` | Starts a session running the command Skelcrew gives, in a folder, with its environment and its labels, and on a host that provides files, the placeholder of its dropped files. Returns the session's ID. Can keep the session when its agent exits cleanly, so a lead you exited can be told from one that crashed. |
| `paste` | Pastes text into the session as one bracketed paste, in steps: readying the text, pasting it, then forgetting it, so typing can take its last look at the screen just before the paste. |
| `keys` | Sends keys, such as Enter or Esc. |
| `read` | Returns what the session shows now, and whether someone has scrolled back in it. Typing, the status screen check and `sc peek` use it. |
| `interrupt` | Stops the agent's turn, as Esc does. `sc interrupt` uses it. |
| `attach` | Attaches your terminal full screen to the session. It returns when you detach. |
| `end` | Ends the session, and waits until every process it ran has exited, so its clone can be removed. |
| `list` | Lists the host's sessions with Skelcrew's labels and whether each agent still runs, so a starting engine finds the agents still running. |
| `rename` | Receives a session's ID and its new title, as `{ "ask": "rename", "id": "<ID>", "title": "<title>" }`, each time its thread's title changes, such as when the lead gives it a short title, and names the session by it. Its answer isn't read. A plugin's host only: tmux keeps no title. A host that fails it, such as an older plugin, keeps the old name, and Skelcrew logs it. |
| `check` | Says whether one session exists, whether its agent still runs, whether it exited cleanly, and the last screen of one that ended, so Skelcrew reconnects instead of starting an agent twice and can say why one ended. |

Every session carries three labels: its repository (`simon/app`), its task (`app-12`, none for a lead) and its role (`builder`, or `lead`). They stay with the session for as long as it lives, so a starting engine knows whose each session is, and a host's own apps can group and filter by them. A builder's session on a plugin's host also carries its title, for the host's own apps to name it by: its task's name in uppercase, then its thread's short title, else its full title, such as `APP-12 Login redirect`. The task label stays lowercase, as Skelcrew finds the session by it. `start` hands them over as `labels`, such as `{ "repository": "simon/app", "role": "builder", "task": "app-12", "title": "APP-12 Login redirect" }`, and `list` gives them back the same way. A host ignores labels it doesn't know. When the title changes, Skelcrew asks the host to `rename` the session. tmux keeps no title, as Skelcrew's list reads titles from its own database.

The built-in host is tmux. Its sessions run on Skelcrew's own tmux server (`tmux -L skelcrew`) with Skelcrew's own config, sent with each new session, and keep every trap in `docs/learnings.md`. The labels are tmux user options on the session. tmux keeps sessions alive, handles attach and detach, and answers the terminal's queries. Skelcrew never runs its own terminal emulator. The config binds Ctrl-\ to detach with no prefix, also in copy mode, where an agent you scrolled back is. It is herdr's key to detach, so an agent is left the same way on either host. Ctrl-4 sends the same key in most terminals, for a keyboard layout where backslash needs AltGr. It hides the status bar, so attaching feels like being inside the harness. tmux reads the key however your terminal sends it: as one byte, as an extended key in the kitty or the xterm form, and in pieces over a slow link. A runtime plugin's host keeps its own key to detach. Only this module runs tmux for agents, and a test fails if anything else does.

Your `session:` setting picks the host for new sessions. Each thread remembers the host it started on, and an agent already running stays there until it ends. A resumed agent, such as after `sc stop` and `sc start`, starts on the current host with its conversation, since the conversation belongs to the harness. If a thread's host plugin is gone when the engine starts, the thread needs you, with the mark `run sc install: its session host herdr is missing`, rather than being moved silently.

### Transport

| Function | What it does |
| --- | --- |
| `deliver` | Types a message into an agent once it is idle, never into a turn still running and never on top of a person's unsent draft. |
| `idle` | Says when an agent becomes idle, so a waiting message can go. |

The built-in transport works on any host's sessions, as it uses only `paste`, `keys` and `read`, with the busy and ready marks each harness module gives. It waits until the agent is idle and its screen is quiet, read a moment apart, with a line holding only the harness's bare prompt. It readies the text, reads once more for a person's draft, pastes it as a bracketed paste, and sends Enter on its own a moment later. No hook can see a draft, so this screen check stays whatever the state says, and a turn can start with no hook, such as when a background task ends.

Mid-turn, Claude Code's spinner and Codex's "Working" line show "esc to interrupt" and redraw every second as their timer counts. The agent's own text can hold those words too, such as a reply about Skelcrew's code, but it sits still. So while those words show, Skelcrew watches the screen a second and a half more, long enough to see the timer tick, before it takes them for the agent's own. An agent whose state is `working` gets no message until its turn ends, even right after a message went in.

A host that can do better provides its own. herdr does: `hc send --if idle` waits for a person's draft and types only when the agent is idle, and `hc events` says when it is.

### Sandbox

The sandbox stays in core on every host, drawn by the harness module. A host runs the sandboxed command exactly as Skelcrew gives it, and never changes what the agent can reach. The one exception is a host that provides `files`: it swaps the placeholder of the agent's dropped files for their folder, which only says what one read-only mount shows, as **Files** under **Runtime plugins** says.

- **bubblewrap on Linux, `sandbox-exec` on a Mac**, drawing the same boundary: the agent's folder writable, the rest of the system read-only, the home folder and credentials hidden.
- **Claude Code.** Each session gets its own config folder in `~/.local/share/skelcrew/claude/`, where its transcripts stay for `claude --resume`, and logs in with the token from `sc install`. Your `~/.claude` stays hidden. Its own permission prompts and sandbox are turned off, since Skelcrew's draws the boundary. Inherited `CLAUDE_CODE_*` variables are removed. The folder is marked as trusted in the session's copy of its settings, or it waits at a question nobody sees. A lead's settings turn off Claude Code's tips, so they don't crowd the lead's greeting. Its notices that need you, such as a login problem, still show. So do its announcements, such as of a new model, as Anthropic's servers send them and no setting turns them off. The first message goes on the command line.
- **Codex.** It gets Skelcrew's `CODEX_HOME` and runs with its own sandbox and approvals turned off. A Codex lead or builder gets a folder of its own for its conversation, and shares the login.
- **The lead** works in its own folder in `~/.local/share/skelcrew/leads/<owner>/<repo>/`. It reads Skelcrew's clone of every repository Skelcrew has, its own included, read-only at `~/.local/share/skelcrew/repos/<owner>/<repo>/`, kept current by the engine's polls. A repository added later shows up in a running lead. It never sees another repository's tasks or conversation. Builders and reviewers see only their own task's clone.
- **The reviewer** sees the task's clone through a throwaway layer, so it can run tests but changes nothing.
- **Priority.** Builders, reviewers and setup commands run at a lower CPU priority than the leads and the engine, so your typing stays quick while their tests pile up.

### Status

Skelcrew keeps each agent's state on its thread: `working`, `idle`, `asking` or `error`. With the thread's needs you and its task's stage, that gives the status a host shows: working, idle, needs you, ready or error.

The state comes from the harness's hooks wherever a hook fires. The lead gets the same hooks as builders, but a lead's hooks only keep its state: they never flag needs you or bring a note.

| Happens | Claude Code | Codex |
| --- | --- | --- |
| A message goes in | `UserPromptSubmit`: `working` | `UserPromptSubmit`: `working` |
| A turn ends normally | `Stop`: `idle` | `Stop`: `idle` |
| A turn ends on an error | `StopFailure`: `error` | No hook |
| The agent asks a question | `PreToolUse` on `AskUserQuestion`: `asking`, and `PostToolUse` makes it `working` again | No question tool: the agent asks the lead with `sc tell lead`, or ends its turn with the question, so `Stop` marks it `idle` and its last message goes to the lead |
| You press Esc | No hook | `Interrupt`: `idle` |

The `Stop` hook also tells Skelcrew the commit the builder's clone has checked out, and its last message when nothing in the clone is uncommitted.

Two gaps have no hook: Esc on Claude Code, and an error on Codex, which prints it and sits at its prompt. For these, every two seconds Skelcrew reads the screen of each agent that is `working`, with the sessions' `read`, so this works on every host. One whose busy mark, "esc to interrupt", is gone at two looks in a row, or sits still at a bare prompt, becomes `idle`. Neither gap flags needs you.

Skelcrew reports the status to the host when the host can show it. A plugin that provides status implements one function:

| Function | What it does |
| --- | --- |
| `status` | Receives a session's ID, its status word (`working`, `idle`, `needs you`, `ready` or `error`) and a short reason, such as `question` or `round limit`, each time the status changes, and shows it on the host. |

The engine calls `status` for every change, from wherever it came: a hook, the screen check, CI going green, or a review. herdr hears status as OSC 7501, an escape code written by the program running in the pane, which the engine, outside the pane, can't write. So `skelcrew-herdr`'s `start` runs the sandboxed command under a small relay of its own, which passes the agent's terminal through untouched and writes OSC 7501 into it when `status` hands it a new status. The relay runs outside the sandbox, as the plugin does, and the sandboxed command inside it is exactly the one Skelcrew gave, but for the placeholder of the agent's dropped files, swapped for their folder. tmux shows no status, and Skelcrew's list shows it instead. A host's own view never replaces the hooks: needs you always comes from Skelcrew.


## State

One SQLite file per machine, `~/.local/share/skelcrew/skelcrew.db`, with `bun:sqlite`. It holds:

- **repositories**: the name, owner and name on the forge or remote, its lead's session, when you last opened it, whether you exited its lead;
- **tasks**: the repository, name, title, description, short title, flow, stage, the lead's updates, the issue and whether Skelcrew assigned you, the PR, CI, round count, review state and when the latest review was asked for or ended, the last handled ID per event kind, and its place in the queue of `limits.threads`, and its armed merge, when ready or over the review: the plan's own ID, who armed it and when, your exact words when the lead armed it, the commit pinned for a merge skipping the review, what it waits on, the round the lead last heard it still waits after, and each approved commit the record was posted on;
- **threads**: the task, role, harness, model, session host and session ID, state, status, needs you and its mark, branch, when it started and when it last changed;
- **the copy** of each tracker's open issues and each forge's open PRs;
- **messages** waiting for each agent, with whether one was left at the prompt unsent;
- **queues and holds**: the queue of reviews with each one's place and the time it first joined, reviews held on a usage limit with the reset time, and the queue of tasks under `limits.threads`. The queue of check slots is the one kept only in the engine's memory, as [Check slots](commands.md#tasks-and-threads) says.

Every other armed or queued state is in the database, so the engine's restart and a database migration keep it: an armed merge stays armed with its record, a queued review or task keeps its place, and a held review still waits for its reset.

Every change is also appended to `~/.local/share/skelcrew/threads/<repo>-<task>.log` as one JSON line, so a task's history can be read and replayed, including each review's round, reviewer, verdict and first line. Repository clones live in `~/.local/share/skelcrew/repos/` and task clones in `~/.local/share/skelcrew/threads/`, on one disk, so a task's clone shares its files with the repository's.

A database from an earlier release is moved forward once, when the new engine starts, after saving a copy beside it. An engine refuses to start while another one runs, so a move never happens under one still writing the old way.

**Tokens stay out.** Agents never see a GitHub token, or any plugin's. They don't push or call GitHub. They call `sc` commands, and the engine and its plugins, outside the sandbox, push and post as Skelcrew's GitHub App, or push with your own git login when a repository has no forge. Commits are authored by `skelcrew[bot]`, with you as co-author.

**One seam for harnesses.** Each harness lives in one module: how it starts, resumes and logs in, where its config folder is, what its screen shows when it is busy or ready, how it reports its hooks, and how it draws the sandbox. A small lookup finds it by the name your config uses. The flow never names a harness, so another one, such as opencode or pi, is one more module.
