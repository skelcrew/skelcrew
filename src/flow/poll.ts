// Polling GitHub: the daemon brings Skelcrew's copy of each repository's issues and PRs up to
// date, starts threads on issues labeled skelcrew, and hands what each thread's PR means for it to
// the code that acts on it.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { threadConfig } from "../config.ts";
import { canPush, reactToIssue, readRepository, readTasks } from "../github.ts";
import { errorText } from "../say.ts";
import { startThread } from "./builder.ts";
import { openTasks, saveItems, taskOf } from "./copy.ts";
import { ciChecks, decide, labeledToStart, newAuthors } from "./decide.ts";
import { endThread, tellBuilder, typingEvents } from "./events.ts";
import { noteForLead, tellLead } from "./lead.ts";
import { fullNameIs, repositories } from "./repo.ts";
import { needsYou, readThread, record, Thread, threadName } from "./thread.ts";

// Starts a thread on each of the repository's open issues labeled skelcrew in Skelcrew's copy that
// has none, exactly as sc start does, then reacts to the issue with 👀 and tells the repository's
// lead. Thread rows are read after GitHub answers, so a thread sc start made meanwhile counts. A
// task in `starting`, named as owner/repo#number, is left to the sc start starting it, which has
// options of its own, such as the branch to start from. The thread is recorded before anything
// else, so neither a later poll nor a restart starts it again; a reaction that fails is only
// logged, never retried.
async function startLabeled(
  db: Database,
  tmux: string,
  owner: string,
  repo: string,
  begin: (thread: Thread) => Promise<void>,
  starting: Set<string>,
): Promise<void> {
  const fullName = `${owner}/${repo}`;
  const threads = db
    .query("SELECT * FROM threads WHERE owner = ? AND repo = ?")
    .all(owner, repo)
    .map((row) => Thread.parse(row));
  const labeled = openTasks(db, owner, repo)
    .filter((task) => task.labels.includes("skelcrew") && !starting.has(`${fullName}#${task.id}`))
    .map((task) => ({ number: Number(task.id), title: task.title }));
  for (const issue of labeledToStart(threads, labeled)) {
    // One sc start took meanwhile waits for the next poll.
    const thread = await startThread(db, { repo: fullName, task: issue.number }).catch((error) => {
      console.log(`couldn't start #${issue.number} in ${fullName}: ${errorText(error)}`);
      return null;
    });
    if (thread === null) continue;
    const note = `started ${threadName(db, thread)} from GitHub: ${issue.title}`;
    noteForLead(db, tmux, { owner, repo }, note.replace(/\s+/g, " ").slice(0, 200));
    // Not waited on, as for sc start: setup can take minutes.
    begin(thread);
    await reactToIssue(fullName, issue.number).catch((error) =>
      console.log(`couldn't react to #${issue.number} in ${fullName}: ${errorText(error)}`),
    );
  }
}

// Brings into Skelcrew's copy the task of each working, waiting or stopped thread that it lacks,
// closed ones too, before the daemon resumes their rounds, which read the task. A database from
// before the copy has none of them, and the first poll brings only open issues. A repository
// GitHub can't answer for is logged, and its rounds fail as they read the task.
export async function keepThreadsTasks(db: Database): Promise<void> {
  const missing = db
    .query("SELECT * FROM threads WHERE status IN ('working', 'waiting', 'stopped')")
    .all()
    .map((row) => Thread.parse(row))
    .filter((t) => {
      try {
        taskOf(db, t.owner, t.repo, t.task);
        return false;
      } catch {
        return true;
      }
    });
  for (const { owner, repo } of repositories(db)) {
    const numbers = missing.filter((t) => t.owner === owner && t.repo === repo).map((t) => t.task);
    if (numbers.length === 0) continue;
    await readTasks(`${owner}/${repo}`, numbers)
      .then((tasks) => saveItems(db, owner, repo, tasks, false))
      .catch((error) =>
        console.log(`couldn't read the tasks of ${owner}/${repo}: ${errorText(error)}`),
      );
  }
}

// Polls one repository: brings Skelcrew's copy of its issues and PRs up to date with what
// changed since `since`, or with everything open without it, starts threads on its issues
// labeled skelcrew, then acts on what each of its threads' PRs means for the thread. Returns the
// `since` of the next poll. Thread rows are read again after GitHub answers, since a round can
// change them while it waits.
async function pollRepository(
  db: Database,
  tmux: string,
  owner: string,
  repo: string,
  threads: Thread[],
  begin: (thread: Thread) => Promise<void>,
  since: string | null,
  starting: Set<string>,
): Promise<string | null> {
  const fullName = `${owner}/${repo}`;
  const { you, items, prs, next } = await readRepository(
    fullName,
    threads.flatMap((t) => (t.pr === null ? [] : [t.pr])),
    since,
  );
  saveItems(db, owner, repo, items, since === null);
  await startLabeled(db, tmux, owner, repo, begin, starting);
  // Asked once per poll, and only about authors of what is new.
  const pushers: string[] = [];
  for (const login of newAuthors(threads, prs, you))
    if (await canPush(fullName, login)) pushers.push(login);
  for (const before of threads) {
    const { folder } = before;
    // Read together, with no wait between, so a review the thread's round has finished is
    // always among those Skelcrew posted.
    const thread = readThread(db, folder);
    const posted = db
      .query("SELECT id FROM posted")
      .all()
      .map((row) => z.object({ id: z.number() }).parse(row).id);
    const pr = thread.pr === null ? undefined : prs.get(thread.pr);
    if (!pr || !["working", "waiting", "stopped"].includes(thread.status)) continue;
    // Read only for a thread with a PR, so a bad max_rounds never fails the copy's update, nor
    // sc start, which polls first.
    const { maxRounds } = threadConfig({ owner, repo });
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
    else if (thread.status === "stopped" || typingEvents.has(folder) || stale) continue;
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
  return next;
}

// Polls GitHub for what changed in each repository's issues and PRs, and the PRs of its live
// and stopped threads, one query per repository, so a stopped thread's merge still ends it:
// every `every` milliseconds while any of its threads is working or waits on review or CI, and
// half as often otherwise, so a label or your comment is seen within a minute. Starts at once,
// to pick up what happened while the daemon was down. A failed poll, such as GitHub answering
// with an error, is logged and tried again at the next one. Polls run in the background, so
// they never hold up the daemon. `begin` sets up a thread started from a label and starts its
// builder, as the daemon does for sc start. `starting` holds the tasks sc start is starting
// right now, which no poll starts by their label. Returns a function that polls one repository at
// once, named by its full GitHub name, for a webhook delivery about it or for sc start, and
// settles once that poll is done, failing as it does.
export function pollGitHub(
  db: Database,
  tmux: string,
  every: number,
  begin: (thread: Thread) => Promise<void>,
  starting: Set<string>,
): (fullName: string) => Promise<void> {
  const skipped = new Map<string, number>();
  // The poll under way for each repository, and the one that follows it.
  const running = new Map<string, Promise<void>>();
  const following = new Map<string, Promise<void>>();
  // Where each repository's next poll starts from. The daemon starts with none, so its first
  // poll brings everything open, and what closed while it was down leaves the copy.
  const since = new Map<string, string | null>();
  // The threads whose PRs a poll reads. A stopped thread's PR still merges or closes.
  const polled = () =>
    db
      .query("SELECT * FROM threads WHERE status IN ('working', 'waiting', 'stopped')")
      .all()
      .map((row) => Thread.parse(row))
      .filter((t) => t.pr !== null);
  const poll = (owner: string, repo: string): Promise<void> => {
    const fullName = `${owner}/${repo}`;
    skipped.set(fullName, 0);
    const now = running.get(fullName);
    if (now) {
      // A delivery that comes in while its repository is being polled may be about an event
      // the poll's query was too early to see, and sc start must see every change up to its
      // asking, so one more poll follows. Everyone who asks meanwhile shares it.
      const next =
        following.get(fullName) ??
        now
          .catch(() => {})
          .then(() => {
            following.delete(fullName);
            return poll(owner, repo);
          });
      following.set(fullName, next);
      return next;
    }
    const threads = polled().filter((t) => t.owner === owner && t.repo === repo);
    const done = pollRepository(
      db,
      tmux,
      owner,
      repo,
      threads,
      begin,
      since.get(fullName) ?? null,
      starting,
    )
      .then(
        (next) => {
          since.set(fullName, next);
        },
        (error) => {
          console.log(`couldn't poll ${fullName}: ${errorText(error)}`);
          throw error;
        },
      )
      .finally(() => running.delete(fullName));
    running.set(fullName, done);
    return done;
  };
  const tick = () => {
    const live = polled();
    for (const { owner, repo } of repositories(db)) {
      const fullName = `${owner}/${repo}`;
      const threads = live.filter((t) => t.owner === owner && t.repo === repo);
      const active = threads.some(
        (t) => t.status === "working" || (t.status === "waiting" && !needsYou(t)),
      );
      const waited = skipped.get(fullName) ?? Number.POSITIVE_INFINITY;
      if (running.has(fullName) || (!active && waited < 1)) {
        skipped.set(fullName, waited + 1);
        continue;
      }
      // Already logged.
      poll(owner, repo).catch(() => {});
    }
  };
  tick();
  setInterval(tick, every);
  return async (fullName) => {
    const found = repositories(db).find((r) => fullNameIs(r, fullName));
    if (found) await poll(found.owner, found.repo);
  };
}
