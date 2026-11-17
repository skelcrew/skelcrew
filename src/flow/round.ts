// A round of the build ⇄ review loop: the builder's sc submit, pushed from Skelcrew's clone,
// its PR opened on the first round, reviewed by a fresh reviewer, and the review typed back
// into the builder's session when it asks for changes.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type HarnessName, harnessNamed } from "../agents/harness.ts";
import { deliver } from "../agents/transport.ts";
import { reviewLimit, threadConfig } from "../config.ts";
import { cloneDir } from "../paths.ts";
import { failedLog, forgeOf, openPr, postReview, setStatus } from "../plugins/ask.ts";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { baseOf } from "./builder.ts";
import { openPrs, prOf, threadTask } from "./copy.ts";
import {
  afterReview,
  ciResult,
  onlyDocs,
  pastRoundLimit,
  refusedWorkflow,
  whoRunsTheSuite,
} from "./decide.ts";
import { fetchInto, pushCommit } from "./git.ts";
import { noteForLead, typeLeadNotes } from "./lead.ts";
import { endLimit, limitOn, reachLimit, tellOfLimit, waitUntil } from "./limits.ts";
import { Queue } from "./queue.ts";
import { type Limited, type Review, review } from "./reviewer.ts";
import {
  builderHarness,
  cloneOf,
  log,
  readThread,
  record,
  repositoryOf,
  type Thread,
  threadName,
} from "./thread.ts";

// Runs git in Skelcrew's own clone and returns what it printed, throwing with its error when it
// fails.
async function git(folder: string, ...args: string[]): Promise<string> {
  const { out, err, ok } = await quietly(["git", "-C", folder, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (!ok) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

// Fetches the thread's branch from its clone into Skelcrew's clone and pushes the commit it got
// to the thread's branch on the repository's remote, then, with a forge, opens the PR if there
// is none yet, with the line that closes its task at the end of its body. Returns the commit.
// git never runs inside the thread's clone: the builder controls everything there, .git
// included, and a planted setting would run with your rights. A push refused for changing a
// workflow file throws saying so, and types that into the builder, unless a newer round
// cancels it first.
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
    // A push refused for changing a workflow file fails the round with words a person can act
    // on, and the builder hears them too, so it can undo the change and submit again. It types
    // in once the builder is idle, as it has likely not ended its turn yet, and not at all once
    // a newer submit makes it stale.
    const refused = refusedWorkflow(threadName(db, thread), errorText(error));
    if (refused === null) throw error;
    deliver(sessions, folder, builderHarness(thread).marks, refused, {
      timeout: 30 * 60_000,
      signal,
    }).catch((failed) =>
      log(db, readThread(db, folder), `couldn't tell its builder: ${errorText(failed)}`),
    );
    throw new Error(refused);
  }
  // The base branch, current, in a ref of the thread's own, for the review to see which files
  // the change touches. Skelcrew's clone holds only the default branch otherwise. The poll
  // fetches the same ref. A base the forge won't give fails no push: the review then can't
  // tell the change is docs only, and the tests run.
  const bases = `refs/skelcrew/bases/${thread.folder}`;
  await fetchInto(db, repository, skelcrewClone, baseOf(thread), bases).catch(() => {});
  if (forgeOf(db, repository) === null) {
    record(db, folder, {}, `pushed ${sha} to ${thread.branch}`);
    return sha;
  }
  // The forge answers with the PR already open from the branch, such as one opened before the
  // daemon stopped and could save it.
  let { pr } = thread;
  if (pr === null) {
    const { title, closes } = threadTask(db, thread);
    pr = await openPr(db, repository, {
      branch: thread.branch,
      base: baseOf(thread),
      title,
      body: closes ? `${summary}\n\n${closes}` : summary,
    });
  }
  record(db, folder, { pr }, `pushed ${sha} to ${thread.branch}, for #${pr}`);
  return sha;
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

// The repositories, as owner/repo, where a review waited the whole time for a first check and
// no PR showed one: they have no CI that runs on PRs, such as a workflow that runs only on a
// release, or no CI at all. Their reviews wait no more, so that costs a repository at most once
// while the daemon runs. CI that is just slow to show its first check ends up here too, and its
// reviewers then run the suite as well, until a check shows on one of the repository's PRs.
const waitedInVain = new Set<string>();

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

// What a round asks of one run of its review, before the task, the clone and the base are read.
type Asked = Omit<Parameters<typeof review>[0], "clone" | "issue" | "base">;

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
  // reviewer, round limit and limit on reviews at once your config names.
  if (signal.aborted) return;
  const thread = readThread(db, folder);
  const repository = repositoryOf(db, thread);
  const { pr } = thread;
  const hasForge = forgeOf(db, repository) !== null;
  if (hasForge && pr === null) throw new Error("the thread has no pull request to review");
  const { reviewer: reviewerRole, maxRounds, fallback, reviewMinutes } = threadConfig(thread);
  const reviewer = reviewerRole.harness;
  const limit = reviewLimit();
  const setCheck = async (state: "pending" | "success" | "failure", description: string) => {
    if (hasForge) await setStatus(db, repository, { commit: sha, state, description });
  };
  // Show the review under way on the PR while it joins the queue of reviews. It joins before
  // any await, so reviews take their places in the order they are asked for: after a restart
  // the daemon asks for them in their saved order. A failed check fails the round at once,
  // rather than once its turn comes.
  const pending = setCheck("pending", "Skelcrew's reviewer is reviewing");
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
  const ls = ["git", "-C", cloneDir(thread.owner, thread.repo), "ls-tree", sha, "--"];
  const listed = Bun.spawnSync([...ls, ".github/workflows"], { stdout: "pipe", stderr: "ignore" });
  const setsUpCi = listed.success && listed.stdout.toString().trim() !== "";
  // A change to docs and Markdown alone is tested by no one, as CI skips it and no code
  // changed, so its review waits for no CI. The files are those changed since the base branch,
  // which the push fetched into the thread's own ref in Skelcrew's clone. Without rename
  // detection, a file moved from code into docs shows both names, so the code it removes
  // counts. Names end in a NUL, as git otherwise quotes one with letters outside ASCII, such
  // as résumé.md. A base or diff Skelcrew can't read, as in a clone not set up yet, lists
  // none, and the tests run.
  const bases = `refs/skelcrew/bases/${thread.folder}`;
  const diff = ["git", "-C", cloneDir(thread.owner, thread.repo), "diff", "--name-only", "-z"];
  const changed = Bun.spawnSync([...diff, "--no-renames", `${bases}...${sha}`], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const docsOnly =
    changed.success && onlyDocs(changed.stdout.toString().split("\0").filter(Boolean));
  const repositoryName = `${thread.owner}/${thread.repo}`;
  const suite = (waited: number) => {
    const prs = openPrs(db, thread.owner, thread.repo);
    const own = pr === null ? null : prOf(db, thread.owner, thread.repo, pr);
    const inVain = waitedInVain.has(repositoryName);
    const given = { own, commit: sha, prs, setsUpCi, waitedInVain: inVain, waited, checkWait };
    return whoRunsTheSuite(given);
  };
  if (pr !== null && !docsOnly && suite(0) === "wait") {
    // Saved as reviewing, as the review is under way for you, and so a restart brings it back.
    // Its place in the queue only matters once it joins, with `since`.
    const waiting = { reviewing: sha, submitting: null, reviewer, queued: null };
    record(db, folder, waiting, `waiting for CI's first check before reviewing ${sha}`);
    const started = Date.now();
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

    if (who === "reviewer" && whoRunsTheSuite({ ...noCi, waited: 0, checkWait }) === "reviewer")
      waitedInVain.add(repositoryName);
  }
  // A review that has to wait is saved as queued, with when it joined, so the thread says so,
  // and a restart puts it back in the same place. One that starts at once is saved as
  // reviewing, with no queued step in between.
  const waits = reviews.full(limit);
  const joined = { reviewing: sha, submitting: null, reviewer, queued: waits ? since : null };
  record(db, folder, joined, waits ? `queued ${sha} for review` : `reviewing ${sha}`);
  const queue = { limit, order: since, signal: AbortSignal.any([signal, checkFailed.signal]) };
  // Each run of the review takes a place in the queue: the first, one after a usage limit, and
  // one after a timeout. A later run keeps the review's place, and says it is queued only when
  // it waits.
  let queued = waits;
  // The task, the clone and the base branch are read only once the review's turn comes and its
  // check is pending, as reading them can fail, and a round still waiting on its check must not
  // fail early. What the run says of its harness's usage limit is saved before its place in the
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
          const started = Date.now();
          const result = await review({
            ...given,
            clone: cloneOf(thread),
            issue: threadTask(db, thread),
            // Setting up the thread's clone put the base branch there under origin/.
            base: `origin/${baseOf(thread)}`,
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
  // Decide what the verdict means for the thread, then post it on the PR. A failed or timed out
  // review is Skelcrew's problem, not the PR's, so it is never posted.
  if (signal.aborted) return;
  const before = readThread(db, folder).rounds;
  const ready = hasForge ? null : `${threadName(db, thread)} is ready on branch ${thread.branch}`;
  const outcome = afterReview(before, verdict, maxRounds, ready);
  if ((verdict.verdict === "approve" || verdict.verdict === "changes") && pr !== null)
    await postReview(db, repository, {
      pr,
      commit: sha,
      verdict: verdict.verdict,
      body: verdict.body,
    });
  // A newer round may be reviewing the same commit, and its check must stay pending.
  if (signal.aborted) return;
  await setCheck(outcome.check, outcome.description);
  if (signal.aborted) return;
  // Save the outcome, tell the lead if the thread now needs you, and type any changes into
  // the builder.
  const { rounds, needsYou, status, tell, held } = outcome;
  const change = {
    reviewing: null,
    rounds,
    needs_you: needsYou,
    status,
    telling: tell,
    held,
    reviewed_by: by,
    review_round: before + 1,
    verdict: verdict.verdict,
    review_line: verdict.body.trim().split("\n")[0]?.slice(0, 200) ?? "",
    review_at: Date.now(),
  };
  record(db, folder, change, outcome.why);
  typeLeadNotes(db, sessions);
  if (!tell) return;
  // The changes are saved, so a builder that never comes back, which ends the round, keeps them
  // for when you start it again.
  await builderBack;
  if (signal.aborted) return;
  await typeChanges(db, sessions, folder, tell, signal);
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

// Types a review's changes into the builder once it is idle, then forgets them. They are
// saved until then, so a stop of the daemon while the builder is busy doesn't lose them.
// A newer round makes them stale, so they are never typed once one starts.
async function typeChanges(
  db: Database,
  sessions: string,
  folder: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  // A builder can work long after it submits, but one busy this long has likely hung.
  await deliver(sessions, folder, builderHarness(readThread(db, folder)).marks, text, {
    timeout: 30 * 60_000,
    signal,
  });
  if (!signal.aborted) record(db, folder, { telling: null }, "typed the review into the builder");
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
  // A failure of a round no newer one replaced leaves the thread needing you, so it never
  // sits waiting on a review that will never come.
  const done = rest.catch((error) => {
    if (cancel.signal.aborted) return;
    const why = errorText(error);
    // A review not yet typed in stays saved, so starting the daemon again can type it. A review
    // that waited in the queue left it with the failure, so it no longer counts as queued.
    const change = {
      needs_you: true,
      status: "waiting",
      queued: null,
      ...notHeld,
      review_at: Date.now(),
    } satisfies Partial<Thread>;
    record(db, folder, change, `the round failed: ${why}`);
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
// about an older commit. Throws when your config or the repository's skelcrew.yaml isn't valid,
// so the builder hears why, and for a thread sc stop is ending, whose builder may submit while
// it exits.
export function submitRound(db: Database, sessions: string, folder: string, summary: string): void {
  const thread = readThread(db, folder);
  const { maxRounds, reviewer } = threadConfig(thread);
  if (thread.status === "stopped")
    throw new Error("this thread was stopped, so Skelcrew won't push it");
  // Past the round limit the thread still needs you, whatever the builder does.
  const needs_you = pastRoundLimit(thread, maxRounds);
  record(
    db,
    folder,
    {
      status: "waiting",
      needs_you,
      // A turn that ends after this waits on the review, not on you.
      submitted: true,
      submitting: summary,
      // A review of the older commit that waited for a place no longer does.
      queued: null,
      telling: null,
      held: null,
      ...notHeld,
      // What CI said was about the commit before this one.
      checks: null,
      reviewer: reviewer.harness,
      review_at: Date.now(),
    },
    `submitted: ${summary}`,
  );
  // The older round is cancelled, but its push still runs first, so the branch ends on this
  // round's commit.
  const before = latestRounds.get(folder);
  before?.cancel.abort();
  pushAndReview(db, sessions, folder, summary, before);
}

// Returns the commit Skelcrew last fetched from the thread's clone and pushed, or null when it
// has pushed none. Read at once, with no await, so two sc review can't both start one.
function lastPushed(thread: Thread): string | null {
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const ref = `refs/skelcrew/threads/${thread.folder}^{commit}`;
  const run = Bun.spawnSync(["git", "-C", skelcrewClone, "rev-parse", "--verify", "--quiet", ref], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.success ? run.stdout.toString().trim() : null;
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
  const { submitting, reviewing } = thread;
  if ((submitting !== null || reviewing !== null) && earlier && !earlier.ended)
    throw new Error(`a review of ${name}'s last commit is already waiting or running`);
  const sha = submitting === null ? lastPushed(thread) : null;
  if (submitting === null && sha === null)
    throw new Error(`${name} has no submitted commit to review yet`);
  const { maxRounds } = threadConfig(thread);
  // Past the round limit the thread still needs you, whatever the review says.
  const needs_you = pastRoundLimit(thread, maxRounds);
  // The commit is saved as under review at once, so a second sc review asked before the
  // check is pending again is refused rather than cancelling this one.
  // A builder that asked for it ends its turn waiting on the review, as after sc submit, not on
  // you. A review the lead or you asked for leaves the builder's turn as it was: a builder that
  // then stops without submitting still needs you.
  const change = {
    status: "waiting",
    needs_you,
    ...(byBuilder ? { submitted: true } : {}),
    telling: null,
    held: null,
    ...notHeld,
    reviewing: sha,
    review_at: Date.now(),
    queued: null,
  } satisfies Partial<Thread>;
  record(db, folder, change, "asked to review again");
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

// Carries on with a round the daemon's stop cut short: a submit not yet pushed and
// reviewed, a review whose Skelcrew's check was left pending, or changes not yet typed
// into the builder. Pushing again is harmless: the remote has the commit, or gets it now. A
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
  const { submitting, reviewing, queued, telling } = readThread(db, folder);
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
      typeChanges(db, sessions, folder, telling, cancel.signal),
    );
}

// Lets a thread past the round limit go on, for sc start: counts its rounds of changes from
// zero again, so it no longer needs you for them, and types the changes of the review that
// reached the limit into the builder, as a round within the limit would have.
export function goOn(db: Database, sessions: string, folder: string): void {
  const { held } = readThread(db, folder);
  const change = { rounds: 0, needs_you: false, held: null, telling: held };
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
    typeChanges(db, sessions, folder, held, cancel.signal),
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
