import { describe, expect, test } from "bun:test";
import { ProjectId } from "./ids";
import { decideProject, evolveProject } from "./projects";
import type {
  Project,
  ProjectDecision,
  ProjectEvent,
  ProjectEventBody,
  ProjectInput,
} from "./types";

const id = ProjectId.parse("reports");
const at = 7_000;

function send(project: Project | null, input: ProjectInput): ProjectDecision {
  return decideProject(project, { projectId: id, at, input });
}

function stamped(body: ProjectEventBody): ProjectEvent {
  return { ...body, v: 1, projectId: id, at };
}

// Sends each input and applies the accepted events, the way the daemon does.
// Fails the test if an input is rejected or evolveProject refuses an event.
function run(...inputs: ProjectInput[]): Project {
  let project: Project | null = null;
  for (const input of inputs) {
    const decision = send(project, input);
    if (!decision.ok) throw new Error(decision.rejection.reason);
    for (const event of decision.events) {
      const result = evolveProject(project, event);
      if (!result.ok) throw new Error(result.reason);
      project = result.project;
    }
  }
  if (project === null) throw new Error("run needs an input that creates the project");
  return project;
}

const create: ProjectInput = { type: "create", name: "Reports", goal: "Better reports" };
const park: ProjectInput = { type: "park" };
const activate: ProjectInput = { type: "activate" };

describe("create", () => {
  test("creates an active project", () => {
    expect(send(null, create)).toEqual({
      ok: true,
      events: [stamped({ type: "project.created", name: "Reports", goal: "Better reports" })],
    });
    expect(run(create)).toEqual({
      id,
      name: "Reports",
      goal: "Better reports",
      status: "active",
      createdAt: at,
    });
  });

  test("is rejected when the project already exists", () => {
    expect(send(run(create), create)).toEqual({
      ok: false,
      rejection: { input: "create", reason: "There is already a project called reports." },
    });
  });

  test("is rejected without a name or a goal", () => {
    expect(send(null, { ...create, name: " " })).toEqual({
      ok: false,
      rejection: { input: "create", reason: "A project needs a name." },
    });
    expect(send(null, { ...create, goal: "" })).toEqual({
      ok: false,
      rejection: { input: "create", reason: "A project needs a goal." },
    });
  });
});

describe("park", () => {
  test("parks an active project", () => {
    expect(send(run(create), park)).toEqual({
      ok: true,
      events: [stamped({ type: "project.parked" })],
    });
    expect(run(create, park).status).toBe("parked");
  });

  test("is rejected for a project that is already parked", () => {
    expect(send(run(create, park), park)).toEqual({
      ok: false,
      rejection: { input: "park", reason: "reports is already parked." },
    });
  });
});

describe("activate", () => {
  test("activates a parked project", () => {
    expect(send(run(create, park), activate)).toEqual({
      ok: true,
      events: [stamped({ type: "project.activated" })],
    });
    expect(run(create, park, activate).status).toBe("active");
  });

  test("is rejected for a project that is already active", () => {
    expect(send(run(create), activate)).toEqual({
      ok: false,
      rejection: { input: "activate", reason: "reports is already active." },
    });
  });
});

describe("any input but create", () => {
  test("is rejected for a project that doesn't exist", () => {
    expect(send(null, park)).toEqual({
      ok: false,
      rejection: { input: "park", reason: "There is no project called reports." },
    });
  });
});

describe("evolveProject", () => {
  test("refuses an event for a project that doesn't exist", () => {
    expect(evolveProject(null, stamped({ type: "project.parked" }))).toEqual({
      ok: false,
      reason: "project.parked can't apply: reports doesn't exist.",
    });
  });

  test("refuses to create a project twice", () => {
    const created = stamped({ type: "project.created", name: "Reports", goal: "Better reports" });
    expect(evolveProject(run(create), created)).toEqual({
      ok: false,
      reason: "project.created can't apply: reports already exists.",
    });
  });
});
