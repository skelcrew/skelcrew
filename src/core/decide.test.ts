import { describe, expect, test } from "bun:test";
import { decideTask } from "./decide";
import { evolveTask } from "./evolve";
import { CommitSha, ProjectId, SessionId, TaskId } from "./ids";
import type {
  BlockReason,
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

const id = TaskId.parse(12);
const at = 5_000;

const config: Config = {
  gates: ["local", "review"],
  maxAttempts: 3,
  maxRunning: 2,
  specApproval: "always",
  criticalPaths: ["src/auth/**"],
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

function send(task: Task | null, input: Input, withConfig: Config = config): Decision {
  return decideTask(task, { taskId: id, at, input }, withConfig, projects);
}

// Sends each input in turn and applies the accepted events with evolve, the
// way the daemon does. Fails the test if an input is rejected or evolve
// refuses one of decide's events, so tests can build a task in any phase.
function run(...inputs: Input[]): Task {
  return runWith(config, ...inputs);
}

function runWith(withConfig: Config, ...inputs: Input[]): Task {
  let task: Task | null = null;
  for (const input of inputs) {
    const decision = send(task, input, withConfig);
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

const spec: Spec = {
  scope: "Add a CSV export button to the reports page.",
  acceptance: ["Clicking Export downloads a CSV of the visible rows."],
  openQuestions: [],
};
const session = SessionId.parse("session-1");
const neverApprove: Config = { ...config, specApproval: "never" };

const start: Input = { by: "system", type: "start" };
const sessionStarted: Input = { by: "plugin", type: "session_started", session };
const submit: Input = { by: "agent", type: "submit_spec", spec };
const approve: Input = { by: "human", type: "approve_spec" };
const sendBack = (note: string): Input => ({ by: "human", type: "send_back_spec", note });
const provide: Input = { by: "human", type: "provide_spec", spec };

const inSpec = [add, requestSpec];
const specRunning = [...inSpec, start, sessionStarted];
const awaitingApproval = [...specRunning, submit];

describe("start in Spec", () => {
  test("starts a spec agent", () => {
    expect(send(run(...inSpec), start)).toEqual({
      ok: true,
      events: [stamped({ type: "task.dispatch_started" })],
      commands: [{ type: "start_spec_session", taskId: id, note: null }],
    });
  });

  test("passes your send-back note to the new spec agent", () => {
    const task = run(...awaitingApproval, sendBack("Also export the totals row."));
    const decision = send(task, start);
    expect(decision.ok && decision.commands).toEqual([
      { type: "start_spec_session", taskId: id, note: "Also export the totals row." },
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
    const failed: Input = { by: "plugin", type: "session_failed", message: "herdr crashed" };
    const task = run(...inSpec, start, failed);
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
    const failed: Input = { by: "plugin", type: "session_failed", message: "herdr crashed" };
    expect(send(run(...inSpec, start), failed)).toEqual({
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

  test("never makes the task Ready by itself when approval is required (invariant 1)", () => {
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
    const incomplete: Input = {
      ...submit,
      spec: { ...spec, acceptance: [], openQuestions: ["Include deleted rows?"] },
    };
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
      rejection: { input: "submit_spec", reason: "#12 has no spec agent running." },
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

describe("send_back_spec", () => {
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
      rejection: { input: "send_back_spec", reason: "A send-back needs a note." },
    });
  });
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

const worktree = { path: "/repo/.worktrees/12", branch: "task/12-csv-export" };
const developSession = SessionId.parse("session-2");
const worktreeCreated: Input = { by: "plugin", type: "worktree_created", worktree };
const developStarted: Input = { by: "plugin", type: "session_started", session: developSession };

const inReady = [...awaitingApproval, approve];
const creatingWorktree = [...inReady, start];
const startingDevelop = [...creatingWorktree, worktreeCreated];

describe("start in Ready", () => {
  test("creates a worktree for build 1", () => {
    expect(send(run(...inReady), start)).toEqual({
      ok: true,
      events: [stamped({ type: "task.dispatch_started" })],
      commands: [{ type: "create_worktree", taskId: id, build: 1 }],
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
      events: [stamped({ type: "task.worktree_created", worktree })],
      commands: [
        {
          type: "start_develop_session",
          taskId: id,
          worktree,
          spec,
          lastFailure: null,
          note: null,
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
    const failed: Input = { by: "plugin", type: "worktree_failed", message: "disk full" };
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
    const failed: Input = { by: "plugin", type: "session_failed", message: "herdr crashed" };
    expect(send(run(...startingDevelop), failed)).toEqual({
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

const branch = { commits: 3, changedFiles: ["src/reports/export.ts"] };
const reportDone: Input = { by: "agent", type: "report_done", branch };
const giveUp: Input = { by: "agent", type: "give_up", message: "The reports API is missing." };
const retry: Input = { by: "human", type: "retry" };

const inProgress = [...startingDevelop, developStarted];

describe("report_done", () => {
  test("moves the task to Checks and runs the first gate", () => {
    expect(send(run(...inProgress), reportDone)).toEqual({
      ok: true,
      events: [stamped({ type: "task.done_reported", branch, gate: "local" })],
      commands: [{ type: "run_gate", taskId: id, gate: "local", worktree }],
    });
  });

  test("is rejected for a branch with no commits", () => {
    expect(send(run(...inProgress), { ...reportDone, branch: { ...branch, commits: 0 } })).toEqual({
      ok: false,
      rejection: { input: "report_done", reason: "The branch has no commits." },
    });
  });

  test("is rejected when no agent is running", () => {
    expect(send(run(...inProgress, giveUp), reportDone)).toEqual({
      ok: false,
      rejection: { input: "report_done", reason: "#12 has no develop agent running." },
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

  test("starts a new agent in the same worktree", () => {
    expect(send(run(...retried), start)).toEqual({
      ok: true,
      events: [stamped({ type: "task.dispatch_started" })],
      commands: [
        {
          type: "start_develop_session",
          taskId: id,
          worktree,
          spec,
          lastFailure: null,
          note: null,
        },
      ],
    });
  });

  test("records the new agent once it runs", () => {
    const again = SessionId.parse("session-3");
    const decision = send(run(...retried, start), {
      by: "plugin",
      type: "session_started",
      session: again,
    });
    expect(decision.ok && decision.events).toEqual([
      stamped({ type: "task.dispatched", session: again }),
    ]);
  });

  test("blocks the task again if the agent fails to start, keeping the worktree", () => {
    const failed: Input = { by: "plugin", type: "session_failed", message: "herdr crashed" };
    expect(send(run(...retried, start), failed)).toEqual({
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

const gatePass = (gate: "local" | "review"): Input => ({
  by: "plugin",
  type: "gate_result",
  gate,
  ok: true,
  summary: "All good.",
});
const localFail: Input = {
  by: "plugin",
  type: "gate_result",
  gate: "local",
  ok: false,
  summary: "2 tests failed in export.test.ts",
};
const localFailure: Failure = { step: "local", summary: "2 tests failed in export.test.ts" };

const inChecks = [...inProgress, reportDone];

describe("gate_result, passing", () => {
  test("runs the next gate", () => {
    expect(send(run(...inChecks), gatePass("local"))).toEqual({
      ok: true,
      events: [stamped({ type: "task.gate_passed", gate: "local", next: "review" })],
      commands: [{ type: "run_gate", taskId: id, gate: "review", worktree }],
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
        worktree,
        spec,
        lastFailure: localFailure,
        note: null,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Checks: the merge
// ---------------------------------------------------------------------------

const commit = CommitSha.parse("b".repeat(40));
const authBranch = { commits: 2, changedFiles: ["src/reports/export.ts", "src/auth/login.ts"] };
const reportAuthDone: Input = { by: "agent", type: "report_done", branch: authBranch };
const approveMerge: Input = { by: "human", type: "approve_merge" };
const sendBackMerge = (note: string): Input => ({ by: "human", type: "send_back_merge", note });
const merged: Input = { by: "plugin", type: "merged", commit };
const mergeFail: Input = { by: "plugin", type: "merge_failed", summary: "Conflicts with main." };
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
        stamped({ type: "task.merge_started" }),
      ],
      commands: [
        { type: "stop_session", session: developSession },
        { type: "merge", taskId: id, worktree },
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
      events: [stamped({ type: "task.merge_started" })],
      commands: [{ type: "merge", taskId: id, worktree }],
    });
  });

  test("is rejected when no merge is waiting for approval", () => {
    expect(send(run(...merging), approveMerge)).toEqual({
      ok: false,
      rejection: { input: "approve_merge", reason: "#12's merge isn't waiting for approval." },
    });
  });
});

describe("send_back_merge", () => {
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
        worktree,
        spec,
        lastFailure: null,
        note: "Don't touch login.",
      },
    ]);
  });

  test("is rejected without a note", () => {
    expect(send(run(...awaitingMerge), sendBackMerge(""))).toEqual({
      ok: false,
      rejection: { input: "send_back_merge", reason: "A send-back needs a note." },
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
    expect(send(run(...awaitingMerge), merged)).toEqual({
      ok: false,
      rejection: { input: "merged", reason: "#12 isn't merging." },
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
        worktree,
        spec,
        lastFailure: mergeFailure,
        note: null,
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

const ask = (text = "Include deleted rows?", options = ["Yes", "No"]): Input => ({
  by: "agent",
  type: "ask",
  text,
  options,
});
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

// ---------------------------------------------------------------------------
// Leaving a phase
// ---------------------------------------------------------------------------

const drop: Input = { by: "human", type: "drop" };
const sendBackToSpec = (note: string): Input => ({ by: "human", type: "send_back_to_spec", note });
const sessionFailed: Input = { by: "plugin", type: "session_failed", message: "herdr crashed" };

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

describe("send_back_to_spec", () => {
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
      rejection: { input: "send_back_to_spec", reason: "A send-back needs a note." },
    });
  });

  test("is rejected for a task that hasn't left Spec", () => {
    expect(send(run(add), sendBackToSpec(note))).toEqual({
      ok: false,
      rejection: {
        input: "send_back_to_spec",
        reason: "#12 is in Idea. Only a task past Spec can be sent back to it.",
      },
    });
  });
});

describe("a running agent crashing", () => {
  test("blocks the task in In progress, keeping the worktree", () => {
    expect(send(run(...inProgress), sessionFailed)).toEqual({
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
    const decision = send(run(...specRunning), sessionFailed);
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual(["task.blocked"]);
  });

  test("blocks the task in Checks while a gate runs", () => {
    const decision = send(run(...inChecks), sessionFailed);
    expect(decision.ok && decision.events.map((e) => e.type)).toEqual(["task.blocked"]);
  });

  test("is rejected once the gates have passed, since the agent was already stopped", () => {
    expect(send(run(...merging), sessionFailed)).toEqual({
      ok: false,
      rejection: { input: "session_failed", reason: "#12 has no develop agent." },
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

describe("revert", () => {
  test("undoes the merge commit and takes the task back to Spec with your reason", () => {
    expect(send(run(...done), revert("Export breaks on empty reports."))).toEqual({
      ok: true,
      events: [
        stamped({ type: "task.reverted", commit, reason: "Export breaks on empty reports." }),
      ],
      commands: [{ type: "revert", taskId: id, commit }],
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
      rejection: { input: "revert", reason: "revert doesn't apply to #12 in In progress." },
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

  test("is rejected for a Done task, which only takes a revert (invariant 17)", () => {
    expect(send(run(...done), changeProject(reports))).toEqual({
      ok: false,
      rejection: {
        input: "change_project",
        reason: "change_project doesn't apply to #12 in Done.",
      },
    });
  });
});

describe("external_move", () => {
  test("is always rejected: a move in another tool is only a request (invariant 3)", () => {
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
      rejection: { input: "approve_merge", reason: "approve_merge doesn't apply to #12 in Spec." },
    });
  });
});

// ---------------------------------------------------------------------------
// Fixes for what the property tests found
// ---------------------------------------------------------------------------

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
