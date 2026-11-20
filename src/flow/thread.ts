// Threads: the work on one task, in a clone and branch of its own, with a builder working in
// it. What a thread is, saving a change to it, finding it and naming it.
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HarnessName, harnessNamed } from "../agents/harness.ts";
import { listSessions, renameSession } from "../agents/sessions.ts";
import { savedJson, taskColumns } from "../db.ts";
import { threadsDir } from "../paths.ts";
import { type Host, hostNamed, pluginHost } from "../plugins/runtime.ts";
import { errorText } from "../say.ts";
import { threadTask } from "./copy.ts";
import { findRepository } from "./repo.ts";
import { needsYou, reportStatus } from "./status.ts";

// What an agent is doing: working on a turn, idle at its prompt, asking you a question with its
// harness's question tool, or stopped on an error its harness reported.
export const AgentState = z.enum(["working", "idle", "asking", "error"]);
export type AgentState = z.infer<typeof AgentState>;

// One message the lead told a thread's builder: who sent it, when it was typed in, in
// milliseconds since 1970, and its text.
const TaskUpdate = z.object({ from: z.literal("lead"), at: z.number(), text: z.string() });

// Skelcrew's review on a PR: the PR, the review's ID on the forge, and the verdict and findings it
// last said, so each round edits that one review, or posts again only when what it says changed.
const ReviewPost = z.object({
  pr: z.number(),
  id: z.string(),
  verdict: z.enum(["approve", "changes"]),
  findings: z.array(z.string()),
});
export type ReviewPost = z.infer<typeof ReviewPost>;

// A thread with its task, as Skelcrew's database keeps them, one row per thread from the
// task_threads view. The task's fields are those openDb's taskColumns name, and they are saved on
// the task. It is checked on every read, since the row comes back from disk. Its folder names it
// inside Skelcrew: its clone, session and log are all named after it.
export const Thread = z.object({
  owner: z.string(),
  // The repository's name on its forge, or its remote's path, without the owner.
  repo: z.string(),
  // The task's ID in its tracker, such as 12, or, with no task there, Skelcrew's own, such as wr1.
  task: z.coerce.string(),
  folder: z.string(),
  branch: z.string(),
  base: z.string().nullable(),
  // Queued while it waits in the queue of limits.threads for its builder to start, or for a
  // stopped one to come back.
  status: z.enum(["queued", "working", "waiting", "failed", "stopped", "done"]),
  session: z.string().nullable(),
  // Rounds whose review asked for changes, counted against max_rounds.
  rounds: z.number(),
  pr: z.number().nullable(),
  needs_you: z.coerce.boolean(),
  // The summary of a submit not yet pushed and reviewed.
  submitting: z.string().nullable(),
  // The commit whose review check is pending, while its review waits or runs.
  reviewing: z.string().nullable(),
  // When that review joined the queue of reviews, in milliseconds since 1970, while it waits
  // there for a place. Null once it runs, and with no review. A review the daemon's stop cut
  // short while it ran is put back first, with 0. Only means something while `reviewing` does.
  queued: z.number().nullable(),
  // A posted review's changes, until they are typed into the builder.
  telling: z.string().nullable(),
  // The changes of a review past the round limit, which aren't typed in, kept for when you
  // let the thread go on with sc start.
  held: z.string().nullable(),
  // The IDs of the reviews, PR comments and check runs handled, among those its PR shows, so
  // each event is handled once, across restarts too. A new thread starts with none. A row from
  // before Skelcrew kept them has the last ID of each kind handled instead, or, older still, null
  // for those too: the PR's first poll then starts after its history rather than replaying it.
  // A value Skelcrew can't read counts as null too, so a bad one never replays the PR's events.
  seen: savedJson("tasks.seen", z.array(z.string()).nullable(), null),
  last_review: z.number().nullable(),
  last_comment: z.number().nullable(),
  last_check: z.number().nullable(),
  // Whether the builder is asking you a question with AskUserQuestion. Kept apart from
  // needs_you, so answering it leaves the thread needing you for any other reason.
  asking: z.coerce.boolean(),
  // Whether the builder ended its turn without sc submit, a question or an error, and so sits
  // waiting on you. Kept apart from asking: no question is open, so the lead may still tell it.
  turn_ended: z.coerce.boolean(),
  // Whether the builder ran sc submit in its current turn, so the turn's end waits on a review
  // rather than on you. Whatever is typed into the builder starts a new turn, and clears it.
  submitted: z.coerce.boolean(),
  // Whether the builder ran sc tell lead in its current turn, so the lead already has its words
  // and the turn's end forwards nothing more. Whatever is typed into the builder clears it.
  told_lead: z.coerce.boolean(),
  // Whether the builder's harness stopped on an error it can't get past alone, such as a lapsed
  // login. The builder then sits idle, so the thread needs you until you type to it.
  erred: z.coerce.boolean(),
  // Whether the builder's harness stopped on its usage limit, which also sets erred. It is woken
  // once the limit resets, so it doesn't need you. `limit_reset` is when, in milliseconds since
  // 1970, or null when the harness didn't say.
  limited: z.coerce.boolean(),
  limit_reset: z.number().nullable(),
  // The same for the thread's review, held until its harness's usage limit resets. Kept apart
  // from the builder's, so the review starting never ends the builder's wait, and typing to the
  // builder never ends the review's.
  review_limited: z.coerce.boolean(),
  review_reset: z.number().nullable(),
  // Why the thread started needing you, until a note saying so is typed into the lead.
  noting: z.string().nullable(),
  // The task's title and body when the thread started, for the strip, which looks each second
  // and so can't ask the tracker, and for a task that has left Skelcrew's copy. With no task in
  // the tracker, they are the task itself. An old row can hold null.
  title: z.string().nullable(),
  body: z.string().nullable(),
  // When the thread started, in milliseconds since 1970, for its running time in the sidebar.
  // An old row can hold null.
  started: z.number().nullable(),
  // What the PR's CI says, without Skelcrew's own check, as last polled. Null with no CI, or
  // while the commit it would be about is still on its way to the forge.
  checks: z.enum(["passing", "failing", "pending"]).nullable(),
  // The base branch the PR conflicts with, as Skelcrew last found, so an approval isn't ready to
  // merge until the builder's next round, whatever else makes the thread need you meanwhile.
  // Null when it doesn't, or once a new round starts, as the conflict is found again if still
  // there. Null in a row from before Skelcrew kept it.
  conflicts: z.string().nullable(),
  // Whether the latest poll found every check on the PR passed, Skelcrew's own approval
  // included. Each poll saves it again, and a new round clears it. Its saved checks can't say
  // so alone: they are also empty while the forge hasn't been asked yet, so an approval that
  // needs you for another reason would read as ready to merge before CI ran. False in a row
  // from before Skelcrew kept it, until the next poll.
  ci_passed: z.coerce.boolean(),
  // Whether a poll ever found CI checks on the PR, besides Skelcrew's own. It never goes back,
  // unlike its saved checks, which go back to none when the forge's checks vanish, so the list
  // can tell a repository with no CI from CI that went missing. False in a row from before
  // Skelcrew kept it, until a poll finds checks.
  ci_seen: z.coerce.boolean(),
  // The harness of the review waiting or running, which can differ from the latest finished
  // one's once you change your config.
  reviewer: HarnessName.nullable(),
  // The latest finished review: its round, reviewer, verdict and the first line of what it said.
  // Each one is saved here, so it reaches the thread's log with the rest of the thread. A task
  // whose flow has no review stage gets "not reviewed" as each submit starts, with no round or
  // reviewer, and goes on to CI as an approval does.
  reviewed_by: HarnessName.nullable(),
  review_round: z.number().nullable(),
  verdict: z.enum(["approve", "changes", "failed", "timed out", "not reviewed"]).nullable(),
  review_line: z.string().nullable(),
  // The commit the latest finished review was about, or the one submitted without a review, so
  // the list knows which commit an approval stands for without asking git. Null before the
  // first, and in a row from before Skelcrew kept it.
  reviewed_commit: z.string().nullable(),
  // When the latest review was asked for, by sc submit or sc review, or ended, in milliseconds
  // since 1970, for sc ps. Null before the first, and in a row from before Skelcrew kept it.
  review_at: z.number().nullable(),
  // The harness its builder runs on, saved when the builder first starts, since a conversation
  // can't move to another harness. Null before then, and in a row from before Skelcrew saved it,
  // when every builder ran on Claude Code.
  harness: HarnessName.nullable(),
  // Two or three words the lead gave the thread, such as "Login redirect", which the sidebar's
  // row shows in place of its title. Only for that row: the builder never sees it. Null until
  // the lead gives one, and in a row from before Skelcrew kept them.
  short: z.string().nullable(),
  // Whether Skelcrew assigned you the thread's issue, rather than you being assigned already, so
  // it takes you off only an issue it put you on.
  assigned: z.coerce.boolean(),
  // When anything last went in the thread's log, in milliseconds since 1970, for the list of
  // threads. Null in a row from before Skelcrew kept it.
  changed: z.number().nullable(),
  // The lead's messages to the builder, oldest first, with when each was typed in. They change
  // the task after the thread started, such as a new design you agreed to, so the reviewer and
  // sc issue show get them with the task. Only the lead's count: a builder must never change
  // what it is reviewed against. A row from before Skelcrew kept them holds null, read as none.
  updates: savedJson("tasks.updates", TaskUpdate.array(), []),
  // What the builder is doing, as its harness's hooks and its screen tell. Null until its first
  // hook runs, and in a row from before Skelcrew kept it.
  state: AgentState.nullable(),
  // The session host its builder runs on, tmux or a runtime plugin by name, which it keeps until
  // the builder ends: a host you pick later is only for new sessions. Null once you stopped it.
  host: z.string().nullable(),
  // The builder's session ID on its host, or null for its folder, which is its name on tmux.
  host_id: z.string().nullable(),
  // Whether the work ended with its changes merged: its PR merged, or without a forge, its
  // branch reached its base. False while it goes on, and once it ended any other way.
  merged: z.coerce.boolean(),
  // The link to the issue the task came from, saved as it started, or null for a task with no
  // issue. A task that started before Skelcrew kept it has the link Skelcrew's copy still had.
  issue_link: z.string().nullable(),
  // The line a PR's body needs to close the task's issue on merge, such as "Closes #12", saved as
  // the task starts. Empty for a task with no issue. Null only in a row from before Skelcrew
  // kept it, which takes the line from Skelcrew's copy of the tracker.
  closes: z.string().nullable(),
  // A merge you armed, or null with none, and then nothing merges by itself. A merge when ready
  // merges the PR once it is approved and green, and one skipping the review, with `merge_pinned`,
  // once CI is green at the commit you saw. Who armed it and when, what it waits on
  // as the last poll found, and the review round the lead last heard it still waits after,
  // or on a flow with no review stage when the submit it heard of was marked not reviewed.
  merge_plan: z.enum(["armed"]).nullable(),
  // The armed plan's own ID, new each time it is armed, so a plan cancelled and armed again is
  // never taken for the one before.
  merge_id: z.string().nullable(),
  merge_by: z.string().nullable(),
  merge_at: z.number().nullable(),
  // Your words, exactly, when you asked the lead to arm the plan, or null when you armed it at
  // your terminal.
  merge_asked: z.string().nullable(),
  merge_waits: z.string().nullable(),
  merge_noted: z.number().nullable(),
  // The PR's head when you asked to merge it without Skelcrew's approval, or null for a merge when
  // ready. Only this commit merges, as you saw it, so a push after you asked cancels the plan.
  merge_pinned: z.string().nullable(),
  // The plan's ID and the commit, with a space between, whose record of who asked Skelcrew posted
  // on the PR, and that review's ID, so the record goes once per plan and commit, through
  // restarts too. Null before the first.
  merge_record: z.string().nullable(),
  merge_record_id: z.string().nullable(),
  // The issue a merge without approval filed what its review still asked for in, once filed, so
  // a poll after a restart never files a second one.
  merge_followup: z.string().nullable(),
  // The tree of the .agents/ you had approved when the task started, whose roles its agents
  // keep to the end, though you approve another meanwhile. Null for the built-in roles, as
  // every task had before Skelcrew read .agents/.
  agents: z.string().nullable(),
  // The flow the task runs, from start to end: `default`, or a flow file of its .agents/.
  flow: z.string(),
  // Skelcrew's review on the task's PR, or null before its first. It names its PR, so a PR
  // opened again after sc rm gets a review of its own. One Skelcrew can't read counts as none,
  // and the next review is posted anew.
  review_post: savedJson("tasks.review_post", ReviewPost.nullable(), null),
  // When the task last joined the queue of limits.threads, in milliseconds since 1970. The queue
  // goes in this order, after a restart too. Kept once the task leaves the queue, until its
  // builder's session is saved, so a restart before then puts it back in its place.
  queued_since: z.number().nullable(),
});
export type Thread = z.infer<typeof Thread>;

// Returns the harness the thread's builder runs on, for starting it again and typing into it.
export const builderHarness = (thread: Thread) => harnessNamed(thread.harness ?? "claude");

// Returns the host the thread's builder session runs on and its ID there, for everything that
// reaches the builder. A stopped thread has no session, and is looked for on tmux, where nothing
// of it runs. Throws when its host is a plugin no longer installed, as it can't be reached.
// A plugin's host gives the ID as it starts the session, and the daemon could stop before saving
// it. So a thread on a plugin with no ID saved finds its builder by the labels it started with,
// and saves its ID then, so it is never started a second time.
export async function builderSession(
  db: Database,
  sessions: string,
  thread: Thread,
): Promise<{ host: Host; id: string }> {
  const host = hostNamed(db, sessions, thread.host ?? "tmux");
  if (host === null) throw new Error(hostGone(thread));
  if (thread.host_id !== null || typeof host === "string")
    return { host, id: thread.host_id ?? thread.folder };
  // The builder's task label is its thread's name when it started: its repository's short name
  // or, once another repository shares that, its owner and name, then its task's ID. Either is
  // matched whole, so task 12 never takes the builder of task other-12.
  const names = [`${thread.repo}-${thread.task}`, `${fullNameOf(thread)}-${thread.task}`];
  const found = (await listSessions(host)).find(
    ({ labels }) =>
      labels?.role === "builder" &&
      labels.repository === fullNameOf(thread) &&
      names.includes(labels.task ?? ""),
  );
  if (!found) return { host, id: thread.folder };
  const now = record(db, thread.folder, { host_id: found.name }, "found its builder on its host");
  // A short title given while its ID was unknown found nothing to rename, so its labels may
  // still name it by the old title.
  if (found.labels?.title !== (sessionTitle(db, now) ?? undefined)) renameOnHost(db, thread.folder);
  return { host, id: found.name };
}

// Returns why a thread's builder can't be reached when its host plugin is gone.
export const hostGone = (thread: Thread) =>
  `its builder's session host ${thread.host} isn't installed any more`;

// Returns whether the thread's review waits in the queue for a place, as limits.reviews already
// runs. Only a working or waiting thread has a review going on: one stopped, failed or done
// can keep the fields of a review that ended with it. A newer submit still pushing doesn't
// wait either, as the queued time left from its older round's review isn't about it.
export const queuedForReview = (thread: Thread) =>
  (thread.status === "working" || thread.status === "waiting") &&
  thread.submitting === null &&
  thread.reviewing !== null &&
  thread.queued !== null;

// Returns the thread's repository as owner/name.
export const fullNameOf = (thread: Thread) => `${thread.owner}/${thread.repo}`;
// Returns the thread's repository, or throws once Skelcrew no longer has it.
export const repositoryOf = (db: Database, thread: Thread) =>
  findRepository(db, fullNameOf(thread));

// Returns the thread's clone folder. It comes from the folder name chosen at start, so it
// stays put when the repository's name changes. Setup and a thread's end delete this folder,
// so it throws for a name that isn't one plain folder inside Skelcrew's threads folder, such
// as one with a / or a .., however it got into the database.
export function cloneOf(thread: Thread): string {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(thread.folder) || thread.folder.includes(".."))
    throw new Error(`a thread's folder must be a plain name, not ${thread.folder}`);
  return join(threadsDir(), thread.folder);
}

// Appends the whole thread as it now is, with the reason when there is one, as a line to
// its log. Every change goes there too, so the thread's history can be read and replayed. It
// also saves when this happened, as the list of threads shows when each one last changed.
export function log(db: Database, thread: Thread, why?: string): void {
  const now = Date.now();
  db.run("UPDATE threads SET changed = ? WHERE folder = ?", [now, thread.folder]);
  mkdirSync(threadsDir(), { recursive: true });
  const line = {
    at: new Date(now).toISOString(),
    ...thread,
    changed: now,
    ...(why ? { why } : {}),
  };
  appendFileSync(join(threadsDir(), `${thread.folder}.log`), `${JSON.stringify(line)}\n`);
}

// Returns the thread in the given folder as it is now in the database.
export const readThread = (db: Database, folder: string) =>
  Thread.parse(db.query("SELECT * FROM task_threads WHERE folder = ?").get(folder));

// Saves a change to the thread, logs the thread as it now is, and returns it. `why` goes in
// the log, so a failure says what went wrong. When the change makes the thread start needing
// you, `why` is also saved as the note for the lead, on one line; once it no longer needs you,
// a note not yet typed is dropped. The daemon types saved notes with typeLeadNotes.
export function record(
  db: Database,
  folder: string,
  change: Partial<
    Omit<
      Thread,
      "owner" | "repo" | "task" | "folder" | "branch" | "base" | "title" | "started" | "changed"
    >
  >,
  why?: string,
): Thread {
  // Work out the note for the lead. A thread that stops needing you drops its note, and one
  // that starts needing you keeps why, short enough to type as one line. A thread that already
  // needed you keeps the note it had, so a later change doesn't hide the first reason.
  const before = readThread(db, folder);
  let { noting } = change;
  if (!needsYou({ ...before, ...change })) noting = null;
  else if (!needsYou(before)) noting = (why ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  // The column names come from the keys of Thread above, never from outside. The task's fields
  // go on its task, and the rest on the thread. One transaction, so a change is saved whole or
  // not at all.
  const full = noting === undefined ? change : { ...change, noting };
  const set = Object.entries(full).filter(([, value]) => value !== undefined);
  const update = (table: string, where: string, columns: typeof set) => {
    if (columns.length > 0)
      db.run(
        `UPDATE ${table} SET ${columns.map(([column]) => `${column} = ?`).join(", ")} ${where}`,
        // The IDs seen, the lead's updates and Skelcrew's review on the PR are kept as JSON.
        [
          ...columns.map(([, value]) =>
            typeof value === "object" && value !== null ? JSON.stringify(value) : value,
          ),
          folder,
        ],
      );
  };
  const onTask = (column: string) => column in taskColumns;
  db.transaction(() => {
    update(
      "threads",
      "WHERE folder = ?",
      set.filter(([column]) => !onTask(column)),
    );
    update(
      "tasks",
      "WHERE (owner, repo, task) = (SELECT owner, repo, task FROM threads WHERE folder = ?)",
      set.filter(([column]) => onTask(column)),
    );
  })();
  // Read the thread back rather than merging the change in memory, so the log and the caller
  // see exactly what the database holds.
  const thread = readThread(db, folder);
  log(db, thread, why);
  reportStatus(db, thread);
  if (thread.short !== before.short) renameOnHost(db, folder);
  return thread;
}

// Tells the builder's host the thread's title, when the host is a plugin, so its own apps stop
// showing an old one. A builder on tmux needs nothing, as Skelcrew's list reads the title from
// here. It doesn't wait for the host, and a host that fails, such as an older plugin that
// doesn't know the question, only costs the new name, so it is logged. Each rename waits for
// the one before on the same session and sends the title as it is then, so two quick changes
// can't reach the host out of order and leave it on the older title.
export function renameOnHost(db: Database, folder: string): void {
  const previous = renaming.get(folder) ?? Promise.resolve();
  const sent = previous.then(async () => {
    const thread = readThread(db, folder);
    if (thread.host === null || thread.host === "tmux" || thread.host_id === null) return;
    const host = pluginHost(db, thread.host);
    const title = sessionTitle(db, thread);
    if (host === null || !title) return;
    await renameSession(host, thread.host_id, title).catch((error) =>
      console.log(`couldn't rename ${folder} on ${host.plugin}: ${errorText(error)}`),
    );
  });
  // A thread gone by then, which readThread throws for, has nothing to rename.
  const settled = sent.catch(() => {});
  renaming.set(folder, settled);
  settled.then(() => {
    if (renaming.get(folder) === settled) renaming.delete(folder);
  });
}

// Returns the title a builder's session goes by on its host: its thread's short title, else the
// task's title as its builder was given it, which a row from before Skelcrew saved titles takes
// from the copy of the tracker. Null when it has neither.
export function sessionTitle(db: Database, thread: Thread): string | null {
  return thread.short || threadTask(db, thread).title || null;
}

// The renames under way of each thread's builder, by its folder, each settling once it is over.
const renaming = new Map<string, Promise<void>>();

// Returns the thread's name, such as app-12, for replies. It uses the repository's name
// now, which can gain its owner since the thread started, or owner/name once Skelcrew no longer
// has the repository.
export function threadName(db: Database, thread: Thread): string {
  const row = db
    .query("SELECT name FROM repositories WHERE owner = ? AND repo = ?")
    .get(thread.owner, thread.repo);
  const name = z.object({ name: z.string() }).nullable().parse(row)?.name ?? fullNameOf(thread);
  return `${name}-${thread.task}`;
}

// Returns the thread named repo-task, such as app-12, or null when the task has none. Throws
// when Skelcrew doesn't have the repository.
export function threadOn(db: Database, repository: string, task: string): Thread | null {
  const { owner, repo } = findRepository(db, repository);
  return Thread.nullable().parse(
    db
      .query("SELECT * FROM task_threads WHERE owner = ? AND repo = ? AND task = ?")
      .get(owner, repo, task),
  );
}

// Returns the thread named repo-task, such as app-12, and throws when there is none.
export function findThread(db: Database, repository: string, task: string): Thread {
  const thread = threadOn(db, repository, task);
  if (!thread) throw new Error(`there is no thread ${repository}-${task}`);
  return thread;
}

// Returns the threads that are working or waiting, whose builders the daemon brings back
// and whose sockets it opens again when it starts.
export function liveThreads(db: Database): Thread[] {
  return db
    .query("SELECT * FROM task_threads WHERE status IN ('working', 'waiting')")
    .all()
    .map((row) => Thread.parse(row));
}

// Returns the start of a thread's folder name, made from its repository's name. The builder's
// config folder and session are named after it too, so it starts with a letter or digit, as
// they must. tmux changes . and : in a session's name, and / would make a folder. It stays
// short: Claude Code hashes the name of the folder it saves a conversation in once the path
// passes 200 characters, and Skelcrew would then miss it when bringing the builder back.
export function folderName(repository: string): string {
  // Anything but a letter, digit, _ or - becomes a dash, and leading dashes and underscores go.
  const name = repository
    .replace(/[^\w-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 60);
  return name || "thread";
}
