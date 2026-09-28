import { describe, expect, test } from "bun:test";
import { evolveTask } from "./evolve";
import { CommitSha, ProjectId, SessionId, TaskId } from "./ids";
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
    const result = evolveTask(task, event(body));
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
    expect(evolveTask(null, event(created))).toEqual({
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
        requests: 0,
        usage: { tokens: 0, ms: 0 },
        usageAtRetry: { tokens: 0, ms: 0 },
      },
    });
  });

  test("is refused for a task that already exists", () => {
    expect(evolveTask(replay(created), event(created))).toEqual({
      ok: false,
      reason: "task.created can't apply: #12 already exists.",
    });
  });
});

describe("any other event", () => {
  test("is refused for a task that doesn't exist yet", () => {
    expect(evolveTask(null, event({ type: "task.spec_requested" }))).toEqual({
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
    expect(evolveTask(task, event({ type: "task.spec_requested" }))).toEqual({
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

  test("clears an open question, since the spec agent that asked is stopped", () => {
    const task = replay(
      created,
      { type: "task.spec_requested" },
      { type: "task.question_asked", question: specQuestion },
      { type: "task.specced", spec, by: "human" },
    );
    expect(task.question).toBeNull();
  });

  test("is refused outside Spec", () => {
    expect(evolveTask(replay(created), event({ type: "task.specced", spec, by: "agent" }))).toEqual(
      {
        ok: false,
        reason: "task.specced can't apply to #12 in Idea.",
      },
    );
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
    expect(
      evolveTask(replay(created), event({ type: "task.spec_session_started", session })),
    ).toEqual({
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
    expect(evolveTask(replay(...inSpec), event({ type: "task.ready" }))).toEqual({
      ok: false,
      reason: "task.ready can't apply: #12 has no spec.",
    });
  });

  test("is refused outside Spec", () => {
    expect(evolveTask(replay(created), event({ type: "task.ready" }))).toEqual({
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
    expect(
      evolveTask(replay(...inReady), event({ type: "task.worktree_created", worktree })),
    ).toEqual({
      ok: false,
      reason: "task.worktree_created can't apply: #12 isn't creating a worktree.",
    });
  });

  test("is refused outside Ready", () => {
    expect(
      evolveTask(replay(...specced), event({ type: "task.worktree_created", worktree })),
    ).toEqual({
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
    expect(evolveTask(task, event({ type: "task.dispatched", session }))).toEqual({
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
    const task = replay(...inChecks);
    expect(task).toMatchObject({
      phase: "checks",
      spec,
      worktree,
      attempts: 0,
      branch: branchFacts,
    });
    expect(task.phase === "checks" && task.step).toEqual({
      kind: "gate",
      gate: "local",
      request: task.requests,
      session,
    });
  });

  test("is refused outside In progress", () => {
    const report = event({ type: "task.done_reported", branch: branchFacts, gate: "local" });
    expect(evolveTask(replay(...inReady), report)).toEqual({
      ok: false,
      reason: "task.done_reported can't apply to #12 in Ready.",
    });
  });
});

describe("task.gate_passed", () => {
  test("moves on to the next gate", () => {
    expect(
      replay(...inChecks, { type: "task.gate_passed", gate: "local", next: "review" }),
    ).toMatchObject({ phase: "checks", step: { kind: "gate", gate: "review", session } });
  });

  test("stays on the last gate until the checks are marked passed", () => {
    expect(
      replay(...inChecks, { type: "task.gate_passed", gate: "local", next: null }),
    ).toMatchObject({ phase: "checks", step: { kind: "gate", gate: "local" } });
  });

  test("is refused for a gate that isn't running", () => {
    const passed = event({ type: "task.gate_passed", gate: "review", next: null });
    expect(evolveTask(replay(...inChecks), passed)).toEqual({
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
    expect(evolveTask(replay(...inChecks), failed)).toEqual({
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
const awaitingMergeApproval: EventBody[] = [
  ...checksPassed,
  { type: "task.merge_approval_requested", criticalFiles: ["src/auth/login.ts"] },
];
const merging: EventBody[] = [...checksPassed, { type: "task.merge_started" }];
const mergeFailed = { step: "merge" as const, summary: "Conflicts with main in export.ts" };

describe("task.checks_passed", () => {
  test("leaves the task in Checks until the merge starts or waits for approval", () => {
    expect(replay(...checksPassed)).toMatchObject({
      phase: "checks",
      step: { kind: "gate", gate: "local" },
    });
  });

  test("is refused outside Checks", () => {
    expect(evolveTask(replay(...inProgress), event({ type: "task.checks_passed" }))).toEqual({
      ok: false,
      reason: "task.checks_passed can't apply to #12 in In progress.",
    });
  });
});

describe("task.merge_approval_requested", () => {
  test("waits for the developer to approve the merge, with the agent stopped", () => {
    // The step holds no session: the agent is stopped.
    const task = replay(...awaitingMergeApproval);
    expect(task.phase === "checks" && task.step).toEqual({ kind: "awaiting_merge_approval" });
  });
});

describe("the agent stopping when the gates pass", () => {
  test("clears the develop agent's open question, since no one is left to answer it", () => {
    for (const next of [
      { type: "task.merge_started" as const },
      { type: "task.merge_approval_requested" as const, criticalFiles: ["src/auth/login.ts"] },
    ]) {
      const task = replay(
        ...inChecks,
        { type: "task.question_asked", question: developQuestion },
        { type: "task.gate_passed", gate: "local", next: null },
        { type: "task.checks_passed" },
        next,
      );
      expect(task.question).toBeNull();
    }
  });
});

describe("task.merge_started", () => {
  test("starts merging straight after the checks pass, with the agent stopped", () => {
    // The step holds no session: the agent is stopped.
    const task = replay(...merging);
    expect(task.phase === "checks" && task.step).toEqual({
      kind: "merging",
      request: task.requests,
    });
  });

  test("starts merging once the developer approves", () => {
    expect(replay(...awaitingMergeApproval, { type: "task.merge_started" })).toMatchObject({
      phase: "checks",
      step: { kind: "merging" },
    });
  });

  test("is refused while already merging", () => {
    expect(evolveTask(replay(...merging), event({ type: "task.merge_started" }))).toEqual({
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
    expect(
      evolveTask(replay(...awaitingMergeApproval), event({ type: "task.merged", commit })),
    ).toEqual({
      ok: false,
      reason: "task.merged can't apply: #12 isn't merging.",
    });
  });
});

describe("task.merge_failed", () => {
  test("queues the task for a new agent with the failure, counting one attempt", () => {
    expect(replay(...merging, { type: "task.merge_failed", failure: mergeFailed })).toMatchObject({
      phase: "in_progress",
      worktree,
      step: { kind: "queued" },
      attempts: 1,
      lastFailure: mergeFailed,
      note: null,
    });
  });

  test("is refused before the merge started", () => {
    const failed = event({ type: "task.merge_failed", failure: mergeFailed });
    expect(evolveTask(replay(...awaitingMergeApproval), failed)).toEqual({
      ok: false,
      reason: "task.merge_failed can't apply: #12 isn't merging.",
    });
  });
});

describe("task.merge_sent_back", () => {
  test("queues the task for a new agent with your note, without counting an attempt", () => {
    const task = replay(...awaitingMergeApproval, {
      type: "task.merge_sent_back",
      note: "Don't touch login.",
    });
    expect(task).toMatchObject({
      phase: "in_progress",
      worktree,
      step: { kind: "queued" },
      attempts: 0,
      lastFailure: null,
      note: "Don't touch login.",
    });
  });

  test("keeps the note until the next report of done", () => {
    const task = replay(
      ...awaitingMergeApproval,
      { type: "task.merge_sent_back", note: "Don't touch login." },
      { type: "task.dispatch_started" },
      { type: "task.dispatched", session },
    );
    expect(task).toMatchObject({ step: { kind: "running", session }, note: "Don't touch login." });
    const done = replay(
      ...awaitingMergeApproval,
      { type: "task.merge_sent_back", note: "Don't touch login." },
      { type: "task.dispatch_started" },
      { type: "task.dispatched", session },
      { type: "task.done_reported", branch: branchFacts, gate: "local" },
      { type: "task.gate_failed", failure: localFailed },
    );
    expect(done).toMatchObject({ phase: "in_progress", note: null });
  });

  test("is refused unless the merge is waiting for approval", () => {
    const sentBack = event({ type: "task.merge_sent_back", note: "Don't touch login." });
    expect(evolveTask(replay(...merging), sentBack)).toEqual({
      ok: false,
      reason: "task.merge_sent_back can't apply: #12 isn't waiting for merge approval.",
    });
  });
});

const specQuestion = {
  from: "spec" as const,
  text: "Include deleted rows?",
  options: ["Yes", "No"],
  askedAt: at,
};
const developQuestion = { ...specQuestion, from: "develop" as const };
const specRunning: EventBody[] = [
  ...inSpec,
  { type: "task.dispatch_started" },
  { type: "task.spec_session_started", session },
];
const capReached = { kind: "safety_cap" as const, usage: { tokens: 200_000, ms: 0 } };
const outOfAttempts = { kind: "out_of_attempts" as const, failure: localFailed };

describe("task.question_asked", () => {
  test("stores the question", () => {
    expect(
      replay(...specRunning, { type: "task.question_asked", question: specQuestion }),
    ).toMatchObject({ question: specQuestion });
  });

  test("is refused while another question is open", () => {
    const task = replay(...specRunning, { type: "task.question_asked", question: specQuestion });
    const second = event({ type: "task.question_asked", question: specQuestion });
    expect(evolveTask(task, second)).toEqual({
      ok: false,
      reason: "task.question_asked can't apply: #12 already has an open question.",
    });
  });

  test("is refused from the spec agent outside Spec", () => {
    const asked = event({ type: "task.question_asked", question: specQuestion });
    expect(evolveTask(replay(...inProgress), asked)).toEqual({
      ok: false,
      reason: "task.question_asked can't apply: a spec question can't be open in In progress.",
    });
  });

  test("is refused from the develop agent outside In progress and Checks", () => {
    const asked = event({ type: "task.question_asked", question: developQuestion });
    expect(evolveTask(replay(...specRunning), asked)).toEqual({
      ok: false,
      reason: "task.question_asked can't apply: a develop question can't be open in Spec.",
    });
  });
});

describe("task.question_answered", () => {
  test("clears the question", () => {
    expect(
      replay(
        ...specRunning,
        { type: "task.question_asked", question: specQuestion },
        { type: "task.question_answered", text: "No" },
      ),
    ).toMatchObject({ question: null });
  });

  test("is refused when no question is open", () => {
    expect(
      evolveTask(replay(...specRunning), event({ type: "task.question_answered", text: "No" })),
    ).toEqual({
      ok: false,
      reason: "task.question_answered can't apply: #12 has no open question.",
    });
  });
});

describe("task.blocked", () => {
  test("stops the agent in In progress but keeps the worktree", () => {
    expect(replay(...inProgress, { type: "task.blocked", reason: capReached })).toMatchObject({
      phase: "in_progress",
      blocked: capReached,
      worktree,
      step: { kind: "queued" },
    });
  });

  test("sends a task blocked in Checks back to In progress, keeping its attempts", () => {
    const task = replay(
      ...inChecks,
      { type: "task.gate_failed", failure: localFailed },
      { type: "task.done_reported", branch: branchFacts, gate: "local" },
      { type: "task.blocked", reason: capReached },
    );
    expect(task).toMatchObject({
      phase: "in_progress",
      blocked: capReached,
      worktree,
      step: { kind: "queued" },
      attempts: 1,
    });
  });

  test("stops the spec agent in Spec, keeping the spec", () => {
    const task = replay(...specRunning, { type: "task.blocked", reason: capReached });
    expect(task).toMatchObject({ phase: "spec", blocked: capReached, step: { kind: "queued" } });
  });

  test("clears an open question, since the agent that asked it is stopped", () => {
    const task = replay(
      ...specRunning,
      { type: "task.question_asked", question: specQuestion },
      { type: "task.blocked", reason: capReached },
    );
    expect(task.question).toBeNull();
  });

  test("is refused for a task that is already blocked", () => {
    const task = replay(...inProgress, { type: "task.blocked", reason: capReached });
    expect(evolveTask(task, event({ type: "task.blocked", reason: outOfAttempts }))).toEqual({
      ok: false,
      reason: "task.blocked can't apply: #12 is already blocked.",
    });
  });

  test("is refused in Idea, where no work is running", () => {
    expect(
      evolveTask(replay(created), event({ type: "task.blocked", reason: capReached })),
    ).toEqual({
      ok: false,
      reason: "task.blocked can't apply to #12 in Idea.",
    });
  });
});

describe("task.unblocked", () => {
  const usage = { tokens: 250_000, ms: 30 * 60_000 };
  const blockedAfterFailures: EventBody[] = [
    ...inChecks,
    { type: "task.gate_failed", failure: localFailed },
    { type: "task.usage_recorded", usage },
    { type: "task.blocked", reason: outOfAttempts },
  ];

  test("clears the flag and resets the attempts and the safety cap", () => {
    expect(replay(...blockedAfterFailures, { type: "task.unblocked" })).toMatchObject({
      phase: "in_progress",
      blocked: null,
      attempts: 0,
      usage,
      usageAtRetry: usage,
      step: { kind: "queued" },
    });
  });

  test("is refused for a task that isn't blocked", () => {
    expect(evolveTask(replay(...inProgress), event({ type: "task.unblocked" }))).toEqual({
      ok: false,
      reason: "task.unblocked can't apply: #12 isn't blocked.",
    });
  });
});

describe("task.usage_recorded", () => {
  test("replaces the running totals", () => {
    const usage = { tokens: 12_000, ms: 90_000 };
    expect(replay(...inProgress, { type: "task.usage_recorded", usage })).toMatchObject({
      usage,
      usageAtRetry: { tokens: 0, ms: 0 },
    });
  });
});

const project = ProjectId.parse("reports");
const done: EventBody[] = [...merging, { type: "task.merged", commit }];
const dropped: EventBody[] = [...inProgress, { type: "task.dropped" }];

describe("task.project_changed", () => {
  test("moves the task to another project, keeping its phase", () => {
    expect(replay(...inProgress, { type: "task.project_changed", project })).toMatchObject({
      phase: "in_progress",
      project,
    });
  });
});

describe("task.dropped", () => {
  test("ends the task in Dropped, clearing its flags", () => {
    const task = replay(
      ...inProgress,
      { type: "task.question_asked", question: developQuestion },
      { type: "task.dropped" },
    );
    expect(task).toMatchObject({ phase: "dropped", question: null, blocked: null });
    expect(task).not.toHaveProperty("worktree");
  });

  test("is refused for a task that is Done", () => {
    expect(evolveTask(replay(...done), event({ type: "task.dropped" }))).toEqual({
      ok: false,
      reason: "task.dropped can't apply to #12 in Done.",
    });
  });
});

describe("a dropped task", () => {
  test("refuses every event, since Dropped is final", () => {
    expect(
      evolveTask(replay(...dropped), event({ type: "task.project_changed", project })),
    ).toEqual({
      ok: false,
      reason: "task.project_changed can't apply to #12 in Dropped.",
    });
  });
});

describe("reverting", () => {
  test("task.revert_started keeps the task Done, waiting on the revert's request", () => {
    const task = replay(...done, { type: "task.revert_started", reason: "Broken." });
    // The revert takes the next request number after the merge's.
    expect(task.phase === "done" && task.step).toEqual({
      kind: "reverting",
      reason: "Broken.",
      request: task.requests,
    });
  });

  test("task.revert_failed keeps the task Done and records why", () => {
    const task = replay(
      ...done,
      { type: "task.revert_started", reason: "Broken." },
      { type: "task.revert_failed", summary: "Conflicts in export.ts" },
    );
    expect(task).toMatchObject({
      phase: "done",
      step: { kind: "revert_failed", summary: "Conflicts in export.ts" },
    });
  });

  test("task.reverted takes the task back to Spec, with the reason as the note", () => {
    const reason = "Export breaks on empty reports.";
    const started = { type: "task.revert_started" as const, reason };
    expect(replay(...done, started, { type: "task.reverted", commit, reason })).toMatchObject({
      phase: "spec",
      spec,
      note: reason,
      step: { kind: "queued" },
    });
  });

  test("is refused outside Done", () => {
    const reverted = event({ type: "task.reverted", commit, reason: "Broken." });
    expect(evolveTask(replay(...inProgress), reverted)).toEqual({
      ok: false,
      reason: "task.reverted can't apply to #12 in In progress.",
    });
  });
});

describe("task.spec_sent_back from a later phase", () => {
  const note = "Also export the totals row.";

  test("takes a blocked task in In progress back to Spec, clearing the block", () => {
    const task = replay(
      ...inProgress,
      { type: "task.blocked", reason: capReached },
      { type: "task.spec_sent_back", note },
    );
    expect(task).toMatchObject({
      phase: "spec",
      spec,
      note,
      step: { kind: "queued" },
      blocked: null,
    });
    expect(task).not.toHaveProperty("worktree");
  });

  test("takes a task in Checks back to Spec", () => {
    expect(replay(...inChecks, { type: "task.spec_sent_back", note })).toMatchObject({
      phase: "spec",
      spec,
      note,
    });
  });

  test("gives the next build a new number, so its branch name differs", () => {
    const task = replay(
      ...inProgress,
      { type: "task.spec_sent_back", note },
      { type: "task.specced", spec, by: "agent" },
      { type: "task.ready" },
      { type: "task.dispatch_started" },
    );
    expect(task.builds).toBe(2);
  });

  test("is refused in Idea, which has no spec to send back", () => {
    expect(evolveTask(replay(created), event({ type: "task.spec_sent_back", note }))).toEqual({
      ok: false,
      reason: "task.spec_sent_back can't apply to #12 in Idea.",
    });
  });
});

describe("a retry in In progress", () => {
  const retried: EventBody[] = [
    ...inProgress,
    { type: "task.blocked", reason: capReached },
    { type: "task.unblocked" },
  ];
  const session2 = SessionId.parse("session-2");

  test("starts a new agent in the same worktree", () => {
    const task = replay(
      ...retried,
      { type: "task.dispatch_started" },
      { type: "task.dispatched", session: session2 },
    );
    expect(task).toMatchObject({
      phase: "in_progress",
      worktree,
      step: { kind: "running", session: session2 },
    });
  });

  test("marks the agent as starting until it runs", () => {
    expect(replay(...retried, { type: "task.dispatch_started" })).toMatchObject({
      phase: "in_progress",
      step: { kind: "starting" },
    });
  });

  test("refuses a new agent while one is running", () => {
    expect(
      evolveTask(replay(...inProgress), event({ type: "task.dispatched", session: session2 })),
    ).toEqual({
      ok: false,
      reason: "task.dispatched can't apply: #12 isn't starting an agent.",
    });
  });
});

describe("the reason for the last block", () => {
  const gaveUp = { kind: "agent_gave_up" as const, message: "Need database credentials" };

  test("is kept after a retry, for the next agent", () => {
    const task = replay(
      ...inProgress,
      { type: "task.blocked", reason: gaveUp },
      { type: "task.unblocked" },
    );
    expect(task).toMatchObject({ phase: "in_progress", blocked: null, lastBlock: gaveUp });
  });

  test("is cleared once the agent reports done", () => {
    const task = replay(
      ...inProgress,
      { type: "task.blocked", reason: gaveUp },
      { type: "task.unblocked" },
      { type: "task.dispatch_started" },
      { type: "task.dispatched", session },
      { type: "task.done_reported", branch: branchFacts, gate: "local" },
      { type: "task.gate_failed", failure: localFailed },
    );
    expect(task).toMatchObject({ phase: "in_progress", lastBlock: null });
  });
});

describe("leaving Checks", () => {
  test("leaves nothing of Checks behind on a merged task", () => {
    expect(replay(...merging, { type: "task.merged", commit })).not.toHaveProperty("request");
  });

  test("leaves nothing of Checks behind on a task sent back to its agent", () => {
    const task = replay(...inChecks, { type: "task.gate_failed", failure: localFailed });
    expect(task).not.toHaveProperty("request");
    expect(task).not.toHaveProperty("session");
    expect(task).not.toHaveProperty("branch");
  });
});
