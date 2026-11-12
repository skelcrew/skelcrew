// Polling: the daemon asks each repository's tracker and forge what changed, brings Skelcrew's
// copy of its tasks and PRs up to date, starts threads on tasks labeled to start, and hands what
// each thread's PR means for it to the code that acts on it. In a repository with no forge, it
// ends a thread once its branch is merged or gone.
import type { Database } from "bun:sqlite";
import { threadConfig } from "../config.ts";
import type { Repository } from "../db.ts";
import { cloneDir } from "../paths.ts";
import {
  askWhatChanged,
  claimTask,
  forgeOf,
  repositoryPlugins,
  trackerOf,
} from "../plugins/ask.ts";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { baseOf, startThread } from "./builder.ts";
import { type Item, openTasks, prOf, saveItems } from "./copy.ts";
import { ciState, decide, labeledToStart, type PullRequest } from "./decide.ts";
import { endThread, tellBuilder, typingEvents } from "./events.ts";
import { fetchInto, onRemote } from "./git.ts";
import { noteForLead, typeLeadNotes } from "./lead.ts";
import { forgeKnown, fullNameIs, repositories } from "./repo.ts";
import { needsYou, readThread, record, Thread, threadName } from "./thread.ts";

// The label that starts a thread on a task, added in its tracker by someone who may.
const startLabel = "skelcrew";

// Starts a thread on each of the repository's open tasks labeled to start in Skelcrew's copy that
// has none, exactly as sc start does, once Skelcrew has claimed it in the tracker, and tells the
// repository's lead. The claim comes first so that when two machines run Skelcrew on one
// repository, such as a laptop and a Sprite, only one starts the task. Thread rows are read
// after the tracker answers, so a thread sc start made meanwhile counts. A task in `starting`,
// named as owner/repo#task, is left to the sc start starting it, which has options of its own,
// such as the branch to start from. A task in `passed`, named the same way, is one this daemon
// won't start by its label: another machine claimed it, or its claim was this daemon's but the
// thread failed to start. Kept in memory, so the tracker isn't asked about it on every poll.
async function startLabeled(
  db: Database,
  tmux: string,
  repository: Repository,
  setUpAndStart: (thread: Thread) => Promise<void>,
  starting: Set<string>,
  passed: Set<string>,
): Promise<void> {
  const { owner, repo } = repository;
  const fullName = `${owner}/${repo}`;
  // Every thread the repository ever had counts, ended ones too, so the tasks to start are
  // those labeled with no thread at all, and not being started by sc start.
  const threads = db
    .query("SELECT * FROM threads WHERE owner = ? AND repo = ?")
    .all(owner, repo)
    .map((row) => Thread.parse(row));
  const labeled = openTasks(db, owner, repo).filter((task) => {
    const key = `${fullName}#${task.id}`;
    return task.labels.includes(startLabel) && !starting.has(key) && !passed.has(key);
  });
  for (const task of labeledToStart(threads, labeled)) {
    const key = `${fullName}#${task.id}`;
    // A claim that fails, such as on a network error, starts nothing and is tried again on the
    // next poll, so a task is never started without its claim.
    const claimed = await claimTask(db, repository, task.id).catch((error) => {
      console.log(`couldn't claim ${task.id} in ${fullName}, trying again: ${errorText(error)}`);
      return null;
    });
    if (claimed === null) continue;
    if (!claimed) {
      console.log(`not starting ${task.id} in ${fullName}: it was already claimed elsewhere`);
      passed.add(key);
      continue;
    }
    // An sc start that came in while the tracker answered starts the task itself, with its own
    // options, such as the branch to start from, so the poll leaves it be.
    if (starting.has(key)) continue;
    // The claim is this daemon's now, so a thread that fails to start isn't started by a
    // later poll either: on another machine, or after a restart, its claim reads as taken.
    // One sc start finished meanwhile also lands here, harmlessly.
    const thread = await startThread(db, { repo: fullName, task: task.id }).catch((error) => {
      console.log(
        `couldn't start ${task.id} in ${fullName}, and its label won't start it again; sc start does: ${errorText(error)}`,
      );
      passed.add(key);
      return null;
    });
    if (thread === null) continue;
    // The lead hears first, then the builder starts. The note is one line, as every note to
    // the lead is.
    const note = `started ${threadName(db, thread)} from ${trackerOf(db, repository)}: ${task.title}`;
    noteForLead(db, tmux, { owner, repo }, note.replace(/\s+/g, " ").slice(0, 200));
    // Not waited on, as for sc start: setup can take minutes.
    setUpAndStart(thread);
  }
}

// Acts on what the thread's PR, as its forge just returned it, means for the thread. `before`
// is the thread as it was when the poll began: a round that moved on while the forge answered
// may have pushed a newer commit, and what the forge said about the checks would be the older
// one's, so the next poll acts on it instead.
async function actOnPr(db: Database, tmux: string, before: Thread, pr: PullRequest): Promise<void> {
  // Act on the thread as it is now, since it may have ended or moved on while the forge
  // answered. One already done or failed has nothing left to act on.
  const { folder } = before;
  const thread = readThread(db, folder);
  if (!["working", "waiting", "stopped"].includes(thread.status)) return;
  // Read only for a thread with a PR, so a bad max_rounds never fails the copy's update, nor
  // sc start, which polls first.
  const { maxRounds } = threadConfig(thread);
  // The decision is pure; what follows carries it out. The poll is stale when a round
  // changed the thread since it began.
  const decision = decide(thread, pr, { maxRounds });
  const stale =
    thread.submitting !== before.submitting ||
    thread.reviewing !== before.reviewing ||
    thread.rounds !== before.rounds;
  // Saved ahead of what the decision does, so a thread never needs you for an approval while
  // its saved checks still say otherwise. A commit on its way has no checks to speak of yet.
  const checks = ciState(pr);
  if (!stale && thread.submitting === null && checks !== thread.checks)
    record(db, folder, { checks });
  // A merge or close ends the thread whatever else is going on. Otherwise new events go to
  // the builder, and with none, only what is seen and what changed is saved.
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
      typeLeadNotes(db, tmux);
    }
  }
}

// Ends a thread of a repository with no forge once its branch is done with: when merging it
// into its base would change nothing, which a merge, a squash and a rebase all leave, or when
// it is gone from the remote. Only a branch Skelcrew has pushed counts, as before that it isn't on
// the remote at all.
async function actOnBranch(db: Database, tmux: string, repository: Repository, thread: Thread) {
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const ref = (kind: string) => `refs/skelcrew/${kind}/${thread.folder}`;
  const git = (...args: string[]) => quietly(["git", "-C", skelcrewClone, ...args]);
  // A push under way has saved its local ref before the remote has the branch, and a failed
  // one keeps its submit, so only a thread with nothing being pushed counts.
  if (thread.submitting !== null) return;
  if (!(await git("rev-parse", "--verify", "--quiet", ref("threads"))).ok) return;
  // Asking git takes a while, and sc rm may meanwhile have deleted the branch and ended the
  // thread, or the thread started over. Only the thread as it was is ended.
  const unchanged = () => {
    const now = readThread(db, thread.folder);
    return now.status === thread.status && now.started === thread.started;
  };
  if (!(await onRemote(db, repository, thread.branch))) {
    if (unchanged()) await endThread(db, tmux, thread, `its branch ${thread.branch} was deleted`);
    return;
  }
  // Merge the remote branch into its base without touching any files, and compare the result
  // with the base. The same tree means the base already has everything on the branch.
  const base = baseOf(thread);
  await fetchInto(db, repository, skelcrewClone, base, ref("bases"));
  await fetchInto(db, repository, skelcrewClone, thread.branch, ref("remote"));
  const merged = await git("merge-tree", "--write-tree", ref("bases"), ref("remote"));
  const tree = await git("rev-parse", `${ref("bases")}^{tree}`);
  if (merged.ok && tree.ok && merged.out.trim().split("\n")[0] === tree.out.trim() && unchanged())
    await endThread(db, tmux, thread, `its branch ${thread.branch} is merged into ${base}`);
}

// Polls one repository. Asks its tracker and its forge what changed since the `next` each
// plugin last gave, kept in `nexts`, or for everything open when there is none. Brings
// Skelcrew's copy up to date, taking tasks only from its tracker and PRs only from its forge.
// Then starts threads on its tasks labeled to start. Then acts on what each thread's PR means
// for it, or, with no forge, on each thread's branch. Thread rows are read again once the
// answers are in, since a round can change them meanwhile.
async function pollRepository(
  db: Database,
  tmux: string,
  repository: Repository,
  threads: Thread[],
  setUpAndStart: (thread: Thread) => Promise<void>,
  nexts: Map<string, string | null>,
  starting: Set<string>,
  passed: Set<string>,
): Promise<void> {
  const { owner, repo } = repository;
  // Ask each plugin in turn, telling a forge which PRs Skelcrew watches: those of this
  // repository's threads. A plugin's answer only updates the kinds its jobs cover. A first
  // poll, with no `next`, replaces those kinds in the copy outright, so what closed while the
  // daemon was down goes.
  for (const { plugin, jobs } of repositoryPlugins(db, repository)) {
    const next = nexts.get(plugin) ?? null;
    const watched = jobs.includes("forge")
      ? threads.flatMap((t) => (t.pr === null ? [] : [t.pr]))
      : [];
    const answer = await askWhatChanged(db, plugin, repository, jobs, next, watched);
    const kinds: Item["kind"][] = [
      ...(jobs.includes("tracker") ? ["task" as const] : []),
      ...(jobs.includes("forge") ? ["pr" as const] : []),
    ];
    const items = answer.items.filter((item) => kinds.includes(item.kind));
    saveItems(db, owner, repo, items, next === null ? kinds : []);
    nexts.set(plugin, answer.next);
  }
  // With the copy up to date, start labeled tasks, then act on each thread: by its PR with a
  // forge, or by its branch without one.
  if (trackerOf(db, repository) !== null)
    await startLabeled(db, tmux, repository, setUpAndStart, starting, passed);
  const hasForge = forgeOf(db, repository) !== null;
  for (const before of threads) {
    if (!hasForge) await actOnBranch(db, tmux, repository, readThread(db, before.folder));
    else {
      // From the copy, just brought up to date, rather than from the answer: a forge answers
      // only what changed, and events held back for a thread, such as one stopped, were left
      // out of its `seen`, so its PR is acted on again until they are handed over.
      const pr = before.pr === null ? null : prOf(db, owner, repo, before.pr);
      if (pr) await actOnPr(db, tmux, before, pr);
    }
  }
}

// Polls each repository's tracker and forge for what changed in its tasks and PRs. The PRs of
// stopped threads are polled too, so a stopped thread's merge still ends it. A repository is
// polled every `every` milliseconds while one of its threads is working or waits on review or
// CI, and half as often otherwise, so a label or your comment is seen within a minute. The
// first poll runs at once, to pick up what happened while the daemon was down. A failed poll,
// such as a forge answering with an error, is logged and tried again at the next one. Polls
// run in the background, so they never hold up the daemon. `setUpAndStart` sets up a thread
// started from a label and starts its builder, as the daemon does for sc start. `starting`
// holds the tasks sc start is starting right now, which no poll starts by their label.
// Returns a function that polls one repository at once, named by its owner/name, for a
// wake-up or for sc start. It settles once that poll is done, and fails if the poll fails.
export function pollRepositories(
  db: Database,
  tmux: string,
  every: number,
  setUpAndStart: (thread: Thread) => Promise<void>,
  starting: Set<string>,
): (fullName: string) => Promise<void> {
  // How many ticks in a row each repository has gone without a poll, by owner/name.
  const ticksSkipped = new Map<string, number>();
  // The labeled tasks this daemon won't start by their label, kept for its lifetime.
  const passed = new Set<string>();
  // The poll under way for each repository, and the one that follows it.
  const running = new Map<string, Promise<void>>();
  const following = new Map<string, Promise<void>>();
  // Where each repository's next poll starts from, for each of its plugins. The daemon starts
  // with none, so its first poll brings everything open, and what closed while it was down
  // leaves the copy.
  const nexts = new Map<string, Map<string, string | null>>();
  // The threads a poll looks after. A stopped thread's PR or branch still merges or closes.
  const threadsToPoll = () =>
    db
      .query("SELECT * FROM threads WHERE status IN ('working', 'waiting', 'stopped')")
      .all()
      .map((row) => Thread.parse(row));
  const poll = (owner: string, repo: string): Promise<void> => {
    const fullName = `${owner}/${repo}`;
    ticksSkipped.set(fullName, 0);
    const underWay = running.get(fullName);
    if (underWay) {
      // A delivery that comes in while its repository is being polled may be about an event
      // the poll's query was too early to see, and sc start must see every change up to its
      // asking, so one more poll follows. Everyone who asks meanwhile shares it.
      const next =
        following.get(fullName) ??
        underWay
          .catch(() => {})
          .then(() => {
            following.delete(fullName);
            return poll(owner, repo);
          });
      following.set(fullName, next);
      return next;
    }
    // No poll is under way, so start one, and keep it as running until it settles. A
    // repository removed meanwhile has nothing to poll.
    const threads = threadsToPoll().filter((t) => t.owner === owner && t.repo === repo);
    const repository = repositories(db).find((r) => r.owner === owner && r.repo === repo);
    if (!repository) return Promise.resolve();
    const pluginNexts = nexts.get(fullName) ?? new Map<string, string | null>();
    nexts.set(fullName, pluginNexts);
    const done = pollRepository(
      db,
      tmux,
      repository,
      threads,
      setUpAndStart,
      pluginNexts,
      starting,
      passed,
    )
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
  // Each tick polls a repository with work under way, and one without every other tick. A
  // repository whose forge isn't known yet waits, and one still being polled is skipped.
  const tick = () => {
    const live = threadsToPoll();
    for (const repository of repositories(db)) {
      const { owner, repo } = repository;
      const fullName = `${owner}/${repo}`;
      if (!forgeKnown(db, repository)) continue;
      const threads = live.filter((t) => t.owner === owner && t.repo === repo);
      const active = threads.some(
        (t) => t.status === "working" || (t.status === "waiting" && !needsYou(t)),
      );
      const waited = ticksSkipped.get(fullName) ?? Number.POSITIVE_INFINITY;
      if (running.has(fullName) || (!active && waited < 1)) {
        ticksSkipped.set(fullName, waited + 1);
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
