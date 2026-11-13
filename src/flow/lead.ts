// Each repository's lead: your agent session for that repository on this machine, in its own
// folder, kept alive in tmux, and the notes Skelcrew types into it.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
import { HarnessName, harnessNamed } from "../agents/harness.ts";
// What the lead is and how it hands work to threads. Without it, told "fix the flaky test",
// it would try to edit the read-only clone rather than start a thread. It is a plain file so
// it reads and changes like a doc, and Bun builds it into Skelcrew. It reaches the lead in every
// turn, so every line costs context: keep it short, and promise only what is built.
import instructions from "../agents/prompts/lead.md" with { type: "text" };
import {
  agentRuns,
  checkAgentStarted,
  endSession,
  exitedCleanly,
  failedScreen,
  hasSession,
  keepOnExit,
  startServer,
  startSession,
} from "../agents/tmux.ts";
import { isIdle, typeInto } from "../agents/typing.ts";
import { agentRoles } from "../config.ts";
import { Repository } from "../db.ts";
import { cloneDir, leadPlaces } from "../paths.ts";
import { errorText } from "../say.ts";
import { refreshClones, repositories } from "./repo.ts";
import { readThread, record, Thread, threadName } from "./thread.ts";

// What Skelcrew's database keeps about a repository's lead, checked as it is read back.
const LeadRow = z.object({
  lead_session: z.string().nullable(),
  lead_harness: HarnessName.nullable(),
  kept_lead: z.coerce.boolean(),
});
// A note waiting to be typed into a lead, or null when none waits.
const Note = z.object({ id: z.number(), text: z.string() }).nullable();

// Returns a repository's lead: where it lives, as leadPlaces gives it, the session ID of its
// conversation, and the harness it started on, both null before it first started. A lead that
// started before Skelcrew saved its harness ran on Claude Code, the only one then. Throws when
// Skelcrew doesn't have the repository.
export function leadOf(db: Database, owner: string, repo: string) {
  const row = db
    .query(
      "SELECT lead_session, lead_harness, kept_lead FROM repositories WHERE owner = ? AND repo = ?",
    )
    .get(owner, repo);
  if (!row) throw new Error(`Skelcrew doesn't have ${owner}/${repo}`);
  const { lead_session, lead_harness, kept_lead } = LeadRow.parse(row);
  const harness = lead_harness ?? (lead_session === null ? null : "claude");
  return { ...leadPlaces(owner, repo, kept_lead), session: lead_session, harness };
}

// Returns the repositories you have opened and whose tabs are open, whose leads the daemon
// keeps running.
export const openedRepositories = (db: Database) =>
  db
    .query(
      "SELECT name, owner, repo, forge, remote FROM repositories WHERE opened IS NOT NULL AND tab_closed = 0 ORDER BY name",
    )
    .all()
    .map((row) => Repository.parse(row));

// Returns the repository you opened last, for plain sc outside any repository, or the first
// by name while you have opened none. One whose tab is open comes before any whose tab you
// closed, which opens only when no tab is left. Null while Skelcrew has no repositories.
export function lastOpened(db: Database): Repository | null {
  const row = db
    .query(
      "SELECT name, owner, repo, forge, remote FROM repositories ORDER BY tab_closed, opened IS NULL, opened DESC, name LIMIT 1",
    )
    .get();
  return Repository.nullable().parse(row);
}

// Keeps a repository's running lead or starts it, resuming its saved conversation when there
// is one. A lead's first start picks the harness your config names for leads, and the lead
// keeps it from then on, as a conversation can't move to another harness. The session id and
// harness are stored before the lead starts, so the lead can be brought back after its session
// is gone. Codex picks its own id, and its module finds the conversation it saved.
export async function startLead(db: Database, tmux: string, repository: Repository): Promise<void> {
  const { owner, repo } = repository;
  const lead = leadOf(db, owner, repo);
  // A lead still running is kept, and stays when it exits, as one an older Skelcrew started
  // would go with its session and its tab would never close. One whose harness ended leaves
  // its screen behind, which is logged before its session is ended to make room for the new one.
  if (hasSession(tmux, lead.name)) {
    const failed = failedScreen(tmux, lead.name);
    if (failed === null) {
      keepOnExit(tmux, lead.name);
      return;
    }
    console.log(`${owner}/${repo}'s lead had ended:\n${failed}`);
    endSession(tmux, lead.name);
  }
  startServer(tmux);
  // The lead's sandbox mounts its clone, and can't mount one that is missing. Adding a
  // repository clones it, so this waits only when that clone failed or has gone since.
  const clone = cloneDir(owner, repo);
  if (!existsSync(clone)) await refreshClones(db);
  if (!existsSync(clone))
    throw new Error(`Skelcrew couldn't clone ${owner}/${repo}, so its lead can't start yet`);
  // Pick the harness and the conversation to bring back, if the harness still has it, and save
  // both before starting.
  const role = agentRoles(repository).lead;
  const harness = harnessNamed(lead.harness ?? role.harness);
  const stored = lead.session;
  const resume = stored === null ? null : harness.saved(lead.name, lead.folder, stored);
  const session = resume ?? crypto.randomUUID();
  db.run(
    "UPDATE repositories SET lead_session = ?, lead_harness = ? WHERE owner = ? AND repo = ?",
    [session, harness.name, owner, repo],
  );
  const { argv, env } = await harness.start({
    name: lead.name,
    socket: lead.socket,
    // A model name belongs to its harness, so a lead on another one than your config now names
    // for leads gets that harness's default.
    model: role.harness === harness.name ? role.model : undefined,
    folder: lead.folder,
    origin: clone,
    // By its owner/name, which every command takes and which never changes, while its
    // name in Skelcrew can gain its owner.
    system: `${instructions}\nYou are the lead of ${owner}/${repo}. Skelcrew's clone of it is at ${clone}.`,
    ...(resume ? { resume } : { sessionId: session }),
  });
  // The session stays when the lead exits, so closeExitedLeads can tell exiting it from a crash.
  startSession(tmux, lead.name, { folder: lead.folder, command: argv, env, keepOnExit: true });
  // A remote can be slow or away, and attaching waits on this.
  refreshClones(db).catch((error) => console.log(errorText(error)));
  console.log(
    `${resume ? "Brought back" : "Started"} ${owner}/${repo}'s lead, session ${session}.`,
  );
  await checkAgentStarted(tmux, lead.name, "lead");
}

// Closes the tab of each repository whose lead you exited, such as with /exit, and ends its
// session. A lead that crashed exits with another code and keeps its tab. The daemon looks at
// its start and every second, so a lead that exited while no screen was open, or while the
// daemon was down, has its tab closed too. Only the lead ends: the repository, its threads and
// its clone stay, and its conversation is kept for when you open it again. The tab is marked
// closed before the session ends, so a sidebar that finds the session gone also finds the tab
// closed, and doesn't bring the lead back.
export function closeExitedLeads(db: Database, tmux: string): void {
  for (const { owner, repo } of openedRepositories(db)) {
    const { name } = leadOf(db, owner, repo);
    if (!exitedCleanly(tmux, name)) continue;
    db.run("UPDATE repositories SET tab_closed = 1 WHERE owner = ? AND repo = ?", [owner, repo]);
    endSession(tmux, name);
    console.log(`${owner}/${repo}'s lead exited, so its tab is closed until you open it again.`);
  }
}

// Types each saved note for a repository's lead into it, one at a time, such as "started
// app-12 from github: Fix the login redirect" or "app-12 needs you: its builder asked a
// question", and forgets it once typed. It waits as long as the lead is busy, checking again
// each time whether a note about a thread needing you is still wanted, so a question you
// answered meanwhile is never announced. A lead that isn't running, or never started, gets
// nothing: its notes stay saved until it starts.
async function typeNotes(db: Database, tmux: string, owner: string, repo: string): Promise<void> {
  const { name, harness } = leadOf(db, owner, repo);
  const where = "owner = ? AND repo = ?";
  // Each pass reads the oldest note and the first thread waiting to be announced, so what was
  // saved while typing is seen too.
  while (true) {
    const note = Note.parse(
      db.query(`SELECT id, text FROM notes WHERE ${where} ORDER BY id`).get(owner, repo),
    );
    const row = db
      .query(`SELECT * FROM threads WHERE noting IS NOT NULL AND ${where} ORDER BY rowid`)
      .get(owner, repo);
    const thread = Thread.nullable().parse(row);
    // Stop when nothing is left to say, or nobody is there to hear it. Wait while the lead is busy.
    if (note === null && (thread === null || thread.noting === null)) return;
    if (!agentRuns(tmux, name)) return;
    // A lead that is running has started, so it has a harness.
    const { marks } = harnessNamed(harness ?? "claude");
    if (!(await isIdle(tmux, name, marks))) continue;
    // Saved notes go first, then a thread that needs you.
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

// The note typing under way for each repository's lead, by its owner/name.
const noteTyping = new Map<string, Promise<void>>();

// Types the saved notes into each repository's lead, and returns at once, so the round or
// request that saved a note never waits on a lead. Each lead's notes are typed one after
// another, so a note is never pasted twice, and two notes never share one Enter. A busy lead
// holds up no other lead. A note that fails to be typed stays saved. The next call tries it
// again: at the next note, the next time you open a lead with sc, or the daemon's next start.
export function typeLeadNotes(db: Database, tmux: string): void {
  for (const { owner, repo } of repositories(db)) {
    // Chain onto the lead's typing under way, so its notes go in one after another.
    const key = `${owner}/${repo}`;
    const before = noteTyping.get(key) ?? Promise.resolve();
    noteTyping.set(
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
  typeLeadNotes(db, tmux);
}
