// Merge when ready: a merge you arm once, from your own terminal, so Skelcrew merges a thread's
// PR by itself as soon as it is approved and green. Arming it, cancelling it, and the merge
// itself. Without an armed plan nothing merges by itself.
import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";
import { forgeOf, mergePr, postReview } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { mergeStuck, mergeWaitsOn, type PullRequest } from "./decide.ts";
import { endThread, removing } from "./events.ts";
import { noteForLead } from "./messages.ts";
import { findRepository, repositoryAt } from "./repo.ts";
import { lastPushed } from "./round.ts";
import { readThread, record, repositoryOf, Thread, threadName, threadOn } from "./thread.ts";

// Returns the thread a merge when ready names: by its task, such as app-12, or by its PR's
// number in the repository `repo` names, or else the one of the checkout sc ran in, `from`.
// Throws when there is none, or its thread is done, as a done thread has nothing to merge.
export function threadToMerge(
  db: Database,
  which: {
    repo?: string | undefined;
    from?: string | undefined;
    task?: string | undefined;
    pr?: number | undefined;
  },
): Thread {
  const repository =
    which.repo !== undefined
      ? findRepository(db, which.repo)
      : which.from !== undefined
        ? repositoryAt(db, which.from)
        : undefined;
  if (!repository)
    throw new Error(
      "name the thread, such as app-12, or run sc merge in a checkout of its repository",
    );
  const { owner, repo, name } = repository;
  // A PR's number names the thread that opened it, the newest one should a task have had two.
  let thread: Thread | null = null;
  if (which.pr !== undefined) {
    const row = db
      .query(
        "SELECT * FROM task_threads WHERE owner = ? AND repo = ? AND pr = ? ORDER BY rowid DESC",
      )
      .get(owner, repo, which.pr);
    thread = Thread.nullable().parse(row);
    if (!thread) throw new Error(`Skelcrew has no thread with PR #${which.pr} in ${name}`);
  } else if (which.task !== undefined) {
    thread = threadOn(db, name, which.task);
    if (!thread) throw new Error(`there is no thread ${name}-${which.task}`);
  }
  if (!thread) throw new Error("name the thread, such as app-12, or its PR, such as #7");
  if (thread.status === "done") throw new Error(`${threadName(db, thread)} is done already`);
  return thread;
}

// Arms a merge when ready on the thread, for sc merge --when-ready, which only you can run, at
// your terminal, and returns what to say. `seen` is what you said y to: the PR's number and
// when its thread started. Anything else is refused, such as a thread removed and started
// over while you read the question, with a PR you never saw. It saves who armed it and when, for the PR's comment
// once it merges. Refuses a repository with no forge, as Skelcrew merges no branch there: you
// merge it yourself once it is approved.
export function armMerge(
  db: Database,
  thread: Thread,
  seen: { pr: number; started: number | null } | undefined,
): string {
  const name = threadName(db, thread);
  refuseWithoutForge(db, thread);
  // You agree to a PR you can see, by its number, so a PR opened later never merges under it.
  if (thread.pr === null)
    throw new Error(`${name} has no PR yet: arm a merge when ready once it opens one`);
  if (!seen || seen.pr !== thread.pr || seen.started !== thread.started)
    throw new Error(
      `${name} changed since you said y, so nothing is armed: run sc merge --when-ready ${name} again`,
    );
  if (thread.merge_plan === "armed") return `${name} already merges when it is ready.`;
  const plan = {
    merge_plan: "armed" as const,
    merge_id: crypto.randomUUID(),
    merge_by: userInfo().username,
    merge_at: Date.now(),
    merge_waits: null,
    merge_noted: null,
  };
  record(db, thread.folder, plan, "you armed a merge when ready");
  return `${name} merges once it is approved and green. sc merge --cancel ${name} stops that.`;
}

// Refuses a merge when ready in a repository with no forge, as Skelcrew merges no branch
// there, and says what you can do instead. Checked before you are asked anything, as no PR
// will ever open there.
export function refuseWithoutForge(db: Database, thread: Thread): void {
  if (forgeOf(db, repositoryOf(db, thread)) === null)
    throw new Error(
      `${threadName(db, thread)}'s repository has no forge, so Skelcrew can't merge it when ready. Once it is approved, merge its branch ${thread.branch} yourself.`,
    );
}

// Drops the thread's merge when ready, and returns what to say. Cancelling is always safe, so
// the lead may do it too, and nothing asks first.
export function cancelMerge(db: Database, thread: Thread): string {
  const name = threadName(db, thread);
  if (thread.merge_plan === null) return `${name} had no merge when ready.`;
  // Once the forge was asked to merge, nothing can take that back, so saying it won't merge
  // would be untrue.
  if (merging.has(thread.folder))
    throw new Error(`${name} is merging on its forge right now, so it can't be cancelled`);
  const none = { merge_plan: null, merge_waits: null, merge_noted: null };
  record(db, thread.folder, none, "its merge when ready was cancelled");
  return `${name} won't merge by itself. It waits for you to merge it.`;
}

// The threads whose PR the forge is merging now, by folder. A cancel meanwhile is refused, as
// it could no longer stop the merge.
const merging = new Set<string>();

// The approved commits whose PR already has the review saying who asked to merge it when ready,
// as folder and commit.
const recorded = new Set<string>();

// Merges an armed thread's PR once it is ready, from a poll, with the PR as its forge just
// returned it and the thread as it was when the poll began, `before`. It merges at the approved commit, so a push after the approval is never merged,
// at a poll after the one that posted a review on the PR saying who asked for it. Whether the PR merges cleanly is the
// forge's to say as it merges: a refusal keeps the plan armed, with the forge's reason as what
// it waits on. Once merged, it ends the thread, and the lead's one note says it merged when
// ready. Otherwise it saves what the merge waits on, for the thread's row, and tells the lead
// once per review round when that needs someone to act.
export async function mergeIfReady(
  db: Database,
  sessions: string,
  before: Thread,
  pr: PullRequest,
): Promise<void> {
  const { folder } = before;
  const thread = readThread(db, folder);
  if (thread.merge_plan !== "armed" || thread.status === "done" || removing.has(folder)) return;
  // `pr` is what the forge said while this poll ran. A round that moved on meanwhile, such as
  // a review that started or ended, makes it stale: the checks of the new round may not be in
  // it yet. The next poll acts on the PR as it is after the round.
  const moved =
    thread.started !== before.started ||
    thread.submitting !== before.submitting ||
    thread.reviewing !== before.reviewing ||
    thread.rounds !== before.rounds ||
    thread.review_round !== before.review_round ||
    thread.review_at !== before.review_at ||
    thread.verdict !== before.verdict;
  if (moved) return;
  const name = threadName(db, thread);
  const approved = lastPushed(thread);
  let waits = mergeWaitsOn(thread, pr, approved);
  if (waits === null && approved !== null && thread.pr !== null) {
    const asked = new Date(thread.merge_at ?? Date.now()).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const repository = repositoryOf(db, thread);
    // The PR records who asked, with a review on the approved commit, the call every forge
    // answers. It goes before the merge, as a merged PR may take no review, and once for each
    // commit of each plan while the daemon runs, so a merge the forge keeps refusing doesn't
    // post it again at every poll. A plan armed again, or a thread started over, has a new ID,
    // so it gets a record of its own.
    const key = `${thread.merge_id} ${approved}`;
    // A forge that fails, such as when it is down, leaves the plan armed, says why it waits,
    // and is tried again at the next poll. It never holds up the poll's other threads.
    const failed = (error: unknown) => `the forge, which failed: ${errorText(error)}`;
    // The record goes first, in a poll of its own. The merge waits for a later poll, so it
    // acts on the PR and thread as the forge and Skelcrew have them after the record: a check
    // that failed or started, a cancel, a stop, sc rm or a new review while the record was
    // posted all show there, and stop the merge.
    if (!recorded.has(key)) {
      const body = `Merging when ready, as asked by ${thread.merge_by ?? "you"} on ${asked}.`;
      try {
        await postReview(db, repository, {
          pr: thread.pr,
          commit: approved,
          verdict: "approve",
          body,
        });
        recorded.add(key);
        return;
      } catch (error) {
        waits = failed(error);
      }
    }
    // The thread and PR were read at this poll's start, with nothing waited on since, and the
    // thread is marked as merging before the forge is asked, so a cancel either came first and
    // this never merges, or comes after and is refused.
    let refused: string | null = null;
    if (waits === null) {
      merging.add(folder);
      try {
        refused = await mergePr(db, repository, { pr: thread.pr, commit: approved });
      } catch (error) {
        waits = failed(error);
      } finally {
        merging.delete(folder);
      }
    }
    if (waits === null && refused === null) {
      await endThread(
        db,
        sessions,
        thread,
        `PR #${thread.pr} was merged when ready`,
        `is done: #${thread.pr} merged into ${pr.base} when ready, as the human asked`,
      );
      return;
    }
    if (refused !== null) waits = `the forge, which refused: ${refused}`;
  }
  // The forge's answer took a while, and meanwhile the plan may have been cancelled, the thread
  // removed, or started over in the same folder. What it waits on is saved only for the same
  // plan, on the thread as it is now.
  const now = readThread(db, folder);
  const samePlan =
    now.merge_plan === "armed" &&
    now.merge_id === thread.merge_id &&
    now.started === thread.started &&
    now.status !== "done" &&
    !removing.has(folder);
  if (!samePlan) return;
  // What it waits on changes only now and then, so the log isn't filled with every poll.
  if (waits !== now.merge_waits)
    record(db, folder, { merge_waits: waits }, `its merge when ready waits on ${waits}`);
  if (mergeStuck(now, waits)) {
    record(db, folder, { merge_noted: now.review_round });
    noteForLead(db, sessions, now, `${name} still waits to merge when ready, on ${waits}.`);
  }
}
