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
import { refreshClones, repositories } from "./repo.ts";
import { agentCommand, hasTranscript } from "./sandbox.ts";
import {
  endSession,
  failedScreen,
  hasSession,
  startServer,
  startSession,
  typeInto,
} from "./tmux.ts";

const Lead = z.object({ session: z.string() }).nullable();
const Attached = z.object({ repo: z.string() }).nullable();

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

let telling: Promise<void> = Promise.resolve();

// Tells the lead which repository you attached from when it differs from what it was last
// told, so "fix the flaky test" means that repository's. Returns at once: you land in the
// lead while the note waits for it to be idle. Notes go one after another, so each compares
// with what the one before it told the lead.
export function tellAttachedFrom(db: Database, tmux: string, from: string | undefined): void {
  telling = telling
    .then(() => tellIfChanged(db, tmux, from))
    .catch((error) => console.log(`The lead wasn't told where you attached from: ${error}`));
}

// Types the note when the repository changed, and remembers it only once typed, so a note
// that never got through comes again on the next attach.
async function tellIfChanged(db: Database, tmux: string, from: string | undefined) {
  const full = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;
  // One skel doesn't have yet, such as one waiting for skel repo trust, is no default.
  const found = repositories(db).find((r) => full(r).toLowerCase() === from?.toLowerCase());
  const now = found ? full(found) : "";
  const told = Attached.parse(db.query("SELECT repo FROM attached").get());
  // A lead never told of a repository has none to forget.
  if ((told?.repo ?? "") === now) return;
  const note = found
    ? `you attached from ${found.name}`
    : "you attached from outside any of skel's repositories";
  // The lead can be busy with a long turn when you attach, and the note can wait for it.
  await typeInto(tmux, "lead", note, { timeout: 15 * 60_000 });
  db.run("INSERT OR REPLACE INTO attached (one, repo) VALUES (1, ?)", [now]);
}
