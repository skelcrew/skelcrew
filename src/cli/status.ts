// What `skelcrew status` answers, and how it is shown. The TUI reads the
// same answer, so both say the same thing about a task.

import * as z from "zod";
import { TaskId } from "../core/ids";
import { phaseNames, type WaitingOn } from "../core/task";
import type { Phase } from "../core/types";

export const phases: [Phase, ...Phase[]] = [
  "idea",
  "spec",
  "ready",
  "in_progress",
  "checks",
  "done",
  "dropped",
];

const waitingOn: [WaitingOn, ...WaitingOn[]] = [
  "retry",
  "answer",
  "spec_approval",
  "merge_approval",
  "revert_failed",
];

export const statusResult = z.object({
  tasks: z.array(
    z.object({
      task: TaskId,
      title: z.string(),
      project: z.string().nullable(),
      phase: z.enum(phases),
      // The step within the phase, such as "merging". Only some are shown.
      step: z.string().nullable(),
      session: z.string().nullable(),
      // Whether that session is yours, so its use isn't counted, and what
      // the task's agents have used. A daemon from before usage leaves
      // them out.
      yours: z.boolean().optional(),
      usage: z.object({ tokens: z.number(), ms: z.number() }).optional(),
      blocked: z.string().nullable(),
      question: z.string().nullable(),
      waitingOnYou: z.enum(waitingOn).nullable(),
      // The draft pull request to read before approving a merge, or why
      // there is none. `pullRequestNote` warns when the pull request shows
      // older work. A daemon from before pull requests leaves them out.
      pullRequest: z.string().nullable().optional(),
      noPullRequest: z.string().nullable().optional(),
      pullRequestNote: z.string().nullable().optional(),
    }),
  ),
  // Every project, even one with no tasks, by name. A daemon from before
  // projects leaves them out.
  projects: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        goal: z.string(),
        status: z.enum(["active", "archived"]),
      }),
    )
    .optional(),
});

export type TaskView = z.infer<typeof statusResult>["tasks"][number];
export type ProjectView = NonNullable<z.infer<typeof statusResult>["projects"]>[number];

// What `skelcrew status` prints.
export function statusLines(tasks: TaskView[], projects: ProjectView[] = []): string[] {
  if (tasks.length === 0 && projects.length === 0) {
    return ['No tasks yet. Add one with: skelcrew add "<task>"'];
  }
  const lines: string[] = [];
  // A task in an archived project can't be claimed, so it waits on nobody.
  const archived = new Set(
    projects.filter((project) => project.status === "archived").map((project) => project.id),
  );
  const toClaim = (task: TaskView) =>
    needsClaim(task) && (task.project === null || !archived.has(task.project));
  const waiting = tasks.filter((task) => task.waitingOnYou !== null || toClaim(task));
  if (waiting.length > 0) {
    lines.push("Waiting on you:");
    for (const task of waiting) {
      const need = toClaim(task)
        ? `nobody is working on it. Claim it to go on: skelcrew claim ${task.task}`
        : needs(task);
      lines.push(`- #${task.task} ${task.title}: ${need}`);
    }
    lines.push("");
  }
  // Without projects, the phases stand alone. With any, each project gets
  // its phases, indented, by name. A project with no tasks says so, and
  // tasks in no project come last.
  const known = new Set(projects.map((project) => project.id));
  // A task can name a project the answer leaves out, such as from an older
  // daemon. It is shown by its ID.
  const unlisted = [...new Set(tasks.map((task) => task.project))]
    .filter((id): id is string => id !== null && !known.has(id))
    .map((id): ProjectView => ({ id, name: id, goal: "", status: "active" }));
  const all = [...projects, ...unlisted].sort((a, b) => a.name.localeCompare(b.name));
  const loose = tasks.filter((task) => task.project === null);
  if (all.length === 0) return [...lines, ...byPhase(loose, "")];
  for (const [i, project] of all.entries()) {
    if (i > 0) lines.push("");
    const name = `Project ${project.name}${project.status === "archived" ? " (archived)" : ""}`;
    const inProject = tasks.filter((task) => task.project === project.id);
    if (inProject.length === 0) lines.push(`${name}: no tasks yet.`);
    else lines.push(`${name}:`, ...byPhase(inProject, "  "));
  }
  if (loose.length > 0) lines.push("", "No project:", ...byPhase(loose, "  "));
  return lines;
}

function byPhase(tasks: TaskView[], indent: string): string[] {
  const lines: string[] = [];
  for (const phase of phases) {
    const inPhase = tasks.filter((task) => task.phase === phase);
    if (inPhase.length === 0) continue;
    lines.push(`${indent}${phaseNames[phase]}:`);
    for (const task of inPhase) {
      const blocked = task.blocked === null ? "" : ` (blocked: ${task.blocked})`;
      const merging = task.step === "merging" ? " (merging)" : "";
      const working =
        task.session === null
          ? ""
          : task.yours === true
            ? ` (you are working on it in ${task.session}, so it isn't counted)`
            : ` (${task.session} is working on it)`;
      lines.push(
        `${indent}- #${task.task} ${task.title}${used(task)}${working}${merging}${blocked}`,
      );
    }
  }
  return lines;
}

// " · 48,210 tokens · 23 min", or "" while nothing has been used.
function used(task: TaskView): string {
  const usage = task.usage;
  if (usage === undefined || (usage.tokens === 0 && usage.ms === 0)) return "";
  const minutes = usage.ms < 60_000 ? "under 1 min" : `${Math.round(usage.ms / 60_000)} min`;
  return ` · ${usage.tokens.toLocaleString("en-US")} tokens · ${minutes}`;
}

// Skelcrew doesn't start agents itself yet, so a task waiting for an agent
// waits for someone to claim it: in Spec, Ready or In progress, with no
// session, not blocked, and nothing else waiting on you.
export function needsClaim(task: TaskView): boolean {
  const phases: TaskView["phase"][] = ["spec", "ready", "in_progress"];
  return (
    phases.includes(task.phase) &&
    task.step === "queued" &&
    task.session === null &&
    task.blocked === null &&
    task.waitingOnYou === null
  );
}

// What the task waits on you for, in full, or "" when nothing.
export function needs(task: TaskView): string {
  switch (task.waitingOnYou) {
    case "retry":
      return "blocked, so retry or drop it.";
    case "answer":
      return `answer its question: ${task.question ?? ""}`;
    case "spec_approval":
      return "approve its spec.";
    case "merge_approval": {
      if (typeof task.pullRequest === "string") {
        const note = typeof task.pullRequestNote === "string" ? ` ${task.pullRequestNote}` : "";
        return `approve its merge. Read it first on GitHub: ${task.pullRequest}${note}`;
      }
      if (typeof task.noPullRequest === "string") {
        return `approve its merge. ${task.noPullRequest}`;
      }
      return "approve its merge.";
    }
    case "revert_failed":
      return "its revert failed. Revert it by hand, or try again.";
    case null:
      return "";
  }
}
