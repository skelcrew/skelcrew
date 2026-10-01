# Architecture

This is a map of how Skelcrew is built, for a developer who is new to the code. It says
which parts exist, what each one does, and how they fit together. The design and the
reasons behind it are in [`spec.md`](spec.md). The rules the core must never break are in
[`invariants.md`](invariants.md).

Parts marked _planned_ are designed in the spec but not built yet.

## The picture in one paragraph

Skelcrew moves a task from an idea to merged code. A small, pure **core** decides every
change to a task. Around it, a **daemon** carries out what the core decides: it starts
agents, creates git worktrees and runs checks. Then it reports the results back to the
core as new inputs. Everything talks to the daemon through the `skelcrew` **CLI**: you from
the TUI or from your own harness, and the agents. **Plugins** connect it to other tools,
like Claude Code, git and GitHub.

```
     you, in the TUI    you, in your harness       agents
            │                   │                    │
            └──────────►    skelcrew CLI    ◄────────┘
                                │
                             daemon  ◄────────────  plugins (planned):
                           (planned)                git, sessions, GitHub…
                        │  ▲
                 input  │  │  events + commands
                        ▼  │
                      ┌──────┐
                      │ core │   pure functions: no clock, no disk, no network
                      └──────┘
```

## How one input flows

An example: the agent working on task #12 says it's done.

1. **The agent reports.** It runs `skelcrew done` through the CLI. The daemon adds facts
   from git: 3 commits, and one changed file, `src/reports/export.ts`.
2. **The daemon wraps it.** It puts the input in an _envelope_ with the task number and
   the current time: `{ taskId: 12, at: 1727…, input: { by: "agent", type: "report_done", … } }`.
   The core never reads the clock, so the time has to come in with the input.
3. **The core decides.** `decideTask(task, envelope, config, projects)` checks the input
   against the rules. Here it accepts it and returns:
   - events: `task.done_reported`, the facts that happened
   - commands: `run_gate local`, the work the daemon must do next
4. **The daemon records.** It appends the events to the log in SQLite. Then it applies them
   with `evolveTask` to get #12's new state: now in Checks, running the `local` gate.
5. **The daemon carries out the commands.** It runs the local checks. When they finish,
   the result comes back as a new input, `gate_result`, and the loop starts again.

If the core had rejected the input, for example a branch with no commits, nothing is
recorded and the reason goes back to the agent.

## The core

Everything in `src/core/` is pure. The same inputs always give the same result, so any
bug can be replayed exactly from the log. Only the core decides what may happen to a
task. That's how "prompts propose, the core decides" is enforced.

| File | What it holds |
| --- | --- |
| `types.ts` | Every type the core uses: tasks, phases, inputs, events, commands, config. Start here. |
| `ids.ts` | Branded IDs (`TaskId`, `ProjectId`, `SessionId`, `CommitSha`), checked with Zod. A task number can't be passed where a project ID is expected. |
| `task.ts` | Questions about one task, answered once for everyone: which agent it runs, which request it waits on, which worktree it holds, and what it waits on you for (the inbox). Also phase names as you see them ("In progress") and `TaskIn<"checks">`, the type of a task in one phase. |
| `contracts.ts` | Small checks that return pass, or fail with reasons: is the spec complete, which files are critical, are attempts left, is the task within its safety cap. |
| `decide.ts` | `decideTask`: the rules for tasks. It takes one input and returns events and commands, or a rejection. |
| `evolve.ts` | `evolveTask`: applies one event to a task. It holds no rules. It only applies what `decideTask` accepted. |
| `projects.ts` | `decideProject` and `evolveProject`: the same pair for projects. Create, park, activate. |
| `schedule.ts` | `schedule`: picks which waiting tasks start when a slot is free. Each pick becomes a `start` input, so `decideTask` still has the final say. |

### Ideas that run through the core

- **Events are the source of truth.** The log of events is what gets saved. A task's
  current state is worked out by folding its events through `evolveTask`, starting from
  nothing. After a restart, that's how every task comes back.
- **Two functions per thing.** `decideTask` judges and `evolveTask` applies. Replaying the
  log only runs `evolveTask`, so old events are never judged again by rules that have
  changed since. This is the decider pattern from event sourcing.
- **Inputs are grouped by who sends them:** human, agent, plugin, system. The daemon marks
  each CLI call with who made it, and a call from an agent can only become an agent
  input. So an agent has no way to even express "approve this spec".
- **Commands are how the core touches the world without doing it.** `create_worktree`,
  `start_develop_session`, `merge` and so on. The daemon carries them out, and the results
  come back as inputs. In tests, a scripted reply stands in for each one.
- **Every reply answers one request.** A command that expects a reply carries a request
  number, and the reply must bring it back. For example, #12's first merge conflicts, a
  new agent fixes it, and a second merge starts as request 10. A repeat of the first
  merge's reply, for request 6, is refused, so it can't mark the new merge done. A late
  agent or worktree is stopped or removed instead.
- **An agent is started or claimed.** The scheduler's `start` makes the daemon start an
  agent. A `claim` makes your own harness session the agent, attended: the core records
  your session and starts nothing. Every spec and every build gets its own worktree first,
  whoever works on it. A spec's is a copy of main on no branch, removed once the spec is
  in, and a build's is on the task's branch. From then on, only that session is heard. Only the loop sees every task, so it checks for a
  free slot before either goes through. Claiming an Idea asks for its spec in the same
  step. A spec from your claimed session needs no approval, so it makes the task Ready
  at once. A spec from an agent Skelcrew started waits for your approval.
- **Errors are values.** Functions return `{ ok: true, … }` or `{ ok: false, reason }`.
  Nothing in the core throws.
- **Phases and flags.** A task is always in one phase: Idea, Spec, Ready, In progress,
  Checks, Done or Dropped. Each phase carries only the data it needs. For example, only a
  task in Checks has branch facts. On top of the phase, a task can have an open question
  or be blocked. Neither changes the phase.

### Reading `decide.ts`

`decideTask` at the top is an outline, one line per step:

1. `add` or a delegated issue creates the task.
2. Any other input for a missing task is rejected.
3. A late reply is cleaned up. For example, a worktree that finished after the task was
   dropped gets a command to remove it.
4. Any input for a dropped task is rejected.
5. Inputs that work in any phase are handled by `inAnyPhase`: drop, ask, answer, usage,
   retry and a few more.
6. Everything else goes to the task's phase: `inIdea`, `inSpec`, `inReady`, `inProgress`,
   `inChecks` or `inDone`.

`evolve.ts` has the same shape: events for any phase first, then one function per phase.

## Tests

Tests sit next to the code: `decide.ts` and `decide.test.ts`. Values they share, such
as the base config, a spec and a worktree, live in `src/test/fixtures.ts`. A test that
needs a different config spreads the base one and changes only the fields it is about.

- **One test per rule**, allowed and rejected. The tests build a task in any phase by
  sending it real inputs, through a helper called `run` (or `replay` in the `evolveTask`
  tests). So every test starts from a state the real code can reach.
- **Property tests** (`invariants.test.ts`). fast-check sends random input sequences to
  one task, and to four tasks sharing the scheduler. It checks every rule in
  `invariants.md` after every step. Most steps pick an input the task accepts right now,
  so runs reach every phase: a typical run merges and reverts dozens of tasks. When a
  property fails, fast-check shrinks the sequence to the few inputs that break the rule.
  These tests have already found real bugs, such as a question that could never be
  answered.
- **The loop's property test** (`src/loop/loop.property.test.ts`). Four tasks run
  through the real loop with random inputs, saves that sometimes fail, and restarts at
  random moments. After every step it checks that no more agents run than
  `max_running` allows, and that the loop's tasks match a fresh replay of the saved log.
- **Golden stories** (`stories.test.ts`). Whole lifecycles, one line per input: what was
  sent, the events it caused, and the commands for the daemon. The happy path, a task
  blocked and retried, a merge that waits for approval, and a revert. The full events of
  each story are also saved in `__snapshots__/`, so any change to the shape of the event
  log shows up in review. Update the snapshots only on purpose, with
  `bun test --update-snapshots`.
- **The simulator** (`src/sim/`). The loop, with fake tools in place of real ones. Each
  command goes to a fake tool that answers the way the real one would, and fake agents
  do their job. Each task gets a script of what goes wrong, such as a gate that fails
  twice or a merge conflict. So whole lifecycles, with several tasks sharing
  `max_running`, run in tests. It lives outside the core because it's test machinery,
  not rules.

`bun run check` runs the lint, the typecheck and every test. It must pass on every commit.

## The loop

`src/loop/loop.ts` is what every host of the core does with an input. The simulator runs
it with fake tools, and the daemon will run it with real ones.

1. `send(task, input)` asks `decideTask`.
2. If accepted, it saves the events and their commands to the event store. If saving
   fails, nothing else happens: the task doesn't change, and no command goes out.
3. It applies the events with `evolveTask`.
4. It hands each command to the tools. A command is marked done in the store only when
   its tool says it has finished, which for a command that expects a reply means once
   the reply has been handled: saved, or refused because its time had passed. Replies
   come back later through `send`.

`startWaiting()` asks `schedule` what to start, and sends the starts. A claim comes from
you instead, so `send` checks for a free slot before passing it on. The loop counts the
starts it has sent out and not yet had answered, by task and request number, and the
agents it is stopping whose stops haven't finished, and gives that count to the
scheduler. So an agent being stopped keeps its slot until it has stopped, and
`max_running` holds even while a stop is slow. `Loop.open` rebuilds everything from a saved log and carries
on from there.

If the daemon dies between saving a decision and finishing its commands, nothing is
lost. `Loop.open` first carries out every saved command not yet marked done, including
one whose work was still going on when the daemon died. So a command
can reach the tools twice, and the tools must treat a repeat as a no-op. For example, a
second "start #1, request 1" starts nothing.

## The event store

`src/store/` saves the event log in SQLite and reads it back. It's the first piece of
build step 2, outside the core because it touches the disk.

| File | What it holds |
| --- | --- |
| `schema.ts` | A Zod schema for every event and every command, typed against the core's own types. The typechecker fails if they drift apart, and names any event the schemas miss. |
| `store.ts` | `EventStore`: one table of events in order. `appendTask` saves one decision's events together, or none. `loadTasks` and `loadProjects` rebuild everything by replaying the events through `evolveTask` and `evolveProject`. `loadTaskEvents` reads one task's events back, oldest first, for `skelcrew log`. A second table keeps the starts in flight, saved in the same transaction as the events, so a restart still knows which agents and worktrees are on their way. A third table keeps each decision's commands until they are carried out. |
| `fixtures/v1-events.jsonl` | 56 real events in the version 1 shape. They must always load. The file is never edited: a change that breaks it needs a way to read old events instead. |

Each event is checked against its schema twice: before it's written, and when it's read
back. Objects are strict, so an unknown field is refused, not dropped. A damaged row is
reported with its position, not guessed at.

## The workflow file

`src/config/workflow.ts` reads `.skelcrew/workflow.yml`: the core's config, including the
safety cap, the commands the local gate runs, the setup commands that prepare a fresh copy of a task's code first (`setup`, none when left out), and the main branch (`main_branch`, `main` when left out). Every field is checked with Zod, and a file that doesn't
fit is refused with every reason, in plain words. An unknown field is refused too, so a
typo like `critical_path` can't be silently ignored. A file without `critical_paths`
makes every path critical, so nothing merges without your approval. `workflowFile`
writes the file `skelcrew init` creates, with the check commands init finds in the
repository, and the setup commands when it finds any.

## The daemon

`src/daemon/daemon.ts` is where the CLI's requests become core inputs. `Daemon.open`
rebuilds the loop from the saved log. `handle(command)` takes one protocol command, turns
it into inputs for the core through the loop, and answers. It hands out task numbers and
session names, since the core never makes up IDs. A session name is short and random, like
`session-k3x9q2mf`: eight random letters or digits, hard to guess and unlikely ever to
repeat. Requests and the tools' replies share one
queue, so everything happens one at a time. Its tools carry out the core's commands and
send the results back as new inputs. Making and removing worktrees go to the git plugin,
and the local gate to the checks runner. Commands for a plugin that arrive at start-up,
before the daemon can look up titles, wait until it can. Merges go to the git plugin too:
it brings the work up to date with main, runs the setup and the checks on the result, and
only then moves main. The daemon hands the merge the task's approved spec as a Markdown
file, such as `docs/specs/12-csv-export.md`, which lands in the same commit as the work.
`spec-file.ts` names the file and writes its text: the task's number and title, the scope
and the acceptance criteria. The task's branch never holds it. Approving a merge first checks your checkout of main, and refuses while it has uncommitted edits, since they would stop main from moving. Then it waits for the merge, and answers with the new commit on main or why the merge failed, including when that used the task's last attempt. Approving again while a merge is under way, such as after a restart, waits for the same result. Rejecting sends the spec or the merge that waits back with your note, and answers with where it went: Spec or In progress. Starting agents and reverting aren't wired in yet: a command
that needs them is answered with a failure at once, so the core never waits. A claim
in Ready waits for the task's worktree, outside the queue, and answers with where to work.
`done` reads the task's branch, reports it to the core, and waits outside the queue while
the gate runs. It answers whether the checks passed, and why not. The gate runs the checks in a fresh
copy of the reported commit, never in the agent's worktree, so edits made meanwhile and
files the checks write change nothing. The `setup` commands run in that copy first, such as an install. A `done` sent while the checks already run, such as again after a restart, waits for their result. Closing the daemon stops a running check and everything it started, at the start of the stop. A `done` waiting on it then hears the daemon is shutting down. A known limit: after a crash, a check that was running keeps going beside the one run again at the next start. Making and removing the copy wait their turn with other git work, which on a very large repository can hold up another task's worktree for some seconds. `serve` refuses to start without git, outside a git repository, in a folder inside a
repository rather than where it starts, or when the main branch from `workflow.yml`
doesn't exist.

`src/daemon/pull-requests.ts` gives you a draft pull request to read on GitHub while a
merge waits for your approval. The core sends no command for it. Instead, after every
request and every reply, and once at start, `DraftPullRequests` looks at each task in the
background and compares it with the pull requests it opened. For example, #12's checks
pass and its merge waits: it pushes `task/12-csv-export` and opens a draft titled
"#12 CSV export". You approve, and it closes the draft with a comment naming the new
commit on main. The comments say "Task 12", since on GitHub "#12" links to its own
pull request 12. The spec's text goes into the body inside fenced blocks, so a "#56" or
"@name" in it links to nothing and notifies nobody. The open ones are remembered in the store, so a restart neither loses one
nor opens a second. After a send-back or a failed merge the task keeps its branch, so its
draft stays open and the next wait pushes the new work to it. A task that leaves its
branch, by being merged, dropped or sent back to Spec, gets its draft closed. If a pull
request can't be opened, such as with no `origin` remote or no `gh`, the task waits as
always, and `status` says why there is none. Work that failed is tried again every five
minutes, so after `gh auth login` the draft appears without a restart. `status` gives each task's link as `pullRequest`, or the reason as
`noPullRequest`. When the draft shows older work than the merge waiting for you, such as
after a push that was refused, `pullRequestNote` says so and why.

## The daemon's socket and the client

These files put the daemon on a socket, one per repository, and let the CLI reach it.

| File | What it holds |
| --- | --- |
| `paths.ts` | `daemonPaths`: where a repository's daemon keeps its files, worked out from the repository's real path. The socket is `.skelcrew/daemon.sock` when that path fits in 103 bytes, the most macOS allows. A deeper repository gets `<hash>.sock` in `/tmp/skelcrew-<user id>/` instead. That folder is the same from every shell, and the daemon makes it so only the user can open it. The daemon and the client both ask here, so they always agree. |
| `server.ts` | `serve`: `skelcrew serve`'s job. It reads `.skelcrew/workflow.yml`, takes the lock, opens `.skelcrew/skelcrew.db` and the daemon, with git, the checks and the GitHub plugin, and listens. Each line on a connection is one request. The reply goes back on that connection with the request's id. A line that isn't a request is refused, and one over 1 MB also closes its connection. `serveUntilSignalled` stops it cleanly on SIGTERM or SIGINT. |
| `lock.ts` | `takeLock`: one daemon per repository. The daemon takes an exclusive `flock` on the repository's folder and keeps it while it runs. The operating system frees it when the process ends, however it ends. `flock` gets the lock or doesn't in one step, so of several daemons starting at once exactly one runs, and it works on a folder the daemon can't write to. Deleting or replacing `.skelcrew`, or anything in it, can't let a second daemon in. No process id is trusted. The process id goes in `.skelcrew/daemon.pid`, only to say who runs the daemon. It is called through the C library on macOS and Linux; other systems are refused plainly. |
| `client.ts` | `request`: sends one command to a repository's daemon and returns the answer as a value. If no daemon is running, it starts one through a function it is given and waits for the socket. A request, once sent, has no time limit, since `done` waits for the checks. |

An example: the CLI sends `add` while no daemon runs. The client finds no socket, so it
starts `skelcrew serve` in the background. It retries the socket every 50 ms. Once the
daemon listens, the client sends `{ "id": "…", "command": { "type": "add", … } }` and
reads back `{ "id": "…", "ok": true, "result": { "task": 1 } }`.

A daemon killed outright leaves its socket file behind, but its hold on the lock ends
with its process. The next daemon takes the lock and removes the old socket file.

## The protocol

`src/protocol/protocol.ts` is how the CLI and the daemon talk: one JSON message per line,
over the daemon's local socket. A request is `{ id, command }`, with one command for each
CLI command. A reply is `{ id, ok: true, result }` or `{ id, ok: false, message }`. An
agent's reports (`submit`, `done`, `give_up`) carry the session its claim handed out.
Your commands carry no identity, since the protocol can't prove who calls. Everything read
from the socket is checked with Zod first, and a line over 1 MB is refused.

## The CLI

`src/cli/` is the `skelcrew` command, for you and for agents. `package.json` names
`src/cli/main.ts` as the program.

| File | What it holds |
| --- | --- |
| `cli.ts` | `run(args, context)`: one command line in, the lines to print and the exit code out. Tests call it as a function. It checks every argument with Zod, finds the repository's main folder through git, so from inside a task's worktree, which holds its own copy of `.skelcrew/`, it still reaches the main folder's daemon, and sends the command through the client. It checks each answer against the shape that command expects. `reject` says where the work went back to, such as "Sent #3 back to Spec with your note." |
| `status.ts` | What `skelcrew status` answers and prints. The TUI reads the same answer, so both say the same thing about a task. It lists what waits on you first, including a task nobody is working on, with the command to claim it, since Skelcrew doesn't start agents itself yet. A merge that waits for you comes with the link to its draft pull request, or the reason there is none. If the draft shows older work, the line says so and why. Then it lists tasks by project and phase, each with the session working on it, if any. |
| `log.ts` | What `skelcrew log` prints: one line per event, oldest first, with its time and what happened in plain words, like `2026-09-30 10:02  You claimed it, as you-2.` A submitted spec shows its scope, then its acceptance criteria as a list under it. The daemon answers with the task's saved events, and the CLI checks them against the store's event schema before it words them. A reply must stay under 1 MB, and every spec is saved whole. So for a long-lived task, the daemon sends only the newest events that fit and says how many older ones it left out. The CLI prints that count first, like `4 older events are left out.` |
| `init.ts` | `skelcrew init`: finds the top of the git repository, runs `initRepository` there, and prints its report in a few lines. The report says which checks and setup commands it chose, what init created, linked, updated and left alone, what to do by hand, the warnings, whether Claude Code will ask before `skelcrew approve`, and the next step. A failed init prints its reason and exits 1. |
| `help.ts` | What `--help` prints, for the program and each command. `skelcrew submit --help` shows the spec's JSON form, since the spec skill sends agents there. |
| `start.ts` | `startDaemon`: runs `skelcrew serve` in the background, in its own process group, so Ctrl-C in the terminal doesn't stop it. Its output goes to `.skelcrew/daemon.log`. If it exits before it answers, the command prints what it wrote there. |
| `main.ts` | The program: runs one command, prints its lines, and exits. A refusal goes to standard error, with exit code 1. Bare `skelcrew` in a terminal opens the TUI instead. It imports the TUI only then, so Ink never slows the other commands. A test checks that `main.ts` doesn't load Ink or React as it starts. |

An agent's reports (`submit`, `done`, `give-up`) take the session from `SKELCREW_SESSION`.
`claim` prints the session, with the command to report with, like
`SKELCREW_SESSION=session-k3x9q2mf skelcrew submit 12`. The session goes in front of each command,
since each shell in a harness starts without the variable.

`retry` clears a blocked task's block. The daemon doesn't start agents itself yet, so the
task then waits in its phase until it is claimed again. The CLI says so.

`init` doesn't go through the daemon. It asks git where the repository starts and sets up
that folder, even when run from a subfolder such as `src/`. A subfolder with a `.skelcrew`
of its own is refused, since Skelcrew doesn't run on part of a repository.

Bare `skelcrew` opens the TUI in a terminal. Without a terminal, such as when an agent runs
it, it prints the status instead, so nothing waits for keys that never come.

## The TUI

`src/tui/` is the screen that bare `skelcrew` opens. It is built with Ink, which draws the
terminal screen from React components. Ink takes about 100 ms to load, so only `main.ts`
imports it, and only when it opens the screen. Every action on the screen runs the same
command as the CLI, so the TUI can do nothing the CLI can't.

| File | What it holds |
| --- | --- |
| `open.tsx` | `open(repo)`: draws the screen over the terminal, like vim does, and returns once it is closed. The terminal is left as it was. It tells the screen how tall the terminal is, and again whenever the window is resized. It gives the screen three things from `cli.ts`: `readStatus`, which sends the same request as `skelcrew status`, `readLog`, which sends the same request as `skelcrew log`, and `run`, for the actions. Each starts the daemon if it isn't running. It also gives the screen a way to open a link in the browser, with `open` on macOS and `xdg-open` elsewhere. |
| `screen.tsx` | `Screen`: the whole screen. It fills the terminal: the header on the first line, the keys on the last, and messages, questions and the text box just above the keys. The list fills the room between. A list taller than that scrolls, and its first and last lines say how many tasks are hidden, such as "↓ 25 more". It asks for the status every second and shows one row per task. `j`/`k` or the arrow keys move the cursor, and `g`/`G` jump to the first or last task. The cursor follows its task when the task moves to another group. If the daemon can't answer, the last list stays, with the reason under it. The keys in `actions.ts` act on the task under the cursor. While a command runs, the screen says so, such as "Approving #14…". Then it shows what the CLI said, cut to four lines, and loads the list again at once. The next key clears it. `q` closes the screen. |
| `task-screen.tsx` | One task's own screen, which enter opens from the list. It shows the project, the pull request to read before a merge, a block's whole reason and a question in full. Then the newest spec: its scope, acceptance criteria and open questions, wrapped to the screen's width. Then the history, newest first, one line per event, since the spec already shows above. `See it all with: skelcrew log 12` says when something was left out. `j`/`k` scroll it, `o` opens the pull request, `esc` or `h` go back, and the keys that act on one task work on it. |
| `list.tsx` | How the task list is drawn: its lines, one row per task, and the width of each column. Titles get the room the other columns leave. |
| `scroll.ts` | `firstShown`: which part of a list taller than the screen shows. It keeps the cursor's task in view, with its group's heading when it is the group's first task. It moves the list as little as it can, so the list doesn't jump. |
| `actions.ts` | The keys that act on tasks, one entry each: `a` and `A` add, `y` approves, `x` sends back with a note, `s` asks for a spec, `r` retries and `D` drops. Each ends in the `skelcrew` command you would type, run through `run()` in `cli.ts`, so the TUI can do nothing the CLI can't. Approving a merge and dropping a task ask y/n first. The rules stay in the daemon: the screen sends what you ask for and shows the refusal word for word. The keys line at the bottom is made from the same list. It shows only the keys used most, `a`, `y` and `x`, so it fits an 80-column window. Each key also has a description for the list `?` shows. |
| `keys.ts` | What `?` shows: every key and what it does, on the list, on a task, and anywhere. The keys that act on tasks come from the action table, so the list can't drift from what they do. `esc` or `?` close it. |
| `testing.tsx` | What the TUI's tests share: a task of each kind, and the screen opened on them with a stand-in for the daemon and the CLI. The tests type keys with `ink-testing-library` and read what the screen draws. |
| `rows.ts` | What the list shows, as plain data: which group each task is in, and what its row says. The groups are Waiting on you, Working, Waiting for an agent, and Ideas. Done and dropped tasks are only counted. A question is marked to show in yellow, and a block in red, in the terminal's own colours. |

## The local checks

`src/checks/checks.ts` runs the `checks` commands from `workflow.yml` in a folder, one
after another, and stops at the first failure. That is the `local` gate, and the merge
runs the same checks again on the merged result. A failure names the command and its exit
code, then the end of its output, which is what the agent sees. Each command runs in a
process group of its own, so a command that runs too long is stopped with everything it
started. Input is closed and `CI=true` is set, so nothing waits for a person.

## Init

`src/init/` is what `skelcrew init` does, built as functions the CLI calls. It sets
up a repository and never overwrites a file, so running it twice changes nothing. It only
adds to two existing files: the missing runtime lines to `.gitignore`, and the approve
rules to `.claude/settings.json`.

The skills live in `.agents/skills/`, so Skelcrew isn't bound to one harness. Claude Code
looks in `.claude/skills/` instead, so init adds one link per skill there. For example,
`.claude/skills/spec` points to `../../.agents/skills/spec`. Other skills already in
`.claude/skills/` stay as they are. In the same way, project instructions live in
`AGENTS.md`, and Claude Code reads `CLAUDE.md`. So a repository with an `AGENTS.md` and no
`CLAUDE.md` gets `CLAUDE.md` as a link to it. Init doesn't write instructions itself.

| File | What it holds |
| --- | --- |
| `detect.ts` | `detectChecks`: finds the check commands a repository has. A `package.json` gives its `test` script, then its `check` script, or its `typecheck` and `lint` scripts when there is no `check`. They run with the package manager the project uses. A lock file shows it best. Without one, the `packageManager` field in `package.json`, such as `"pnpm@9.12.0"`, names it. Next, a `bunfig.toml` file means Bun. Next, a script that runs `bun` or `bunx`, such as `"test": "bun test"`, means Bun. Otherwise it is npm. The `test` script runs beside a `check` script, since a `check` script often runs no test. When the `check` script runs the `test` script by name, such as `bun run test` or `npm test`, the `check` script runs alone. A test runner in the `check` script, such as `vitest`, isn't enough, since it may run only some of the tests. A `test` script that does nothing, such as `exit 0`, counts as none. One that runs no test runner init knows, such as `vitest` or `jest`, gives a warning. `Cargo.toml` gives `cargo test`, and `go.mod` gives `go test ./...`. A `pyproject.toml` with a `[tool.pytest]` or `[tool.pytest.ini_options]` table gives `pytest`. A makefile's `test` target is used only when nothing else was found. The makefile is the one `make` reads: `GNUmakefile`, `makefile` or `Makefile`, whichever comes first. A file that can't be read is skipped and named in the reason. It never throws. `detectSetup` finds the `setup` commands. A `package.json` gets its dependencies installed by that same package manager. With a lock file, the install keeps it as it is where that manager has a flag for it: `bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `npm ci`, or plain `yarn install`. With no lock file, it is a plain install, such as `bun install` or `npm install`. Without a `package.json`, there is no setup. |
| `gitignore.ts` | `leftOutBy`: says which line of a `.gitignore` leaves out a path, read the way `git check-ignore` reads it. The last line that matches wins, a line starting with `!` adds a path back, and nothing inside a left-out folder can be added back. Init uses it to warn when the skill links, the skills or the approve and reject rules would never be committed. It reads only the repository's top `.gitignore`. |
| `init.ts` | `initRepository`: writes `.skelcrew/workflow.yml` with the checks and setup found, adds Skelcrew's runtime files to `.gitignore` (the database, and the daemon's log, pid file and socket), writes the default skills to `.agents/skills/`, links each into `.claude/skills/`, and adds the approve and reject rules to `.claude/settings.json`. A file already there is kept as it is and reported. Each link is relative, so it still works when the repository moves. Anything already where a link would go stays, even a link to nowhere. It is reported, with a warning that Claude Code will use that one instead. A link init can't make, such as when `.claude/skills` is a file, is listed under `byHand` with a warning that gives the command to make it. The command uses the same relative path init would have used, so it works even when `.claude` is a link to another folder in the repository. With an `AGENTS.md` and no `CLAUDE.md`, it makes `CLAUDE.md` a link to `AGENTS.md`. It does so only when `AGENTS.md` is a file inside the repository that it can read. A link to a file outside the repository, a folder, or a link to nowhere gets no `CLAUDE.md`, and a warning says why. With both, in any form, it leaves both alone. With only a real `CLAUDE.md`, it leaves it alone and warns how to switch: move it to `AGENTS.md`, then make `CLAUDE.md` a link to it. New links are listed under `linked`. A file or link that would land outside the repository through a link, such as a `.claude` or `.agents` folder linked to your home folder, isn't made. It is listed under `byHand` with a warning that says why. Warnings from finding the checks go into its report. A `workflow.yml` it can't open, such as a folder, is left alone with a warning. A linked `.gitignore` is left alone with a warning that says what to add. Each `.gitignore` line goes in once, and only if it is missing. New lines use the file's own line endings. It warns if `.gitignore` leaves out all of `.skelcrew/`, since `workflow.yml` could then never be committed. It doesn't warn when a later line adds `workflow.yml` back, as in `.skelcrew/*` followed by `!.skelcrew/workflow.yml`. It also warns when `.gitignore` leaves out the skill links, the skills or `.claude/settings.json`, such as with a `.claude/` line. Teammates who clone the repository wouldn't get them. If it finds no checks and there's no `workflow.yml` yet, it writes nothing and says why. If a later step fails, the result still lists every file it wrote and every link it made before it stopped. |
| `paths.ts` | `outsideLink`: says whether a file init writes would land outside the repository. It follows each link on the way to the file, from the repository down, and names the first one that leads outside. A link it can't follow counts as outside. |
| `settings.ts` | `addAskRule`: makes Claude Code ask you before anything runs `skelcrew approve` or `skelcrew reject`. The spec puts this guard in the harness's settings. Reject needs it too, since an agent that sent a task back unasked would write a note the next agent reads as yours. It adds one rule to the `ask` list in the repository's `.claude/settings.json` for each usual way to type each command: plain, through `bunx`, `bun x` or `npx`, and by a path such as `./node_modules/.bin/skelcrew`. It adds only the rules the file lacks, and keeps everything else in the file. It writes the file back only when nothing but the rules change. Otherwise, such as for a file that isn't valid JSON, is a link, or can't be written, it changes nothing and warns you with the rules to add by hand. The rest of init carries on. The guard can be got round: `bash -c 'skelcrew approve 12'` runs without asking. The init report says so, in `askBeforeApproveLimit`. When init couldn't add the rules, that text says the guard is not in place yet, and lists the rules to add. It also says the rules work only in Claude Code. Another harness needs its own guard, or the developer approves only by typing the command. `skelcrew init` doesn't print this text. It prints one line that says whether Claude Code will ask. It never touches `.claude/settings.local.json` or your user settings. |
| `skills.ts` | The default skills, imported as text from `skills/<name>/SKILL.md`. They go to `.agents/skills/` in the repository, so no one harness owns them. Init links each into `.claude/skills/` for Claude Code. There are two kinds. The agents' skills, `spec` and `develop`, tell an agent in your harness how to work a task while you watch, with only the commands the CLI gives the skills, plus `skelcrew log` and `skelcrew status` to read a task. They also carry a way of working. The spec skill reads the code first, asks its questions once, writes the spec in a fixed shape, and runs every sentence about what the code does today. Started with a title instead of a number, it adds the task with `skelcrew add --spec` first. Started with an Idea's number, it asks for the spec with `skelcrew spec` before it claims. Started with a number and more words, such as `12 focus on the API`, it asks whether you meant #12 when that task exists. The develop skill first reads `skelcrew status`, and stops without claiming a task still in Idea or Spec, since a claim there would make it the spec writer. It writes each test first, reviews its own diff against the spec in at most three rounds, and runs the code to check each acceptance criterion before it reports done. The developer's skills are your own verbs, run in your harness, and most are named like the CLI command they use: `add` adds a task, `skelcrew` reads `skelcrew status` and says what waits on you first, `log` presents one task with its spec and history, and `approve` shows a task and then runs plain `skelcrew approve`. There is no skill to send work back. `log` ends with the approve and reject commands for you to type, and never runs them. They all work in any harness as written: they name the task the developer gave rather than Claude Code's `$ARGUMENTS`, and describe when to use them in plain words, not only as a slash command. In Claude Code, only you can start `spec`, `develop` and `approve`, through `disable-model-invocation`. Claude may start `add`, `skelcrew` and `log` itself, since they only add an idea or read. Other harnesses ignore that field. |


To see whether the chosen checks pass on the current code, the caller runs them with
`localChecks` from `src/checks/checks.ts`.

## Plugins

`src/plugins/` connects the daemon to other tools. Each kind of plugin is an interface,
and every call answers with a value, never a throw, so a failure becomes a reply the core
decides on. Every call may also arrive twice after a crash, and must then change nothing.

| File | What it holds |
| --- | --- |
| `version-control.ts` | `VersionControl`: create and remove a task's worktree, read its branch when the agent reports done, merge it, and revert its commit on main. A merge can add one file of its own, such as the task's spec. `shortName` is the name a task goes by in the repository, such as `12-csv-export`, shared by its branch and its spec file. |
| `version-control.contract.ts` | The tests every version-control plugin must pass, against a throwaway git repository. |
| `git/git.ts` | The built-in plugin. Each build gets a worktree in `.skelcrew/worktrees/` on its own branch from main, such as `task/12-csv-export-2`. Removing one commits its uncommitted work first, and refuses if the worktree isn't on its task's branch or still has unsaved work after that. Each spec is written in a copy of main on no branch, in `.skelcrew/spec-worktrees/`, such as `12-csv-export`. Asked again, it gives back the same copy untouched. Removing one throws away anything changed in it, since a spec is never saved there. Like the other copies below, it is marked as Skelcrew's own, and anything at its path without that mark is left alone. A merge is built in `.skelcrew/merging/`, checked there, and only then moves main. The merge's own file, such as the spec, is added there even if the repository ignores its folder. The merge proves main gets exactly main merged with the task's commit, plus that file with exactly its text, so no hook can change or remove it. A revert is built the same way in `.skelcrew/reverting/`, as one new commit that undoes the task's commit. It moves main under the same rules as a merge, but runs no checks. The gate's checks run in a fresh copy of the reported commit in `.skelcrew/checking/`, removed afterwards. Its own copies are marked, so even one git can only half remove, such as with a read-only folder left in it, is made writable and deleted. `uncommittedOnMain` lists the tracked files with uncommitted changes in any checkout of main, which a merge can't move over. |
| `pull-requests.ts` | `PullRequests`: show a task's branch as a draft pull request for you to read, and close it again. Reading only: Skelcrew still merges locally. |
| `github/github.ts` | `GitHub`, the one pull-request plugin. `show` works out the GitHub repository from the `origin` remote, such as `owner/repo` from `git@github.com:owner/repo.git`, and names it in every `gh` call. Left to itself, `gh` would prefer an `upstream` remote, which on a fork is the project you forked. An `origin` that isn't on GitHub gets no pull request. `show` then asks `gh` for an open pull request on the branch, pushes exactly the checked commit to it (never by force), and opens a draft with `gh pr create --draft` if there was none. So asked twice, it opens one pull request. A pull request from someone's fork, on a branch with the same name, is ignored, so Skelcrew never links or closes a stranger's. It asks `gh` before pushing, so without `gh`, or with `gh` logged out, nothing is pushed. `close` closes it with a comment through `gh pr close`, then deletes the pushed branch on `origin`, but only while it is still at the commit Skelcrew pushed. For example, a reviewer's "Commit suggestion" on the draft adds a commit that `approve` never merged. That branch is kept, and the closing comment says it holds commits that weren't merged. git itself checks this at the moment of deleting, with `--force-with-lease`. The local branch stays. Every reply from `gh` is checked with Zod. Each call has a time limit: three minutes for a push, which may run a pre-push hook, one minute for `gh`. A call past its limit is killed, and `status` says which one it was. git and ssh are told never to ask for anything, such as a passphrase, since nobody is there to answer. An ssh command you set yourself is kept, in `GIT_SSH_COMMAND` or as the repository's `core.sshCommand`. Its tests use recorded replies, and never run `gh`. |
| `git/top.ts` | `repositoryTop`: asks git where the repository that holds a folder starts, the folder with its `.git`. It fails with a plain message when git isn't installed or the folder isn't in a repository. `insideRepository` is the message for a folder inside a repository. `mainRepository` gives the repository's main folder, even from inside one of its worktrees; the CLI finds the repository with it, and the daemon refuses to start in a worktree. `skelcrew init` uses both. The daemon has its own copy of this check for now. |

## Around the core (planned)

These parts are designed in the spec's Architecture and Plugins sections, and come in
build step 2 onwards.

- **The daemon** (`skelcrew serve`) holds all state. It owns the SQLite database, calls the
  core, carries out commands, and runs the local checks. The checks are part of the
  daemon, not a plugin, because running them is enforcing the gates.
- **Two ways to work:** the TUI, and your own harness through skills that call the CLI.
  Agents run in the background, started by the daemon, or attended, started by you in
  your harness. The spec's "Who does the work" section describes both.
- **Plugins** connect to other tools: the session runner, git, work sources like GitHub
  Issues, inbox surfaces like notifications. They bring information in and carry work
  out, but never change the rules.

## Where to start reading

1. `types.ts`, top to bottom. The comments explain why each type is shaped the way it is.
2. `docs/invariants.md`, for what must always be true.
3. `decide.ts`, starting from the outline in `decideTask`.
4. `decide.test.ts`, for concrete examples of every rule.

## Keeping this current

This document must match the code. A change that adds, removes, renames or moves a part
described here updates this document in the same pull request.
