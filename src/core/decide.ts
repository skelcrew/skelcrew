// Decide: the only place a task can change. It checks one input against the
// task, the config and the rules, then accepts it with events and commands,
// or rejects it with a reason. It reads nothing else and changes nothing.
//
// `decideTask` below is the outline: each step is one line, in the order the
// rules apply. The steps follow it, then one function per phase, like
// evolve, then small helpers.

import { attemptsLeft, criticalFiles, specComplete, withinSafetyCap } from "./contracts";
import { phaseNames, type TaskIn } from "./phases";
import type {
  Command,
  Config,
  DecideTask,
  Decision,
  Envelope,
  EventBody,
  Failure,
  Input,
  Project,
  ProjectId,
  SessionId,
  Spec,
  Task,
  Timestamp,
  Usage,
  Worktree,
} from "./types";

// What every step needs besides the task and the input.
type Context = {
  accept: (bodies: EventBody[], commands?: Command[]) => Decision;
  reject: (reason: string) => Decision;
  at: Timestamp;
  config: Config;
  projects: ReadonlyMap<ProjectId, Project>;
};

export const decideTask: DecideTask = (task, envelope, config, projects) => {
  const ctx = makeContext(envelope, config, projects);
  const { input } = envelope;

  if (input.type === "add" || input.type === "issue_delegated") return create(task, input, ctx);
  if (task === null) return ctx.reject(`#${envelope.taskId} doesn't exist.`);

  const cleanup = lateReply(task, input, ctx);
  if (cleanup !== null) return cleanup;
  if (task.phase === "dropped") return ctx.reject(`#${task.id} was dropped.`);

  if (worksInAnyPhase(input)) return inAnyPhase(task, input, ctx);

  switch (task.phase) {
    case "idea":
      return inIdea(task, input, ctx);
    case "spec":
      return inSpec(task, input, ctx);
    case "ready":
      return inReady(task, input, ctx);
    case "in_progress":
      return inProgress(task, input, ctx);
    case "checks":
      return inChecks(task, input, ctx);
    case "done":
      return inDone(task, input, ctx);
  }
};

function makeContext(
  envelope: Envelope,
  config: Config,
  projects: ReadonlyMap<ProjectId, Project>,
): Context {
  const { taskId, at, input } = envelope;
  return {
    accept: (bodies, commands = []) => ({
      ok: true,
      events: bodies.map((body) => ({ ...body, v: 1, taskId, at })),
      commands,
    }),
    reject: (reason) => ({ ok: false, rejection: { input: input.type, reason } }),
    at,
    config,
    projects,
  };
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

// A delegated issue counts as asking for a spec, as `add --spec` does.
function create(
  task: Task | null,
  input: Input & { type: "add" | "issue_delegated" },
  ctx: Context,
): Decision {
  if (task !== null) return ctx.reject(`#${task.id} already exists.`);
  if (isBlank(input.title)) return ctx.reject("A task needs a title.");
  const missing = unknownProject(input.project, ctx);
  if (missing) return ctx.reject(missing);
  const created: EventBody = {
    type: "task.created",
    title: input.title,
    project: input.project,
    source: input.type === "issue_delegated" ? input.source : null,
  };
  const asksForSpec = input.type === "issue_delegated" || input.requestSpec;
  return ctx.accept(asksForSpec ? [created, { type: "task.spec_requested" }] : [created]);
}

// A reply the task isn't waiting for, for example a worktree that finished
// after the task was dropped. It is cleaned up and nothing is recorded, so
// no worktree or agent is left behind (invariant 13). Null if the task is
// waiting for it.
function lateReply(task: Task, input: Input, ctx: Context): Decision | null {
  if (input.type === "worktree_created" && !waitingForWorktree(task)) {
    return ctx.accept([], [removeWorktree(input.worktree)]);
  }
  if (input.type === "session_started" && !waitingForAgent(task)) {
    return ctx.accept([], [stopSession(input.session)]);
  }
  return null;
}

const anyPhaseInputs = [
  "request_spec",
  "retry",
  "external_move",
  "change_project",
  "drop",
  "send_back_to_spec",
  "ask",
  "answer",
  "usage",
] as const;

type AnyPhaseInput = Extract<Input, { type: (typeof anyPhaseInputs)[number] }>;

// Inputs whose rules don't depend on the phase, or that span several phases.
function worksInAnyPhase(input: Input): input is AnyPhaseInput {
  return anyPhaseInputs.some((type) => type === input.type);
}

function inAnyPhase(task: Task, input: AnyPhaseInput, ctx: Context): Decision {
  const { accept, reject } = ctx;

  switch (input.type) {
    case "request_spec":
      if (task.phase !== "idea") {
        return reject(`#${task.id} is in ${phaseNames[task.phase]}. Only an Idea can be specced.`);
      }
      return accept([{ type: "task.spec_requested" }]);

    // Retry only clears the block. The scheduler then starts the task when a
    // slot is free, so a retry never goes past max_running.
    case "retry":
      if (task.blocked === null) return reject(`#${task.id} isn't blocked.`);
      return accept([{ type: "task.unblocked" }]);

    // Moves in other tools are requests, never obeyed (invariant 3).
    case "external_move":
      return reject(
        `Tasks only move through Skelcrew. The move to ${input.to} in the other tool was ignored.`,
      );

    // A Done task only takes a revert (invariant 17).
    case "change_project": {
      if (task.phase === "done") return wrongPhase(task, input, ctx);
      const missing = unknownProject(input.project, ctx);
      if (missing) return reject(missing);
      return accept([{ type: "task.project_changed", project: input.project }]);
    }

    // Leaving for good stops the agent and removes the worktree, whatever
    // the task holds. A merge already under way is left to finish.
    case "drop": {
      if (task.phase === "done") return reject(`#${task.id} is done. Use revert to undo it.`);
      const merging = stillMerging(task);
      if (merging) return reject(merging);
      return accept([{ type: "task.dropped" }], leavePhase(task));
    }

    // The spec is kept and redone with your note. The next build starts on
    // a fresh branch; the shell saves any uncommitted work first.
    case "send_back_to_spec": {
      if (task.phase !== "ready" && task.phase !== "in_progress" && task.phase !== "checks") {
        return reject(
          `#${task.id} is in ${phaseNames[task.phase]}. Only a task past Spec can be sent back to it.`,
        );
      }
      const merging = stillMerging(task);
      if (merging) return reject(merging);
      if (isBlank(input.note)) return reject("A send-back needs a note.");
      return accept([{ type: "task.spec_sent_back", note: input.note }], leavePhase(task));
    }

    // One open question at a time, from the agent that is running.
    case "ask": {
      const from = agentKind(task);
      if (from === null) return reject(`#${task.id} has no agent running.`);
      if (task.question !== null) return reject(`#${task.id} already has an open question.`);
      if (input.options.length < 2 || input.options.length > 4) {
        return reject("A question needs two to four options.");
      }
      const question = { from, text: input.text, options: input.options, askedAt: ctx.at };
      return accept([{ type: "task.question_asked", question }]);
    }

    case "answer": {
      if (task.question === null) return reject(`#${task.id} has no open question.`);
      if (isBlank(input.text)) return reject("An answer needs text.");
      const session = runningSession(task);
      if (session === null) return reject(`#${task.id} has no agent running.`);
      return accept(
        [{ type: "task.question_answered", text: input.text }],
        [{ type: "send_to_session", session, text: input.text }],
      );
    }

    // The safety cap counts from the last retry. It blocks while an agent is
    // running or starting. With no agent under way, the report is only
    // recorded, and start checks the cap before the next agent runs.
    case "usage": {
      const recorded: EventBody = { type: "task.usage_recorded", usage: input.usage };
      if (task.blocked !== null || !agentUnderWay(task)) return accept([recorded]);
      const block = safetyCapBlock(task, input.usage, ctx);
      if (block === null) return accept([recorded]);
      return accept([recorded, block], stopForBlock(task));
    }
  }
}

// ---------------------------------------------------------------------------
// The phases
// ---------------------------------------------------------------------------

function inIdea(task: TaskIn<"idea">, input: Input, ctx: Context): Decision {
  switch (input.type) {
    case "provide_spec":
      return acceptSpec(input.spec, "human", ctx, [{ type: "task.spec_requested" }]);

    default:
      return wrongPhase(task, input, ctx);
  }
}

function inSpec(task: TaskIn<"spec">, input: Input, ctx: Context): Decision {
  const { accept, reject } = ctx;
  const { step } = task;

  switch (input.type) {
    case "start": {
      const refused = cantStart(task, ctx);
      if (refused) return reject(refused);
      const capped = safetyCapBlock(task, task.usage, ctx);
      if (capped) return accept([capped]);
      return accept(
        [{ type: "task.dispatch_started" }],
        [{ type: "start_spec_session", taskId: task.id, note: task.note }],
      );
    }

    case "session_started":
      return accept([{ type: "task.spec_session_started", session: input.session }]);

    // The agent failed to start, or crashed while running.
    case "session_failed":
      if (step.kind !== "starting" && step.kind !== "running") {
        return reject(`#${task.id} has no spec agent.`);
      }
      return accept([blocked("session_failed", input.message)]);

    // A spec submitted before your answer would ignore it.
    case "submit_spec":
      if (step.kind !== "running") return reject(`#${task.id} has no spec agent running.`);
      if (task.question !== null) {
        return reject(`#${task.id} has an open question. Wait for the answer.`);
      }
      return acceptSpec(input.spec, "agent", ctx, [], [stopSession(step.session)]);

    // Your spec replaces the agent's work, so a running agent is stopped.
    case "provide_spec": {
      const stop = step.kind === "running" ? [stopSession(step.session)] : [];
      return acceptSpec(input.spec, "human", ctx, [], stop);
    }

    case "approve_spec":
      if (step.kind !== "awaiting_approval") {
        return reject(`#${task.id}'s spec isn't waiting for approval.`);
      }
      return accept([{ type: "task.ready" }]);

    // The note tells the spec agent what to change.
    case "send_back_spec":
      if (step.kind !== "awaiting_approval") {
        return reject(`#${task.id}'s spec isn't waiting for approval.`);
      }
      if (isBlank(input.note)) return reject("A send-back needs a note.");
      return accept([{ type: "task.spec_sent_back", note: input.note }]);

    default:
      return wrongPhase(task, input, ctx);
  }
}

function inReady(task: TaskIn<"ready">, input: Input, ctx: Context): Decision {
  const { accept, reject } = ctx;
  const { step } = task;

  switch (input.type) {
    // Each start is a new build, and the build number names its branch.
    case "start": {
      const refused = cantStart(task, ctx);
      if (refused) return reject(refused);
      const capped = safetyCapBlock(task, task.usage, ctx);
      if (capped) return accept([capped]);
      return accept(
        [{ type: "task.dispatch_started" }],
        [{ type: "create_worktree", taskId: task.id, build: task.builds + 1 }],
      );
    }

    case "worktree_created":
      return accept(
        [{ type: "task.worktree_created", worktree: input.worktree }],
        [startDevelop(task, input.worktree, null)],
      );

    case "worktree_failed":
      if (step.kind !== "creating_worktree") {
        return reject(`#${task.id} isn't creating a worktree.`);
      }
      return accept([blocked("worktree_failed", input.message)]);

    case "session_started":
      return accept([{ type: "task.dispatched", session: input.session }]);

    // A blocked task waits without a worktree, so the unused one is removed.
    // The agent never ran, so no work is lost.
    case "session_failed":
      if (step.kind !== "starting_session") {
        return reject(`#${task.id} isn't starting a develop agent.`);
      }
      return accept([blocked("session_failed", input.message)], [removeWorktree(step.worktree)]);

    default:
      return wrongPhase(task, input, ctx);
  }
}

function inProgress(task: TaskIn<"in_progress">, input: Input, ctx: Context): Decision {
  const { accept, reject, config } = ctx;
  const { step, worktree } = task;

  switch (input.type) {
    // After a retry: a new agent in the same worktree, told what failed last.
    case "start": {
      const refused = cantStart(task, ctx);
      if (refused) return reject(refused);
      const capped = safetyCapBlock(task, task.usage, ctx);
      if (capped) return accept([capped]);
      return accept(
        [{ type: "task.dispatch_started" }],
        [startDevelop(task, worktree, task.lastFailure)],
      );
    }

    case "session_started":
      return accept([{ type: "task.dispatched", session: input.session }]);

    // The agent failed to start, or crashed while running. The worktree
    // stays, so a retry carries on with the same code.
    case "session_failed":
      if (step.kind !== "starting" && step.kind !== "running") {
        return reject(`#${task.id} has no develop agent.`);
      }
      return accept([blocked("session_failed", input.message)]);

    // The agent stays open during Checks, so a failed gate goes straight
    // back to the agent that wrote the code.
    case "report_done": {
      if (step.kind !== "running") return reject(`#${task.id} has no develop agent running.`);
      if (input.branch.commits === 0) return reject("The branch has no commits.");
      const gate = config.gates[0];
      if (gate === undefined) return reject("workflow.yml has no gates.");
      return accept(
        [{ type: "task.done_reported", branch: input.branch, gate }],
        [{ type: "run_gate", taskId: task.id, gate, worktree }],
      );
    }

    case "give_up":
      if (step.kind !== "running") return reject(`#${task.id} has no develop agent running.`);
      return accept([blocked("agent_gave_up", input.message)], [stopSession(step.session)]);

    default:
      return wrongPhase(task, input, ctx);
  }
}

function inChecks(task: TaskIn<"checks">, input: Input, ctx: Context): Decision {
  const { accept, reject, config } = ctx;
  const merge: Command = { type: "merge", taskId: task.id, worktree: task.worktree };

  switch (input.type) {
    case "gate_result": {
      if (task.step !== input.gate) {
        const running =
          task.step === "merge_approval" || task.step === "merging"
            ? "isn't running a gate"
            : `is running the ${task.step} gate, not ${input.gate}`;
        return reject(`#${task.id} ${running}.`);
      }

      if (!input.ok) {
        const failure: Failure = { step: input.gate, summary: input.summary };
        return failedRound(task, { type: "task.gate_failed", failure }, failure, ctx);
      }

      const next = config.gates[config.gates.indexOf(input.gate) + 1] ?? null;
      const passed: EventBody = { type: "task.gate_passed", gate: input.gate, next };
      if (next !== null) {
        return accept(
          [passed],
          [{ type: "run_gate", taskId: task.id, gate: next, worktree: task.worktree }],
        );
      }

      // The last gate passed. A merge that touches a critical path waits
      // for your approval. Anything else merges now.
      const critical = criticalFiles(task.branch, config.criticalPaths);
      if (critical.length > 0) {
        return accept([
          passed,
          { type: "task.checks_passed" },
          { type: "task.merge_approval_requested", criticalFiles: critical },
        ]);
      }
      return accept(
        [passed, { type: "task.checks_passed" }, { type: "task.merge_started" }],
        [merge],
      );
    }

    case "approve_merge":
      if (task.step !== "merge_approval") {
        return reject(`#${task.id}'s merge isn't waiting for approval.`);
      }
      return accept([{ type: "task.merge_started" }], [merge]);

    // Your note goes to the agent that wrote the code. It isn't a failure,
    // so no attempt is used.
    case "send_back_merge":
      if (task.step !== "merge_approval") {
        return reject(`#${task.id}'s merge isn't waiting for approval.`);
      }
      if (isBlank(input.note)) return reject("A send-back needs a note.");
      return accept(
        [{ type: "task.merge_sent_back", note: input.note }],
        [{ type: "send_to_session", session: task.session, text: input.note }],
      );

    // The branch is now squashed into main, so removing the worktree loses
    // nothing.
    case "merged":
      if (task.step !== "merging") return reject(`#${task.id} isn't merging.`);
      return accept(
        [{ type: "task.merged", commit: input.commit }],
        [stopSession(task.session), removeWorktree(task.worktree)],
      );

    // The agent crashed. A merge under way doesn't need it, so it carries
    // on. Otherwise the task is blocked, keeping its worktree.
    case "session_failed":
      if (task.step === "merging") return accept([]);
      return accept([blocked("session_failed", input.message)]);

    // A failed merge counts as an attempt, like a failed gate.
    case "merge_failed": {
      if (task.step !== "merging") return reject(`#${task.id} isn't merging.`);
      const failure: Failure = { step: "merge", summary: input.summary };
      return failedRound(task, { type: "task.merge_failed", failure }, failure, ctx);
    }

    default:
      return wrongPhase(task, input, ctx);
  }
}

// The reason becomes the note for the redone spec. The shell reverts the
// merge commit on main.
function inDone(task: TaskIn<"done">, input: Input, ctx: Context): Decision {
  switch (input.type) {
    case "revert":
      if (isBlank(input.reason)) return ctx.reject("A revert needs a reason.");
      return ctx.accept(
        [{ type: "task.reverted", commit: task.mergeCommit, reason: input.reason }],
        [{ type: "revert", taskId: task.id, commit: task.mergeCommit }],
      );
    default:
      return wrongPhase(task, input, ctx);
  }
}

// ---------------------------------------------------------------------------
// Rules shared between phases
// ---------------------------------------------------------------------------

// A spec must pass the spec contract to be stored. An agent's spec then
// waits for your approval, unless spec_approval is never. A spec you wrote
// yourself counts as approved, since you are the one who approves.
function acceptSpec(
  spec: Spec,
  by: "agent" | "human",
  ctx: Context,
  before: EventBody[],
  commands: Command[] = [],
): Decision {
  const check = specComplete(spec);
  if (!check.ok) return ctx.reject(check.reasons.join(" "));
  const approved = by === "human" || ctx.config.specApproval === "never";
  const specced: EventBody = { type: "task.specced", spec, by };
  return ctx.accept(
    approved ? [...before, specced, { type: "task.ready" }] : [...before, specced],
    commands,
  );
}

// Why the scheduler's start is refused, or null if the task may start. The
// scheduler should never ask for these, but decide keeps the final say.
function cantStart(task: TaskIn<"spec" | "ready" | "in_progress">, ctx: Context): string | null {
  if (task.blocked !== null) return `#${task.id} is blocked.`;
  if (task.project !== null && ctx.projects.get(task.project)?.status === "parked") {
    return `#${task.id} is in a parked project.`;
  }
  if (task.step.kind !== "queued") return `#${task.id} isn't waiting for a slot.`;
  return null;
}

// The block for a task at or over its safety cap since the last retry, or
// null if it is within it.
function safetyCapBlock(task: Task, usage: Usage, ctx: Context): EventBody | null {
  if (withinSafetyCap(usage, task.usageAtRetry, ctx.config.safetyCap).ok) return null;
  const used = {
    tokens: usage.tokens - task.usageAtRetry.tokens,
    ms: usage.ms - task.usageAtRetry.ms,
  };
  return { type: "task.blocked", reason: { kind: "safety_cap", usage: used } };
}

// What blocking stops: a running agent, and in Ready, the worktree made for
// an agent that is still starting, since a blocked task there can't hold
// one. Anything still being created is cleaned up by its late reply.
function stopForBlock(task: Task): Command[] {
  const commands: Command[] = [];
  const session = runningSession(task);
  if (session !== null) commands.push(stopSession(session));
  if (task.phase === "ready" && task.step.kind === "starting_session") {
    commands.push(removeWorktree(task.step.worktree));
  }
  return commands;
}

// A failed gate or merge. The same agent gets the failure while attempts
// remain. After the last one, the task is blocked and the agent stopped.
// The worktree stays, so a retry carries on with the same code.
function failedRound(
  task: TaskIn<"checks">,
  failed: EventBody,
  failure: Failure,
  ctx: Context,
): Decision {
  if (attemptsLeft(task.attempts + 1, ctx.config.maxAttempts).ok) {
    const what = failure.step === "merge" ? "The merge" : `The ${failure.step} gate`;
    const text = `${what} failed: ${failure.summary}`;
    return ctx.accept([failed], [{ type: "send_to_session", session: task.session, text }]);
  }
  return ctx.accept(
    [failed, { type: "task.blocked", reason: { kind: "out_of_attempts", failure } }],
    [stopSession(task.session)],
  );
}

// The commands that stop the task's agent and remove its worktree, for a
// task leaving its phase for good. A worktree or agent still being created
// is cleaned up when its late reply arrives.
function leavePhase(task: Task): Command[] {
  const commands: Command[] = [];
  const session = runningSession(task);
  if (session !== null) commands.push(stopSession(session));
  if (task.phase === "ready" && task.step.kind === "starting_session") {
    commands.push(removeWorktree(task.step.worktree));
  }
  if (task.phase === "in_progress" || task.phase === "checks") {
    commands.push(removeWorktree(task.worktree));
  }
  return commands;
}

// Why a task can't leave while merging, or null if it isn't merging.
function stillMerging(task: Task): string | null {
  if (task.phase === "checks" && task.step === "merging") {
    return `#${task.id} is merging. Wait until the merge finishes.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading the task
// ---------------------------------------------------------------------------

// The session of the task's running agent, or null if none is running. In
// Checks the develop agent stays open, so it counts as running.
function runningSession(task: Task): SessionId | null {
  switch (task.phase) {
    case "spec":
    case "in_progress":
      return task.step.kind === "running" ? task.step.session : null;
    case "checks":
      return task.session;
    default:
      return null;
  }
}

// Which agent a question would come from, or null if none is running.
function agentKind(task: Task): "spec" | "develop" | null {
  if (runningSession(task) === null) return null;
  return task.phase === "spec" ? "spec" : "develop";
}

// An agent running or starting, or a worktree being created for one.
function agentUnderWay(task: Task): boolean {
  return runningSession(task) !== null || waitingForAgent(task) || waitingForWorktree(task);
}

function waitingForWorktree(task: Task): boolean {
  return task.phase === "ready" && task.step.kind === "creating_worktree";
}

function waitingForAgent(task: Task): boolean {
  switch (task.phase) {
    case "spec":
    case "in_progress":
      return task.step.kind === "starting";
    case "ready":
      return task.step.kind === "starting_session";
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Small builders and checks
// ---------------------------------------------------------------------------

function blocked(
  kind: "session_failed" | "worktree_failed" | "agent_gave_up",
  message: string,
): EventBody {
  return { type: "task.blocked", reason: { kind, message } };
}

function stopSession(session: SessionId): Command {
  return { type: "stop_session", session };
}

function removeWorktree(worktree: Worktree): Command {
  return { type: "remove_worktree", worktree };
}

function startDevelop(
  task: TaskIn<"ready" | "in_progress">,
  worktree: Worktree,
  lastFailure: Failure | null,
): Command {
  return { type: "start_develop_session", taskId: task.id, worktree, spec: task.spec, lastFailure };
}

// Why a project can't be used, or null if it exists (or is none).
function unknownProject(project: ProjectId | null, ctx: Context): string | null {
  if (project !== null && !ctx.projects.has(project)) {
    return `There is no project called ${project}.`;
  }
  return null;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

function wrongPhase(task: Task, input: Input, ctx: Context): Decision {
  return ctx.reject(`${input.type} doesn't apply to #${task.id} in ${phaseNames[task.phase]}.`);
}
