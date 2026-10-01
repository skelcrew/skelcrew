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
});

export type TaskView = z.infer<typeof statusResult>["tasks"][number];

// What `skelcrew status` prints.
export function statusLines(tasks: TaskView[]): string[] {
  if (tasks.length === 0) return ['No tasks yet. Add one with: skelcrew add "<task>"'];
  const lines: string[] = [];
  const waiting = tasks.filter((task) => task.waitingOnYou !== null || needsClaim(task));
  if (waiting.length > 0) {
    lines.push("Waiting on you:");
    for (const task of waiting) {
      const need = needsClaim(task)
        ? `nobody is working on it. Claim it to go on: skelcrew claim ${task.task}`
        : needs(task);
      lines.push(`- #${task.task} ${task.title}: ${need}`);
    }
    lines.push("");
  }
  // Without projects, the phases stand alone. With any, each project gets
  // its phases, indented, and tasks in no project come last.
  const projects = [...new Set(tasks.map((task) => task.project))].sort(byProject);
  if (projects.length === 1 && projects[0] === null) return [...lines, ...byPhase(tasks, "")];
  for (const [i, project] of projects.entries()) {
    if (i > 0) lines.push("");
    lines.push(project === null ? "No project:" : `Project ${project}:`);
    const inProject = tasks.filter((task) => task.project === project);
    lines.push(...byPhase(inProject, "  "));
  }
  return lines;
}

// Projects by name, and no project last.
function byProject(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a.localeCompare(b);
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
      const working = task.session === null ? "" : ` (${task.session} is working on it)`;
      lines.push(`${indent}- #${task.task} ${task.title}${working}${merging}${blocked}`);
    }
  }
  return lines;
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
