// Threads: the work on one task, in a clone and branch of its own, with a builder working in
// it. What a thread is, saving a change to it, finding it and naming it.
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { threadsDir } from "./paths.ts";
import { findRepository } from "./repo.ts";

export const Thread = z.object({
  owner: z.string(),
  // The repository's GitHub name, without the owner.
  repo: z.string(),
  task: z.number(),
  folder: z.string(),
  branch: z.string(),
  base: z.string().nullable(),
  status: z.enum(["working", "waiting", "failed", "stopped", "done"]),
  session: z.string().nullable(),
  // Rounds whose review asked for changes, counted against max_rounds.
  rounds: z.number(),
  pr: z.number().nullable(),
  needs_you: z.coerce.boolean(),
  // The summary of a submit not yet pushed and reviewed.
  submitting: z.string().nullable(),
  // The commit whose skel/review check is pending, while its review waits or runs.
  reviewing: z.string().nullable(),
  // A posted review's changes, until they are typed into the builder.
  telling: z.string().nullable(),
  // The changes of a review past the round limit, which aren't typed in, kept for when you
  // let the thread go on with skel start.
  held: z.string().nullable(),
  // The ID of the last review, PR comment and check run handled, so each event is handled
  // once, across restarts too. A new thread starts them at 0. An old row can hold null: the
  // PR's first poll then starts after its history rather than replaying it.
  last_review: z.number().nullable(),
  last_comment: z.number().nullable(),
  last_check: z.number().nullable(),
  // Whether the builder is asking you a question with AskUserQuestion. Kept apart from
  // needs_you, so answering it leaves the thread needing you for any other reason.
  asking: z.coerce.boolean(),
  // Why the thread started needing you, until a note saying so is typed into the lead.
  noting: z.string().nullable(),
  // The task's title when the thread started, for the strip, which looks each second and so
  // can't ask GitHub. An old row can hold null.
  title: z.string().nullable(),
  // When the thread started, in milliseconds since 1970, for its running time in the sidebar.
  // An old row can hold null.
  started: z.number().nullable(),
  // What the PR's CI says, without skel's own review check, as last polled. Null with no CI,
  // or while the commit it would be about is still on its way to GitHub.
  checks: z.enum(["passing", "failing", "pending"]).nullable(),
  // The harness of the review waiting or running, which can differ from the latest finished
  // one's once you change your config.
  reviewer: z.enum(["codex", "claude"]).nullable(),
  // The latest finished review: its round, reviewer, verdict and the first line of what it said.
  // Each one is saved here, so it reaches the thread's log with the rest of the thread.
  reviewed_by: z.enum(["codex", "claude"]).nullable(),
  review_round: z.number().nullable(),
  verdict: z.enum(["approve", "changes", "failed"]).nullable(),
  review_line: z.string().nullable(),
});
export type Thread = z.infer<typeof Thread>;

// Returns whether the thread needs you: for a review, the round limit or an approval, or for
// the builder's question.
export const needsYou = (thread: Thread) => thread.needs_you || thread.asking;

// Returns whether any thread has work under way that the machine must stay awake for: a
// builder working, a review waiting or running, or a PR waiting on CI. A thread that only
// waits on you is no work, and a builder working on your comment past the round limit is.
// A round that failed keeps its submit or review saved, to carry on after a restart, so those
// don't count as work on a thread that needs you.
export const hasWork = (threads: Thread[]) =>
  threads.some(
    (t) => (t.status === "working" && !t.asking) || (t.status === "waiting" && !needsYou(t)),
  );

// Returns the thread's repository as owner/name, as GitHub calls want it.
export const fullNameOf = (thread: Thread) => `${thread.owner}/${thread.repo}`;
// Returns the thread's clone folder. It comes from the folder name chosen at start, so it
// stays put when the repository's name changes.
export const cloneOf = (thread: Thread) => join(threadsDir(), thread.folder);

// Appends the whole thread as it now is, with the reason when there is one, as a line to
// its log. Every change goes there too, so the thread's history can be read and replayed.
export function log(thread: Thread, why?: string): void {
  mkdirSync(threadsDir(), { recursive: true });
  const line = { at: new Date().toISOString(), ...thread, ...(why ? { why } : {}) };
  appendFileSync(join(threadsDir(), `${thread.folder}.log`), `${JSON.stringify(line)}\n`);
}

// Returns the thread in the given folder as it is now in the database.
export const readThread = (db: Database, folder: string) =>
  Thread.parse(db.query("SELECT * FROM threads WHERE folder = ?").get(folder));

// Saves a change to the thread, logs the thread as it now is, and returns it. `why` goes in
// the log, so a failure says what went wrong. When the change makes the thread start needing
// you, `why` is also saved as the note for the lead, on one line; once it no longer needs you,
// a note not yet typed is dropped. The daemon types saved notes with tellLead.
export function record(
  db: Database,
  folder: string,
  change: Partial<
    Omit<Thread, "owner" | "repo" | "task" | "folder" | "branch" | "base" | "title" | "started">
  >,
  why?: string,
): Thread {
  const before = readThread(db, folder);
  let { noting } = change;
  if (!needsYou({ ...before, ...change })) noting = null;
  else if (!needsYou(before)) noting = (why ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  // The column names come from the keys of Thread above, never from outside. One statement,
  // so a change is saved whole or not at all.
  const full = noting === undefined ? change : { ...change, noting };
  const set = Object.entries(full).filter(([, value]) => value !== undefined);
  if (set.length > 0)
    db.run(
      `UPDATE threads SET ${set.map(([column]) => `${column} = ?`).join(", ")} WHERE folder = ?`,
      [...set.map(([, value]) => value), folder],
    );
  const thread = readThread(db, folder);
  log(thread, why);
  return thread;
}

// Returns the thread's name, such as app-12, for replies. It uses the repository's name
// now, which can gain its owner since the thread started, or owner/name once skel no longer
// has the repository.
export function threadName(db: Database, thread: Thread): string {
  const row = db
    .query("SELECT name FROM repositories WHERE owner = ? AND repo = ?")
    .get(thread.owner, thread.repo);
  const name = z.object({ name: z.string() }).nullable().parse(row)?.name ?? fullNameOf(thread);
  return `${name}-${thread.task}`;
}

// Returns the thread named repo-task, such as app-12, or null when the task has none. Throws
// when skel doesn't have the repository.
export function threadOn(db: Database, repository: string, task: number): Thread | null {
  const { owner, repo } = findRepository(db, repository);
  return Thread.nullable().parse(
    db
      .query("SELECT * FROM threads WHERE owner = ? AND repo = ? AND task = ?")
      .get(owner, repo, task),
  );
}

// Returns the thread named repo-task, such as app-12, and throws when there is none.
export function findThread(db: Database, repository: string, task: number): Thread {
  const thread = threadOn(db, repository, task);
  if (!thread) throw new Error(`there is no thread ${repository}-${task}`);
  return thread;
}

// Returns the threads that are working or waiting, whose builders the daemon brings back
// and whose sockets it opens again when it starts.
export function liveThreads(db: Database): Thread[] {
  return db
    .query("SELECT * FROM threads WHERE status IN ('working', 'waiting')")
    .all()
    .map((row) => Thread.parse(row));
}

// Returns the start of a thread's folder name, made from its repository's name. The builder's
// config folder and session are named after it too, so it starts with a letter or digit, as
// they must. tmux changes . and : in a session's name, and / would make a folder. It stays
// short: Claude Code hashes the name of the folder it saves a conversation in once the path
// passes 200 characters, and skel would then miss it when bringing the builder back.
export function folderName(repository: string): string {
  const name = repository
    .replace(/[^\w-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 60);
  return name || "thread";
}
