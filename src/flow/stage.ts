// A task's stage: where it is, from an open issue to the merge. Every command that shows a
// task reads its stage from here.
import { z } from "zod";
import { readyToMerge } from "./status.ts";
import type { Thread } from "./thread.ts";

export const Stage = z.enum(["issue", "working", "ready for review", "merged", "closed"]);
export type Stage = z.infer<typeof Stage>;

// Returns a task's stage, given its builder thread, or null for a task that never started, and
// whether the tracker still has its issue open, which a task with no issue never has. A task
// with a thread at work is working, as is one whose thread stopped or failed, so it doesn't
// vanish. It is ready for review once Skelcrew's reviewer approved its latest round and CI is
// green. Work that ended merges it, and otherwise puts it back in stage issue while its issue is
// open, as sc start starts it again from there, or closes it.
export function taskStage(thread: Thread | null, issueOpen: boolean): Stage {
  const ended = issueOpen ? "issue" : "closed";
  if (thread === null) return ended;
  if (thread.status === "done") return thread.merged ? "merged" : ended;
  return readyToMerge(thread) ? "ready for review" : "working";
}
