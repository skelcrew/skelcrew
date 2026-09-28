import { describe, expect, test } from "bun:test";
import { agentOf, awaited, commit, config, id, session, spec, worktree } from "../test/fixtures";
import { decideTask } from "./decide";
import { evolveTask } from "./evolve";
import { CommitSha, ProjectId, SessionId, TaskId } from "./ids";
import { awaitedRequest, runningSession } from "./task";
import type {
  BlockReason,
  BranchFacts,
  Config,
  Decision,
  EventBody,
  Failure,
  Input,
  Project,
  Spec,
  Task,
  TaskEvent,
} from "./types";

const at = 5_000;

const reports = ProjectId.parse("reports");
const archive = ProjectId.parse("archive");
const projects = new Map<ProjectId, Project>([
  [
    reports,
    { id: reports, name: "Reports", goal: "Better reports", status: "active", createdAt: 0 },
  ],
  [archive, { id: archive, name: "Archive", goal: "Old ideas", status: "parked", createdAt: 0 }],
]);

// A step is an input, or a reply built from the task as it stands: replies
// answer the request the task is waiting on, the way the daemon matches them.
// Tests of late replies give an earlier request number instead.
type Step = Input | ((task: Task | null) => Input);

function send(task: Task | null, step: Step, withConfig: Config = config): Decision {
  const input = typeof step === "function" ? step(task) : step;
  return decideTask(task, { taskId: id, at, input }, withConfig, projects);
}

// Sends each input in turn and applies the accepted events with evolve, the
// way the daemon does. Fails the test if an input is rejected or evolve
// refuses one of decide's events, so tests can build a task in any phase.
function run(...steps: Step[]): Task {
  return runWith(config, ...steps);
}

function runWith(withConfig: Config, ...steps: Step[]): Task {
  let task: Task | null = null;
  for (const step of steps) {
    const decision = send(task, step, withConfig);
    if (!decision.ok) throw new Error(decision.rejection.reason);
    for (const event of decision.events) {
      const result = evolveTask(task, event);
      if (!result.ok) throw new Error(result.reason);
      task = result.task;
    }
  }
  if (task === null) throw new Error("run needs an input that creates the task");
  return task;
}

function stamped(body: EventBody): TaskEvent {
  return { ...body, v: 1, taskId: id, at };
}

const add: Input = {
  by: "human",
  type: "add",
  title: "CSV export",
  project: null,
  requestSpec: false,
};
const requestSpec: Input = { by: "human", type: "request_spec" };

describe("add", () => {
  test("creates the task as an Idea, starting nothing", () => {
    expect(send(null, add)).toEqual({
      ok: true,
      events: [stamped({ type: "task.created", title: "CSV export", project: null, source: null })],
      commands: [],
    });
  });

  test("with --spec, also asks for a spec", () => {
    const decision = send(null, { ...add, requestSpec: true });
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual([
      "task.created",
      "task.spec_requested",
    ]);
  });

  test("puts the task in a project", () => {
    expect(run({ ...add, project: reports }).project).toBe(reports);
  });

  test("accepts a parked project, where the idea waits without using agents", () => {
    expect(run({ ...add, project: archive }).project).toBe(archive);
  });

  test("is rejected for a project that doesn't exist", () => {
    expect(send(null, { ...add, project: ProjectId.parse("billing") })).toEqual({
      ok: false,
      rejection: { input: "add", reason: "There is no project called billing." },
    });
  });

  test("is rejected without a title", () => {
    expect(send(null, { ...add, title: "  " })).toEqual({
      ok: false,
      rejection: { input: "add", reason: "A task needs a title." },
    });
  });

  test("is rejected when the task already exists", () => {
    expect(send(run(add), add)).toEqual({
      ok: false,
      rejection: { input: "add", reason: "#12 already exists." },
    });
  });
});

describe("issue_delegated", () => {
  const source = { label: "GitHub #40", url: "https://github.com/acme/app/issues/40" };
  const delegated: Input = {
    by: "plugin",
    type: "issue_delegated",
    title: "CSV export",
    source,
    project: null,
  };

  test("creates the task with a link to the issue, and asks for a spec", () => {
    expect(send(null, delegated)).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.created", title: "CSV export", project: null, source }),
        stamped({ type: "task.spec_requested" }),
      ],
      commands: [],
    });
  });

  test("is rejected for a project that doesn't exist", () => {
    const decision = send(null, { ...delegated, project: ProjectId.parse("billing") });
    expect(decision.ok).toBe(false);
  });
});

describe("request_spec", () => {
  test("moves an Idea to Spec, where it waits for a free slot", () => {
    expect(send(run(add), requestSpec)).toEqual({
      ok: true,
      events: [stamped({ type: "task.spec_requested" })],
      commands: [],
    });
  });

  test("is rejected outside Idea", () => {
    expect(send(run(add, requestSpec), requestSpec)).toEqual({
      ok: false,
      rejection: { input: "request_spec", reason: "#12 is in Spec. Only an Idea can be specced." },
    });
  });
});

describe("drop", () => {
  test("ends an Idea in Dropped", () => {
    expect(send(run(add), { by: "human", type: "drop" })).toEqual({
      ok: true,
      events: [stamped({ type: "task.dropped" })],
      commands: [],
    });
  });
});

describe("any input", () => {
  test("is rejected for a task that doesn't exist", () => {
    expect(send(null, requestSpec)).toEqual({
      ok: false,
      rejection: { input: "request_spec", reason: "#12 doesn't exist." },
    });
  });

  test("is rejected for a dropped task", () => {
    const dropped = run(add, { by: "human", type: "drop" });
    expect(send(dropped, requestSpec)).toEqual({
      ok: false,
      rejection: { input: "request_spec", reason: "#12 was dropped." },
    });
  });
});

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

const neverApprove: Config = { ...config, specApproval: "never" };

const start: Input = { by: "system", type: "start" };
const sessionStarted: Step = (t) => ({
  by: "plugin",
  type: "session_started",
  request: awaited(t),
  session,
});
const startFailed: Step = (t) => ({
  by: "plugin",
  type: "session_failed",
  request: awaited(t),
  message: "herdr crashed",
});
const submitWith =
  (s: Spec): Step =>
  (t) => ({ by: "agent", type: "submit_spec", session: agentOf(t), spec: s });
const submit = submitWith(spec);
const approve: Input = { by: "human", type: "approve_spec" };
const sendBack = (note: string): Input => ({ by: "human", type: "revise_spec", note });
const provide: Input = { by: "human", type: "provide_spec", spec };

const inSpec = [add, requestSpec];
const specRunning = [...inSpec, start, sessionStarted];
const awaitingApproval = [...specRunning, submit];

describe("start in Spec", () => {
  test("starts a spec agent", () => {
    expect(send(run(...inSpec), start)).toEqual({
      ok: true,
      events: [stamped({ type: "task.dispatch_started", request: 1 })],
      commands: [{ type: "start_spec_session", taskId: id, request: 1, note: null }],
    });
  });

  test("passes your send-back note to the new spec agent", () => {
    const task = run(...awaitingApproval, sendBack("Also export the totals row."));
    const decision = send(task, start);
    expect(decision.ok && decision.commands).toEqual([
      {
        type: "start_spec_session",
        taskId: id,
        request: 2,
        note: "Also export the totals row.",
      },
    ]);
  });

  test("is rejected while an agent is already starting", () => {
    expect(send(run(...inSpec, start), start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#12 isn't waiting for a slot." },
    });
  });

  test("is rejected for a task in a parked project", () => {
    const task = run({ ...add, project: archive }, requestSpec);
    expect(send(task, start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#12 is in a parked project." },
    });
  });

  test("is rejected for a blocked task", () => {
    const task = run(...inSpec, start, startFailed);
    expect(send(task, start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#12 is blocked." },
    });
  });
});

describe("session_started in Spec", () => {
  test("records the running spec agent", () => {
    expect(send(run(...inSpec, start), sessionStarted)).toEqual({
      ok: true,
      events: [stamped({ type: "task.spec_session_started", session })],
      commands: [],
    });
  });
});

describe("session_failed in Spec", () => {
  test("blocks the task with the reason", () => {
    expect(send(run(...inSpec, start), startFailed)).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.blocked",
          reason: { kind: "session_failed", message: "herdr crashed" },
        }),
      ],
      commands: [],
    });
  });
});

describe("submit_spec", () => {
  test("stores a complete spec, stops the agent, and waits for your approval", () => {
    expect(send(run(...specRunning), submit)).toEqual({
      ok: true,
      events: [stamped({ type: "task.specced", spec, by: "agent" })],
      commands: [{ type: "stop_session", session }],
    });
  });

  test("never makes the task Ready by itself when approval is required", () => {
    expect(run(...awaitingApproval).phase).toBe("spec");
  });

  test("moves the task straight to Ready when spec_approval is never", () => {
    const decision = send(runWith(neverApprove, ...specRunning), submit, neverApprove);
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual([
      "task.specced",
      "task.ready",
    ]);
  });

  test("is rejected with every reason when the spec is incomplete", () => {
    const incomplete = submitWith({
      ...spec,
      acceptance: [],
      openQuestions: ["Include deleted rows?"],
    });
    expect(send(run(...specRunning), incomplete)).toEqual({
      ok: false,
      rejection: {
        input: "submit_spec",
        reason:
          "The spec has no acceptance criteria. The spec has 1 open question: Include deleted rows?",
      },
    });
  });

  test("is rejected when no spec agent is running", () => {
    expect(send(run(...inSpec), submit)).toEqual({
      ok: false,
      rejection: { input: "submit_spec", reason: "#12 has no agent running." },
    });
  });
});

describe("provide_spec", () => {
  test("for an Idea, stores your spec and moves the task to Ready", () => {
    expect(send(run(add), provide)).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.spec_requested" }),
        stamped({ type: "task.specced", spec, by: "human" }),
        stamped({ type: "task.ready" }),
      ],
      commands: [],
    });
  });

  test("while a spec agent is running, stops it and uses your spec", () => {
    const decision = send(run(...specRunning), provide);
    expect(decision.ok && decision.commands).toEqual([{ type: "stop_session", session }]);
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual([
      "task.specced",
      "task.ready",
    ]);
  });

  test("is rejected when the spec is incomplete", () => {
    const incomplete: Input = { ...provide, spec: { ...spec, scope: "" } };
    expect(send(run(add), incomplete)).toEqual({
      ok: false,
      rejection: { input: "provide_spec", reason: "The spec has no scope." },
    });
  });
});

describe("approve_spec", () => {
  test("moves the task to Ready", () => {
    expect(send(run(...awaitingApproval), approve)).toEqual({
      ok: true,
      events: [stamped({ type: "task.ready" })],
      commands: [],
    });
  });

  test("is rejected when no spec is waiting for approval", () => {
    expect(send(run(...specRunning), approve)).toEqual({
      ok: false,
      rejection: { input: "approve_spec", reason: "#12's spec isn't waiting for approval." },
    });
  });
});

describe("revise_spec", () => {
  test("sends the spec back with your note", () => {
    expect(send(run(...awaitingApproval), sendBack("Also export the totals row."))).toEqual({
      ok: true,
      events: [stamped({ type: "task.spec_sent_back", note: "Also export the totals row." })],
      commands: [],
    });
  });

  test("is rejected without a note", () => {
    expect(send(run(...awaitingApproval), sendBack(" "))).toEqual({
      ok: false,
      rejection: { input: "revise_spec", reason: "A send-back needs a note." },
    });
  });
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

const developSession = SessionId.parse("session-2");
const worktreeCreated: Step = (t) => ({
  by: "plugin",
  type: "worktree_created",
  request: awaited(t),
  worktree,
});
const developStarted: Step = (t) => ({
  by: "plugin",
  type: "session_started",
  request: awaited(t),
  session: developSession,
});

const inReady = [...awaitingApproval, approve];
const creatingWorktree = [...inReady, start];
const startingDevelop = [...creatingWorktree, worktreeCreated];

describe("start in Ready", () => {
  test("creates a worktree for build 1", () => {
    expect(send(run(...inReady), start)).toEqual({
      ok: true,
      events: [stamped({ type: "task.dispatch_started", request: 2 })],
      commands: [{ type: "create_worktree", taskId: id, request: 2, build: 1 }],
    });
  });

  test("is rejected while the worktree is being created", () => {
    expect(send(run(...creatingWorktree), start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#12 isn't waiting for a slot." },
    });
  });
});

describe("worktree_created", () => {
  test("starts a develop agent in the worktree, with the spec", () => {
    expect(send(run(...creatingWorktree), worktreeCreated)).toEqual({
      ok: true,
      events: [stamped({ type: "task.worktree_created", worktree, request: 3 })],
      commands: [
        {
          type: "start_develop_session",
          taskId: id,
          request: 3,
          worktree,
          spec,
          brief: { failure: null, note: null, blocked: null },
        },
      ],
    });
  });

  test("removes a worktree the task isn't waiting for, recording nothing", () => {
    expect(send(run(...inReady), worktreeCreated)).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "remove_worktree", worktree }],
    });
  });
});

describe("worktree_failed", () => {
  test("blocks the task with the reason", () => {
    const failed: Step = (t) => ({
      by: "plugin",
      type: "worktree_failed",
      request: awaited(t),
      message: "disk full",
    });
    expect(send(run(...creatingWorktree), failed)).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.blocked",
          reason: { kind: "worktree_failed", message: "disk full" },
        }),
      ],
      commands: [],
    });
  });
});

describe("session_started in Ready", () => {
  test("moves the task to In progress", () => {
    expect(send(run(...startingDevelop), developStarted)).toEqual({
      ok: true,
      events: [stamped({ type: "task.dispatched", session: developSession })],
      commands: [],
    });
  });

  test("stops an agent the task isn't waiting for, recording nothing", () => {
    expect(send(run(...creatingWorktree), developStarted)).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "stop_session", session: developSession }],
    });
  });
});

describe("session_failed in Ready", () => {
  test("blocks the task and removes the unused worktree", () => {
    expect(send(run(...startingDevelop), startFailed)).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.blocked",
          reason: { kind: "session_failed", message: "herdr crashed" },
        }),
      ],
      commands: [{ type: "remove_worktree", worktree }],
    });
  });
});

// ---------------------------------------------------------------------------
// In progress
// ---------------------------------------------------------------------------

// Each report names the commit at the branch's tip, as the daemon reads it.
const exportHead = CommitSha.parse("e".repeat(40));
const authHead = CommitSha.parse("f".repeat(40));
const branch: BranchFacts = {
  head: exportHead,
  commits: 3,
  changedFiles: ["src/reports/export.ts"],
};
const reportWith =
  (b: BranchFacts): Step =>
  (t) => ({ by: "agent", type: "report_done", session: agentOf(t), branch: b });
const reportDone = reportWith(branch);
const giveUp: Step = (t) => ({
  by: "agent",
  type: "give_up",
  session: agentOf(t),
  message: "The reports API is missing.",
});
const retry: Input = { by: "human", type: "retry" };

const inProgress = [...startingDevelop, developStarted];

describe("report_done", () => {
  test("moves the task to Checks and runs the first gate", () => {
    expect(send(run(...inProgress), reportDone)).toEqual({
      ok: true,
      events: [stamped({ type: "task.done_reported", branch, gate: "local", request: 4 })],
      commands: [
        { type: "run_gate", taskId: id, request: 4, gate: "local", worktree, head: exportHead },
      ],
    });
  });

  test("is rejected for a branch with no commits", () => {
    expect(send(run(...inProgress), reportWith({ ...branch, commits: 0 }))).toEqual({
      ok: false,
      rejection: { input: "report_done", reason: "The branch has no commits." },
    });
  });

  test("is rejected when no agent is running", () => {
    expect(send(run(...inProgress, giveUp), reportDone)).toEqual({
      ok: false,
      rejection: { input: "report_done", reason: "#12 has no agent running." },
    });
  });
});

describe("give_up", () => {
  test("blocks the task and stops the agent, keeping the worktree", () => {
    expect(send(run(...inProgress), giveUp)).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.blocked",
          reason: { kind: "agent_gave_up", message: "The reports API is missing." },
        }),
      ],
      commands: [{ type: "stop_session", session: developSession }],
    });
  });
});

describe("retry", () => {
  test("clears the block, so the scheduler can start the task again", () => {
    expect(send(run(...inProgress, giveUp), retry)).toEqual({
      ok: true,
      events: [stamped({ type: "task.unblocked" })],
      commands: [],
    });
  });

  test("is rejected for a task that isn't blocked", () => {
    expect(send(run(...inProgress), retry)).toEqual({
      ok: false,
      rejection: { input: "retry", reason: "#12 isn't blocked." },
    });
  });
});

describe("start in In progress, after a retry", () => {
  const retried = [...inProgress, giveUp, retry];

  test("starts a new agent in the same worktree, told why the last one stopped", () => {
    expect(send(run(...retried), start)).toEqual({
      ok: true,
      events: [stamped({ type: "task.dispatch_started", request: 4 })],
      commands: [
        {
          type: "start_develop_session",
          taskId: id,
          request: 4,
          worktree,
          spec,
          brief: {
            failure: null,
            note: null,
            blocked: { kind: "agent_gave_up", message: "The reports API is missing." },
          },
        },
      ],
    });
  });

  test("records the new agent once it runs", () => {
    const again = SessionId.parse("session-3");
    const decision = send(run(...retried, start), (t) => ({
      by: "plugin",
      type: "session_started",
      request: awaited(t),
      session: again,
    }));
    expect(decision.ok && decision.events).toEqual([
      stamped({ type: "task.dispatched", session: again }),
    ]);
  });

  test("blocks the task again if the agent fails to start, keeping the worktree", () => {
    expect(send(run(...retried, start), startFailed)).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.blocked",
          reason: { kind: "session_failed", message: "herdr crashed" },
        }),
      ],
      commands: [],
    });
  });

  test("is rejected while an agent is running", () => {
    expect(send(run(...inProgress), start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#12 isn't waiting for a slot." },
    });
  });
});

// ---------------------------------------------------------------------------
// Checks: the gates
// ---------------------------------------------------------------------------

// A gate result answers the request the task is waiting on: the gate that
// is running.
const gatePass =
  (gate: "local" | "review"): Step =>
  (t) => ({
    by: "plugin",
    type: "gate_result",
    request: awaited(t),
    gate,
    ok: true,
    summary: "All good.",
  });
const localFail: Step = (t) => ({
  by: "plugin",
  type: "gate_result",
  request: awaited(t),
  gate: "local",
  ok: false,
  summary: "2 tests failed in export.test.ts",
});
const localFailure: Failure = { step: "local", summary: "2 tests failed in export.test.ts" };

const inChecks = [...inProgress, reportDone];

describe("gate_result, passing", () => {
  test("runs the next gate", () => {
    expect(send(run(...inChecks), gatePass("local"))).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.gate_passed", gate: "local", next: { gate: "review", request: 5 } }),
      ],
      commands: [
        { type: "run_gate", taskId: id, request: 5, gate: "review", worktree, head: exportHead },
      ],
    });
  });

  test("is rejected for a gate that isn't running", () => {
    expect(send(run(...inChecks), gatePass("review"))).toEqual({
      ok: false,
      rejection: {
        input: "gate_result",
        reason: "#12 is running the local gate, not review.",
      },
    });
  });
});

describe("gate_result, failing", () => {
  test("sends the failure back to the same agent", () => {
    expect(send(run(...inChecks), localFail)).toEqual({
      ok: true,
      events: [stamped({ type: "task.gate_failed", failure: localFailure })],
      commands: [
        {
          type: "send_to_session",
          session: developSession,
          text: "The local gate failed: 2 tests failed in export.test.ts",
        },
      ],
    });
  });

  test("blocks the task and stops the agent when the last attempt fails", () => {
    const task = run(...inChecks, localFail, reportDone, localFail, reportDone);
    expect(send(task, localFail)).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.gate_failed", failure: localFailure }),
        stamped({
          type: "task.blocked",
          reason: { kind: "out_of_attempts", failure: localFailure },
        }),
      ],
      commands: [{ type: "stop_session", session: developSession }],
    });
  });

  test("after a retry, the new agent is told what failed", () => {
    const task = run(...inChecks, localFail, reportDone, localFail, reportDone, localFail, retry);
    const decision = send(task, start);
    expect(decision.ok && decision.commands).toEqual([
      {
        type: "start_develop_session",
        taskId: id,
        request: 7,
        worktree,
        spec,
        brief: {
          failure: localFailure,
          note: null,
          blocked: { kind: "out_of_attempts", failure: localFailure },
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Checks: the merge
// ---------------------------------------------------------------------------

const authBranch: BranchFacts = {
  head: authHead,
  commits: 2,
  changedFiles: ["src/reports/export.ts", "src/auth/login.ts"],
};
const reportAuthDone = reportWith(authBranch);
const approveMerge: Input = { by: "human", type: "approve_merge" };
const sendBackMerge = (note: string): Input => ({ by: "human", type: "revise_merge", note });
const merged: Step = (t) => ({ by: "plugin", type: "merged", request: awaited(t), commit });
const mergeFail: Step = (t) => ({
  by: "plugin",
  type: "merge_failed",
  request: awaited(t),
  summary: "Conflicts with main.",
});
const mergeFailure: Failure = { step: "merge", summary: "Conflicts with main." };

const lastGateRunning = [...inChecks, gatePass("local")];
const merging = [...lastGateRunning, gatePass("review")];
const awaitingMerge = [...inProgress, reportAuthDone, gatePass("local"), gatePass("review")];

describe("the last gate passing", () => {
  test("starts the merge when no critical path is touched", () => {
    expect(send(run(...lastGateRunning), gatePass("review"))).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.gate_passed", gate: "review", next: null }),
        stamped({ type: "task.checks_passed" }),
        stamped({ type: "task.merge_started", request: 6 }),
      ],
      commands: [
        { type: "stop_session", session: developSession },
        { type: "merge", taskId: id, request: 6, worktree, head: exportHead },
      ],
    });
  });

  test("asks for your approval when a critical path is touched, naming the files", () => {
    const task = run(...inProgress, reportAuthDone, gatePass("local"));
    expect(send(task, gatePass("review"))).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.gate_passed", gate: "review", next: null }),
        stamped({ type: "task.checks_passed" }),
        stamped({ type: "task.merge_approval_requested", criticalFiles: ["src/auth/login.ts"] }),
      ],
      commands: [{ type: "stop_session", session: developSession }],
    });
  });
});

describe("approve_merge", () => {
  test("starts the merge", () => {
    expect(send(run(...awaitingMerge), approveMerge)).toEqual({
      ok: true,
      events: [stamped({ type: "task.merge_started", request: 6 })],
      commands: [{ type: "merge", taskId: id, request: 6, worktree, head: authHead }],
    });
  });

  test("is rejected when no merge is waiting for approval", () => {
    expect(send(run(...merging), approveMerge)).toEqual({
      ok: false,
      rejection: { input: "approve_merge", reason: "#12's merge isn't waiting for approval." },
    });
  });
});

// Found by Codex review. The agent's first report changed only
// export.ts, and the local gate failed. The agent fixed it, also changing
// login.ts, but its first report arrived again and was accepted first.
describe("the commit that merges", () => {
  const repeated = [...inChecks, localFail, reportDone];

  test("is the one the gates tested, never one the agent made after its report", () => {
    // The real report, with the critical file, comes too late to count.
    expect(send(run(...repeated), reportAuthDone).ok).toBe(false);

    const decision = send(run(...repeated, gatePass("local")), gatePass("review"));
    expect(decision.ok && decision.commands).toContainEqual({
      type: "merge",
      taskId: id,
      request: 7,
      worktree,
      head: exportHead,
    });
  });
});

describe("revise_merge", () => {
  test("queues the task for a new agent, without using an attempt", () => {
    expect(send(run(...awaitingMerge), sendBackMerge("Don't touch login."))).toEqual({
      ok: true,
      events: [stamped({ type: "task.merge_sent_back", note: "Don't touch login." })],
      commands: [],
    });
  });

  test("gives your note to the new agent when it starts", () => {
    const decision = send(run(...awaitingMerge, sendBackMerge("Don't touch login.")), start);
    expect(decision.ok && decision.commands).toEqual([
      {
        type: "start_develop_session",
        taskId: id,
        request: 6,
        worktree,
        spec,
        brief: { failure: null, note: "Don't touch login.", blocked: null },
      },
    ]);
  });

  test("is rejected without a note", () => {
    expect(send(run(...awaitingMerge), sendBackMerge(""))).toEqual({
      ok: false,
      rejection: { input: "revise_merge", reason: "A send-back needs a note." },
    });
  });
});

describe("merged", () => {
  test("moves the task to Done and removes the worktree", () => {
    expect(send(run(...merging), merged)).toEqual({
      ok: true,
      events: [stamped({ type: "task.merged", commit })],
      commands: [{ type: "remove_worktree", worktree }],
    });
  });

  test("is rejected before the merge started", () => {
    const early: Input = { by: "plugin", type: "merged", request: 6, commit };
    expect(send(run(...awaitingMerge), early)).toEqual({
      ok: false,
      rejection: {
        input: "merged",
        reason: "This reply answers request 6, but #12 isn't waiting on any request.",
      },
    });
  });
});

describe("merge_failed", () => {
  test("queues the task for a new agent, using an attempt", () => {
    expect(send(run(...merging), mergeFail)).toEqual({
      ok: true,
      events: [stamped({ type: "task.merge_failed", failure: mergeFailure })],
      commands: [],
    });
  });

  test("gives the failure to the new agent when it starts", () => {
    const decision = send(run(...merging, mergeFail), start);
    expect(decision.ok && decision.commands).toEqual([
      {
        type: "start_develop_session",
        taskId: id,
        request: 7,
        worktree,
        spec,
        brief: { failure: mergeFailure, note: null, blocked: null },
      },
    ]);
  });

  test("blocks the task when the last attempt fails", () => {
    // Two failed gates, then both gates pass and the merge fails: attempt 3.
    const task = run(
      ...inChecks,
      localFail,
      reportDone,
      localFail,
      reportDone,
      gatePass("local"),
      gatePass("review"),
    );
    expect(send(task, mergeFail)).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.merge_failed", failure: mergeFailure }),
        stamped({
          type: "task.blocked",
          reason: { kind: "out_of_attempts", failure: mergeFailure },
        }),
      ],
      commands: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const ask =
  (text = "Include deleted rows?", options = ["Yes", "No"]): Step =>
  (t) => ({ by: "agent", type: "ask", session: agentOf(t), text, options });
const answer = (text: string): Input => ({ by: "human", type: "answer", text });

describe("ask", () => {
  test("from the spec agent, stores the question for your inbox", () => {
    expect(send(run(...specRunning), ask())).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.question_asked",
          question: {
            from: "spec",
            text: "Include deleted rows?",
            options: ["Yes", "No"],
            askedAt: at,
          },
        }),
      ],
      commands: [],
    });
  });

  test("from the develop agent, in In progress or Checks", () => {
    for (const inputs of [inProgress, inChecks]) {
      const decision = send(run(...inputs), ask());
      expect(decision.ok && decision.events[0]).toMatchObject({ question: { from: "develop" } });
    }
  });

  test("is rejected while another question is open", () => {
    expect(send(run(...specRunning, ask()), ask("Which date format?"))).toEqual({
      ok: false,
      rejection: { input: "ask", reason: "#12 already has an open question." },
    });
  });

  test("is rejected when no agent is running", () => {
    expect(send(run(...awaitingApproval), ask())).toEqual({
      ok: false,
      rejection: { input: "ask", reason: "#12 has no agent running." },
    });
  });

  test("is rejected without two to four options", () => {
    for (const options of [["Yes"], ["A", "B", "C", "D", "E"]]) {
      expect(send(run(...specRunning), ask("Include deleted rows?", options))).toEqual({
        ok: false,
        rejection: { input: "ask", reason: "A question needs two to four options." },
      });
    }
  });
});

describe("answer", () => {
  test("clears the question and sends your answer to the agent that asked", () => {
    expect(send(run(...specRunning, ask()), answer("No"))).toEqual({
      ok: true,
      events: [stamped({ type: "task.question_answered", text: "No" })],
      commands: [{ type: "send_to_session", session, text: "No" }],
    });
  });

  test("reaches the develop agent while the task is in Checks", () => {
    const decision = send(run(...inChecks, ask()), answer("No"));
    expect(decision.ok && decision.commands).toEqual([
      { type: "send_to_session", session: developSession, text: "No" },
    ]);
  });

  test("is rejected when no question is open", () => {
    expect(send(run(...specRunning), answer("No"))).toEqual({
      ok: false,
      rejection: { input: "answer", reason: "#12 has no open question." },
    });
  });

  test("is rejected when blank", () => {
    expect(send(run(...specRunning, ask()), answer(" "))).toEqual({
      ok: false,
      rejection: { input: "answer", reason: "An answer needs text." },
    });
  });
});

describe("an open spec question", () => {
  test("stops the agent from submitting a spec until you answer", () => {
    expect(send(run(...specRunning, ask()), submit)).toEqual({
      ok: false,
      rejection: { input: "submit_spec", reason: "#12 has an open question. Wait for the answer." },
    });
  });

  test("is cleared when you write the spec yourself", () => {
    expect(run(...specRunning, ask(), provide).question).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Usage and the safety cap
// ---------------------------------------------------------------------------

// The test config's cap is 200,000 tokens and 60 minutes.
const usage = (tokens: number, minutes = 0): Input => ({
  by: "system",
  type: "usage",
  usage: { tokens, ms: minutes * 60_000 },
});

describe("usage", () => {
  test("records the totals while under the cap", () => {
    expect(send(run(...inProgress), usage(50_000, 10))).toEqual({
      ok: true,
      events: [stamped({ type: "task.usage_recorded", usage: { tokens: 50_000, ms: 600_000 } })],
      commands: [],
    });
  });

  test("blocks the task and stops the agent once it reaches the cap", () => {
    expect(send(run(...inProgress), usage(200_000, 10))).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.usage_recorded", usage: { tokens: 200_000, ms: 600_000 } }),
        stamped({
          type: "task.blocked",
          reason: { kind: "safety_cap", usage: { tokens: 200_000, ms: 600_000 } },
        }),
      ],
      commands: [{ type: "stop_session", session: developSession }],
    });
  });

  test("stops the spec agent too", () => {
    const decision = send(run(...specRunning), usage(0, 60));
    expect(decision.ok && decision.commands).toEqual([{ type: "stop_session", session }]);
  });

  test("counts only what was used since the last retry", () => {
    const retried = run(...inProgress, usage(200_000), retry);
    const decision = send(retried, usage(250_000));
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual(["task.usage_recorded"]);
  });

  test("only records the totals when no agent is running", () => {
    for (const inputs of [awaitingApproval, [...inProgress, giveUp]]) {
      const decision = send(run(...inputs), usage(300_000));
      expect(decision.ok && decision.events.map((e) => e.type)).toEqual(["task.usage_recorded"]);
    }
  });
});

describe("the safety cap while an agent is starting", () => {
  const capped: BlockReason = { kind: "safety_cap", usage: { tokens: 250_000, ms: 0 } };

  test("blocks a task whose spec agent is still starting", () => {
    expect(send(run(...inSpec, start), usage(250_000))).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.usage_recorded", usage: { tokens: 250_000, ms: 0 } }),
        stamped({ type: "task.blocked", reason: capped }),
      ],
      commands: [],
    });
  });

  test("blocks a task whose worktree is being created", () => {
    const decision = send(run(...creatingWorktree), usage(250_000));
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual([
      "task.usage_recorded",
      "task.blocked",
    ]);
  });

  test("blocks a task whose develop agent is starting, removing the unused worktree", () => {
    expect(send(run(...startingDevelop), usage(250_000))).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.usage_recorded", usage: { tokens: 250_000, ms: 0 } }),
        stamped({ type: "task.blocked", reason: capped }),
      ],
      commands: [{ type: "remove_worktree", worktree }],
    });
  });
});

describe("start for a task already over its safety cap", () => {
  test("blocks the task instead of starting an agent", () => {
    // The report arrived while the spec waited for approval, so it was only recorded.
    const task = run(...awaitingApproval, usage(250_000), approve);
    expect(send(task, start)).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.blocked",
          reason: { kind: "safety_cap", usage: { tokens: 250_000, ms: 0 } },
        }),
      ],
      commands: [],
    });
  });
});

describe("a usage report older than the last one", () => {
  test("is refused, so the totals never go down", () => {
    expect(send(run(...inProgress, usage(50_000)), usage(10_000))).toEqual({
      ok: false,
      rejection: {
        input: "usage",
        reason: "This usage report for #12 is older than the last one.",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Leaving a phase
// ---------------------------------------------------------------------------

const drop: Input = { by: "human", type: "drop" };
const sendBackToSpec = (note: string): Input => ({ by: "human", type: "back_to_spec", note });
// A crash report names the agent, and the request that started it.
const crashed = (s: SessionId, request: number): Input => ({
  by: "plugin",
  type: "session_crashed",
  request,
  session: s,
  message: "herdr crashed",
});

describe("drop", () => {
  test("stops a running spec agent", () => {
    expect(send(run(...specRunning), drop)).toEqual({
      ok: true,
      events: [stamped({ type: "task.dropped" })],
      commands: [{ type: "stop_session", session }],
    });
  });

  test("removes the worktree of a develop agent that is still starting", () => {
    const decision = send(run(...startingDevelop), drop);
    expect(decision.ok && decision.commands).toEqual([{ type: "remove_worktree", worktree }]);
  });

  test("stops the develop agent and removes the worktree in In progress", () => {
    const decision = send(run(...inProgress), drop);
    expect(decision.ok && decision.commands).toEqual([
      { type: "stop_session", session: developSession },
      { type: "remove_worktree", worktree },
    ]);
  });

  test("only removes the worktree of a blocked task, whose agent is already stopped", () => {
    const decision = send(run(...inProgress, giveUp), drop);
    expect(decision.ok && decision.commands).toEqual([{ type: "remove_worktree", worktree }]);
  });

  test("stops the agent and removes the worktree in Checks", () => {
    const decision = send(run(...inChecks), drop);
    expect(decision.ok && decision.commands).toEqual([
      { type: "stop_session", session: developSession },
      { type: "remove_worktree", worktree },
    ]);
  });

  test("is rejected while merging", () => {
    expect(send(run(...merging), drop)).toEqual({
      ok: false,
      rejection: { input: "drop", reason: "#12 is merging. Wait until the merge finishes." },
    });
  });

  test("is rejected for a Done task", () => {
    expect(send(run(...merging, merged), drop)).toEqual({
      ok: false,
      rejection: { input: "drop", reason: "#12 is done. Use revert to undo it." },
    });
  });
});

describe("back_to_spec", () => {
  const note = "Split this into export and totals.";

  test("takes a blocked task back to Spec and removes its worktree", () => {
    expect(send(run(...inProgress, giveUp), sendBackToSpec(note))).toEqual({
      ok: true,
      events: [stamped({ type: "task.spec_sent_back", note })],
      commands: [{ type: "remove_worktree", worktree }],
    });
  });

  test("stops the agent too when one is running", () => {
    const decision = send(run(...inChecks), sendBackToSpec(note));
    expect(decision.ok && decision.commands).toEqual([
      { type: "stop_session", session: developSession },
      { type: "remove_worktree", worktree },
    ]);
  });

  test("is rejected without a note", () => {
    expect(send(run(...inProgress, giveUp), sendBackToSpec(""))).toEqual({
      ok: false,
      rejection: { input: "back_to_spec", reason: "A send-back needs a note." },
    });
  });

  test("is rejected for a task that hasn't left Spec", () => {
    expect(send(run(add), sendBackToSpec(note))).toEqual({
      ok: false,
      rejection: {
        input: "back_to_spec",
        reason: "#12 is in Idea. Only a task past Spec can be sent back to it.",
      },
    });
  });
});

describe("a running agent crashing", () => {
  test("blocks the task in In progress, keeping the worktree", () => {
    expect(send(run(...inProgress), crashed(developSession, 3))).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.blocked",
          reason: { kind: "session_failed", message: "herdr crashed" },
        }),
      ],
      commands: [],
    });
  });

  test("blocks the task in Spec", () => {
    const decision = send(run(...specRunning), crashed(session, 1));
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual(["task.blocked"]);
  });

  test("blocks the task in Checks while a gate runs", () => {
    const decision = send(run(...inChecks), crashed(developSession, 3));
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual(["task.blocked"]);
  });

  test("is rejected once the gates have passed, since the agent was already stopped", () => {
    expect(send(run(...merging), crashed(developSession, 3))).toEqual({
      ok: false,
      rejection: { input: "session_crashed", reason: "#12's agent isn't session-2." },
    });
  });
});

describe("a crash reported before the agent's start reply", () => {
  // The spec agent (request 1) starts and crashes at once, and the crash
  // report overtakes the start reply.
  const early = crashed(SessionId.parse("gone"), 1);
  const lateStart: Input = {
    by: "plugin",
    type: "session_started",
    request: 1,
    session: SessionId.parse("gone"),
  };

  test("counts as a failed start and blocks the task", () => {
    expect(send(run(...inSpec, start), early)).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.blocked",
          reason: { kind: "session_failed", message: "herdr crashed" },
        }),
      ],
      commands: [],
    });
  });

  test("leaves the late start reply to be stopped, not recorded as running", () => {
    expect(send(run(...inSpec, start, early), lateStart)).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "stop_session", session: SessionId.parse("gone") }],
    });
  });

  test("is refused for a request the task isn't waiting on", () => {
    const stale = crashed(SessionId.parse("gone"), 7);
    expect(send(run(...inSpec, start), stale)).toEqual({
      ok: false,
      rejection: { input: "session_crashed", reason: "#12's agent isn't gone." },
    });
  });
});

// ---------------------------------------------------------------------------
// Done, projects and outside moves
// ---------------------------------------------------------------------------

const revert = (reason: string): Input => ({ by: "human", type: "revert", reason });
const changeProject = (project: ProjectId | null): Input => ({
  by: "human",
  type: "change_project",
  project,
});
const done = [...merging, merged];

const reverted: Step = (t) => ({ by: "plugin", type: "reverted", request: awaited(t) });
const revertFailed: Step = (t) => ({
  by: "plugin",
  type: "revert_failed",
  request: awaited(t),
  summary: "Conflicts in export.ts",
});

describe("revert", () => {
  test("asks version control to undo the merge commit, and the task stays Done until it has", () => {
    expect(send(run(...done), revert("Export breaks on empty reports."))).toEqual({
      ok: true,
      events: [
        stamped({
          type: "task.revert_started",
          reason: "Export breaks on empty reports.",
          request: 7,
        }),
      ],
      commands: [{ type: "revert", taskId: id, request: 7, commit }],
    });
    expect(run(...done, revert("Broken.")).phase).toBe("done");
  });

  test("once the revert has happened, takes the task back to Spec with your reason", () => {
    expect(send(run(...done, revert("Export breaks on empty reports.")), reverted)).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.reverted", commit, reason: "Export breaks on empty reports." }),
      ],
      commands: [],
    });
  });

  test("when the revert fails, keeps the task Done and says why", () => {
    expect(send(run(...done, revert("Broken.")), revertFailed)).toEqual({
      ok: true,
      events: [stamped({ type: "task.revert_failed", summary: "Conflicts in export.ts" })],
      commands: [],
    });
  });

  test("is rejected while a revert is already under way", () => {
    expect(send(run(...done, revert("Broken.")), revert("Broken."))).toEqual({
      ok: false,
      rejection: { input: "revert", reason: "#12 is already being reverted." },
    });
  });

  test("can be tried again after it failed", () => {
    const decision = send(run(...done, revert("Broken."), revertFailed), revert("Broken."));
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual(["task.revert_started"]);
  });

  test("a reply is rejected when no revert is under way", () => {
    const early: Input = { by: "plugin", type: "reverted", request: 7 };
    expect(send(run(...done), early)).toEqual({
      ok: false,
      rejection: {
        input: "reverted",
        reason: "This reply answers request 7, but #12 isn't waiting on any request.",
      },
    });
  });

  test("is rejected without a reason", () => {
    expect(send(run(...done), revert(""))).toEqual({
      ok: false,
      rejection: { input: "revert", reason: "A revert needs a reason." },
    });
  });

  test("is rejected for a task that isn't done", () => {
    expect(send(run(...inProgress), revert("Broken."))).toEqual({
      ok: false,
      rejection: { input: "revert", reason: "#12 is in In progress, so it can't take a revert." },
    });
  });
});

describe("change_project", () => {
  test("moves the task to another project", () => {
    expect(send(run(...inProgress), changeProject(reports))).toEqual({
      ok: true,
      events: [stamped({ type: "task.project_changed", project: reports })],
      commands: [],
    });
  });

  test("takes the task out of its project", () => {
    const decision = send(run({ ...add, project: reports }), changeProject(null));
    expect(decision.ok && decision.events).toEqual([
      stamped({ type: "task.project_changed", project: null }),
    ]);
  });

  test("is rejected for a project that doesn't exist", () => {
    expect(send(run(add), changeProject(ProjectId.parse("billing")))).toEqual({
      ok: false,
      rejection: { input: "change_project", reason: "There is no project called billing." },
    });
  });

  test("is rejected for a Done task, which only takes a revert", () => {
    expect(send(run(...done), changeProject(reports))).toEqual({
      ok: false,
      rejection: {
        input: "change_project",
        reason: "#12 is in Done, so it can't take a project change.",
      },
    });
  });
});

describe("external_move", () => {
  test("is always rejected: a move in another tool is only a request", () => {
    const moved: Input = { by: "plugin", type: "external_move", to: "Done" };
    expect(send(run(...inProgress), moved)).toEqual({
      ok: false,
      rejection: {
        input: "external_move",
        reason: "Tasks only move through Skelcrew. The move to Done in the other tool was ignored.",
      },
    });
  });
});

describe("an input in the wrong phase", () => {
  test("is rejected with the phase it doesn't fit", () => {
    expect(send(run(...specRunning), approveMerge)).toEqual({
      ok: false,
      rejection: {
        input: "approve_merge",
        reason: "#12 is in Spec, so it can't take a merge approval.",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Late and repeated replies
// ---------------------------------------------------------------------------

// Every reply names the request it answers. A reply to any other request is
// late or repeated: it is cleaned up or refused, and never answers the
// current one.

describe("late replies for a dropped task", () => {
  test("remove a worktree that finished after the drop", () => {
    expect(send(run(...creatingWorktree, drop), worktreeCreated)).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "remove_worktree", worktree }],
    });
  });

  test("stop an agent that started after the drop", () => {
    expect(send(run(...inSpec, start, drop), sessionStarted)).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "stop_session", session }],
    });
  });
});

describe("a reply repeated for what the task already holds", () => {
  test("is ignored when it names the running agent, instead of stopping it", () => {
    expect(send(run(...inProgress), developStarted)).toEqual({
      ok: true,
      events: [],
      commands: [],
    });
  });

  test("is ignored when it names the task's worktree, instead of removing it", () => {
    expect(send(run(...inProgress), worktreeCreated)).toEqual({
      ok: true,
      events: [],
      commands: [],
    });
  });
});

describe("a worktree reply for an earlier build", () => {
  const build2 = { path: "/repo/.worktrees/12-2", branch: "task/12-csv-export-2" };
  // Build 1's worktree (request 2) is still being made when the task is sent
  // back and started again as build 2 (request 3).
  const build2Waiting = [...creatingWorktree, sendBackToSpec("Split it."), provide, start];
  const build1Created: Input = { by: "plugin", type: "worktree_created", request: 2, worktree };

  test("is removed, not used for the current build", () => {
    expect(send(run(...build2Waiting), build1Created)).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "remove_worktree", worktree }],
    });
  });

  test("leaves the current build waiting for its own worktree", () => {
    const own: Input = { by: "plugin", type: "worktree_created", request: 3, worktree: build2 };
    const decision = send(run(...build2Waiting, build1Created), own);
    expect(decision.ok && decision.events).toEqual([
      stamped({ type: "task.worktree_created", worktree: build2, request: 4 }),
    ]);
  });

  test("can't block the current build when it failed", () => {
    const failed: Input = {
      by: "plugin",
      type: "worktree_failed",
      request: 2,
      message: "disk full",
    };
    expect(send(run(...build2Waiting), failed)).toEqual({
      ok: false,
      rejection: {
        input: "worktree_failed",
        reason: "This reply answers request 2, but #12 is waiting on request 3.",
      },
    });
  });
});

describe("a gate result from an earlier run of the checks", () => {
  // Local passes (request 4) and the review starts (request 5). The agent
  // crashes, you retry, and a new agent reports done: local runs again and
  // passes (request 7), and the review starts again (request 8).
  const reviewingAgain: Step[] = [
    ...inChecks,
    gatePass("local"),
    crashed(developSession, 3),
    retry,
    start,
    (t) => ({
      by: "plugin",
      type: "session_started",
      request: awaited(t),
      session: SessionId.parse("session-3"),
    }),
    reportDone,
    gatePass("local"),
  ];
  const oldReview: Input = {
    by: "plugin",
    type: "gate_result",
    request: 5,
    gate: "review",
    ok: true,
    summary: "All good.",
  };

  test("is refused, so it can't approve code it never checked", () => {
    expect(send(run(...reviewingAgain), oldReview)).toEqual({
      ok: false,
      rejection: {
        input: "gate_result",
        reason: "This reply answers request 5, but #12 is waiting on request 8.",
      },
    });
  });

  test("leaves the current run to its own result", () => {
    const decision = send(run(...reviewingAgain), gatePass("review"));
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual([
      "task.gate_passed",
      "task.checks_passed",
      "task.merge_started",
    ]);
  });
});

describe("a merge reply for an earlier merge", () => {
  // The first merge (request 6) conflicts. A new agent fixes it, the gates
  // pass again (requests 8 and 9), and a second merge starts (request 10).
  const mergingAgain: Step[] = [
    ...merging,
    mergeFail,
    start,
    developStarted,
    reportDone,
    gatePass("local"),
    gatePass("review"),
  ];

  test("can't finish the current merge", () => {
    const oldMerged: Input = { by: "plugin", type: "merged", request: 6, commit };
    expect(send(run(...mergingAgain), oldMerged)).toEqual({
      ok: false,
      rejection: {
        input: "merged",
        reason: "This reply answers request 6, but #12 is waiting on request 10.",
      },
    });
  });

  test("can't fail the current merge", () => {
    const oldFailed: Input = { by: "plugin", type: "merge_failed", request: 6, summary: "x" };
    expect(send(run(...mergingAgain), oldFailed).ok).toBe(false);
    expect(send(run(...mergingAgain), merged).ok).toBe(true);
  });
});

describe("a revert reply for an earlier revert", () => {
  // The first revert (request 7) fails, and you try again (request 8).
  const revertingAgain: Step[] = [...done, revert("Broken."), revertFailed, revert("Broken.")];

  test("can't confirm the current revert", () => {
    const oldReverted: Input = { by: "plugin", type: "reverted", request: 7 };
    expect(send(run(...revertingAgain), oldReverted)).toEqual({
      ok: false,
      rejection: {
        input: "reverted",
        reason: "This reply answers request 7, but #12 is waiting on request 8.",
      },
    });
  });

  test("can't fail the current revert, which then still succeeds", () => {
    const oldFailed: Input = { by: "plugin", type: "revert_failed", request: 7, summary: "x" };
    expect(send(run(...revertingAgain), oldFailed).ok).toBe(false);
    expect(send(run(...revertingAgain), reverted).ok).toBe(true);
  });
});

describe("a crash report for an earlier agent", () => {
  test("can't block the task or make it forget the agent it has now", () => {
    const replaced: Step[] = [
      ...inProgress,
      crashed(developSession, 3),
      retry,
      start,
      (t) => ({
        by: "plugin",
        type: "session_started",
        request: awaited(t),
        session: SessionId.parse("session-3"),
      }),
    ];
    expect(send(run(...replaced), crashed(developSession, 3))).toEqual({
      ok: false,
      rejection: { input: "session_crashed", reason: "#12's agent isn't session-2." },
    });
  });
});

describe("an agent started for an earlier request", () => {
  // You write the spec yourself while the spec agent (request 1) is still
  // starting. The task moves on, and its develop agent (request 3) starts.
  const developStarting: Step[] = [...inSpec, start, provide, start, worktreeCreated];
  const lateSpecAgent: Input = {
    by: "plugin",
    type: "session_started",
    request: 1,
    session: SessionId.parse("spec-late"),
  };

  test("is stopped, not taken as the develop agent", () => {
    expect(send(run(...developStarting), lateSpecAgent)).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "stop_session", session: SessionId.parse("spec-late") }],
    });
  });

  test("leaves the task waiting for the develop agent it asked for", () => {
    const decision = send(run(...developStarting, lateSpecAgent), developStarted);
    expect(decision.ok && decision.events).toEqual([
      stamped({ type: "task.dispatched", session: developSession }),
    ]);
  });
});

describe("an agent started for an earlier request, after a retry", () => {
  // The first develop agent answered request 3. After a give-up and a retry,
  // a new agent is starting for request 4, when a repeat of request 3's
  // reply arrives, naming another session.
  test("is stopped, not taken as the new agent", () => {
    const retrying: Step[] = [...inProgress, giveUp, retry, start];
    const late: Input = {
      by: "plugin",
      type: "session_started",
      request: 3,
      session: SessionId.parse("stray"),
    };
    expect(send(run(...retrying), late)).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "stop_session", session: SessionId.parse("stray") }],
    });
  });
});

// ---------------------------------------------------------------------------
// Reports from an agent the task has replaced
// ---------------------------------------------------------------------------

describe("a report from an agent the task has replaced", () => {
  const replaced = SessionId.parse("session-2");
  const current = SessionId.parse("session-3");
  const newAgent: Step = (t) => ({
    by: "plugin",
    type: "session_started",
    request: awaited(t),
    session: current,
  });

  test("can't stop the new agent by giving up for it", () => {
    const retried = run(...inProgress, giveUp, retry, start, newAgent);
    const oldGiveUp: Input = {
      by: "agent",
      type: "give_up",
      session: replaced,
      message: "The reports API is missing.",
    };
    expect(send(retried, oldGiveUp)).toEqual({
      ok: false,
      rejection: { input: "give_up", reason: "#12's agent isn't session-2." },
    });
  });

  test("can't resubmit the spec you sent back while the new agent revises it", () => {
    const first = SessionId.parse("session-1");
    const revising = run(
      ...awaitingApproval,
      sendBack("Also export the totals row."),
      start,
      (t) => ({ by: "plugin", type: "session_started", request: awaited(t), session: current }),
    );
    const oldSubmit: Input = { by: "agent", type: "submit_spec", session: first, spec };
    expect(send(revising, oldSubmit)).toEqual({
      ok: false,
      rejection: { input: "submit_spec", reason: "#12's agent isn't session-1." },
    });
  });
});
