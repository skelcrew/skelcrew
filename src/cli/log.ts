// What `skelcrew log` prints: one line per event, oldest first, with its
// time and what happened in plain words. For example:
//
//   2026-09-30 10:02  Claimed by you-2.
//
// A text that runs over several lines, such as a failed check's output,
// keeps its lines, indented under the first.

import type { GateName, TaskEvent } from "../core/types";
import { describeBlock } from "../daemon/daemon";

// "2026-09-30 10:02" and two spaces.
const INDENT = " ".repeat(18);

export function logLines(events: TaskEvent[]): string[] {
  return events.flatMap((event) => {
    const [first = "", ...rest] = happened(event).split("\n");
    return [`${time(event.at)}  ${first}`, ...rest.map((line) => `${INDENT}${line}`)];
  });
}

// The time in the reader's own time zone, to the minute.
function time(at: number): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return `${day} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function happened(event: TaskEvent): string {
  switch (event.type) {
    case "task.created": {
      const where = event.project === null ? "Added" : `Added to project ${event.project}`;
      const from = event.source === null ? "" : ` It came from ${event.source.label}.`;
      return `${where}: ${event.title}.${from}`;
    }
    case "task.project_changed":
      return event.project === null
        ? "Taken out of its project."
        : `Moved to project ${event.project}.`;
    case "task.spec_requested":
      return "A spec was asked for.";
    case "task.spec_session_started":
      return `A spec agent started as ${event.session}.`;
    case "task.specced":
      return event.by === "agent"
        ? `The agent sent a spec: ${event.spec.scope}`
        : `A spec was written by hand: ${event.spec.scope}`;
    case "task.spec_sent_back":
      return `You sent the spec back: ${event.note}`;
    case "task.ready":
      return "The spec was approved. The task is Ready.";
    case "task.dispatch_started":
      return "Picked to start, since a slot was free.";
    case "task.worktree_created":
      return `Its worktree was made on branch ${event.worktree.branch}, at ${event.worktree.path}.`;
    case "task.dispatched":
      return `An agent started as ${event.session}.`;
    case "task.claimed":
      return `Claimed by ${event.session}.`;
    case "task.question_asked": {
      const { text, options } = event.question;
      return options.length === 0
        ? `The agent asked: ${text}`
        : `The agent asked: ${text} Options: ${options.join(", ")}.`;
    }
    case "task.question_answered":
      return `You answered: ${event.text}`;
    case "task.done_reported": {
      const { commits, changedFiles } = event.branch;
      const counted = `${count(commits, "commit")}, ${count(changedFiles.length, "changed file")}`;
      return `The agent said it's done: ${counted}. ${checks(event.gate)} started.`;
    }
    case "task.gate_passed":
      return event.next === null
        ? `${checks(event.gate)} passed.`
        : `${checks(event.gate)} passed. ${checks(event.next.gate)} started.`;
    case "task.gate_failed":
      return event.failure.step === "merge"
        ? `The merge failed: ${event.failure.summary}`
        : `${checks(event.failure.step)} failed: ${event.failure.summary}`;
    case "task.checks_passed":
      return "All checks passed.";
    case "task.merge_approval_requested":
      return `It waits for your approval to merge, since it changes critical files: ${event.criticalFiles.join(", ")}.`;
    case "task.merge_sent_back":
      return `You sent the merge back: ${event.note}`;
    case "task.merge_started":
      return "Merging started.";
    case "task.merge_failed":
      return `The merge failed: ${event.failure.summary}`;
    case "task.merged":
      return `Merged as commit ${event.commit.slice(0, 7)}.`;
    case "task.revert_started":
      return `Reverting it, because: ${event.reason}`;
    case "task.revert_failed":
      return `The revert failed: ${event.summary}`;
    case "task.reverted":
      return `Reverted by commit ${event.commit.slice(0, 7)}. It went back to Spec, because: ${event.reason}`;
    case "task.blocked":
      return `Blocked. ${describeBlock(event.reason)}`;
    case "task.unblocked":
      return "Unblocked, to try again.";
    case "task.dropped":
      return "Dropped.";
    case "task.usage_recorded":
      return `Used ${event.usage.tokens} tokens in ${Math.round(event.usage.ms / 60_000)} minutes so far.`;
  }
}

function checks(gate: GateName): string {
  return `The ${gate} checks`;
}

function count(n: number, thing: string): string {
  return `${n} ${thing}${n === 1 ? "" : "s"}`;
}
