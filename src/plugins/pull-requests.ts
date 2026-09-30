// The pull-request plugin: where the developer reads a task's work before
// approving its merge. Skelcrew still merges locally, with `skelcrew
// approve`. The pull request is only for reading.
//
// Each call answers with a value, never a throw. Each may also arrive
// twice, such as after a restart, and must then have the same effect as
// once: asked to show a branch that already has an open pull request, it
// gives back that one instead of opening a second.

import type { CommitSha } from "../core/types";
import type { Done } from "./version-control";

export type PullRequest = { number: number; url: string };

// What to show: exactly `head`, pushed to `branch`, in a draft pull request
// into `base`. The title and body are used only when a new one is opened.
export type ShowRequest = {
  branch: string;
  head: CommitSha;
  base: string;
  title: string;
  body: string;
};

// Which pull request to close, the comment to leave on it, and the branch
// Skelcrew pushed for it.
export type CloseRequest = { number: number; branch: string; comment: string };

export interface PullRequests {
  // Pushes `head` to `branch`, never by force, then gives back the open
  // pull request for that branch. It opens a draft one if there is none.
  // A failure says why in plain words, such as that the repository has no
  // `origin` remote or that `gh` isn't logged in.
  show(request: ShowRequest): Promise<Done<PullRequest>>;

  // Closes the pull request with a comment, then deletes the pushed branch
  // on the remote. The local branch is kept, as it always is.
  close(request: CloseRequest): Promise<Done<null>>;
}
