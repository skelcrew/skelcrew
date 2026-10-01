// Projects: named groups of tasks, active or archived. They have their own
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
    // Archiving stops new agents from starting. Work already running carries on.
    case "archive":
      if (project.status === "archived") return reject(`${projectId} is already archived.`);
      return accept({ type: "project.archived" });

    case "unarchive":
      if (project.status === "active") return reject(`${projectId} isn't archived.`);
      return accept({ type: "project.unarchived" });
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
    case "project.archived":
      return { ok: true, project: { ...project, status: "archived" } };
    case "project.unarchived":
      return { ok: true, project: { ...project, status: "active" } };
  }
};

function refuse(event: ProjectEvent, why: string): EvolvedProject {
  return { ok: false, reason: `${event.type} can't apply: ${why}.` };
}
