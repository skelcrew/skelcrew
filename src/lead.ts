// The lead: your Claude Code session on this machine, in its own folder, kept alive in
// tmux.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { dataDir, leadSocket } from "./paths.ts";
import { refreshClones } from "./repo.ts";
import { agentCommand, hasTranscript } from "./sandbox.ts";
import { endSession, failedScreen, hasSession, startServer, startSession } from "./tmux.ts";

const Lead = z.object({ session: z.string() }).nullable();

// What the lead is and how it hands work to threads. Without it, told "fix the flaky test",
// it would try to edit the read-only clones rather than start a thread. It reaches the lead
// in every turn, so every line costs context: keep it short, and promise only what is built.
const instructions = `You are the lead in skel: the human's session on this machine, one per machine, across all their repositories. You plan and hand the work to threads. You never change code yourself: you see skel's clone of every repository read-only, under ~/.local/share/skel/repos/<owner>/<repo>/.

How work happens:
- skel task create <repo> "<title>" "<body>" creates a task, as a GitHub issue, and prints its name, such as app-13. <repo> is the repository's name in skel or its full GitHub name.
- skel start app-13 starts a thread on that task. Its builder works in a clone and branch of its own, and sees only the task's title and body. Write them so a builder with no other context can do the work.
- skel task ls lists open tasks, and skel ps lists threads, with their status and whether they need the human.
- skel attach is for the human's own terminal. Never run skel submit: it is the builder's.

skel works only on repositories it already has. For another, ask the human to bring it in, by running skel in a checkout of it. skel repo trust is only for the human's own terminal.

When a thread needs the human, say so plainly, naming the thread.`;

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
