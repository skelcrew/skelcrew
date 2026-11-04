// The daemon, run by skel serve: keeps the lead and the threads' builders running, and
// answers the CLI and the agents on their sockets. Plain skel makes sure it runs, then
// attaches to the lead; skel task create and skel start ask it.
import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import { openDb } from "./db.ts";
import { createIssue } from "./github.ts";
import { startLead, tellAttachedFrom, tellLead } from "./lead.ts";
import {
  listRepositories,
  listTasks,
  listThreads,
  RepositoryRow,
  TaskRow,
  ThreadRow,
} from "./list.ts";
import { cliSocket, daemonSocket, leadSocket, threadSocket } from "./paths.ts";
import { findRepository, refreshClones } from "./repo.ts";
import { resumeRound, submitRound } from "./round.ts";
import { setupDone } from "./setup.ts";
import { onSprite, serviceLog, startSpriteService } from "./sprite.ts";
import {
  bringBack,
  failThread,
  liveThreads,
  readThread,
  record,
  setUpThread,
  startBuilder,
  startThread,
  type Thread,
  threadName,
} from "./thread.ts";
import { attach } from "./tmux.ts";

// Only what a branch name holds: it goes into what git fetches, where a : or * would ask
// for something else.
const Branch = z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/);

const Request = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }),
  z.object({ command: z.literal("lead"), from: z.string().optional() }),
  z.object({ command: z.literal("repo ls") }),
  z.object({ command: z.literal("ps"), repo: z.string().optional() }),
  z.object({ command: z.literal("task ls"), repo: z.string().optional() }),
  z.object({
    command: z.literal("task create"),
    repo: z.string(),
    title: z.string().min(1),
    body: z.string(),
  }),
  z.object({
    command: z.literal("start"),
    repo: z.string(),
    task: z.number().int().positive(),
    from: Branch.optional(),
  }),
  z.object({ command: z.literal("submit"), summary: z.string().min(1) }),
  z.object({ command: z.literal("question asked") }),
  z.object({ command: z.literal("question answered") }),
]);
type Request = z.infer<typeof Request>;
const LeadReply = z.union([z.object({ lead: z.literal(true) }), z.object({ error: z.string() })]);

// Who is on the other end of a socket: you, the lead, or a thread's builder. An agent may ask
// only for what its commands need. Trusting a repository is never a request: only you can,
// in your own terminal.
type Caller = "you" | "lead" | Thread;
const allowed = {
  you: ["status", "lead", "repo ls", "ps", "task ls", "task create", "start"],
  lead: ["status", "repo ls", "ps", "task ls", "task create", "start"],
  builder: ["status", "submit", "question asked", "question answered"],
};

// Returns a decoded socket message, or undefined so invalid JSON can be rejected without
// crashing.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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

// Tries to hold the daemon lock and returns whether this process owns it, preventing
// duplicate daemons. The kernel lets go of it when the process ends, however it ends, so a
// daemon that was killed never leaves it held. Node has no flock, so it comes from libc.
function lock(path: string): boolean {
  const libc = dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  // Never closed: closing it would let go of the lock.
  const fd = openSync(path, "a", 0o600);
  return libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0;
}

// Opens a daemon socket and waits until it can accept requests, rejecting if opening it
// fails.
function listen(server: Server, path: string): Promise<void> {
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(path, () => {
      server.off("error", failed);
      done();
    });
  });
}

// Returns the text of anything thrown, for replies and the daemon's log.
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Opens the daemon's sockets, starts the lead, and brings back the builders of threads that
// were running, so commands and agents can reach it. Leaves the sockets listening after
// returning, and removes them when stopped, leaving every tmux session running. It never
// asks questions: systemd has nobody to answer.
export async function serve(tmux: string): Promise<void> {
  if (!setupDone()) throw new Error("the first run isn't done on this machine: run skel first");
  const db = openDb();
  let starting: Promise<void> = Promise.resolve();
  // Serializes lead starts so simultaneous requests cannot create two sessions.
  const lead = () => {
    starting = starting.catch(() => {}).then(() => startLead(db, tmux));
    return starting;
  };
  const sockets: string[] = [];
  // Opens a socket that answers the given caller, removing one a killed daemon left behind,
  // and keeps its path so stopping removes it.
  const open = async (socket: string, caller: Caller) => {
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    rmSync(socket, { force: true });
    await listen(createServer(answer(caller)), socket);
    sockets.push(socket);
  };
  const listening = new Set<string>();
  // Opens a thread's own socket, so the daemon knows which thread calls on it. A thread that
  // starts over keeps the socket it has.
  const listenFor = async (thread: Thread) => {
    if (listening.has(thread.folder)) return;
    listening.add(thread.folder);
    await open(threadSocket(thread.folder), thread);
  };
  // Sets up a new thread's clone, opens its socket and starts its builder, after skel start
  // has had its answer. Marks the thread failed, with the reason, when any of it fails.
  const begin = async (thread: Thread) => {
    try {
      await setUpThread(db, thread);
      await listenFor(thread);
      await startBuilder(db, tmux, thread);
    } catch (error) {
      failThread(db, thread, error);
    }
  };
  // Carries out a request the caller may make, and returns the reply to send.
  const handle = async (request: Request, caller: Caller): Promise<object> => {
    if (request.command === "status") {
      const thread = typeof caller === "object" ? { thread: threadName(db, caller) } : {};
      return { running: true, pid: process.pid, ...thread };
    }
    if (request.command === "lead") {
      await lead();
      tellAttachedFrom(db, tmux, request.from);
      // A lead that wasn't running kept its notes until now.
      tellLead(db, tmux);
      // Not waited on, so attaching never waits on GitHub.
      refreshClones(db).catch((error) => console.log(String(error)));
      return { lead: true };
    }
    if (request.command === "repo ls") return { repositories: listRepositories(db) };
    if (request.command === "ps") return { threads: listThreads(db, request.repo) };
    if (request.command === "task ls") return { tasks: await listTasks(db, request.repo) };
    if (request.command === "task create") {
      const { owner, repo, name } = findRepository(db, request.repo);
      const number = await createIssue(`${owner}/${repo}`, request.title, request.body);
      return { task: `${name}-${number}` };
    }
    if (request.command === "submit" && typeof caller === "object") {
      submitRound(db, tmux, caller.folder, request.summary);
      return { submitted: threadName(db, caller) };
    }
    if (request.command === "question asked" && typeof caller === "object") {
      record(db, caller.folder, { asking: true }, "its builder asked a question");
      tellLead(db, tmux);
      return { asking: true };
    }
    if (request.command === "question answered" && typeof caller === "object") {
      // Run before every message typed into the builder, so only a question that was open
      // is logged.
      if (readThread(db, caller.folder).asking)
        record(db, caller.folder, { asking: false }, "its builder's question is over");
      return { asking: false };
    }
    if (request.command !== "start")
      throw new Error("only a builder can ask that, from its thread");
    const thread = await startThread(db, request);
    // Not waited on: an agent's command must answer quickly, and setup can take minutes.
    begin(thread);
    return { thread: threadName(db, thread) };
  };
  // Returns a handler for connections from the given caller: it reads one request, refuses
  // what that caller may not ask, and answers the rest.
  const answer = (caller: Caller) => (connection: Socket) => {
    let request = "";
    // Sends one JSON reply and closes the connection so the caller knows the request
    // finished.
    const reply = (answer: object) => connection.end(`${JSON.stringify(answer)}\n`);
    // Gathers data until the request's line is whole, then refuses it or has it handled.
    const read = (data: Buffer) => {
      request += data.toString();
      const end = request.indexOf("\n");
      if (end === -1) return;
      // One request per connection: more data while it runs must not run it again.
      connection.off("data", read);
      const asked = Request.safeParse(parseJson(request.slice(0, end)));
      const kind = typeof caller === "object" ? "builder" : caller;
      if (!asked.success || !allowed[kind].includes(asked.data.command))
        reply({ error: "skel's daemon doesn't know that request" });
      else handle(asked.data, caller).then(reply, (error) => reply({ error: message(error) }));
    };
    connection.on("data", read);
    connection.on("error", () => {});
  };
  // The lock decides which of two daemons started together runs. The socket can't: both
  // could find one left by a daemon that was killed, and each remove the other's new one.
  const path = daemonSocket();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!lock(`${path}.lock`))
    throw new Error("skel's daemon is already running. Run skel to attach to the lead.");
  // Taken before any request comes in, so a thread started meanwhile, still setting up,
  // isn't taken for one whose setup the daemon's stop cut short.
  const before = liveThreads(db);
  await open(path, "you");
  await open(leadSocket(), "lead");
  // The tmux sessions are left running: agents keep working while the daemon is down.
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      for (const socket of sockets) rmSync(socket, { force: true });
      process.exit(0);
    });
  console.log(`Listening on ${path}.`);
  await lead().catch((error) => console.log(message(error)));
  // Notes the daemon's stop kept from the lead.
  tellLead(db, tmux);
  for (const thread of before) {
    await listenFor(thread);
    // After the builder is back, since the round may type into its session.
    bringBack(db, tmux, thread).then(
      () => resumeRound(db, tmux, thread.folder),
      (error) => failThread(db, thread, error),
    );
  }
}

// Asks the daemon on behalf of skel task create and skel start, and returns its answer. Throws
// with the daemon's error, or when nothing answers.
async function request(asked: Request): Promise<unknown> {
  const reply = await ask(asked, 60_000);
  if (reply === null) throw new Error("skel's daemon didn't answer: run skel to start it");
  const failed = z.object({ error: z.string() }).safeParse(reply);
  if (failed.success) throw new Error(failed.data.error);
  return reply;
}

// Returns the daemon's reply checked against the shape this skel expects, so a daemon of
// another version fails with a clear message.
const understood = <T>(schema: z.ZodType<T>, reply: unknown): T => {
  const read = schema.safeParse(reply);
  if (!read.success)
    throw new Error("skel's daemon answered in a way this skel doesn't understand");
  return read.data;
};

// Asks the daemon for the repositories, for skel repo ls run by the lead. The daemon
// answers, as the lead's sandbox hides skel's database.
export async function repos(): Promise<RepositoryRow[]> {
  const reply = await request({ command: "repo ls" });
  return understood(z.object({ repositories: z.array(RepositoryRow) }), reply).repositories;
}

// Asks the daemon for the threads, or one repository's, for skel ps. The daemon answers, as
// the lead's sandbox hides skel's database.
export async function threads(repo?: string): Promise<ThreadRow[]> {
  const reply = await request({ command: "ps", ...(repo ? { repo } : {}) });
  return understood(z.object({ threads: z.array(ThreadRow) }), reply).threads;
}

// Asks the daemon for the open tasks of every repository, or of one, for skel task ls. The
// daemon answers, as only it may call GitHub.
export async function tasks(repo?: string): Promise<TaskRow[]> {
  const reply = await request({ command: "task ls", ...(repo ? { repo } : {}) });
  return understood(z.object({ tasks: z.array(TaskRow) }), reply).tasks;
}

// Has the daemon create a task, as a GitHub issue, for skel task create, and returns the
// task's name, such as app-13. The daemon makes the call, since agents never hold a GitHub
// login.
export async function createTask(repo: string, title: string, body: string): Promise<string> {
  const reply = await request({ command: "task create", repo, title, body });
  return understood(z.object({ task: z.string() }), reply).task;
}

// Has the daemon start a thread on a task, for skel start, and returns the thread's name.
// The daemon answers once the thread is recorded; its setup and builder come after.
export async function startOn(repo: string, task: number, from?: string): Promise<string> {
  const reply = await request({ command: "start", repo, task, ...(from ? { from } : {}) });
  return understood(z.object({ thread: z.string() }), reply).thread;
}

// Has the daemon start a round for skel submit, run by a builder in its sandbox, and returns
// the thread's name. The builder's own socket tells the daemon which thread it is. The
// daemon answers at once, and pushes and starts the review after.
export async function submitForReview(summary: string): Promise<string> {
  const reply = await request({ command: "submit", summary });
  return understood(z.object({ submitted: z.string() }), reply).submitted;
}

// Tells the daemon, for a builder's hook, that its builder is asking you a question, so the
// thread needs you, or that the question is over. The builder's own socket tells the daemon
// which thread it is. The daemon answers at once, as Claude Code waits on its hooks.
export async function question(asking: boolean): Promise<void> {
  await request({ command: asking ? "question asked" : "question answered" });
}

// Ensures the daemon and lead are running, then attaches your terminal until you detach
// with Ctrl-]. The daemon tells the lead which repository you attached from, as owner/repo,
// or that there is none.
export async function attachToLead(tmux: string, from?: string): Promise<void> {
  const asked: Request = { command: "lead", ...(from ? { from } : {}) };
  // Asking for the lead brings it back if it ended while the daemon kept running.
  let reply = await ask(asked, 15_000);
  if (reply === null) {
    const sprite = onSprite();
    if (sprite) startSpriteService();
    else {
      const start = Bun.spawnSync(["systemctl", "--user", "start", "skel"], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      if (!start.success) throw new Error("systemctl couldn't start skel's daemon");
    }
    const deadline = Date.now() + 10_000;
    while (reply === null) {
      if (Date.now() > deadline)
        throw new Error(
          `skel's daemon didn't answer within 10 seconds: ${sprite ? serviceLog : "journalctl --user -u skel"} shows why`,
        );
      await Bun.sleep(100);
      reply = await ask(asked, 15_000);
    }
  }
  const lead = LeadReply.safeParse(reply);
  if (!lead.success)
    throw new Error("skel's daemon answered in a way this skel doesn't understand");
  if ("error" in lead.data) throw new Error(lead.data.error);
  await attach(tmux, "lead");
}
