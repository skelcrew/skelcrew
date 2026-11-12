// What Skelcrew shows you about its work: repositories for sc repo ls, threads for sc ps,
// open tasks for sc issue ls and one task for sc issue show, as short text for a terminal
// or JSON for tools.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { repositoryTracker } from "../config.ts";
import { cloneDir } from "../paths.ts";
import { forgeOf, trackerOf } from "../plugins/ask.ts";
import { openTasks, taskOf } from "./copy.ts";
import { findRepository, noRepositories, repositories } from "./repo.ts";
import { needsYou, Thread, threadName } from "./thread.ts";

// A repository as sc repo ls shows it. `missing` is a tracker its skelcrew.yaml names that
// isn't installed, so it has none until you install that plugin.
export const RepositoryRow = z.object({
  name: z.string(),
  repository: z.string(),
  tracker: z.string().nullable(),
  forge: z.string().nullable(),
  missing: z.string().nullable(),
  clone: z.string(),
});
export type RepositoryRow = z.infer<typeof RepositoryRow>;

// Returns the repositories Skelcrew works on, in name order, with each one's tracker and forge
// and where Skelcrew keeps its clone, for sc repo ls.
export function listRepositories(db: Database): RepositoryRow[] {
  return repositories(db).map((r) => {
    const tracker = trackerOf(db, r);
    // The tracker skelcrew.yaml names, to say which plugin is missing. A skelcrew.yaml that
    // can't be read names none here, so one bad repository doesn't stop the whole list, and
    // tracker: none misses nothing.
    let named: string | null = null;
    try {
      named = repositoryTracker(r) ?? null;
    } catch {}
    if (named === "none") named = null;
    return {
      name: r.name,
      repository: `${r.owner}/${r.repo}`,
      tracker,
      forge: forgeOf(db, r),
      missing: tracker === null ? named : null,
      clone: cloneDir(r.owner, r.repo),
    };
  });
}

// A thread as sc ps shows it.
export const ThreadRow = z.object({
  thread: z.string(),
  status: Thread.shape.status,
  needsYou: z.boolean(),
});
export type ThreadRow = z.infer<typeof ThreadRow>;

// Returns the threads, or one repository's, newest first, for sc ps. A thread that starts
// over gets a new row, so it counts as started when it last started.
export function listThreads(db: Database, repository?: string): ThreadRow[] {
  const one = repository ? findRepository(db, repository) : null;
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

// An open task as sc issue ls shows it, with how its thread stands, or null with no thread.
export const TaskRow = z.object({
  task: z.string(),
  title: z.string(),
  thread: z.object({ status: Thread.shape.status, needsYou: z.boolean() }).nullable(),
});
export type TaskRow = z.infer<typeof TaskRow>;

// Returns how the thread on a task stands, or null when it has none.
function threadStatusOf(
  db: Database,
  owner: string,
  repo: string,
  task: string,
): TaskRow["thread"] {
  const row = db
    .query("SELECT * FROM threads WHERE owner = ? AND repo = ? AND task = ?")
    .get(owner, repo, task);
  const thread = Thread.nullable().parse(row);
  return thread && { status: thread.status, needsYou: needsYou(thread) };
}

// Returns the open tasks of every repository, or of one, newest first, with the thread on
// each one that has one, for sc issue ls. They come from Skelcrew's copy, so the tracker isn't
// asked.
export function listTasks(db: Database, repository?: string): TaskRow[] {
  const chosen = repository ? [findRepository(db, repository)] : repositories(db);
  // Each repository's tasks come newest first, but mixing repositories needs a sort of its own,
  // so each row keeps its creation time until the sort is done.
  return chosen
    .flatMap((r) =>
      openTasks(db, r.owner, r.repo).map((task) => ({
        created: task.created,
        task: `${r.name}-${task.id}`,
        title: task.title,
        thread: threadStatusOf(db, r.owner, r.repo, task.id),
      })),
    )
    .sort((a, b) => b.created.localeCompare(a.created))
    .map(({ created, ...task }) => task);
}

// One task as sc issue show shows it.
export const TaskView = z.object({
  task: z.string(),
  title: z.string(),
  body: z.string(),
  thread: TaskRow.shape.thread,
});
export type TaskView = z.infer<typeof TaskView>;

// Returns one task's title and body, which is all its builder sees, with the thread on it if
// it has one, for sc issue show. It comes from Skelcrew's copy, so the tracker isn't asked.
export function showTask(db: Database, repository: string, task: string): TaskView {
  const r = findRepository(db, repository);
  const { title, body } = taskOf(db, r.owner, r.repo, task);
  return {
    task: `${r.name}-${task}`,
    title,
    body,
    thread: threadStatusOf(db, r.owner, r.repo, task),
  };
}

// Prints rows as columns lined up under their headings, with no spaces left at line ends.
function table(heading: string[], rows: string[][]): void {
  // Each column is as wide as its widest cell.
  const widths = heading.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  for (const row of [heading, ...rows])
    console.log(
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    );
}

// Prints repositories for sc repo ls: as JSON for tools, or else as a table, with the
// plugin to install for a tracker a repository's skelcrew.yaml names that isn't installed, or
// how to bring in the first one.
export function printRepositories(repositories: RepositoryRow[], json: boolean): void {
  if (json) console.log(JSON.stringify(repositories));
  else if (repositories.length === 0) console.log(noRepositories);
  else
    table(
      ["NAME", "REPOSITORY", "TRACKER", "FORGE", "CLONE"],
      repositories.map((r) => [
        r.name,
        r.repository,
        r.tracker ?? (r.missing ? `${r.missing}, not installed` : "none"),
        r.forge ?? "none",
        r.clone,
      ]),
    );
}

// Prints threads for sc ps: as JSON for tools, or else as a table.
export function printThreads(threads: ThreadRow[], json: boolean): void {
  if (json) console.log(JSON.stringify(threads));
  else if (threads.length === 0) console.log("There are no threads.");
  else
    table(
      ["THREAD", "STATUS", "NEEDS YOU"],
      threads.map((t) => [t.thread, t.status, t.needsYou ? "yes" : ""]),
    );
}

// Prints open tasks for sc issue ls: as JSON for tools, or else as a table whose thread
// column is empty for a task with no thread.
export function printTasks(tasks: TaskRow[], json: boolean): void {
  if (json) console.log(JSON.stringify(tasks));
  else if (tasks.length === 0) console.log("There are no open issues.");
  else
    table(
      ["ISSUE", "THREAD", "TITLE"],
      tasks.map(({ task, title, thread }) => {
        const status = thread ? `${thread.status}${thread.needsYou ? ", needs you" : ""}` : "";
        return [task, status, title];
      }),
    );
}

// Prints one task for sc issue show: as JSON for tools, or else its name and title, the
// thread on it if it has one, and its body after a blank line.
export function printTask(task: TaskView, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(task));
    return;
  }
  console.log(`${task.task}  ${task.title}`);
  if (task.thread)
    console.log(`Thread: ${task.thread.status}${task.thread.needsYou ? ", needs you" : ""}`);
  if (task.body) console.log(`\n${task.body.trimEnd()}`);
}
