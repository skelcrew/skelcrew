// Attaching you to a repository's lead or a thread's builder, after making sure the daemon
// runs on this Skelcrew's code. Plain sc attaches to a lead, and sc attach to a builder.
import { z } from "zod";
import { agentRuns } from "./agents/tmux.ts";
import { ask } from "./client.ts";
import { openDb } from "./db.ts";
import { leadOf } from "./flow/lead.ts";
import { findThread } from "./flow/thread.ts";
import { restartDaemon, startDaemon } from "./machine/service.ts";
import { openScreen } from "./screen/screen.ts";
import { checkoutFolder, git, release, singleFile } from "./version.ts";

// The daemon's answer when asked for a lead: the lead's tmux session and its repository's
// owner/name, or why it has none.
const LeadReply = z.union([
  z.object({ lead: z.string(), repository: z.string() }),
  z.object({ error: z.string() }),
]);

// What the daemon says it runs: its release, or for a daemon from a checkout, that checkout's
// folder and the commit it started on. A field an older daemon doesn't report comes back empty.
const DaemonBuild = z
  .object({
    release: z.string().catch(""),
    folder: z.string().catch(""),
    commit: z.string().catch(""),
  })
  .catch({ release: "", folder: "", commit: "" });

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

// Restarts the daemon when it runs another release than this Skelcrew, or another commit of this
// checkout. So a release installed in the background, or a git pull, takes over the next time
// you run sc. Agents keep running, as only the daemon restarts.
export async function restartStaleDaemon(): Promise<void> {
  const running = await daemonRuns();
  const want = running && daemonShouldRun(running);
  if (!want) return;
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

// Makes sure the daemon runs this Skelcrew's code before you attach to an agent. A daemon on
// another release or commit is restarted, and one that doesn't answer is started.
async function ensureDaemon(): Promise<void> {
  await restartStaleDaemon();
  if (await daemonRuns()) return;
  const log = startDaemon();
  // The service manager returns before the daemon listens, so wait until it answers.
  const deadline = Date.now() + 10_000;
  while (!(await daemonRuns())) {
    if (Date.now() > deadline)
      throw new Error(`Skelcrew's daemon didn't answer within 10 seconds: ${log} shows why`);
    await Bun.sleep(100);
  }
}

// Makes sure the daemon and a lead are running, then opens the screen on the lead until you
// leave with Ctrl-Q. The lead is for `from`, an owner/repo, or else for the repository you
// opened last.
export async function attachToLead(tmux: string, from?: string): Promise<void> {
  await ensureDaemon();
  // Asking for the lead brings it back if it ended while the daemon kept running. Starting it
  // takes longer than a status, hence the longer wait.
  const reply = await ask({ command: "lead", ...(from ? { from } : {}) }, 15_000);
  if (reply === null) throw new Error("the daemon didn't answer: run sc to start it");
  const lead = LeadReply.safeParse(reply);
  if (!lead.success)
    throw new Error("the daemon answered in a way this Skelcrew doesn't understand");
  if ("error" in lead.data) throw new Error(lead.data.error);
  await openScreen(tmux, lead.data.lead, lead.data.lead, lead.data.repository);
}

// Opens the screen with a thread's builder on the right and its repository's lead in the
// sidebar, and returns when you leave with Ctrl-Q. Only you can run it, since it takes over
// your terminal. It checks the builder is running before it starts the daemon.
export async function attachToThread(
  tmux: string,
  repository: string,
  task: string,
): Promise<void> {
  const db = openDb();
  const thread = findThread(db, repository, task);
  // A builder that exited leaves its last screen behind, which would look like it still runs.
  if (!agentRuns(tmux, thread.folder))
    throw new Error(
      `${repository}-${task}'s builder isn't running: the thread is ${thread.status}`,
    );
  await ensureDaemon();
  const { name } = leadOf(db, thread.owner, thread.repo);
  await openScreen(tmux, thread.folder, name, `${thread.owner}/${thread.repo}`);
}
