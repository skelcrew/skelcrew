// The lead: your Claude Code session on this machine, in its own folder, kept alive in tmux.
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.ts";
import { hasSession, startSession } from "./tmux.ts";

const Lead = z.object({ session: z.string() }).nullable();

// Once the sandbox lands, this returns agentCommand from sandbox.ts for the lead, which
// already gives an argv and env in this shape. Until then Claude Code runs directly, and
// tmux.ts keeps inherited CLAUDE_CODE_* variables out of the session.
function leadCommand(session: string, resume: boolean) {
  return { argv: ["claude", resume ? "--resume" : "--session-id", session], env: {} };
}

// skel picks the session id rather than Claude Code, so it is stored before the lead starts
// and a lead whose session is gone can always be brought back with --resume.
export function startLead(db: Database, tmux: string): void {
  if (hasSession(tmux, "lead")) {
    console.log("The lead is running.");
    return;
  }
  const folder = join(dataDir(), "lead");
  mkdirSync(folder, { recursive: true });
  const stored = Lead.parse(db.query("SELECT session FROM lead").get());
  const session = stored?.session ?? crypto.randomUUID();
  if (!stored) db.run("INSERT INTO lead (one, session) VALUES (1, ?)", [session]);
  const { argv, env } = leadCommand(session, stored !== null);
  startSession(tmux, "lead", { folder, command: argv, env });
  console.log(`${stored ? "Brought back" : "Started"} the lead, session ${session}.`);
}
