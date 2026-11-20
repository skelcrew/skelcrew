// The backlog of Skelcrew's own tasks: work filed with sc task add, with no issue in a tracker,
// waiting for sc start. Each task is kept on the repository's remote, so every machine's daemon
// shows the same backlog, and the daemon keeps a copy in its database for the list to read.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Repository } from "../db.ts";
import { errorText } from "../say.ts";
import { claimedNames, claimName, fetchFiled, unfile } from "./git.ts";

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

// The tasks of the backlog starting on this machine, by owner/name/task, from the moment their
// thread is recorded until their start takes them off the remote. A refresh of the backlog
// leaves them to the start, which would otherwise take them for started by another machine.
export const starting = new Set<string>();

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

// Brings the daemon's copy of the repository's backlog up to date with its remote, from
// Skelcrew's clone in the folder. Each refresh of the clone runs it, so a task filed, started or
// removed on another machine shows here within a poll. A task the remote holds in a shape this
// Skelcrew can't read is left out, with a line in the log.
export async function refreshBacklog(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<void> {
  const filed = await fetchFiled(db, repository, folder);
  const tasks = filed.flatMap(({ name, commit, text }) => {
    let kept: z.infer<typeof Kept> | null = null;
    try {
      kept = Kept.parse(JSON.parse(text));
    } catch {}
    if (kept && /^t\d+$/.test(name)) return [{ task: name, commit, ...kept }];
    console.log(`left out ${repository.name}-${name} from its backlog: Skelcrew can't read it`);
    return [];
  });
  // A task this machine has a thread on started here, and a stop before its start took it off the
  // remote left it there, so it comes off now. Names are claimed, so no other machine filed it.
  const started = (task: string) =>
    !starting.has(`${repository.owner}/${repository.repo}/${task}`) &&
    db
      .query("SELECT 1 FROM task_threads WHERE owner = ? AND repo = ? AND task = ?")
      .get(repository.owner, repository.repo, task) !== null;
  for (const task of tasks.filter((t) => started(t.task)))
    await unfile(db, repository, folder, task.task, task.commit).catch((error) =>
      console.log(
        `couldn't take started ${repository.name}-${task.task} off its backlog: ${errorText(error)}`,
      ),
    );
  // One transaction, so no reader sees the backlog half refreshed.
  db.transaction(() => {
    db.run("DELETE FROM backlog WHERE owner = ? AND repo = ?", [repository.owner, repository.repo]);
    saveFiled(
      db,
      repository,
      tasks.filter((t) => !started(t.task)),
    );
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

// Takes a task out of the repository's backlog, on its remote from Skelcrew's clone in the
// folder and in the daemon's copy, as it starts or is removed. Throws when another machine
// started or removed it since this one read it, so it never starts twice.
export async function unfileTask(
  db: Database,
  repository: Repository,
  folder: string,
  task: Filed,
): Promise<void> {
  try {
    await unfile(db, repository, folder, task.task, task.commit);
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
