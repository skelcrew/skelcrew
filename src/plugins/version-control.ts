// The version-control plugin: what the daemon asks of git, or of any tool
// that takes its place. Each call answers with a value, never a throw, so a
// failure becomes a reply the core can decide on.
//
// Every call may arrive twice. If the daemon dies after a command went out
// but before it was marked done, the command goes out again after the
// restart. Doing it twice must have the same effect as doing it once. Two
// calls can also overlap, and must then answer as if one came after the
// other. A worktree only counts as made once its creation has finished, so
// one left half made by a crash is made again, not trusted.

import type { TaskId, Worktree } from "../core/types";

export type Done<T> = { ok: true; value: T } | { ok: false; message: string };

// Which worktree to create. The core's create_worktree command has no
// title, so the daemon adds the task's title for the branch name.
export type WorktreeRequest = { taskId: TaskId; title: string; build: number };

export interface VersionControl {
  // A new worktree for this build of the task, on a new branch from main,
  // named after the task: "task/12-csv-export", then "task/12-csv-export-2"
  // for build 2. Asked again, it gives back the same worktree and changes
  // nothing. A failure leaves nothing behind, since the core then records
  // no worktree to clean up later.
  createWorktree(request: WorktreeRequest): Promise<Done<Worktree>>;

  // Removes the worktree. Its uncommitted changes are committed to its
  // branch first, so no work is lost, and the branch is kept. Removing one
  // that is already gone does nothing.
  removeWorktree(worktree: Worktree): Promise<Done<null>>;
}
