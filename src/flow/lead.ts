// Each repository's lead: your agent session for that repository on this machine, in its own
// folder, kept alive in tmux, and the notes skel types into it.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
// What the lead is and how it hands work to threads. Without it, told "fix the flaky test",
// it would try to edit the read-only clone rather than start a thread. It is a plain file so
// it reads and changes like a doc, and Bun builds it into skel. It reaches the lead in every
// turn, so every line costs context: keep it short, and promise only what is built.
import instructions from "../agents/prompts/lead.md" with { type: "text" };
import {
  agentRuns,
  checkItLived,
  endSession,
  failedScreen,
  hasSession,
  isIdle,
  startServer,
  startSession,
  typeInto,
} from "../agents/tmux.ts";
import { agentHarness, agentRoles } from "../config.ts";
import { Repository } from "../db.ts";
import { cloneDir, leadPlaces } from "../paths.ts";
import { errorText } from "../say.ts";
import { refreshClones, repositories } from "./repo.ts";
import { readThread, record, Thread, threadName } from "./thread.ts";

const LeadRow = z.object({ lead_session: z.string().nullable(), kept_lead: z.coerce.boolean() });
const Note = z.object({ id: z.number(), text: z.string() }).nullable();

// Returns a repository's lead: where it lives, as leadPlaces gives it, and the session ID of
// its conversation, or null before it first started. Throws when skel doesn't have the
// repository.
export function leadOf(db: Database, owner: string, repo: string) {
  const row = db
    .query("SELECT lead_session, kept_lead FROM repositories WHERE owner = ? AND repo = ?")
    .get(owner, repo);
  if (!row) throw new Error(`skel doesn't have ${owner}/${repo}`);
  const { lead_session, kept_lead } = LeadRow.parse(row);
  return { ...leadPlaces(owner, repo, kept_lead), session: lead_session };
}

// Returns the repositories you have opened, whose leads the daemon keeps running.
export const openedRepositories = (db: Database) =>
  db
    .query("SELECT name, owner, repo FROM repositories WHERE opened IS NOT NULL ORDER BY name")
    .all()
    .map((row) => Repository.parse(row));

// Returns the repository you opened last, for plain skel outside any repository, or the first
// by name while you have opened none. Null while skel has no repositories.
export function lastOpened(db: Database): Repository | null {
  const row = db
    .query(
      "SELECT name, owner, repo FROM repositories ORDER BY opened IS NULL, opened DESC, name LIMIT 1",
    )
    .get();
  return Repository.nullable().parse(row);
}

// Keeps a repository's running lead or starts it, resuming its saved conversation when there
// is one. skel picks the session id rather than the harness, so it is stored before the lead
// starts and the lead can be brought back with --resume after its session is gone.
export async function startLead(db: Database, tmux: string, repository: Repository): Promise<void> {
  const { owner, repo } = repository;
  const lead = leadOf(db, owner, repo);
  if (hasSession(tmux, lead.name)) {
    const failed = failedScreen(tmux, lead.name);
    if (failed === null) return;
    console.log(`${owner}/${repo}'s lead had ended:\n${failed}`);
    endSession(tmux, lead.name);
  }
  startServer(tmux);
  // The lead's sandbox mounts its clone, and can't mount one that is missing. Adding a
  // repository clones it, so this waits only when that clone failed or has gone since.
  const clone = cloneDir(owner, repo);
  if (!existsSync(clone)) await refreshClones(db);
  if (!existsSync(clone))
    throw new Error(`skel couldn't clone ${owner}/${repo}, so its lead can't start yet`);
  const harness = agentHarness();
  const stored = lead.session;
  const resume = stored !== null && harness.saved(lead.name, lead.folder, stored) ? stored : null;
  const session = resume ?? crypto.randomUUID();
  db.run("UPDATE repositories SET lead_session = ? WHERE owner = ? AND repo = ?", [
    session,
    owner,
    repo,
  ]);
  const { argv, env } = harness.start({
    name: lead.name,
    socket: lead.socket,
    model: agentRoles().lead.model,
    folder: lead.folder,
    origin: clone,
    // By its full GitHub name, which every command takes and which never changes, while its
    // name in skel can gain its owner.
    system: `${instructions}\nYou are the lead of ${owner}/${repo}. skel's clone of it is at ${clone}.`,
    ...(resume ? { resume } : { sessionId: session }),
  });
  startSession(tmux, lead.name, { folder: lead.folder, command: argv, env });
  // GitHub can be slow or away, and attaching waits on this.
  refreshClones(db).catch((error) => console.log(String(error)));
  console.log(
    `${resume ? "Brought back" : "Started"} ${owner}/${repo}'s lead, session ${session}.`,
  );
  await checkItLived(tmux, lead.name, "lead");
}

// Types each saved note for a repository's lead into it, one at a time, such as "started
// app-12 from GitHub: Fix the login redirect" or "app-12 needs you: its builder asked a
// question", and forgets it once typed. It waits as long as the lead is busy, checking again
// each time whether a note about a thread needing you is still wanted, so a question you
// answered meanwhile is never announced. A lead that isn't running, or never started, gets
// nothing: its notes stay saved until it starts.
async function typeNotes(db: Database, tmux: string, owner: string, repo: string): Promise<void> {
  const { name } = leadOf(db, owner, repo);
  const where = "owner = ? AND repo = ?";
  for (;;) {
    const note = Note.parse(
      db.query(`SELECT id, text FROM notes WHERE ${where} ORDER BY id`).get(owner, repo),
    );
    const row = db
      .query(`SELECT * FROM threads WHERE noting IS NOT NULL AND ${where} ORDER BY rowid`)
      .get(owner, repo);
    const thread = Thread.nullable().parse(row);
    if (note === null && (thread === null || thread.noting === null)) return;
    if (!agentRuns(tmux, name)) return;
    const { marks } = agentHarness();
    if (!(await isIdle(tmux, name, marks))) continue;
    if (note !== null) {
      await typeInto(tmux, name, marks, note.text);
      db.run("DELETE FROM notes WHERE id = ?", [note.id]);
      continue;
    }
    if (thread === null || thread.noting === null) return;
    await typeInto(tmux, name, marks, `${threadName(db, thread)} needs you: ${thread.noting}`);
    // The thread may have stopped needing you and started again while this was typed.
    if (readThread(db, thread.folder).noting === thread.noting)
      record(db, thread.folder, { noting: null }, "told the lead it needs you");
  }
}

// Each repository's notes being typed, by its GitHub name.
const telling = new Map<string, Promise<void>>();

// Has the daemon type the saved notes into each repository's lead, and returns at once, so
// the round or request that saved a note never waits on a lead. Each lead's notes go one
// after another, so a note is never pasted twice, nor two before either's Enter, while a busy
// lead holds up no other. A note that fails to be typed stays saved, and the next call, at
// the next note, the next skel attach or the daemon's next start, tries it again.
export function tellLead(db: Database, tmux: string): void {
  for (const { owner, repo } of repositories(db)) {
    const key = `${owner}/${repo}`;
    const before = telling.get(key) ?? Promise.resolve();
    telling.set(
      key,
      before
        .then(() => typeNotes(db, tmux, owner, repo))
        .catch((error) => console.log(`couldn't tell ${key}'s lead: ${errorText(error)}`)),
    );
  }
}

// Saves a note for the lead of a repository, and has the daemon type it in. Notes already
// wait while the lead is busy, and stay saved while it isn't running, so a note is never lost.
export function noteForLead(
  db: Database,
  tmux: string,
  repository: { owner: string; repo: string },
  text: string,
): void {
  db.run("INSERT INTO notes (owner, repo, text) VALUES (?, ?, ?)", [
    repository.owner,
    repository.repo,
    text,
  ]);
  tellLead(db, tmux);
}
