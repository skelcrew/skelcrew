// The backlog of Skelcrew's own tasks: work filed with sc add, with no issue in a tracker,
// waiting for sc start. Each task is kept on the repository's remote, so every machine's daemon
// shows the same backlog, and the daemon keeps a copy in its database for the list to read.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { fillIssues, type Repository } from "../db.ts";
import { errorText } from "../format.ts";
import { cloneDir } from "../paths.ts";
import { trackerOf } from "../plugins/ask.ts";
import {
  claimedAt,
  claimedNames,
  claimName,
  fetchBacklog,
  filedRef,
  makeCommit,
  moveRefs,
  remoteRef,
  renamedTo,
  renames,
  startedRef,
} from "./git.ts";
import { lastReviewed } from "./ledger.ts";
import { noteForLead, typeLeadNotes } from "./messages.ts";
import { readThread, record, repositoryOf, Thread, taskName, threadName } from "./thread.ts";

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

// The change to each repository's backlog under way or waiting, by owner/name. A refresh, a
// start and a removal each read the backlog and write it back, so they run one at a time: a
// refresh that overlapped a start would write back the task it just took out, or take the start
// for one a stop cut short.
const turns = new Map<string, Promise<unknown>>();

// Runs `work` on the repository's backlog once the change before it is over, and returns what it
// gave. The next one waits for it whether it fails or not, and the last leaves no entry behind.
function inTurn<T>(repository: Repository, work: () => Promise<T>): Promise<T> {
  const key = `${repository.owner}/${repository.repo}`;
  const run = (turns.get(key) ?? Promise.resolve()).then(work);
  const settled = run.catch(() => {});
  turns.set(key, settled);
  settled.then(() => {
    if (turns.get(key) === settled) turns.delete(key);
  });
  return run;
}

// Returns the names of Skelcrew's own tasks this machine holds in the repository, such as t4.
// Names from a machine's code, such as wr4, are left out, as no claim can match them.
function heldNames(db: Database, repository: Repository): string[] {
  return db
    .query("SELECT task FROM tasks WHERE owner = ? AND repo = ? AND task GLOB 't[0-9]*'")
    .all(repository.owner, repository.repo)
    .map((row) => z.object({ task: z.string() }).parse(row).task)
    .filter((id) => /^t\d+$/.test(id));
}

// The names this daemon has seen claimed on the remote, as owner/repo/name, so each poll asks the
// remote only about names it hasn't settled yet, such as a task started since.
const settled = new Set<string>();

// Claims on the remote, as an old name, each name this machine holds that no claim has yet: a
// name from before Skelcrew claimed names, such as t25, which lives only here. Every machine then
// numbers its new tasks above 99, above every old name, where a brand-new repository starts at t1.
// A name another machine claimed first is settled as it is: a claim doesn't say which machine made
// it, so it can't be told from this machine's own. That gap is left to a machine whose daemon
// didn't run between this release and another machine's first task there. Each refresh runs it,
// and it asks the remote nothing once every name held is settled.
async function claimOldNames(db: Database, repository: Repository, folder: string) {
  const key = (name: string) => `${repository.owner}/${repository.repo}/${name}`;
  let left = heldNames(db, repository).filter((name) => !settled.has(key(name)));
  while (left.length > 0) {
    const claims = await claimedNames(db, repository);
    const known = [...claims.names, ...claims.old];
    for (const name of left.filter((name) => known.includes(name))) settled.add(key(name));
    left = left.filter((name) => !known.includes(name));
    const [name] = left;
    if (name === undefined) return;
    // A claim refused because another machine claimed meanwhile is tried again on fresh claims.
    if (await claimName(db, repository, folder, name, claims.last, undefined, undefined, true)) {
      settled.add(key(name));
      left = left.slice(1);
      console.log(
        `claimed ${taskName(repository.name, name)}, a name from before Skelcrew claimed names`,
      );
    }
  }
}

// Gives each task this machine holds under a name from before every task took a number of
// Skelcrew's, such as 12, named after its issue, or wr4, a number claimed on the remote, as any new
// task gets. The remote records which old name each number is for, so another machine holding
// the same task gives it the same number. A task this machine holds under a number from before
// Skelcrew claimed names, such as t1, whose number another machine gave a task of an old name
// meanwhile, is another task: it is renumbered too, so no two tasks share a name. Each keeps its
// old name as its alias, which still reaches it here, and its folder, branch and session, which
// go by the folder, and the item the lead posted about it, if any. Every change to a thread goes
// by its folder, so work under way carries on.
// Otherwise the oldest goes first. Each refresh runs it, and it asks the remote nothing once every task
// this machine holds has a number of its own.
async function renumberTasks(db: Database, repository: Repository, folder: string) {
  const { owner, repo } = repository;
  const where = "WHERE owner = ? AND repo = ? AND task = ?";
  // An item the lead posted about an issue no task has, by the issue's ID alone, such as 12, is
  // about #12, as such an issue goes by now.
  db.run(
    `UPDATE OR IGNORE asks SET task = '#' || task WHERE owner = ? AND repo = ? AND task != ''
      AND task NOT GLOB '#*' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.owner = asks.owner
        AND t.repo = asks.repo AND CAST(t.task AS TEXT) = asks.task)
      AND NOT EXISTS (SELECT 1 FROM backlog b WHERE b.owner = asks.owner AND b.repo = asks.repo
        AND b.task = asks.task)`,
    [owner, repo],
  );
  const held = db
    .query("SELECT task, alias FROM tasks WHERE owner = ? AND repo = ? ORDER BY rowid")
    .all(owner, repo)
    .map((row) => z.object({ task: z.coerce.string(), alias: z.string().nullable() }).parse(row));
  const named = held.filter(({ task }) => /^t\d+$/.test(task));
  const given =
    named.length > 0 && named.some(({ task }) => !checked.has(`${owner}/${repo}/${task}`))
      ? await renames(db, repository)
      : new Map<string, string>();
  // A task held under a number another machine gave goes first, so the task that number was
  // given for, if this machine holds it too, finds it free. Only a task found to keep its number,
  // or given a new one, counts as checked, so a renumbering that fails is tried at the next refresh.
  const clashing = named.filter(({ task, alias }) => {
    const to = given.get(task);
    return to !== undefined && to !== alias;
  });
  for (const { task } of named)
    if (!clashing.some((clash) => clash.task === task)) checked.add(`${owner}/${repo}/${task}`);
  const old = [...clashing, ...held.filter(({ task }) => !/^t\d+$/.test(task))];
  for (const { task: alias } of old) {
    // A number another machine gave in place of an old name is that task's, not this one's, so
    // this task's own number records nothing.
    const renaming = /^t\d+$/.test(alias) ? undefined : alias;
    const task = await claimOwnName(db, repository, folder, undefined, undefined, renaming);
    db.transaction(() => {
      fillIssues(db);
      // An issue GitHub's plugin numbered is written as GitHub writes it, as writtenAs does.
      const github = trackerOf(db, repository) === "github" ? 1 : 0;
      db.run(
        `UPDATE tasks SET task = ?, alias = ?, issue_ref = COALESCE(issue_ref, CASE WHEN ?
          AND issue GLOB '[0-9]*' AND issue NOT GLOB '*[^0-9]*' THEN '#' || issue END) ${where}`,
        [task, alias, github, owner, repo, alias],
      );
      db.run(`UPDATE threads SET task = ? ${where}`, [task, owner, repo, alias]);
      db.run(`UPDATE OR REPLACE asks SET task = ? ${where}`, [task, owner, repo, alias]);
    })();
    checked.add(`${owner}/${repo}/${task}`);
    console.log(
      `renamed ${taskName(repository.name, alias)} to ${taskName(repository.name, task)}, its number`,
    );
  }
}

// The numbered tasks this daemon has looked for in the remote's renames, as owner/repo/task, so
// each refresh asks the remote only about tasks it hasn't looked at yet.
const checked = new Set<string>();

// Claims the next name for one of Skelcrew's own tasks on the remote, from Skelcrew's clone in
// the folder, and returns it, such as t104. It is a t and the next number after every one claimed
// on the remote, which every machine sees, and every one this machine's tasks hold. A brand-new
// repository's first is t1. Names from before Skelcrew claimed them, such as t25, were never
// claimed and live only on the machine that started them, so where this machine holds one,
// numbers start at 100, above all of them. Only one machine can claim a name, so
// the claims are read again while another machine claimed first. `filed` is the task to keep in
// the backlog under the name, as claimName takes it. `renaming` is the old name of a task that
// gets the name, as claimName takes it: once another machine renamed that task, its name is
// returned instead, so the task has the same name on every machine.
export async function claimOwnName(
  db: Database,
  repository: Repository,
  folder: string,
  filed?: string,
  noting?: (task: string, commit: string) => void,
  renaming?: string,
): Promise<string> {
  const held = heldNames(db, repository);
  while (true) {
    const renamed = renaming === undefined ? null : await renamedTo(db, repository, renaming);
    if (renamed !== null) return renamed;
    const claims = await claimedNames(db, repository);
    // A repository with old names, claimed or only held here, numbers its new ones above 99, as
    // another machine may hold old names it hasn't claimed yet.
    const numbers = [...claims.names, ...claims.old, ...held].map((id) => Number(id.slice(1)));
    const unclaimed = held.some((id) => !claims.names.includes(id) && !claims.old.includes(id));
    const old = claims.old.length > 0 || unclaimed;
    const task = `t${Math.max(old ? 99 : 0, ...numbers) + 1}`;
    const note = noting && ((commit: string) => noting(task, commit));
    if (await claimName(db, repository, folder, task, claims.last, filed, note, false, renaming))
      return task;
  }
}

// Files a task in the backlog and returns its name, and whether an earlier filing whose answer
// was lost had filed it already. Each try is noted until it is settled, so the same filing run
// again finds it. `saved` keeps the name where the caller needs it, in the same step that drops
// the note, so a stop between the two can never file it twice.
export function fileTask(
  db: Database,
  repository: Repository,
  folder: string,
  given: { title: string; body: string; by: string },
  saved: (task: string) => void = () => {},
): Promise<{ task: string; already: boolean }> {
  return inTurn(repository, async () => {
    const { owner, repo } = repository;
    const forget = (commit: string) =>
      db.run("DELETE FROM filing_tries WHERE owner = ? AND repo = ? AND claim_commit = ?", [
        owner,
        repo,
        commit,
      ]);
    const notes = db
      .query(`SELECT task, claim_commit FROM filing_tries
        WHERE owner = ? AND repo = ? AND title = ? AND body = ?`)
      .all(owner, repo, given.title, given.body)
      .map((row) => z.object({ task: z.string(), claim_commit: z.string() }).parse(row));
    for (const note of notes) {
      const holds = await claimedAt(db, repository, note.task);
      if (holds !== note.claim_commit) {
        forget(note.claim_commit);
        continue;
      }
      db.transaction(() => {
        saved(note.task);
        forget(note.claim_commit);
      })();
      return { task: note.task, already: true };
    }
    const kept = { ...given, created: new Date().toISOString() };
    const tried: string[] = [];
    const note = (task: string, commit: string) => {
      tried.push(commit);
      db.run(
        `INSERT INTO filing_tries (owner, repo, task, claim_commit, title, body)
          VALUES (?, ?, ?, ?, ?, ?)`,
        [owner, repo, task, commit, given.title, given.body],
      );
    };
    const task = await claimOwnName(db, repository, folder, JSON.stringify(kept), note);
    db.transaction(() => {
      saved(task);
      for (const commit of tried) forget(commit);
    })();
    return { task, already: false };
  });
}

// Files what the thread's latest review found that didn't block as one task of the backlog, once
// its work merged, so none is lost with the thread. It names the PR, or the branch without one.
// Returns what the lead's note adds about it, or nothing when the latest review found none, as
// they were all fixed. It files once: the task's name is saved on the thread as the filing is
// settled, and a filing cut short is found again by its words, which every try gives the same. A
// task that can't be filed yet is said in the note, and each poll tries again.
export async function fileNotBlocking(db: Database, thread: Thread): Promise<string> {
  const repository = repositoryOf(db, thread);
  const named = (task: string) => taskName(repository.name, task);
  if (thread.not_blocking_task !== null)
    return ` Its not-blocking findings are in ${named(thread.not_blocking_task)}.`;
  const found = lastReviewed(thread)?.notBlocking ?? [];
  if (found.length === 0) return "";
  const listed = found.map((finding, n) => `${n + 1}. ${finding.trim()}`).join("\n");
  const merged = thread.pr === null ? `branch ${thread.branch}` : `#${thread.pr}`;
  const title = `Not-blocking findings from ${merged}'s review`;
  const body = `Skelcrew's reviewer found these in ${merged} and didn't let them block it, so they wait here:\n\n${listed}\n\nFrom ${merged}, ${threadName(db, thread)}.`;
  try {
    const saved = (task: string) =>
      record(
        db,
        thread.folder,
        { not_blocking_task: task },
        `filed its review's not-blocking findings as ${named(task)}`,
      );
    const clone = cloneDir(repository.owner, repository.repo);
    const given = { title, body, by: "skelcrew" };
    const { task } = await fileTask(db, repository, clone, given, saved);
    return ` Its not-blocking findings are in ${named(task)}.`;
  } catch (error) {
    console.log(
      `${threadName(db, thread)}: couldn't file its not-blocking findings: ${errorText(error)}`,
    );
    return ` Its not-blocking findings couldn't be filed yet, and each poll tries again: ${errorText(error)}`;
  }
}

// Files again what each merged thread of the repository found that didn't block, where filing it
// failed as the thread ended, such as while the remote couldn't be reached. Each poll of the
// repository tries, and the lead hears once it is filed.
export async function fileNotBlockingAgain(
  db: Database,
  sessions: string,
  repository: Repository,
): Promise<void> {
  const ended = db
    .query(`SELECT * FROM task_threads WHERE owner = ? AND repo = ? AND status = 'done'
      AND merged = 1 AND not_blocking_task IS NULL AND round_log LIKE '%"notBlocking":["%'`)
    .all(repository.owner, repository.repo)
    .map((row) => Thread.parse(row));
  for (const thread of ended) {
    const said = await fileNotBlocking(db, thread);
    if (readThread(db, thread.folder).not_blocking_task !== null)
      noteForLead(db, sessions, repository, `${threadName(db, thread)} merged earlier.${said}`);
  }
  typeLeadNotes(db, sessions);
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
  console.log(
    `left out ${taskName(repository.name, name)} from its backlog: Skelcrew can't read it`,
  );
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
export function refreshBacklog(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<void> {
  return inTurn(repository, () => refreshInTurn(db, repository, folder));
}

// Refreshes the backlog for refreshBacklog, in the repository's turn.
async function refreshInTurn(db: Database, repository: Repository, folder: string) {
  const { owner, repo } = repository;
  // A failed claim of an old name stops nothing else, and is tried again at the next refresh.
  await claimOldNames(db, repository, folder).catch((error) =>
    console.log(`couldn't claim ${repository.name}'s old task names: ${errorText(error)}`),
  );
  await renumberTasks(db, repository, folder).catch((error) =>
    console.log(`couldn't renumber ${repository.name}'s tasks: ${errorText(error)}`),
  );
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
      console.log(
        `couldn't finish starting ${taskName(repository.name, name)}: ${errorText(error)}`,
      );
    }
  }
  // One transaction, so no reader sees the backlog half refreshed. A start this machine noted
  // whose claim isn't on the remote now never got it, or was finished above.
  db.transaction(() => {
    db.run("DELETE FROM backlog WHERE owner = ? AND repo = ?", [owner, repo]);
    saveFiled(db, repository, tasks);
    const noted = db
      .query("SELECT task, started_commit FROM backlog_starts WHERE owner = ? AND repo = ?")
      .all(owner, repo)
      .map((row) => z.object({ task: z.string(), started_commit: z.string() }).parse(row));
    for (const note of noted)
      if (!started.some((s) => s.name === note.task && s.commit === note.started_commit))
        db.run(`DELETE FROM backlog_starts ${where}`, [owner, repo, note.task]);
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
// the task back. A thread that can't be recorded puts it back at once. Throws when the backlog no
// longer has the task.
export function startFiled<T>(
  db: Database,
  repository: Repository,
  folder: string,
  name: string,
  record: () => T,
): Promise<T> {
  return inTurn(repository, async () => {
    const { owner, repo } = repository;
    const where = "WHERE owner = ? AND repo = ? AND task = ?";
    const task = filedTask(db, owner, repo, name);
    if (!task) throw new Error(`${taskName(repository.name, name)} is no longer in the backlog`);
    // An earlier start of this task whose outcome nobody heard left its note. It is settled
    // first, never replaced: with its claim on the remote, that start won, and this one goes on
    // from it. With none, the note goes. With no answer, the note stays and the start is refused,
    // as either way could be true.
    const earlier = z
      .object({ started_commit: z.string() })
      .nullable()
      .parse(db.query(`SELECT started_commit FROM backlog_starts ${where}`).get(owner, repo, name));
    let won = false;
    let commit = "";
    if (earlier) {
      const holds = await remoteRef(db, repository, startedRef(name)).catch((error) => {
        throw new Error(
          `Skelcrew can't tell whether its earlier start of ${taskName(repository.name, name)} reached the remote, so it starts nothing: ${errorText(error)}`,
        );
      });
      won = holds === earlier.started_commit;
      if (won) commit = earlier.started_commit;
      else db.run(`DELETE FROM backlog_starts ${where}`, [owner, repo, name]);
    }
    if (!won) {
      // The claim's commit carries the task's words, so it can be put back.
      const kept = { title: task.title, body: task.body, created: task.created, by: task.by };
      const message = `Skelcrew starts ${name}: ${crypto.randomUUID()}\n\n${JSON.stringify(kept)}`;
      const claim = await makeCommit(db, repository, folder, message);
      commit = claim;
      db.run("INSERT INTO backlog_starts (owner, repo, task, started_commit) VALUES (?, ?, ?, ?)", [
        owner,
        repo,
        name,
        claim,
      ]);
      try {
        await moveRefs(db, repository, folder, [
          { ref: filedRef(name), was: task.commit, now: "" },
          { ref: startedRef(name), was: "", now: claim },
        ]);
      } catch (error) {
        // A push can reach the remote and fail only on its way back, so the remote is asked
        // whose claim it holds. With this one, the start goes on. With none or another's, it
        // never got it. With no answer, the note stays, and a retry or the next refresh
        // settles it.
        const holds = await remoteRef(db, repository, startedRef(name)).catch(() => null);
        if (holds !== claim) {
          if (holds !== null) db.run(`DELETE FROM backlog_starts ${where}`, [owner, repo, name]);
          throw new Error(
            `${taskName(repository.name, name)} was started or removed on another machine, or its remote can't be reached: ${errorText(error)}`,
          );
        }
      }
    }
    // The note goes with the thread, in one transaction, as from then on the thread says this
    // machine started it.
    let recorded: T;
    try {
      recorded = db.transaction(() => {
        db.run(`DELETE FROM backlog_starts ${where}`, [owner, repo, name]);
        db.run(`DELETE FROM backlog ${where}`, [owner, repo, name]);
        return record();
      })();
    } catch (error) {
      await moveRefs(db, repository, folder, [
        { ref: filedRef(name), was: "", now: commit },
        endClaim(name, commit),
      ])
        .then(() => db.run(`DELETE FROM backlog_starts ${where}`, [owner, repo, name]))
        .catch((failed) =>
          console.log(`couldn't put ${taskName(repository.name, name)} back: ${errorText(failed)}`),
        );
      throw error;
    }
    // A claim that can't be removed now is removed by the next refresh.
    await moveRefs(db, repository, folder, [endClaim(name, commit)]).catch((error) =>
      console.log(
        `couldn't finish starting ${taskName(repository.name, name)}: ${errorText(error)}`,
      ),
    );
    return recorded;
  });
}

// Removes a task of the backlog that never started, on its remote from Skelcrew's clone in the
// folder and in the daemon's copy, for sc rm. Its words were only on its ref, which goes. Its
// name stays claimed. Throws when the backlog no longer has it, or another machine started or
// removed it since this one read it.
export function unfileTask(
  db: Database,
  repository: Repository,
  folder: string,
  name: string,
): Promise<void> {
  return inTurn(repository, async () => {
    const { owner, repo } = repository;
    const task = filedTask(db, owner, repo, name);
    if (!task) throw new Error(`${taskName(repository.name, name)} is no longer in the backlog`);
    try {
      await moveRefs(db, repository, folder, [{ ref: filedRef(name), was: task.commit, now: "" }]);
    } catch (error) {
      throw new Error(
        `${taskName(repository.name, name)} was started or removed on another machine, or its remote can't be reached: ${errorText(error)}`,
      );
    }
    db.run("DELETE FROM backlog WHERE owner = ? AND repo = ? AND task = ?", [owner, repo, name]);
  });
}
