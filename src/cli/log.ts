// What `skelcrew log` prints: one line per event, oldest first, with its
// time and what happened in plain words. For example:
//
//   2026-09-30 10:02  You claimed it, as session you-2.
//
// A text that runs over several lines, such as a failed check's output,
// keeps its lines, indented under the first.

import type { GateName, TaskEvent } from "../core/types";
import { describeBlock } from "../daemon/daemon";

// The line above the events when the oldest didn't fit in the daemon's
// reply, or none.
export function leftOutLine(leftOut: number): string[] {
  if (leftOut === 0) return [];
  return [leftOut === 1 ? "1 older event is left out." : `${leftOut} older events are left out.`];
}

// "2026-09-30 10:02" and two spaces.
const INDENT = " ".repeat(18);

export function logLines(events: TaskEvent[]): string[] {
  return events.flatMap((event, index) => {
    const [first = "", ...rest] = happened(event, events.slice(0, index)).split("\n");
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

// `before` holds the events that came before this one, oldest first. Some
// lines depend on them.
function happened(event: TaskEvent, before: TaskEvent[]): string {
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
    // The saved events don't say whether you approved an agent's spec, or
    // spec_approval: never let it through. A spec you write always goes
    // straight to Ready.
    case "task.ready": {
      const last = before.at(-1);
      return last?.type === "task.specced" && last.by === "human"
        ? "A spec you write needs no approval, so the task is Ready."
        : "The task is Ready to build from this spec.";
    }
    case "task.dispatch_started":
      return "Skelcrew picked it to start.";
    case "task.worktree_created":
      return `Its worktree was made on branch ${event.worktree.branch}, at ${event.worktree.path}.`;
    case "task.dispatched":
      return claimedBy(before) === event.session
        ? "Your session is working on it."
        : `An agent started as ${event.session}.`;
    case "task.claimed":
      return `You claimed it, as session ${event.session}.`;
    case "task.question_asked": {
      const { text, options } = event.question;
      return options.length === 0
        ? `The agent asked: ${text}`
        : `The agent asked: ${text}\nOptions: ${options.join(", ")}.`;
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
      // The commit is the merge that was undone, not the revert's own.
      return `The revert went through, undoing commit ${event.commit.slice(0, 7)}. The task went back to Spec with your reason: ${event.reason}`;
    case "task.blocked":
      return `Blocked. ${describeBlock(event.reason)}`;
    case "task.unblocked":
      return "Unblocked, to try again.";
    case "task.dropped":
      return "Dropped.";
    case "task.usage_recorded":
      return `Used ${event.usage.tokens.toLocaleString("en-US")} tokens in ${duration(event.usage.ms)} so far.`;
  }
}

// The session that claimed the task, if a claim was its latest start. A
// claim in Ready waits for the worktree, then the claiming session becomes
// the agent. No agent is started.
function claimedBy(before: TaskEvent[]): string | null {
  const start = before.findLast(
    (event) => event.type === "task.claimed" || event.type === "task.dispatch_started",
  );
  return start?.type === "task.claimed" ? start.session : null;
}

// The local and remote gates run several checks. The review is one step.
function checks(gate: GateName): string {
  return gate === "review" ? "The review" : `The ${gate} checks`;
}

// "under a minute", "1 minute", "45 minutes".
function duration(ms: number): string {
  return ms < 60_000 ? "under a minute" : count(Math.round(ms / 60_000), "minute");
}

function count(n: number, thing: string): string {
  return `${n} ${thing}${n === 1 ? "" : "s"}`;
}
