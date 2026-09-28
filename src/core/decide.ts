// Decide: the only place a task can change. It checks one input against the
// task, the config and the rules, then accepts it with events and commands,
// or rejects it with a reason. It reads nothing else and changes nothing.
//
// Inputs that create a task come first, then checks that apply to every
// input. The rest are grouped by the phase they apply in, one function per
// phase, like evolve.

import { specComplete } from "./contracts";
import { phaseNames, type TaskIn } from "./phases";
import type {
  Command,
  Config,
  Decide,
  Decision,
  EventBody,
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

  switch (task.phase) {
    case "idea":
      return inIdea(task, input, ctx);
    case "spec":
      return inSpec(task, input, ctx);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
