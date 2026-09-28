// Decide: the only place a task can change. It checks one input against the
// task, the config and the rules, then accepts it with events and commands,
// or rejects it with a reason. It reads nothing else and changes nothing.

import { phaseNames } from "./phases";
import type { Command, Decide, Decision, EventBody, Input } from "./types";

export const decide: Decide = (task, envelope, _config, projects) => {
  const { input, taskId } = envelope;
  const accept = (bodies: EventBody[], commands: Command[] = []): Decision => ({
    ok: true,
    events: bodies.map((body) => ({ ...body, v: 1, taskId, at: envelope.at })),
    commands,
  });
  const reject = (reason: string): Decision => ({
    ok: false,
    rejection: { input: input.type, reason },
  });

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

  switch (input.type) {
    case "request_spec":
      if (task.phase !== "idea") {
        return reject(`#${task.id} is in ${phaseNames[task.phase]}. Only an Idea can be specced.`);
      }
      return accept([{ type: "task.spec_requested" }]);

    case "drop":
      if (task.phase !== "idea") return reject("Not handled yet.");
      return accept([{ type: "task.dropped" }]);

    default:
      return reject("Not handled yet.");
  }
};

function asksForSpec(input: Input & { type: "add" | "issue_delegated" }): boolean {
  return input.type === "issue_delegated" || input.requestSpec;
}
