// The lead: your Claude Code session on this machine, in its own folder, kept alive in tmux.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.ts";
import { endSession, failedScreen, hasSession, startServer, startSession } from "./tmux.ts";

const Lead = z.object({ session: z.string() }).nullable();

// Once the sandbox lands, each session has its own config folder, and this becomes
// join(dataDir(), "claude", "lead").
const leadConfig = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

// Claude Code saves a conversation only once it has a message, so a lead nobody talked to
// has nothing to resume, and its id can't start a new one either. The file sits in a folder
// under projects/ named after the session's folder; looking in each one avoids depending on
// how Claude Code spells that name.
function hasTranscript(config: string, session: string): boolean {
  const projects = join(config, "projects");
  if (!existsSync(projects)) return false;
  return readdirSync(projects).some((folder) =>
    existsSync(join(projects, folder, `${session}.jsonl`)),
  );
}

// Once the sandbox lands, this returns agentCommand from sandbox.ts for the lead, which
// already gives an argv and env in this shape. Until then Claude Code runs directly, and
// tmux.ts keeps inherited CLAUDE_CODE_* variables out of the session.
function leadCommand(session: string, resume: boolean) {
  return { argv: ["claude", resume ? "--resume" : "--session-id", session], env: {} };
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
  mkdirSync(folder, { recursive: true });
  const stored = Lead.parse(db.query("SELECT session FROM lead").get());
  const resume = stored !== null && hasTranscript(leadConfig(), stored.session);
  const session = resume ? stored.session : crypto.randomUUID();
  db.run("INSERT OR REPLACE INTO lead (one, session) VALUES (1, ?)", [session]);
  const { argv, env } = leadCommand(session, resume);
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
