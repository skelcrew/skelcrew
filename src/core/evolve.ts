// Evolve: folds one event into a task. It only applies facts that decide
// already accepted, so it holds no rules of its own. Replaying a task's
// events through it, starting from null, rebuilds the task exactly.

import type { Evolve, Evolved, Failure, Phase, Task, TaskEvent } from "./types";

const noUsage = { tokens: 0, ms: 0 };

export const evolve: Evolve = (task, event) => {
  if (event.type === "task.created") {
    if (task !== null) {
      return refuse(event, `#${event.taskId} already exists`);
    }
    return {
      ok: true,
      task: {
        phase: "idea",
        id: event.taskId,
        title: event.title,
        project: event.project,
        source: event.source,
        createdAt: event.at,
        question: null,
        blocked: null,
        builds: 0,
        usage: noUsage,
        usageAtRetry: noUsage,
      },
    };
  }
  if (task === null) {
    return refuse(event, `#${event.taskId} doesn't exist`);
  }

  switch (event.type) {
    case "task.spec_requested":
      if (task.phase !== "idea") return wrongPhase(event, task);
      return {
        ok: true,
        task: { ...task, phase: "spec", spec: null, note: null, step: { kind: "queued" } },
      };

    case "task.specced":
      if (task.phase !== "spec") return wrongPhase(event, task);
      return {
        ok: true,
        task: { ...task, spec: event.spec, note: null, step: { kind: "awaiting_approval" } },
      };

    // In Ready, each start is a new build with its own branch. The count
    // goes up before the worktree exists, so a failed try never reuses it.
    case "task.dispatch_started":
      if (task.phase === "spec") {
        return { ok: true, task: { ...task, step: { kind: "starting" } } };
      }
      if (task.phase === "ready") {
        return {
          ok: true,
          task: { ...task, step: { kind: "creating_worktree" }, builds: task.builds + 1 },
        };
      }
      return wrongPhase(event, task);

    case "task.spec_session_started":
      if (task.phase !== "spec") return wrongPhase(event, task);
      return { ok: true, task: { ...task, step: { kind: "running", session: event.session } } };

    // The old spec is kept, so the agent revises it with the note instead
    // of starting over.
    case "task.spec_sent_back":
      if (task.phase !== "spec") return wrongPhase(event, task);
      return { ok: true, task: { ...task, note: event.note, step: { kind: "queued" } } };

    case "task.ready": {
      if (task.phase !== "spec") return wrongPhase(event, task);
      const { spec, note: _note, step: _step, ...rest } = task;
      if (spec === null) return refuse(event, `#${task.id} has no spec`);
      return { ok: true, task: { ...rest, phase: "ready", spec, step: { kind: "queued" } } };
    }

    case "task.worktree_created":
      if (task.phase !== "ready") return wrongPhase(event, task);
      if (task.step.kind !== "creating_worktree") {
        return refuse(event, `#${task.id} isn't creating a worktree`);
      }
      return {
        ok: true,
        task: { ...task, step: { kind: "starting_session", worktree: event.worktree } },
      };

    case "task.dispatched": {
      if (task.phase !== "ready") return wrongPhase(event, task);
      const { step, ...rest } = task;
      if (step.kind !== "starting_session") {
        return refuse(event, `#${task.id} has no worktree yet`);
      }
      return {
        ok: true,
        task: {
          ...rest,
          phase: "in_progress",
          worktree: step.worktree,
          step: { kind: "running", session: event.session },
          attempts: 0,
          lastFailure: null,
        },
      };
    }

    case "task.done_reported": {
      if (task.phase !== "in_progress") return wrongPhase(event, task);
      const { step, lastFailure: _lastFailure, ...rest } = task;
      if (step.kind !== "running") return refuse(event, `#${task.id} has no agent running`);
      return {
        ok: true,
        task: {
          ...rest,
          phase: "checks",
          session: step.session,
          branch: event.branch,
          step: event.gate,
        },
      };
    }

    // After the last gate, the step stays put. decide writes
    // task.checks_passed in the same batch, and that moves the task on.
    case "task.gate_passed": {
      if (task.phase !== "checks") return wrongPhase(event, task);
      const mismatch = gateMismatch(task, event.gate);
      if (mismatch) return refuse(event, mismatch);
      return event.next === null
        ? { ok: true, task }
        : { ok: true, task: { ...task, step: event.next } };
    }

    // Back to the same agent, which is still open and knows the code.
    case "task.gate_failed": {
      if (task.phase !== "checks") return wrongPhase(event, task);
      const mismatch = gateMismatch(task, event.failure.step);
      if (mismatch) return refuse(event, mismatch);
      return { ok: true, task: backToAgent(task, task.attempts + 1, event.failure) };
    }

    // Only a fact for the record: every merge must follow a pass. The next
    // event in the same batch starts the merge or waits for approval.
    case "task.checks_passed":
      if (task.phase !== "checks") return wrongPhase(event, task);
      return { ok: true, task };

    case "task.escalated":
      if (task.phase !== "checks") return wrongPhase(event, task);
      return { ok: true, task: { ...task, step: "merge_approval" } };

    case "task.merge_started":
      if (task.phase !== "checks") return wrongPhase(event, task);
      if (task.step === "merging") return refuse(event, `#${task.id} is already merging`);
      return { ok: true, task: { ...task, step: "merging" } };

    case "task.merged": {
      if (task.phase !== "checks") return wrongPhase(event, task);
      if (task.step !== "merging") return refuse(event, `#${task.id} isn't merging`);
      const {
        worktree: _worktree,
        session: _session,
        attempts: _attempts,
        branch: _branch,
        step: _step,
        ...rest
      } = task;
      return { ok: true, task: { ...rest, phase: "done", mergeCommit: event.commit } };
    }

    // A failed merge counts as an attempt, like a failed gate.
    case "task.merge_failed":
      if (task.phase !== "checks") return wrongPhase(event, task);
      if (task.step !== "merging") return refuse(event, `#${task.id} isn't merging`);
      return { ok: true, task: backToAgent(task, task.attempts + 1, event.failure) };

    // Not a failure, so no attempt is used. The note reaches the agent as
    // a message.
    case "task.merge_sent_back":
      if (task.phase !== "checks") return wrongPhase(event, task);
      if (task.step !== "merge_approval") {
        return refuse(event, `#${task.id} isn't waiting for merge approval`);
      }
      return { ok: true, task: backToAgent(task, task.attempts, null) };

    default:
      return refuse(event, "not handled yet");
  }
};

function refuse(event: TaskEvent, why: string): Evolved {
  return { ok: false, reason: `${event.type} can't apply: ${why}.` };
}

// From Checks back to In progress, with the same agent. Its session stayed
// open, so it still knows the code it wrote.
function backToAgent(
  task: Task & { phase: "checks" },
  attempts: number,
  lastFailure: Failure | null,
): Task {
  const { session, branch: _branch, step: _step, ...rest } = task;
  return {
    ...rest,
    phase: "in_progress",
    step: { kind: "running", session },
    attempts,
    lastFailure,
  };
}

// Returns what doesn't match between a gate result and the running gate,
// or null when they match.
function gateMismatch(task: Task & { phase: "checks" }, gate: string): string | null {
  if (task.step === gate) return null;
  if (task.step === "merge_approval" || task.step === "merging") {
    return `#${task.id} isn't running a gate`;
  }
  return `#${task.id} is running the ${task.step} gate, not ${gate}`;
}

function wrongPhase(event: TaskEvent, task: Task): Evolved {
  return {
    ok: false,
    reason: `${event.type} can't apply to #${task.id} in ${phaseNames[task.phase]}.`,
  };
}

const phaseNames: Record<Phase, string> = {
  idea: "Idea",
  spec: "Spec",
  ready: "Ready",
  in_progress: "In progress",
  checks: "Checks",
  done: "Done",
  dropped: "Dropped",
};
