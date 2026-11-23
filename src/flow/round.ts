// A round of the build ⇄ review loop: the builder's sc submit, pushed from Skelcrew's clone,
// its PR opened on the first round, reviewed by a fresh reviewer, and the review typed back
// into the builder's session when it asks for changes.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type HarnessName, harnessNamed } from "../agents/harness.ts";
import { hasAgentLogin, loginInstruction } from "../agents/login.ts";
import { repositoryCommands, reviewConfig, reviewLimit, roundLimit } from "../config.ts";
import type { Repository } from "../db.ts";
import { flowRoles, strictRounds } from "../flows.ts";
import { errorText } from "../format.ts";
import { cloneDir, reviewSocket } from "../paths.ts";
import {
  askWhatChanged,
  editPr,
  editReview,
  failedLog,
  forgeOf,
  openPr,
  postReview,
  setStatus,
} from "../plugins/ask.ts";
import { repositoryRole } from "../roles.ts";
import { capture } from "../run.ts";
import { baseOf } from "./builder.ts";
import { openPrs, prOf, saveItems, threadTask } from "./copy.ts";
import {
  branchMoved,
  ciResult,
  ciState,
  forgetMoves,
  headSeen,
  onlyDocs,
  type PullRequest,
  refusedWorkflow,
  reviewComment,
  whoRunsTheSuite,
} from "./decide.ts";
import { fetchInto, noMaintenance, pushCommit } from "./git.ts";
import {
  approvalFound,
  checkSet,
  lastReviewed,
  letGoOn,
  nextRound,
  notReviewed,
  reviewAsked,
  reviewOnPr,
  reviewStarted,
  roundFailed,
  roundOf,
  submitted,
  submittedBefore,
  summariesSubmitted,
  verdictPosted,
  verdictReached,
} from "./ledger.ts";
import { endLimit, limitOn, reachLimit, tellOfLimit, waitUntil } from "./limits.ts";
import { dropOldEvents, noteForLead, queueMessage, typeLeadNotes } from "./messages.ts";
import { Queue } from "./queue.ts";
import { type LastRound, type Limited, type Review, review } from "./reviewer.ts";
import { needsYou as neededYou } from "./status.ts";
import { supervisor } from "./supervisor.ts";
import { cloneOf, readThread, record, repositoryOf, Thread, threadName } from "./thread.ts";

// Runs git in Skelcrew's own clone and returns what it printed, throwing with its error when it
// fails. Never with maintenance in the background, which a fetch could otherwise start.
async function git(folder: string, ...args: string[]): Promise<string> {
  const { out, err, ok } = await capture(["git", ...noMaintenance, "-C", folder, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (!ok) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

// Fetches the thread's branch from its clone into Skelcrew's clone and pushes the commit it got
// to the thread's branch on the repository's remote, then, with a forge, opens the PR if there
// is none yet, or else replaces its description, with the line that closes its task at the end
// of its body. Returns the commit.
// git never runs inside the thread's clone: the builder controls everything there, .git
// included, and a planted setting would run with your rights. A push refused for changing a
// workflow file, or because the branch moved on the forge without the builder, throws saying
// so, and types that into the builder, unless a newer round cancels it first.
async function push(
  db: Database,
  sessions: string,
  folder: string,
  summary: string,
  signal: AbortSignal,
): Promise<string> {
  const thread = readThread(db, folder);
  const repository = repositoryOf(db, thread);
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  // A ref of the thread's own, not FETCH_HEAD, which refreshing Skelcrew's clone also writes.
  const ref = `refs/skelcrew/threads/${thread.folder}`;
  await git(
    skelcrewClone,
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    cloneOf(thread),
    `+refs/heads/${thread.branch}:${ref}`,
  );
  // Push the exact commit fetched, by its hash, so a builder that commits again meanwhile
  // can't change what this round reviews. Without a forge the push is the whole round's
  // delivery, and there is no PR to open.
  const sha = await git(skelcrewClone, "rev-parse", "--verify", `${ref}^{commit}`);
  try {
    await pushCommit(db, repository, skelcrewClone, sha, thread.branch);
  } catch (error) {
    // A push refused for changing a workflow file, or for a branch that moved on the forge,
    // such as by a PR merged into it, fails the round with words a person can act on. The
    // builder hears them too, so it can fix it and submit again. It waits as every message to
    // the builder does, as it has likely not ended its turn yet, and a newer submit drops it
    // as stale.
    const said = errorText(error);
    const name = threadName(db, thread);
    let refused = refusedWorkflow(name, said);
    let why = "its push was refused for changing a workflow file";
    // git refuses a push that would drop commits the branch has on the forge, as it is never
    // forced. The branch is fetched into Skelcrew's clone, the builder's origin, to merge. A
    // poll that told the builder of the same commit already said it all. One this tells is
    // saved as seen, so a poll doesn't tell it again. A thread with a PR that never took in its
    // history has seen nothing, and saving one ID would make the rest look new. One with no PR
    // has no history to hold back.
    let told = false;
    if (refused === null && /\[rejected\].*\((non-fast-forward|fetch first)\)/.test(said)) {
      await fetchInto(db, repository, skelcrewClone, thread.branch);
      const at = await git(skelcrewClone, "rev-parse", `refs/heads/${thread.branch}`);
      refused = `${name}'s push was refused. ${branchMoved(thread.branch, at)}`;
      why = "its push was refused, as its branch moved on the remote";
      const now = readThread(db, folder);
      const seen = now.seen ?? (now.pr === null ? [] : null);
      told = seen?.includes(headSeen(at)) ?? false;
      if (seen !== null && !told && !signal.aborted)
        record(db, folder, { seen: [...seen, headSeen(at)] });
    }
    if (refused === null) throw error;
    if (!signal.aborted && !told)
      queueMessage(db, sessions, folder, {
        sender: "skelcrew",
        text: refused,
        said: why,
        typed_in: [],
      });
    throw new Error(refused);
  }
  // The PR's base branch, current, in a ref of the thread's own, for the review to see which
  // files the change touches. Skelcrew's clone holds only the default branch otherwise. The
  // review fetches it again when its turn comes. A base the forge won't give fails no push: the
  // review then can't tell the change is docs only, and the tests run.
  const bases = `refs/skelcrew/bases/${thread.folder}`;
  await fetchInto(db, repository, skelcrewClone, prBase(db, thread), bases).catch(() => {});
  if (forgeOf(db, repository) === null) {
    record(db, folder, {}, `pushed ${sha} to ${thread.branch}`);
    return sha;
  }
  // The forge answers with the PR already open from the branch, such as one opened before the
  // daemon stopped and could save it. After an earlier submit, it may hold that one's summary.
  const { title, closes } = threadTask(db, thread);
  const body = prBody(summary, closes);
  const known = thread.pr;
  const pr =
    known ??
    (await openPr(db, repository, { branch: thread.branch, base: baseOf(thread), title, body }));
  if (forgeOf(db, repository) === null) return sha;
  record(db, folder, { pr }, `pushed ${sha} to ${thread.branch}, for #${pr}`);
  if (known !== null || submittedBefore(thread))
    await describePr(db, sessions, folder, pr, { summary, closes }, signal);
  return sha;
}

const prBody = (summary: string, closes: string | null) =>
  closes ? `${summary}\n\n${closes}` : summary;

// Replaces the PR's description with the round's summary and the line that closes its task, so
// the reviewer, who reads it as the review starts, and sc show see this round's. Only a
// description that is empty or still holds a summary Skelcrew wrote is replaced, read from the
// forge, or from Skelcrew's copy when the forge doesn't show the PR. One a person edited is kept, and the
// builder and lead hear so, the lead with the new summary. One Skelcrew can't read is kept too.
// A forge that can't edit keeps the one before, and the builder hears so, as its round goes on.
async function describePr(
  db: Database,
  sessions: string,
  folder: string,
  pr: number,
  { summary, closes }: { summary: string; closes: string | null },
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const thread = readThread(db, folder);
  const repository = repositoryOf(db, thread);
  const tell = (text: string, said: string) => {
    record(db, folder, {}, text);
    queueMessage(db, sessions, folder, { sender: "skelcrew", text, said, typed_in: [] });
  };
  const shown = await refreshPr(db, repository, pr).then(
    (found) => found ?? prOf(db, thread.owner, thread.repo, pr),
    errorText,
  );
  if (signal.aborted) return;
  if (typeof shown === "string")
    return tell(
      `Skelcrew couldn't read PR #${pr}'s description, so it kept it and left your new summary out: ${shown}`,
      `it couldn't read PR #${pr}'s description`,
    );
  const plain = (text: string) => text.replaceAll("\r\n", "\n").trim();
  const written = summariesSubmitted(thread).map((said) => plain(prBody(said, closes)));
  const kept = shown === null ? "" : plain(shown.body);
  if (kept !== "" && !written.includes(kept)) {
    record(db, folder, {}, `kept PR #${pr}'s description, which someone edited on the forge`);
    queueMessage(db, sessions, folder, {
      sender: "skelcrew",
      text: `Someone edited PR #${pr}'s description on the forge, so Skelcrew kept it and left your new summary out. The lead has your summary. The reviewer reads trade-offs only from the description, so ask the lead about any your summary states.`,
      said: `someone edited PR #${pr}'s description`,
      typed_in: [],
    });
    noteForLead(
      db,
      sessions,
      repository,
      `${threadName(db, thread)}: someone edited PR #${pr}'s description on the forge, so Skelcrew kept it instead of the builder's new summary. That summary:\n\n${summary}`,
    );
    return;
  }
  const body = prBody(summary, closes);
  const edited = await editPr(db, repository, { pr, body }).catch(errorText);
  // A newer submit's push waits for this one, so its own edit comes next and says what holds.
  if (signal.aborted) return;
  if (edited === true) {
    const copied = prOf(db, thread.owner, thread.repo, pr);
    if (copied) saveItems(db, thread.owner, thread.repo, [{ ...copied, body }], []);
    record(db, folder, {}, `replaced PR #${pr}'s description`);
    return;
  }
  const why = edited === false ? "the forge can't edit it" : edited;
  tell(
    `Skelcrew couldn't replace PR #${pr}'s description with your new summary, so it still shows the one before: ${why}`,
    `it couldn't replace PR #${pr}'s description`,
  );
}

// How long a review waits for a first check when nothing says CI runs: no workflows and no CI
// on any PR. CI outside GitHub, such as Buildkite, still shows a check, and the next poll, 30
// seconds on, brings it. Tests of the daemon set SKELCREW_CHECK_WAIT_MS, mostly to 0, as most
// of them start a fresh daemon on a repository without CI and would each pay the wait.
const checkWait = z.coerce
  .number()
  .min(0)
  .catch(40_000)
  .parse(process.env.SKELCREW_CHECK_WAIT_MS ?? 40_000);

// How long a review waits for CI's first check on its commit, when CI shows on another PR or
// the commit has workflows. A forge shows a check within seconds of a push, and Skelcrew's copy
// has it by the next poll, 30 seconds later. Tests of a review that waits it out set
// SKELCREW_CI_WAIT_MS, so they don't pay two minutes each.
const ciWait = z.coerce
  .number()
  .min(0)
  .catch(2 * 60_000)
  .parse(process.env.SKELCREW_CI_WAIT_MS ?? 2 * 60_000);

// The repositories, as owner/repo, where a review waited the whole time for a first check and
// no PR showed one: they have no CI that runs on PRs, such as a workflow that runs only on a
// release, or no CI at all. Their reviews wait no more, so that costs a repository at most once
// while the daemon runs. CI that is just slow to show its first check ends up here too, and its
// reviewers then run the suite as well, until a check shows on one of the repository's PRs.
const waitedInVain = new Set<string>();

// Takes the repository, as owner/repo, out of those whose reviews wait no more for a first
// check, as a poll found a CI check on one of its PRs. Its reviews and merges then make the
// full wait again, even once that PR closed, so a PR with workflows isn't taken for one no CI
// runs on before its first check could start.
export function ciShowedIn(repository: string): void {
  waitedInVain.delete(repository);
}

// When the wait for CI's first check began on each commit, by owner/repo and commit. A review
// that waits for CI starts it, so its approval finds it ended. A docs-only review waits for no
// CI, so the first poll after its approval starts it instead. Kept in memory, so a restart
// during the wait starts it again and no PR waits forever.
const ciWaitSince = new Map<string, number>();

// Returns whether the commit has GitHub workflows, read from Skelcrew's clone, which fetched it,
// never from the builder's, which the builder controls. A commit Skelcrew can't read has none.
function setsUpCi(skelcrewClone: string, sha: string): boolean {
  const ls = ["git", "-C", skelcrewClone, "ls-tree", sha, "--", ".github/workflows"];
  const listed = Bun.spawnSync(ls, { stdout: "pipe", stderr: "ignore" });
  return listed.success && listed.stdout.toString().trim() !== "";
}

// Returns whether the wait for CI's first check on the head of `pr`, the thread's PR, has ended:
// a CI check showed, or none came in time, so no CI runs on this commit, such as a docs-only one
// CI skips with a paths filter. It is the wait a review makes before it joins the queue, by the
// same rules and limits. Polls ask it so an approved PR with no CI check still gets ready and
// merges when ready, rather than waiting on CI that never comes.
export function ciWaitEnded(db: Database, thread: Thread, pr: PullRequest): boolean {
  if (pr.head === null) return false;
  const key = `${thread.owner}/${thread.repo} ${pr.head}`;
  const since = ciWaitSince.get(key) ?? Date.now();
  ciWaitSince.set(key, since);
  const who = whoRunsTheSuite({
    own: pr,
    commit: pr.head,
    prs: openPrs(db, thread.owner, thread.repo),
    setsUpCi: setsUpCi(cloneDir(thread.owner, thread.repo), pr.head),
    waitedInVain: waitedInVain.has(`${thread.owner}/${thread.repo}`),
    waited: Date.now() - since,
    checkWait,
    ciWait,
  });
  if (who !== "wait") ciWaitSince.delete(key);
  return who !== "wait";
}

// Returns what tells the reviewer CI's result for the commit, from Skelcrew's copy of the
// thread's PR, which each poll brings up to date. The end of each failed check's log comes from
// the forge, once per check, so a review that reads the result again doesn't ask again. A log
// the forge won't give is left out, and asked for again next time.
function ciOfCommit(db: Database, thread: Thread, pr: number, sha: string): () => Promise<string> {
  const repository = repositoryOf(db, thread);
  const logs = new Map<string, string>();
  return async () => {
    const shown = prOf(db, thread.owner, thread.repo, pr);
    const failed = shown?.head === sha ? shown.checks.filter((c) => c.state === "failed") : [];
    for (const { id } of failed)
      if (id !== null && !logs.has(id))
        await failedLog(db, repository, id).then(
          (log) => logs.set(id, log),
          () => {},
        );
    return ciResult(shown, sha, logs);
  };
}

// What a round asks of one run of its review, before the task, the clone, the base and the test
// commands are read.
type Asked = Omit<Parameters<typeof review>[0], "clone" | "issue" | "base" | "test">;

// The reviews of every thread, kept to limits.reviews at once. A review of a commit CI doesn't
// run on runs the repository's whole test suite, so too many at once slow every one of them
// down.
const reviews = new Queue();

// Reviews the commit and acts on the verdict: with a forge, posts it on the PR and sets Skelcrew's
// check; saves what it means for the thread, and types changes into the builder. Without a
// forge the review stays in Skelcrew, and an approved branch needs you at once. Stops without a
// word once a newer round cancels it, since that round now owns the thread. The review waits its
// turn among all reviews, in order of `since`, when it joined: now, unless it is one the
// daemon's stop cut short, which keeps its place. Changes are typed in only once `builderBack`
// settles, as a review the daemon brings back can end before the builder's session is there.
// A commit that only merges the base branch into the last approved one keeps that approval
// once every CI check on it passed, and no reviewer runs. A task whose flow has no review stage
// runs no reviewer either: it waits for CI's first check as a review would, then is marked not
// reviewed.
async function reviewRound(
  db: Database,
  sessions: string,
  folder: string,
  sha: string,
  signal: AbortSignal,
  later: { since?: number; builderBack?: Promise<unknown> } = {},
): Promise<void> {
  const { since = Date.now(), builderBack } = later;
  // Read what the round needs: the thread's PR, whether there is a forge to post on, and the
  // reviewer, its time limit and the limit on reviews at once your config names.
  if (signal.aborted) return;
  const thread = readThread(db, folder);
  const repository = repositoryOf(db, thread);
  const { pr } = thread;
  const hasForge = forgeOf(db, repository) !== null;
  if (hasForge && pr === null) throw new Error("the thread has no pull request to review");
  const unreviewed = flowRoles(thread).review === null;
  const { reviewer: reviewerRole, fallback, reviewMinutes } = reviewConfig(thread);
  const reviewer = reviewerRole.harness;
  const limit = reviewLimit();
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const bases = `refs/skelcrew/bases/${thread.folder}`;
  // The check waits its turn behind the thread's earlier writes to the forge, such as a verdict
  // still being posted. A round cancelled meanwhile writes none, as no review of it would then
  // ever end the pending it sets.
  const setCheck = (state: "pending" | "success" | "failure", description: string) =>
    inTurn(folder, async () => {
      if (signal.aborted) return;
      if (hasForge) await setStatus(db, repository, { commit: sha, state, description });
    });
  // A flow with no review stage saves its pushed commit at once, before any check is set, so a
  // check that fails from here on is told as one, never as a failed push.
  // The review started, as the round's record says, saved again as it waits for CI or a place.
  const reviewUnderWay = () => reviewStarted(readThread(db, folder), sha, Date.now());
  if (unreviewed) record(db, folder, { ...reviewUnderWay(), queued: null });
  // Show the review under way on the PR while it joins the queue of reviews. It joins before
  // any await, so reviews take their places in the order they are asked for: after a restart
  // the daemon asks for them in their saved order. A failed check fails the round at once,
  // rather than once its turn comes.
  const pending = setCheck(
    "pending",
    unreviewed ? "waiting for CI's first check" : "Skelcrew's reviewer is reviewing",
  );
  const checkFailed = new AbortController();
  pending.catch(() => checkFailed.abort());
  // CI runs the suite only once a CI check shows on this commit. A forge shows one within
  // seconds of a push, and Skelcrew's copy has it by the next poll. So while one may still come,
  // the review waits a little for it, before it joins the queue, so it never holds a place
  // while it waits, and `since` keeps its place in line. It waits longest when CI shows on
  // another PR, or when the commit has GitHub workflows, the only CI of a forge Skelcrew has a
  // plugin for. It still waits about a poll without them, as CI outside GitHub has none. The
  // commit is read from Skelcrew's clone, which fetched it, never from the builder's, which the
  // builder controls. It is read at once, so the review still joins before any await when it
  // doesn't wait, and a commit Skelcrew can't read sets nothing up.
  const workflows = setsUpCi(skelcrewClone, sha);
  // A change to docs and Markdown alone is tested by no one, as CI skips it and no code
  // changed, so its review waits for no CI. The files are those changed since the base branch,
  // which the push fetched into the thread's own ref in Skelcrew's clone. The review asks
  // again once it fetched the base anew, as the PR may have moved to another base meanwhile.
  const docsOnly = changesOnlyDocs(skelcrewClone, bases, sha);
  const repositoryName = `${thread.owner}/${thread.repo}`;
  const suite = (waited: number) => {
    const prs = openPrs(db, thread.owner, thread.repo);
    const own = pr === null ? null : prOf(db, thread.owner, thread.repo, pr);
    const inVain = waitedInVain.has(repositoryName);
    const given = {
      own,
      commit: sha,
      prs,
      setsUpCi: workflows,
      waitedInVain: inVain,
      waited,
      checkWait,
      ciWait,
    };
    return whoRunsTheSuite(given);
  };
  // A flow with no review stage waits on docs too: no reviewer will look at them, and its check
  // goes green next, so the wait is all that keeps CI from being skipped.
  if (pr !== null && (!docsOnly || unreviewed) && suite(0) === "wait") {
    // Saved as reviewing, as the review is under way for you, and so a restart brings it back.
    // Its place in the queue only matters once it joins, with `since`.
    const waiting = { ...reviewUnderWay(), reviewer, queued: null };
    const before = unreviewed ? "marking it not reviewed" : "reviewing";
    record(db, folder, waiting, `waiting for CI's first check on ${sha} before ${before}`);
    const started = Date.now();
    ciWaitSince.set(`${repositoryName} ${sha}`, started);
    let who = suite(0);
    while (who === "wait") {
      await Bun.sleep(5_000);
      // A newer round ends the wait, and so does a pending check that failed, which fails
      // the round once it joins the queue.
      if (signal.aborted) return;
      if (checkFailed.signal.aborted) break;
      who = suite(Date.now() - started);
    }
    // A wait that ran out with CI on no PR was for a check that never came.
    const prs = openPrs(db, thread.owner, thread.repo);
    const noCi = { own: null, commit: sha, prs, setsUpCi: false, waitedInVain: true };

    if (
      who === "reviewer" &&
      whoRunsTheSuite({ ...noCi, waited: 0, checkWait, ciWait }) === "reviewer"
    )
      waitedInVain.add(repositoryName);
  }
  // A flow with no review stage needed only that wait: ready and a merge when ready wait for it
  // too, so CI can't be skipped by a check that hasn't shown yet.
  if (unreviewed) {
    await pending;
    await markNotReviewed(db, sessions, folder, sha, signal);
    return;
  }
  // A builder whose PR fell behind or conflicts with the base branch merges it and submits
  // again. When that is all the commit does, the PR's own change is the one already approved, so
  // the approval holds. It counts only while the latest review approved, so a review asking for
  // changes since is never skipped. A clean merge can still break things, so it is kept only
  // once every CI check that ran on this commit passed. Whether that CI tests the PR is the
  // repository's own setup, as it is for merging. A check that fails, or no CI on the commit
  // after the wait for its first check, gets a normal review, which runs the tests. The approved
  // commit and the base are refs in Skelcrew's clone, which the push brought up to date, and sc
  // review deletes the approved one, so it always runs the reviewer. A restart brings the round
  // back to wait again. Its check goes from pending to success, in that order.
  const latest = roundOf(thread);
  const approved = latest.verdict === "approve" ? lastApproved(thread) : null;
  const merged = approved !== null && onlyMergedBase(skelcrewClone, approved, sha, bases);
  if (approved !== null && merged && pr !== null && suite(Number.POSITIVE_INFINITY) === "ci") {
    const waiting = { ...reviewUnderWay(), reviewer, queued: null };
    record(
      db,
      folder,
      waiting,
      `only merged ${prBase(db, thread)}: waiting for CI to pass on ${sha}`,
    );
    const ci = await ciEnds(db, thread, pr, sha, AbortSignal.any([signal, checkFailed.signal]));
    if (signal.aborted) return;
    // The PR may have moved to another base while CI ran, against which the commit can do more
    // than merge it. So the approval is kept only if it still only merges the PR's base as the
    // forge has it now. A base that can't be fetched gets a review, which says why it failed.
    const base = prBase(db, thread);
    const still =
      ci === "passing" &&
      (await fetchInto(db, repository, skelcrewClone, base, bases).then(
        () => onlyMergedBase(skelcrewClone, approved, sha, bases),
        () => false,
      ));
    if (signal.aborted) return;
    if (still) {
      const body = `Approval kept: this commit only merges ${base} into ${approved}, which Skelcrew's reviewer approved, and changes nothing else in the PR. Every CI check on it passed.`;
      const notBlocking = lastReviewed(thread)?.notBlocking ?? [];
      const verdict: Review = { verdict: "approve", body, findings: [], notBlocking };
      const kept = { verdict, by: latest.reviewed_by ?? reviewer, kept: approved };
      await pending;
      await actOnVerdict(db, sessions, folder, sha, signal, kept, builderBack);
      return;
    }
    if (ci === "failing") record(db, folder, {}, `CI failed on ${sha}, so it is reviewed`);
    else if (ci === "passing")
      record(db, folder, {}, `${sha} does more than merge ${base}, so it is reviewed`);
  }
  // A review that has to wait is saved as queued, with when it joined, so the thread says so,
  // and a restart puts it back in the same place. One that starts at once is saved as
  // reviewing, with no queued step in between.
  const waits = reviews.full(limit);
  const joined = { ...reviewUnderWay(), reviewer, queued: waits ? since : null };
  record(db, folder, joined, waits ? `queued ${sha} for review` : `reviewing ${sha}`);
  const queue = { limit, order: since, signal: AbortSignal.any([signal, checkFailed.signal]) };
  // Each run of the review takes a place in the queue: the first, one after a usage limit, and
  // one after a timeout. A later run keeps the review's place, and says it is queued only when
  // it waits.
  let queued = waits;
  // The task, the clone, the base branch and the test commands are read only once the review's
  // turn comes and its check is pending, as reading them can fail, and a round still waiting on
  // its check must not fail early. What the run says of its harness's usage limit is saved before its place in the
  // queue is given back, as giving it back starts the next review at once, which must see it.
  // A run that met the limit holds every review on that harness until it resets. A review the
  // queue didn't start, as the limit was already in force, changes nothing. Any other run that
  // started after the limit was met means the harness works again, and the leads that heard
  // of its limit hear that too. One that started before, running alongside the review that met
  // it, says nothing of the limit.
  const run = (given: Asked) => {
    if (!queued && reviews.full(limit)) {
      queued = true;
      record(db, folder, { queued: since }, `queued ${sha} for review`);
    }
    return (
      reviews
        .run(queue, async () => {
          await pending;
          if (queued) record(db, folder, { queued: null }, `reviewing ${sha}`);
          queued = false;
          // The diff starts where the commit meets the PR's base as the forge has it now,
          // fetched into Skelcrew's clone. Never the builder's origin/, which moves only when
          // the builder fetches: a builder that merged a newer main would show main's commits
          // as its own. That commit is in the commit's history, so the reviewer's copy of the
          // clone has it. A review with no current base to read fails and says why, rather
          // than judging a diff that may hold someone else's commits. From round 2 on, the
          // last round asks the forge for the PR first, so the base comes from that answer too.
          const last = await lastRound(db, thread, skelcrewClone, sha);
          const base = prBase(db, thread);
          const fetched = await fetchInto(db, repository, skelcrewClone, base, bases).then(
            () => null,
            (error) => errorText(error),
          );
          const from = fetched === null ? whereItMeets(skelcrewClone, bases, sha) : null;
          if (from === null)
            return {
              verdict: "failed" as const,
              body: `Skelcrew couldn't read where ${sha.slice(0, 7)} meets ${base} as the forge has it, so it can't tell the PR's change apart: ${fetched ?? "they share no commit"}`,
            };
          // A PR moved to another base while the review waited can now change code, so a
          // change that was docs alone is asked again, against the base just fetched. One that
          // now changes code runs the tests, as there is then no CI result to read.
          const docsOnly = given.docsOnly === true && changesOnlyDocs(skelcrewClone, bases, sha);
          const started = Date.now();
          const result = await review({
            ...given,
            docsOnly,
            last,
            clone: cloneOf(thread),
            issue: threadTask(db, thread),
            bounds: async () => {
              const fresh = readThread(db, folder);
              const shown =
                fresh.pr === null
                  ? null
                  : await refreshPr(db, repository, fresh.pr).then(
                      (pr) => pr?.body ?? null,
                      () => null,
                    );
              return { decisions: fresh.decisions, stayTrue: fresh.stay_true, description: shown };
            },
            base: from,
            test: repositoryCommands(thread).test,
            socket: reviewSocket(thread.folder),
          });
          const { harness } = given;
          if (result.verdict === "limited") {
            if (limitOn(harness, Date.now()) === null)
              reachLimit(db, harness, result.reset, Date.now());
          } else if (!signal.aborted) endLimit(db, sessions, harness, started);
          return result;
        })
        // Leaving the queue early says why: the check's own error, or else that it was
        // cancelled, which a newer round did, so the round ends as cancelled rounds do.
        .catch(async (error) => {
          await pending;
          throw error;
        })
    );
  };
  const plan = {
    given: {
      // The review stage's role, from the task's flow, and its instructions come from the
      // .agents/ the task started with.
      instructions: repositoryRole(flowRoles(thread).review ?? "reviewer", thread).instructions,
      strict: nextRound(thread) <= strictRounds(thread),
      skills: thread,
      commit: sha,
      signal,
      limit: reviewMinutes * 60_000,
      // With CI on this commit, CI runs the whole test suite and the reviewer reads its result.
      // Without, the reviewer runs the suite itself, and on a change to docs alone no one
      // does. Asked again as each run starts, as CI may show a check while it waits its turn.
      docsOnly,
      ci:
        pr === null || docsOnly
          ? undefined
          : {
              has: () => suite(Number.POSITIVE_INFINITY) === "ci",
              read: ciOfCommit(db, thread, pr, sha),
            },
    },
    role: reviewerRole,
    fallback,
    run,
  };
  let { verdict, by } = await reviewWithinLimits(db, sessions, folder, plan);
  // A review that hung was ended. It runs once more, logged, and the lead hears of it at once,
  // so a hung review never sits unseen. A second that hangs gives a timed out review.
  if (verdict.verdict === "timed out" && !signal.aborted) {
    const why = `${threadName(db, thread)}'s review timed out after ${reviewMinutes}m; retrying`;
    record(db, folder, {}, why);
    noteForLead(db, sessions, repositoryOf(db, thread), why);
    ({ verdict, by } = await reviewWithinLimits(db, sessions, folder, plan));
    if (verdict.verdict === "timed out")
      verdict = { verdict: "timed out", body: `its review timed out twice (${reviewMinutes}m)` };
  }
  await actOnVerdict(db, sessions, folder, sha, signal, { verdict, by, kept: null }, builderBack);
}

// Acts on a review's verdict: saves what it means for the thread, then, with a forge, puts it in
// Skelcrew's one review on the PR and sets Skelcrew's check, and types changes into the builder
// once `builderBack` settles.
// Without a forge an approved branch needs you at once. An approval is saved as a ref in
// Skelcrew's clone, so a later submit that only merges the base branch can keep it. `kept` is
// the approved commit whose approval this one keeps, with no reviewer run, which the check and
// the thread's log say. A round a newer one or sc stop cancels before the verdict is saved stops
// without a word. Once saved, the verdict still goes on the PR and the check, in its turn among
// the thread's writes to the forge, so the PR never shows a verdict Skelcrew didn't save, nor
// Skelcrew one the PR doesn't show.
async function actOnVerdict(
  db: Database,
  sessions: string,
  folder: string,
  sha: string,
  signal: AbortSignal,
  reviewed: { verdict: Review; by: HarnessName; kept: string | null },
  builderBack?: Promise<unknown>,
): Promise<void> {
  const { verdict, by, kept } = reviewed;
  const thread = readThread(db, folder);
  const repository = repositoryOf(db, thread);
  const hasForge = forgeOf(db, repository) !== null;
  const maxRounds = roundLimit(thread);
  // Decide what the verdict means for the thread. A kept approval says so on the check and in
  // the log, in place of the reviewer's.
  const ready = hasForge ? null : `${threadName(db, thread)} is ready on branch ${thread.branch}`;
  const base = prBase(db, thread);
  const reached = {
    review: verdict,
    by,
    sha,
    maxRounds,
    ready,
    forge: hasForge,
    kept: kept === null ? null : { base, approved: kept },
    now: Date.now(),
  };
  const { change, round, tell, why, note, holds, choices } = verdictReached(thread, reached);
  // A newer submit, or sc stop, may have cancelled the round, and the thread is then its to
  // change. Nothing is awaited from this check until the verdict is saved, so a cancel either
  // comes first and nothing is saved or posted, or comes after and finds the verdict saved.
  if (signal.aborted) return;
  // The whole review goes in the thread's log first, as the PR keeps only the latest one.
  if (verdict.verdict === "approve" || verdict.verdict === "changes")
    record(
      db,
      folder,
      {},
      `the review said (${verdict.verdict}): ${reviewComment(verdict, round, sha)}`,
    );
  // Save the outcome, with what is still to go on the forge, and tell the lead if its review
  // failed. A failed or timed out review is Skelcrew's problem, not the PR's, so it is never
  // posted, though its check is set. The round limit's note waits for the review to be on the
  // PR, so a thread that starts needing you for it saves no note yet.
  const failed = verdict.verdict === "failed" || verdict.verdict === "timed out";
  const quiet = !neededYou(thread) && holds ? { noting: null } : {};
  // Without a forge the verdict is posted at once, with nothing to put on a PR, and its note is
  // saved with it.
  const name = threadName(db, thread);
  db.transaction(() => {
    record(db, folder, { ...change, ...quiet }, why);
    noteLimit(db, sessions, folder, note);
    if (choices !== null) noteForLead(db, sessions, repository, `${name}${choices}`);
  })();
  // A review that failed doesn't need you: the lead hears of it, with the error the harness
  // gave, and can run it again, or mark the thread if only you can fix what stops it.
  if (failed) {
    const said =
      verdict.verdict === "failed" ? `'s review failed: ${verdict.body}` : `: ${verdict.body}`;
    const line = `${name}${said}`.replace(/\s+/g, " ").slice(0, 200);
    noteForLead(db, sessions, repository, `${line}. sc review ${name} runs it again.`, null, true);
  }
  // The approved commit is kept for the next submit to compare with. It is written at once,
  // with no await since the save, so sc review, which deletes it as it asks for a review, never
  // runs before the write and has it put back after. Losing it costs only a review, so a ref
  // git won't write fails nothing.
  if (verdict.verdict === "approve")
    Bun.spawnSync(
      [
        "git",
        "-C",
        cloneDir(thread.owner, thread.repo),
        "update-ref",
        `refs/skelcrew/approved/${thread.folder}`,
        sha,
      ],
      { stderr: "ignore" },
    );
  // The verdict takes its turn among the thread's writes to the forge as it is saved, with no
  // await between. Otherwise sc stop, sc start and sc review could queue a newer review's pending
  // check first, and this verdict's check would land on top of it. A forge that fails to take it
  // is the lead's to hear, once, while each poll tries again. The verdict stands, so any changes
  // still reach the builder.
  const posted = postVerdict(db, sessions, folder).then((failed) => {
    if (failed === null) return;
    const why = `couldn't put its review on the forge: ${failed}`;
    record(db, folder, {}, `${why}; each poll tries again`);
    const line = `${threadName(db, thread)} ${why}`.replace(/\s+/g, " ").slice(0, 200);
    noteForLead(db, sessions, repository, `${line}. Skelcrew tries again at each poll.`);
    typeLeadNotes(db, sessions);
  });
  typeLeadNotes(db, sessions);
  // The changes are saved, so a builder that never comes back, which ends the round, keeps them
  // for when you start it again. A round cancelled meanwhile leaves them to the newer round,
  // which drops them, or to sc start, which types them in.
  if (tell) {
    await builderBack;
    if (!signal.aborted) await queueChanges(db, sessions, folder, tell, signal);
  }
  await posted;
}

// Ends a round whose task's flow has no review stage, once CI's first check had its chance to
// show. Skelcrew's check goes green, saying it wasn't reviewed, as ready and branch protection
// both read it. Nothing is posted on the PR: a forge's review carries a verdict, such as
// GitHub's "Approved.", which would contradict it, and the check already says it. The thread
// then waits on CI like an approved one, and without a forge it is ready at once. Stops without
// a word once a newer round cancels it.
async function markNotReviewed(
  db: Database,
  sessions: string,
  folder: string,
  sha: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const thread = readThread(db, folder);
  const repository = repositoryOf(db, thread);
  const hasForge = forgeOf(db, repository) !== null;
  if (hasForge)
    await inTurn(folder, () =>
      setStatus(db, repository, {
        commit: sha,
        state: "success",
        description: "not reviewed: this flow has no review stage",
      }),
    );
  if (signal.aborted) return;
  // Without a forge there is no CI to wait on, so the branch is ready for you at once, as an
  // approved one is.
  const ready = hasForge ? null : `${threadName(db, thread)} is ready on branch ${thread.branch}`;
  const change = {
    queued: null,
    status: "waiting",
    ...notReviewed(readThread(db, folder), sha, ready, Date.now()),
  } satisfies Partial<Thread>;
  const why = "not reviewed, as its flow has no review stage";
  record(db, folder, change, ready === null ? `${why}, so it waits on CI` : `${why}; ${ready}`);
  typeLeadNotes(db, sessions);
}

// Each thread's writes of its review to the forge, its checks and its review on the PR, by
// folder, as the last one asked for. A round cancelled after saving its verdict still puts it on
// the forge, and sc stop forgets the round, so a later round's writes wait here behind it, and
// an older verdict never lands on the PR after a newer one.
const forgeWrites = new Map<string, Promise<unknown>>();
// How many of each thread's writes to the forge are waiting or under way, by folder, so a poll
// can tell one is.
const writesUnderWay = new Map<string, number>();

// Runs `write` once every write to the forge the thread asked for before it has ended, failed
// or not, and returns what it gives.
function inTurn<T>(folder: string, write: () => Promise<T>): Promise<T> {
  writesUnderWay.set(folder, (writesUnderWay.get(folder) ?? 0) + 1);
  const mine = (forgeWrites.get(folder) ?? Promise.resolve())
    .catch(() => {})
    .then(write)
    .finally(() => {
      const left = (writesUnderWay.get(folder) ?? 1) - 1;
      if (left > 0) writesUnderWay.set(folder, left);
      else writesUnderWay.delete(folder);
    });
  forgeWrites.set(folder, mine);
  return mine;
}

// Puts the thread's saved verdict on the forge in its turn: its review on the PR, then Skelcrew's
// check on its commit. It is then no longer saved as posting, unless a newer verdict replaced it
// meanwhile, which goes on in its own turn. A newer one already saved when the turn comes goes
// on in its place, as the PR only shows the latest. Returns what the forge said when it failed,
// or null. It never throws: the verdict stays saved, and each poll tries again, so a forge that
// fails never stops the round, such as its changes reaching the builder.
function postVerdict(db: Database, sessions: string, folder: string): Promise<string | null> {
  return inTurn(folder, async () => {
    const thread = readThread(db, folder);
    let { posting } = roundOf(thread);
    if (posting === null) return null;
    const { review } = posting;
    try {
      // The review is saved as posted once the PR has it, with the lead's note in the same save,
      // so a check that keeps failing never holds back the note, nor a stop between the two.
      if (review !== null) {
        await postOrEdit(db, folder, review.pr, review.commit, review, posting.note !== null);
        const posted = verdictPosted(readThread(db, folder), posting, Date.now());
        if (posted === null) return null;
        db.transaction(() => {
          record(db, folder, posted.change);
          noteLimit(db, sessions, folder, posted.note);
        })();
        typeLeadNotes(db, sessions);
        posting = roundOf(readThread(db, folder)).posting;
        if (posting === null) return null;
      }
      const { commit, check, description } = posting;
      await setStatus(db, repositoryOf(db, thread), { commit, state: check, description });
    } catch (error) {
      return errorText(error);
    }
    const set = checkSet(readThread(db, folder), posting, Date.now());
    if (set !== null) record(db, folder, set);
    return null;
  });
}

// Saves the note telling the lead the round limit holds the thread's changes, as its review went
// on the PR, or with the verdict without a forge, so the note never names a review the PR doesn't
// show yet. The ledger gives the note only while the changes are still held, and it is saved only
// while the thread needs you. A thread with a note still to type for another reason keeps it, and the lead gets
// this one apart. The caller saves it with the change that brought it, and types the notes.
export function noteLimit(
  db: Database,
  sessions: string,
  folder: string,
  note: string | null,
): void {
  if (note === null) return;
  const thread = readThread(db, folder);
  if (!neededYou(thread)) return;
  if (thread.noting === null) record(db, folder, { noting: note }, "its review is posted");
  else {
    const line = `${threadName(db, thread)} needs you: ${note}`;
    noteForLead(db, sessions, repositoryOf(db, thread), line, null, true);
  }
}

// Tries again to put on the forge a verdict whose post failed, or that a stop of the daemon cut
// short, on a stopped thread too, so the PR doesn't keep an older review than the thread says.
// Each poll asks. A forge that still fails is logged and asked again at the next. A done
// thread's PR is closed, so it is left alone. A submit or review under way brings a newer verdict, which is posted in its place,
// so it is left to that round. So is a write to the forge still under way, such as the round's
// own post: waiting behind it would hold up the whole poll, and a post that fails is tried
// again at the next. A round that only waits to type its changes in, such as for a builder
// still starting, doesn't hold it up.
export async function retryPost(db: Database, sessions: string, folder: string): Promise<void> {
  const thread = readThread(db, folder);
  const round = roundOf(thread);
  const quiet =
    thread.status !== "done" &&
    round.posting !== null &&
    round.submitting === null &&
    round.reviewing === null &&
    !writesUnderWay.has(folder);
  if (!quiet) return;
  const failed = await postVerdict(db, sessions, folder);
  if (failed !== null)
    console.log(`${folder}: couldn't put its saved verdict on the forge: ${failed}`);
  else record(db, folder, {}, "its saved verdict is on the forge now");
}

// Puts a review's verdict and findings on the PR as Skelcrew's one review there, so the PR shows
// the latest round rather than a review per round. It edits the review an earlier round posted.
// When the forge can't edit it, it posts a new one only if the verdict or any finding changed, so a
// round that found the same again adds nothing, unless `noted`: the lead is to hear of this
// round's review, so the PR must show it, not an older round's. One deleted from the PR is posted again. The rounds one by one stay in the thread's log.
// What it posted is saved on the thread at once, so a later round edits it though this one is
// cancelled. Two rounds of a thread never post at once: a round's review starts only once the
// round before has ended, posting included, so the later round always reads what the earlier
// one saved, and its verdict is the one left on the PR.
async function postOrEdit(
  db: Database,
  folder: string,
  pr: number,
  commit: string,
  review: {
    verdict: "approve" | "changes";
    body: string;
    findings: string[];
    notBlocking?: string[] | undefined;
    round: number;
  },
  noted: boolean,
): Promise<void> {
  const thread = readThread(db, folder);
  const repository = repositoryOf(db, thread);
  const { verdict, findings, round } = review;
  const notBlocking = review.notBlocking ?? [];
  // The body ends with a hidden marker naming the thread. The forge keeps HTML comments, and
  // gives them back unchanged, so Skelcrew can find its review in its copy of the PR.
  const marker = `<!-- skelcrew:review thread=${thread.folder} -->`;
  const body = `${reviewComment(review, review.round, commit)}\n\n${marker}`;
  // Only a review on this PR counts: a PR opened again after sc rm starts with none.
  const { review_post } = roundOf(thread);
  const earlier = review_post?.pr === pr ? review_post : null;
  // With no review saved, the forge may still have taken one with its ID never saved: its
  // answer was lost, or the daemon stopped first. Skelcrew's copy of the PR may not show it
  // yet, as a round can end before the next poll. So the forge is asked for the PR first, and
  // the review is found there by its marker. One that already says this is counted as posted,
  // so it is never posted twice, and any other is the one to edit. A forge that can't answer
  // fails the post, which is tried again later. With a review saved, the forge isn't asked.
  if (earlier === null) await refreshPr(db, repository, pr);
  const marked =
    earlier === null
      ? (prOf(db, thread.owner, thread.repo, pr)?.reviews ?? []).filter((posted) =>
          posted.text.includes(marker),
        )
      : [];
  const already = marked.find((posted) => posted.text.trim() === body.trim());
  if (already) {
    const post = { pr, id: already.id, verdict, findings, notBlocking, round };
    const saved = reviewOnPr(readThread(db, folder), post, Date.now());
    record(db, folder, saved, `found its review ${already.id} on PR #${pr}, posted already`);
    return;
  }
  const editing = earlier?.id ?? marked.at(-1)?.id ?? null;
  // A forge that fails to edit, such as a plugin that doesn't know the question yet, is treated
  // as one that can't, so the review still reaches the PR.
  const edit =
    editing === null
      ? "gone"
      : await editReview(db, repository, { pr, id: editing, verdict, body }).catch(
          () => "can't" as const,
        );
  const edited = edit === "edited";
  // A review deleted from the PR is posted again even when it would say the same, so the PR
  // always shows one. One found only by its marker may say anything, so it isn't the same.
  const same =
    earlier !== null &&
    earlier.verdict === verdict &&
    JSON.stringify(earlier.findings) === JSON.stringify(findings) &&
    JSON.stringify(earlier.notBlocking ?? []) === JSON.stringify(notBlocking);
  if (edit === "can't" && same && !noted) return;
  const id =
    edited && editing !== null
      ? editing
      : await postReview(db, repository, { pr, commit, verdict, body });
  if (forgeOf(db, repository) === null) return;
  const how = edited ? `edited its review ${id}` : `posted its review ${id}`;
  const post = { pr, id, verdict, findings, notBlocking, round };
  record(db, folder, reviewOnPr(readThread(db, folder), post, Date.now()), `${how} on PR #${pr}`);
}

// Brings Skelcrew's copy of the PR up to date with its forge, as the copy can be a poll behind,
// and returns the PR as the forge just showed it, or null when it didn't. Throws when the forge
// can't answer.
async function refreshPr(
  db: Database,
  repository: Repository,
  pr: number,
): Promise<PullRequest | null> {
  const forge = forgeOf(db, repository);
  if (forge === null) return null;
  const { items } = await askWhatChanged(db, forge, repository, ["forge"], null, [pr]);
  if (forgeOf(db, repository) !== forge) return null;
  const shown = items.flatMap((item) =>
    item.kind === "pr" && item.id === String(pr) ? [item] : [],
  );
  saveItems(db, repository.owner, repository.repo, shown, []);
  return shown[0] ?? null;
}

// Runs the review on the reviewer's harness and returns its verdict and the harness it ran on,
// waiting out that harness's usage limit. While the limit holds, the review runs on the
// `fallback` harness, if you set one that isn't limited too, and its body says so. Otherwise it
// is held, without a word to the builder, until the limit resets, or, with no reset time, until
// the next try. All reviews held on a harness wait for that same moment. The thread shows the
// limit meanwhile, and its lead hears of it once. A cancelled round returns as soon as it is
// cancelled, with a failed review its caller drops.
async function reviewWithinLimits(
  db: Database,
  sessions: string,
  folder: string,
  plan: {
    given: Omit<Asked, "harness" | "model"> & { signal: AbortSignal };
    role: { harness: HarnessName; model?: string };
    fallback: HarnessName | null;
    run: (given: Asked) => Promise<Review | Limited>;
  },
): Promise<{ verdict: Review; by: HarnessName }> {
  const { given, role, fallback, run } = plan;
  const { signal } = given;
  while (true) {
    // A cancelled review held on a limit no longer is: the round that cancelled it shows its own.
    if (signal.aborted) {
      if (readThread(db, folder).review_limited)
        record(db, folder, notHeld, "the held review ended");
      return { verdict: { verdict: "failed", body: "the review was cancelled" }, by: role.harness };
    }
    // Pick the harness: the reviewer's own, or the fallback while the reviewer's is limited.
    const now = Date.now();
    const limit = limitOn(role.harness, now);
    const spare = fallback !== null && limitOn(fallback, now) === null ? fallback : null;
    // The lead hears of the reviewer's limit, and of the fallback's when that holds reviews too.
    const repository = repositoryOf(db, readThread(db, folder));
    if (limit !== null) tellOfLimit(db, sessions, role.harness, repository, spare);
    if (limit !== null && spare === null && fallback !== null)
      tellOfLimit(db, sessions, fallback, repository, null);
    // With no harness free, hold the review until a limit resets, and show that on the
    // thread. With the fallback limited too, it waits for whichever frees first.
    if (limit !== null && spare === null) {
      const other = fallback === null ? null : limitOn(fallback, now);
      const first = other !== null && other.until < limit.until ? other : limit;
      const held = { review_limited: true, review_reset: first.reset };
      const thread = readThread(db, folder);
      if (!thread.review_limited || thread.review_reset !== first.reset)
        record(db, folder, held, `${role.harness}'s usage limit holds the review`);
      await waitUntil(first.until, signal);
      continue;
    }
    // Run it, and show which harness has the thread now.
    const harness = limit === null ? role.harness : (fallback ?? role.harness);
    if (!hasAgentLogin(harness)) {
      const mark = loginInstruction(harness);
      record(db, folder, { needs_you_for: mark }, `its reviewer needs a login: ${mark}`);
      while (!hasAgentLogin(harness)) {
        if (signal.aborted)
          return { verdict: { verdict: "failed", body: "the review was cancelled" }, by: harness };
        await Bun.sleep(250);
      }
      if (readThread(db, folder).needs_you_for === mark)
        record(db, folder, { needs_you_for: null }, "its reviewer login is saved");
    }
    const running = { ...notHeld, reviewer: harness };
    const thread = readThread(db, folder);
    if (thread.review_limited || thread.reviewer !== harness)
      record(db, folder, running, `reviewing on ${harness}`);
    const model = harness === role.harness ? role.model : undefined;
    // The run saved what it said of the harness's limit, so a limited one only waits again.
    const result = await run({ ...given, harness, model });
    if (result.verdict === "limited") continue;
    if (signal.aborted) return { verdict: result, by: harness };
    if (harness === role.harness) return { verdict: result, by: harness };
    const { title } = harnessNamed(harness);
    const why = `${harnessNamed(role.harness).title} reached its usage limit`;
    const body = `This review ran on ${title}, as ${why}.\n\n${result.body}`;
    return { verdict: { ...result, body }, by: harness };
  }
}

// What a thread's review held on a usage limit becomes once it isn't.
const notHeld = { review_limited: false, review_reset: null };

// Saves a review's changes as a message for the builder, typed in as soon as it can take them,
// however long that takes, as every message to a builder is: never while it asks you a
// question, which they would answer. They stay saved on the thread too until then, so sc ps
// counts them and the sidebar says changes. A newer round drops them, as they are about an
// older commit. Nothing is saved once the round is cancelled.
async function queueChanges(
  db: Database,
  sessions: string,
  folder: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  queueMessage(db, sessions, folder, {
    sender: "review",
    text,
    said: "the review's changes",
    typed_in: [],
  });
}

// A thread's latest round, with what cancels its review. The next round pushes only after this
// round's push, so two pushes or two PRs never race. The next round's review waits for this
// round to end, so this round's last write to Skelcrew's check comes before the next round's
// pending one. `ended` is true once the round has finished or failed.
type Round = {
  cancel: AbortController;
  pushed: Promise<unknown>;
  done: Promise<unknown>;
  ended: boolean;
};
// Each thread's latest round, by its folder.
const latestRounds = new Map<string, Round>();

// Returns whether the thread's latest round is still pushing or reviewing, for sc ps. A round
// that failed has ended, while its submit or commit stays saved for sc review to try again, so
// the saved columns alone can't tell a running review from a failed one.
export function roundRunning(folder: string): boolean {
  const round = latestRounds.get(folder);
  return round !== undefined && !round.ended;
}

// Saves the round as the thread's latest. When `rest`, the rest of the round, fails, it marks
// the thread needs you with the reason, unless the round was cancelled, such as by a newer
// round. `pushed`
// settles once the round's push is done.
function trackRound(
  db: Database,
  sessions: string,
  folder: string,
  cancel: AbortController,
  pushed: Promise<unknown>,
  rest: Promise<void>,
): void {
  // A failure of a round no newer one replaced shows as a failed review, and the lead hears of
  // it, so it never sits waiting on a review that will never come.
  const done = rest.catch((error) => {
    if (cancel.signal.aborted) return;
    const why = errorText(error);
    // A review not yet typed in stays saved, so starting the daemon again can type it. A review
    // that waited in the queue left it with the failure, so it no longer counts as queued.
    const change = {
      status: "waiting",
      queued: null,
      ...notHeld,
      ...roundFailed(readThread(db, folder), Date.now()),
    } satisfies Partial<Thread>;
    const thread = record(db, folder, change, `the round failed: ${why}`);
    const name = threadName(db, thread);
    const line = `${name}'s round failed: ${why}`.replace(/\s+/g, " ").slice(0, 200);
    noteForLead(
      db,
      sessions,
      repositoryOf(db, thread),
      `${line}. sc review ${name} runs it again.`,
      null,
      true,
    );
    typeLeadNotes(db, sessions);
  });
  const round = { cancel, pushed, done, ended: false };
  done.then(() => {
    round.ended = true;
  });
  latestRounds.set(folder, round);
}

// Pushes the round, after the earlier round's push, then reviews it, once the earlier round
// has ended.
function pushAndReview(
  db: Database,
  sessions: string,
  folder: string,
  summary: string,
  earlier: Round | undefined,
): void {
  // The earlier round's failure is already handled by its own follow, so here it only sets
  // the order.
  const cancel = new AbortController();
  const before = earlier?.pushed.catch(() => {}) ?? Promise.resolve();
  const pushed = before.then(() => push(db, sessions, folder, summary, cancel.signal));
  const rest = Promise.all([pushed, earlier?.done]).then(([sha]) =>
    reviewRound(db, sessions, folder, sha, cancel.signal),
  );
  trackRound(db, sessions, folder, cancel, pushed, rest);
}

// Starts a round for sc submit, cancelling the thread's older round if one is still under
// way, and returns at once: a shell command can't block long, so pushing and the review go on
// in the background. The submit is saved first, so a stop of the daemon can't lose it. A
// review still waiting to be typed in, or held past the round limit, is dropped, as it is
// about an older commit, and so are Skelcrew's waiting messages of the PR's events. A moved branch
// commit whose notice is dropped is no longer told, so the builder hears of it again if its new
// round doesn't merge it. One whose notice the builder got stays told. Throws when your config or the repository's skelcrew.yaml isn't valid,
// so the builder hears why, and for a thread sc stop is ending, whose builder may submit while
// it exits.
export function submitRound(db: Database, sessions: string, folder: string, summary: string): void {
  const thread = readThread(db, folder);
  const { reviewer } = reviewConfig(thread);
  // A flow with no review stage saves its verdict as the submit starts, so the thread waits on
  // checks from then on, rather than showing a review no reviewer will run.
  const unreviewed = flowRoles(thread).review === null;
  if (thread.status === "stopped" || supervisor(folder).state().stopping)
    throw new Error("this thread was stopped, so Skelcrew won't push it");
  record(
    db,
    folder,
    {
      status: "waiting",
      ...submitted(thread, summary, Date.now(), unreviewed),
      // A turn that ends after this waits on the review, not on you. An earlier turn that
      // ended without a submit no longer does either: the builder can go on with nothing
      // typed in, such as when a command it left running finishes.
      submitted: true,
      turn_ended: false,
      // A review of the older commit that waited for a place no longer does.
      queued: null,
      ...notHeld,
      // What CI said, and the conflict found, were about the commit before this one.
      checks: null,
      conflicts: null,
      ci_passed: false,
      reviewer: reviewer.harness,
    },
    `submitted: ${summary}`,
  );
  // A moved branch's notice dropped here never reached the builder, so its commit is forgotten.
  // A notice being typed as the round started is dropped only once its typing ends, if it never
  // got in, so its commit is forgotten then.
  const forget = (dropped: string[]) => {
    const { seen } = readThread(db, folder);
    const kept = forgetMoves(seen, thread.branch, dropped);
    if (JSON.stringify(kept) !== JSON.stringify(seen)) record(db, folder, { seen: kept });
  };
  const { dropped, later } = dropOldEvents(db, sessions, folder);
  forget(dropped);
  later.then(forget);
  // The older round is cancelled, but its push still runs first, so the branch ends on this
  // round's commit.
  const before = latestRounds.get(folder);
  before?.cancel.abort();
  pushAndReview(db, sessions, folder, summary, before);
}

// Returns the commit Skelcrew last fetched from the thread's clone and pushed, or null when it
// has pushed none. Read at once, with no await, so two sc review can't both start one.
export function lastPushed(thread: Thread): string | null {
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const ref = `refs/skelcrew/threads/${thread.folder}^{commit}`;
  const run = Bun.spawnSync(["git", "-C", skelcrewClone, "rev-parse", "--verify", "--quiet", ref], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.success ? run.stdout.toString().trim() : null;
}

// Waits until every CI check on the commit has ended, as Skelcrew's copy of the thread's PR
// shows, and returns whether they all passed or one failed, or null once `signal` ends the
// wait. Each poll brings the copy up to date. Skelcrew's own check isn't CI, so it is left out.
// A check that failed ends the wait at once, as nothing the rest say can keep the approval.
async function ciEnds(
  db: Database,
  thread: Thread,
  pr: number,
  sha: string,
  signal: AbortSignal,
): Promise<"passing" | "failing" | null> {
  while (true) {
    if (signal.aborted) return null;
    const shown = prOf(db, thread.owner, thread.repo, pr);
    const state = shown?.head === sha ? ciState(shown) : null;
    if (state === "passing" || state === "failing") return state;
    await Bun.sleep(5_000);
  }
}

// Saves on each approved thread the commit its approval stands for, when the database doesn't
// have it, as for an approval from before reviews saved it there. Skelcrew's clone keeps that
// commit as a ref, so the list, which reads only the database, can still merge it. The daemon
// runs this as it starts. A thread whose ref is gone keeps none, and merges on the forge.
export function saveApprovedCommits(db: Database): void {
  const approved = db
    .query(`SELECT * FROM task_threads WHERE verdict = 'approve' AND reviewed_commit IS NULL
      AND status != 'done'`)
    .all()
    .map((row) => Thread.parse(row));
  for (const thread of approved) {
    const commit = lastApproved(thread);
    if (commit !== null) record(db, thread.folder, approvalFound(thread, commit));
  }
}

// Returns the commit Skelcrew's reviewer last approved for the thread, or null when none is
// saved, such as before its first approval.
function lastApproved(thread: Thread): string | null {
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const ref = `refs/skelcrew/approved/${thread.folder}^{commit}`;
  const run = Bun.spawnSync(["git", "-C", skelcrewClone, "rev-parse", "--verify", "--quiet", ref], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.success ? run.stdout.toString().trim() : null;
}

// Returns the branch the thread's PR goes into, as the forge last said, since someone can
// change it on the forge. Before the PR is open, or with no forge, the branch the thread
// started from.
function prBase(db: Database, thread: Thread): string {
  const pr = thread.pr === null ? null : prOf(db, thread.owner, thread.repo, thread.pr);
  return pr?.base ?? baseOf(thread);
}

// Returns what the reviewer gets of the last round the thread's reviewer finished: its findings,
// and the diff from the commit it reviewed to this one, read in Skelcrew's clone, which the
// builder can't change. On a new commit it asks the forge for the PR first, so the review's base
// comes from what the forge shows now, as a PR can be retargeted. A commit no longer in this one's
// history, such as after a force push, gives no diff. Null on the first round.
async function lastRound(
  db: Database,
  thread: Thread,
  clone: string,
  sha: string,
): Promise<LastRound | null> {
  const last = lastReviewed(thread);
  if (last === null) return null;
  if (last.commit === sha) return { ...last, since: "same commit" };
  const { pr } = thread;
  if (pr !== null) await refreshPr(db, repositoryOf(db, thread), pr).catch(() => null);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", clone, ...args], { stdout: "pipe", stderr: "pipe" });
  const kept = git("merge-base", "--is-ancestor", last.commit, sha).success;
  const diff = kept ? git("diff", last.commit, sha) : null;
  return {
    ...last,
    since: diff?.success ? { diff: diff.stdout.toString() } : "dropped",
  };
}

// Returns whether the commit, in the clone, changes only docs and Markdown since it met the
// base, so no one runs the tests. Without rename detection, a file moved from code into docs
// shows both names, so the code it removes counts. Names end in a NUL, as git otherwise quotes
// one with letters outside ASCII, such as résumé.md. A base or diff git can't read, as in a
// clone not set up yet, gives false, and the tests run.
export function changesOnlyDocs(clone: string, base: string, sha: string): boolean {
  const changed = Bun.spawnSync(
    ["git", "-C", clone, "diff", "--name-only", "-z", "--no-renames", `${base}...${sha}`],
    { stdout: "pipe", stderr: "ignore" },
  );
  return changed.success && onlyDocs(changed.stdout.toString().split("\0").filter(Boolean));
}

// Returns the commit where the commit meets the base, in the clone, which is where the PR's own
// change starts, as the forge shows it. Returns null when git can't read either, such as a
// base the clone never fetched.
export function whereItMeets(clone: string, base: string, sha: string): string | null {
  const run = Bun.spawnSync(["git", "-C", clone, "merge-base", base, sha], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.success ? run.stdout.toString().trim() : null;
}

// Returns whether the commit, in the clone, is exactly the approved commit with the base
// branch merged in: what git merges by itself, with no conflict and nothing else changed. A
// builder whose PR fell behind or conflicts with main merges it and submits again, and then the
// PR's own change is the one already approved. A conflict, even one resolved by keeping the PR's
// side, any change on top, or a merge that changes the PR's own diff needs a review. So does a
// rebase, which rewrites the approved commit. The base merged is where the commit meets the
// base branch, which may be older than the base's tip. A commit git can't read gives false.
export function onlyMergedBase(
  clone: string,
  approved: string,
  sha: string,
  base: string,
): boolean {
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", clone, ...args], { stdout: "pipe", stderr: "pipe" });
    return run.success ? run.stdout.toString().trim() : null;
  };
  // merge-tree fails on a conflict, and prints the merged tree first otherwise. Returns whether
  // the commit's tree is what git alone makes of merging the two.
  const automatic = (commit: string, one: string, two: string) => {
    const tree = git("merge-tree", "--write-tree", one, two);
    return tree !== null && tree.split("\n")[0] === git("rev-parse", `${commit}^{tree}`);
  };
  // The commit must build on the approved one, not rewrite it.
  if (git("merge-base", "--is-ancestor", approved, sha) === null) return false;
  // Every commit the builder made since the approval must be a merge git made alone. Checking
  // only the last tree would miss a conflict resolved in an earlier merge whose side main undid
  // since. The base's own commits are left out, as they are main's, not the PR's.
  const added = git("rev-list", "--parents", sha, `^${approved}`, `^${base}`);
  if (added === null) return false;
  for (const line of added.split("\n").filter(Boolean)) {
    const [commit = "", one = "", two = "", ...more] = line.split(" ");
    if (two === "" || more.length > 0 || !automatic(commit, one, two)) return false;
  }
  // And the whole is the approved commit merged with the base, so nothing else crept in.
  const merged = git("merge-base", sha, base);
  if (merged === null || !automatic(sha, approved, merged)) return false;
  // A clean merge can still change the PR's own diff, such as when main took one of its
  // changes as its own, which then leaves the PR. So the PR's change against where it meets the
  // base must read the same before and after. Line numbers and blob IDs are left out, as main's
  // changes elsewhere in a file shift them, and no context, which main's changes alter too.
  const change = (commit: string, from: string | null) => {
    if (from === null) return null;
    const diff = git("diff", "--no-color", "--no-ext-diff", "--no-renames", "-U0", from, commit);
    const kept = (line: string) => !line.startsWith("index ") && !line.startsWith("@@");
    return diff?.split("\n").filter(kept).join("\n") ?? null;
  };
  const before = change(approved, git("merge-base", approved, base));
  return before !== null && before === change(sha, merged);
}

// Reviews the thread's last submitted commit again, for sc review, such as after a review
// that failed, and returns at once, as sc submit does. The review runs like any round's,
// so changes count toward the round limit and a newer sc submit cancels it. A submit whose
// push failed is pushed first. Refuses a thread that is done or stopped, one with nothing
// submitted, and one whose review is still waiting or running, since that review answers
// already. `byBuilder` says the thread's own builder asked, which counts as a submit in its turn.
export function rerunReview(
  db: Database,
  sessions: string,
  folder: string,
  byBuilder: boolean,
): void {
  // Refuse what there is nothing to do for: a thread that ended, a review already under way,
  // or no commit yet. A submit that was saved but never pushed counts as a commit.
  const thread = readThread(db, folder);
  const name = threadName(db, thread);
  if (thread.status === "done") throw new Error(`${name} is done, so there is nothing to review`);
  if (thread.status === "stopped")
    throw new Error(`${name} is stopped: run sc start ${name} first`);
  const earlier = latestRounds.get(folder);
  const { submitting, reviewing } = roundOf(thread);
  if ((submitting !== null || reviewing !== null) && earlier && !earlier.ended)
    throw new Error(`a review of ${name}'s last commit is already waiting or running`);
  const sha = submitting === null ? lastPushed(thread) : null;
  if (submitting === null && sha === null)
    throw new Error(`${name} has no submitted commit to review yet`);
  // The commit is saved as under review at once, so a second sc review asked before the
  // check is pending again is refused rather than cancelling this one.
  // A builder that asked for it ends its turn waiting on the review, as after sc submit. Any
  // review ends a turn that ended without a submit, which the thread then shows as queued or
  // reviewing. A builder that stops after a review the lead or you asked for hasn't submitted
  // in its turn, so its last message goes to the lead.
  const change = {
    status: "waiting",
    turn_ended: false,
    ...(byBuilder ? { submitted: true } : {}),
    ...notHeld,
    ...reviewAsked(thread, sha, Date.now()),
    queued: null,
  } satisfies Partial<Thread>;
  record(db, folder, change, "asked to review again");
  // A review asked for runs the reviewer, so the approval a merge could keep goes. Deleting it
  // saves that across a restart too, which brings the review back as any other.
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const ref = `refs/skelcrew/approved/${thread.folder}`;
  Bun.spawnSync(["git", "-C", skelcrewClone, "update-ref", "-d", ref], { stderr: "ignore" });
  // A submit not yet pushed goes through the whole round. A commit already pushed only needs
  // its review, after the earlier round has ended.
  earlier?.cancel.abort();
  if (submitting !== null) pushAndReview(db, sessions, folder, submitting, earlier);
  else if (sha !== null) {
    const cancel = new AbortController();
    const rest = Promise.resolve(earlier?.done).then(() =>
      reviewRound(db, sessions, folder, sha, cancel.signal),
    );
    trackRound(db, sessions, folder, cancel, Promise.resolve(), rest);
  }
}

// Carries on with a round the daemon's stop cut short: a submit not yet pushed and reviewed, a
// review whose Skelcrew's check was left pending, or changes not yet typed into the builder. A
// verdict saved but not yet on the forge is left to the poll, which first brings Skelcrew's copy
// of the PR up to date, so a review the forge took before the stop is found there, not posted
// again. Pushing again is harmless: the remote has the commit, or gets it now. A
// builder brought back can submit before this runs, and then its newer round wins. A review
// joins the queue of reviews again rather than starting at once: one that waited keeps its
// place, and one that was running goes ahead of every review that waited. The daemon asks for
// the reviews before anything else can start one, in that order, as the first to join a queue
// with room starts at once. Such a review may end before its builder is back, so its changes
// wait for `builderBack`, which the daemon settles once the builder is back or has failed.
export function resumeRound(
  db: Database,
  sessions: string,
  folder: string,
  builderBack: Promise<unknown> = Promise.resolve(),
): void {
  // A thread with a round of its own already is past this. Otherwise carry on from the
  // furthest the round got: its push, its review, or typing its changes in.
  if (latestRounds.has(folder)) return;
  const saved = readThread(db, folder);
  const { queued } = saved;
  const { submitting, reviewing, telling } = roundOf(saved);
  const cancel = new AbortController();
  const none = Promise.resolve();
  if (submitting !== null) pushAndReview(db, sessions, folder, submitting, undefined);
  else if (reviewing !== null)
    trackRound(
      db,
      sessions,
      folder,
      cancel,
      none,
      reviewRound(db, sessions, folder, reviewing, cancel.signal, {
        since: queued ?? 0,
        builderBack,
      }),
    );
  else if (telling !== null)
    trackRound(
      db,
      sessions,
      folder,
      cancel,
      none,
      queueChanges(db, sessions, folder, telling, cancel.signal),
    );
}

// Lets a thread past the round limit go on, for sc start: types the changes of the review that
// reached the limit into the builder, as a round within the limit would have, and stops it
// needing you for them. Its rounds of changes stand at the limit, so it is no longer past it,
// but the next review that asks for changes reaches it again and needs a new decision.
export function goOn(db: Database, sessions: string, folder: string): void {
  const thread = readThread(db, folder);
  const { held } = roundOf(thread);
  const change = letGoOn(thread, roundLimit(thread), Date.now());
  record(
    db,
    folder,
    held === null ? change : { ...change, status: "working" },
    "you let it go on past the round limit",
  );
  // The held changes are saved as to be typed in first, so a stop of the daemon before
  // they reach the builder doesn't lose them.
  if (held === null) return;
  const cancel = new AbortController();
  trackRound(
    db,
    sessions,
    folder,
    cancel,
    Promise.resolve(),
    queueChanges(db, sessions, folder, held, cancel.signal),
  );
}

// Cancels the thread's round, once its PR is merged or closed or sc stop ends its builder,
// so a review still running never changes a thread that is done or stopped. Returns its push,
// which can't be cancelled, settled either way: sc rm waits for it, or the push could put back
// the branch it deletes, or open a PR after it closed none.
export function endRound(folder: string): Promise<unknown> {
  const round = latestRounds.get(folder);
  round?.cancel.abort();
  latestRounds.delete(folder);
  return round?.pushed.catch(() => {}) ?? Promise.resolve();
}
