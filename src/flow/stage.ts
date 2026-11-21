// A task's stage: where it is, from an open issue to the merge. Every command that shows a
// task reads its stage from here.
import { z } from "zod";
import { waitsOnFirstCheck } from "./decide.ts";
import { passedReviewStage, roundOf } from "./ledger.ts";
import { readyToMerge } from "./status.ts";
import type { Thread } from "./thread.ts";

export const Stage = z.enum(["issue", "working", "ready for review", "merged", "closed"]);
export type Stage = z.infer<typeof Stage>;

// Returns a task's stage, given its builder thread, or null for a task that never started, and
// whether the tracker still has its issue open, which a task with no issue never has. A task
// with a thread at work is working, as is one whose thread stopped or failed, so it doesn't
// vanish. It is ready for review once Skelcrew's reviewer approved its latest round and CI is
// green, while its thread works or waits: a thread that failed or stopped after an approval
// keeps its review, but waits for sc start, not for you to merge. Work that ended merges it,
// and otherwise puts it back in stage issue while its issue is open, as sc start starts it
// again from there, or closes it.
export function taskStage(thread: Thread | null, issueOpen: boolean): Stage {
  const ended = issueOpen ? "issue" : "closed";
  if (thread === null) return ended;
  if (thread.status === "done") return thread.merged ? "merged" : ended;
  const live = thread.status === "working" || thread.status === "waiting";
  return live && readyToMerge(thread) ? "ready for review" : "working";
}

// The stages of the list, in the order it shows them: not started yet, a builder at work, a
// review running or waiting, an approval waiting on CI, ready for you to merge, and ended.
export const ListStage = z.enum(["backlog", "building", "reviewing", "checks", "ready", "done"]);
export type ListStage = z.infer<typeof ListStage>;

// Returns the stage of the list a task shows under, from the same thread and issue as its stage.
// Needs you is never a stage: a task that needs you stays where its work is, and its row says
// so. A thread that stopped or failed is under Building, as its builder is what must start
// again. A review under way, waiting for a place or for its usage limit, or one that couldn't
// run, is under Reviewing. An approval the builder isn't working on waits on CI, as does a submit
// whose flow has no review stage, from the moment it is pushed. Ready includes a
// merge when ready that is about to merge, as it is approved and green.
export function listStage(thread: Thread | null, issueOpen: boolean): ListStage {
  const stage = taskStage(thread, issueOpen);
  if (stage === "issue") return "backlog";
  if (stage === "merged" || stage === "closed") return "done";
  if (stage === "ready for review") return "ready";
  if (thread === null || thread.status === "failed" || thread.status === "stopped")
    return "building";
  if (waitsOnFirstCheck(thread)) return "checks";
  const reviewing = roundOf(thread).submitting !== null || roundOf(thread).reviewing !== null;
  if (reviewing || thread.review_limited || roundOf(thread).review_failed) return "reviewing";
  if (passedReviewStage(thread) && thread.status === "waiting") return "checks";
  return "building";
}
