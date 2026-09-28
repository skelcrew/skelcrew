import { describe, expect, test } from "bun:test";
import { evolve } from "./evolve";
import { SessionId, TaskId } from "./ids";
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

const session = SessionId.parse("session-1");
const inSpec: EventBody[] = [created, { type: "task.spec_requested" }];
const specced: EventBody[] = [...inSpec, { type: "task.specced", spec, by: "agent" }];

describe("task.dispatch_started in Spec", () => {
  test("marks the spec session as starting", () => {
    expect(replay(...inSpec, { type: "task.dispatch_started" })).toMatchObject({
      phase: "spec",
      step: { kind: "starting" },
    });
  });
});

describe("task.spec_session_started", () => {
  test("stores the session, so a drop can stop it", () => {
    expect(
      replay(
        ...inSpec,
        { type: "task.dispatch_started" },
        { type: "task.spec_session_started", session },
      ),
    ).toMatchObject({ phase: "spec", step: { kind: "running", session } });
  });

  test("is refused outside Spec", () => {
    expect(evolve(replay(created), event({ type: "task.spec_session_started", session }))).toEqual({
      ok: false,
      reason: "task.spec_session_started can't apply to #12 in Idea.",
    });
  });
});

describe("task.spec_sent_back in Spec", () => {
  test("keeps the spec, stores the note and waits for a slot again", () => {
    expect(
      replay(...specced, { type: "task.spec_sent_back", note: "Also export the totals row." }),
    ).toMatchObject({
      phase: "spec",
      spec,
      note: "Also export the totals row.",
      step: { kind: "queued" },
    });
  });
});

describe("task.ready", () => {
  test("moves a specced task to Ready, waiting for a slot", () => {
    expect(replay(...specced, { type: "task.ready" })).toMatchObject({
      phase: "ready",
      spec,
      step: { kind: "queued" },
    });
  });

  test("is refused for a task in Spec with no spec yet", () => {
    expect(evolve(replay(...inSpec), event({ type: "task.ready" }))).toEqual({
      ok: false,
      reason: "task.ready can't apply: #12 has no spec.",
    });
  });

  test("is refused outside Spec", () => {
    expect(evolve(replay(created), event({ type: "task.ready" }))).toEqual({
      ok: false,
      reason: "task.ready can't apply to #12 in Idea.",
    });
  });
});

const worktree = { path: "/repo/.worktrees/12", branch: "task/12-csv-export" };
const inReady: EventBody[] = [...specced, { type: "task.ready" }];

describe("task.dispatch_started in Ready", () => {
  test("starts creating the worktree and counts a new build", () => {
    const task = replay(...inReady, { type: "task.dispatch_started" });
    expect(task).toMatchObject({ phase: "ready", step: { kind: "creating_worktree" }, builds: 1 });
  });
});

describe("task.worktree_created", () => {
  test("stores the worktree while the develop session starts", () => {
    expect(
      replay(
        ...inReady,
        { type: "task.dispatch_started" },
        { type: "task.worktree_created", worktree },
      ),
    ).toMatchObject({ phase: "ready", step: { kind: "starting_session", worktree } });
  });

  test("is refused before the worktree was asked for", () => {
    expect(evolve(replay(...inReady), event({ type: "task.worktree_created", worktree }))).toEqual({
      ok: false,
      reason: "task.worktree_created can't apply: #12 isn't creating a worktree.",
    });
  });

  test("is refused outside Ready", () => {
    expect(evolve(replay(...specced), event({ type: "task.worktree_created", worktree }))).toEqual({
      ok: false,
      reason: "task.worktree_created can't apply to #12 in Spec.",
    });
  });
});

describe("task.dispatched from Ready", () => {
  const starting: EventBody[] = [
    ...inReady,
    { type: "task.dispatch_started" },
    { type: "task.worktree_created", worktree },
  ];

  test("moves the task to In progress with its worktree and running session", () => {
    expect(replay(...starting, { type: "task.dispatched", session })).toMatchObject({
      phase: "in_progress",
      spec,
      worktree,
      step: { kind: "running", session },
      attempts: 0,
      lastFailure: null,
    });
  });

  test("is refused before the worktree exists", () => {
    const task = replay(...inReady, { type: "task.dispatch_started" });
    expect(evolve(task, event({ type: "task.dispatched", session }))).toEqual({
      ok: false,
      reason: "task.dispatched can't apply: #12 has no worktree yet.",
    });
  });
});
