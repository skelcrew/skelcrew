// The backlog of Skelcrew's own tasks: work filed with sc task add, with no issue in a tracker,
// waiting for sc start. Each task is kept on the repository's remote, so every machine's daemon
// shows the same backlog, and the daemon keeps a copy in its database for the list to read.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Repository } from "../db.ts";
import { errorText } from "../say.ts";
import {
  claimedNames,
  claimName,
  fetchBacklog,
  filedRef,
  makeCommit,
  moveRefs,
  startedRef,
} from "./git.ts";

// A task in the backlog: its name, such as t104, its title and description, when it was filed,
// as an ISO time so it sorts beside the tracker's issues, and by whom, such as simon or simon via
// the lead. `commit` is where the remote keeps it, which starting or removing it must still find.
export const Filed = z.object({
  task: z.string(),
  title: z.string(),
  body: z.string(),
  created: z.string(),
  by: z.string(),
  commit: z.string(),
});
export type Filed = z.infer<typeof Filed>;

// What the remote keeps of a task, as JSON. Any machine may have written it, so it is checked.
const Kept = z.object({
  title: z.string().min(1),
  body: z.string(),
  created: z.string(),
  by: z.string(),
});

// The tasks of the backlog this machine is starting now, by owner/name/task, from before it
// claims one on the remote until its thread is recorded and the claim gone. A refresh of the
// backlog leaves them to their start, which it would otherwise take for one cut short.
const starting = new Set<string>();

// Claims the next name for one of Skelcrew's own tasks on the remote, from Skelcrew's clone in
// the folder, and returns it, such as t104. It is a t and the next number after every one claimed
// on the remote, which every machine sees, and every one this machine's tasks hold. Names from
// before Skelcrew claimed them, such as t25, were never claimed and live only on the machine that
// started them, so numbers start at 100, above all of them. Only one machine can claim a name, so
// the claims are read again while another machine claimed first. `filed` is the task to keep in
// the backlog under the name, as claimName takes it.
export async function claimOwnName(
  db: Database,
  repository: Repository,
  folder: string,
  filed?: string,
): Promise<string> {
  const { owner, repo } = repository;
  const held = db
    .query("SELECT task FROM tasks WHERE owner = ? AND repo = ? AND task GLOB 't[0-9]*'")
    .all(owner, repo)
    .map((row) => z.object({ task: z.string() }).parse(row).task)
    .filter((id) => /^t\d+$/.test(id));
  while (true) {
    const claims = await claimedNames(db, repository);
    const numbers = [...claims.names, ...held].map((id) => Number(id.slice(1)));
    const task = `t${Math.max(99, ...numbers) + 1}`;
    if (await claimName(db, repository, folder, task, claims.last, filed)) return task;
  }
}

// Files a task in the repository's backlog on its remote, from Skelcrew's clone in the folder,
// and returns its name, such as t104. It starts nothing: sc start starts it later, on any
// machine. The daemon's copy has it once the clone's next refresh reads it back.
export async function fileTask(
  db: Database,
  repository: Repository,
  folder: string,
  given: { title: string; body: string; by: string },
): Promise<string> {
  const kept = { ...given, created: new Date().toISOString() };
  return claimOwnName(db, repository, folder, JSON.stringify(kept));
}

// Writes tasks into the daemon's copy of the repository's backlog, over any of the same name.
function saveFiled(db: Database, repository: Repository, tasks: Filed[]): void {
  for (const t of tasks)
    db.run(
      `INSERT OR REPLACE INTO backlog (owner, repo, task, title, body, created, by, filed_commit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [repository.owner, repository.repo, t.task, t.title, t.body, t.created, t.by, t.commit],
    );
}

// Returns the task the remote keeps under a name, at a commit, from its text, or null with a line
// in the log when this Skelcrew can't read it.
function readKept(repository: Repository, name: string, commit: string, text: string) {
  try {
    const kept = Kept.parse(JSON.parse(text));
    if (/^t\d+$/.test(name)) return { task: name, commit, ...kept };
  } catch {}
  console.log(`left out ${repository.name}-${name} from its backlog: Skelcrew can't read it`);
  return null;
}

// Returns the move that removes a start's claim on the remote, while it is still at its commit.
const endClaim = (name: string, commit: string) => ({
  ref: startedRef(name),
  was: commit,
  now: "",
});

// Brings the daemon's copy of the repository's backlog up to date with its remote, from
// Skelcrew's clone in the folder. Each refresh of the clone runs it, so a task filed, started or
// removed on another machine shows here within a poll. It also finishes a start of this
// machine's that a stop cut short, as startFiled says.
export async function refreshBacklog(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<void> {
  const { owner, repo } = repository;
  const { filed, started } = await fetchBacklog(db, repository, folder);
  const tasks = filed.flatMap(({ name, commit, text }) => {
    const kept = readKept(repository, name, commit, text);
    return kept ? [kept] : [];
  });
  // A start this machine claimed on the remote either recorded its thread, and only the claim is
  // left to remove, or stopped before it did, and the task goes back in the backlog. A claim with
  // neither is another machine's start, which is that machine's to finish.
  const where = "WHERE owner = ? AND repo = ? AND task = ?";
  for (const { name, commit, text } of started) {
    if (starting.has(`${owner}/${repo}/${name}`)) continue;
    const thread = db.query(`SELECT 1 FROM task_threads ${where}`).get(owner, repo, name);
    const ours = db
      .query(`SELECT 1 FROM backlog_starts ${where} AND started_commit = ?`)
      .get(owner, repo, name, commit);
    try {
      if (thread) await moveRefs(db, repository, folder, [endClaim(name, commit)]);
      else if (ours) {
        await moveRefs(db, repository, folder, [
          { ref: filedRef(name), was: "", now: commit },
          endClaim(name, commit),
        ]);
        const kept = readKept(repository, name, commit, text);
        if (kept) tasks.push(kept);
      }
    } catch (error) {
      console.log(`couldn't finish starting ${repository.name}-${name}: ${errorText(error)}`);
    }
  }
  // One transaction, so no reader sees the backlog half refreshed. A start this machine noted
  // that has no claim on the remote now never got it, or was finished above.
  const claimed = started.map((s) => s.name);
  db.transaction(() => {
    db.run("DELETE FROM backlog WHERE owner = ? AND repo = ?", [owner, repo]);
    saveFiled(db, repository, tasks);
    const noted = db
      .query("SELECT task FROM backlog_starts WHERE owner = ? AND repo = ?")
      .all(owner, repo)
      .map((row) => z.object({ task: z.string() }).parse(row).task);
    for (const task of noted)
      if (!claimed.includes(task) && !starting.has(`${owner}/${repo}/${task}`))
        db.run(`DELETE FROM backlog_starts ${where}`, [owner, repo, task]);
  })();
}

// Returns the repository's backlog, newest first, from the daemon's copy.
export function backlogOf(db: Database, owner: string, repo: string): Filed[] {
  return db
    .query(`SELECT task, title, body, created, by, filed_commit AS "commit" FROM backlog
      WHERE owner = ? AND repo = ? ORDER BY created DESC, length(task) DESC, task DESC`)
    .all(owner, repo)
    .map((row) => Filed.parse(row));
}

// Returns a task of the repository's backlog, or null when it has none of that name.
export const filedTask = (db: Database, owner: string, repo: string, task: string) =>
  backlogOf(db, owner, repo).find((t) => t.task === task) ?? null;

// Starts a task of the backlog on this machine: claims it on the remote, then has `record` record
// its thread, which holds its words from then on, then removes the claim, and returns what
// `record` gave. The claim moves the task from its ref to a ref of its own start, in one push
// whose lease needs the task where it was read, so of two machines starting it, the second is
// refused, and no thread of its is ever recorded. The claim keeps the task's words, and the
// daemon's database notes it before it is pushed. So a stop at any point loses nothing: the next
// refresh of the backlog finds the claim, and removes it once the thread is there, or else puts
// the task back. A thread that can't be recorded puts it back at once.
export async function startFiled<T>(
  db: Database,
  repository: Repository,
  folder: string,
  task: Filed,
  record: () => T,
): Promise<T> {
  const { owner, repo } = repository;
  const key = `${owner}/${repo}/${task.task}`;
  const where = "WHERE owner = ? AND repo = ? AND task = ?";
  starting.add(key);
  try {
    // The claim's commit carries the task's words, so it can be put back.
    const kept = { title: task.title, body: task.body, created: task.created, by: task.by };
    const message = `Skelcrew starts ${task.task}: ${crypto.randomUUID()}\n\n${JSON.stringify(kept)}`;
    const commit = await makeCommit(db, repository, folder, message);
    db.run(
      "INSERT OR REPLACE INTO backlog_starts (owner, repo, task, started_commit) VALUES (?, ?, ?, ?)",
      [owner, repo, task.task, commit],
    );
    try {
      await moveRefs(db, repository, folder, [
        { ref: filedRef(task.task), was: task.commit, now: "" },
        { ref: startedRef(task.task), was: "", now: commit },
      ]);
    } catch (error) {
      db.run(`DELETE FROM backlog_starts ${where}`, [owner, repo, task.task]);
      throw new Error(
        `${repository.name}-${task.task} was started or removed on another machine, or its remote can't be reached: ${errorText(error)}`,
      );
    }
    // The note goes with the thread, in one transaction, as from then on the thread says this
    // machine started it.
    let recorded: T;
    try {
      recorded = db.transaction(() => {
        db.run(`DELETE FROM backlog_starts ${where}`, [owner, repo, task.task]);
        db.run(`DELETE FROM backlog ${where}`, [owner, repo, task.task]);
        return record();
      })();
    } catch (error) {
      await moveRefs(db, repository, folder, [
        { ref: filedRef(task.task), was: "", now: commit },
        endClaim(task.task, commit),
      ])
        .then(() => db.run(`DELETE FROM backlog_starts ${where}`, [owner, repo, task.task]))
        .catch((failed) =>
          console.log(`couldn't put ${repository.name}-${task.task} back: ${errorText(failed)}`),
        );
      throw error;
    }
    // A claim that can't be removed now is removed by the next refresh.
    await moveRefs(db, repository, folder, [endClaim(task.task, commit)]).catch((error) =>
      console.log(`couldn't finish starting ${repository.name}-${task.task}: ${errorText(error)}`),
    );
    return recorded;
  } finally {
    starting.delete(key);
  }
}

// Removes a task of the backlog that never started, on its remote from Skelcrew's clone in the
// folder and in the daemon's copy, for sc rm. Its words were only on its ref, which goes. Its
// name stays claimed. Throws when another machine started or removed it since this one read it.
export async function unfileTask(
  db: Database,
  repository: Repository,
  folder: string,
  task: Filed,
): Promise<void> {
  try {
    await moveRefs(db, repository, folder, [
      { ref: filedRef(task.task), was: task.commit, now: "" },
    ]);
  } catch (error) {
    throw new Error(
      `${repository.name}-${task.task} was started or removed on another machine, or its remote can't be reached: ${errorText(error)}`,
    );
  }
  db.run("DELETE FROM backlog WHERE owner = ? AND repo = ? AND task = ?", [
    repository.owner,
    repository.repo,
    task.task,
  ]);
}
