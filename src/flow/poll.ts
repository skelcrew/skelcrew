// Polling: the daemon asks each repository's tracker and forge what changed, brings skel's
// copy of its tasks and PRs up to date, starts threads on tasks labeled to start, and hands what
// each thread's PR means for it to the code that acts on it. In a repository with no forge, it
// ends a thread once its branch is merged or gone.
import type { Database } from "bun:sqlite";
import { threadConfig } from "../config.ts";
import type { Repository } from "../db.ts";
import { cloneDir } from "../paths.ts";
import { changed, forgeOf, pluginsOf, took, trackerOf } from "../plugins/ask.ts";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { baseOf, startThread } from "./builder.ts";
import { type Item, openTasks, saveItems } from "./copy.ts";
import { ciChecks, decide, labeledToStart, type PullRequest } from "./decide.ts";
import { endThread, tellBuilder, typingEvents } from "./events.ts";
import { fetchInto, onRemote } from "./git.ts";
import { noteForLead, tellLead } from "./lead.ts";
import { forgeKnown, fullNameIs, repositories } from "./repo.ts";
import { needsYou, readThread, record, Thread, threadName } from "./thread.ts";

// The label that starts a thread on a task, added in its tracker by someone who may.
const startLabel = "skelcrew";

// Starts a thread on each of the repository's open tasks labeled to start in skel's copy that
// has none, exactly as skel start does, then tells the tracker skel took it and tells the
// repository's lead. Thread rows are read after the tracker answers, so a thread skel start
// made meanwhile counts. A task in `starting`, named as owner/repo#task, is left to the skel
// start starting it, which has options of its own, such as the branch to start from. The
// thread is recorded before anything else, so neither a later poll nor a restart starts it
// again; telling the tracker that fails is only logged, never tried again.
async function startLabeled(
  db: Database,
  tmux: string,
  repository: Repository,
  begin: (thread: Thread) => Promise<void>,
  starting: Set<string>,
): Promise<void> {
  const { owner, repo } = repository;
  const fullName = `${owner}/${repo}`;
  const threads = db
    .query("SELECT * FROM threads WHERE owner = ? AND repo = ?")
    .all(owner, repo)
    .map((row) => Thread.parse(row));
  const labeled = openTasks(db, owner, repo).filter(
    (task) => task.labels.includes(startLabel) && !starting.has(`${fullName}#${task.id}`),
  );
  for (const task of labeledToStart(threads, labeled)) {
    // One skel start took meanwhile waits for the next poll.
    const thread = await startThread(db, { repo: fullName, task: task.id }).catch((error) => {
      console.log(`couldn't start ${task.id} in ${fullName}: ${errorText(error)}`);
      return null;
    });
    if (thread === null) continue;
    const note = `started ${threadName(db, thread)} from ${trackerOf(db, repository)}: ${task.title}`;
    noteForLead(db, tmux, { owner, repo }, note.replace(/\s+/g, " ").slice(0, 200));
    // Not waited on, as for skel start: setup can take minutes.
    begin(thread);
    await took(db, repository, task.id).catch((error) =>
      console.log(
        `couldn't tell the tracker skel took ${task.id} in ${fullName}: ${errorText(error)}`,
      ),
    );
  }
}

// Acts on what the thread's PR, as its forge just returned it, means for the thread. `before`
// is the thread as it was when the poll began: a round that moved on while the forge answered
// may have pushed a newer commit, and what the forge said about the checks would be the older
// one's, so the next poll acts on it instead.
async function actOnPr(db: Database, tmux: string, before: Thread, pr: PullRequest): Promise<void> {
  const { folder } = before;
  const thread = readThread(db, folder);
  if (!["working", "waiting", "stopped"].includes(thread.status)) return;
  // Read only for a thread with a PR, so a bad max_rounds never fails the copy's update, nor
  // skel start, which polls first.
  const { maxRounds } = threadConfig(thread);
  const decision = decide(thread, pr, { maxRounds });
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
  else if (thread.status === "stopped" || typingEvents.has(folder) || stale) return;
  else if (decision.tell.length > 0 || decision.failed.length > 0)
    // Not waited on, so a busy builder holds up neither the other threads nor the next poll.
    tellBuilder(db, tmux, thread, decision);
  else {
    const { seen, change, why } = decision;
    const moved = JSON.stringify(seen) !== JSON.stringify(thread.seen);
    // Most polls find nothing new, and the log stays free of them.
    if (moved || Object.keys(change).length > 0) {
      record(db, folder, { seen, ...change }, why);
      tellLead(db, tmux);
    }
  }
}

// Ends a thread of a repository with no forge once its branch is done with: when merging it
// into its base would change nothing, which a merge, a squash and a rebase all leave, or when
// it is gone from the remote. Only a branch skel has pushed counts, as before that it isn't on
// the remote at all.
async function actOnBranch(db: Database, tmux: string, repository: Repository, thread: Thread) {
  const ours = cloneDir(thread.owner, thread.repo);
  const ref = (kind: string) => `refs/skel/${kind}/${thread.folder}`;
  const git = (...args: string[]) => quietly(["git", "-C", ours, ...args]);
  // A push under way has saved its local ref before the remote has the branch, and a failed
  // one keeps its submit, so only a thread with nothing being pushed counts.
  if (thread.submitting !== null) return;
  if (!(await git("rev-parse", "--verify", "--quiet", ref("threads"))).ok) return;
  if (!(await onRemote(db, repository, thread.branch))) {
    await endThread(db, tmux, thread, `its branch ${thread.branch} was deleted`);
    return;
  }
  const base = baseOf(thread);
  await fetchInto(db, repository, ours, base, ref("bases"));
  await fetchInto(db, repository, ours, thread.branch, ref("remote"));
  const merged = await git("merge-tree", "--write-tree", ref("bases"), ref("remote"));
  const tree = await git("rev-parse", `${ref("bases")}^{tree}`);
  if (merged.ok && tree.ok && merged.out.trim().split("\n")[0] === tree.out.trim())
    await endThread(db, tmux, thread, `its branch ${thread.branch} is merged into ${base}`);
}

// Polls one repository: asks each of its tracker and forge what changed since its last
// `next`, kept in `nexts` by plugin, or for everything open without one, and brings skel's
// copy up to date, keeping tasks only from its tracker and PRs only from its forge. Then
// starts threads on its tasks labeled to start, and acts on what each of its threads' PRs
// means for the thread, or, with no forge, on each thread's branch. Thread rows are read again
// once the answers are in, since a round can change them meanwhile.
async function pollRepository(
  db: Database,
  tmux: string,
  repository: Repository,
  threads: Thread[],
  begin: (thread: Thread) => Promise<void>,
  nexts: Map<string, string | null>,
  starting: Set<string>,
): Promise<void> {
  const { owner, repo } = repository;
  const prs = new Map<number, PullRequest>();
  for (const { plugin, jobs } of pluginsOf(db, repository)) {
    const next = nexts.get(plugin) ?? null;
    const watched = jobs.includes("forge")
      ? threads.flatMap((t) => (t.pr === null ? [] : [t.pr]))
      : [];
    const answer = await changed(db, plugin, repository, jobs, next, watched);
    const kinds: Item["kind"][] = [
      ...(jobs.includes("tracker") ? ["task" as const] : []),
      ...(jobs.includes("forge") ? ["pr" as const] : []),
    ];
    const items = answer.items.filter((item) => kinds.includes(item.kind));
    saveItems(db, owner, repo, items, next === null ? kinds : []);
    for (const item of items) if (item.kind === "pr") prs.set(Number(item.id), item);
    nexts.set(plugin, answer.next);
  }
  if (trackerOf(db, repository) !== null) await startLabeled(db, tmux, repository, begin, starting);
  const forged = forgeOf(db, repository) !== null;
  for (const before of threads) {
    if (!forged) await actOnBranch(db, tmux, repository, readThread(db, before.folder));
    else {
      const pr = before.pr === null ? undefined : prs.get(before.pr);
      if (pr) await actOnPr(db, tmux, before, pr);
    }
  }
}

// Polls each repository's tracker and forge for what changed in its tasks and PRs, with the
// PRs of its live and stopped threads, so a stopped thread's merge still ends it: every
// `every` milliseconds while any of its threads is working or waits on review or CI, and half
// as often otherwise, so a label or your comment is seen within a minute. Starts at once, to
// pick up what happened while the daemon was down. A failed poll, such as a forge answering
// with an error, is logged and tried again at the next one. Polls run in the background, so
// they never hold up the daemon. `begin` sets up a thread started from a label and starts its
// builder, as the daemon does for skel start. `starting` holds the tasks skel start is starting
// right now, which no poll starts by their label. Returns a function that polls one repository
// at once, named by its owner/name, for a wake-up or for skel start, and settles once that
// poll is done, failing as it does.
export function pollRepositories(
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
  // Where each repository's next poll starts from, for each of its plugins. The daemon starts
  // with none, so its first poll brings everything open, and what closed while it was down
  // leaves the copy.
  const nexts = new Map<string, Map<string, string | null>>();
  // The threads a poll looks after. A stopped thread's PR or branch still merges or closes.
  const polled = () =>
    db
      .query("SELECT * FROM threads WHERE status IN ('working', 'waiting', 'stopped')")
      .all()
      .map((row) => Thread.parse(row));
  const poll = (owner: string, repo: string): Promise<void> => {
    const fullName = `${owner}/${repo}`;
    skipped.set(fullName, 0);
    const now = running.get(fullName);
    if (now) {
      // A delivery that comes in while its repository is being polled may be about an event
      // the poll's query was too early to see, and skel start must see every change up to its
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
    const repository = repositories(db).find((r) => r.owner === owner && r.repo === repo);
    if (!repository) return Promise.resolve();
    const kept = nexts.get(fullName) ?? new Map<string, string | null>();
    nexts.set(fullName, kept);
    const done = pollRepository(db, tmux, repository, threads, begin, kept, starting)
      .then(
        () => {},
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
    for (const repository of repositories(db)) {
      const { owner, repo } = repository;
      const fullName = `${owner}/${repo}`;
      if (!forgeKnown(db, repository)) continue;
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
