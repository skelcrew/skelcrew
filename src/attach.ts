// Attaching you to a repository's lead or a thread's builder, after making sure the daemon
// runs on this skel's code. Plain skel attaches to a lead, and skel attach to a builder.
import { z } from "zod";
import { agentRuns } from "./agents/tmux.ts";
import { ask } from "./client.ts";
import { openDb } from "./db.ts";
import { leadOf } from "./flow/lead.ts";
import { findThread } from "./flow/thread.ts";
import { restartDaemon, startDaemon } from "./machine/service.ts";
import { skelLine } from "./say.ts";
import { openScreen } from "./screen/screen.ts";
import { checkoutFolder, git, release, singleFile } from "./version.ts";

const LeadReply = z.union([
  z.object({ lead: z.string(), repository: z.string() }),
  z.object({ error: z.string() }),
]);

// What the daemon says it runs: its release, or for a daemon from a checkout, that checkout's
// folder and the commit it started on. A field the daemon doesn't give, as one from before it
// said, is empty.
const Running = z
  .object({
    release: z.string().catch(""),
    folder: z.string().catch(""),
    commit: z.string().catch(""),
  })
  .catch({ release: "", folder: "", commit: "" });

// Returns what the daemon runs, or null when no daemon answers.
async function daemonRuns(): Promise<z.infer<typeof Running> | null> {
  const reply = await ask({ command: "status" }, 2000);
  return reply === null ? null : Running.parse(reply);
}

// Returns what this skel would have the daemon run, in words, or null when the daemon already
// runs it, or a restart couldn't change what it runs. A release wants the daemon on the same
// release. A checkout wants it on its current commit, after a git pull, but only a daemon that
// runs from this same checkout: the service starts one checkout, so restarting a daemon of
// another, such as your main one while you run skel from a worktree, would change nothing.
// Changes not committed don't count: the daemon can't say what it loaded, and asking for a
// restart at every skel while you edit would only get in the way.
function wanted(running: z.infer<typeof Running>): string | null {
  if (release) return running.release === release ? null : `skel ${release}`;
  if (singleFile || running.folder !== checkoutFolder) return null;
  const commit = git("rev-parse", "--short", "HEAD");
  return commit === "" || running.commit === commit ? null : `commit ${commit}`;
}

// Restarts the daemon when it runs another release than this skel, or another commit of this
// checkout, before you attach. So a release installed in the background, or a git pull, takes
// over once you run skel again. Agents keep running, as only the daemon restarts.
export async function onThisSkel(): Promise<void> {
  const running = await daemonRuns();
  const want = running && wanted(running);
  if (!want) return;
  console.log(skelLine(`restarting the daemon on ${want}. Your agents keep running.`));
  const log = restartDaemon();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const now = await daemonRuns();
    if (now && !wanted(now)) return;
    if (Date.now() > deadline)
      throw new Error(
        `skel's daemon didn't come back on ${want} within 10 seconds: ${log} shows why`,
      );
    await Bun.sleep(100);
  }
}

// Makes sure the daemon runs, on this skel's code, before you attach to an agent it keeps.
// One on another release or commit is restarted, and one that doesn't answer is started.
async function daemonUp(): Promise<void> {
  await onThisSkel();
  if (await daemonRuns()) return;
  const log = startDaemon();
  const deadline = Date.now() + 10_000;
  while (!(await daemonRuns())) {
    if (Date.now() > deadline)
      throw new Error(`skel's daemon didn't answer within 10 seconds: ${log} shows why`);
    await Bun.sleep(100);
  }
}

// Ensures the daemon and the lead of the repository you attached from, as owner/repo, are
// running, then opens the screen on that lead until you leave with Ctrl-Q. With none, the
// daemon opens the repository you opened last.
export async function attachToLead(tmux: string, from?: string): Promise<void> {
  await daemonUp();
  // Asking for the lead brings it back if it ended while the daemon kept running.
  const reply = await ask({ command: "lead", ...(from ? { from } : {}) }, 15_000);
  if (reply === null) throw new Error("the daemon didn't answer: run skel to start it");
  const lead = LeadReply.safeParse(reply);
  if (!lead.success) throw new Error("the daemon answered in a way this skel doesn't understand");
  if ("error" in lead.data) throw new Error(lead.data.error);
  await openScreen(tmux, lead.data.lead, lead.data.lead, lead.data.repository);
}

// Opens the screen with the builder of the thread named repo-task on the right, and returns
// when you leave with Ctrl-Q, with its repository's lead in the sidebar. Only from your own
// terminal: it takes over the screen, which the lead can't hand to you. The daemon is made
// sure of as for a lead, once the thread is known to be there.
export async function attachToThread(
  tmux: string,
  repository: string,
  task: number,
): Promise<void> {
  const db = openDb();
  const thread = findThread(db, repository, task);
  // A builder that exited leaves its last screen behind, which would look like it still runs.
  if (!agentRuns(tmux, thread.folder))
    throw new Error(
      `${repository}-${task}'s builder isn't running: the thread is ${thread.status}`,
    );
  await daemonUp();
  const { name } = leadOf(db, thread.owner, thread.repo);
  await openScreen(tmux, thread.folder, name, `${thread.owner}/${thread.repo}`);
}
