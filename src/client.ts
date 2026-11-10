// What skel's commands ask the daemon, over its socket.
import { createConnection } from "node:net";
import { z } from "zod";
import { RepositoryRow, TaskRow, TaskView, ThreadRow } from "./flow/list.ts";
import { type DaemonRequest, parseJson } from "./flow/requests.ts";
import { cliSocket } from "./paths.ts";

// Sends a request to the daemon and returns its decoded reply, or null when nothing
// answers. A socket file alone proves nothing: a daemon that was killed leaves it behind.
export function ask(request: DaemonRequest, timeout: number): Promise<unknown> {
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

// Tells the daemon, for a Codex builder's hook, that its builder ended its turn, so the thread
// needs you if the builder stopped without submitting. The builder's own socket says which
// thread.
export async function reportTurnEnded(): Promise<void> {
  await request({ command: "turn ended" });
}

// Has the daemon open a repository, by its GitHub name, for the sidebar switching to its tab:
// it starts the repository's lead if it never has, and marks it as the one you opened last.
// The sidebar goes on without waiting, and a daemon that is down has nothing to start.
export async function openRepository(fullName: string): Promise<void> {
  await ask({ command: "lead", from: fullName }, 60_000);
}
