// Decide: the only place a task can change. It checks one input against the
// task, the config and the rules, then accepts it with events and commands,
// or rejects it with a reason. It reads nothing else and changes nothing.
//
// Inputs that create a task come first, then checks that apply to every
// input. The rest are grouped by the phase they apply in, one function per
// phase, like evolve.

import { attemptsLeft, criticalFiles, specComplete } from "./contracts";
import { phaseNames, type TaskIn } from "./phases";
import type {
  Command,
  Config,
  Decide,
  Decision,
  EventBody,
  Failure,
  Input,
  Project,
  ProjectId,
  Spec,
} from "./types";

// What every phase function needs besides the task and the input.
type Context = {
  accept: (bodies: EventBody[], commands?: Command[]) => Decision;
  reject: (reason: string) => Decision;
  config: Config;
  projects: ReadonlyMap<ProjectId, Project>;
};

export const decide: Decide = (task, envelope, config, projects) => {
  const { input, taskId } = envelope;
  const ctx: Context = {
    accept: (bodies, commands = []) => ({
      ok: true,
      events: bodies.map((body) => ({ ...body, v: 1, taskId, at: envelope.at })),
      commands,
    }),
    reject: (reason) => ({ ok: false, rejection: { input: input.type, reason } }),
    config,
    projects,
  };
  const { accept, reject } = ctx;

  // A delegated issue counts as asking for a spec, as `add --spec` does.
  if (input.type === "add" || input.type === "issue_delegated") {
    if (task !== null) return reject(`#${taskId} already exists.`);
    if (input.title.trim() === "") return reject("A task needs a title.");
    if (input.project !== null && !projects.has(input.project)) {
      return reject(`There is no project called ${input.project}.`);
    }
    const source = input.type === "issue_delegated" ? input.source : null;
    const created: EventBody = {
      type: "task.created",
      title: input.title,
      project: input.project,
      source,
    };
    return accept(asksForSpec(input) ? [created, { type: "task.spec_requested" }] : [created]);
  }
  if (task === null) return reject(`#${taskId} doesn't exist.`);
  if (task.phase === "dropped") return reject(`#${task.id} was dropped.`);

  if (input.type === "request_spec" && task.phase !== "idea") {
    return reject(`#${task.id} is in ${phaseNames[task.phase]}. Only an Idea can be specced.`);
  }

  // Retry only clears the block. The scheduler then starts the task when a
  // slot is free, so a retry never goes past max_running.
  if (input.type === "retry") {
    if (task.blocked === null) return reject(`#${task.id} isn't blocked.`);
    return accept([{ type: "task.unblocked" }]);
  }

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
    default:
      return reject("Not handled yet.");
  }
};

function inIdea(_task: TaskIn<"idea">, input: Input, ctx: Context): Decision {
  switch (input.type) {
    case "request_spec":
      return ctx.accept([{ type: "task.spec_requested" }]);

    case "provide_spec":
      return acceptSpec(input.spec, "human", ctx, [{ type: "task.spec_requested" }]);

    case "drop":
      return ctx.accept([{ type: "task.dropped" }]);

    default:
      return ctx.reject("Not handled yet.");
  }
}

function inSpec(task: TaskIn<"spec">, input: Input, ctx: Context): Decision {
  const { accept, reject } = ctx;
  const { step } = task;

  switch (input.type) {
    case "start": {
      const refused = cantStart(task, ctx);
      if (refused) return reject(refused);
      return accept(
        [{ type: "task.dispatch_started" }],
        [{ type: "start_spec_session", taskId: task.id, note: task.note }],
      );
    }

    case "session_started":
      if (step.kind !== "starting") return reject(`#${task.id} isn't starting a spec agent.`);
      return accept([{ type: "task.spec_session_started", session: input.session }]);

    case "session_failed":
      if (step.kind !== "starting") return reject(`#${task.id} isn't starting a spec agent.`);
      return accept([
        { type: "task.blocked", reason: { kind: "session_failed", message: input.message } },
      ]);

    case "submit_spec":
      if (step.kind !== "running") return reject(`#${task.id} has no spec agent running.`);
      return acceptSpec(
        input.spec,
        "agent",
        ctx,
        [],
        [{ type: "stop_session", session: step.session }],
      );

    // Your spec replaces the agent's work, so a running agent is stopped.
    case "provide_spec": {
      const stop: Command[] =
        step.kind === "running" ? [{ type: "stop_session", session: step.session }] : [];
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
      if (input.note.trim() === "") return reject("A send-back needs a note.");
      return accept([{ type: "task.spec_sent_back", note: input.note }]);

    default:
      return reject("Not handled yet.");
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
      return accept(
        [{ type: "task.dispatch_started" }],
        [{ type: "create_worktree", taskId: task.id, build: task.builds + 1 }],
      );
    }

    case "worktree_created":
      if (step.kind !== "creating_worktree") {
        return reject(`#${task.id} isn't creating a worktree.`);
      }
      return accept(
        [{ type: "task.worktree_created", worktree: input.worktree }],
        [
          {
            type: "start_develop_session",
            taskId: task.id,
            worktree: input.worktree,
            spec: task.spec,
            lastFailure: null,
          },
        ],
      );

    case "worktree_failed":
      if (step.kind !== "creating_worktree") {
        return reject(`#${task.id} isn't creating a worktree.`);
      }
      return accept([
        { type: "task.blocked", reason: { kind: "worktree_failed", message: input.message } },
      ]);

    case "session_started":
      if (step.kind !== "starting_session") {
        return reject(`#${task.id} isn't starting a develop agent.`);
      }
      return accept([{ type: "task.dispatched", session: input.session }]);

    // A blocked task waits without a worktree, so the unused one is removed.
    // The agent never ran, so no work is lost.
    case "session_failed":
      if (step.kind !== "starting_session") {
        return reject(`#${task.id} isn't starting a develop agent.`);
      }
      return accept(
        [{ type: "task.blocked", reason: { kind: "session_failed", message: input.message } }],
        [{ type: "remove_worktree", worktree: step.worktree }],
      );

    default:
      return reject("Not handled yet.");
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
      return accept(
        [{ type: "task.dispatch_started" }],
        [
          {
            type: "start_develop_session",
            taskId: task.id,
            worktree,
            spec: task.spec,
            lastFailure: task.lastFailure,
          },
        ],
      );
    }

    case "session_started":
      if (step.kind !== "starting") return reject(`#${task.id} isn't starting a develop agent.`);
      return accept([{ type: "task.dispatched", session: input.session }]);

    // The worktree stays, so a retry carries on with the same code.
    case "session_failed":
      if (step.kind !== "starting") return reject(`#${task.id} isn't starting a develop agent.`);
      return accept([
        { type: "task.blocked", reason: { kind: "session_failed", message: input.message } },
      ]);

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
      return accept(
        [{ type: "task.blocked", reason: { kind: "agent_gave_up", message: input.message } }],
        [{ type: "stop_session", session: step.session }],
      );

    default:
      return reject("Not handled yet.");
  }
}

function inChecks(task: TaskIn<"checks">, input: Input, ctx: Context): Decision {
  const { accept, reject, config } = ctx;

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
        [{ type: "merge", taskId: task.id, worktree: task.worktree }],
      );
    }

    case "approve_merge":
      if (task.step !== "merge_approval") {
        return reject(`#${task.id}'s merge isn't waiting for approval.`);
      }
      return accept(
        [{ type: "task.merge_started" }],
        [{ type: "merge", taskId: task.id, worktree: task.worktree }],
      );

    // Your note goes to the agent that wrote the code. It isn't a failure,
    // so no attempt is used.
    case "send_back_merge":
      if (task.step !== "merge_approval") {
        return reject(`#${task.id}'s merge isn't waiting for approval.`);
      }
      if (input.note.trim() === "") return reject("A send-back needs a note.");
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
        [
          { type: "stop_session", session: task.session },
          { type: "remove_worktree", worktree: task.worktree },
        ],
      );

    // A failed merge counts as an attempt, like a failed gate.
    case "merge_failed": {
      if (task.step !== "merging") return reject(`#${task.id} isn't merging.`);
      const failure: Failure = { step: "merge", summary: input.summary };
      return failedRound(task, { type: "task.merge_failed", failure }, failure, ctx);
    }

    default:
      return reject("Not handled yet.");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    return ctx.accept(
      [failed],
      [
        {
          type: "send_to_session",
          session: task.session,
          text: `${what} failed: ${failure.summary}`,
        },
      ],
    );
  }
  return ctx.accept(
    [failed, { type: "task.blocked", reason: { kind: "out_of_attempts", failure } }],
    [{ type: "stop_session", session: task.session }],
  );
}

function asksForSpec(input: Input & { type: "add" | "issue_delegated" }): boolean {
  return input.type === "issue_delegated" || input.requestSpec;
}

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
