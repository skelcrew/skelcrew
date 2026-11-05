// Events on a thread's PR: the daemon polls GitHub for each repository's PRs, decides what
// each new review, comment, check, conflict or merge means for its thread, and acts on it.
// Ending a thread's builder lives here too, for a merge and for skel stop, as both must
// cancel the events still being typed in.
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { z } from "zod";
import {
  type Check,
  canPush,
  failedLog,
  fetchIntoClone,
  type Labeled,
  type PullRequest,
  reactToIssue,
  readRepository,
} from "./github.ts";
import { tellLead } from "./lead.ts";
import { cloneDir } from "./paths.ts";
import { refreshClones, repositories } from "./repo.ts";
import { endRound } from "./round.ts";
import {
  baseOf,
  cloneOf,
  github,
  needsYou,
  readThread,
  record,
  startThread,
  Thread,
  threadConfig,
  threadName,
} from "./thread.ts";
import { failedScreen, hasSession, stopSession, typeInto } from "./tmux.ts";

type Change = Partial<Pick<Thread, "status" | "needs_you">>;
type Author = PullRequest["comments"][number]["author"];

export type Decision =
  | { end: string }
  | {
      // The last event of each kind handled once this decision is carried out.
      handled: { last_review: number; last_comment: number; last_check: number };
      // What to type into the builder, besides the failed checks, whose logs come from GitHub.
      tell: string[];
      failed: Check[];
      // The base branch the PR conflicts with, which skel's clone must hold before the
      // builder, told to merge it, fetches it from there.
      conflict: string | null;
      change: Change;
      why: string;
    };

// Conclusions the builder can do something about. A cancelled run was mostly replaced by a
// newer one, and one that needs action needs it from you.
const failing = ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"];

// Returns whether a check passed, so a PR with every check passed is green.
const passed = (check: Check) =>
  check.kind === "run"
    ? check.status === "COMPLETED" &&
      ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? "")
    : check.state === "SUCCESS";

// Returns whether a check is still to finish.
const running = (check: Check) =>
  check.kind === "run"
    ? check.status !== "COMPLETED"
    : ["PENDING", "EXPECTED"].includes(check.state);

// Returns CI's checks, without skel's own review check, which its rounds look after.
const ciOf = (pr: PullRequest) => pr.checks.filter((c) => c.name !== "skel/review");

// Returns what the PR's CI says, for the strip, or null when it has none. One failure is enough
// to say so, while the rest still run.
export function ciChecks(pr: PullRequest): Thread["checks"] {
  const ci = ciOf(pr);
  if (ci.length === 0) return null;
  if (ci.every(passed)) return "passing";
  return ci.some((c) => !passed(c) && !running(c)) ? "failing" : "pending";
}

// Returns the reviews after the last one handled, oldest first, up to the first one still
// pending. A pending review gets its ID when it is started, not when it is submitted, so the
// reviews after it must wait for it, or it would come in behind the last handled ID.
function newReviews(reviews: PullRequest["reviews"], after: number): PullRequest["reviews"] {
  const later = reviews.filter((r) => r.id > after).sort((a, b) => a.id - b.id);
  const pending = later.findIndex((r) => r.state === "PENDING");
  return pending === -1 ? later : later.slice(0, pending);
}

// Decides what the thread's PR, as GitHub returned it, means for the thread: whether it
// ended, what to type into the builder, and how the thread changes. Events are handled once:
// only reviews, comments and check runs after the last ones handled count. You are `you`, the
// gh login skel uses, and `posted` holds the reviews skel posted with it, which are never
// typed back as yours. Your comments wake the builder even past the round limit. Those of
// `pushers`, who can push to the repository, wake it within the limit. Anyone else's, a bot's
// included, never do: on a public repository anyone can comment, and what is typed in steers
// the builder.
export function decide(
  thread: Thread,
  pr: PullRequest,
  given: { you: string; maxRounds: number; posted: number[]; pushers: string[] },
): Decision {
  if (pr.state === "MERGED") return { end: `PR #${thread.pr} was merged` };
  if (pr.state === "CLOSED") return { end: `PR #${thread.pr} was closed without merging` };
  const runs = pr.checks.flatMap((check) => (check.kind === "run" ? [check] : []));
  const { last_review, last_comment, last_check } = thread;
  if (last_review === null || last_comment === null || last_check === null) {
    const reviews = newReviews(pr.reviews, 0);
    const handled = {
      last_review: Math.max(0, ...reviews.map((r) => r.id)),
      last_comment: Math.max(0, ...pr.comments.map((c) => c.id)),
      last_check: Math.max(0, ...runs.map((r) => r.id)),
    };
    const why = "started after the PR's history";
    return { handled, tell: [], failed: [], conflict: null, change: {}, why };
  }
  const past = thread.rounds > given.maxRounds;
  // Whether what this author wrote is typed into the builder.
  const wakes = (author: Author) =>
    author !== null &&
    !author.bot &&
    (author.login === given.you || (!past && given.pushers.includes(author.login)));
  const who = (author: Author) => author?.login ?? "someone";
  const tell: string[] = [];
  // While skel's reviewer reviews, the review it posts can reach GitHub before skel has
  // noted it as its own, so reviews wait until it is done.
  const reviews = thread.reviewing === null ? newReviews(pr.reviews, last_review) : [];
  for (const r of reviews) {
    if (given.posted.includes(r.id) || !wakes(r.author)) continue;
    const lines = r.comments.map((c) => `${c.path}${c.line ? `:${c.line}` : ""}: ${c.body}`);
    const text = [r.body.trim(), ...lines].filter(Boolean).join("\n\n");
    if (text) tell.push(`${who(r.author)} reviewed the PR:\n\n${text}`);
  }
  const comments = pr.comments.filter((c) => c.id > last_comment).sort((a, b) => a.id - b.id);
  for (const c of comments)
    if (wakes(c.author)) tell.push(`${who(c.author)} commented on the PR:\n\n${c.body}`);
  // Only once nothing is under way, so a conflict or a failed commit status is told once: the
  // builder then works on it until it submits again.
  const quiet =
    thread.status === "waiting" && thread.submitting === null && thread.reviewing === null;
  const ci = ciOf(pr);
  // While a newer round is still being pushed, the checks GitHub shows are an older commit's.
  // Parallel jobs finish out of order, and one that fails later must not fall behind the last
  // handled ID, so failures wait until every check has finished. A commit status has no ID.
  const finished = thread.submitting === null && !ci.some(running);
  const failed = finished
    ? ci.filter((c) =>
        c.kind === "run"
          ? c.id > last_check && failing.includes(c.conclusion ?? "")
          : quiet && ["FAILURE", "ERROR"].includes(c.state),
      )
    : [];
  const conflict = quiet && pr.mergeable === "CONFLICTING" ? pr.base : null;
  if (conflict !== null)
    tell.push(
      `The PR conflicts with ${conflict}. Run git fetch origin, merge origin/${conflict} into your branch and fix the conflict, then commit and run skel submit "<summary>" again.`,
    );
  const handled = {
    last_review: Math.max(last_review, ...reviews.map((r) => r.id)),
    last_comment: Math.max(last_comment, ...comments.map((c) => c.id)),
    last_check: finished ? Math.max(last_check, ...runs.map((r) => r.id)) : last_check,
  };
  if (tell.length > 0 || failed.length > 0) {
    const told = [...failed.map((r) => `${r.name} failed`), ...tell.map((t) => t.split("\n")[0])];
    // Past the round limit the thread still needs you, as the builder's next round would.
    const change: Change = { status: "working", needs_you: past };
    const why = `told the builder: ${told.join("; ")}`;
    return { handled, tell, failed, conflict, change, why };
  }
  // skel's reviewer approves by setting its skel/review check, so an approved PR with every
  // check passed, its own included, is ready. With no CI, that check is the only one.
  const approved = pr.checks.some(
    (c) => c.kind === "status" && c.name === "skel/review" && c.state === "SUCCESS",
  );
  if (quiet && !thread.needs_you && approved && pr.checks.every(passed))
    return {
      handled,
      tell,
      failed,
      conflict,
      change: { needs_you: true },
      why: "approved by skel's reviewer with every check green, so it is ready to merge",
    };
  return { handled, tell, failed, conflict, change: {}, why: "" };
}

// Returns the issues labeled skel that get a thread: those with no thread at all. A thread
// that failed, was stopped or is done keeps its row, so its label never starts it again;
// only skel start does.
export function labeledToStart(threads: Thread[], labeled: Labeled[]): Labeled[] {
  return labeled.filter((issue) => !threads.some((t) => t.task === issue.number));
}

// The message about failed checks, with the end of each one's log. A check that isn't a
// GitHub Actions job has no log gh can read, so it gets its link instead.
async function aboutChecks(repo: string, failed: Check[]): Promise<string[]> {
  return Promise.all(
    failed.map(async (c) => {
      const link = c.url ? ` (${c.url})` : "";
      const fix = 'Fix it, commit, and run skel submit "<summary>" again.';
      if (c.kind === "status") return `The check ${c.name} failed${link}. ${fix}`;
      const log = await failedLog(repo, c.id).catch(
        (error) =>
          `(skel couldn't read its log: ${error instanceof Error ? error.message : error})`,
      );
      return `The check ${c.name} failed${link}. The end of its log:\n\n${log}\n\n${fix}`;
    }),
  );
}

// Brings skel's clone of the repository up to date with the base branch, so the builder,
// whose clone has it as origin, gets the latest base when it fetches. The daemon otherwise
// refreshes it only when you attach or it starts, and holds only the default branch.
async function freshBase(db: Database, thread: Thread, base: string): Promise<void> {
  await refreshClones(db);
  if (base !== baseOf({ ...thread, base: null }))
    await fetchIntoClone(cloneDir(thread.owner, thread.repo), github(thread), base);
}

// Typing in progress per thread. A poll leaves a thread alone while its events are typed in,
// so they are never typed twice, and a merge cancels the typing.
const typing = new Map<string, AbortController>();

// Cancels the round and the typing under way for the thread, ends its builder's session, and
// waits for the builder to exit, so nothing types into it or changes the thread afterwards.
async function endBuilder(tmux: string, folder: string): Promise<void> {
  typing.get(folder)?.abort();
  endRound(folder);
  // Claude Code can outlive the end of its session for a few seconds, still writing in the
  // clone.
  await stopSession(tmux, folder);
}

// Stops the thread for skel stop: marks it stopped, then ends its builder as a merge would,
// but keeps its clone, branch and PR, so skel start can bring the builder back where it was.
// A submit, review or review's changes under way stay saved and carry on once it starts
// again. It no longer needs you: you stopped it, and its builder's question ended with it.
// Marked first, so a builder that submits while it exits is refused.
export async function stopThread(db: Database, tmux: string, thread: Thread): Promise<void> {
  record(db, thread.folder, { status: "stopped", needs_you: false, asking: false }, "stopped");
  await endBuilder(tmux, thread.folder);
}

// Ends the thread once its PR is merged or closed: ends its builder, and removes its clone by
// deleting the folder, never running git in it.
async function endThread(db: Database, tmux: string, thread: Thread, why: string): Promise<void> {
  await endBuilder(tmux, thread.folder);
  rmSync(cloneOf(thread), { recursive: true, force: true });
  record(db, thread.folder, { status: "done", needs_you: false }, `${why}: ended the thread`);
}

// Types what the decision tells into the builder once it is idle, then saves the decision.
// It is saved only after, so a stop of the daemon meanwhile leaves the events to the next
// poll. A builder that isn't running, or stays busy for half an hour, isn't told: the events
// count as handled, and the thread needs you, with what it missed in its log.
async function tellBuilder(
  db: Database,
  tmux: string,
  thread: Thread,
  decision: Exclude<Decision, { end: string }>,
): Promise<void> {
  const cancel = new AbortController();
  typing.set(thread.folder, cancel);
  const { handled, change, why } = decision;
  try {
    if (decision.conflict !== null) await freshBase(db, thread, decision.conflict);
    const checks = await aboutChecks(`${thread.owner}/${thread.repo}`, decision.failed);
    const text = [...checks, ...decision.tell].join("\n\n---\n\n");
    if (!hasSession(tmux, thread.folder) || failedScreen(tmux, thread.folder) !== null)
      throw new Error("its builder isn't running");
    // A builder can work long after an event, but one busy this long has likely hung.
    await typeInto(tmux, thread.folder, text, { timeout: 30 * 60_000, signal: cancel.signal });
    if (cancel.signal.aborted) return;
    // Typing can wait a long time, and a newer round may have moved the thread on meanwhile,
    // such as to approved. Its state then stands, and only the events count as handled.
    const now = readThread(db, thread.folder);
    const moved =
      now.status !== thread.status ||
      now.needs_you !== thread.needs_you ||
      now.rounds !== thread.rounds ||
      now.submitting !== thread.submitting ||
      now.reviewing !== thread.reviewing;
    record(db, thread.folder, moved ? handled : { ...handled, ...change }, why);
  } catch (error) {
    // Ending the session for a stop or a merge can make typing fail, and a stopped thread's
    // events must stay unhandled for its builder to hear once it starts again.
    if (cancel.signal.aborted) return;
    const said = error instanceof Error ? error.message : String(error);
    record(db, thread.folder, { ...handled, needs_you: true }, `couldn't tell: ${said}. ${why}`);
    tellLead(db, tmux);
  } finally {
    typing.delete(thread.folder);
  }
}

// Starts a thread on each of the repository's issues labeled skel that has none, exactly as
// skel start does, then reacts to the issue with 👀 and tells the lead. Thread rows are read
// after GitHub answers, so a thread skel start made meanwhile counts. The thread is recorded
// before anything else, so neither a later poll nor a restart starts it again; a reaction
// that fails is only logged, never retried.
async function startLabeled(
  db: Database,
  tmux: string,
  repo: string,
  labeled: Labeled[],
  begin: (thread: Thread) => Promise<void>,
): Promise<void> {
  const [owner, name] = repo.split("/");
  const threads = db
    .query("SELECT * FROM threads WHERE owner = ? AND repo = ?")
    .all(owner ?? "", name ?? "")
    .map((row) => Thread.parse(row));
  for (const issue of labeledToStart(threads, labeled)) {
    // An issue skel can't read, or one skel start took meanwhile, waits for the next poll.
    const thread = await startThread(db, { repo, task: issue.number }).catch((error) => {
      console.log(`couldn't start #${issue.number} in ${repo}: ${message(error)}`);
      return null;
    });
    if (thread === null) continue;
    const note = `started ${threadName(db, thread)} from GitHub: ${issue.title}`;
    db.run("INSERT INTO notes (text) VALUES (?)", [note.replace(/\s+/g, " ").slice(0, 200)]);
    tellLead(db, tmux);
    // Not waited on, as for skel start: setup can take minutes.
    begin(thread);
    await reactToIssue(repo, issue.number).catch((error) =>
      console.log(`couldn't react to #${issue.number} in ${repo}: ${message(error)}`),
    );
  }
}

// Returns the text of anything thrown, for the daemon's log.
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Polls one repository: starts threads on its issues labeled skel, then acts on what each of
// its threads' PRs means for the thread. Thread rows are read again after GitHub answers,
// since a round can change them while it waits.
async function pollRepository(
  db: Database,
  tmux: string,
  repo: string,
  threads: Thread[],
  begin: (thread: Thread) => Promise<void>,
): Promise<void> {
  const { you, labeled, prs } = await readRepository(
    repo,
    threads.flatMap((t) => (t.pr === null ? [] : [t.pr])),
  );
  await startLabeled(db, tmux, repo, labeled, begin);
  const { maxRounds } = threadConfig();
  // Asked once per poll, and only about authors of what is new.
  const authors = new Set<string>();
  for (const t of threads) {
    const pr = t.pr === null || t.status === "stopped" ? undefined : prs.get(t.pr);
    for (const item of [
      ...(pr?.reviews.filter((r) => r.id > (t.last_review ?? Number.POSITIVE_INFINITY)) ?? []),
      ...(pr?.comments.filter((c) => c.id > (t.last_comment ?? Number.POSITIVE_INFINITY)) ?? []),
    ])
      if (item.author && !item.author.bot && item.author.login !== you)
        authors.add(item.author.login);
  }
  const pushers: string[] = [];
  for (const login of authors) if (await canPush(repo, login)) pushers.push(login);
  for (const before of threads) {
    const { folder } = before;
    // Read together, with no wait between, so a review the thread's round has finished is
    // always among those skel posted.
    const thread = readThread(db, folder);
    const posted = db
      .query("SELECT id FROM posted")
      .all()
      .map((row) => z.object({ id: z.number() }).parse(row).id);
    const pr = thread.pr === null ? undefined : prs.get(thread.pr);
    if (!pr || !["working", "waiting", "stopped"].includes(thread.status)) continue;
    const decision = decide(thread, pr, { you, maxRounds, posted, pushers });
    // A round that moved on while GitHub answered may have pushed a newer commit, and what
    // GitHub said about the checks would be the older one's. The next poll sees the new one.
    const stale =
      thread.submitting !== before.submitting ||
      thread.reviewing !== before.reviewing ||
      thread.rounds !== before.rounds;
    // Saved ahead of what the decision does, so a thread never needs you for an approval while
    // its saved checks still say otherwise. A commit on its way has no checks to speak of yet.
    const checks = ciChecks(pr);
    if (!stale && thread.submitting === null && checks !== thread.checks)
      record(db, folder, { checks });
    if ("end" in decision) await endThread(db, tmux, thread, decision.end);
    // Left unhandled, so a stopped thread's events reach its builder once it starts again.
    else if (thread.status === "stopped" || typing.has(folder) || stale) continue;
    else if (decision.tell.length > 0 || decision.failed.length > 0)
      // Not waited on, so a busy builder holds up neither the other threads nor the next poll.
      tellBuilder(db, tmux, thread, decision);
    else {
      const { handled, change, why } = decision;
      const moved =
        handled.last_review !== thread.last_review ||
        handled.last_comment !== thread.last_comment ||
        handled.last_check !== thread.last_check;
      // Most polls find nothing new, and the log stays free of them.
      if (moved || Object.keys(change).length > 0) {
        record(db, folder, { ...handled, ...change }, why);
        tellLead(db, tmux);
      }
    }
  }
}

// Polls GitHub for each repository's issues labeled skel and the PRs of its live and stopped
// threads, one query per repository, so a stopped thread's merge still ends it: every `every`
// milliseconds while any of its threads is working or waits on review or CI, and half as
// often otherwise, so a label or your comment is seen within a minute. Starts at once, to pick
// up what happened while the daemon was down. A failed poll, such as GitHub answering with an
// error, is logged and tried again at the next one. Polls run in the background, so they never hold up the daemon. `begin` sets up a
// thread started from a label and starts its builder, as the daemon does for skel start.
// Returns a function that polls one repository at once, named by its full GitHub name, for
// a webhook delivery about it.
export function pollGitHub(
  db: Database,
  tmux: string,
  every: number,
  begin: (thread: Thread) => Promise<void>,
): (full: string) => void {
  const skipped = new Map<string, number>();
  const polling = new Set<string>();
  // A delivery that comes in while its repository is being polled may be about an event the
  // poll's query was too early to see, so the repository is polled again once it is done.
  const again = new Set<string>();
  // The threads whose PRs a poll reads. A stopped thread's PR still merges or closes.
  const polled = () =>
    db
      .query("SELECT * FROM threads WHERE status IN ('working', 'waiting', 'stopped')")
      .all()
      .map((row) => Thread.parse(row))
      .filter((t) => t.pr !== null);
  const poll = (owner: string, name: string) => {
    const repo = `${owner}/${name}`;
    skipped.set(repo, 0);
    if (polling.has(repo)) {
      again.add(repo);
      return;
    }
    polling.add(repo);
    const threads = polled().filter((t) => t.owner === owner && t.repo === name);
    pollRepository(db, tmux, repo, threads, begin)
      .catch((error) => console.log(`couldn't poll ${repo}: ${message(error)}`))
      .finally(() => {
        polling.delete(repo);
        if (again.delete(repo)) poll(owner, name);
      });
  };
  const tick = () => {
    const live = polled();
    for (const { owner, repo: name } of repositories(db)) {
      const repo = `${owner}/${name}`;
      const threads = live.filter((t) => t.owner === owner && t.repo === name);
      const active = threads.some(
        (t) => t.status === "working" || (t.status === "waiting" && !needsYou(t)),
      );
      const waited = skipped.get(repo) ?? Number.POSITIVE_INFINITY;
      if (polling.has(repo) || (!active && waited < 1)) {
        skipped.set(repo, waited + 1);
        continue;
      }
      poll(owner, name);
    }
  };
  tick();
  setInterval(tick, every);
  return (full) => {
    const found = repositories(db).find(
      (r) => `${r.owner}/${r.repo}`.toLowerCase() === full.toLowerCase(),
    );
    if (found) poll(found.owner, found.repo);
  };
}
