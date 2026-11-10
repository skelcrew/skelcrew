// What Skelcrew shows you about its work: repositories for sc repo ls, threads for sc ps,
// open tasks for sc task ls and one task for sc task show, as short text for a terminal
// or JSON for tools.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { cloneDir } from "../paths.ts";
import { openTasks, taskOf } from "./copy.ts";
import { findRepository, noRepositories, repositories } from "./repo.ts";
import { needsYou, Thread, threadName } from "./thread.ts";

export const RepositoryRow = z.object({ name: z.string(), github: z.string(), clone: z.string() });
export type RepositoryRow = z.infer<typeof RepositoryRow>;

// Returns the repositories Skelcrew works on, in name order, with where Skelcrew keeps each clone,
// for sc repo ls.
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

export const TaskRow = z.object({
  task: z.string(),
  title: z.string(),
  thread: z.object({ status: Thread.shape.status, needsYou: z.boolean() }).nullable(),
});
export type TaskRow = z.infer<typeof TaskRow>;

// Returns how the thread on a task stands, or null when it has none.
function threadOf(db: Database, owner: string, repo: string, task: number): TaskRow["thread"] {
  const row = db
    .query("SELECT * FROM threads WHERE owner = ? AND repo = ? AND task = ?")
    .get(owner, repo, task);
  const thread = Thread.nullable().parse(row);
  return thread && { status: thread.status, needsYou: needsYou(thread) };
}

// Returns the open tasks of every repository, or of one, newest first, with the thread on
// each one that has one, for sc task ls. They come from Skelcrew's copy, so GitHub isn't asked.
export function listTasks(db: Database, repository?: string): TaskRow[] {
  const chosen = repository ? [findRepository(db, repository)] : repositories(db);
  return chosen
    .flatMap((r) =>
      openTasks(db, r.owner, r.repo).map((task) => ({
        created: task.created,
        task: `${r.name}-${task.id}`,
        title: task.title,
        thread: threadOf(db, r.owner, r.repo, Number(task.id)),
      })),
    )
    .sort((a, b) => b.created.localeCompare(a.created))
    .map(({ created, ...task }) => task);
}

export const TaskView = z.object({
  task: z.string(),
  title: z.string(),
  body: z.string(),
  thread: TaskRow.shape.thread,
});
export type TaskView = z.infer<typeof TaskView>;

// Returns one task's title and body, which is all its builder sees, with the thread on it if
// it has one, for sc task show. It comes from Skelcrew's copy, so GitHub isn't asked.
export function showTask(db: Database, repository: string, task: number): TaskView {
  const r = findRepository(db, repository);
  const { title, body } = taskOf(db, r.owner, r.repo, task);
  return { task: `${r.name}-${task}`, title, body, thread: threadOf(db, r.owner, r.repo, task) };
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

// Prints repositories for sc repo ls: as JSON for tools, or else one line each, or how to
// bring in the first one.
export function printRepositories(repositories: RepositoryRow[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(repositories));
    return;
  }
  const name = Math.max(...repositories.map((r) => r.name.length));
  const github = Math.max(...repositories.map((r) => r.github.length));
  if (repositories.length === 0) console.log(noRepositories);
  for (const r of repositories)
    console.log(`${r.name.padEnd(name)}  ${r.github.padEnd(github)}  ${r.clone}`);
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

// Prints open tasks for sc task ls: as JSON for tools, or else as a table whose thread
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

// Prints one task for sc task show: as JSON for tools, or else its name and title, the
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
