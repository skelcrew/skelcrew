// Running the daemon in the background, as sc up --bg does, then showing you a repository's
// lead or a thread's builder once it runs this Skelcrew's code. Plain sc opens the screen on a
// lead, sc --list shows the lead's repository as a list, and sc attach attaches to a builder
// full screen. sc restart restarts the daemon when you ask.
import { statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { z } from "zod";
import { agentRuns, attachSession } from "./agents/sessions.ts";
import { askAboutAgents } from "./approved-agents.ts";
import { ask } from "./client.ts";
import { tellOldKeys } from "./config.ts";
import { openDb } from "./db.ts";
import { builderSession, findThread, taskName } from "./flow/thread.ts";
import { runList } from "./list/list.ts";
import { installService, restartDaemon, servicePid, startDaemon } from "./machine/service.ts";
import { daemonSocket } from "./paths.ts";
import { attachOnHost } from "./plugins/runtime.ts";
import { openScreen } from "./screen/screen.ts";
import { checkoutFolder, git, release, singleFile } from "./version.ts";

// The daemon's answer when asked for a lead: the lead's session and its repository's
// owner/name, that every tab is closed when only an open tab would do, or why it has none.
const LeadReply = z.union([
  z.object({ lead: z.string(), repository: z.string() }),
  z.object({ closed: z.literal(true) }),
  z.object({ agents: z.object({ owner: z.string(), repo: z.string(), name: z.string() }) }),
  z.object({ error: z.string() }),
]);

// What the daemon says it runs: its release, or for a daemon from a checkout, that checkout's
// folder and the commit it started on, and its process id. A field an older daemon doesn't
// report comes back empty.
const DaemonBuild = z
  .object({
    release: z.string().catch(""),
    folder: z.string().catch(""),
    commit: z.string().catch(""),
    pid: z.number().catch(0),
  })
  .catch({ release: "", folder: "", commit: "", pid: 0 });

// Returns what the daemon runs, or null when no daemon answers.
async function daemonRuns(): Promise<z.infer<typeof DaemonBuild> | null> {
  const reply = await ask({ command: "status" }, 2000);
  return reply === null ? null : DaemonBuild.parse(reply);
}

// Returns what the daemon should run instead, in words, or null when a restart isn't needed or
// wouldn't help. A release wants the daemon on the same release. A checkout wants it on its
// current commit, but only when the daemon runs from this same checkout. The service always
// starts one checkout, so restarting your main one's daemon from a worktree would change
// nothing. Uncommitted changes don't count, so editing doesn't ask for a restart at every sc.
function daemonShouldRun(running: z.infer<typeof DaemonBuild>): string | null {
  if (release) return running.release === release ? null : `Skelcrew ${release}`;
  // A single file that isn't a release has no checkout to compare.
  if (singleFile || running.folder !== checkoutFolder) return null;
  const commit = git("rev-parse", "--short", "HEAD");
  return commit === "" || running.commit === commit ? null : `commit ${commit}`;
}

// How long a restarted daemon may take to answer on what this Skelcrew wants, in milliseconds.
// Tests set SKELCREW_RESTART_WAIT_MS shorter, so a daemon that never comes back doesn't cost
// them ten seconds.
const restartWait = z.coerce
  .number()
  .min(0)
  .catch(10_000)
  .parse(process.env.SKELCREW_RESTART_WAIT_MS ?? 10_000);

// Reports whether the daemon that answered runs outside its service, such as sc up or an older
// sc serve in a terminal. Told by its process id, which every daemon reports, so it holds for a
// daemon of an older release too. One that reports none can't be told, and counts as the service's.
const outsideService = (running: z.infer<typeof DaemonBuild>) =>
  running.pid !== 0 && running.pid !== servicePid();

// The error for a daemon outside its service that runs other code than this Skelcrew. Restarting
// the service can't end it, and a new daemon can't start while it holds the lock, so only you can
// stop it.
const stopItFirst = (want: string) =>
  new Error(
    `Skelcrew's daemon runs outside its service, such as with sc up in a terminal, on other code than ${want}. Stop it, such as with Ctrl-C, then run sc again. Your agents keep running.`,
  );

// Restarts the daemon when it runs another release than this Skelcrew, or another commit of this
// checkout. So a release installed in the background, or a git pull, takes over the next time
// you run sc. Agents keep running, as only the daemon restarts.
export async function restartStaleDaemon(): Promise<void> {
  const running = await daemonRuns();
  const want = running && daemonShouldRun(running);
  if (!want) return;
  if (outsideService(running)) throw stopItFirst(want);
  console.log(`Restarting the daemon on ${want}. Your agents keep running.`);
  const log = restartDaemon();
  // Done once a daemon answers that runs what this Skelcrew wants. The old one can still
  // answer for a moment while it stops.
  const deadline = Date.now() + restartWait;
  while (true) {
    const now = await daemonRuns();
    if (now && !daemonShouldRun(now)) return;
    if (Date.now() > deadline)
      throw new Error(
        `Skelcrew's daemon didn't come back on ${want} within ${restartWait / 1000} seconds: ${log} shows why`,
      );
    await Bun.sleep(100);
  }
}

// Restarts the engine's service on this machine, for sc restart, and returns once a new engine
// answers. sc --remote runs it on a server too. An engine run in a terminal with sc up is left
// alone and you are asked to stop it, as the service manager can't restart it and a service
// started beside it would fail on the lock. Agents keep running, as only the engine restarts.
export async function restartEngine(): Promise<void> {
  const before = await daemonRuns();
  // An engine from an older release reports no process id. When the service runs none, it
  // surely runs in a terminal. Otherwise it may be the service's, so the service restarts, and
  // the wait below catches one in a terminal: it keeps answering, and with no id.
  const terminal =
    before !== null && (before.pid === 0 ? servicePid() === 0 : outsideService(before));
  if (terminal)
    throw new Error(
      "Skelcrew's engine runs in a terminal, with sc up, not as its service. Stop it there, such as with Ctrl-C, then run sc up again, or sc up --bg to run it as the service. Your agents keep running.",
    );
  const began = Date.now();
  const log = restartDaemon();
  // A new engine is told by its socket, which an engine makes once it holds the lock: one made
  // after the restart began. The process id can't tell, as an engine from an older release
  // reports none, and the service may run one. The old engine, still answering for a moment
  // while it stops, and one in a terminal, which keeps a new one from starting, keep the socket
  // they made before.
  const deadline = began + restartWait;
  while (true) {
    const made = statSync(daemonSocket(), { throwIfNoEntry: false })?.ctimeMs ?? 0;
    if (made >= began && (await daemonRuns())) break;
    if (Date.now() > deadline)
      throw new Error(
        `Skelcrew's engine didn't come back within ${restartWait / 1000} seconds: ${log} shows why. An engine from an older release that you ran with sc up in a terminal keeps a new one from starting: stop it there, such as with Ctrl-C.`,
      );
    await Bun.sleep(100);
  }
  console.log(`Restarted the engine on ${userInfo().username}@${hostname()}. Agents kept running.`);
}

// Runs the daemon as the background service on this Skelcrew's code, and returns once it
// answers. This is sc up --bg, and plain sc and sc attach do it before attaching. The service is
// installed first, or rewritten when the PATH or Skelcrew it needs moved. A daemon on another
// release or commit is restarted, and one that doesn't answer is started. A daemon outside the
// service is left running, and true comes back to say so: a service started beside it would
// fail on the lock, and fail again on each retry until systemd gave up on it.
export async function upInBackground(): Promise<boolean> {
  const before = await daemonRuns();
  if (before && outsideService(before)) {
    const want = daemonShouldRun(before);
    if (want) throw stopItFirst(want);
    return true;
  }
  installService();
  await restartStaleDaemon();
  if (await daemonRuns()) return false;
  const log = startDaemon();
  // The service manager returns before the daemon listens, so wait until it answers.
  const deadline = Date.now() + 10_000;
  while (!(await daemonRuns())) {
    if (Date.now() > deadline)
      throw new Error(`Skelcrew's daemon didn't answer within 10 seconds: ${log} shows why`);
    await Bun.sleep(100);
  }
  return false;
}

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
  await upInBackground();
  if (typeof host !== "string") return attachOnHost(host, id);
  const failed = await attachSession(host, id);
  if (failed) throw new Error(failed);
}
