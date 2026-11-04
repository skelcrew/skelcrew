// What skel shows you about its work: threads for skel ps, as a short table for a terminal
// or JSON for tools.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { findRepository } from "./repo.ts";
import { Thread, threadName } from "./thread.ts";

export const ThreadRow = z.object({
  thread: z.string(),
  status: Thread.shape.status,
  needsYou: z.boolean(),
});
export type ThreadRow = z.infer<typeof ThreadRow>;

// Returns the threads, or one repository's, newest first, for skel ps. A thread that starts
// over gets a new row, so it counts as started when it last started.
export function listThreads(db: Database, repo?: string): ThreadRow[] {
  const one = repo ? findRepository(db, repo) : null;
  const all = one
    ? db
        .query("SELECT * FROM threads WHERE owner = ? AND repo = ? ORDER BY rowid DESC")
        .all(one.owner, one.repo)
    : db.query("SELECT * FROM threads ORDER BY rowid DESC").all();
  return all.map((row) => {
    const thread = Thread.parse(row);
    return { thread: threadName(db, thread), status: thread.status, needsYou: thread.needs_you };
  });
}

// Prints rows as columns lined up under their headings, with no spaces left at line ends.
function table(heading: string[], rows: string[][]): void {
  const widths = heading.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  for (const row of [heading, ...rows])
    console.log(
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    );
}

// Prints threads for skel ps: as JSON for tools, or else as a table.
export function printThreads(threads: ThreadRow[], json: boolean): void {
  if (json) console.log(JSON.stringify(threads));
  else if (threads.length === 0) console.log("There are no threads.");
  else
    table(
      ["THREAD", "STATUS", "NEEDS YOU"],
      threads.map((t) => [t.thread, t.status, t.needsYou ? "yes" : ""]),
    );
}
