// The lead: your Claude Code session on this machine, in its own folder, kept alive in
// tmux.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { dataDir, leadSocket } from "./paths.ts";
// What the lead is and how it hands work to threads. Without it, told "fix the flaky test",
// it would try to edit the read-only clones rather than start a thread. It is a plain file so
// it reads and changes like a doc, and Bun builds it into skel. It reaches the lead in every
// turn, so every line costs context: keep it short, and promise only what is built.
import instructions from "./prompts/lead.md" with { type: "text" };
import { refreshClones } from "./repo.ts";
import { agentCommand, hasTranscript } from "./sandbox.ts";
import { readThread, record, Thread, threadName } from "./thread.ts";
import {
  endSession,
  failedScreen,
  hasSession,
  isIdle,
  startServer,
  startSession,
  typeInto,
} from "./tmux.ts";

const Lead = z.object({ session: z.string() }).nullable();

// Keeps a running lead or starts one, resuming its saved conversation when available. skel
// picks the session id rather than Claude Code, so it is stored before the lead starts and
// the lead can be brought back with --resume after its session is gone.
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
  const resume = stored !== null && hasTranscript("lead", folder, stored.session);
  const session = resume ? stored.session : crypto.randomUUID();
  db.run("INSERT OR REPLACE INTO lead (one, session) VALUES (1, ?)", [session]);
  const { argv, env } = agentCommand({
    name: "lead",
    socket: leadSocket(),
    model: "opus",
    system: instructions,
    ...(resume ? { resume: session } : { sessionId: session }),
  });
  startSession(tmux, "lead", { folder, command: argv, env });
  // GitHub can be slow or away, and attaching waits on this. The lead sees the whole folder
  // of clones, so clones made after it started show up for it.
  refreshClones(db).catch((error) => console.log(String(error)));
  console.log(`${resume ? "Brought back" : "Started"} the lead, session ${session}.`);
  // A lead that can't start, such as one whose login is gone, ends within moments, and
  // attaching would only find it gone.
  await Bun.sleep(1000);
  const failed = failedScreen(tmux, "lead");
  if (failed !== null) endSession(tmux, "lead");
  if (failed !== null || !hasSession(tmux, "lead"))
    throw new Error(`the lead exited as soon as it started:\n${failed ?? ""}`);
}

// Types each saved note into the lead, one at a time, such as "app-12 needs you: its builder
// asked a question", and forgets it once typed. It waits as long as the lead is busy,
// checking again each time whether the note is still wanted, so a question you answered
// meanwhile is never announced. A lead that isn't running gets nothing: its notes stay saved
// until it starts again.
async function typeNotes(db: Database, tmux: string): Promise<void> {
  for (;;) {
    const row = db.query("SELECT * FROM threads WHERE noting IS NOT NULL ORDER BY rowid").get();
    const thread = Thread.nullable().parse(row);
    if (thread === null || thread.noting === null) return;
    if (!hasSession(tmux, "lead") || failedScreen(tmux, "lead") !== null) return;
    if (!(await isIdle(tmux, "lead"))) continue;
    await typeInto(tmux, "lead", `${threadName(db, thread)} needs you: ${thread.noting}`);
    // The thread may have stopped needing you and started again while this was typed.
    if (readThread(db, thread.folder).noting === thread.noting)
      record(db, thread.folder, { noting: null }, "told the lead it needs you");
  }
}

let telling: Promise<void> = Promise.resolve();

// Has the daemon type the saved notes into the lead, after any it is typing already, and
// returns at once, so the round or request that saved a note never waits on the lead. A
// note that fails to be typed stays saved, and the next call, at the next note, the next
// skel attach or the daemon's next start, tries it again.
export function tellLead(db: Database, tmux: string): void {
  telling = telling
    .then(() => typeNotes(db, tmux))
    .catch((error) =>
      console.log(
        `couldn't tell the lead: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}
