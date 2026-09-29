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
            └──────────►  skelcrew CLI (planned)  ◄──┘
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
  your session and starts nothing. In Ready it still creates the worktree first. From
  then on, only that session is heard. Only the loop sees every task, so it checks for a
  free slot before either goes through.
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
4. It hands each command to the tools, then marks it done in the store. Replies come back
   later through `send`.

`startWaiting()` asks `schedule` what to start, and sends the starts. The loop counts the
starts it has sent out and not yet had answered, by task and request number, and gives
that count to the scheduler. `Loop.open` rebuilds everything from a saved log and carries
on from there.

If the daemon dies between saving a decision and carrying out its commands, nothing is
lost. `Loop.open` first carries out every saved command not yet marked done. So a command
can reach the tools twice, and the tools must treat a repeat as a no-op. For example, a
second "start #1, request 1" starts nothing.

## The event store

`src/store/` saves the event log in SQLite and reads it back. It's the first piece of
build step 2, outside the core because it touches the disk.

| File | What it holds |
| --- | --- |
| `schema.ts` | A Zod schema for every event and every command, typed against the core's own types. The typechecker fails if they drift apart, and names any event the schemas miss. |
| `store.ts` | `EventStore`: one table of events in order. `appendTask` saves one decision's events together, or none. `loadTasks` and `loadProjects` rebuild everything by replaying the events through `evolveTask` and `evolveProject`. A second table keeps the starts in flight, saved in the same transaction as the events, so a restart still knows which agents and worktrees are on their way. A third table keeps each decision's commands until they are carried out. |
| `fixtures/v1-events.jsonl` | 56 real events in the version 1 shape. They must always load. The file is never edited: a change that breaks it needs a way to read old events instead. |

Each event is checked against its schema twice: before it's written, and when it's read
back. Objects are strict, so an unknown field is refused, not dropped. A damaged row is
reported with its position, not guessed at.

## The workflow file

`src/config/workflow.ts` reads `.skelcrew/workflow.yml`: the core's config and the
commands the local gate runs. Every field is checked with Zod, and a file that doesn't
fit is refused with every reason, in plain words. An unknown field is refused too, so a
typo like `critical_path` can't be silently ignored. A file without `critical_paths`
makes every path critical, so nothing merges without your approval. `defaultWorkflow`
is the file `skelcrew init` will write.

## Around the core (planned)

These parts are designed in the spec's Architecture and Plugins sections, and come in
build step 2 onwards.

- **The daemon** (`skelcrew serve`) holds all state. It owns the SQLite database, calls the
  core, carries out commands, and runs the local checks. The checks are part of the
  daemon, not a plugin, because running them is enforcing the gates.
- **The CLI** is the one way in, for you and for agents. Typing `skelcrew` opens the TUI,
  and any command starts the daemon if it isn't running. Everything sent through it is
  checked with Zod before it reaches the core. Clients hold no state.
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
