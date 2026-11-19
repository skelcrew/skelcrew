// The queue of tasks under limits.threads: a start over its repository's limit waits there as
// queued, and leaves it, first come first served, once one of the repository's builders ends. It
// is kept in the database, so a restart of the engine keeps each task's place.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { threadLimit } from "../config.ts";
import { errorText } from "../say.ts";
import { statusOnceBack } from "./builder.ts";
import { findRepository } from "./repo.ts";
import { record, Thread, threadName } from "./thread.ts";

// Returns how many of the repository's builders run, its threads at work or waiting, those still
// setting up included, and how many of its tasks wait in the queue.
function counted(db: Database, { owner, repo }: { owner: string; repo: string }) {
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

// Returns what sc start, the lead or the label's note says of a task that joined the queue.
export function queuedText(db: Database, thread: Thread): string {
  const { name } = findRepository(db, `${thread.owner}/${thread.repo}`);
  return `${threadName(db, thread)} is queued: ${name} runs as many builders as its limits.threads allows. It starts once one of them ends.`;
}

// Takes the tasks whose turn has come out of the queue, in the order they joined, as far as each
// repository's limit allows now, and returns their threads. Each leaves the queue working, or a
// stopped one coming back as statusOnceBack says, and the caller starts its builder. Each keeps
// when it joined until its builder's session is saved, so backToQueue can put it back should
// the engine stop before then. It all happens at once, with nothing waited on, so no task leaves
// the queue twice. A thread in `skip`, such as one sc rm is removing, stays in the queue. A
// repository whose limit can't be read keeps its queue until it can, and the daemon's log says
// why once.
export function leaveQueue(db: Database, skip: Set<string>): Thread[] {
  const queued = db
    .query("SELECT * FROM task_threads WHERE status = 'queued' ORDER BY queued_since, rowid")
    .all()
    .map((row) => Thread.parse(row));
  const leaving: Thread[] = [];
  for (const thread of queued) {
    if (skip.has(thread.folder)) continue;
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

// What the daemon's log already said of a queue that can't read its limit.
const told = new Set<string>();
