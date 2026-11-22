// The logins Skelcrew copies to its agents, as the daemon keeps them: the sweep of copies whose
// session ended, renewals, and taking the login an earlier release shared once no agent runs on it.
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { z } from "zod";
import { keepLogins, sharedLoginLeft, sharesLogin, takeSharedLogin } from "../agents/harness.ts";
import { agentRuns } from "../agents/sessions.ts";
import { errorText } from "../format.ts";
import { leadAgent, leadOf, leadSession } from "./lead.ts";
import { noteForLead } from "./messages.ts";
import { supervisor } from "./supervisor.ts";
import { builderHarness, builderSession, liveThreads, readThread } from "./thread.ts";

// Returns the repositories Skelcrew has, by owner and name.
const allRepositories = (db: Database) =>
  z
    .array(z.object({ owner: z.string(), repo: z.string() }))
    .parse(db.query("SELECT owner, repo FROM repositories").all());

// Returns whether the lead or builder whose session has the given name may still run. One that
// is starting runs, as does one whose host doesn't answer for now or whose host plugin is gone,
// as it may still run there. `unsure` hears why when its host can't say.
async function agentNamedRuns(
  db: Database,
  sessions: string,
  name: string,
  unsure: (why: string) => void = () => {},
): Promise<boolean> {
  try {
    const thread = db.query("SELECT folder FROM task_threads WHERE folder = ?").get(name);
    if (thread) {
      if (supervisor(name).state().busy) return true;
      const { host, id } = await builderSession(db, sessions, readThread(db, name));
      return await agentRuns(host, id);
    }
    for (const { owner, repo } of allRepositories(db)) {
      if (leadOf(db, owner, repo).name !== name) continue;
      if (leadAgent(owner, repo).state().busy) return true;
      const lead = await leadSession(db, sessions, owner, repo);
      if (lead === null) unsure("its session host isn't installed");
      return lead === null || (await agentRuns(lead.host, lead.id));
    }
    return false;
  } catch (error) {
    unsure(errorText(error));
    return true;
  }
}

// The agents on the shared login whose host couldn't say whether they run, logged once each.
const unsureLogged = new Set<string>();

// Returns the Codex leads and builders that may still run on the login an earlier release
// shared, but for `starting`, the one whose start asks, each with its repository.
async function onSharedLogin(db: Database, sessions: string, starting: string | null) {
  const candidates: { name: string; owner: string; repo: string }[] = [];
  for (const thread of liveThreads(db))
    if (sharesLogin(builderHarness(thread).name, homedir(), thread.folder))
      candidates.push({ name: thread.folder, owner: thread.owner, repo: thread.repo });
  for (const { owner, repo } of allRepositories(db)) {
    const lead = leadOf(db, owner, repo);
    if (lead.harness !== null && sharesLogin(lead.harness, homedir(), lead.name))
      candidates.push({ name: lead.name, owner, repo });
  }
  const running = [];
  for (const agent of candidates) {
    if (agent.name === starting) continue;
    const unsure = (why: string) => {
      if (unsureLogged.has(agent.name)) return;
      unsureLogged.add(agent.name);
      console.log(
        `Skelcrew can't tell whether ${agent.name} still runs on the login Codex agents shared, so it leaves that login as it is and asks again: ${why}`,
      );
    };
    if (await agentNamedRuns(db, sessions, agent.name, unsure)) running.push(agent);
  }
  return running;
}

// Whether the log and the leads heard that agents still run on the shared login.
let told = false;

// Takes the login an earlier release shared, once no lead or builder but `starting` may still
// run on it, so agents get copies of their own from then on. Until then the shared login stays
// as it is for those agents, and new Codex agents get no login. The log and the leads of their
// repositories hear once that they should be restarted. An agent from then can spend its refresh
// token meanwhile, which leaves the login to sign in again.
export async function takeSharedLoginWhenFree(
  db: Database,
  sessions: string,
  starting: string | null = null,
): Promise<void> {
  if (!sharedLoginLeft(homedir())) return;
  const running = await onSharedLogin(db, sessions, starting);
  if (running.length === 0) return takeSharedLogin(homedir());
  if (told) return;
  told = true;
  const names = running.map((agent) => agent.name).join(", ");
  const text = `Codex agents started before Skelcrew gave each agent its own login still run: ${names}. Restart each with sc stop and sc start. Until none is left, new Codex agents get no login.`;
  console.log(text);
  for (const key of new Set(running.map((agent) => `${agent.owner}/${agent.repo}`))) {
    const [owner = "", repo = ""] = key.split("/");
    noteForLead(db, sessions, { owner, repo }, text, null, true);
  }
}

// Keeps the agents' logins, every look of the daemon's: the sweep and renewals, and apart from
// them, taking the shared login, so a host that fails one never holds up the other.
export function keepAgentLogins(db: Database, sessions: string): void {
  keepLogins(homedir(), (name) => agentNamedRuns(db, sessions, name)).catch((error) =>
    console.log(`couldn't keep the agents' logins: ${errorText(error)}`),
  );
  takeSharedLoginWhenFree(db, sessions).catch((error) =>
    console.log(`couldn't take the login agents shared: ${errorText(error)}`),
  );
}
