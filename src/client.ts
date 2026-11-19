// What Skelcrew's commands ask the daemon, over its socket.
import { createConnection } from "node:net";
import { z } from "zod";
import { RepositoryRow, TaskRow, TaskView, ThreadRow } from "./flow/list.ts";
import { type DaemonRequest, parseJson } from "./flow/requests.ts";
import { cliSocket } from "./paths.ts";
import { quietly } from "./run.ts";

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

// Asks the daemon whether a word, such as api-v2, names a repository Skelcrew has, by its name,
// owner/name or URL. sc start needs it, as such a name also reads like a task of api.
export async function namesRepository(word: string): Promise<boolean> {
  const reply = await request({ command: "repo named", word });
  return checkReply(z.object({ named: z.boolean() }), reply).named;
}

// Asks the daemon for the threads, or one repository's, for sc ps. The daemon answers, as
// the lead's sandbox hides Skelcrew's database.
export async function askForThreads(repository?: string): Promise<ThreadRow[]> {
  const reply = await request({ command: "ps", ...(repository ? { repo: repository } : {}) });
  return checkReply(z.object({ threads: z.array(ThreadRow) }), reply).threads;
}

// Asks the daemon for the tasks of every repository, or of one, for sc ls.
// The daemon answers, as the lead's sandbox hides Skelcrew's database.
export async function askForTasks(repository?: string): Promise<TaskRow[]> {
  const reply = await request({ command: "task ls", ...(repository ? { repo: repository } : {}) });
  return checkReply(z.object({ tasks: z.array(TaskRow) }), reply).tasks;
}

// Asks the daemon for one task, for sc show, named by its task or by its PR's number. The daemon
// answers from Skelcrew's copy, and asks the forge for the logs of failed checks, as only it
// holds the forge's login.
export async function askForTask(which: {
  repo?: string;
  from?: string;
  task?: string;
  pr?: number;
}): Promise<TaskView> {
  const reply = await request({ command: "task show", ...which });
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
// at work is all that changes. `flow` is the flow the task runs, which on a thread at work that
// hasn't submitted yet switches it.
export async function startOn(
  repository: string,
  task: string,
  from?: string,
  short?: string,
  flow?: string,
): Promise<string> {
  const reply = await request({
    command: "start",
    repo: repository,
    task,
    ...(from ? { from } : {}),
    ...(short ? { short } : {}),
    ...(flow ? { flow } : {}),
  });
  return checkReply(z.object({ started: z.string() }), reply).started;
}

// Has the daemon start a thread on a title and body, for sc start in a repository with no
// tracker, and returns what it did, in a sentence naming the thread, such as app-wr1. `short` is
// its short title for the sidebar, and `flow` the flow it runs.
export async function startNew(
  repository: string,
  title: string,
  body: string,
  short?: string,
  flow?: string,
): Promise<string> {
  const reply = await request({
    command: "start new",
    repo: repository,
    title,
    body,
    ...(short ? { short } : {}),
    ...(flow ? { flow } : {}),
  });
  return checkReply(z.object({ started: z.string() }), reply).started;
}

// Has the daemon start a thread on an issue or merge a PR, for s or m on the screen's lists
// and pages, which hold the request ready. Throws the daemon's error, such as the forge's
// reason for refusing a merge. Only your own socket takes a merge, so no agent can merge.
export async function startOrMerge(asked: DaemonRequest): Promise<void> {
  await request(asked);
}

// Has the daemon arm or cancel a merge when ready, for sc merge, and returns what to say. The
// thread is named by its repository and task, or by its PR's number, with `from` naming the
// repository of the checkout sc ran in. Your own socket arms one with `seen`, what you said y to,
// and a lead you let arm merges with `asked`, your words to it, exactly.
export async function planMerge(
  command: "merge when ready" | "merge cancel",
  which: {
    repo?: string;
    task?: string;
    pr?: number;
    from?: string;
    seen?: { pr: number; started: number | null };
    asked?: string;
  },
): Promise<string> {
  const reply = await request({ command, ...which });
  return checkReply(z.object({ said: z.string() }), reply).said;
}

// Asks the daemon which thread and PR sc merge --when-ready names, with its title, when the
// thread started and what to say about its changes to .agents/, so it can ask you about it
// before arming, and arm only that.
export async function previewMerge(which: {
  repo?: string;
  task?: string;
  pr?: number;
  from?: string;
}) {
  const reply = await request({ command: "merge preview", ...which });
  return checkReply(
    z.object({
      thread: z.string(),
      pr: z.number().nullable(),
      title: z.string().nullable(),
      started: z.number().nullable(),
      merging: z.boolean(),
      agents: z.string(),
    }),
    reply,
  );
}

// Has the daemon stop a thread, for sc stop, and returns the thread's name. The daemon
// answers once the builder has exited.
export async function stopOn(repository: string, task: string): Promise<string> {
  const reply = await request({ command: "stop", repo: repository, task });
  return checkReply(z.object({ stopped: z.string() }), reply).stopped;
}

// Asks the daemon what a thread's builder shows now, for sc peek, and returns the thread's
// name and the screen as text. Throws when the builder isn't running.
export async function peekAt(repository: string, task: string) {
  const reply = await request({ command: "peek", repo: repository, task });
  return checkReply(z.object({ thread: z.string(), screen: z.string() }), reply);
}

// Has the daemon stop the turn of a thread's builder, as Esc does, for sc interrupt, and
// returns the thread's name. Throws when the builder isn't running.
export async function interruptOn(repository: string, task: string): Promise<string> {
  const reply = await request({ command: "interrupt", repo: repository, task });
  return checkReply(z.object({ interrupted: z.string() }), reply).interrupted;
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

// Waits for one of the machine's check slots, for sc check, and returns the repository's test
// commands and the connection's file descriptor, when Bun gives it. The daemon keeps the slot
// while the connection stays open: in this process, and in any process the descriptor is handed
// to. `queued` is told the caller's place in
// line when it has to wait. `from` is the remote of the checkout you ran it in; an agent's own
// socket names its repository instead. Throws with the daemon's error, such as when no test
// command is configured, or when nothing answers.
export function takeCheckSlot(given: {
  queued: (place: number) => void;
  from?: string | undefined;
}): Promise<{ test: string[]; fd: number | undefined }> {
  const { queued, from } = given;
  const Line = z.union([
    z.object({ queued: z.number() }),
    z.object({ test: z.array(z.string()) }),
    z.object({ error: z.string() }),
  ]);
  return new Promise((done, fail) => {
    const connection = createConnection(cliSocket());
    let said = "";
    let answered = false;
    const request = { command: "check", ...(from ? { from } : {}) };
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    // Each line is one answer: a place in line, then the commands once a slot is free.
    connection.on("data", (data) => {
      said += data.toString();
      let end = said.indexOf("\n");
      while (end !== -1) {
        const line = Line.safeParse(parseJson(said.slice(0, end)));
        said = said.slice(end + 1);
        end = said.indexOf("\n");
        if (!line.success) {
          answered = true;
          connection.destroy();
          fail(new Error("the daemon answered in a way this Skelcrew doesn't understand"));
        } else if ("queued" in line.data) queued(line.data.queued);
        else if ("error" in line.data) {
          answered = true;
          fail(new Error(line.data.error));
        } else {
          answered = true;
          // Node's socket keeps its descriptor on a field it doesn't publish, so it is read
          // and checked here, and a Bun without it gives none.
          const handle: unknown = Reflect.get(connection, "_handle");
          const read = z.object({ fd: z.number().int().nonnegative() }).safeParse(handle);
          const fd = read.success ? read.data.fd : undefined;
          done({ test: line.data.test, fd });
        }
      }
    });
    connection.on("error", () => {});
    // A daemon that stops while the caller waits leaves it nothing to wait for.
    connection.on("close", () => {
      if (!answered) fail(new Error("the daemon didn't answer: run sc to start it"));
    });
  });
}

// Has the daemon type the lead's message into a thread's builder, for sc tell, and returns the
// line to print: whether it goes in now, or why it waits. The daemon answers at once, and types
// it in once the builder can take it.
export async function tellOn(repository: string, task: string, text: string): Promise<string> {
  const reply = await request({ command: "tell", repo: repository, task, text });
  return checkReply(z.object({ told: z.string() }), reply).told;
}

// Has the daemon type a builder's message into the lead, for sc tell lead. The builder's
// own socket tells the daemon which thread it comes from. The daemon answers at once.
export async function tellTheLead(text: string): Promise<void> {
  await request({ command: "tell lead", text });
}

// Has the daemon type a lead's brief into another repository's lead, for sc tell lead <repo>,
// with the human's words when they asked for it, and returns that repository's name. The
// calling lead's own socket tells the daemon who sends it. The daemon answers at once, and types
// it in once the other lead can take it.
export async function briefOtherLead(to: string, text: string, asked?: string): Promise<string> {
  const reply = await request({ command: "brief lead", to, text, ...(asked ? { asked } : {}) });
  return checkReply(z.object({ briefed: z.string() }), reply).briefed;
}

// Has the daemon review a thread's last submitted commit again, for sc review, and returns
// the thread's name. The daemon answers at once, and the review runs after, as a round's.
export async function reviewAgain(repository: string, task: string): Promise<string> {
  const reply = await request({ command: "review", repo: repository, task });
  return checkReply(z.object({ reviewing: z.string() }), reply).reviewing;
}

// Tells the daemon, for an agent's hook, about its question: asked, so a builder's thread
// needs you, or closed, as AskUserQuestion returned its answer within the same turn. Answered is
// sent whenever something is typed into the agent. It starts a new turn, and for a builder ends
// any question or error. The agent's own socket tells the daemon which agent it is. The daemon
// answers at once, as Claude Code waits on its hooks.
export async function reportQuestion(state: "asked" | "answered" | "closed"): Promise<void> {
  await request({ command: `question ${state}` });
}

// Tells the daemon, for an agent's Stop hook, that it ended its turn, so it shows idle. The
// hook's input on stdin can hold the builder's last message, which goes to the lead when the
// builder stopped without submitting. Input that isn't the hook's is left out, and a terminal
// isn't read, as it would wait for you. The agent's own socket says which agent. When nothing in
// the clone the hook runs in is uncommitted, it also sends the commit checked out: a builder that
// only answered a message while its last submit is reviewed waits on that submit.
export async function reportTurnEnded(): Promise<void> {
  const Input = z.object({ last_assistant_message: z.string().nullish() });
  const text = process.stdin.isTTY ? "" : await Bun.stdin.text();
  const input = Input.safeParse(parseJson(text));
  const message = input.success ? (input.data.last_assistant_message ?? "").trim() : "";
  // The hook runs in the builder's own clone, inside its sandbox. Untracked files count as work
  // left over, whatever the clone's settings say about showing them. A folder git can't read
  // sends no commit, so the turn counts as new work. git status would take the clone's
  // index.lock to refresh the index, and the hook runs right after sc submit, as the reviewer
  // checks the commit out in its view of the clone. A lock there makes that checkout refuse.
  const status = await quietly([
    "git",
    "--no-optional-locks",
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const head = await quietly(["git", "rev-parse", "--verify", "HEAD"]);
  const clean = status.ok && status.out.trim() === "" && head.ok;
  await request({
    command: "turn ended",
    ...(message ? { message: shortened(message) } : {}),
    ...(clean ? { head: head.out.trim() } : {}),
  });
}

// Shortens the builder's last message for the lead, so a long report can't flood it. A question
// or a decision usually comes last, so the end is kept along with the start, and the lead reads
// where and how much was cut, to ask the builder for the rest.
function shortened(message: string): string {
  if (message.length <= 2000) return message;
  const cut = message.length - 2000;
  return `${message.slice(0, 1000)}\n\n[${cut} characters cut]\n\n${message.slice(-1000)}`;
}

// What Claude Code's StopFailure hook gets on stdin: the kind of error, such as rate_limit, and
// what it showed, such as "You've hit your limit · resets 2pm".
const StopFailure = z.looseObject({
  error: z.string().optional(),
  error_details: z.string().optional(),
  last_assistant_message: z.string().optional(),
});

// Tells the daemon, for a Claude Code agent's hook, that its turn ended on an error, such as a
// lapsed login or a usage limit, with what the hook was told of it, so a builder's thread needs
// you or waits for the limit to reset. The agent's own socket says which agent. A hook input that can't be read still reports the error, only without its words.
export async function reportTurnFailed(input: string): Promise<void> {
  let given: unknown = {};
  try {
    given = JSON.parse(input);
  } catch {}
  const hook = StopFailure.safeParse(given);
  const { error, error_details, last_assistant_message } = hook.success ? hook.data : {};
  const message = [last_assistant_message, error_details].filter(Boolean).join("\n");
  await request({
    command: "turn failed",
    ...(error ? { error } : {}),
    ...(message ? { message } : {}),
  });
}

// Tells the daemon, for a Codex agent's Interrupt hook, that you stopped its turn with Esc, so
// it shows idle. The agent's own socket says which one.
export async function reportTurnInterrupted(): Promise<void> {
  await request({ command: "turn interrupted" });
}

// Has the daemon open a repository, by its owner/name, when the list moves to it with Tab, or
// you press Enter on its lead. The daemon starts the repository's lead if it isn't running, and
// marks it as the one you opened last. With `tab`, a repository whose tab you closed by exiting
// its lead stays closed, as the list may still show it for a moment. Without, as Enter on the
// lead asks, it opens again. Returns why the lead couldn't start, as the daemon says, or that
// the daemon didn't answer, or null once it runs.
export async function openRepository(fullName: string, tab: boolean): Promise<string | null> {
  const reply = await ask({ command: "lead", from: fullName, ...(tab ? { tab } : {}) }, 60_000);
  if (reply === null) return "the daemon didn't answer: run sc to start it";
  const failed = z.object({ error: z.string() }).safeParse(reply);
  return failed.success ? failed.data.error : null;
}
