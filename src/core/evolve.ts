// Evolve: folds one event into a task. It only applies facts that decide
// already accepted, so it holds no rules of its own. Replaying a task's
// events through it, starting from null, rebuilds the task exactly.
//
// Events that can happen in any phase come first. The rest are grouped by
// the phase they apply in, one function per phase, in lifecycle order.

import { phaseNames, type TaskIn } from "./phases";
import type { EvolvedTask, EvolveTask, Failure, Spec, Task, TaskEvent } from "./types";

const noUsage = { tokens: 0, ms: 0 };

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
          ? { ...cleared, attempts: 0, lastBlock: task.blocked }
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
      return ok(withRequest(task, (request) => ({ kind: "starting", request })));

    case "task.spec_session_started":
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
      const { spec, note: _note, step: _step, ...rest } = task;
      if (spec === null) return refuse(event, `#${task.id} has no spec`);
      return ok({ ...rest, phase: "ready", spec, step: { kind: "queued" } });
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
        ...withRequest(task, (request) => ({ kind: "creating_worktree", request })),
        builds: task.builds + 1,
      });

    case "task.worktree_created":
      if (task.step.kind !== "creating_worktree") {
        return refuse(event, `#${task.id} isn't creating a worktree`);
      }
      return ok(
        withRequest(task, (request) => ({
          kind: "starting_session",
          worktree: event.worktree,
          request,
        })),
      );

    case "task.dispatched": {
      const { step, ...rest } = task;
      if (step.kind !== "starting_session") {
        return refuse(event, `#${task.id} has no worktree yet`);
      }
      return ok({
        ...rest,
        phase: "in_progress",
        worktree: step.worktree,
        step: { kind: "running", session: event.session },
        attempts: 0,
        lastFailure: null,
        note: null,
        lastBlock: null,
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
      return ok(withRequest(task, (request) => ({ kind: "starting", request })));

    case "task.dispatched":
      if (task.step.kind !== "starting") {
        return refuse(event, `#${task.id} isn't starting an agent`);
      }
      return ok({ ...task, step: { kind: "running", session: event.session } });

    case "task.done_reported": {
      const { step, lastFailure: _lastFailure, note: _note, lastBlock: _lastBlock, ...rest } = task;
      if (step.kind !== "running") return refuse(event, `#${task.id} has no agent running`);
      return ok({
        ...rest,
        phase: "checks",
        session: step.session,
        branch: event.branch,
        step: event.gate,
        request: task.requests + 1,
        requests: task.requests + 1,
      });
    }

    case "task.spec_sent_back":
      return ok(backToSpec(task, task.spec, event.note));

    default:
      return wrongPhase(event, task);
  }
}

function inChecks(task: TaskIn<"checks">, event: TaskEvent): EvolvedTask {
  switch (event.type) {
    // After the last gate, the step stays put. decide writes
    // task.checks_passed in the same batch, and that moves the task on.
    case "task.gate_passed": {
      const mismatch = gateMismatch(task, event.gate);
      if (mismatch) return refuse(event, mismatch);
      if (event.next === null) return ok(task);
      return ok({
        ...task,
        step: event.next,
        request: task.requests + 1,
        requests: task.requests + 1,
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
      return ok({ ...task, step: "merge_approval", request: null, session: null, question: null });

    // Not a failure, so no attempt is used. The note waits for the next agent.
    case "task.merge_sent_back":
      if (task.step !== "merge_approval") {
        return refuse(event, `#${task.id} isn't waiting for merge approval`);
      }
      return ok(backToAgent(task, task.attempts, null, event.note));

    case "task.merge_started":
      if (task.step === "merging") return refuse(event, `#${task.id} is already merging`);
      return ok({
        ...task,
        step: "merging",
        request: task.requests + 1,
        requests: task.requests + 1,
        session: null,
        question: null,
      });

    case "task.merged": {
      if (task.step !== "merging") return refuse(event, `#${task.id} isn't merging`);
      const {
        worktree: _worktree,
        session: _session,
        attempts: _attempts,
        branch: _branch,
        step: _step,
        ...rest
      } = task;
      return ok({
        ...rest,
        phase: "done",
        mergeCommit: event.commit,
        reverting: null,
        revertFailure: null,
      });
    }

    // A failed merge counts as an attempt, like a failed gate.
    case "task.merge_failed":
      if (task.step !== "merging") return refuse(event, `#${task.id} isn't merging`);
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
        reverting: { reason: event.reason, request: task.requests + 1 },
        requests: task.requests + 1,
        revertFailure: null,
      });

    case "task.revert_failed":
      return ok({ ...task, reverting: null, revertFailure: event.summary });

    // The revert has happened. The reason becomes the note, so the redone
    // spec addresses it.
    case "task.reverted":
      if (task.reverting === null) return refuse(event, `#${task.id} isn't being reverted`);
      return ok(backToSpec(task, task.spec, event.reason));
    default:
      return wrongPhase(event, task);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A step that sends a request: it takes the next request number, and the
// step records it, so only the reply that brings it back can answer.
function withRequest<T extends Task, S>(task: T, step: (request: number) => S) {
  const request = task.requests + 1;
  return { ...task, step: step(request), requests: request };
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

// The fields every phase has, with the flags cleared. Used when a task
// leaves its phase for good, so nothing from the old phase is carried over.
function shared(task: Task) {
  return {
    id: task.id,
    title: task.title,
    project: task.project,
    source: task.source,
    createdAt: task.createdAt,
    question: null,
    blocked: null,
    builds: task.builds,
    requests: task.requests,
    usage: task.usage,
    usageAtRetry: task.usageAtRetry,
  };
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
      const { session: _session, branch: _branch, step: _step, ...rest } = task;
      return {
        ...rest,
        phase: "in_progress",
        step: { kind: "queued" },
        lastFailure: null,
        note: null,
        lastBlock: null,
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
  lastFailure: Failure | null,
  note: string | null,
): Task {
  const { session, branch: _branch, step: _step, ...rest } = task;
  const step =
    session === null ? { kind: "queued" as const } : { kind: "running" as const, session };
  return { ...rest, phase: "in_progress", step, attempts, lastFailure, note, lastBlock: null };
}

// Returns what doesn't match between a gate result and the running gate,
// or null when they match.
function gateMismatch(task: TaskIn<"checks">, gate: string): string | null {
  if (task.step === gate) return null;
  if (task.step === "merge_approval" || task.step === "merging") {
    return `#${task.id} isn't running a gate`;
  }
  return `#${task.id} is running the ${task.step} gate, not ${gate}`;
}
