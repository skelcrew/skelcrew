// Draft pull requests for reading, kept in step with the tasks. The core
// sends no command for them. Instead the daemon calls `update` after every
// change, and this compares each task with the pull requests it opened:
//
// - A merge waits for your approval, and the task has no pull request for
//   this work yet: push the branch and open a draft.
// - The task no longer works on the branch its pull request shows, such as
//   after the merge, a drop, or a send-back to Spec: close it, with a
//   comment that says why.
//
// After a send-back to In progress, or a failed merge, the task keeps its
// branch. So its draft stays open, and the next wait pushes the new work
// to it.
//
// Nothing here can stop or fail a task. A pull request that can't be
// opened leaves a note that `status` shows, and the merge waits as always.
// It is tried again every five minutes, and when new work arrives.

import * as z from "zod";
import { CommitSha, TaskId } from "../core/ids";
import { phaseNames, waitingOnYou } from "../core/task";
import type { GateName, Task } from "../core/types";
import type { Loaded, Saved } from "../loop/loop";
import type { PullRequests } from "../plugins/pull-requests";

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

// What `status` shows of a task's pull request: its link, or why there is
// none while its merge waits for you. `pullRequestNote` warns when the
// link shows older work than the merge waiting for you, and says why.
export type Shown = {
  pullRequest: string | null;
  noPullRequest: string | null;
  pullRequestNote: string | null;
};

// Work that couldn't be shown. It isn't tried again for the same commit
// until the retry timer next fires.
type Failed = { branch: string; head: CommitSha; message: string };

// How often work that failed is tried again, such as after you run
// `gh auth login` or the network comes back. Five minutes keeps a GitHub
// that is down from being asked all the time.
export const RETRY_MS = 5 * 60_000;

export class DraftPullRequests {
  private readonly open = new Map<TaskId, OpenPullRequest>();
  private readonly failed = new Map<TaskId, Failed>();
  // Closes that failed. Tried again when the retry timer next fires.
  private readonly unclosed = new Set<TaskId>();
  private running = false;
  private again = false;
  private retryDue = false;
  private stopped = false;
  private readonly retryTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly plugin: PullRequests,
    private readonly log: PullRequestLog,
    private readonly base: string,
    private readonly gates: GateName[],
    private readonly tasks: () => Task[],
    retryMs = RETRY_MS,
  ) {
    // A log that can't be read starts with none remembered. Showing a
    // branch gives back the pull request it already has, so none is
    // opened twice.
    const loaded = log.loadPullRequests();
    if (loaded.ok) for (const saved of loaded.pullRequests) this.open.set(saved.task, saved);
    this.retryTimer = setInterval(() => {
      if (this.failed.size === 0 && this.unclosed.size === 0) return;
      this.retryDue = true;
      this.update();
    }, retryMs);
    // The timer alone never keeps the daemon's process running.
    this.retryTimer.unref();
  }

  shown(task: Task): Shown {
    const open = this.open.get(task.id);
    const failed = this.failed.get(task.id);
    const waiting = task.phase === "checks" && waitingOnYou(task) === "merge_approval";
    if (open !== undefined) {
      // For example, after a send-back the agent amended its commit, and
      // the push was refused. The draft still shows the old commit.
      let pullRequestNote: string | null = null;
      if (task.phase === "checks" && waiting && open.head !== task.branch.head) {
        const why =
          failed !== undefined && failed.head === task.branch.head
            ? failed.message
            : "Skelcrew is pushing the new work.";
        pullRequestNote = `It still shows older work, commit ${open.head.slice(0, 7)}. ${why}`;
      }
      return { pullRequest: open.url, noPullRequest: null, pullRequestNote };
    }
    if (failed !== undefined && waiting) {
      return {
        pullRequest: null,
        noPullRequest: `No pull request was opened. ${failed.message}`,
        pullRequestNote: null,
      };
    }
    return { pullRequest: null, noPullRequest: null, pullRequestNote: null };
  }

  // Looks at every task again, in the background. One look runs at a
  // time. A call during one makes it look once more when it is done, so
  // no change is missed and no two looks open the same pull request.
  update(): void {
    this.again = true;
    if (this.running || this.stopped) return;
    this.running = true;
    void this.look().finally(() => {
      this.running = false;
    });
  }

  // Nothing more is saved after this. A pull request still being opened
  // is found again by the next daemon, which asks GitHub for it.
  stop(): void {
    this.stopped = true;
    clearInterval(this.retryTimer);
  }

  private async look(): Promise<void> {
    while (this.again && !this.stopped) {
      this.again = false;
      const retry = this.retryDue;
      this.retryDue = false;
      for (const task of this.tasks()) {
        if (this.stopped) return;
        try {
          await this.keepInStep(task, retry);
        } catch {
          // A plugin that throws is a bug there. The task goes on as today.
        }
      }
    }
  }

  // `retry` tries again work that failed before.
  private async keepInStep(task: Task, retry: boolean): Promise<void> {
    let open = this.open.get(task.id);
    if (open !== undefined && !worksOn(task, open.branch)) {
      if (this.unclosed.has(task.id) && !retry) return;
      const closed = await this.plugin.close({
        number: open.number,
        branch: open.branch,
        head: open.head,
        comment: closingComment(task),
      });
      if (this.stopped) return;
      if (!closed.ok) {
        this.unclosed.add(task.id);
        return;
      }
      this.unclosed.delete(task.id);
      this.open.delete(task.id);
      this.log.forgetPullRequest(task.id);
      open = undefined;
    }

    if (task.phase !== "checks" || waitingOnYou(task) !== "merge_approval") return;
    const branch = task.worktree.branch;
    const head = task.branch.head;
    if (open?.head === head) return;
    const failed = this.failed.get(task.id);
    if (failed?.branch === branch && failed.head === head && !retry) return;

    const shown = await this.plugin.show({
      branch,
      head,
      base: this.base,
      title: `#${task.id} ${task.title}`,
      body: body(task, this.gates),
    });
    if (this.stopped) return;
    if (!shown.ok) {
      this.failed.set(task.id, { branch, head, message: shown.message });
      return;
    }
    this.failed.delete(task.id);
    const saved: OpenPullRequest = { task: task.id, branch, head, ...shown.value };
    this.open.set(task.id, saved);
    this.log.savePullRequest(saved);
  }
}

// Whether the task still works on the branch: it is in In progress or
// Checks, on that branch. A merged, dropped or respecced task doesn't.
function worksOn(task: Task, branch: string): boolean {
  return (
    (task.phase === "in_progress" || task.phase === "checks") && task.worktree.branch === branch
  );
}

const gateNames: Record<GateName, string> = {
  local: "the local checks",
  remote: "the remote checks",
  review: "the review",
};

// What the pull request says: what the task is for, that its checks
// passed, and how it is approved.
function body(task: Extract<Task, { phase: "checks" }>, gates: GateName[]): string {
  const approve = `skelcrew approve ${task.id}`;
  const passed = gates.map((gate) => gateNames[gate]).join(", ");
  return [
    `Skelcrew opened this draft for you to read. It is merged with \`${approve}\` on your machine, not here on GitHub.`,
    "",
    "## Scope",
    "",
    task.spec.scope,
    "",
    "## Acceptance criteria",
    "",
    ...task.spec.acceptance.map((line) => `- ${line}`),
    "",
    "## Checks",
    "",
    `These passed on commit ${task.branch.head.slice(0, 7)}: ${passed}.`,
    "",
    "## Approving",
    "",
    `Merge it with \`${approve}\`. Send it back with \`${approve} --send-back "<what to change>"\`.`,
    "",
    "The diff here is against main on GitHub. If you haven't pushed main lately, it also shows commits that are only on your machine.",
  ].join("\n");
}

function closingComment(task: Task): string {
  switch (task.phase) {
    case "done":
      return `Merged into main as ${task.mergeCommit.slice(0, 7)} with \`skelcrew approve ${task.id}\`. Skelcrew merges on your machine, so main on GitHub has it once you push main.`;
    case "dropped":
      return `#${task.id} was dropped, so this pull request is closed. Nothing was merged.`;
    default:
      return `#${task.id} went back to ${phaseNames[task.phase]}. Its next build gets a new branch and a new pull request.`;
  }
}
