// Each repository's lead: your agent session for that repository on this machine, in its own
// folder, kept alive in a session of its own.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
import { HarnessName, harnessNamed } from "../agents/harness.ts";
import {
  checkAgentStarted,
  endSession,
  exitedCleanly,
  failedScreen,
  hasSession,
  keepOnExit,
  type Labels,
  startSession,
} from "../agents/sessions.ts";
import { agentRole, repositoryCommands } from "../config.ts";
import { Repository } from "../db.ts";
import { cloneDir, leadPlaces } from "../paths.ts";
import { repositoryRole } from "../roles.ts";
import { errorText } from "../say.ts";
import type { Settings } from "../settings.ts";
import { refreshClones } from "./repo.ts";

// What Skelcrew's database keeps about a repository's lead, checked as it is read back.
const LeadRow = z.object({
  lead_session: z.string().nullable(),
  lead_harness: HarnessName.nullable(),
  kept_lead: z.coerce.boolean(),
});

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

// Returns the lead's instructions: its role's, from `role`, the repository it leads and where its
// clone is, then the setup and test commands its skelcrew.yaml or your config names, each on its
// own, or that none is configured. The lead can't read your config from its sandbox, so it is
// told, and proposes to you only the commands that are missing. They are as of the lead's start:
// once a thread adds them to skelcrew.yaml, the lead reads them there.
export function leadInstructions(
  role: string,
  repository: string,
  clone: string,
  commands: Pick<Settings, "setup" | "test">,
): string {
  const { setup, test } = commands;
  const shown = (list: string[]) => `\`${list.join(" && ")}\``;
  // An empty list says on purpose that there is none, so the lead doesn't propose one.
  const setupTold =
    setup === undefined
      ? "no setup command was configured"
      : setup.length === 0
        ? "setup was configured as none"
        : `the setup command was ${shown(setup)}`;
  const testTold =
    test === undefined
      ? "no test command was configured"
      : test.length === 0
        ? "test was configured as none"
        : `the test command was ${shown(test)}`;
  return `${role}\nYou are the lead of ${repository}. Skelcrew's clone of it is at ${clone}.\nWhen this session started, ${setupTold}, and ${testTold}.\n`;
}

// Keeps a repository's running lead or starts it, resuming its saved conversation when there
// is one. A lead's first start picks the harness your config names for leads, and the lead
// keeps it from then on, as a conversation can't move to another harness. The session id and
// harness are stored before the lead starts, so the lead can be brought back after its session
// is gone. Codex picks its own id, and its module finds the conversation it saved.
export async function startLead(
  db: Database,
  sessions: string,
  repository: Repository,
): Promise<void> {
  const { owner, repo } = repository;
  const lead = leadOf(db, owner, repo);
  // A lead still running is kept. One started by a release before leads stayed on a clean exit
  // is given that setting now, or exiting it would end its session and never close its tab.
  // One whose harness ended leaves its screen behind, which is logged before its session is
  // ended to make room for the new one.
  if (hasSession(sessions, lead.name)) {
    const failed = failedScreen(sessions, lead.name);
    if (failed === null) {
      keepOnExit(sessions, lead.name);
      return;
    }
    console.log(`${owner}/${repo}'s lead had ended:\n${failed}`);
    endSession(sessions, lead.name);
  }
  // The lead's sandbox mounts its clone, and can't mount one that is missing. Adding a
  // repository clones it, so this waits only when that clone failed or has gone since.
  const clone = cloneDir(owner, repo);
  if (!existsSync(clone)) await refreshClones(db);
  if (!existsSync(clone))
    throw new Error(`Skelcrew couldn't clone ${owner}/${repo}, so its lead can't start yet`);
  // Pick the harness and the conversation to bring back, if the harness still has it, and save
  // both before starting.
  const role = agentRole("lead", repository);
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
    // The lead's role comes from the .agents/ you approved, as it is when the lead starts. The
    // repository is named by its owner/name, which every command takes and which never
    // changes, while its name in Skelcrew can gain its owner.
    system: leadInstructions(
      repositoryRole("lead", repository).instructions,
      `${owner}/${repo}`,
      clone,
      repositoryCommands(repository),
    ),
    ...(resume ? { resume } : { sessionId: session }),
  });
  // The session stays when the lead exits, so closeExitedLeads can tell exiting it from a crash.
  const labels: Labels = { repository: `${owner}/${repo}`, role: "lead" };
  startSession(sessions, lead.name, {
    folder: lead.folder,
    command: argv,
    env,
    labels,
    keepOnExit: true,
  });
  // A remote can be slow or away, and attaching waits on this.
  refreshClones(db).catch((error) => console.log(errorText(error)));
  console.log(
    `${resume ? "Brought back" : "Started"} ${owner}/${repo}'s lead, session ${session}.`,
  );
  await checkAgentStarted(sessions, lead.name, "lead");
}

// Closes the tab of each repository whose lead you exited, such as with /exit, and ends its
// session. A lead that crashed exits with another code and keeps its tab. The daemon looks at
// its start and every second, so a lead that exited while no screen was open, or while the
// daemon was down, has its tab closed too. Only the lead ends: the repository, its threads and
// its clone stay, and its conversation is kept for when you open it again. The tab is marked
// closed before the session ends, so a sidebar that finds the session gone also finds the tab
// closed, and doesn't bring the lead back.
export function closeExitedLeads(db: Database, sessions: string): void {
  for (const { owner, repo } of openedRepositories(db)) {
    const { name } = leadOf(db, owner, repo);
    if (!exitedCleanly(sessions, name)) continue;
    db.run("UPDATE repositories SET tab_closed = 1 WHERE owner = ? AND repo = ?", [owner, repo]);
    endSession(sessions, name);
    console.log(`${owner}/${repo}'s lead exited, so its tab is closed until you open it again.`);
  }
}
