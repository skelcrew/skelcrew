import { describe, expect, test } from "bun:test";
import { decide } from "./decide";
import { evolve } from "./evolve";
import { ProjectId, SessionId, TaskId } from "./ids";
import type { Config, Decision, EventBody, Input, Project, Spec, Task, TaskEvent } from "./types";

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
  return decide(task, { taskId: id, at, input }, withConfig, projects);
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
      const result = evolve(task, event);
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
