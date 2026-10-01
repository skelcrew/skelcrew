import { describe, expect, test } from "bun:test";
import { config as base, head } from "../test/fixtures";
import { evolveTask } from "./evolve";
import { ProjectId, SessionId, TaskId } from "./ids";
import { schedule } from "./schedule";
import type { Config, EventBody, Project, Spec, Task } from "./types";

const config: Config = { ...base, gates: ["local"], criticalPaths: [] };

const reports = ProjectId.parse("reports");
const someday = ProjectId.parse("someday");
const projects = new Map<ProjectId, Project>([
  [
    reports,
    { id: reports, name: "Reports", goal: "Better reports", status: "active", createdAt: 0 },
  ],
  [someday, { id: someday, name: "Someday", goal: "Old ideas", status: "archived", createdAt: 0 }],
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
// Request numbers follow the lifecycle: 1 starts the spec agent, 2 creates
// the worktree, 3 starts the develop agent, 4 runs the gate, 5 merges.
const specRunning: EventBody[] = [
  ...specQueued,
  { type: "task.dispatch_started", request: 1 },
  { type: "task.spec_session_started", session },
];
const awaitingApproval: EventBody[] = [...specRunning, { type: "task.specced", spec, by: "agent" }];
const readyQueued: EventBody[] = [...awaitingApproval, { type: "task.ready" }];
const creatingWorktree: EventBody[] = [
  ...readyQueued,
  { type: "task.dispatch_started", request: 2 },
];
const developRunning: EventBody[] = [
  ...creatingWorktree,
  { type: "task.worktree_created", worktree, request: 3 },
  { type: "task.dispatched", session },
];
const blocked: EventBody[] = [
  ...developRunning,
  { type: "task.blocked", reason: { kind: "agent_gave_up", message: "Stuck." } },
];
const retried: EventBody[] = [...blocked, { type: "task.unblocked" }];
const awaitingMerge: EventBody[] = [
  ...developRunning,
  {
    type: "task.done_reported",
    branch: { head, commits: 1, changedFiles: ["a.ts"] },
    gate: "local",
    request: 4,
  },
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
    expect(schedule(tasks, projects, config, 0)).toEqual(ids(1, 2));
  });

  test("counts running agents against the limit", () => {
    const tasks = [
      task(1, null, ...developRunning),
      task(2, null, ...specQueued),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config, 0)).toEqual(ids(2));
  });

  test("counts a spec session you claimed against the limit", () => {
    const you = SessionId.parse("you-1");
    const tasks = [
      task(1, null, ...specQueued, { type: "task.claimed", session: you, request: null }),
      task(2, null, ...specQueued),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config, 0)).toEqual(ids(2));
  });

  test("counts starts still in flight, which the daemon reports", () => {
    const tasks = [
      task(1, null, ...creatingWorktree),
      task(2, null, ...specQueued, { type: "task.dispatch_started", request: 1 }),
      task(3, null, ...specQueued),
    ];
    // Two starts are out: #1's worktree and #2's spec agent.
    expect(schedule(tasks, projects, config, 2)).toEqual([]);
  });

  test("keeps the slot of a start still in flight for a task that was dropped", () => {
    // #1's agent was starting when #1 was dropped. It hasn't reported in yet.
    const tasks = [
      task(
        1,
        null,
        ...specQueued,
        { type: "task.dispatch_started", request: 1 },
        { type: "task.dropped" },
      ),
      task(2, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, { ...config, maxRunning: 1 }, 1)).toEqual([]);
  });

  test("doesn't count a task merging, since its agent is stopped", () => {
    const merging: EventBody[] = [
      ...developRunning,
      {
        type: "task.done_reported",
        branch: { head, commits: 1, changedFiles: ["a.ts"] },
        gate: "local",
        request: 4,
      },
      { type: "task.gate_passed", gate: "local", next: null },
      { type: "task.checks_passed" },
      { type: "task.merge_started", request: 5 },
    ];
    const tasks = [
      task(1, null, ...merging),
      task(2, null, ...developRunning),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config, 0)).toEqual(ids(3));
  });

  test("doesn't count a task whose merge waits for approval, since its agent is stopped", () => {
    const tasks = [
      task(1, null, ...awaitingMerge),
      task(2, null, ...developRunning),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config, 0)).toEqual(ids(3));
  });

  test("skips blocked tasks, which hold no slot", () => {
    const tasks = [task(1, null, ...blocked), task(2, null, ...specQueued)];
    expect(schedule(tasks, projects, config, 0)).toEqual(ids(2));
  });

  test("skips tasks in an archived project, but starts tasks in active projects or none", () => {
    const tasks = [
      task(1, someday, ...specQueued),
      task(2, reports, ...specQueued),
      task(3, null, ...specQueued),
    ];
    expect(schedule(tasks, projects, config, 0)).toEqual(ids(2, 3));
  });

  test("ignores tasks that aren't waiting for a slot", () => {
    const tasks = [task(1, null), task(2, null, ...awaitingApproval)];
    expect(schedule(tasks, projects, config, 0)).toEqual([]);
  });

  test("finishes before it starts: In progress, then Ready, then Spec", () => {
    const tasks = [
      task(1, null, ...specQueued),
      task(2, null, ...readyQueued),
      task(3, null, ...retried),
    ];
    expect(schedule(tasks, projects, { ...config, maxRunning: 3 }, 0)).toEqual(ids(3, 2, 1));
  });

  test("starts the oldest task first within a phase", () => {
    const tasks = [
      task(3, null, ...readyQueued),
      task(1, null, ...readyQueued),
      task(2, null, ...readyQueued),
    ];
    expect(schedule(tasks, projects, config, 0)).toEqual(ids(1, 2));
  });
});
