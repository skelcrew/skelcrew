# Skelcrew spec v1

Sep 26, 2026 · @Simon

## Overview

Skelcrew moves coding tasks from idea to merged code with agents doing the work, while the developer acts as team lead: setting direction, answering questions and approving only what matters.

The problem is not that agents can't write code. It is that running several of them means constant chatting, babysitting sessions and reading diffs, which is draining and does not scale. Skelcrew replaces that with a workflow where tasks move through phases on their own, gated by deterministic rules, and the human is pulled in only for decisions.

The goal is to make building with agents fun again. Once agents could write the code, the work became prompt, wait, read, prompt again. Skelcrew gives the developer back the interesting parts: deciding what to build and how the system should work.

Skelcrew does not replace harnesses, terminals or issue trackers. It works alongside tools that already do their job well, such as Claude Code, Herdr, git and GitHub, and owns the part nobody else does: the rules and the record.

## Principles

- **Developer well-being over output.** Pace work by human attention, not machine capacity. Fewer decisions, less review, bounded parallelism.
- **Prompts propose, the core decides.** Agents can suggest a transition. Only the core, following deterministic rules, performs it.
- **Focus on what matters.** Building is cheap now, so the risk is building the wrong things. The workflow should make distraction harder, not easier.
- **Rules are core, everything else is a plugin.** Anything that decides whether work may move lives in the core. Anything that connects to another tool is a plugin, even when it ships built in.
- **Plain files for what people read.** Rules, skills and the record are Markdown and YAML in the repository, readable by humans and agents, versioned in git. Runtime state lives in SQLite.
- **Personal where it should be.** Skills are the developer's craft and are swappable. Skelcrew ships good defaults but never requires them.
- **Works with zero setup.** The full loop runs on one machine with git, Claude Code and a terminal.

## Layer model

Skelcrew owns Coordination and Oversight, ships default skills into Context, and reaches every other layer through plugins.

| # | Layer | Contents | Examples | Skelcrew's role |
| --- | --- | --- | --- | --- |
| 7 | Human | Direction, priorities, architecture, decisions | You | Serves |
| 6 | Oversight | Inbox and record | Skelcrew | Owns |
| 5 | Delivery | Deployment, monitoring, error tracking, rollback | Vercel, Fly, Sentry, CI on main | Listens via plugins |
| 4 | Coordination | Work source, workflow and gates, dispatch, orchestration | Skelcrew, GitHub Issues, Linear | Owns |
| 3 | Context | Repository, agent instructions, skills, architecture docs, conventions | AGENTS.md, skills | Ships default skills |
| 2 | Execution | Models, harnesses, sessions, isolation, version control | Claude Code, Herdr, git, worktrees | Uses via plugins |
| 1 | Infrastructure | Laptop, or server plus network access | Mac mini, VPS, Tailscale | Runs on |

The interface (CLI, TUI, phone) cuts across all layers rather than sitting on top.

## Architecture

Skelcrew is one binary with a headless daemon at its centre, thin clients around it, and plugins at its edges. Stack: TypeScript on Bun.

**Daemon** (`skelcrew serve`) owns all state and rules:

- task state and phase transitions
- workflow engine, gates and local checks
- merge policy and reverts
- dispatch
- decision inbox and record
- an MCP server that agents use to report progress, ask questions and propose transitions

**Clients** talk to the daemon over one local socket protocol: the CLI first, then a TUI, later possibly a desktop or phone view. Clients hold no state.

**Plugins** connect the daemon to other tools. Communication happens three ways:

| Kind | Direction | Example | Waits for result |
| --- | --- | --- | --- |
| Event | Core to plugins | `task.ready`, `task.merged` | No |
| Command | Core to plugin | open a session, create a worktree | Yes |
| Signal | Plugin to core | issue delegated, remote check finished | Core validates |

Events are facts announced after a transition. Plugins that only reflect state (issue trackers, notifications) listen and never block the task. Commands are work the core needs done before it can continue. Signals are requests; the core decides whether they are allowed.

State lives in a local SQLite database: every event is appended to an events table, alongside current task state, projects, the built-in board, inbox items and cost data. The record is a readable projection of the events.

## Stack and code quality

Skelcrew is built in TypeScript on Bun, with the language's escape hatches closed, because it is itself developed by agents with human review only on critical paths.

Why TypeScript over Go or Rust:

- Reviewing only critical code means the developer must read it quickly and confidently. The developer knows JavaScript and Python deeply, not Go or Rust.
- It has the largest training corpus and fast typecheck and test loops, so agents get many correction cycles.
- Its weakness is escape hatches (`any`, casts, unchecked input), which the rules below remove.

Rust offers stronger compile-time guarantees and Go more uniform code, but both would make critical review slower and less reliable for this developer.

Rules, enforced as Skelcrew's own gates:

- `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` in tsconfig
- lint rules banning `any`, non-null assertions and unchecked casts (Biome or typescript-eslint)
- runtime validation at every boundary: plugin input, MCP messages, config, external API responses (Zod or Valibot)
- errors as values in the core, so failure paths are visible in types
- the state machine as a pure module with thorough tests

Critical paths in Skelcrew's own repository: the state machine, gates, merge policy and revert. Everything else merges automatically once the gates pass, making Skelcrew its own first user.

## Core design

Every decision about a task passes through one pure function; everything that touches the world carries out what it returns. This is what makes "prompts propose, the core decides" enforceable, and it keeps the critical code small enough to review in one sitting.

**Decide.** The only place a task can change:

```ts
decide(state, input, config):
  | { events: Event[]; commands: Command[] }
  | { rejected: Reason }
```

Inputs are everything that can happen to a task: an agent proposing done, a check result, a human answer, a work source signal, a clock tick. Phase transitions are one kind of outcome; many inputs change something without moving phase, and some are rejected (an agent proposing a merge, an issue dragged to Done by hand).

**Scheduler.** A second pure function over all tasks decides what to start next. At most `max_running` agents work at once, counting both spec and develop sessions, so new work is paced by how many questions the developer can handle. An agent whose merge is waiting for the developer's approval does not count: it sits idle and cannot ask anything, and it stays open so a send-back reaches the agent that wrote the code. It only starts tasks in active projects, or tasks with no project, and never starts a blocked task. Quota awareness comes later.

**Contracts and policies.** Small pure predicates called by decide: spec completeness, critical path match, attempts left. Each returns pass or fail with reasons, which become inbox text and record entries.

**Events as source of truth.** State is the reduction of a task's events. Events are appended to an events table in SQLite and versioned from day one. Replaying the log rebuilds state after a crash and reproduces bugs exactly.

**No hidden inputs.** Time and IDs are passed in, never read inside the core, so every run is deterministic.

**Testing:**

- one test per transition, allowed and rejected
- property-based invariants (fast-check): the full list is in `docs/invariants.md`. Examples: no task reaches Done without passing checks, rejected inputs never change state, no agent or worktree is ever left untracked, and replay always yields the same state
- golden stories: full lifecycles as input sequences with expected events (happy path, blocked, escalated then approved, merged then reverted)
- a simulator that feeds the core scripted plugin responses, so whole lifecycles run in milliseconds before any real plugin exists

This resembles the Elm architecture and the decider pattern from event sourcing.

**How the core is built.** The core is built in close collaboration with Claude, in live sessions rather than as background tasks:

- the developer writes the types, contracts and invariants first; Claude implements against them
- tests come before implementation and are read closely, since a wrong test is more dangerous here than wrong code
- one transition or contract at a time, with every diff read before it lands
- Claude is asked to find input sequences that break an invariant, as an adversarial check

## Task lifecycle

A task moves through six phases: Idea, Spec, Ready, In progress, Checks, Done. A task can also end as Dropped, when the developer decides not to do it. Blocked is a side state.

1. **Define.** The developer adds a task: `skelcrew add`, a task on the built-in board, or an issue delegated to Skelcrew in a work source plugin. A captured task waits in Idea until the developer asks for a spec; delegating an issue counts as asking. Each task gets the next number in the repository, shown as `#12`, and commands take that number. A delegated issue keeps its own number as a link, shown as `#12 CSV export (GitHub #40)`. Event: `task.created`.
2. **Spec.** The daemon runs the spec skill. Anything it cannot decide becomes an inbox question with options. Intake can also be done by hand or interactively in the harness; the daemon only cares whether the result meets the spec contract. Event: `task.specced`.
3. **Ready.** The core checks the spec against the contract, then asks the developer to approve it in the inbox. When spec\_approval is always, only that approval moves the task to Ready; agents and plugins can never do it. A delegated issue never skips this step. Event: `task.ready`.
4. **Dispatch.** The core asks the version control plugin for a worktree on a branch named after the task, such as `task/12-csv-export`, and the session plugin to start the harness in it with the develop skill. Each build of a task starts fresh from main on its own branch. If the task is sent back to spec and built again, the new branch is `task/12-csv-export-2`, and the old one is kept for reference. Before any worktree is removed, its uncommitted changes are committed to its branch, so no work is lost. Event: `task.dispatched`.
5. **Develop.** The agent works and reports through MCP. If it needs information, it raises one clear question and the task stays In progress. If it cannot continue at all, it reports giving up; only the core moves a task to Blocked. Event when blocked: `task.blocked`.
6. **Checks and review.** The core runs the gates: local check commands, remote check results from plugins, then a review by a fresh agent session. Failures return to the developing agent; repeated failures block the task with a reason. Event: `task.checks_passed`.
7. **Merge.** The merge policy either merges automatically or escalates to the inbox. Tasks merge one at a time. Just before merging, the branch is brought up to date with main and the local checks run again. If that fails, or the branch conflicts with main, the task returns to In progress with the failure, and it counts as a failed attempt. After the merge, the worktree is removed. Events: `task.merged` or `task.merge_approval_requested`.
8. **Record.** The task's events are summarised into a Markdown entry.
9. **Afterwards.** If a merged task turns out to be wrong, the developer reverts it with `skelcrew revert`. The core reverts the commit, returns the task to Spec with the reason attached, and records why. The revised spec needs approval again. Event: `task.reverted`.

## Projects

Projects group tasks, so the developer keeps an overview and chooses which work may move.

- A project has a name and a one-line goal, such as "Inbox: answer every decision from the CLI in under a minute".
- A task belongs to one project or to none. Projects do not nest.
- A project is active or parked. New projects start active.
- The scheduler only starts agents for tasks in active projects, and for tasks with no project. Parking a project stops new agents from starting in it; work already running carries on.
- Ideas can be captured into a parked project at any time. They wait there without using agents or adding inbox items.
- `skelcrew status` groups tasks by project.

Work sources with their own grouping, such as GitHub milestones or Linear projects, map to Skelcrew projects in their plugins.

## Phase contracts and gates

Each phase has a contract: what must be true before a task may leave it. Contracts are enforced by the core, never by a skill, so any skill that satisfies them can replace the defaults.

| Transition | Contract |
| --- | --- |
| Idea to Spec | The developer asked for a spec (`skelcrew spec`, `skelcrew add --spec`, or delegating the issue); a spec session starts, or a spec written by hand is provided |
| Spec to Ready | Spec has scope, acceptance criteria and no open questions, and the developer approved it (unless spec\_approval is never) |
| Ready to In progress | Worktree and session started |
| In progress to Checks | Agent reports done; branch has commits |
| Checks to Done | All gates pass; merge policy allows or human approves; the branch, brought up to date with main, still passes the local checks |

Gates run in order and stop at the first failure:

1. Local check commands from `workflow.yml` (tests, types, lint).
2. Remote check results reported by plugins, such as GitHub Actions.
3. Agent review by a fresh session, optionally with a different model.

After a configurable number of failed attempts, the task moves to Blocked with the last failure as its reason.

## Merge policy and revert

Tasks merge automatically unless they touch critical paths; a task that turns out wrong is undone as one commit. This replaces human code review, which is draining and does not scale with parallel agents.

**Merge policy.** `skelcrew check` compares the files a task changed against the critical paths in `workflow.yml` (for example auth, payments, migrations). No match: merge. Match: escalate to the inbox as a short summary with approve or send back, never a raw diff. The same command runs standalone in any CI.

**Merge shape.** Each task lands as one squashed commit on main, so undoing a task is a single revert.

**Revert.** In v1, reverts are manual. `skelcrew revert <task> "<reason>"` reverts the task's commit, returns the task to Spec with the reason attached, and records why. The revised spec needs approval again. Production rollback stays with the deploy tool, which picks up the revert.

**Later: automatic revert.** After v1, the core could re-run checks on main after every merge and listen to plugins such as GitHub Actions or Sentry. When main breaks, it would revert the most likely merge. The hard part is knowing which merge broke main when several landed close together.

## Decision inbox

The inbox is the only place Skelcrew asks for the developer's attention, and every item is a decision that takes seconds, not a conversation.

Item types:

- **Question:** from spec or development, with two to four options plus free text.
- **Approval:** a finished spec, or a merge touching critical paths, shown as a summary with approve or send back. A spec sent back returns to the spec agent with the developer's note. A merge sent back returns to In progress with the note.
- **Blocked:** a task the core stopped, with its reason (ran out of attempts, safety cap reached, agent gave up, worktree or session failed) and options that fit it: retry, send back to spec, or drop. Retry resets the attempt count and the safety cap; the record keeps the totals. Only the core blocks tasks; agents ask questions or report giving up.

  A blocked task keeps its phase and its worktree, but its agent is stopped, so it does not hold a slot while it waits. A task blocked during checks goes back to In progress. Retry puts the task back in the queue. When a slot is free, a new agent starts in the same worktree, with the last failure as its brief.

Rules:

- One open question per task at a time.
- Items are batched so they can be handled in one sitting.
- Agent replies are short, like a chat message, never an essay.

The inbox is core; where it appears is a plugin: CLI and TUI built in, desktop notifications as a nudge, phone push and issue tracker surfaces as first party plugins.

## Record

The record is a human readable account of what shipped and why, written as Markdown into `.skelcrew/record/` in the repository.

Each task entry contains:

- what shipped, and the task it came from
- decisions the developer made along the way
- gate results and whether it merged automatically or was approved
- cost and time spent
- any later revert and its reason

Entries roll up into a daily digest. Because the record is a projection of the event log, it can be rebuilt or audited at any time. Because it is plain files in git, it outlives Skelcrew and stays readable anywhere.

## Costs and tracing

Skelcrew traces tasks itself and links to the harness for agent-level detail; it measures cost per task and phase and stops work before it runs away.

**Tracing:**

- Task level: the event log is the trace, owned by Skelcrew.
- Agent level: prompts, tool calls and outputs stay in the harness's own session transcripts. Skelcrew passes the task ID into each session as an environment variable and stores the session ID on the task, linking rather than copying.
- An optional tracing plugin can export to a tool like Langfuse. Traces may contain code, paths and secrets and are treated as sensitive.

**Costs:**

- Token usage per task and per phase, read from session transcripts and shown as an estimated cost at API prices, even on a subscription.
- A safety cap per task: one default limit on tokens and wall-clock time, catching agents stuck in a loop within a session. A task that reaches it moves to Blocked with the reason safety cap reached. Configurable per-task budgets come later, once the cap shows what the right numbers are.
- Later: quota-aware scheduling, so dispatch slows or pauses near the plan's limits instead of starting tasks that will stall halfway.
- Cost appears in every record entry and is one of the metrics evals compare.

## Retrieval and learnings

Skelcrew does no code retrieval of its own; harnesses already search code well. It only makes its own history findable, so tasks build on what earlier tasks learned.

- **Past decisions.** Answers already given ("CSV or Markdown for exports?") are searchable, so the spec skill does not ask the same question twice.
- **Record search via MCP.** A plain text search tool over decisions and record entries. Embeddings only if plain search clearly fails.
- **Learnings into Context.** When a task discovers something durable ("tests need the database running"), it proposes an addition to `AGENTS.md` or a conventions file. Proposals go through the normal gates and count as critical, so agents never quietly rewrite their own instructions.

## Evals

The core is tested, not evaluated; evals cover the parts where a model makes judgments, starting with the review gate that auto-merge depends on.

| Target | Eval set | Measures |
| --- | --- | --- |
| Review gate | Diffs with seeded bugs plus clean diffs | Catch rate, false alarms |
| Spec skill | Rough ideas of varying clarity | Contract met, questions asked, repeat questions |
| Code skill | Fixture repo with 10 to 20 tasks and hidden acceptance tests, including underspecified and impossible tasks | Pass rate, first-try gate passes, attempts, scope discipline, never weakening tests, mutation score of its tests, asking or blocking instead of inventing |
| Init skill | Varied repos: Bun app, Python service, monorepo, repo without tests | Detected checks run and pass on main, critical path recall against hand labels, no overwrites, idempotent, warns when auto-merge is unsafe |
| Real use | The event log | Revert rate, escalations approved versus sent back, blocked tasks, questions per task, cost |

Evals start after dogfood day with small sets. They run when a skill, model or prompt changes, not on every commit, and they run as Skelcrew tasks. Results guide which paths stay critical and are published as evidence for users.

## Plugins

A plugin connects Skelcrew to another tool. Plugins bring information in and carry decisions out, but can never change the rules: gates, merge policy and transitions stay in the core.

| Category | Layer | Job | Built in | First party (opt in) | Later |
| --- | --- | --- | --- | --- | --- |
| Work source | Coordination | Pull tasks, write back specs, sync status | Built-in board (core) | GitHub Issues | Linear, Jira |
| Harness | Execution | Start an agent, pass prompts, load skills | Claude Code profile |  | Codex, Pi |
| Session runner | Execution | Run and watch agent sessions | Process runner | Herdr | Remote machines |
| Version control | Execution | Worktrees, merge, revert, changed files | Git |  | Jujutsu |
| Delivery signal | Delivery | Report breakage after merge |  |  | GitHub Actions, Sentry, deploy platforms |
| Inbox surface | Oversight | Show decisions, return answers | Desktop notifications | Phone push (ntfy) | Slack, Linear agent sessions |

Notes:

- **Harnesses** are likely profiles rather than code: a command template, skills folder and flags. A code plugin only when a harness does something unusual.
- **Process runner** runs the agent in a pseudo terminal, detached, logging output per task. State comes from the agent's MCP reports.
- **Work source plugins** translate Skelcrew's phases into the tool's states and turn manual changes (an issue dragged to Done) into signals the core validates.
- **Linear** delegation uses its agent API, which requires a public webhook, so it arrives with a hosted relay. Polling for tagged issues works without one.
- Local check commands are core, not a plugin, because running them is enforcing the gates.

## Configuration and repository layout

`skelcrew init` writes everything Skelcrew needs into the repository, with sensible defaults:

```
.skelcrew/
  workflow.yml    phases, gates, check commands, critical paths, plugins
  record/         record entries and daily digests
  skelcrew.db     events, state, board, inbox and costs (SQLite, gitignored)
.claude/skills/   default skills (spec, develop, review)
```

Rules and record are committed and reviewed like code. The SQLite database holds runtime state and stays out of git; tasks that should be visible in git belong in a work source like GitHub Issues.

Example `workflow.yml`:

```yaml
checks:
  - bun test
  - bun run typecheck
  - bun run lint
max_attempts: 3
max_running: 2
spec_approval: always
review:
  model: different
critical_paths:
  - src/auth/**
  - migrations/**
plugins:
  sessions: herdr
  work_source: github
```

## CLI

| Command | Does |
| --- | --- |
| `skelcrew init` | Set up `.skelcrew/` and default skills in a repository |
| `skelcrew serve` | Run the daemon (foreground or as a service) |
| `skelcrew add "<task>"` | Capture a task as an Idea; `--spec` also starts speccing, `--project <name>` puts it in a project |
| `skelcrew project add "<name>" "<goal>"` | Create a project |
| `skelcrew project park <name>` | Stop new agents from starting in a project; `activate` undoes it |
| `skelcrew project set <task> <project>` | Put a task in a project, or take it out with `none` |
| `skelcrew spec <task>` | Ask for an Idea to be specced |
| `skelcrew approve <task>` | Approve a spec or a critical merge; `--send-back` returns it |
| `skelcrew drop <task>` | Drop a task that is not done; stops its session and removes its worktree if it has them |
| `skelcrew inbox` | List open decisions and answer them |
| `skelcrew status` | Show tasks by project and phase, and running sessions |
| `skelcrew attach <task>` | Follow a task's session or log |
| `skelcrew log <task>` | Show a task's events and record entry |
| `skelcrew check` | Decide whether a diff is safe to auto-merge; runs standalone in CI |
| `skelcrew revert <task> "<reason>"` | Undo a merged task and return it to Spec with the reason |

The TUI comes after the CLI, as another thin client over the same socket.

## Build plan

Skelcrew should build itself as early as possible, and trust in auto-merge is earned from data rather than switched on. The existing CLI keeps building the new core until the daemon can take over.

1. **Core in close collaboration.** State machine, contracts, event log and scheduler, with the full test approach and the simulator. Built interactively with Claude rather than delegated: the developer defines the types, contracts and invariants first, Claude implements against them, and every change to the core is read before it lands.
2. **Smallest real loop.** Daemon, CLI, built-in board, process runner, git plugin, Claude Code profile and local checks. Merging stays manual, and specs are approved with `skelcrew approve` until the inbox exists. One task goes from `skelcrew add` to a merged commit.
3. **Dogfood day.** Skelcrew runs on its own repository; every change from here is a Skelcrew task.
4. **Inbox and intake.** Questions with options, the spec skill wired into intake, desktop notifications.
5. **Auto-merge, gradually.** Start with every path critical, so all merges arrive as inbox summaries and the workflow stops at approval, like a pull request. Then loosen critical paths based on which approvals were rubber-stamped.
6. **Record and digest.** A projection of the event log.
7. **Second implementations.** GitHub next to the built-in board, Herdr next to the process runner, to validate the plugin interfaces.
8. **TUI.** Card and status overview as a thin client.

Metrics tracked from step 3: inbox items per day, minutes spent on decisions, automatic versus approved merges, reverts and cost per task. They guide the design and are the evidence for users and funders.

## v1 scope and non-goals

v1 is single user, runs on one machine, and ships only the plugins its first user needs daily.

**In v1:**

- daemon, CLI and the full lifecycle, with manual revert
- built-in board, projects, inbox, record and event log
- built-in plugins: git, process runner, Claude Code profile, desktop notifications
- first party plugins: GitHub (issues, pull requests, Actions results) and Herdr
- default skills: spec, develop, review
- plugin interfaces defined internally, with two implementations for sessions (process runner, Herdr) and work sources (built-in board, GitHub)

**Not in v1:**

- teams, shared boards or permissions
- a hosted service or webhook relay; GitHub is polled
- a public plugin API
- harnesses other than Claude Code
- deployment or production rollback, which stay with deploy tools
- automatic revert when main breaks after a merge
- an IDE, editor or diff viewer

## Open questions

- [ ] Who does the review gate: a fresh Claude session, a different model, or both depending on risk?
- [ ] How is billing handled if programmatic use of subscriptions changes? The process runner keeps sessions interactive, but a fallback to API keys may be needed.
- [ ] Should the built-in board and GitHub Issues coexist in one repository, or is it one work source per project?
- [ ] Which critical paths should `skelcrew init` suggest by default?
- [ ] Should every learning proposal count as critical, or only changes to `AGENTS.md`?
- [ ] What should the default safety cap be, in tokens and in time?
- [ ] Which seeded bug types matter most for the review gate eval, and what catch rate is good enough to loosen a critical path?
