// What Skelcrew's commands ask the daemon, over its socket.
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
    // A daemon that doesn't answer in time is treated as one that isn't there.
    const timer = setTimeout(() => connection.destroy(), timeout);
    // A request and its reply are one JSON line each, so the reply is complete at its line end.
    let reply = "";
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (data) => {
      reply += data.toString();
      if (reply.includes("\n")) connection.end();
    });
    // A refused or broken connection is followed by close, which answers null.
    connection.on("error", () => {});
    connection.on("close", () => {
      clearTimeout(timer);
      done(reply ? parseJson(reply) : null);
    });
  });
}

// Asks the daemon on behalf of a Skelcrew command, and returns its answer. Throws with the
// daemon's error, or when nothing answers.
async function request(asked: DaemonRequest): Promise<unknown> {
  // A minute, as some requests wait on the daemon's own work, such as stopping a builder.
  const reply = await ask(asked, 60_000);
  if (reply === null) throw new Error("the daemon didn't answer: run sc to start it");
  const failed = z.object({ error: z.string() }).safeParse(reply);
  if (failed.success) throw new Error(failed.data.error);
  return reply;
}

// Returns the daemon's reply checked against the shape this Skelcrew expects, so a daemon of
// another version fails with a clear message.
const checkReply = <T>(schema: z.ZodType<T>, reply: unknown): T => {
  const read = schema.safeParse(reply);
  if (!read.success)
    throw new Error("the daemon answered in a way this Skelcrew doesn't understand");
  return read.data;
};

// Asks the daemon for the repositories, for sc repo ls run by the lead. The daemon
// answers, as the lead's sandbox hides Skelcrew's database.
export async function askForRepositories(): Promise<RepositoryRow[]> {
  const reply = await request({ command: "repo ls" });
  return checkReply(z.object({ repositories: z.array(RepositoryRow) }), reply).repositories;
}

// Asks the daemon for the threads, or one repository's, for sc ps. The daemon answers, as
// the lead's sandbox hides Skelcrew's database.
export async function askForThreads(repository?: string): Promise<ThreadRow[]> {
  const reply = await request({ command: "ps", ...(repository ? { repo: repository } : {}) });
  return checkReply(z.object({ threads: z.array(ThreadRow) }), reply).threads;
}

// Asks the daemon for the open tasks of every repository, or of one, for sc issue ls. The
// daemon answers, as only it asks the tracker.
export async function askForTasks(repository?: string): Promise<TaskRow[]> {
  const reply = await request({ command: "task ls", ...(repository ? { repo: repository } : {}) });
  return checkReply(z.object({ tasks: z.array(TaskRow) }), reply).tasks;
}

// Asks the daemon for one task, for sc issue show. The daemon answers, as only it asks the
// tracker.
export async function askForTask(repository: string, task: string): Promise<TaskView> {
  const reply = await request({ command: "task show", repo: repository, task });
  return checkReply(z.object({ task: TaskView }), reply).task;
}

// Has the daemon create a task in the repository's tracker, such as a GitHub issue, for sc
// issue create, and returns the task's name, such as app-13. The daemon asks the tracker, since
// agents never hold its login.
export async function createTask(repository: string, title: string, body: string): Promise<string> {
  const reply = await request({ command: "task create", repo: repository, title, body });
  return checkReply(z.object({ task: z.string() }), reply).task;
}

// Has the daemon start a thread on a task, for sc start, and returns what it did, in a
// sentence: started a new thread, brought back a stopped one's builder, or let one past the
// round limit go on. The daemon answers once the thread is recorded; its setup and builder
// come after. `short` is the thread's short title for the sidebar, which on a thread already
// at work is all that changes.
export async function startOn(
  repository: string,
  task: string,
  from?: string,
  short?: string,
): Promise<string> {
  const reply = await request({
    command: "start",
    repo: repository,
    task,
    ...(from ? { from } : {}),
    ...(short ? { short } : {}),
  });
  return checkReply(z.object({ started: z.string() }), reply).started;
}

// Has the daemon start a thread on a title and body, for sc start in a repository with no
// tracker, and returns what it did, in a sentence naming the thread, such as app-t1. `short` is
// its short title for the sidebar.
export async function startNew(
  repository: string,
  title: string,
  body: string,
  short?: string,
): Promise<string> {
  const reply = await request({
    command: "start new",
    repo: repository,
    title,
    body,
    ...(short ? { short } : {}),
  });
  return checkReply(z.object({ started: z.string() }), reply).started;
}

// Has the daemon stop a thread, for sc stop, and returns the thread's name. The daemon
// answers once the builder has exited.
export async function stopOn(repository: string, task: string): Promise<string> {
  const reply = await request({ command: "stop", repo: repository, task });
  return checkReply(z.object({ stopped: z.string() }), reply).stopped;
}

// Asks the daemon what sc rm would remove: the thread's name, its status, and its PR, if it has
// one, so sc rm can say so before asking you.
export async function previewRemoval(repository: string, task: string) {
  const reply = await request({ command: "rm preview", repo: repository, task });
  return checkReply(
    z.object({ thread: z.string(), status: z.string(), pr: z.number().nullable() }),
    reply,
  );
}

// Has the daemon remove a thread, for sc rm, with the reason its PR's comment gives, and
// returns the thread's name and the ID of the issue it worked on, or null when it had none.
// The daemon answers once the PR is closed and the clone removed.
export async function removeOn(repository: string, task: string, reason?: string) {
  const reply = await request({
    command: "rm",
    repo: repository,
    task,
    ...(reason ? { reason } : {}),
  });
  return checkReply(z.object({ removed: z.string(), issue: z.string().nullable() }), reply);
}

// Has the daemon start a round for sc submit, run by a builder in its sandbox, and returns
// the thread's name. The builder's own socket tells the daemon which thread it is. The
// daemon answers at once, and pushes and starts the review after.
export async function submitForReview(summary: string): Promise<string> {
  const reply = await request({ command: "submit", summary });
  return checkReply(z.object({ submitted: z.string() }), reply).submitted;
}

// Has the daemon type the lead's message into a thread's builder, for sc tell, and returns
// the thread's name. The daemon answers at once, and types it in once the builder is idle.
export async function tellOn(repository: string, task: string, text: string): Promise<string> {
  const reply = await request({ command: "tell", repo: repository, task, text });
  return checkReply(z.object({ told: z.string() }), reply).told;
}

// Has the daemon type a builder's message into the lead, for sc tell lead. The builder's
// own socket tells the daemon which thread it comes from. The daemon answers at once.
export async function tellTheLead(text: string): Promise<void> {
  await request({ command: "tell lead", text });
}

// Has the daemon review a thread's last submitted commit again, for sc review, and returns
// the thread's name. The daemon answers at once, and the review runs after, as a round's.
export async function reviewAgain(repository: string, task: string): Promise<string> {
  const reply = await request({ command: "review", repo: repository, task });
  return checkReply(z.object({ reviewing: z.string() }), reply).reviewing;
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

// Has the daemon open a repository, by its owner/name, when the sidebar switches to its tab or
// finds its lead crashed. The daemon starts the repository's lead if it isn't running, and marks
// it as the one you opened last. A repository whose tab you closed stays closed, as the screen
// may still show its tab for a moment. The sidebar doesn't wait for an answer, and if the
// daemon is down nothing happens.
export async function openRepository(fullName: string): Promise<void> {
  await ask({ command: "lead", from: fullName, tab: true }, 60_000);
}
