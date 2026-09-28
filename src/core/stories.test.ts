// Golden stories: whole task lifecycles, one line per input. Each line says
// what was sent, the events it caused, and after "|" the commands for the
// daemon. The expected lines were written by hand from docs/spec.md, not
// copied from the code's output.
//
// A second check saves each story's full events to a snapshot file. It
// catches any change to the shape of the event log, which must stay
// readable for good. Update it only when the change is intended, with
// `bun test --update-snapshots`, and say why in the commit.

import { describe, expect, test } from "bun:test";
import { decideTask } from "./decide";
import { evolveTask } from "./evolve";
import { CommitSha, type ProjectId, SessionId, TaskId } from "./ids";
import type { BranchFacts, Command, Config, Input, Project, Spec, Task, TaskEvent } from "./types";

const config: Config = {
  gates: ["local", "review"],
  maxAttempts: 3,
  maxRunning: 2,
  specApproval: "always",
  criticalPaths: ["src/auth/**"],
  safetyCap: { tokens: 200_000, ms: 60 * 60_000 },
};
const projects = new Map<ProjectId, Project>();
const id = TaskId.parse(12);

const spec: Spec = {
  scope: "Add a CSV export button to the reports page.",
  acceptance: ["Clicking Export downloads a CSV of the visible rows."],
  openQuestions: [],
};
const worktree = { path: "/repo/.worktrees/12", branch: "task/12-csv-export" };
const specAgent = SessionId.parse("spec-1");
const developAgent = SessionId.parse("develop-1");
const commit = CommitSha.parse("a".repeat(40));
const exportBranch: BranchFacts = { commits: 3, changedFiles: ["src/reports/export.ts"] };
const authBranch: BranchFacts = {
  commits: 2,
  changedFiles: ["src/reports/export.ts", "src/auth/login.ts"],
};

// ---------------------------------------------------------------------------
// The inputs, named so a story reads like what happens
// ---------------------------------------------------------------------------

const add: Input = {
  by: "human",
  type: "add",
  title: "CSV export",
  project: null,
  requestSpec: false,
};
const requestSpec: Input = { by: "human", type: "request_spec" };
const start: Input = { by: "system", type: "start" };
const started = (session: SessionId): Input => ({ by: "plugin", type: "session_started", session });
const submitSpec: Input = { by: "agent", type: "submit_spec", spec };
const approveSpec: Input = { by: "human", type: "approve_spec" };
const worktreeCreated: Input = { by: "plugin", type: "worktree_created", worktree, build: 1 };
const reportDone = (branch: BranchFacts): Input => ({ by: "agent", type: "report_done", branch });
const gate = (name: "local" | "review", ok: boolean): Input => ({
  by: "plugin",
  type: "gate_result",
  gate: name,
  ok,
  summary: ok ? "Passed." : "2 tests failed in export.test.ts",
});
const merged: Input = { by: "plugin", type: "merged", commit };
const retry: Input = { by: "human", type: "retry" };
const approveMerge: Input = { by: "human", type: "approve_merge" };
const revert: Input = { by: "human", type: "revert", reason: "Export breaks on empty reports." };

// Up to a running develop agent: the start every story shares.
const toInProgress: Input[] = [
  add,
  requestSpec,
  start,
  started(specAgent),
  submitSpec,
  approveSpec,
  start,
  worktreeCreated,
  started(developAgent),
];

const toInProgressLines = [
  'human add "CSV export" → task.created',
  "human request_spec → task.spec_requested",
  "system start → task.dispatch_started | start_spec_session",
  "plugin session_started → task.spec_session_started",
  "agent submit_spec → task.specced | stop_session",
  "human approve_spec → task.ready",
  "system start → task.dispatch_started | create_worktree",
  "plugin worktree_created → task.worktree_created | start_develop_session",
  "plugin session_started → task.dispatched",
];

// ---------------------------------------------------------------------------
// Running a story
// ---------------------------------------------------------------------------

type Told = { lines: string[]; events: TaskEvent[]; task: Task | null };

// Sends each input the way the daemon does, and writes one line per input.
function tell(inputs: Input[]): Told {
  let task: Task | null = null;
  const lines: string[] = [];
  const events: TaskEvent[] = [];
  inputs.forEach((input, i) => {
    const decision = decideTask(task, { taskId: id, at: 1_000 * (i + 1), input }, config, projects);
    if (!decision.ok) {
      lines.push(`${label(input)} → rejected: ${decision.rejection.reason}`);
      return;
    }
    for (const event of decision.events) {
      const result = evolveTask(task, event);
      if (!result.ok) throw new Error(result.reason);
      task = result.task;
      events.push(event);
    }
    lines.push(line(input, decision.events, decision.commands));
  });
  return { lines, events, task };
}

function label(input: Input): string {
  switch (input.type) {
    case "add":
      return `${input.by} add "${input.title}"`;
    case "gate_result":
      return `${input.by} gate_result ${input.gate} ${input.ok ? "passed" : "failed"}`;
    case "report_done":
      return `${input.by} report_done ${input.branch.changedFiles.join(" ")}`;
    default:
      return `${input.by} ${input.type}`;
  }
}

function line(input: Input, events: TaskEvent[], commands: Command[]): string {
  const said = events.map((e) => e.type).join(", ");
  const todo = commands.map((c) => c.type).join(", ");
  return `${label(input)} → ${said}${todo === "" ? "" : ` | ${todo}`}`;
}

// ---------------------------------------------------------------------------
// The stories
// ---------------------------------------------------------------------------

describe("golden stories", () => {
  test("happy path: from an idea to a merged commit", () => {
    const told = tell([
      ...toInProgress,
      reportDone(exportBranch),
      gate("local", true),
      gate("review", true),
      merged,
    ]);
    expect(told.lines).toEqual([
      ...toInProgressLines,
      "agent report_done src/reports/export.ts → task.done_reported | run_gate",
      "plugin gate_result local passed → task.gate_passed | run_gate",
      "plugin gate_result review passed → task.gate_passed, task.checks_passed, task.merge_started | stop_session, merge",
      "plugin merged → task.merged | remove_worktree",
    ]);
    expect(told.task).toMatchObject({ phase: "done", mergeCommit: commit });
    expect(told.events).toMatchSnapshot();
  });

  test("blocked: the local gate fails three times, you retry, and it merges", () => {
    const told = tell([
      ...toInProgress,
      reportDone(exportBranch),
      gate("local", false),
      reportDone(exportBranch),
      gate("local", false),
      reportDone(exportBranch),
      gate("local", false),
      reportDone(exportBranch),
      retry,
      start,
      started(developAgent),
      reportDone(exportBranch),
      gate("local", true),
      gate("review", true),
      merged,
    ]);
    expect(told.lines).toEqual([
      ...toInProgressLines,
      "agent report_done src/reports/export.ts → task.done_reported | run_gate",
      "plugin gate_result local failed → task.gate_failed | send_to_session",
      "agent report_done src/reports/export.ts → task.done_reported | run_gate",
      "plugin gate_result local failed → task.gate_failed | send_to_session",
      "agent report_done src/reports/export.ts → task.done_reported | run_gate",
      "plugin gate_result local failed → task.gate_failed, task.blocked | stop_session",
      "agent report_done src/reports/export.ts → rejected: #12 has no develop agent running.",
      "human retry → task.unblocked",
      "system start → task.dispatch_started | start_develop_session",
      "plugin session_started → task.dispatched",
      "agent report_done src/reports/export.ts → task.done_reported | run_gate",
      "plugin gate_result local passed → task.gate_passed | run_gate",
      "plugin gate_result review passed → task.gate_passed, task.checks_passed, task.merge_started | stop_session, merge",
      "plugin merged → task.merged | remove_worktree",
    ]);
    expect(told.task).toMatchObject({ phase: "done" });
    expect(told.events).toMatchSnapshot();
  });

  test("escalated: a critical file waits for your approval, then merges", () => {
    const told = tell([
      ...toInProgress,
      reportDone(authBranch),
      gate("local", true),
      gate("review", true),
      approveMerge,
      merged,
    ]);
    expect(told.lines).toEqual([
      ...toInProgressLines,
      "agent report_done src/reports/export.ts src/auth/login.ts → task.done_reported | run_gate",
      "plugin gate_result local passed → task.gate_passed | run_gate",
      "plugin gate_result review passed → task.gate_passed, task.checks_passed, task.merge_approval_requested | stop_session",
      "human approve_merge → task.merge_started | merge",
      "plugin merged → task.merged | remove_worktree",
    ]);
    expect(told.task).toMatchObject({ phase: "done" });
    expect(told.events).toMatchSnapshot();
  });

  test("reverted: a merged task is undone and goes back to Spec with the reason", () => {
    const told = tell([
      ...toInProgress,
      reportDone(exportBranch),
      gate("local", true),
      gate("review", true),
      merged,
      revert,
      start,
    ]);
    expect(told.lines).toEqual([
      ...toInProgressLines,
      "agent report_done src/reports/export.ts → task.done_reported | run_gate",
      "plugin gate_result local passed → task.gate_passed | run_gate",
      "plugin gate_result review passed → task.gate_passed, task.checks_passed, task.merge_started | stop_session, merge",
      "plugin merged → task.merged | remove_worktree",
      "human revert → task.reverted | revert",
      "system start → task.dispatch_started | start_spec_session",
    ]);
    expect(told.task).toMatchObject({
      phase: "spec",
      spec,
      note: "Export breaks on empty reports.",
    });
    expect(told.events).toMatchSnapshot();
  });
});
