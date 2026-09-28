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
core as new inputs. **Clients** like the CLI talk to the daemon. **Plugins** connect it to
other tools, like Claude Code, git and GitHub.

```
            you                    agents
             │                       │
        CLI, TUI (planned)     MCP server (planned)
             │                       │
             └────────►  daemon  ◄───┘          plugins (planned):
                     (planned)   ◄────────────  git, sessions, GitHub…
                        │  ▲
                 input  │  │  events + commands
                        ▼  │
                      ┌──────┐
                      │ core │   pure functions: no clock, no disk, no network
                      └──────┘
```

## How one input flows

An example: the agent working on task #12 says it's done.

1. **The agent reports.** It calls `report_done` through the MCP server. The daemon adds
   facts from git: 3 commits, and one changed file, `src/reports/export.ts`.
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
| `phases.ts` | Phase names as you see them ("In progress"), and `TaskIn<"checks">`, the type of a task in one phase. |
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
- **Inputs are grouped by who sends them:** human, agent, plugin, system. The MCP server
  can only build agent inputs. So an agent has no way to even express "approve this spec".
- **Commands are how the core touches the world without doing it.** `create_worktree`,
  `start_develop_session`, `merge` and so on. The daemon carries them out, and the results
  come back as inputs. In tests, a scripted reply stands in for each one.
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

Tests sit next to the code: `decide.ts` and `decide.test.ts`.

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
- **Golden stories** (`stories.test.ts`). Whole lifecycles, one line per input: what was
  sent, the events it caused, and the commands for the daemon. The happy path, a task
  blocked and retried, a merge that waits for approval, and a revert. The full events of
  each story are also saved in `__snapshots__/`, so any change to the shape of the event
  log shows up in review. Update the snapshots only on purpose, with
  `bun test --update-snapshots`.
- **The simulator** (_planned_). It stands in for agents, git and plugins, so full
  lifecycles run in tests.

`bun run check` runs the lint, the typecheck and every test. It must pass on every commit.

## Around the core (planned)

These parts are designed in the spec's Architecture and Plugins sections, and come in
build step 2 onwards.

- **The daemon** (`skelcrew serve`) holds all state. It owns the SQLite database, calls the
  core, carries out commands, and runs the local checks. The checks are part of the
  daemon, not a plugin, because running them is enforcing the gates.
- **The MCP server** is how agents report progress and ask questions. Everything an agent
  sends is checked with Zod before it reaches the core.
- **Clients** (the CLI first, a TUI later) talk to the daemon over a local socket. They
  hold no state.
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
