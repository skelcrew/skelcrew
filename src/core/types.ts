// Core types for Skelcrew. Draft 3.
//
// Everything here is plain data. The core never reads the clock, the disk or
// the network: time and IDs arrive inside inputs, and all side effects leave
// as commands.

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

export type TaskId = string;
export type ProjectId = string; // a short slug, e.g. "inbox"
export type SessionId = string;
export type CommitSha = string;
export type Timestamp = number; // milliseconds since epoch, passed in

export type Phase =
  | "idea"
  | "spec"
  | "ready"
  | "in_progress"
  | "checks"
  | "done"
  | "dropped";

export type GateName = "local" | "remote" | "review";

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

export type Spec = {
  scope: string;
  acceptance: string[];
  openQuestions: string[];
};

export type Question = {
  from: "spec" | "develop";
  text: string;
  options: string[]; // two to four; free text is always allowed
  askedAt: Timestamp;
};

export type BlockReason =
  | { kind: "gates_failed"; failure: Failure }
  | { kind: "safety_cap"; usage: Usage }
  | { kind: "agent_gave_up"; message: string }
  | { kind: "worktree_failed"; message: string }
  | { kind: "session_failed"; message: string };

// A failed gate, or a failed merge: the branch no longer passes the local
// checks once brought up to date with main, or it conflicts with main.
export type Failure = {
  step: GateName | "merge";
  summary: string; // short, becomes feedback to the agent and inbox text
};

export type Usage = {
  tokens: number;
  ms: number;
};

export type Worktree = {
  path: string;
  branch: string;
};

// Facts about the task's branch, gathered by the shell from git.
export type BranchFacts = {
  commits: number;
  changedFiles: string[];
};

// Data that only exists in some phases. Each phase carries exactly what it
// needs, so impossible combinations (a Done task with no merge commit, a
// task in Checks with no worktree) cannot be written down.
export type PhaseState =
  | { phase: "idea" }
  | {
      phase: "spec";
      spec: Spec | null; // the previous spec when it is being redone
      note: string | null; // why it is being redone: send-back or revert
      step: SpecStep;
    }
  | { phase: "ready"; spec: Spec; step: ReadyStep }
  | {
      phase: "in_progress";
      spec: Spec;
      worktree: Worktree;
      session: SessionId;
      attempts: number; // failed gate or merge rounds since the last retry
      lastFailure: Failure | null;
    }
  | {
      phase: "checks";
      spec: Spec;
      worktree: Worktree;
      session: SessionId;
      attempts: number;
      branch: BranchFacts;
      step: GateName | "merge_approval" | "merging";
    }
  | { phase: "done"; spec: Spec; mergeCommit: CommitSha }
  | { phase: "dropped" };

// Spec and Ready both wait for a free slot before an agent starts.
export type SpecStep =
  | { kind: "queued" }
  | { kind: "starting" }
  | { kind: "running"; session: SessionId }
  | { kind: "awaiting_approval" };

export type ReadyStep =
  | { kind: "queued" }
  | { kind: "creating_worktree" }
  | { kind: "starting_session"; worktree: Worktree };

export type Task = PhaseState & {
  id: TaskId;
  title: string;
  project: ProjectId | null;
  createdAt: Timestamp;
  question: Question | null; // at most one open question per task
  blocked: BlockReason | null; // Blocked is a flag on top of the phase
  usage: Usage; // all-time totals, for the record
  usageAtRetry: Usage; // the safety cap counts from here
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

// A named group of tasks, one level deep. Parked projects keep their tasks
// but the scheduler starts no new agents for them.
export type Project = {
  id: ProjectId;
  name: string;
  goal: string; // one line
  status: "active" | "parked";
  createdAt: Timestamp;
};

// Only the developer changes projects.
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
// Inputs are grouped by who can send them. The MCP server can only build an
// AgentInput, so an agent has no way to express "approve this spec".

export type HumanInput =
  | {
      type: "add";
      id: TaskId;
      title: string;
      project: ProjectId | null;
      spec: boolean;
    }
  | { type: "assign"; project: ProjectId | null }
  | { type: "request_spec" }
  | { type: "provide_spec"; spec: Spec } // a spec written by hand
  | { type: "approve_spec" }
  | { type: "send_back_spec"; note: string }
  | { type: "answer"; text: string }
  | { type: "approve_merge" }
  | { type: "send_back_merge"; note: string }
  | { type: "retry" }
  | { type: "send_back_to_spec"; note: string }
  | { type: "drop" }
  | { type: "revert"; reason: string };

export type AgentInput =
  | { type: "submit_spec"; spec: Spec }
  | { type: "ask"; text: string; options: string[] }
  | { type: "report_done"; branch: BranchFacts } // shell attaches git facts
  | { type: "give_up"; message: string };

export type PluginInput =
  | {
      type: "issue_delegated";
      id: TaskId;
      title: string;
      project: ProjectId | null; // mapped from e.g. a GitHub milestone
    }
  | { type: "external_move"; to: string } // e.g. issue dragged to Done
  | { type: "worktree_created"; worktree: Worktree }
  | { type: "worktree_failed"; message: string }
  | { type: "session_started"; session: SessionId }
  | { type: "session_failed"; message: string }
  | { type: "gate_result"; gate: GateName; ok: boolean; summary: string }
  | { type: "merged"; commit: CommitSha }
  | { type: "merge_failed"; summary: string };

export type SystemInput =
  | { type: "start" } // proposed by the scheduler when a slot is free
  | { type: "usage"; usage: Usage }; // running totals for this task

export type Input =
  | ({ by: "human" } & HumanInput)
  | ({ by: "agent" } & AgentInput)
  | ({ by: "plugin" } & PluginInput)
  | ({ by: "system" } & SystemInput);

export type Envelope = {
  taskId: TaskId;
  at: Timestamp;
  input: Input;
};

// ---------------------------------------------------------------------------
// Events: facts, appended to the log after decide accepts an input
// ---------------------------------------------------------------------------

export type EventBody =
  | { type: "task.created"; title: string; project: ProjectId | null }
  | { type: "task.assigned"; project: ProjectId | null }
  | { type: "task.spec_requested" }
  | { type: "task.spec_session_started"; session: SessionId }
  | { type: "task.specced"; spec: Spec; by: "agent" | "human" }
  | { type: "task.spec_sent_back"; note: string }
  | { type: "task.ready" }
  | { type: "task.dispatch_started" }
  | { type: "task.worktree_created"; worktree: Worktree }
  | { type: "task.dispatched"; session: SessionId }
  | { type: "task.question_asked"; question: Question }
  | { type: "task.question_answered"; text: string }
  | { type: "task.done_reported"; branch: BranchFacts }
  | { type: "task.gate_passed"; gate: GateName }
  | { type: "task.gate_failed"; failure: Failure }
  | { type: "task.checks_passed" }
  | { type: "task.escalated"; criticalFiles: string[] }
  | { type: "task.merge_sent_back"; note: string }
  | { type: "task.merge_started" }
  | { type: "task.merge_failed"; failure: Failure }
  | { type: "task.merged"; commit: CommitSha }
  | { type: "task.reverted"; commit: CommitSha; reason: string }
  | { type: "task.blocked"; reason: BlockReason }
  | { type: "task.unblocked" } // resets attempts and the safety cap
  | { type: "task.dropped" }
  | { type: "task.usage_recorded"; usage: Usage };

export type TaskEvent = EventBody & {
  v: 1; // schema version, bumped when an event's shape changes
  taskId: TaskId;
  at: Timestamp;
};

// Everything in the events table.
export type Event = TaskEvent | ProjectEvent;

// ---------------------------------------------------------------------------
// Commands: work the shell must do, results come back as inputs
// ---------------------------------------------------------------------------

export type Command =
  | { type: "start_spec_session"; taskId: TaskId; note: string | null }
  | { type: "create_worktree"; taskId: TaskId }
  | {
      type: "start_develop_session";
      taskId: TaskId;
      worktree: Worktree;
      spec: Spec;
    }
  | { type: "send_to_session"; session: SessionId; text: string }
  | { type: "stop_session"; session: SessionId }
  | { type: "run_gate"; taskId: TaskId; gate: GateName; worktree: Worktree }
  // The shell merges one task at a time. It brings the branch up to date
  // with main, runs the local checks again, then squash-merges. It answers
  // with "merged" or "merge_failed".
  | { type: "merge"; taskId: TaskId; worktree: Worktree }
  | { type: "remove_worktree"; worktree: Worktree }
  | { type: "revert"; taskId: TaskId; commit: CommitSha };

// ---------------------------------------------------------------------------
// Config: the parts of workflow.yml the core reads
// ---------------------------------------------------------------------------

export type Config = {
  gates: GateName[]; // in order; "remote" only when a plugin reports it
  maxAttempts: number;
  maxRunning: number; // spec and develop sessions at once
  specApproval: "always" | "never";
  criticalPaths: string[]; // globs
  safetyCap: Usage;
};

// ---------------------------------------------------------------------------
// The core functions
// ---------------------------------------------------------------------------

export type Rejection = {
  input: Input["type"] | ProjectInput["type"];
  reason: string; // plain words, shown to whoever sent the input
};

export type Decision =
  | { ok: true; events: TaskEvent[]; commands: Command[] }
  | { ok: false; rejection: Rejection };

export type Check = { ok: true } | { ok: false; reasons: string[] };

// The only place a task can change. `task` is null before task.created.
// `projects` lets decide reject a task put into a project that does not exist.
export type Decide = (
  task: Task | null,
  envelope: Envelope,
  config: Config,
  projects: ReadonlyMap<ProjectId, Project>,
) => Decision;

// Folds one event into state. Replaying all of a task's events through
// evolve, starting from null, must rebuild the task exactly.
export type Evolve = (task: Task | null, event: TaskEvent) => Task;

export type ProjectDecision =
  | { ok: true; events: ProjectEvent[] }
  | { ok: false; rejection: Rejection };

// The only place a project can change. `project` is null before it exists.
export type DecideProject = (
  project: Project | null,
  envelope: ProjectEnvelope,
) => ProjectDecision;

export type EvolveProject = (
  project: Project | null,
  event: ProjectEvent,
) => Project;

// Picks which queued tasks in Spec or Ready to start next. It keeps running
// sessions at or below maxRunning, and skips tasks in parked projects. It
// only proposes: each pick becomes a "start" input that decide can reject.
export type Schedule = (
  tasks: Task[],
  projects: ReadonlyMap<ProjectId, Project>,
  config: Config,
) => TaskId[];
