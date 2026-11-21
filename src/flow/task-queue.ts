// The queue of tasks under limits.threads: a start over its repository's limit waits there as
// queued, and leaves it, first come first served, once one of the repository's builders ends. It
// is kept in the database, so a restart of the engine keeps each task's place.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { threadLimit } from "../config.ts";
import { claimTask } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { unassignIssue } from "./assign.ts";
import { statusOnceBack } from "./builder.ts";
import { removalEnded } from "./events.ts";
import { noteForLead } from "./messages.ts";
import { findRepository } from "./repo.ts";
import { readThread, record, repositoryOf, Thread, threadName } from "./thread.ts";

// Returns how many of the repository's builders run, its threads at work or waiting, those still
// setting up included, and how many of its tasks wait in the queue. The list shows both, such as
// `Building 4/4 · 3 queued`.
export function counted(db: Database, { owner, repo }: { owner: string; repo: string }) {
  const row = db
    .query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('working', 'waiting')) AS running,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued
      FROM threads WHERE owner = ? AND repo = ?`,
    )
    .get(owner, repo);
  return z.object({ running: z.number(), queued: z.number() }).parse(row);
}

// Returns whether a task of the repository starting now waits in the queue: as many of its
// builders run as its limits.threads allows, or tasks already wait there, which go first. Throws
// when the file that sets the limit isn't valid, which refuses the start, so a task never waits
// on a limit nobody can read.
export function joinsQueue(db: Database, repository: { owner: string; repo: string }): boolean {
  const limit = threadLimit(repository);
  if (limit === undefined) return false;
  const { running, queued } = counted(db, repository);
  return queued > 0 || running >= limit;
}

// Returns the time a task joining the queue now joins at, in milliseconds since 1970: now, or
// just after the latest time any task joined, should the clock not have moved on or gone back.
// So two tasks never share a time, and the queue's order is the order they joined.
export function joinTime(db: Database): number {
  const latest = z
    .object({ latest: z.number().nullable() })
    .parse(db.query("SELECT MAX(queued_since) AS latest FROM tasks").get()).latest;
  return Math.max(Date.now(), (latest ?? 0) + 1);
}

// Returns what sc start, the lead or the label's note says of a task that joined the queue.
export function queuedText(db: Database, thread: Thread): string {
  const { name } = findRepository(db, `${thread.owner}/${thread.repo}`);
  return `${threadName(db, thread)} is queued: ${name} runs as many builders as its limits.threads allows. It starts once one of them ends.`;
}

// Moves a queued task one place earlier in its repository's queue, by -1, or one place later, by
// 1, so you choose which task starts next. It swaps when the task and its neighbour joined, as
// the queue's order is that time alone, so no other task moves and a restart keeps the new order.
// Returns what the list says of it, such as `app-13 starts next`. Refuses a task that isn't
// queued, such as one that started meanwhile. One already first or last stays where it is.
export function moveInQueue(db: Database, thread: Thread, by: -1 | 1): string {
  const name = threadName(db, thread);
  if (thread.status !== "queued" || thread.queued_since === null)
    throw new Error(`${name} isn't queued, so it has no place to move`);
  const queue = db
    .query(`SELECT * FROM task_threads WHERE owner = ? AND repo = ? AND status = 'queued'
      ORDER BY queued_since, rowid`)
    .all(thread.owner, thread.repo)
    .map((row) => Thread.parse(row));
  const at = queue.findIndex((queued) => queued.folder === thread.folder);
  const other = queue[at + by];
  // Returns where the task is in line, in words.
  const place = (index: number) =>
    index === 0 ? "starts next" : `is ${ordinal(index + 1)} in line`;
  if (other === undefined || other.queued_since === null) return `${name} ${place(at)}`;
  // Both change in one transaction, so a queue read meanwhile never sees two tasks at one time.
  db.transaction(() => {
    record(db, thread.folder, { queued_since: other.queued_since }, "moved in the queue");
    record(db, other.folder, { queued_since: thread.queued_since }, "moved in the queue");
  })();
  return `${name} ${place(at + by)}`;
}

// Returns a place in line as words, such as 1st, 2nd, 3rd, 4th, 11th or 22nd.
export function ordinal(place: number): string {
  const teen = place % 100 >= 11 && place % 100 <= 13;
  const end = teen ? "th" : (["th", "st", "nd", "rd"][place % 10] ?? "th");
  return `${place}${end}`;
}

// Whether a queued task still owes its claim, as leaveQueue reads it beside the thread.
const Owes = z.object({ owes: z.coerce.boolean() });

// Takes the tasks whose turn has come out of the queue, in the order they joined, as far as each
// repository's limit allows now, and returns their threads. Each leaves the queue working, or a
// stopped one coming back as statusOnceBack says, and the caller starts its builder. Each keeps
// when it joined until its builder's session is saved, so backToQueue can put it back should
// the engine stop before then. It all happens at once, with nothing waited on, so no task leaves
// the queue twice. A thread in `skip`, such as one sc rm is removing, stays in the queue, as does
// one that still owes its claim. Each also holds back every task of its repository that joined
// after it, so the queue stays first come first served, even when sc rm then fails. A repository whose limit can't be read keeps its queue
// until it can, and the daemon's log says why once.
export function leaveQueue(db: Database, skip: (folder: string) => boolean): Thread[] {
  const queued = db
    .query(`SELECT *, EXISTS (SELECT 1 FROM claims c WHERE c.owner = t.owner AND c.repo = t.repo
          AND c.task = CAST(t.task AS TEXT)) AS owes
      FROM task_threads t WHERE status = 'queued' ORDER BY queued_since, rowid`)
    .all()
    .map((row) => ({ thread: Thread.parse(row), ...Owes.parse(row) }));
  // The repositories whose queue waits on a claim, as owner/repo.
  const held = new Set<string>();
  const leaving: Thread[] = [];
  for (const { thread, owes } of queued) {
    const repository = `${thread.owner}/${thread.repo}`;
    if (owes || skip(thread.folder)) held.add(repository);
    if (held.has(repository)) continue;
    let limit: number | undefined;
    try {
      limit = threadLimit(thread);
    } catch (error) {
      const why = `the queue of ${thread.owner}/${thread.repo} waits: ${errorText(error)}`;
      if (!told.has(why)) console.log(why);
      told.add(why);
      continue;
    }
    if (limit !== undefined && counted(db, thread).running >= limit) continue;
    const status = thread.session === null ? "working" : statusOnceBack(thread);
    leaving.push(
      record(db, thread.folder, { status }, "its turn came in the queue of limits.threads"),
    );
  }
  return leaving;
}

// Puts back in the queue each task that left it but whose builder's start the engine's stop cut
// short, before its session was saved. Such a thread can't be brought back, and would otherwise
// fail and leave the queue for good. It goes back in its place, by when it first joined, ahead
// of the tasks that joined after it. For the daemon's start, before it brings back builders.
export function backToQueue(db: Database): void {
  const cut = db
    .query(`SELECT * FROM task_threads WHERE status IN ('working', 'waiting')
      AND session IS NULL AND queued_since IS NOT NULL`)
    .all()
    .map((row) => Thread.parse(row));
  for (const thread of cut)
    record(
      db,
      thread.folder,
      { status: "queued" },
      "back in the queue: the engine stopped as it started",
    );
}

// Makes the claim the queued thread's task still owes, if it owes one, and forgets it once the
// tracker answered. sc start's own ask, as you wait, takes the task whatever the answer, as
// the spec's sc start claims without looking: you decided to start it. A later ask, with
// `retry`, runs with nobody there to decide: the first ask failed, and another machine may have
// claimed the issue meanwhile. So when the tracker says the issue is taken, the task leaves
// the queue, back to its issue, and the lead hears it can sc start it if no other machine works
// on it. An answer that comes while sc rm is removing the task waits for sc rm, and acts only
// if the removal failed. Throws when the tracker fails, and the claim stays owed, to be asked
// again. Asked once at a time per start of the thread: a second call gets the ask under way. A
// task sc rm removed and started again makes a claim of its own, as the answer to the first one
// was for the task removed.
export function claimQueued(
  db: Database,
  sessions: string,
  thread: Thread,
  retry: boolean,
): Promise<void> {
  const key = claimKey(thread);
  const under = claiming.get(key);
  if (under) return under;
  const { owner, repo, task } = thread;
  const where = "WHERE owner = ? AND repo = ? AND task = ?";
  if (db.query(`SELECT 1 FROM claims ${where}`).get(owner, repo, task) === null)
    return Promise.resolve();
  const ask = claimTask(db, repositoryOf(db, thread), task)
    .then(async (took) => {
      // sc rm may have taken it out of the queue while the tracker answered. One still removing
      // it decides first: the task stays queued, and owes its claim, only if that removal fails.
      await removalEnded(thread.folder);
      const now = readThread(db, thread.folder);
      const same = now.started === thread.started;
      const taken = retry && !took && now.status === "queued" && same;
      const name = threadName(db, thread);
      db.transaction(() => {
        // A claim saved since belongs to the task started again, which still owes it.
        if (same) db.run(`DELETE FROM claims ${where}`, [owner, repo, task]);
        if (!taken) return;
        record(
          db,
          thread.folder,
          { status: "done" },
          "its issue was claimed elsewhere while it waited for its claim",
        );
        noteForLead(
          db,
          sessions,
          thread,
          `${name} left the queue: its issue was claimed while Skelcrew couldn't reach the tracker. If no other machine works on it, sc start ${name}.`,
        );
      })();
      if (taken) unassignIssue(db, thread.folder);
    })
    .finally(() => claiming.delete(key));
  claiming.set(key, ask);
  return ask;
}

// The claims being asked for, by the start of the queued thread that owes each, from claimKey.
const claiming = new Map<string, Promise<void>>();

// Names one start of a thread, by its folder and when it started, as a thread sc rm removed and
// started again keeps its folder.
const claimKey = (thread: Thread) => `${thread.folder}@${thread.started}`;

// Returns whether the claim this start of the thread owes is being asked for now, so a claim
// whose answer is still coming isn't taken for one the engine's stop cut short.
export function claimUnderWay(thread: Thread): boolean {
  return claiming.has(claimKey(thread));
}

// Asks again for each claim a queued task still owes, such as one whose ask failed or that a
// restart of the engine cut short, without waiting. A claim that fails again is logged, and
// asked for once more the next time.
export function claimOwed(db: Database, sessions: string): void {
  const owing = db
    .query(`SELECT * FROM task_threads t WHERE status = 'queued' AND EXISTS (SELECT 1 FROM claims c
        WHERE c.owner = t.owner AND c.repo = t.repo AND c.task = CAST(t.task AS TEXT))`)
    .all()
    .map((row) => Thread.parse(row));
  for (const thread of owing)
    claimQueued(db, sessions, thread, true).catch((error) =>
      console.log(
        `couldn't claim ${threadName(db, thread)}'s issue, trying again: ${errorText(error)}`,
      ),
    );
}

// What the daemon's log already said of a queue that can't read its limit.
const told = new Set<string>();
