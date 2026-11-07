// Polling GitHub: the daemon reads each repository's labeled issues, open lists and threads'
// PRs, and hands what each PR means for its thread to the code that acts on it.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ciChecks, decide, labeledToStart, newAuthors } from "./decide.ts";
import { endThread, tellBuilder, typing } from "./events.ts";
import { canPush, type Labeled, type OpenList, reactToIssue, readRepository } from "./github.ts";
import { tellLead } from "./lead.ts";
import { repositories } from "./repo.ts";
import {
  needsYou,
  readThread,
  record,
  startThread,
  Thread,
  threadConfig,
  threadName,
} from "./thread.ts";
import { runningSessions, screenSocket } from "./tmux.ts";

// Starts a thread on each of the repository's issues labeled skel that has none, exactly as
// skel start does, then reacts to the issue with 👀 and tells the lead. Thread rows are read
// after GitHub answers, so a thread skel start made meanwhile counts. The thread is recorded
// before anything else, so neither a later poll nor a restart starts it again; a reaction
// that fails is only logged, never retried.
async function startLabeled(
  db: Database,
  tmux: string,
  owner: string,
  name: string,
  labeled: Labeled[],
  begin: (thread: Thread) => Promise<void>,
): Promise<void> {
  const repo = `${owner}/${name}`;
  const threads = db
    .query("SELECT * FROM threads WHERE owner = ? AND repo = ?")
    .all(owner, name)
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

// Replaces what is saved of a repository's open issues and PRs with what GitHub just said, for
// the sidebar, which only reads the database. All at once, so it never reads half a list.
function saveOpen(
  db: Database,
  owner: string,
  name: string,
  open: { issues: OpenList; prs: OpenList },
): void {
  // Saves one list's rows.
  const insert = (kind: string, list: OpenList) => {
    for (const { number, title, createdAt } of list.items)
      db.run(
        `INSERT INTO open_items (owner, repo, kind, number, title, created)
          VALUES (?, ?, ?, ?, ?, ?)`,
        [owner, name, kind, number, title, createdAt],
      );
  };
  db.transaction(() => {
    db.run("DELETE FROM open_items WHERE owner = ? AND repo = ?", [owner, name]);
    insert("issue", open.issues);
    insert("pr", open.prs);
    db.run("UPDATE repositories SET open_issues = ?, open_prs = ? WHERE owner = ? AND repo = ?", [
      open.issues.total,
      open.prs.total,
      owner,
      name,
    ]);
  })();
}

// Polls one repository: saves its open issues and PRs while a screen is open, starts threads on
// its issues labeled skel, then acts on what each of its threads' PRs means for the thread.
// Thread rows are read again after GitHub answers, since a round can change them while it waits.
async function pollRepository(
  db: Database,
  tmux: string,
  owner: string,
  name: string,
  threads: Thread[],
  begin: (thread: Thread) => Promise<void>,
): Promise<void> {
  const repo = `${owner}/${name}`;
  // Nobody sees the lists with no screen open, so GitHub isn't asked for them.
  const lists = runningSessions(screenSocket(tmux)).length > 0;
  const { you, labeled, prs, open } = await readRepository(
    repo,
    threads.flatMap((t) => (t.pr === null ? [] : [t.pr])),
    lists,
  );
  if (open) saveOpen(db, owner, name, open);
  await startLabeled(db, tmux, owner, name, labeled, begin);
  const { maxRounds } = threadConfig();
  // Asked once per poll, and only about authors of what is new.
  const pushers: string[] = [];
  for (const login of newAuthors(threads, prs, you))
    if (await canPush(repo, login)) pushers.push(login);
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
// threads, and its open issues and PRs while a screen is open, one query per repository, so a stopped thread's merge still ends it: every `every`
// milliseconds while any of its threads is working or waits on review or CI, and half as
// often otherwise, so a label or your comment is seen within a minute. Starts at once, to pick
// up what happened while the daemon was down. A failed poll, such as GitHub answering with an
// error, is logged and tried again at the next one. Polls run in the background, so they never hold up the daemon. `begin` sets up a
// thread started from a label and starts its builder, as the daemon does for skel start.
// Returns a function that polls one repository at once, named by its full GitHub name, for
// a webhook delivery about it or a screen opening.
export function pollGitHub(
  db: Database,
  tmux: string,
  every: number,
  begin: (thread: Thread) => Promise<void>,
): (full: string) => void {
  const skipped = new Map<string, number>();
  const polling = new Set<string>();
  // A delivery that comes in while its repository is being polled may be about an event the
  // poll's query was too early to see, and a screen that opens may want lists it didn't ask
  // for, so the repository is polled again once it is done.
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
    pollRepository(db, tmux, owner, name, threads, begin)
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
