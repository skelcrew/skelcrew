// Showing you a repository's lead on the screen or in the list, or a thread's builder full
// screen, with plain sc, sc --list and sc attach.
import { z } from "zod";
import { agentRuns, attachSession } from "./agents/sessions.ts";
import { askAboutAgents } from "./approved-agents.ts";
import { ask } from "./client.ts";
import { tellOldKeys } from "./config.ts";
import { openDb } from "./db.ts";
import { builderSession, findThread, taskName } from "./flow/thread.ts";
import { runList } from "./list/list.ts";
import { ensureDaemon } from "./machine/service.ts";
import { attachOnHost } from "./plugins/runtime.ts";
import { openScreen } from "./screen/screen.ts";

// The daemon's answer when asked for a lead: the lead's session and its repository's
// owner/name, that every tab is closed when only an open tab would do, or why it has none.
const LeadReply = z.union([
  z.object({ lead: z.string(), repository: z.string() }),
  z.object({ closed: z.literal(true) }),
  z.object({ agents: z.object({ owner: z.string(), repo: z.string(), name: z.string() }) }),
  z.object({ error: z.string() }),
]);

// Makes sure a lead is running, then opens the screen on the lead until you leave with Alt-Q,
// or with `list` shows the list of the lead's repository until you leave it with q. Both exist
// side by side until the human picks one. The daemon must already run, as plain sc starts it
// first. The lead is for `from`, an owner/repo, or else for the repository you opened last.
// With `tab`, only a repository whose tab is open will do. Returns false, showing nothing, when
// every tab is closed. Before it shows either, it names once any old keys the opened
// repository's skelcrew.yaml still uses, and before its lead starts, asks about an .agents/ you
// never answered for: only the daemon knows which repository you opened last.
export async function attachToLead(
  sessions: string,
  list: boolean,
  from?: string,
  tab = false,
): Promise<boolean> {
  // Asking for the lead brings it back if it ended while the daemon kept running. Starting it
  // takes longer than a status, hence the longer wait. The daemon may first hand back the
  // repository it would open, for you to answer about its .agents/ before its lead starts. sc
  // then asks again, and the daemon may pick another repository by then, which is asked about
  // the same way.
  let asked: string | undefined;
  let lead: z.infer<typeof LeadReply>;
  while (true) {
    const reply = await ask(
      {
        command: "lead",
        ...(from ? { from } : {}),
        ...(tab ? { tab } : {}),
        ...(asked ? { asked } : {}),
      },
      15_000,
    );
    if (reply === null) throw new Error("the daemon didn't answer: run sc to start it");
    const parsed = LeadReply.safeParse(reply);
    if (!parsed.success)
      throw new Error("the daemon answered in a way this Skelcrew doesn't understand");
    lead = parsed.data;
    if (!("agents" in lead)) break;
    askAboutAgents(lead.agents, lead.agents.name);
    asked = `${lead.agents.owner}/${lead.agents.repo}`;
  }
  if ("error" in lead) throw new Error(lead.error);
  if ("closed" in lead) return false;
  tellOldKeys(lead.repository);
  if (list) {
    await runList(sessions, lead.repository);
    return true;
  }
  // The screen opens on any session host: a lead on a runtime plugin's host shows on its right
  // through that host's own attach.
  await openScreen(sessions, lead.lead, lead.lead, lead.repository);
  return true;
}

// Attaches your terminal full screen to a thread's builder, with no sidebar, as Enter does
// from the list, and returns when you leave it with Ctrl-\ or the builder ends. Only you can
// run it, since it takes over your terminal. It checks the builder is running before it starts
// the daemon. A builder on a runtime plugin's host is attached through that host instead.
export async function attachToThread(
  sessions: string,
  repository: string,
  task: string,
): Promise<void> {
  const db = openDb();
  const thread = findThread(db, repository, task);
  const { host, id } = await builderSession(db, sessions, thread);
  // A builder that exited leaves its last screen behind, which would look like it still runs.
  if (!(await agentRuns(host, id)))
    throw new Error(
      `${taskName(repository, task)}'s builder isn't running: the thread is ${thread.status}`,
    );
  // Its hooks and sc reach the daemon wherever it runs, so the daemon runs first on any host.
  await ensureDaemon();
  if (typeof host !== "string") return attachOnHost(host, id);
  const failed = await attachSession(host, id);
  if (failed) throw new Error(failed);
}
