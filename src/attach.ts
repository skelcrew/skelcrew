// Running the daemon in the background, as sc up --bg does, and attaching you to a repository's
// lead or a thread's builder once it runs this Skelcrew's code. Plain sc attaches to a lead, and
// sc attach to a builder.
import { z } from "zod";
import { agentRuns } from "./agents/sessions.ts";
import { ask } from "./client.ts";
import { openDb } from "./db.ts";
import { leadOf } from "./flow/lead.ts";
import { findThread } from "./flow/thread.ts";
import { installService, restartDaemon, servicePid, startDaemon } from "./machine/service.ts";
import { openScreen } from "./screen/screen.ts";
import { checkoutFolder, git, release, singleFile } from "./version.ts";

// The daemon's answer when asked for a lead: the lead's session and its repository's
// owner/name, that every tab is closed when only an open tab would do, or why it has none.
const LeadReply = z.union([
  z.object({ lead: z.string(), repository: z.string() }),
  z.object({ closed: z.literal(true) }),
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
  const deadline = Date.now() + 10_000;
  while (true) {
    const now = await daemonRuns();
    if (now && !daemonShouldRun(now)) return;
    if (Date.now() > deadline)
      throw new Error(
        `Skelcrew's daemon didn't come back on ${want} within 10 seconds: ${log} shows why`,
      );
    await Bun.sleep(100);
  }
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

// Makes sure a lead is running, then opens the screen on the lead until you leave with Alt-Q.
// The daemon must already run, as plain sc starts it first. The lead is for `from`, an
// owner/repo, or else for the repository you opened last. With `tab`, only a repository whose
// tab is open will do. Returns false, with no screen opened, when every tab is closed.
export async function attachToLead(sessions: string, from?: string, tab = false): Promise<boolean> {
  // Asking for the lead brings it back if it ended while the daemon kept running. Starting it
  // takes longer than a status, hence the longer wait.
  const reply = await ask(
    { command: "lead", ...(from ? { from } : {}), ...(tab ? { tab } : {}) },
    15_000,
  );
  if (reply === null) throw new Error("the daemon didn't answer: run sc to start it");
  const lead = LeadReply.safeParse(reply);
  if (!lead.success)
    throw new Error("the daemon answered in a way this Skelcrew doesn't understand");
  if ("error" in lead.data) throw new Error(lead.data.error);
  if ("closed" in lead.data) return false;
  await openScreen(sessions, lead.data.lead, lead.data.lead, lead.data.repository);
  return true;
}

// Opens the screen with a thread's builder on the right and its repository's lead in the
// sidebar, and returns when you leave with Alt-Q. Only you can run it, since it takes over
// your terminal. It checks the builder is running before it starts the daemon.
export async function attachToThread(
  sessions: string,
  repository: string,
  task: string,
): Promise<void> {
  const db = openDb();
  const thread = findThread(db, repository, task);
  // A builder that exited leaves its last screen behind, which would look like it still runs.
  if (!agentRuns(sessions, thread.folder))
    throw new Error(
      `${repository}-${task}'s builder isn't running: the thread is ${thread.status}`,
    );
  await upInBackground();
  // Attaching to a thread opens its repository, as plain sc in a checkout of it would, which
  // opens its tab again if you closed it by exiting its lead, and starts that lead. It is asked
  // each time, not only for a tab the database says is closed: a lead you exited a moment ago
  // reads as open until the daemon's next look, which would then close the tab under the screen
  // you just opened. The daemon notices the exit first. The builder's screen opens even when
  // the lead can't start.
  const fullName = `${thread.owner}/${thread.repo}`;
  await ask({ command: "lead", from: fullName }, 60_000);
  const { name } = leadOf(db, thread.owner, thread.repo);
  await openScreen(sessions, thread.folder, name, fullName);
}
