// The lead: your Claude Code session on this machine, in its own folder, kept alive in tmux.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir, leadSocket } from "./paths.ts";
import { agentCommand } from "./sandbox.ts";
import { endSession, failedScreen, hasSession, startServer, startSession } from "./tmux.ts";

const Lead = z.object({ session: z.string() }).nullable();
const Path = z.object({ path: z.string() });

// Claude Code saves a conversation only once it has a message, so a lead nobody talked to
// has nothing to resume, and its id can't start a new one either. It saves it in the
// session's own config folder, under a folder named after the folder it runs in, with every
// character but letters and digits made a dash. Names over 200 characters get a hash
// instead, which the lead's folder never comes near.
function hasTranscript(folder: string, session: string): boolean {
  const project = folder.replace(/[^a-zA-Z0-9]/g, "-");
  return existsSync(join(dataDir(), "claude", "lead", "projects", project, `${session}.jsonl`));
}

// skel picks the session id rather than Claude Code, so it is stored before the lead starts
// and the lead can be brought back with --resume after its session is gone.
export async function startLead(db: Database, tmux: string): Promise<void> {
  if (hasSession(tmux, "lead")) {
    const failed = failedScreen(tmux, "lead");
    if (failed === null) return;
    console.log(`The lead had ended:\n${failed}`);
    endSession(tmux, "lead");
  }
  startServer(tmux);
  const folder = join(dataDir(), "lead");
  const stored = Lead.parse(db.query("SELECT session FROM lead").get());
  const resume = stored !== null && hasTranscript(folder, stored.session);
  const session = resume ? stored.session : crypto.randomUUID();
  db.run("INSERT OR REPLACE INTO lead (one, session) VALUES (1, ?)", [session]);
  // Repositories added after this aren't in its sandbox until the lead starts again.
  const repositories = db
    .query("SELECT path FROM repositories ORDER BY name")
    .all()
    .map((row) => Path.parse(row).path);
  const { argv, env } = agentCommand({
    repositories,
    name: "lead",
    socket: leadSocket(),
    model: "opus",
    ...(resume ? { resume: session } : { sessionId: session }),
  });
  startSession(tmux, "lead", { folder, command: argv, env });
  console.log(`${resume ? "Brought back" : "Started"} the lead, session ${session}.`);
  // A lead that can't start, such as one whose login is gone, ends within moments, and
  // attaching would only find it gone.
  await Bun.sleep(1000);
  const failed = failedScreen(tmux, "lead");
  if (failed !== null) endSession(tmux, "lead");
  if (failed !== null || !hasSession(tmux, "lead"))
    throw new Error(`the lead exited as soon as it started:\n${failed ?? ""}`);
}
