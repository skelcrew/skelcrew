// Core types for Skelcrew. Draft 4.
//
// Everything here is plain data. The core never reads the clock, the disk or
// the network: time and IDs arrive inside inputs, and all side effects leave
// as commands.
//
// Why: the core is the code that decides what agents may do, so it must be
// easy to trust. Plain data with no side effects means the same inputs always
// give the same result. Tests can feed it a whole task lifecycle in
// milliseconds, and a bug seen once can be replayed exactly from the log.

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

// IDs are branded, so one kind can't be passed where another is expected.
// ids.ts explains why and how.
import type { CommitSha, ProjectId, SessionId, TaskId } from "./ids";

export type { CommitSha, ProjectId, SessionId, TaskId };

// Passed in, never read with Date.now(). That keeps decide deterministic.
export type Timestamp = number; // milliseconds since epoch

// The six phases from the spec, plus Dropped as a second way to end.
// Blocked is not here: it is a flag on the task (see Task.blocked), so a
// blocked task keeps its phase and "retry" knows where to pick up again.
export type Phase = "idea" | "spec" | "ready" | "in_progress" | "checks" | "done" | "dropped";

// The checks a task passes before merging, run in the order Config.gates
// lists them. Cheapest first: local commands take seconds, remote results
// cost nothing to wait for, and a review session costs tokens.
export type GateName = "local" | "remote" | "review";

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

// The fields the spec contract checks, and nothing else. The core does not
// read the rest of a spec, so any spec skill that fills these works.
export type Spec = {
  scope: string;
  acceptance: string[];
  openQuestions: string[]; // must be empty before the task can leave Spec
};

// Options make an answer one tap instead of a typed reply. That keeps each
// inbox item a decision of seconds, not a conversation.
export type Question = {
  from: "spec" | "develop"; // tells the core which session gets the answer
  text: string;
  options: string[]; // two to four; free text is always allowed
  askedAt: Timestamp;
};

// Each reason offers different choices in the inbox. Running out of attempts
// suggests retry; an agent that gave up may suggest sending back to spec.
export type BlockReason =
  // Failed gates and failed merges share one attempt count. `failure` is
  // the last one, so the inbox can say whether a gate or the merge failed.
  | { kind: "out_of_attempts"; failure: Failure }
  | { kind: "safety_cap"; usage: Usage }
  | { kind: "agent_gave_up"; message: string }
  | { kind: "worktree_failed"; message: string }
  | { kind: "session_failed"; message: string };

// A failed gate, or a failed merge: the branch no longer passes the local
// checks once brought up to date with main, or it conflicts with main.
// Both go back to the agent the same way, so they share one type.
export type Failure = {
  step: GateName | "merge";
  summary: string; // short, becomes feedback to the agent and inbox text
};

// Tokens catch an agent burning through the plan. Time catches an agent
// stuck waiting on something that never happens.
export type Usage = {
  tokens: number;
  ms: number;
};

// Each task works in its own worktree, so parallel agents never touch each
// other's files.
export type Worktree = {
  path: string;
  branch: string; // e.g. "task/12-csv-export": the number keeps it unique
};

// Where a task came from, when it came from another tool. The task keeps
// its own number; this is only a link, shown as "#12 CSV export (GitHub #40)".
export type SourceRef = {
  label: string; // e.g. "GitHub #40"
  url: string;
};

// Facts about the task's branch, gathered by the shell from version control.
// The core never runs version control itself; the shell attaches these when
// the agent reports done. `commits` enforces "branch has commits"; `changedFiles` feeds the
// critical path check.
export type BranchFacts = {
  commits: number;
  changedFiles: string[];
};

// Data that only exists in some phases. Each phase carries exactly what it
// needs, so impossible combinations (a Done task with no merge commit, a
// task in Checks with no worktree) cannot be written down. The typechecker
// then catches whole classes of bugs before any test runs.
export type PhaseState =
  | { phase: "idea" }
  | {
      phase: "spec";
      // Kept when a spec is redone, so the agent revises instead of
      // starting over.
      spec: Spec | null;
      // Why it is being redone: a send-back or a revert. Both reach the
      // agent the same way, so one field covers both.
      note: string | null;
      step: SpecStep;
    }
  | { phase: "ready"; spec: Spec; step: ReadyStep }
  | {
      phase: "in_progress";
      spec: Spec;
      // Kept while the task is blocked, so a retry carries on with the
      // same code instead of starting over.
      worktree: Worktree;
      step: DevelopStep;
      attempts: number; // failed gate or merge rounds since the last retry
      brief: Brief;
    }
  | {
      phase: "checks";
      spec: Spec;
      worktree: Worktree;
      attempts: number;
      branch: BranchFacts;
      step: ChecksStep;
    }
  // mergeCommit is what `skelcrew revert` undoes. Each task lands as one
  // squashed commit, so one commit is enough.
  | { phase: "done"; spec: Spec; mergeCommit: CommitSha; step: DoneStep }
  | { phase: "dropped" };

// What the next develop agent should know, kept until an agent reports done:
// the last gate or merge failure, your note from sending a merge back, and
// why the task was last blocked. A new agent starts with all three, so it
// doesn't repeat what went wrong.
export type Brief = {
  failure: Failure | null;
  note: string | null;
  blocked: BlockReason | null;
};

// Spec, Ready and In progress all wait for a free slot before an agent
// starts. The steps are separate states because each waits on a different
// reply from the shell, and a crash in between must replay to the right place.
export type SpecStep =
  | { kind: "queued" } // waiting for a slot (maxRunning)
  | { kind: "starting"; request: number } // start_spec_session sent, no reply yet
  | { kind: "running"; session: SessionId } // stored so drop can stop it
  | { kind: "awaiting_approval" }; // no agent running, so no slot used

// The spec contract says a task only reaches In progress once the worktree
// and the session both exist. Until then, it stays in Ready.
export type ReadyStep =
  | { kind: "queued" }
  | { kind: "creating_worktree"; request: number }
  | { kind: "starting_session"; worktree: Worktree; request: number };

// In progress only waits for a slot after a block. Blocking stops the agent,
// so a blocked task holds no slot while it waits for the developer. After a
// retry, a new agent starts in the same worktree.
export type DevelopStep =
  | { kind: "queued" }
  | { kind: "starting"; request: number }
  | { kind: "running"; session: SessionId };

// The develop agent stays open while the gates run, so a failure can go
// straight back to the agent that wrote the code. Once they pass, it is
// stopped: an idle agent waiting for a merge would otherwise wake up later
// without a free slot. So only a running gate has a session.
export type ChecksStep =
  | { kind: "gate"; gate: GateName; request: number; session: SessionId }
  | { kind: "awaiting_merge_approval" }
  | { kind: "merging"; request: number };

// A revert is two steps, like a merge: version control is asked, then
// answers. The task stays Done until the revert has happened, so the record
// never says it did when it didn't. A failed revert stays Done, and the
// inbox says why.
export type DoneStep =
  | { kind: "merged" }
  | { kind: "reverting"; reason: string; request: number }
  | { kind: "revert_failed"; summary: string };

export type Task = PhaseState & {
  id: TaskId;
  title: string;
  project: ProjectId | null; // null means no project; the scheduler treats it as active
  source: SourceRef | null; // null when added in Skelcrew itself
  createdAt: Timestamp;
  // At most one open question per task. A second question waits until the
  // first is answered, so the inbox never floods from one task.
  question: Question | null;
  // Blocked is a flag on top of the phase. Blocking stops the task's agent
  // and puts its step back to queued; the scheduler skips it until a retry
  // clears the flag. A task blocked in Checks goes back to In progress.
  blocked: BlockReason | null;
  // How many times the task has been built. Each build gets its own branch
  // from main ("task/12-csv-export", then "task/12-csv-export-2"), so a
  // build after a send-back never starts on code written for the old spec.
  builds: number;
  // How many requests the task has sent that expect a reply: starting an
  // agent, creating a worktree, running a gate, merging, reverting. decide
  // gives each the next number and writes it into the event and the command;
  // its reply must bring it back. A reply with any other number is late or
  // repeated, so it can never answer the current request.
  requests: number;
  // Two usage counters. `usage` never resets, so the record shows the true
  // cost. The safety cap counts from `usageAtRetry`, so a retried task gets
  // a fresh allowance instead of being blocked again at once.
  usage: Usage;
  usageAtRetry: Usage;
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

// A named group of tasks, one level deep. Parked projects keep their tasks
// but the scheduler starts no new agents for them.
//
// Why a core type and not a label: the active/parked rule changes which
// work may start, and rules live in the core. Grouping alone could have
// been a tag.
export type Project = {
  id: ProjectId;
  name: string;
  goal: string; // one line, so the developer remembers why it exists
  status: "active" | "parked";
  createdAt: Timestamp;
};

// Only the developer changes projects. There is no agent or plugin input,
// so an agent cannot activate a parked project to give itself work.
export type ProjectInput =
  | { type: "create"; name: string; goal: string }
  | { type: "park" }
  | { type: "activate" };

export type ProjectEnvelope = {
  projectId: ProjectId;
  at: Timestamp;
  input: ProjectInput;
};

export type ProjectEventBody =
  | { type: "project.created"; name: string; goal: string }
  | { type: "project.parked" }
  | { type: "project.activated" };

export type ProjectEvent = ProjectEventBody & {
  v: 1;
  projectId: ProjectId;
  at: Timestamp;
};

// ---------------------------------------------------------------------------
// Inputs: everything that can happen to a task
// ---------------------------------------------------------------------------
//
// Inputs are grouped by who can send them. A CLI call from an agent can only
// become an AgentInput, so an agent has no way to express "approve this
// spec". That makes "prompts propose, the core decides" a type error to
// break, not just a runtime check.

export type HumanInput =
  | {
      type: "add";
      title: string;
      project: ProjectId | null;
      requestSpec: boolean; // `add --spec`: capture and ask for a spec in one step
    }
  | { type: "change_project"; project: ProjectId | null }
  | { type: "request_spec" }
  | { type: "provide_spec"; spec: Spec } // a spec written by hand
  | { type: "approve_spec" }
  | { type: "revise_spec"; note: string } // "send back" on a spec: the spec agent redoes it
  | { type: "answer"; text: string }
  | { type: "approve_merge" }
  | { type: "revise_merge"; note: string } // "send back" on a merge: a new develop agent
  | { type: "retry" }
  | { type: "back_to_spec"; note: string } // from Ready, In progress or Checks: the spec was wrong
  | { type: "drop" }
  | { type: "revert"; reason: string }; // the reason guides the redone spec

// Agents can only report and ask. Each of these is a proposal: decide still
// checks it against the task's phase and the contracts.
//
// `session` says which agent sent it. The daemon sets it from the agent's
// identity, never the agent itself. Only the task's current agent is heard,
// so a report from one it replaced can't stop the new one or resubmit old
// work.
export type AgentInput = { session: SessionId } & (
  | { type: "submit_spec"; spec: Spec }
  | { type: "ask"; text: string; options: string[] }
  | { type: "report_done"; branch: BranchFacts } // shell attaches branch facts
  | { type: "give_up"; message: string }
);

// Plugin inputs are either results of commands the core sent, or signals
// from outside. Signals are requests: an issue dragged to Done becomes
// `external_move`, which decide rejects rather than obeys.
export type PluginInput =
  | {
      type: "issue_delegated";
      title: string;
      source: SourceRef;
      project: ProjectId | null; // mapped from e.g. a GitHub milestone
    }
  | { type: "external_move"; to: string } // e.g. issue dragged to Done
  // Replies to commands. Each brings back the command's `request` number, so
  // a late or repeated reply can never answer the current request.
  | { type: "worktree_created"; request: number; worktree: Worktree }
  | { type: "worktree_failed"; request: number; message: string }
  | { type: "session_started"; request: number; session: SessionId }
  | { type: "session_failed"; request: number; message: string } // the agent didn't start
  | { type: "gate_result"; request: number; gate: GateName; ok: boolean; summary: string }
  | { type: "merged"; request: number; commit: CommitSha }
  | { type: "merge_failed"; request: number; summary: string }
  | { type: "reverted"; request: number }
  | { type: "revert_failed"; request: number; summary: string }
  // An agent has stopped. It names the session, so a report about an agent
  // the task no longer has is refused, and the request that started it, so a
  // crash that overtakes the agent's start reply still counts as a failed
  // start.
  | { type: "session_crashed"; request: number; session: SessionId; message: string };

// Inputs the daemon makes itself. The scheduler's pick is an input, not a
// direct change, so decide keeps the final say on every transition.
export type SystemInput =
  | { type: "start" } // proposed by the scheduler when a slot is free
  | { type: "usage"; usage: Usage }; // running totals, read from transcripts

// `by` is set by the boundary that received the input (the CLI, from the
// caller's identity, or the plugin host), never by the sender. An agent
// cannot claim to be human.
export type Input =
  | ({ by: "human" } & HumanInput)
  | ({ by: "agent" } & AgentInput)
  | ({ by: "plugin" } & PluginInput)
  | ({ by: "system" } & SystemInput);

// The time rides along with every input, so decide never reads the clock.
// For an input that creates a task (add, issue_delegated), taskId is the new
// task's number. The shell picks it, since the core never makes up IDs. A
// delegated issue gets a new Skelcrew number, not the issue's own number.
export type Envelope = {
  taskId: TaskId;
  at: Timestamp;
  input: Input;
};

// ---------------------------------------------------------------------------
// Events: facts, appended to the log after decide accepts an input
// ---------------------------------------------------------------------------
//
// Events are the source of truth. Task state, the inbox and the record are
// all rebuilt from them. So an event must say everything needed to rebuild
// state; anything left out is lost for good.

export type EventBody =
  | {
      type: "task.created";
      title: string;
      project: ProjectId | null;
      source: SourceRef | null;
    }
  | { type: "task.project_changed"; project: ProjectId | null }
  | { type: "task.spec_requested" }
  | { type: "task.spec_session_started"; session: SessionId }
  // `by` shows in the record whether an agent or the developer wrote it.
  | { type: "task.specced"; spec: Spec; by: "agent" | "human" }
  // Covers every way back to Spec except a revert: a spec the developer
  // didn't approve, and a task sent back from a later phase, for example
  // after it was blocked. Both give the spec agent the note to work from.
  | { type: "task.spec_sent_back"; note: string }
  | { type: "task.ready" }
  // The scheduler's start was accepted. What starts depends on the phase:
  // a spec session in Spec, a worktree in Ready, and a new develop session
  // in In progress after a retry.
  //
  // An event that sends a request says which number it used, so evolve
  // records it instead of working it out, and the log shows which reply
  // answers which event.
  | { type: "task.dispatch_started"; request: number }
  | { type: "task.worktree_created"; worktree: Worktree; request: number } // starts the develop agent
  | { type: "task.dispatched"; session: SessionId }
  | { type: "task.question_asked"; question: Question }
  // Answers are kept so past decisions can be searched later, and the spec
  // skill does not ask the same question twice.
  | { type: "task.question_answered"; text: string }
  // Which gate runs next comes from workflow.yml, which evolve never sees.
  // So decide writes it into the event: the first gate when the agent
  // reports done, and the next one after each pass (null after the last).
  // Replay then gives the same task even if workflow.yml changes later.
  | { type: "task.done_reported"; branch: BranchFacts; gate: GateName; request: number }
  | { type: "task.gate_passed"; gate: GateName; next: { gate: GateName; request: number } | null }
  | { type: "task.gate_failed"; failure: Failure }
  | { type: "task.checks_passed" }
  // The files that matched a critical path, so the inbox summary can say
  // why this merge needs approval.
  | { type: "task.merge_approval_requested"; criticalFiles: string[] }
  | { type: "task.merge_sent_back"; note: string }
  | { type: "task.merge_started"; request: number }
  | { type: "task.merge_failed"; failure: Failure }
  | { type: "task.merged"; commit: CommitSha }
  | { type: "task.revert_started"; reason: string; request: number }
  | { type: "task.revert_failed"; summary: string }
  | { type: "task.reverted"; commit: CommitSha; reason: string }
  | { type: "task.blocked"; reason: BlockReason }
  | { type: "task.unblocked" } // resets attempts and the safety cap
  | { type: "task.dropped" }
  | { type: "task.usage_recorded"; usage: Usage };

export type TaskEvent = EventBody & {
  // The log is kept forever, so old events must stay readable after their
  // shape changes. The version says which shape an event was written in.
  v: 1;
  taskId: TaskId;
  at: Timestamp;
};

// Everything in the events table.
export type Event = TaskEvent | ProjectEvent;

// ---------------------------------------------------------------------------
// Commands: work the shell must do, results come back as inputs
// ---------------------------------------------------------------------------
//
// Commands are how the core touches the world without doing it itself.
// decide says "create a worktree"; the shell does it and reports back with
// an input. So every side effect can be faked in tests with a scripted reply.

export type Command =
  // Every command that expects a reply carries a request number, from the
  // task's `requests` counter. The reply must bring it back.
  | { type: "start_spec_session"; taskId: TaskId; request: number; note: string | null }
  | { type: "create_worktree"; taskId: TaskId; request: number; build: number } // build names the branch
  | {
      type: "start_develop_session";
      taskId: TaskId;
      request: number;
      worktree: Worktree;
      spec: Spec;
      brief: Brief;
    }
  | { type: "send_to_session"; session: SessionId; text: string }
  | { type: "stop_session"; session: SessionId }
  | { type: "run_gate"; taskId: TaskId; request: number; gate: GateName; worktree: Worktree }
  // The shell merges one task at a time. It brings the branch up to date
  // with main, runs the local checks again, then squash-merges. It answers
  // with "merged" or "merge_failed".
  //
  // Why in the shell: decide sees one task at a time, so it cannot stop two
  // tasks merging at once. Only the shell sees all merges. Without this
  // step, two tasks that each pass alone could break main together.
  | { type: "merge"; taskId: TaskId; request: number; worktree: Worktree }
  // The shell first commits any uncommitted changes to the worktree's
  // branch, so removing a worktree never loses work.
  | { type: "remove_worktree"; worktree: Worktree }
  | { type: "revert"; taskId: TaskId; request: number; commit: CommitSha };

// ---------------------------------------------------------------------------
// Config: the parts of workflow.yml the core reads
// ---------------------------------------------------------------------------
//
// Passed in as an argument rather than read from disk, so tests can try any
// setting without touching files.

export type Config = {
  gates: GateName[]; // in order; "remote" only when a plugin reports it
  maxAttempts: number; // failed rounds before the task is blocked
  // Counts spec and develop sessions together. Both can ask questions, so
  // both use up the developer's attention. A task past its gates holds no
  // slot: its agent is stopped while the merge waits or runs.
  maxRunning: number;
  specApproval: "always" | "never";
  criticalPaths: string[]; // globs; a match sends the merge to the inbox
  safetyCap: Usage;
};

// ---------------------------------------------------------------------------
// The core functions
// ---------------------------------------------------------------------------

// A rejection is a normal result, not an exception. Errors as values keep
// every failure path visible in the types.
export type Rejection = {
  input: Input["type"] | ProjectInput["type"];
  reason: string; // plain words, shown to whoever sent the input
};

// Either the input is accepted and produces events and commands, or it is
// rejected and nothing changes. There is no partial success.
export type Decision =
  | { ok: true; events: TaskEvent[]; commands: Command[] }
  | { ok: false; rejection: Rejection };

// Result of a contract or policy check. The reasons become inbox text and
// record entries, so they must be readable on their own.
export type Check = { ok: true } | { ok: false; reasons: string[] };

// The only place a task can change. `task` is null before task.created.
// `projects` lets decide reject a task put into a project that does not exist.
export type DecideTask = (
  task: Task | null,
  envelope: Envelope,
  config: Config,
  projects: ReadonlyMap<ProjectId, Project>,
) => Decision;

// Folds one event into state. Replaying all of a task's events through
// evolve, starting from null, must rebuild the task exactly.
//
// Why split decide and evolve: decide holds the rules, evolve only applies
// facts. Replaying the log after a crash runs evolve alone, so old events
// are never re-judged by rules that have since changed.
//
// decide never produces an event that doesn't fit the task. A damaged or
// hand-edited log could, so evolve says which event and why instead of
// guessing. Replay then stops there, rather than rebuilding a wrong task.
export type EvolveTask = (task: Task | null, event: TaskEvent) => EvolvedTask;

export type EvolvedTask = { ok: true; task: Task } | { ok: false; reason: string };

export type ProjectDecision =
  | { ok: true; events: ProjectEvent[] }
  | { ok: false; rejection: Rejection };

// The only place a project can change. `project` is null before it exists.
// Projects have their own small decider because their rules never depend
// on a task's state.
export type DecideProject = (project: Project | null, envelope: ProjectEnvelope) => ProjectDecision;

// Like evolve, it refuses an event that doesn't fit, so replay stops at a
// damaged log instead of rebuilding a wrong project.
export type EvolveProject = (project: Project | null, event: ProjectEvent) => EvolvedProject;

export type EvolvedProject = { ok: true; project: Project } | { ok: false; reason: string };

// Picks which queued tasks in Spec, Ready or In progress to start next. It
// keeps agents at or below maxRunning: those running, and those still
// starting. It skips blocked tasks and tasks in parked projects. It only
// proposes: each pick becomes a "start" input that decide can reject.
//
// `startsInFlight` comes from the daemon: the starts it has sent out
// (start_spec_session, create_worktree, start_develop_session) and not yet
// had answered. The tasks alone can't tell: a task dropped while its agent
// was starting no longer says so, but the agent is still on its way up and
// needs its slot until it reports in and is stopped.
//
// Why separate from decide: choosing what to start next means looking at
// all tasks. decide only ever sees one, which keeps it small enough to read
// in one sitting.
export type Schedule = (
  tasks: Task[],
  projects: ReadonlyMap<ProjectId, Project>,
  config: Config,
  startsInFlight: number,
) => TaskId[];
