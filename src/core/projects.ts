// Projects: named groups of tasks, active or parked. They have their own
// small decide and evolve, because their rules never depend on a task.
// Only the developer sends project inputs; agents have no way to.

import type {
  DecideProject,
  EvolvedProject,
  EvolveProject,
  ProjectDecision,
  ProjectEvent,
  ProjectEventBody,
} from "./types";

export const decideProject: DecideProject = (project, envelope) => {
  const { projectId, at, input } = envelope;
  const accept = (body: ProjectEventBody): ProjectDecision => ({
    ok: true,
    events: [{ ...body, v: 1, projectId, at }],
  });
  const reject = (reason: string): ProjectDecision => ({
    ok: false,
    rejection: { input: input.type, reason },
  });

  if (input.type === "create") {
    if (project !== null) return reject(`There is already a project called ${projectId}.`);
    if (input.name.trim() === "") return reject("A project needs a name.");
    if (input.goal.trim() === "") return reject("A project needs a goal.");
    return accept({ type: "project.created", name: input.name, goal: input.goal });
  }
  if (project === null) return reject(`There is no project called ${projectId}.`);

  switch (input.type) {
    // Parking stops new agents from starting. Work already running carries on.
    case "park":
      if (project.status === "parked") return reject(`${projectId} is already parked.`);
      return accept({ type: "project.parked" });

    case "activate":
      if (project.status === "active") return reject(`${projectId} is already active.`);
      return accept({ type: "project.activated" });
  }
};

export const evolveProject: EvolveProject = (project, event) => {
  if (event.type === "project.created") {
    if (project !== null) return refuse(event, `${event.projectId} already exists`);
    return {
      ok: true,
      project: {
        id: event.projectId,
        name: event.name,
        goal: event.goal,
        status: "active",
        createdAt: event.at,
      },
    };
  }
  if (project === null) return refuse(event, `${event.projectId} doesn't exist`);

  switch (event.type) {
    case "project.parked":
      return { ok: true, project: { ...project, status: "parked" } };
    case "project.activated":
      return { ok: true, project: { ...project, status: "active" } };
  }
};

function refuse(event: ProjectEvent, why: string): EvolvedProject {
  return { ok: false, reason: `${event.type} can't apply: ${why}.` };
}
