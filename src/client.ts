// What skel's commands ask the daemon, over its socket, and attaching you to a repository's
// lead or a thread's builder. Plain skel makes sure the daemon runs, then attaches to a lead.
import { createConnection } from "node:net";
import { z } from "zod";
import { agentRuns } from "./agents/tmux.ts";
import { openDb } from "./db.ts";
import { leadOf } from "./flow/lead.ts";
import { RepositoryRow, TaskRow, TaskView, ThreadRow } from "./flow/list.ts";
import { Page } from "./flow/page.ts";
import { type DaemonRequest, parseJson } from "./flow/requests.ts";
import { findThread } from "./flow/thread.ts";
import { restartDaemon, startDaemon } from "./machine/service.ts";
import { cliSocket } from "./paths.ts";
import { skelLine } from "./say.ts";
import { openScreen } from "./screen/screen.ts";
import { release } from "./version.ts";

const LeadReply = z.union([
  z.object({ lead: z.string(), repository: z.string() }),
  z.object({ error: z.string() }),
]);

// Sends a request to the daemon and returns its decoded reply, or null when nothing
// answers. A socket file alone proves nothing: a daemon that was killed leaves it behind.
function ask(request: DaemonRequest, timeout: number): Promise<unknown> {
  return new Promise((done) => {
    const connection = createConnection(cliSocket());
    const timer = setTimeout(() => connection.destroy(), timeout);
    let reply = "";
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (data) => {
      reply += data.toString();
      if (reply.includes("\n")) connection.end();
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      clearTimeout(timer);
      done(reply ? parseJson(reply) : null);
    });
  });
}

// Asks the daemon on behalf of a skel command, and returns its answer. Throws with the
// daemon's error, or when nothing answers.
async function request(asked: DaemonRequest): Promise<unknown> {
  const reply = await ask(asked, 60_000);
  if (reply === null) throw new Error("the daemon didn't answer: run skel to start it");
  const failed = z.object({ error: z.string() }).safeParse(reply);
  if (failed.success) throw new Error(failed.data.error);
  return reply;
}

// Returns the daemon's reply checked against the shape this skel expects, so a daemon of
// another version fails with a clear message.
const understood = <T>(schema: z.ZodType<T>, reply: unknown): T => {
  const read = schema.safeParse(reply);
  if (!read.success) throw new Error("the daemon answered in a way this skel doesn't understand");
  return read.data;
};

// Asks the daemon for the repositories, for skel repo ls run by the lead. The daemon
// answers, as the lead's sandbox hides skel's database.
export async function askForRepositories(): Promise<RepositoryRow[]> {
  const reply = await request({ command: "repo ls" });
  return understood(z.object({ repositories: z.array(RepositoryRow) }), reply).repositories;
}

// Asks the daemon for the threads, or one repository's, for skel ps. The daemon answers, as
// the lead's sandbox hides skel's database.
export async function askForThreads(repository?: string): Promise<ThreadRow[]> {
  const reply = await request({ command: "ps", ...(repository ? { repo: repository } : {}) });
  return understood(z.object({ threads: z.array(ThreadRow) }), reply).threads;
}

// Asks the daemon for the open tasks of every repository, or of one, for skel task ls. The
// daemon answers, as only it may call GitHub.
export async function askForTasks(repository?: string): Promise<TaskRow[]> {
  const reply = await request({ command: "task ls", ...(repository ? { repo: repository } : {}) });
  return understood(z.object({ tasks: z.array(TaskRow) }), reply).tasks;
}

// Asks the daemon for one task, for skel task show. The daemon answers, as only it may call
// GitHub.
export async function askForTask(repository: string, number: number): Promise<TaskView> {
  const reply = await request({ command: "task show", repo: repository, task: number });
  return understood(z.object({ task: TaskView }), reply).task;
}

// Has the daemon create a task, as a GitHub issue, for skel task create, and returns the
// task's name, such as app-13. The daemon makes the call, since agents never hold a GitHub
// login.
export async function createTask(repository: string, title: string, body: string): Promise<string> {
  const reply = await request({ command: "task create", repo: repository, title, body });
  return understood(z.object({ task: z.string() }), reply).task;
}

// Has the daemon start a thread on a task, for skel start, and returns what it did, in a
// sentence: started a new thread, brought back a stopped one's builder, or let one past the
// round limit go on. The daemon answers once the thread is recorded; its setup and builder
// come after.
export async function startOn(repository: string, task: number, from?: string): Promise<string> {
  const reply = await request({
    command: "start",
    repo: repository,
    task,
    ...(from ? { from } : {}),
  });
  return understood(z.object({ started: z.string() }), reply).started;
}

// Has the daemon stop a thread, for skel stop, and returns the thread's name. The daemon
// answers once the builder has exited.
export async function stopOn(repository: string, task: number): Promise<string> {
  const reply = await request({ command: "stop", repo: repository, task });
  return understood(z.object({ stopped: z.string() }), reply).stopped;
}

// Has the daemon start a round for skel submit, run by a builder in its sandbox, and returns
// the thread's name. The builder's own socket tells the daemon which thread it is. The
// daemon answers at once, and pushes and starts the review after.
export async function submitForReview(summary: string): Promise<string> {
  const reply = await request({ command: "submit", summary });
  return understood(z.object({ submitted: z.string() }), reply).submitted;
}

// Has the daemon type the lead's message into a thread's builder, for skel tell, and returns
// the thread's name. The daemon answers at once, and types it in once the builder is idle.
export async function tellOn(repository: string, task: number, text: string): Promise<string> {
  const reply = await request({ command: "tell", repo: repository, task, text });
  return understood(z.object({ told: z.string() }), reply).told;
}

// Has the daemon type a builder's message into the lead, for skel tell lead. The builder's
// own socket tells the daemon which thread it comes from. The daemon answers at once.
export async function tellTheLead(text: string): Promise<void> {
  await request({ command: "tell lead", text });
}

// Has the daemon review a thread's last submitted commit again, for skel review, and returns
// the thread's name. The daemon answers at once, and the review runs after, as a round's.
export async function reviewAgain(repository: string, task: number): Promise<string> {
  const reply = await request({ command: "review", repo: repository, task });
  return understood(z.object({ reviewing: z.string() }), reply).reviewing;
}

// Tells the daemon, for a builder's hook, that its builder is asking you a question, so the
// thread needs you, or that the question is over. The builder's own socket tells the daemon
// which thread it is. The daemon answers at once, as Claude Code waits on its hooks.
export async function reportQuestion(asking: boolean): Promise<void> {
  await request({ command: asking ? "question asked" : "question answered" });
}

// Tells the daemon a screen just opened, for the sidebar as it starts, so ISSUES and PRS fill
// within seconds and not at the next poll. Only a poll with a screen open asks for them, which
// is why this comes from the sidebar: while you attach, no screen is open yet. A daemon that is
// down has nothing to tell, and the sidebar goes on without it.
export async function screenOpened(): Promise<void> {
  await ask({ command: "screen opened" }, 2000);
}

// Has the daemon open a repository, by its GitHub name, for the sidebar switching to its tab:
// it starts the repository's lead if it never has, and marks it as the one you opened last.
// The sidebar goes on without waiting, and a daemon that is down has nothing to start.
export async function openRepository(fullName: string): Promise<void> {
  await ask({ command: "lead", from: fullName }, 60_000);
}

// Asks the daemon for the page of an issue or PR, for the page command. The daemon answers, as
// only it may call GitHub.
export async function pageOf(url: string): Promise<Page> {
  const reply = await request({ command: "page", url });
  return understood(z.object({ page: Page }), reply).page;
}

// Returns the release the daemon runs, or null when no daemon answers. A daemon from a
// checkout, or from before daemons said, gives "".
async function daemonRelease(): Promise<string | null> {
  const reply = await ask({ command: "status" }, 2000);
  if (reply === null) return null;
  return z
    .object({ release: z.string().catch("") })
    .catch({ release: "" })
    .parse(reply).release;
}

// Restarts the daemon when it runs another release than this skel, before you attach, so a
// release installed in the background takes over once you leave and run skel again. A build
// from a checkout never does: you update it with git pull and restart its daemon yourself.
export async function onThisRelease(): Promise<void> {
  if (!release) return;
  const running = await daemonRelease();
  if (running === null || running === release) return;
  console.log(skelLine(`restarting the daemon on skel ${release}. Your agents keep running.`));
  const log = restartDaemon();
  const deadline = Date.now() + 10_000;
  while ((await daemonRelease()) !== release) {
    if (Date.now() > deadline)
      throw new Error(
        `skel's daemon didn't come back on ${release} within 10 seconds: ${log} shows why`,
      );
    await Bun.sleep(100);
  }
}

// Ensures the daemon and the lead of the repository you attached from, as owner/repo, are
// running, then opens the screen on that lead until you leave with Ctrl-Q. With none, the
// daemon opens the repository you opened last.
export async function attachToLead(tmux: string, from?: string): Promise<void> {
  await onThisRelease();
  const asked: DaemonRequest = { command: "lead", ...(from ? { from } : {}) };
  // Asking for the lead brings it back if it ended while the daemon kept running.
  let reply = await ask(asked, 15_000);
  if (reply === null) {
    const log = startDaemon();
    const deadline = Date.now() + 10_000;
    while (reply === null) {
      if (Date.now() > deadline)
        throw new Error(`skel's daemon didn't answer within 10 seconds: ${log} shows why`);
      await Bun.sleep(100);
      reply = await ask(asked, 15_000);
    }
  }
  const lead = LeadReply.safeParse(reply);
  if (!lead.success) throw new Error("the daemon answered in a way this skel doesn't understand");
  if ("error" in lead.data) throw new Error(lead.data.error);
  await openScreen(tmux, lead.data.lead, lead.data.lead, lead.data.repository);
}

// Opens the screen with the builder of the thread named repo-task on the right, and returns
// when you leave with Ctrl-Q, with its repository's lead in the sidebar. Only from your own
// terminal: it takes over the screen, which the lead can't hand to you.
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
  const { name } = leadOf(db, thread.owner, thread.repo);
  await openScreen(tmux, thread.folder, name, `${thread.owner}/${thread.repo}`);
}
