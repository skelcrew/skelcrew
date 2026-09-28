import { describe, expect, test } from "bun:test";
import { evolve } from "./evolve";
import { CommitSha, SessionId, TaskId } from "./ids";
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

const branchFacts = { commits: 3, changedFiles: ["src/reports/export.ts"] };
const inProgress: EventBody[] = [
  ...inReady,
  { type: "task.dispatch_started" },
  { type: "task.worktree_created", worktree },
  { type: "task.dispatched", session },
];
const inChecks: EventBody[] = [
  ...inProgress,
  { type: "task.done_reported", branch: branchFacts, gate: "local" },
];
const localFailed = { step: "local" as const, summary: "2 tests failed in export.test.ts" };

describe("task.done_reported", () => {
  test("moves the task to Checks, running the first gate, with the agent kept open", () => {
    expect(replay(...inChecks)).toMatchObject({
      phase: "checks",
      spec,
      worktree,
      session,
      attempts: 0,
      branch: branchFacts,
      step: "local",
    });
  });

  test("is refused outside In progress", () => {
    const report = event({ type: "task.done_reported", branch: branchFacts, gate: "local" });
    expect(evolve(replay(...inReady), report)).toEqual({
      ok: false,
      reason: "task.done_reported can't apply to #12 in Ready.",
    });
  });
});

describe("task.gate_passed", () => {
  test("moves on to the next gate", () => {
    expect(
      replay(...inChecks, { type: "task.gate_passed", gate: "local", next: "review" }),
    ).toMatchObject({ phase: "checks", step: "review" });
  });

  test("stays on the last gate until the checks are marked passed", () => {
    expect(
      replay(...inChecks, { type: "task.gate_passed", gate: "local", next: null }),
    ).toMatchObject({ phase: "checks", step: "local" });
  });

  test("is refused for a gate that isn't running", () => {
    const passed = event({ type: "task.gate_passed", gate: "review", next: null });
    expect(evolve(replay(...inChecks), passed)).toEqual({
      ok: false,
      reason: "task.gate_passed can't apply: #12 is running the local gate, not review.",
    });
  });
});

describe("task.gate_failed", () => {
  test("sends the task back to the same agent with the failure, counting one attempt", () => {
    expect(replay(...inChecks, { type: "task.gate_failed", failure: localFailed })).toMatchObject({
      phase: "in_progress",
      worktree,
      step: { kind: "running", session },
      attempts: 1,
      lastFailure: localFailed,
    });
  });

  test("keeps counting attempts across rounds", () => {
    const task = replay(
      ...inChecks,
      { type: "task.gate_failed", failure: localFailed },
      { type: "task.done_reported", branch: branchFacts, gate: "local" },
      { type: "task.gate_failed", failure: localFailed },
    );
    expect(task).toMatchObject({ phase: "in_progress", attempts: 2 });
  });

  test("is refused for a gate that isn't running", () => {
    const failed = event({ type: "task.gate_failed", failure: { ...localFailed, step: "review" } });
    expect(evolve(replay(...inChecks), failed)).toEqual({
      ok: false,
      reason: "task.gate_failed can't apply: #12 is running the local gate, not review.",
    });
  });
});

const commit = CommitSha.parse("a".repeat(40));
const checksPassed: EventBody[] = [
  ...inChecks,
  { type: "task.gate_passed", gate: "local", next: null },
  { type: "task.checks_passed" },
];
const escalated: EventBody[] = [
  ...checksPassed,
  { type: "task.escalated", criticalFiles: ["src/auth/login.ts"] },
];
const merging: EventBody[] = [...checksPassed, { type: "task.merge_started" }];
const mergeFailed = { step: "merge" as const, summary: "Conflicts with main in export.ts" };

describe("task.checks_passed", () => {
  test("leaves the task in Checks until the merge starts or waits for approval", () => {
    expect(replay(...checksPassed)).toMatchObject({ phase: "checks", step: "local" });
  });

  test("is refused outside Checks", () => {
    expect(evolve(replay(...inProgress), event({ type: "task.checks_passed" }))).toEqual({
      ok: false,
      reason: "task.checks_passed can't apply to #12 in In progress.",
    });
  });
});

describe("task.escalated", () => {
  test("waits for the developer to approve the merge", () => {
    expect(replay(...escalated)).toMatchObject({ phase: "checks", step: "merge_approval" });
  });
});

describe("task.merge_started", () => {
  test("starts merging straight after the checks pass", () => {
    expect(replay(...merging)).toMatchObject({ phase: "checks", step: "merging" });
  });

  test("starts merging once the developer approves", () => {
    expect(replay(...escalated, { type: "task.merge_started" })).toMatchObject({
      phase: "checks",
      step: "merging",
    });
  });

  test("is refused while already merging", () => {
    expect(evolve(replay(...merging), event({ type: "task.merge_started" }))).toEqual({
      ok: false,
      reason: "task.merge_started can't apply: #12 is already merging.",
    });
  });
});

describe("task.merged", () => {
  test("moves the task to Done with the merge commit", () => {
    const task = replay(...merging, { type: "task.merged", commit });
    expect(task).toMatchObject({ phase: "done", spec, mergeCommit: commit });
    expect(task).not.toHaveProperty("worktree");
    expect(task).not.toHaveProperty("session");
  });

  test("is refused before the merge started", () => {
    expect(evolve(replay(...escalated), event({ type: "task.merged", commit }))).toEqual({
      ok: false,
      reason: "task.merged can't apply: #12 isn't merging.",
    });
  });
});

describe("task.merge_failed", () => {
  test("sends the task back to the same agent with the failure, counting one attempt", () => {
    expect(replay(...merging, { type: "task.merge_failed", failure: mergeFailed })).toMatchObject({
      phase: "in_progress",
      worktree,
      step: { kind: "running", session },
      attempts: 1,
      lastFailure: mergeFailed,
    });
  });

  test("is refused before the merge started", () => {
    const failed = event({ type: "task.merge_failed", failure: mergeFailed });
    expect(evolve(replay(...escalated), failed)).toEqual({
      ok: false,
      reason: "task.merge_failed can't apply: #12 isn't merging.",
    });
  });
});

describe("task.merge_sent_back", () => {
  test("sends the task back to the same agent without counting an attempt", () => {
    const task = replay(...escalated, { type: "task.merge_sent_back", note: "Don't touch login." });
    expect(task).toMatchObject({
      phase: "in_progress",
      worktree,
      step: { kind: "running", session },
      attempts: 0,
      lastFailure: null,
    });
  });

  test("is refused unless the merge is waiting for approval", () => {
    const sentBack = event({ type: "task.merge_sent_back", note: "Don't touch login." });
    expect(evolve(replay(...merging), sentBack)).toEqual({
      ok: false,
      reason: "task.merge_sent_back can't apply: #12 isn't waiting for merge approval.",
    });
  });
});
