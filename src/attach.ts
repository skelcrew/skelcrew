// Showing you a repository's lead on the screen or in the list, or a thread's builder full
// screen, with plain sc, sc --list and sc attach.
import { z } from "zod";
import { agentRuns, attachSession } from "./agents/sessions.ts";
import { askAboutAgents } from "./approved-agents.ts";
import { ask } from "./client.ts";
import { tellOldKeys } from "./config.ts";
import { openDb } from "./db.ts";
import { builderSession, findThread, resolveTask, threadName } from "./flow/thread.ts";
import { runList } from "./list/list.ts";
import { ensureDaemon } from "./machine/service.ts";
import { attachOnHost } from "./plugins/runtime.ts";
import { openScreen } from "./screen/screen.ts";

const LeadReply = z.union([
  z.object({ lead: z.string(), repository: z.string() }),
  z.object({ closed: z.literal(true) }),
  z.object({ agents: z.object({ owner: z.string(), repo: z.string(), name: z.string() }) }),
  z.object({ error: z.string() }),
]);

export async function attachToLead(
  sessions: string,
  list: boolean,
  from?: string,
  tab = false,
): Promise<boolean> {
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
  await openScreen(sessions, lead.lead, lead.lead, lead.repository);
  return true;
}

export async function attachToThread(
  sessions: string,
  repository: string,
  task: string,
): Promise<void> {
  const db = openDb();
  const thread = findThread(db, repository, resolveTask(db, repository, task));
  const { host, id } = await builderSession(db, sessions, thread);
  if (!(await agentRuns(host, id)))
    throw new Error(
      `${threadName(db, thread)}'s builder isn't running: the thread is ${thread.status}`,
    );
  await ensureDaemon();
  if (typeof host !== "string") return attachOnHost(host, id);
  const failed = await attachSession(host, id);
  if (failed) throw new Error(failed);
}
