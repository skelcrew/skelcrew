// What skel shows you about its work: repositories for skel repo ls, threads for skel ps
// and open tasks for skel task ls, as a short table for a terminal or JSON for tools.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { openIssues } from "./github.ts";
import { cloneDir } from "./paths.ts";
import { findRepository, noRepositories, repositories } from "./repo.ts";
import { needsYou, Thread, threadName } from "./thread.ts";

export const RepositoryRow = z.object({ name: z.string(), github: z.string(), clone: z.string() });
export type RepositoryRow = z.infer<typeof RepositoryRow>;

// Returns the repositories skel works on, in name order, with where skel keeps each clone,
// for skel repo ls.
export function listRepositories(db: Database): RepositoryRow[] {
  return repositories(db).map(({ name, owner, repo }) => ({
    name,
    github: `${owner}/${repo}`,
    clone: cloneDir(owner, repo),
  }));
}

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
    return { thread: threadName(db, thread), status: thread.status, needsYou: needsYou(thread) };
  });
}

export const TaskRow = z.object({
  task: z.string(),
  title: z.string(),
  thread: z.object({ status: Thread.shape.status, needsYou: z.boolean() }).nullable(),
});
export type TaskRow = z.infer<typeof TaskRow>;

// Returns the open tasks of every repository, or of one, newest first, with the thread on
// each one that has one, for skel task ls. Tasks aren't kept: GitHub is asked each time.
export async function listTasks(db: Database, repo?: string): Promise<TaskRow[]> {
  const chosen = repo ? [findRepository(db, repo)] : repositories(db);
  const each = await Promise.all(
    chosen.map(async (r) =>
      (await openIssues(`${r.owner}/${r.repo}`)).map((issue) => {
        const row = db
          .query("SELECT * FROM threads WHERE owner = ? AND repo = ? AND task = ?")
          .get(r.owner, r.repo, issue.number);
        const thread = Thread.nullable().parse(row);
        return {
          createdAt: issue.createdAt,
          task: `${r.name}-${issue.number}`,
          title: issue.title,
          thread: thread && { status: thread.status, needsYou: needsYou(thread) },
        };
      }),
    ),
  );
  return each
    .flat()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ createdAt, ...task }) => task);
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

// Prints repositories for skel repo ls, or tells you how to bring in the first one.
export function printRepositories(repositories: RepositoryRow[]): void {
  const name = Math.max(...repositories.map((r) => r.name.length));
  const github = Math.max(...repositories.map((r) => r.github.length));
  if (repositories.length === 0) console.log(noRepositories);
  for (const r of repositories)
    console.log(`${r.name.padEnd(name)}  ${r.github.padEnd(github)}  ${r.clone}`);
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

// Prints open tasks for skel task ls: as JSON for tools, or else as a table whose thread
// column is empty for a task with no thread.
export function printTasks(tasks: TaskRow[], json: boolean): void {
  if (json) console.log(JSON.stringify(tasks));
  else if (tasks.length === 0) console.log("There are no open tasks.");
  else
    table(
      ["TASK", "THREAD", "TITLE"],
      tasks.map(({ task, title, thread }) => {
        const status = thread ? `${thread.status}${thread.needsYou ? ", needs you" : ""}` : "";
        return [task, status, title];
      }),
    );
}
