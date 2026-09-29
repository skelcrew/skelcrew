// Evolve: folds one event into a task. It only applies facts that decide
// already accepted, so it holds no rules of its own. Replaying a task's
// events through it, starting from null, rebuilds the task exactly.
//
// Events that can happen in any phase come first. The rest are grouped by
// the phase they apply in, one function per phase, in lifecycle order.

import { phaseNames, type TaskIn } from "./task";
import type { Brief, EvolvedTask, EvolveTask, Failure, Spec, Task, TaskEvent } from "./types";

const noUsage = { tokens: 0, ms: 0 };
const noBrief: Brief = { failure: null, note: null, blocked: null };

export const evolveTask: EvolveTask = (task, event) => {
  if (event.type === "task.created") {
    if (task !== null) return refuse(event, `#${event.taskId} already exists`);
    return ok({
      phase: "idea",
      id: event.taskId,
      title: event.title,
      project: event.project,
      source: event.source,
      createdAt: event.at,
      question: null,
      blocked: null,
      builds: 0,
      requests: 0,
      usage: noUsage,
      usageAtRetry: noUsage,
    });
  }
  if (task === null) return refuse(event, `#${event.taskId} doesn't exist`);
  // Dropped is final.
  if (task.phase === "dropped") return wrongPhase(event, task);

  switch (event.type) {
    case "task.question_asked": {
      if (task.question !== null) return refuse(event, `#${task.id} already has an open question`);
      const { from } = event.question;
      const fits =
        from === "spec"
          ? task.phase === "spec"
          : task.phase === "in_progress" || task.phase === "checks";
      if (!fits) {
        return refuse(event, `a ${from} question can't be open in ${phaseNames[task.phase]}`);
      }
      return ok({ ...task, question: event.question });
    }

    case "task.question_answered":
      if (task.question === null) return refuse(event, `#${task.id} has no open question`);
      return ok({ ...task, question: null });

    // Blocking stops the agent, so its question is cleared too: there is no
    // one left to answer. A task blocked in Checks goes back to In progress,
    // keeping its worktree, so a retry carries on with the same code.
    case "task.blocked": {
      if (task.blocked !== null) return refuse(event, `#${task.id} is already blocked`);
      const stopped = stopAgent(task);
      if (stopped === null) return wrongPhase(event, task);
      return ok({ ...stopped, blocked: event.reason, question: null });
    }

    // A retry starts fresh: no failed attempts, and the safety cap counts
    // from the usage so far. The reason for the block is kept, so the next
    // develop agent knows why the last one stopped.
    case "task.unblocked": {
      if (task.blocked === null) return refuse(event, `#${task.id} isn't blocked`);
      const cleared = { ...task, blocked: null, usageAtRetry: task.usage };
      return ok(
        cleared.phase === "in_progress"
          ? { ...cleared, attempts: 0, brief: { ...cleared.brief, blocked: task.blocked } }
          : cleared,
      );
    }

    case "task.usage_recorded":
      return ok({ ...task, usage: event.usage });

    case "task.project_changed":
      return ok({ ...task, project: event.project });

    // A Done task only changes through a revert.
    case "task.dropped":
      if (task.phase === "done") return wrongPhase(event, task);
      return ok({ ...shared(task), phase: "dropped" });
  }

  switch (task.phase) {
    case "idea":
      return inIdea(task, event);
    case "spec":
      return inSpec(task, event);
    case "ready":
      return inReady(task, event);
    case "in_progress":
      return inProgress(task, event);
    case "checks":
      return inChecks(task, event);
    case "done":
      return inDone(task, event);
  }
};

function inIdea(task: TaskIn<"idea">, event: TaskEvent): EvolvedTask {
  switch (event.type) {
    case "task.spec_requested":
      return ok({ ...task, phase: "spec", spec: null, note: null, step: { kind: "queued" } });
    default:
      return wrongPhase(event, task);
  }
}

function inSpec(task: TaskIn<"spec">, event: TaskEvent): EvolvedTask {
  switch (event.type) {
    case "task.dispatch_started":
      return ok(withRequest(task, event.request, { kind: "starting", request: event.request }));

    case "task.spec_session_started":
    case "task.claimed":
      return ok({ ...task, step: { kind: "running", session: event.session } });

    // The spec agent is stopped once a spec is stored, so a question it
    // left open could never be answered.
    case "task.specced":
      return ok({
        ...task,
        spec: event.spec,
        note: null,
        step: { kind: "awaiting_approval" },
        question: null,
      });

    // The old spec is kept, so the agent revises it with the note instead
    // of starting over.
    case "task.spec_sent_back":
      return ok({
        ...task,
        note: event.note,
        step: { kind: "queued" },
        question: null,
        blocked: null,
      });

    case "task.ready": {
      if (task.spec === null) return refuse(event, `#${task.id} has no spec`);
      return ok({ ...base(task), phase: "ready", spec: task.spec, step: { kind: "queued" } });
    }

    default:
      return wrongPhase(event, task);
  }
}

function inReady(task: TaskIn<"ready">, event: TaskEvent): EvolvedTask {
  switch (event.type) {
    // Each start is a new build with its own branch. The count goes up
    // before the worktree exists, so a failed try never reuses it.
    case "task.dispatch_started":
      return ok({
        ...withRequest(task, event.request, {
          kind: "creating_worktree",
          request: event.request,
          claimedBy: null,
        }),
        builds: task.builds + 1,
      });

    // A claim is a new build too. Your session waits for its worktree.
    case "task.claimed":
      if (event.request === null) {
        return refuse(event, `#${task.id} needs a worktree before your session can work`);
      }
      return ok({
        ...withRequest(task, event.request, {
          kind: "creating_worktree",
          request: event.request,
          claimedBy: event.session,
        }),
        builds: task.builds + 1,
      });

    case "task.worktree_created":
      if (task.step.kind !== "creating_worktree") {
        return refuse(event, `#${task.id} isn't creating a worktree`);
      }
      return ok(
        withRequest(task, event.request, {
          kind: "starting_session",
          worktree: event.worktree,
          request: event.request,
        }),
      );

    case "task.dispatched": {
      const { step } = task;
      if (step.kind !== "starting_session") {
        return refuse(event, `#${task.id} has no worktree yet`);
      }
      return ok({
        ...base(task),
        phase: "in_progress",
        spec: task.spec,
        worktree: step.worktree,
        step: { kind: "running", session: event.session },
        attempts: 0,
        brief: noBrief,
      });
    }

    case "task.spec_sent_back":
      return ok(backToSpec(task, task.spec, event.note));

    default:
      return wrongPhase(event, task);
  }
}

function inProgress(task: TaskIn<"in_progress">, event: TaskEvent): EvolvedTask {
  switch (event.type) {
    // After a retry: a new agent in the same worktree.
    case "task.dispatch_started":
      return ok(withRequest(task, event.request, { kind: "starting", request: event.request }));

    case "task.dispatched":
      if (task.step.kind !== "starting") {
        return refuse(event, `#${task.id} isn't starting an agent`);
      }
      return ok({ ...task, step: { kind: "running", session: event.session } });

    // After a retry: your session carries on in the same worktree.
    case "task.claimed":
      return ok({ ...task, step: { kind: "running", session: event.session } });

    case "task.done_reported": {
      const { step } = task;
      if (step.kind !== "running") return refuse(event, `#${task.id} has no agent running`);
      return ok({
        ...base(task),
        phase: "checks",
        spec: task.spec,
        worktree: task.worktree,
        attempts: task.attempts,
        branch: event.branch,
        step: { kind: "gate", gate: event.gate, request: event.request, session: step.session },
        requests: event.request,
      });
    }

    case "task.spec_sent_back":
      return ok(backToSpec(task, task.spec, event.note));

    default:
      return wrongPhase(event, task);
  }
}

function inChecks(task: TaskIn<"checks">, event: TaskEvent): EvolvedTask {
  const { step } = task;
  switch (event.type) {
    // After the last gate, the step stays put. decide writes
    // task.checks_passed in the same batch, and that moves the task on.
    case "task.gate_passed": {
      const mismatch = gateMismatch(task, event.gate);
      if (mismatch) return refuse(event, mismatch);
      if (event.next === null || step.kind !== "gate") return ok(task);
      return ok({
        ...task,
        step: {
          kind: "gate",
          gate: event.next.gate,
          request: event.next.request,
          session: step.session,
        },
        requests: event.next.request,
      });
    }

    case "task.gate_failed": {
      const mismatch = gateMismatch(task, event.failure.step);
      if (mismatch) return refuse(event, mismatch);
      return ok(backToAgent(task, task.attempts + 1, event.failure, null));
    }

    // Only a fact for the record: every merge must follow a pass. The next
    // event in the same batch starts the merge or waits for approval.
    case "task.checks_passed":
      return ok(task);

    // The agent is stopped once the gates pass, and its question with it.
    // A send-back or a failed merge queues the task for a new agent, so it
    // waits for a free slot.
    case "task.merge_approval_requested":
      return ok({ ...task, step: { kind: "awaiting_merge_approval" }, question: null });

    // Not a failure, so no attempt is used. The note waits for the next agent.
    case "task.merge_sent_back":
      if (step.kind !== "awaiting_merge_approval") {
        return refuse(event, `#${task.id} isn't waiting for merge approval`);
      }
      return ok(backToAgent(task, task.attempts, null, event.note));

    case "task.merge_started":
      if (step.kind === "merging") return refuse(event, `#${task.id} is already merging`);
      return ok({
        ...task,
        step: { kind: "merging", request: event.request },
        requests: event.request,
        question: null,
      });

    case "task.merged":
      if (step.kind !== "merging") return refuse(event, `#${task.id} isn't merging`);
      return ok({
        ...base(task),
        phase: "done",
        spec: task.spec,
        mergeCommit: event.commit,
        step: { kind: "merged" },
      });

    // A failed merge counts as an attempt, like a failed gate.
    case "task.merge_failed":
      if (step.kind !== "merging") return refuse(event, `#${task.id} isn't merging`);
      return ok(backToAgent(task, task.attempts + 1, event.failure, null));

    case "task.spec_sent_back":
      return ok(backToSpec(task, task.spec, event.note));

    default:
      return wrongPhase(event, task);
  }
}

function inDone(task: TaskIn<"done">, event: TaskEvent): EvolvedTask {
  switch (event.type) {
    case "task.revert_started":
      return ok({
        ...task,
        step: { kind: "reverting", reason: event.reason, request: event.request },
        requests: event.request,
      });

    case "task.revert_failed":
      return ok({ ...task, step: { kind: "revert_failed", summary: event.summary } });

    // The revert has happened. The reason becomes the note, so the redone
    // spec addresses it.
    case "task.reverted":
      if (task.step.kind !== "reverting") return refuse(event, `#${task.id} isn't being reverted`);
      return ok(backToSpec(task, task.spec, event.reason));
    default:
      return wrongPhase(event, task);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A step that sends a request records the number the event gives it, so
// only the reply that brings it back can answer. The counter follows it.
// The step must be one the task's phase allows. Typing it as T["step"]
// makes the compiler check that, field by field.
function withRequest<T extends Extract<Task, { step: unknown }>>(
  task: T,
  request: number,
  step: T["step"],
): T {
  return { ...task, step, requests: request };
}

function ok(task: Task): EvolvedTask {
  return { ok: true, task };
}

function refuse(event: TaskEvent, why: string): EvolvedTask {
  return { ok: false, reason: `${event.type} can't apply: ${why}.` };
}

function wrongPhase(event: TaskEvent, task: Task): EvolvedTask {
  return {
    ok: false,
    reason: `${event.type} can't apply to #${task.id} in ${phaseNames[task.phase]}.`,
  };
}

// The fields every task has, whatever its phase. A move to another phase is
// built from these plus the new phase's own fields, never by copying the old
// phase's, so nothing from the old phase is left behind.
function base(task: Task) {
  return {
    id: task.id,
    title: task.title,
    project: task.project,
    source: task.source,
    createdAt: task.createdAt,
    question: task.question,
    blocked: task.blocked,
    builds: task.builds,
    requests: task.requests,
    usage: task.usage,
    usageAtRetry: task.usageAtRetry,
  };
}

// The same, with the flags cleared: for a task leaving its phase for good.
function shared(task: Task) {
  return { ...base(task), question: null, blocked: null };
}

// From a later phase, the worktree is dropped: the next build starts on a
// fresh branch.
function backToSpec(task: Task, spec: Spec, note: string): Task {
  return { ...shared(task), phase: "spec", spec, note, step: { kind: "queued" } };
}

// The task with its agent stopped and waiting for a slot again, or null in
// a phase with no work in flight.
function stopAgent(task: Task): Task | null {
  switch (task.phase) {
    case "spec":
    case "ready":
    case "in_progress":
      return { ...task, step: { kind: "queued" } };
    case "checks": {
      return {
        ...base(task),
        phase: "in_progress",
        spec: task.spec,
        worktree: task.worktree,
        attempts: task.attempts,
        step: { kind: "queued" },
        brief: noBrief,
      };
    }
    default:
      return null;
  }
}

// From Checks back to In progress. While a gate runs, the same agent is
// still open and carries on. Once the gates have passed, its agent was
// stopped, so the task waits for a new one, with the failure or your note.
function backToAgent(
  task: TaskIn<"checks">,
  attempts: number,
  failure: Failure | null,
  note: string | null,
): Task {
  const step =
    task.step.kind === "gate"
      ? { kind: "running" as const, session: task.step.session }
      : { kind: "queued" as const };
  return {
    ...base(task),
    phase: "in_progress",
    spec: task.spec,
    worktree: task.worktree,
    step,
    attempts,
    brief: { failure, note, blocked: null },
  };
}

// Returns what doesn't match between a gate result and the running gate,
// or null when they match.
function gateMismatch(task: TaskIn<"checks">, gate: string): string | null {
  const { step } = task;
  if (step.kind !== "gate") return `#${task.id} isn't running a gate`;
  if (step.gate !== gate) return `#${task.id} is running the ${step.gate} gate, not ${gate}`;
  return null;
}
