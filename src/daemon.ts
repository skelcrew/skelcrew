// The daemon, run by skel serve: keeps the lead and the threads' builders running, and
// answers the CLI and the agents on their sockets. Plain skel makes sure it runs, then
// attaches to the lead; skel issue and skel start ask it.
import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import { openDb } from "./db.ts";
import { createIssue } from "./github.ts";
import { startLead } from "./lead.ts";
import { cliSocket, daemonSocket, leadSocket, threadSocket } from "./paths.ts";
import { findRepository, refreshClones } from "./repo.ts";
import { setupDone } from "./setup.ts";
import {
  bringBack,
  failThread,
  liveThreads,
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
  z.object({ command: z.literal("lead") }),
  z.object({
    command: z.literal("issue"),
    repo: z.string(),
    title: z.string().min(1),
    body: z.string(),
  }),
  z.object({
    command: z.literal("start"),
    repo: z.string(),
    issue: z.number().int().positive(),
    from: Branch.optional(),
  }),
]);
type Request = z.infer<typeof Request>;
const LeadReply = z.union([z.object({ lead: z.literal(true) }), z.object({ error: z.string() })]);

// Who is on the other end of a socket: you, the lead, or a thread's builder. An agent may ask
// only for what its commands need. Trusting a repository is never a request: only you can,
// in your own terminal.
type Caller = "you" | "lead" | Thread;
const allowed = {
  you: ["status", "lead", "issue", "start"],
  lead: ["status", "issue", "start"],
  builder: ["status"],
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// What the daemon replies, or null when nothing answers. A socket file alone proves nothing:
// a daemon that was killed leaves it behind.
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

// Whether this process now owns the lock. The kernel lets go of it when the process ends,
// however it ends, so a daemon that was killed never leaves it held. Node has no flock, so
// it comes from libc.
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

function listen(server: Server, path: string): Promise<void> {
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(path, () => {
      server.off("error", failed);
      done();
    });
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// It never asks anything: under systemd there is nobody to answer.
export async function serve(tmux: string): Promise<void> {
  if (!setupDone()) throw new Error("the first run isn't done on this machine: run skel first");
  const db = openDb();
  // One start at a time, so two requests can't both find the lead gone and start it twice.
  let starting: Promise<void> = Promise.resolve();
  const lead = () => {
    starting = starting.catch(() => {}).then(() => startLead(db, tmux));
    return starting;
  };
  const sockets: string[] = [];
  const open = async (socket: string, caller: Caller) => {
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    rmSync(socket, { force: true });
    await listen(createServer(answer(caller)), socket);
    sockets.push(socket);
  };
  // A thread that starts over keeps the socket it has.
  const listening = new Set<string>();
  const listenFor = async (thread: Thread) => {
    if (listening.has(thread.folder)) return;
    listening.add(thread.folder);
    await open(threadSocket(thread.folder), thread);
  };
  const begin = async (thread: Thread) => {
    try {
      await setUpThread(db, thread);
      await listenFor(thread);
      await startBuilder(db, tmux, thread);
    } catch (error) {
      failThread(db, thread, error);
    }
  };
  const handle = async (request: Request, caller: Caller): Promise<object> => {
    if (request.command === "status") {
      const thread = typeof caller === "object" ? { thread: threadName(db, caller) } : {};
      return { running: true, pid: process.pid, ...thread };
    }
    if (request.command === "lead") {
      await lead();
      // Not waited on, so attaching never waits on GitHub.
      refreshClones(db).catch((error) => console.log(String(error)));
      return { lead: true };
    }
    if (request.command === "issue") {
      const { owner, repo } = findRepository(db, request.repo);
      return { number: await createIssue(`${owner}/${repo}`, request.title, request.body) };
    }
    const thread = await startThread(db, request);
    // Not waited on: an agent's command must answer quickly, and setup can take minutes.
    begin(thread);
    return { thread: threadName(db, thread) };
  };
  const answer = (caller: Caller) => (connection: Socket) => {
    let request = "";
    const reply = (answer: object) => connection.end(`${JSON.stringify(answer)}\n`);
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
  for (const thread of before) {
    await listenFor(thread);
    bringBack(db, tmux, thread).catch((error) => failThread(db, thread, error));
  }
}

// Asks the daemon on behalf of skel issue and skel start, and returns its answer.
async function request(asked: Request): Promise<unknown> {
  const reply = await ask(asked, 60_000);
  if (reply === null) throw new Error("skel's daemon didn't answer: run skel to start it");
  const failed = z.object({ error: z.string() }).safeParse(reply);
  if (failed.success) throw new Error(failed.data.error);
  return reply;
}

const understood = <T>(schema: z.ZodType<T>, reply: unknown): T => {
  const read = schema.safeParse(reply);
  if (!read.success)
    throw new Error("skel's daemon answered in a way this skel doesn't understand");
  return read.data;
};

export async function fileIssue(repo: string, title: string, body: string): Promise<number> {
  const reply = await request({ command: "issue", repo, title, body });
  return understood(z.object({ number: z.number() }), reply).number;
}

export async function startOn(repo: string, issue: number, from?: string): Promise<string> {
  const reply = await request({ command: "start", repo, issue, ...(from ? { from } : {}) });
  return understood(z.object({ thread: z.string() }), reply).thread;
}

// Returns when you detach with Ctrl-].
export async function attachToLead(tmux: string): Promise<void> {
  // Asking for the lead brings it back if it ended while the daemon kept running.
  let reply = await ask({ command: "lead" }, 15_000);
  if (reply === null) {
    const start = Bun.spawnSync(["systemctl", "--user", "start", "skel"], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    if (!start.success) throw new Error("systemctl couldn't start skel's daemon");
    const deadline = Date.now() + 10_000;
    while (reply === null) {
      if (Date.now() > deadline)
        throw new Error(
          "skel's daemon didn't answer within 10 seconds: journalctl --user -u skel shows why",
        );
      await Bun.sleep(100);
      reply = await ask({ command: "lead" }, 15_000);
    }
  }
  const lead = LeadReply.safeParse(reply);
  if (!lead.success)
    throw new Error("skel's daemon answered in a way this skel doesn't understand");
  if ("error" in lead.data) throw new Error(lead.data.error);
  await attach(tmux, "lead");
}
