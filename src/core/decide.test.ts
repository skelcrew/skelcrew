import { describe, expect, test } from "bun:test";
import { decide } from "./decide";
import { evolve } from "./evolve";
import { ProjectId, TaskId } from "./ids";
import type { Config, Decision, EventBody, Input, Project, Task, TaskEvent } from "./types";

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

function send(task: Task | null, input: Input): Decision {
  return decide(task, { taskId: id, at, input }, config, projects);
}

// Sends each input in turn and applies the accepted events with evolve, the
// way the daemon does. Fails the test if an input is rejected or evolve
// refuses one of decide's events, so tests can build a task in any phase.
function run(...inputs: Input[]): Task {
  let task: Task | null = null;
  for (const input of inputs) {
    const decision = send(task, input);
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
