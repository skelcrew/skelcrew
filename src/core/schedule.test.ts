import { describe, expect, test } from "bun:test";
import { evolveTask } from "./evolve";
import { ProjectId, SessionId, TaskId } from "./ids";
import { schedule } from "./schedule";
import type { Config, EventBody, Project, Spec, Task } from "./types";

const config: Config = {
  gates: ["local"],
  maxAttempts: 3,
  maxRunning: 2,
  specApproval: "always",
  criticalPaths: [],
  safetyCap: { tokens: 200_000, ms: 60 * 60_000 },
};

const reports = ProjectId.parse("reports");
const archive = ProjectId.parse("archive");
const projects = new Map<ProjectId, Project>([
  [
    reports,
    { id: reports, name: "Reports", goal: "Better reports", status: "active", createdAt: 0 },
  ],
  [archive, { id: archive, name: "Archive", goal: "Old ideas", status: "parked", createdAt: 0 }],
]);

const spec: Spec = { scope: "Do it.", acceptance: ["It is done."], openQuestions: [] };
const session = SessionId.parse("session-1");
const worktree = { path: "/repo/.worktrees/1", branch: "task/1-x" };

// Builds task #n, created at time n, by replaying events through evolveTask.
function task(n: number, project: ProjectId | null, ...bodies: EventBody[]): Task {
  const created: EventBody = { type: "task.created", title: `Task ${n}`, project, source: null };
  let current: Task | null = null;
  for (const body of [created, ...bodies]) {
    const result = evolveTask(current, { ...body, v: 1, taskId: TaskId.parse(n), at: n });
    if (!result.ok) throw new Error(result.reason);
    current = result.task;
  }
  if (current === null) throw new Error("unreachable");
  return current;
}

// The events that bring a task to each state.
const specQueued: EventBody[] = [{ type: "task.spec_requested" }];
const specRunning: EventBody[] = [
  ...specQueued,
  { type: "task.dispatch_started" },
  { type: "task.spec_session_started", session },
];
const awaitingApproval: EventBody[] = [...specRunning, { type: "task.specced", spec, by: "agent" }];
const readyQueued: EventBody[] = [...awaitingApproval, { type: "task.ready" }];
const creatingWorktree: EventBody[] = [...readyQueued, { type: "task.dispatch_started" }];
const developRunning: EventBody[] = [
  ...creatingWorktree,
  { type: "task.worktree_created", worktree },
  { type: "task.dispatched", session },
];
const blocked: EventBody[] = [
  ...developRunning,
  { type: "task.blocked", reason: { kind: "agent_gave_up", message: "Stuck." } },
];
const retried: EventBody[] = [...blocked, { type: "task.unblocked" }];
const awaitingMerge: EventBody[] = [
  ...developRunning,
  { type: "task.done_reported", branch: { commits: 1, changedFiles: ["a.ts"] }, gate: "local" },
  { type: "task.gate_passed", gate: "local", next: null },
  { type: "task.checks_passed" },
  { type: "task.merge_approval_requested", criticalFiles: ["a.ts"] },
];

const ids = (...numbers: number[]) => numbers.map((n) => TaskId.parse(n));

describe("schedule", () => {
  test("starts waiting tasks up to max_running", () => {
    const tasks = [
      task(1, null, ...specQueued),
      task(2, null, ...specQueued),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config)).toEqual(ids(1, 2));
  });

  test("counts running agents against the limit", () => {
    const tasks = [
      task(1, null, ...developRunning),
      task(2, null, ...specQueued),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config)).toEqual(ids(2));
  });

  test("counts agents and worktrees that are still starting", () => {
    const tasks = [
      task(1, null, ...creatingWorktree),
      task(2, null, ...specQueued, { type: "task.dispatch_started" }),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config)).toEqual([]);
  });

  test("doesn't count an agent whose merge waits for approval", () => {
    const tasks = [
      task(1, null, ...awaitingMerge),
      task(2, null, ...developRunning),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config)).toEqual(ids(3));
  });

  test("skips blocked tasks, which hold no slot", () => {
    const tasks = [task(1, null, ...blocked), task(2, null, ...specQueued)];
    expect(schedule(tasks, projects, config)).toEqual(ids(2));
  });

  test("skips tasks in a parked project, but starts tasks in active projects or none", () => {
    const tasks = [
      task(1, archive, ...specQueued),
      task(2, reports, ...specQueued),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config)).toEqual(ids(2, 3));
  });

  test("ignores tasks that aren't waiting for a slot", () => {
    const tasks = [task(1, null), task(2, null, ...awaitingApproval)];
    expect(schedule(tasks, projects, config)).toEqual([]);
  });

  test("finishes before it starts: In progress, then Ready, then Spec", () => {
    const tasks = [
      task(1, null, ...specQueued),
      task(2, null, ...readyQueued),
      task(3, null, ...retried),
    ];
    expect(schedule(tasks, projects, { ...config, maxRunning: 3 })).toEqual(ids(3, 2, 1));
  });

  test("starts the oldest task first within a phase", () => {
    const tasks = [
      task(3, null, ...readyQueued),
      task(1, null, ...readyQueued),
      task(2, null, ...readyQueued),
    ];
    expect(schedule(tasks, projects, config)).toEqual(ids(1, 2));
  });
});
