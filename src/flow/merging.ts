// Merge when ready, and merge without Skelcrew's approval: a merge you arm once, from your own
// terminal or by asking a lead you let arm merges, so Skelcrew merges a thread's PR by itself. When
// ready, it merges once the PR is approved and green. Skipping the review, it merges the commit you
// saw once CI is green there, whatever the reviewer says. Arming it, cancelling it, and the merge
// itself. Without an armed plan nothing merges by itself.
import type { Database } from "bun:sqlite";
import { createTask, editReview, forgeOf, mergePr, postReview, trackerOf } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { openPrs, openTasks, prOf } from "./copy.ts";
import {
  ciState,
  mergeStuck,
  mergeWaitsOn,
  type PullRequest,
  skipReviewWaitsOn,
} from "./decide.ts";
import { endThread, removing } from "./events.ts";
import { noteForLead } from "./messages.ts";
import { findRepository, repositoryAt } from "./repo.ts";
import { lastPushed } from "./round.ts";
import { openFindings } from "./status.ts";
import { readThread, record, repositoryOf, Thread, threadName, threadOn } from "./thread.ts";

// Returns the thread sc merge names: by its task, such as app-12, or by its PR's
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

// Returns how a thread's armed merge is said, after "Merging #7", such as "as soon as it's
// approved and green", for what sc merge says and the lead's notes.
const mergeWhen = (thread: Pick<Thread, "merge_pinned">) =>
  thread.merge_pinned === null
    ? "as soon as it's approved and green"
    : "without Skelcrew's approval once its checks pass";

// Returns what sc merge says of a merge already armed on the thread, and how to stop it, so a
// second ask, or a "no" to it, never sounds like it stopped the merge.
export function alreadyMerging(db: Database, thread: Thread): string {
  const name = threadName(db, thread);
  return `Already merging #${thread.pr} ${mergeWhen(thread)}. sc merge --cancel ${name} stops it.`;
}

// Arms a merge on the thread and returns what to say: when ready, for sc merge --when-ready, or
// `skip` the review, for sc merge --skip-review and m in the list. At your terminal, `seen` is what
// you said y to: the PR's number and when its thread started, and when skipping the review the PR's
// head. Anything else is refused, such as a thread removed and started over while you read the
// question, with a PR you never saw, or a push you never saw. From a lead you let arm merges,
// `asked` is your words in the conversation, quoted by the lead: the thread's log keeps them and
// the daemon logs them, and when skipping the review the head is the one Skelcrew's copy has as it
// asks. A merge you asked for at your terminal is typed into the lead as a note, so it knows. One
// the lead asked for isn't, as the lead tells you itself and a note would say it twice. It saves
// who armed it and when, for the PR's record once it merges. Refuses a repository with no forge, as
// Skelcrew merges no branch there: you merge it yourself.
export function armMerge(
  db: Database,
  sessions: string,
  thread: Thread,
  how:
    | { seen: { pr: number; started: number | null; head?: string | undefined } | undefined }
    | { asked: string },
  skip: boolean,
): string {
  const name = threadName(db, thread);
  refuseWithoutForge(db, thread);
  // You agree to a PR you can see, by its number, so a PR opened later never merges under it.
  if (thread.pr === null) throw new Error(`${name} has no PR yet: ask again once it opens one`);
  // A plan already on the thread is reported first, even to a y given to an older PR: saying
  // it won't merge would be untrue while that plan stays.
  if (thread.merge_plan === "armed") return alreadyMerging(db, thread);
  // Skipping the review, the head is the commit Skelcrew's copy of the PR has now, which is the one
  // the question showed you, as anything newer would be a push you never saw.
  const head = skip ? prOf(db, thread.owner, thread.repo, thread.pr)?.head : undefined;
  const flag = skip ? "--skip-review" : "--when-ready";
  const { seen } = "seen" in how ? how : { seen: undefined };
  const changed =
    !seen || seen.pr !== thread.pr || seen.started !== thread.started || seen.head !== head;
  if ("seen" in how && changed)
    throw new Error(
      `${name} changed since you said y, so it won't merge by itself: run sc merge ${flag} ${name} again`,
    );
  if (skip && !head)
    throw new Error(`Skelcrew hasn't seen #${thread.pr}'s newest commit yet: ask again shortly`);
  // Only a review that asks for changes, or still runs, can be skipped. An approved PR merges
  // as usual, and one never reviewed waits for its review.
  if (skip && thread.verdict !== "changes" && thread.reviewing === null)
    throw new Error(
      thread.verdict === "approve"
        ? `${name} is approved already: merge it with m in the list, or sc merge --when-ready ${name}`
        : `${name} has no review asking for changes or under way, so there is nothing to skip: wait for its review`,
    );
  const asked = "asked" in how ? how.asked : null;
  const plan = {
    merge_plan: "armed" as const,
    merge_id: crypto.randomUUID(),
    merge_by: asked === null ? loginName() : `${loginName()} via the lead`,
    merge_at: Date.now(),
    merge_asked: asked,
    merge_waits: null,
    merge_noted: null,
    merge_pinned: head ?? null,
  };
  const when = mergeWhen(plan);
  // The log keeps your words exactly, line breaks and spaces included. Written as JSON, they
  // still fit on one line of the daemon's log.
  const what = head
    ? `merge #${thread.pr} without Skelcrew's approval at commit ${head.slice(0, 7)}`
    : `merge #${thread.pr} once it's approved and green`;
  const why =
    asked === null
      ? `you asked to ${what}`
      : `the lead asked to ${what}, as the human asked: ${JSON.stringify(asked)}`;
  record(db, thread.folder, plan, why);
  console.log(`${name}: ${why}`);
  // The lead can't see your terminal, so it hears of a merge you asked for there. One it asked
  // for itself it already told you about.
  if (asked === null)
    noteForLead(
      db,
      sessions,
      thread,
      `Merging #${thread.pr} (${name}) ${when}, as you asked at your terminal. sc merge --cancel ${name} stops it.`,
    );
  return `Merging #${thread.pr} ${when}. sc merge --cancel ${name} stops it.`;
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

// Returns your login name on this machine, for the record on the PR of who asked. Bun's
// userInfo reads it from USER, which the daemon may run without, as a service does, and then
// says "unknown", so the system is asked.
function loginName(): string {
  const id = Bun.spawnSync(["id", "-un"], { stdout: "pipe", stderr: "ignore" });
  return (id.success && id.stdout.toString().trim()) || "you";
}

// Drops the thread's armed merge, when ready or without approval, and returns what to say.
// Cancelling is always safe, so the lead may do it too, and nothing asks first.
export function cancelMerge(db: Database, thread: Thread): string {
  const name = threadName(db, thread);
  if (thread.merge_plan === null) return `${name} had no merge armed.`;
  // Once the forge was asked to merge, nothing can take that back, so saying it won't merge
  // would be untrue.
  if (merging.has(thread.folder))
    throw new Error(`${name} is merging on its forge right now, so it can't be cancelled`);
  const none = { merge_plan: null, merge_waits: null, merge_noted: null, merge_pinned: null };
  record(db, thread.folder, none, "its armed merge was cancelled");
  return `${name} won't merge by itself. It waits for you to merge it.`;
}

// The threads whose PR the forge is merging now, by folder. A cancel meanwhile is refused, as
// it could no longer stop the merge.
const merging = new Set<string>();

// Merges an armed thread's PR once it is ready, from a poll, with the PR as its forge just
// returned it and the thread as it was when the poll began, `before`. When ready, it merges at
// the approved commit, so a push after the approval is never merged. Skipping the review, it merges
// at the commit you saw, and a push after you asked cancels the plan and tells the lead. Either
// merges at a poll after the one that posted a review on the PR saying who asked for it.
// Whether the PR merges cleanly is the forge's to say as it merges: a refusal keeps the plan
// armed, with the forge's reason as what it waits on. Once merged without approval, what the
// review still asked for is filed as one issue. Then it ends the thread, and the lead's one note
// says how it merged. Otherwise it saves what the merge waits on, for the thread's row, and
// tells the lead once per review round when that needs someone to act.
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
  const pinned = thread.merge_pinned;
  // You asked to merge the commit you saw without approval. A newer one is a change nobody you
  // trust has looked at, so the plan ends, rather than waiting, and the lead hears it.
  if (pinned !== null && pr.state === "open" && pr.head !== null && pr.head !== pinned) {
    const none = { merge_plan: null, merge_waits: null, merge_noted: null, merge_pinned: null };
    record(db, folder, none, `a push to #${thread.pr} cancelled its merge without approval`);
    noteForLead(
      db,
      sessions,
      thread,
      `#${thread.pr} (${name}) got a new commit after the human asked to merge it without Skelcrew's approval, so it won't merge. Ask them again if they still want it.`,
    );
    return;
  }
  const commit = pinned ?? lastPushed(thread);
  let waits =
    pinned === null
      ? mergeWaitsOn(thread, pr, commit)
      : skipReviewWaitsOn(thread, pr, repositoryHasCi(db, thread));
  if (waits === null && commit !== null && thread.pr !== null) {
    const repository = repositoryOf(db, thread);
    // The PR records who asked, with a review on the commit it merges, the call every forge
    // answers. It goes before the merge, as a merged PR may take no review, and once for each
    // commit of each plan, saved on the thread, so neither a merge the forge keeps refusing nor
    // a restart posts it again. A plan armed again, or a thread started over, has a new ID, so
    // it gets a record of its own. Skipping the review it keeps the reviewer's verdict, as
    // Skelcrew's reviewer never approved that commit.
    const key = `${thread.merge_id} ${commit}`;
    // A record the forge took just before the daemon stopped, with nothing saved yet, is found
    // by its marker in the PR's reviews.
    const marker = recordMarker(thread, commit);
    // A forge that fails, such as when it is down, leaves the plan armed, says why it waits,
    // and is tried again at the next poll. It never holds up the poll's other threads.
    const failed = (error: unknown) => `the forge, which failed: ${errorText(error)}`;
    // The record goes first, in a poll of its own. The merge waits for a later poll, so it
    // acts on the PR and thread as the forge and Skelcrew have them after the record: a check
    // that failed or started, a cancel, a stop, sc rm or a new review while the record was
    // posted all show there, and stop the merge.
    if (thread.merge_record !== key) {
      const found = pr.reviews.find((review) => review.text.includes(marker));
      if (found) {
        record(db, folder, { merge_record: key, merge_record_id: found.id });
        return;
      }
      // It says "Merging", as the merge may still never happen: a check can fail, or the plan
      // be cancelled. Once merged without approval, it is edited to say so.
      try {
        const id = await postReview(db, repository, {
          pr: thread.pr,
          commit,
          verdict: pinned === null ? "approve" : "changes",
          body: recordBody(thread, commit, "Merging"),
        });
        record(db, folder, { merge_record: key, merge_record_id: id });
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
        refused = await mergePr(db, repository, { pr: thread.pr, commit });
      } catch (error) {
        waits = failed(error);
      } finally {
        merging.delete(folder);
      }
    }
    if (waits === null && refused === null) {
      const note =
        (await finishSkippedMerge(db, readThread(db, folder), pr)) ??
        `is done: #${thread.pr} merged into ${pr.base} when ready, as the human asked`;
      await endThread(
        db,
        sessions,
        thread,
        `PR #${thread.pr} was merged ${pinned === null ? "when ready" : "without approval"}`,
        note,
        true,
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
    record(db, folder, { merge_waits: waits }, `its armed merge waits on ${waits}`);
  if (mergeStuck(now, waits)) {
    record(db, folder, { merge_noted: now.review_round });
    const when = pinned === null ? "once it's approved and green" : "without Skelcrew's approval";
    noteForLead(
      db,
      sessions,
      now,
      `Still merging #${now.pr} (${name}) ${when}, waiting on ${waits}.`,
    );
  }
}

// Returns whether a poll ever found CI in the thread's repository: on any of its tasks' PRs, as
// each task keeps, or on any open PR in Skelcrew's copy. A merge without approval needs CI's
// checks, so in such a repository a PR with none yet waits for them.
function repositoryHasCi(db: Database, thread: Thread): boolean {
  const seen = db
    .query("SELECT 1 FROM tasks WHERE owner = ? AND repo = ? AND ci_seen = 1 LIMIT 1")
    .get(thread.owner, thread.repo);
  return seen !== null || openPrs(db, thread.owner, thread.repo).some((pr) => ciState(pr) !== null);
}

// Returns the hidden marker in a merge's record on the PR, naming its plan and commit, so the
// record is found again after a restart. Its kind tells the two merges apart.
function recordMarker(thread: Thread, commit: string): string {
  const kind = thread.merge_pinned === null ? "merge-when-ready" : "merge-skip-review";
  return `<!-- skelcrew:${kind} plan=${thread.merge_id} commit=${commit} -->`;
}

// Returns the body of a merge's record on the PR, saying who asked and on which day, then its
// marker. `verb` is "Merging" before the forge merged, and "Merged" once a merge without
// approval did, as the record is then edited to say so.
function recordBody(thread: Thread, commit: string, verb: "Merging" | "Merged"): string {
  const day = new Date(thread.merge_at ?? Date.now()).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const how = thread.merge_pinned === null ? "when ready" : "without Skelcrew's approval";
  return `${verb} ${how}, as asked by ${thread.merge_by ?? "you"} on ${day}.\n\n${recordMarker(thread, commit)}`;
}

// Finishes a merge without approval once its PR merged at the pinned commit, and returns the
// lead's note, or null when the thread had no such plan. It edits the PR's record to say it
// merged, and files what the review still asked for. Both the merge itself and a poll that
// finds the PR merged call it, so a daemon that stopped between the forge's merge and these
// steps still does them. The thread is read as it is now, so a review that ended during the
// merge counts.
export async function finishSkippedMerge(
  db: Database,
  thread: Thread,
  pr: PullRequest,
): Promise<string | null> {
  const pinned = thread.merge_pinned;
  if (thread.merge_plan !== "armed" || pinned === null || thread.pr === null) return null;
  if (pr.head !== null && pr.head !== pinned) return null;
  // A forge that can't edit the record leaves "Merging", which the merge made true.
  if (thread.merge_record === `${thread.merge_id} ${pinned}` && thread.merge_record_id !== null)
    await editReview(db, repositoryOf(db, thread), {
      pr: thread.pr,
      id: thread.merge_record_id,
      verdict: "changes",
      body: recordBody(thread, pinned, "Merged"),
    }).catch((error) =>
      console.log(`${thread.folder}: couldn't edit its merge record: ${errorText(error)}`),
    );
  const filed = await fileFollowUps(db, thread);
  return `is done: #${thread.pr} merged into ${pr.base} without Skelcrew's approval, as the human asked.${filed}`;
}

// Files what Skelcrew's latest review still asked for, once its PR merged without its approval, as
// one issue that links back to the PR, so the findings aren't lost with the thread. Returns what
// the lead's note adds about it, such as " Its open findings are in #13.", or nothing with no
// findings. It files once: the issue's ID is saved on the thread, and given again after that, and
// an issue filed but not yet saved is found again by its marker. An issue that can't be filed, such
// as with no tracker or a tracker that fails, is said in the note instead, so you can file it.
async function fileFollowUps(db: Database, thread: Thread): Promise<string> {
  if (thread.merge_followup !== null) return ` Its open findings are in #${thread.merge_followup}.`;
  const findings = openFindings(thread);
  if (findings.length === 0) return "";
  const repository = repositoryOf(db, thread);
  const listed = findings.map((finding, n) => `${n + 1}. ${finding.trim()}`).join("\n");
  // A hidden marker names the plan. An issue the tracker made just before the daemon stopped,
  // with its ID not saved yet, is found by it in Skelcrew's copy, which the poll brought up to
  // date first, so a restart never files a second one.
  const marker = `<!-- skelcrew:follow-ups plan=${thread.merge_id} -->`;
  const body = `Skelcrew's reviewer still asked for these when #${thread.pr} merged without its approval, as asked by ${thread.merge_by ?? "you"}:\n\n${listed}\n\nFrom #${thread.pr}.\n\n${marker}`;
  try {
    if (trackerOf(db, repository) === null) throw new Error("its repository has no tracker");
    const issue =
      openTasks(db, thread.owner, thread.repo).find((task) => task.body.includes(marker)) ??
      (await createTask(db, repository, `Follow-ups from #${thread.pr}'s review`, body));
    record(
      db,
      thread.folder,
      { merge_followup: issue.id },
      `filed the open findings of #${thread.pr}'s review as #${issue.id}`,
    );
    return ` Its open findings are in #${issue.id}.`;
  } catch (error) {
    console.log(`${thread.folder}: couldn't file its open findings: ${errorText(error)}`);
    return ` Its open findings couldn't be filed as an issue: ${errorText(error)}`;
  }
}
