// Draft pull requests for reading, kept in step with the tasks. The core
// sends no command for them. Instead the daemon calls `update` after every
// change, and this compares each task with the pull requests it opened.

import * as z from "zod";
import { CommitSha, TaskId } from "../core/ids";
import type { Loaded, Saved } from "../loop/loop";

// A pull request Skelcrew opened for a task and hasn't closed yet. `head`
// is the commit last pushed to it.
export const OpenPullRequest = z.strictObject({
  task: TaskId,
  branch: z.string().min(1),
  head: CommitSha,
  number: z.number().int().positive(),
  url: z.string().min(1),
});
export type OpenPullRequest = z.infer<typeof OpenPullRequest>;

// Where the open pull requests are remembered, so a restart neither loses
// one nor opens a second. One per task at most. EventStore is the real one.
export interface PullRequestLog {
  loadPullRequests(): Loaded<{ pullRequests: OpenPullRequest[] }>;
  // Replaces the task's pull request, if it had one.
  savePullRequest(pullRequest: OpenPullRequest): Saved;
  forgetPullRequest(task: TaskId): Saved;
}
