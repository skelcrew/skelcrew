// What skel's commands ask the daemon, over its socket, and attaching you to the lead or a
// thread's builder. Plain skel makes sure the daemon runs, then attaches to the lead.
import { createConnection } from "node:net";
import { z } from "zod";
import { openDb } from "./db.ts";
import { RepositoryRow, TaskRow, TaskView, ThreadRow } from "./list.ts";
import { Page } from "./page.ts";
import { cliSocket } from "./paths.ts";
import { parseJson, type Request } from "./requests.ts";
import { openScreen } from "./screen.ts";
import { startDaemon } from "./service.ts";
import { findThread } from "./thread.ts";
import { agentRuns } from "./tmux.ts";

const LeadReply = z.union([z.object({ lead: z.literal(true) }), z.object({ error: z.string() })]);

// Sends a request to the daemon and returns its decoded reply, or null when nothing
// answers. A socket file alone proves nothing: a daemon that was killed leaves it behind.
function ask(request: Request, timeout: number): Promise<unknown> {
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
async function request(asked: Request): Promise<unknown> {
  const reply = await ask(asked, 60_000);
  if (reply === null) throw new Error("the daemon didn't answer: run skel to start it");
  const failed = z.object({ error: z.string() }).safeParse(reply);
  if (failed.success) throw new Error(failed.data.error);
  // On stderr, so a tool reading --json from stdout still gets only JSON.
  const brought = z
    .object({ broughtIn: z.object({ github: z.string(), name: z.string() }) })
    .safeParse(reply);
  if (brought.success) {
    const { github, name } = brought.data.broughtIn;
    console.error(
      `skel brought in ${github}, as ${name}. It clones it in the background, and a thread started on it waits for the clone.`,
    );
  }
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

// Returns the note telling the lead where you attached from, for the lead's hook, or nothing
// when it has nothing new. Claude Code holds your message until the hook ends, so it gives
// up quickly, and never throws: a daemon that is down must not stop your message.
export async function askForAttachedNote(): Promise<string> {
  const reply = z.object({ note: z.string() }).safeParse(await ask({ command: "attached" }, 2000));
  return reply.success ? reply.data.note : "";
}

// Tells the daemon a screen just opened, for the sidebar as it starts, so ISSUES and PRS fill
// within seconds and not at the next poll. Only a poll with a screen open asks for them, which
// is why this comes from the sidebar: while you attach, no screen is open yet. A daemon that is
// down has nothing to tell, and the sidebar goes on without it.
export async function screenOpened(): Promise<void> {
  await ask({ command: "screen opened" }, 2000);
}

// Asks the daemon for the page of an issue or PR, for the page command. The daemon answers, as
// only it may call GitHub.
export async function pageOf(url: string): Promise<Page> {
  const reply = await request({ command: "page", url });
  return understood(z.object({ page: Page }), reply).page;
}

// Ensures the daemon and lead are running, then opens the screen on the lead until you leave
// with Ctrl-Q. The daemon keeps which repository you attached from, as owner/repo, or that
// there is none, for the lead to hear with your next message.
export async function attachToLead(tmux: string, from?: string): Promise<void> {
  const asked: Request = { command: "lead", ...(from ? { from } : {}) };
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
  await openScreen(tmux, "lead");
}

// Opens the screen with the builder of the thread named repo-task on the right, and returns
// when you leave with Ctrl-Q. Only from your own terminal: it takes over the screen, which
// the lead can't hand to you.
export async function attachToThread(
  tmux: string,
  repository: string,
  task: number,
): Promise<void> {
  const thread = findThread(openDb(), repository, task);
  // A builder that exited leaves its last screen behind, which would look like it still runs.
  if (!agentRuns(tmux, thread.folder))
    throw new Error(
      `${repository}-${task}'s builder isn't running: the thread is ${thread.status}`,
    );
  await openScreen(tmux, thread.folder);
}
