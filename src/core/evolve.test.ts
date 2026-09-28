import { describe, expect, test } from "bun:test";
import { evolve } from "./evolve";
import { TaskId } from "./ids";
import type { EventBody, Spec, Task, TaskEvent } from "./types";

const id = TaskId.parse(12);
const at = 1_000;

function event(body: EventBody): TaskEvent {
  return { ...body, v: 1, taskId: id, at };
}

// Folds events from nothing, the way replay does. Fails the test if any
// event is refused, so tests can build a task in any phase.
function replay(...bodies: EventBody[]): Task {
  let task: Task | null = null;
  for (const body of bodies) {
    const result = evolve(task, event(body));
    if (!result.ok) throw new Error(result.reason);
    task = result.task;
  }
  if (task === null) throw new Error("replay needs at least one event");
  return task;
}

const created: EventBody = {
  type: "task.created",
  title: "CSV export",
  project: null,
  source: null,
};

const spec: Spec = {
  scope: "Add a CSV export button to the reports page.",
  acceptance: ["Clicking Export downloads a CSV of the visible rows."],
  openQuestions: [],
};

describe("task.created", () => {
  test("starts a new task in Idea with nothing used yet", () => {
    expect(evolve(null, event(created))).toEqual({
      ok: true,
      task: {
        phase: "idea",
        id,
        title: "CSV export",
        project: null,
        source: null,
        createdAt: at,
        question: null,
        blocked: null,
        builds: 0,
        usage: { tokens: 0, ms: 0 },
        usageAtRetry: { tokens: 0, ms: 0 },
      },
    });
  });

  test("is refused for a task that already exists", () => {
    expect(evolve(replay(created), event(created))).toEqual({
      ok: false,
      reason: "task.created can't apply: #12 already exists.",
    });
  });
});

describe("any other event", () => {
  test("is refused for a task that doesn't exist yet", () => {
    expect(evolve(null, event({ type: "task.spec_requested" }))).toEqual({
      ok: false,
      reason: "task.spec_requested can't apply: #12 doesn't exist.",
    });
  });
});

describe("task.spec_requested", () => {
  test("moves a task from Idea to Spec, waiting for a free slot", () => {
    const task = replay(created, { type: "task.spec_requested" });
    expect(task.phase).toBe("spec");
    expect(task).toMatchObject({ spec: null, note: null, step: { kind: "queued" } });
  });

  test("is refused outside Idea", () => {
    const task = replay(created, { type: "task.spec_requested" });
    expect(evolve(task, event({ type: "task.spec_requested" }))).toEqual({
      ok: false,
      reason: "task.spec_requested can't apply to #12 in Spec.",
    });
  });
});

describe("task.specced", () => {
  test("stores the spec and waits for approval", () => {
    const task = replay(
      created,
      { type: "task.spec_requested" },
      { type: "task.specced", spec, by: "agent" },
    );
    expect(task.phase).toBe("spec");
    expect(task).toMatchObject({ spec, note: null, step: { kind: "awaiting_approval" } });
  });

  test("is refused outside Spec", () => {
    expect(evolve(replay(created), event({ type: "task.specced", spec, by: "agent" }))).toEqual({
      ok: false,
      reason: "task.specced can't apply to #12 in Idea.",
    });
  });
});

describe("every other field", () => {
  test("stays as it was when the phase changes", () => {
    const idea = replay(created);
    const specced = replay(
      created,
      { type: "task.spec_requested" },
      { type: "task.specced", spec, by: "agent" },
    );
    if (specced.phase !== "spec") throw new Error("expected a task in Spec");
    const { phase: _a, ...before } = idea;
    const { phase: _b, spec: _s, note: _n, step: _t, ...after } = specced;
    expect(after).toEqual(before);
  });
});
