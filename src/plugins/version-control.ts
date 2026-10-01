// The version-control plugin: what the daemon asks of git, or of any tool
// that takes its place. Each call answers with a value, never a throw, so a
// failure becomes a reply the core can decide on.
//
// Every call may arrive twice. If the daemon dies after a command went out
// but before it was marked done, the command goes out again after the
// restart. Doing it twice must have the same effect as doing it once. Two
// calls can also overlap, and must then answer as if one came after the
// other. A worktree only counts as made once its creation has finished. One
// left half made by a crash is made again only with proof the plugin
// started it and nothing was done in it since. Anything else at its path
// is someone's work: it is refused and left as it is.

import type { BranchFacts, CommitSha, SpecWorktree, TaskId, Worktree } from "../core/types";

export type Done<T> = { ok: true; value: T } | { ok: false; message: string };

// The commit a task's agent reported done, to check.
export type CheckRequest = { taskId: TaskId; head: CommitSha };

// What to merge: exactly `head` from the task's worktree, even if the
// branch has moved on since. The title names the commit on main. `file`,
// if given, is one more file the merge writes into its commit, such as the
// task's approved spec at docs/specs/12-csv-export.md. The task's branch
// never holds it.
export type MergeRequest = {
  taskId: TaskId;
  title: string;
  worktree: Worktree;
  head: CommitSha;
  file?: FileToAdd;
};

// A file for the merge to add: where it goes in the repository, and its
// text, exactly.
export type FileToAdd = { path: string; text: string };

// Runs the local checks in a folder. The daemon owns the checks, so it
// hands this to the gate and the merge, which call it on a copy of their
// own. `stop` ends them early, such as when the daemon stops, and they then
// count as failed.
export type RunChecks = (dir: string, stop?: AbortSignal) => Promise<Done<null>>;

// What to undo: a commit a merge put on main, for this task. The reason
// goes in the new commit's message.
export type RevertRequest = { taskId: TaskId; commit: CommitSha; reason: string };

// Which worktree to create. The core's create_worktree command has no
// title, so the daemon adds the task's title for the branch name.
export type WorktreeRequest = { taskId: TaskId; title: string; build: number };

// Which spec worktree to create. The title names its folder, like a
// build's.
export type SpecWorktreeRequest = { taskId: TaskId; title: string };

// How many characters of the title a short name keeps, at most.
const maxTitleLength = 40;

// The name a task goes by in the repository, such as "12-csv-export". Its
// branch is "task/12-csv-export", and its spec file
// "docs/specs/12-csv-export.md". The title keeps only lowercase letters and
// digits, joined by dashes. A title longer than 40 characters is cut after
// the last whole word that fits, so "take-a-discount-off-the-total-a-whole-
// percentage" becomes "take-a-discount-off-the-total-a-whole". Only a first
// word longer than 40 characters is cut inside the word. A title with no
// letters or digits leaves only the number, such as "12".
export function shortName(taskId: TaskId, title: string): string {
  const all = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let words = "";
  for (const word of all.split("-")) {
    const longer = words === "" ? word : `${words}-${word}`;
    if (longer.length > maxTitleLength) break;
    words = longer;
  }
  if (words === "") words = all.slice(0, maxTitleLength);
  return words === "" ? String(taskId) : `${taskId}-${words}`;
}

export interface VersionControl {
  // A new worktree for this build of the task, on a new branch from main,
  // named after the task: "task/12-csv-export", then "task/12-csv-export-2"
  // for build 2. Asked again, it gives back the same worktree and changes
  // nothing. A failure leaves nothing behind, since the core then records
  // no worktree to clean up later.
  createWorktree(request: WorktreeRequest): Promise<Done<Worktree>>;

  // What the task's branch holds, for when its agent reports done: the
  // commit at its tip, its own commits beyond main, and every file it
  // changed since it left main. A renamed file counts under both names.
  // Refused while the worktree has uncommitted work, since the gates and
  // the merge only see what is committed.
  readBranch(worktree: Worktree): Promise<Done<BranchFacts>>;

  // Runs the checks in a fresh copy of exactly `head`, then removes the
  // copy. Nothing in the task's worktree is seen or changed, so an agent
  // editing meanwhile, or a check that writes files, can't change what is
  // checked. Gives back the checks' own result, or why the copy couldn't be
  // made.
  checkCommit(request: CheckRequest, runChecks: RunChecks): Promise<Done<null>>;

  // The tracked files with uncommitted changes in any checkout of main.
  // A merge can't move main over them, so the daemon asks before merging.
  // Files git doesn't track are left out.
  uncommittedOnMain(): Promise<Done<string[]>>;

  // Squash-merges exactly `head` onto main, as one commit. It brings the
  // work up to date with main first, then runs the checks on the result.
  // The checks may leave build output, but mustn't commit or change tracked
  // files, or they tested something other than what would land. Main only
  // moves if all this succeeds, only to the exact commit the checks tested,
  // only if it is still where the merge began, and never over uncommitted
  // edits or ignored files in a checkout of main. It doesn't move while
  // main is being rebased or bisected, or is checked out in more than one
  // place. If moving fails, a checkout of main is left as it was, with your
  // own edits kept. Hooks run as usual, but nothing they add can land: the
  // result must be one commit on the old main, holding exactly main merged
  // with `head`, plus the request's file with exactly its text, if it has
  // one. That file replaces any version on main or on the branch, and is
  // added even if the repository's ignore files cover it. The checks see
  // it. The merge is refused if it already holds a path that differs from
  // the file's only in letter case, such as docs/specs/12-CSV-export.md,
  // and the message names that path. The task's branch is never changed.
  // A failure leaves main as it was, and the message says why. Asked again
  // after it succeeded, it gives back the same commit and merges nothing
  // twice.
  //
  // Known limits:
  // - This proves the merge once reached main, not that main still holds
  //   it. Merge a task, revert it, then merge the same head again, and it
  //   reports success with the work not on main.
  // - A finished merge is remembered by task and head only, not by the
  //   file. Asked again for the same task and head with a revised spec, it
  //   gives back the earlier commit and lands nothing new.
  //   The normal flow can't hit either limit, since a rebuilt task gets a
  //   new branch and head.
  // - Attributes set on the branch, such as a .gitattributes with eol or
  //   ident for docs/specs/*, can change the copy of the file the checks
  //   read. What lands on main is always the file's exact text.
  merge(request: MergeRequest, runChecks: RunChecks): Promise<Done<CommitSha>>;

  // Undoes one commit on main by adding a new commit that reverses it, and
  // gives back the new commit. The commit must be on main and have one
  // parent, as a merge's squashed commit does. The result must be one
  // commit on the old main, holding exactly main with that commit undone,
  // so nothing a hook adds can land. Main moves under the same rules as a
  // merge: only if it is still where the revert began, never over your
  // uncommitted edits or ignored files, and not while main is being
  // rebased or bisected or is checked out in more than one place. If
  // moving fails, a checkout of main is left as it was. A conflict leaves
  // main as it was, and the message names the files. No checks run. Asked
  // again after it succeeded, it gives back the same commit and reverts
  // nothing twice. As with the merge, this proves the revert once reached
  // main, not that main still has the commit undone.
  revert(request: RevertRequest): Promise<Done<CommitSha>>;

  // Removes the worktree. Its uncommitted changes are committed to its
  // branch first, so no work is lost, and the branch is kept. Removing one
  // that is already gone does nothing.
  removeWorktree(worktree: Worktree): Promise<Done<null>>;

  // A copy of main to write the task's spec in, on no branch, apart from
  // your checkout and every other worktree. Asked again, it gives back the
  // same copy and changes nothing in it, since a spec agent may already be
  // reading it. Anything at its path that the plugin didn't make is someone
  // else's, so it is refused and left as it is.
  createSpecWorktree(request: SpecWorktreeRequest): Promise<Done<SpecWorktree>>;

  // Removes a spec worktree, with anything changed in it. Nothing is saved:
  // the spec itself goes to Skelcrew, never into a file there. Removing one
  // that is already gone does nothing. Anything at its path that the plugin
  // didn't make is left as it is.
  removeSpecWorktree(worktree: SpecWorktree): Promise<Done<null>>;
}
