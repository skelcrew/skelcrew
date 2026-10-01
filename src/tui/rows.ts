// What the task list shows: which group each task is in, and what its row
// says. Plain data, so the screen only draws it.

import { needsClaim, type TaskView } from "../cli/status";
import { phaseNames } from "../core/task";

// `mark` asks the screen to colour the row's words: a question or a block.
export type Row = { task: TaskView; says: string; mark: "question" | "blocked" | null };
export type Group = { heading: string; rows: Row[] };

// The groups in the order you act on them. Empty ones are left out, and so
// are done and dropped tasks, which only get counted.
export function groupsOf(tasks: TaskView[]): Group[] {
  const open = tasks.filter((task) => task.phase !== "done" && task.phase !== "dropped");
  const others = open.filter((task) => task.waitingOnYou === null);
  const groups: Group[] = [
    {
      heading: "Waiting on you",
      rows: tasks.filter((task) => task.waitingOnYou !== null).map(waitingRow),
    },
    {
      heading: "Working",
      rows: others.filter((task) => task.phase !== "idea" && !needsClaim(task)).map(workingRow),
    },
    {
      heading: "Waiting for an agent",
      rows: others.filter(needsClaim).map((task) => {
        const skill = task.phase === "spec" ? "spec" : "develop";
        const says = `${phaseNames[task.phase]} · start it with /${skill} ${task.task}`;
        return { task, says, mark: null };
      }),
    },
    {
      heading: "Ideas",
      rows: others
        .filter((task) => task.phase === "idea")
        .map((task) => ({ task, says: "Idea", mark: null })),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

function waitingRow(task: TaskView): Row {
  switch (task.waitingOnYou) {
    case "retry": {
      const [reason = ""] = (task.blocked ?? "").split("\n");
      return { task, says: `blocked: ${reason}`, mark: "blocked" };
    }
    case "answer":
      return { task, says: `question: ${task.question ?? ""}`, mark: "question" };
    case "spec_approval":
      return { task, says: "approve its spec", mark: null };
    case "merge_approval": {
      const link = typeof task.pullRequest === "string" ? " · PR on GitHub" : "";
      return { task, says: `approve its merge${link}`, mark: null };
    }
    case "revert_failed":
      return { task, says: "its revert failed", mark: "blocked" };
    case null:
      return { task, says: "", mark: null };
  }
}

// Its phase, the session working on it, and whether it is merging.
function workingRow(task: TaskView): Row {
  const parts = [phaseNames[task.phase]];
  if (task.session !== null) parts.push(task.session);
  if (task.step === "merging") parts.push("merging");
  return { task, says: parts.join(" · "), mark: null };
}

// The line at the top: "4 wait on you · 2 working".
export function counts(groups: Group[]): string {
  const sizeOf = (heading: string) =>
    groups.find((group) => group.heading === heading)?.rows.length ?? 0;
  const waiting = sizeOf("Waiting on you");
  const working = sizeOf("Working");
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? "waits" : "wait"} on you`);
  if (working > 0) parts.push(`${working} working`);
  return parts.join(" · ");
}

// The line under the list: "8 done · 2 dropped", or "" when there are none.
export function finished(tasks: TaskView[]): string {
  const done = tasks.filter((task) => task.phase === "done").length;
  const dropped = tasks.filter((task) => task.phase === "dropped").length;
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} done`);
  if (dropped > 0) parts.push(`${dropped} dropped`);
  return parts.join(" · ");
}
