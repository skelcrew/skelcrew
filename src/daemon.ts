// The daemon, run by skel serve: keeps the lead and the threads' builders running, and
// answers the CLI and the agents on their sockets. Plain skel makes sure it runs, then
// attaches to the lead; skel task create and skel start ask it.
import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import { openDb } from "./db.ts";
import { stopThread } from "./events.ts";
import { createIssue } from "./github.ts";
import { daemonLog, startLaunchAgent } from "./launchd.ts";
import { attachedNote, recordAttachedFrom, startLead, tellLead } from "./lead.ts";
import {
  listRepositories,
  listTasks,
  listThreads,
  RepositoryRow,
  showTask,
  TaskRow,
  TaskView,
  ThreadRow,
} from "./list.ts";
import { Page, PageUrl, readPage } from "./page.ts";
import { cliSocket, daemonSocket, leadSocket, threadSocket } from "./paths.ts";
import { pollGitHub } from "./poll.ts";
import { bringInNamed, findRepository, refreshClones, repositories } from "./repo.ts";
import { goOn, rerunReview, resumeRound, submitRound } from "./round.ts";
import { openScreen } from "./screen.ts";
import { setupDone } from "./setup.ts";
import {
  holdAwhile,
  keepAwake,
  onSprite,
  serviceLog,
  startSpriteService,
  urlPort,
} from "./sprite.ts";
import {
  bringBack,
  failThread,
  findThread,
  hasWork,
  liveThreads,
  readThread,
  record,
  setUpThread,
  startBuilder,
  startThread,
  type Thread,
  threadConfig,
  threadName,
  threadOn,
} from "./thread.ts";
import { processTree, stillRunning } from "./tmux.ts";
import { hookRepository, listenForWebhooks, webhookSecret } from "./webhook.ts";

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
    command: z.literal("task show"),
    repo: z.string(),
    task: z.number().int().positive(),
  }),
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
  z.object({
    command: z.literal("review"),
    repo: z.string(),
    task: z.number().int().positive(),
  }),
  z.object({
    command: z.literal("stop"),
    repo: z.string(),
    task: z.number().int().positive(),
  }),
  z.object({ command: z.literal("submit"), summary: z.string().min(1) }),
  z.object({ command: z.literal("question asked") }),
  z.object({ command: z.literal("question answered") }),
  z.object({ command: z.literal("attached") }),
  z.object({ command: z.literal("screen opened") }),
  z.object({ command: z.literal("page"), url: PageUrl }),
]);
type Request = z.infer<typeof Request>;
const LeadReply = z.union([z.object({ lead: z.literal(true) }), z.object({ error: z.string() })]);

// Who is on the other end of a socket: you, the lead, or a thread's builder. An agent may ask
// only for what its commands need. Trusting a repository is never a request: only you can,
// in your own terminal.
type Caller = "you" | "lead" | Thread;
const allowed = {
  you: [
    "status",
    "lead",
    "repo ls",
    "ps",
    "task ls",
    "task show",
    "task create",
    "start",
    "review",
    "stop",
    "screen opened",
    "page",
  ],
  lead: [
    "status",
    "repo ls",
    "ps",
    "task ls",
    "task show",
    "task create",
    "start",
    "review",
    "stop",
    "attached",
  ],
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
  const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
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
// asks questions: systemd has nobody to answer. Polls GitHub every `every` milliseconds while
// a thread is active. On a Sprite, keeps the Sprite awake while there is work, and listens on
// `port` for GitHub's webhooks, which wake it while it sleeps.
export async function serve(tmux: string, every = 30_000, port = urlPort): Promise<void> {
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
  // Polls one repository at once. Until polling starts it does nothing, as the first poll comes
  // as soon as it does.
  let poll: (full: string) => void = () => {};
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
  // Brings back a stopped thread's builder for skel start, with --resume on its last session
  // in the same clone, then carries on the round its stop cut short, as after a restart.
  // Marks the thread failed, with the reason, when the builder can't start.
  const resume = async (stopped: Thread) => {
    // Its builder sits at its prompt once back, as its turn ended with the stop. It waits when
    // a round or its PR will wake it: a submit or review under way, or the PR's checks,
    // reviews and comments. It works when it has a review's changes to be typed in, or no PR
    // yet.
    const { pr, submitting, reviewing, telling } = stopped;
    const handed = telling === null && (pr !== null || submitting !== null || reviewing !== null);
    const thread = record(
      db,
      stopped.folder,
      { status: handed ? "waiting" : "working" },
      "started again",
    );
    try {
      await listenFor(thread);
      await bringBack(db, tmux, thread);
      resumeRound(db, tmux, thread.folder);
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
      recordAttachedFrom(db, request.from);
      // A lead that wasn't running kept its notes until now.
      tellLead(db, tmux);
      // Not waited on, so attaching never waits on GitHub.
      refreshClones(db).catch((error) => console.log(String(error)));
      return { lead: true };
    }
    if (request.command === "attached") return { note: attachedNote(db) };
    if (request.command === "screen opened") {
      for (const { owner, repo } of repositories(db)) poll(`${owner}/${repo}`);
      return { polling: true };
    }
    if (request.command === "page") return { page: await readPage(request.url) };
    if (request.command === "repo ls") return { repositories: listRepositories(db) };
    if (request.command === "ps") return { threads: listThreads(db, request.repo) };
    if (request.command === "task ls") return { tasks: await listTasks(db, request.repo) };
    if (request.command === "task show")
      return { task: await showTask(db, request.repo, request.task) };
    if (request.command === "task create") {
      const { owner, repo, name } = findRepository(db, request.repo);
      const number = await createIssue(`${owner}/${repo}`, request.title, request.body);
      return { task: `${name}-${number}` };
    }
    if (request.command === "review") {
      const thread = findThread(db, request.repo, request.task);
      rerunReview(db, tmux, thread.folder);
      return { reviewing: threadName(db, thread) };
    }
    if (request.command === "stop") {
      const thread = findThread(db, request.repo, request.task);
      const name = threadName(db, thread);
      if (thread.status === "stopped") throw new Error(`${name} is stopped already`);
      if (thread.status !== "working" && thread.status !== "waiting")
        throw new Error(`${name} is ${thread.status}, so it has no builder to stop`);
      // Its setup would go on to start the builder after the stop.
      if (thread.session === null)
        throw new Error(`${name} is still setting up: stop it once its builder has started`);
      await stopThread(db, tmux, thread);
      return { stopped: name };
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
    const before = threadOn(db, request.repo, request.task);
    if (before?.status === "stopped") {
      const name = threadName(db, before);
      resume(before);
      return { started: `Started ${name} again: its builder is back where it was.` };
    }
    const live = before?.status === "working" || before?.status === "waiting";
    if (before && live && before.rounds > threadConfig().maxRounds) {
      goOn(db, tmux, before.folder);
      return { started: `${threadName(db, before)} goes on past the round limit.` };
    }
    const thread = await startThread(db, request);
    // Not waited on: an agent's command must answer quickly, and setup can take minutes.
    begin(thread);
    return { started: `Started ${threadName(db, thread)}.` };
  };
  // Brings in a repository that task ls, task show, task create or start names by its full
  // GitHub name, when skel doesn't have it, then carries out the command. The reply says so,
  // so whoever asked learns its short name, and that its clone comes after.
  const bringInFirst = async (request: Request, caller: Caller): Promise<object> => {
    const naming = ["task ls", "task show", "task create", "start"].includes(request.command);
    if (!naming || !("repo" in request) || !request.repo) return handle(request, caller);
    const brought = await bringInNamed(db, request.repo);
    if (!brought) return handle(request, caller);
    // GitHub can answer an old name with the repository's new one, which is the name skel
    // now has it by.
    const reply = await handle({ ...request, repo: brought.name }, caller);
    return {
      ...reply,
      broughtIn: { github: `${brought.owner}/${brought.repo}`, name: brought.name },
    };
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
        reply({ error: "the daemon doesn't know that request" });
      else
        bringInFirst(asked.data, caller).then(reply, (error) => reply({ error: message(error) }));
    };
    connection.on("data", read);
    connection.on("error", () => {});
  };
  // The lock decides which of two daemons started together runs. The socket can't: both
  // could find one left by a daemon that was killed, and each remove the other's new one.
  const path = daemonSocket();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!lock(`${path}.lock`))
    throw new Error("the daemon is already running. Run skel to attach to the lead.");
  // Taken before any request comes in, so a thread started meanwhile, still setting up,
  // isn't taken for one whose setup the daemon's stop cut short.
  const before = liveThreads(db);
  await open(path, "you");
  await open(leadSocket(), "lead");
  // The tmux sessions are left running: agents keep working while the daemon is down. They
  // aren't under the daemon. What is, such as a clone or a reviewer, is ended: the service
  // stops only the daemon, and the next daemon starts that work again, so a clone left going
  // would write into the folder the new one clones into. So the daemon waits for it. Asked
  // rather than killed, so git can remove its lock files. The wait blocks on purpose: left to
  // run, the daemon would publish a reviewer it just ended as a failed review, where the next
  // daemon would have run it again, and a refresh would go on to the next clone.
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      for (const socket of sockets) rmSync(socket, { force: true });
      const started = processTree(process.pid).slice(1);
      const end = (pids: number[], signal: NodeJS.Signals) => {
        for (const pid of pids)
          try {
            process.kill(pid, signal);
          } catch {}
      };
      end(started, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (stillRunning(started).length > 0 && Date.now() < deadline) Bun.sleepSync(50);
      end(stillRunning(started), "SIGKILL");
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
  poll = pollGitHub(db, tmux, every, begin);
  if (!onSprite()) return;
  keepAwake(() => hasWork(liveThreads(db)));
  // Without the listener, events wait until something else wakes the Sprite, and polling
  // still sees them then.
  // The Sprite sleeps again as soon as the delivery is answered, so it is held for a minute
  // first: long enough for the poll, and for keepAwake to hold it for any work the poll starts.
  const wake = async (repo: string) => {
    await holdAwhile(60).catch((error) =>
      console.log(`couldn't hold the Sprite awake: ${message(error)}`),
    );
    poll(repo);
  };
  try {
    listenForWebhooks(port, webhookSecret(), wake);
  } catch (error) {
    console.log(`couldn't listen for GitHub's webhooks on port ${port}: ${message(error)}`);
  }
  // Set again at each start, so a webhook deleted on GitHub, or one an older skel set with
  // other events, is put right.
  for (const { owner, repo } of repositories(db))
    hookRepository(`${owner}/${repo}`).catch((error) => console.log(message(error)));
}

// Asks the daemon on behalf of skel task create and skel start, and returns its answer. Throws
// with the daemon's error, or when nothing answers.
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

// Asks the daemon for one task, for skel task show. The daemon answers, as only it may call
// GitHub.
export async function task(repo: string, number: number): Promise<TaskView> {
  const reply = await request({ command: "task show", repo, task: number });
  return understood(z.object({ task: TaskView }), reply).task;
}

// Has the daemon create a task, as a GitHub issue, for skel task create, and returns the
// task's name, such as app-13. The daemon makes the call, since agents never hold a GitHub
// login.
export async function createTask(repo: string, title: string, body: string): Promise<string> {
  const reply = await request({ command: "task create", repo, title, body });
  return understood(z.object({ task: z.string() }), reply).task;
}

// Has the daemon start a thread on a task, for skel start, and returns what it did, in a
// sentence: started a new thread, brought back a stopped one's builder, or let one past the
// round limit go on. The daemon answers once the thread is recorded; its setup and builder
// come after.
export async function startOn(repo: string, task: number, from?: string): Promise<string> {
  const reply = await request({ command: "start", repo, task, ...(from ? { from } : {}) });
  return understood(z.object({ started: z.string() }), reply).started;
}

// Has the daemon stop a thread, for skel stop, and returns the thread's name. The daemon
// answers once the builder has exited.
export async function stopOn(repo: string, task: number): Promise<string> {
  const reply = await request({ command: "stop", repo, task });
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
export async function reviewAgain(repo: string, task: number): Promise<string> {
  const reply = await request({ command: "review", repo, task });
  return understood(z.object({ reviewing: z.string() }), reply).reviewing;
}

// Tells the daemon, for a builder's hook, that its builder is asking you a question, so the
// thread needs you, or that the question is over. The builder's own socket tells the daemon
// which thread it is. The daemon answers at once, as Claude Code waits on its hooks.
export async function question(asking: boolean): Promise<void> {
  await request({ command: asking ? "question asked" : "question answered" });
}

// Returns the note telling the lead where you attached from, for the lead's hook, or nothing
// when it has nothing new. Claude Code holds your message until the hook ends, so it gives
// up quickly, and never throws: a daemon that is down must not stop your message.
export async function attached(): Promise<string> {
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
    const sprite = onSprite();
    const mac = process.platform === "darwin";
    if (sprite) startSpriteService();
    else if (mac) startLaunchAgent();
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
          `skel's daemon didn't answer within 10 seconds: ${sprite ? serviceLog : mac ? daemonLog() : "journalctl --user -u skel"} shows why`,
        );
      await Bun.sleep(100);
      reply = await ask(asked, 15_000);
    }
  }
  const lead = LeadReply.safeParse(reply);
  if (!lead.success) throw new Error("the daemon answered in a way this skel doesn't understand");
  if ("error" in lead.data) throw new Error(lead.data.error);
  await openScreen(tmux, "lead");
}
