// One task's own screen: what it needs from you, its spec, and its
// history, newest first. Enter opens it from the list.

import { leftOutLine, logLines } from "../cli/log";
import type { ProjectView, TaskView } from "../cli/status";
import { phaseNames } from "../core/task";
import type { TaskEvent } from "../core/types";
import type { Line } from "./list";
import type { Row } from "./rows";

// What `skelcrew log` answers, or why it couldn't.
export type LoadedLog =
  | { ok: true; events: TaskEvent[]; leftOut: number }
  | { ok: false; message: string };

// What the header's right side says: "Spec · approve its spec". `row` is
// the task's row in the list, which a done or dropped task doesn't have.
export function taskState(task: TaskView, row: Row | undefined): string {
  const phase = phaseNames[task.phase];
  if (row === undefined) return phase;
  return task.waitingOnYou === null ? row.says : `${phase} · ${row.says}`;
}

// The screen's lines under the header, wrapped to `width`. log is null
// until it is read.
// `project` is the task's project, when the status names it.
export function taskLines(
  task: TaskView,
  log: LoadedLog | null,
  width: number,
  project?: ProjectView,
): Line[] {
  const text = (line: string, dim = false): Line => ({ kind: "text", text: line, dim });
  const wrapped = (words: string, first = "", rest = first) =>
    wrap(words, width - first.length).map((line, i) => text(`${i === 0 ? first : rest}${line}`));
  const lines: Line[] = [];

  // What the task needs from you, and anything to read first.
  const facts: Line[] = [];
  if (task.project !== null) {
    const archived = project?.status === "archived" ? " (archived)" : "";
    facts.push(text(`Project: ${project?.name ?? task.project}${archived}`));
  }
  if (typeof task.pullRequest === "string") {
    facts.push(text(`Read it on GitHub: ${task.pullRequest}`));
    if (typeof task.pullRequestNote === "string") facts.push(...wrapped(task.pullRequestNote));
  } else if (typeof task.noPullRequest === "string") {
    facts.push(...wrapped(task.noPullRequest));
  }
  if (task.blocked !== null) facts.push(...wrapped(`Blocked: ${task.blocked}`));
  if (task.question !== null) facts.push(...wrapped(`Question: ${task.question}`));
  if (facts.length > 0) lines.push({ kind: "blank" }, ...facts);

  if (log === null) return lines;
  if (!log.ok) {
    lines.push({ kind: "blank" }, text(`The history couldn't be read: ${log.message}`));
    return lines;
  }

  // The newest spec, as it stands.
  const specced = log.events.findLast((event) => event.type === "task.specced");
  if (specced?.type === "task.specced") {
    const { scope, acceptance, openQuestions } = specced.spec;
    lines.push({ kind: "blank" }, { kind: "heading", text: "Scope" }, ...wrapped(scope, "  "));
    if (acceptance.length > 0) {
      lines.push({ kind: "blank" }, { kind: "heading", text: "Acceptance criteria" });
      for (const criterion of acceptance) lines.push(...wrapped(criterion, "  - ", "    "));
    }
    if (openQuestions.length > 0) {
      lines.push({ kind: "blank" }, { kind: "heading", text: "Open questions" });
      for (const question of openQuestions) lines.push(...wrapped(question, "  - ", "    "));
    }
  }

  // Each event's first line, newest first. The spec shows above, so the
  // rest, such as its criteria, is left to `skelcrew log`.
  const entries: string[][] = [];
  for (const line of logLines(log.events)) {
    const last = entries.at(-1);
    if (line.startsWith(" ") && last !== undefined) last.push(line);
    else entries.push([line]);
  }
  if (entries.length > 0) {
    lines.push({ kind: "blank" }, { kind: "heading", text: "History" });
    for (const [first = ""] of entries.toReversed()) lines.push(text(`  ${first}`));
    for (const line of leftOutLine(log.leftOut)) lines.push(text(`  ${line}`, true));
    if (log.leftOut > 0 || entries.some((entry) => entry.length > 1)) {
      lines.push(text(`  See it all with: skelcrew log ${task.task}`, true));
    }
  }
  return lines;
}

// Text in lines no wider than `width`, broken between words. A line of its
// own stays one.
function wrap(text: string, width: number): string[] {
  const room = Math.max(width, 20);
  return text.split("\n").flatMap((paragraph) => {
    const lines: string[] = [];
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line !== "" && line.length + 1 + word.length > room) {
        lines.push(line);
        line = word;
      } else {
        line = line === "" ? word : `${line} ${word}`;
      }
    }
    lines.push(line);
    return lines;
  });
}
