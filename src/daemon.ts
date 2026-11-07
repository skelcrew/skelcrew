// The daemon, run by skel serve: keeps the lead and the threads' builders running, and
// answers the CLI and the agents on their sockets.
import { dlopen, FFIType } from "bun:ffi";
import type { Database } from "bun:sqlite";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { openDb } from "./db.ts";
import { stopThread } from "./events.ts";
import { createIssue } from "./github.ts";
import { attachedNote, recordAttachedFrom, startLead, tellLead } from "./lead.ts";
import { listRepositories, listTasks, listThreads, showTask } from "./list.ts";
import { readPage } from "./page.ts";
import { daemonSocket, leadSocket, threadSocket } from "./paths.ts";
import { pollGitHub } from "./poll.ts";
import { bringInNamed, findRepository, refreshClones, repositories } from "./repo.ts";
import { allowed, type Caller, parseJson, Request } from "./requests.ts";
import { goOn, rerunReview, resumeRound, submitRound } from "./round.ts";
import { errorText } from "./say.ts";
import { setupDone } from "./setup.ts";
import { holdAwhile, keepAwake, onSprite, urlPort } from "./sprite.ts";
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

// Returns the thread whose builder is calling, for the requests only a builder may make.
// `allowed` already refuses them from anyone else, so the throw never runs: it is what tells
// the typecheck the caller is a thread.
function callingThread(caller: Caller): Thread {
  if (typeof caller !== "object") throw new Error("only a builder can ask that, from its thread");
  return caller;
}

// Ends the daemon on a signal: removes its sockets, ends what it started, and exits.
// The tmux sessions are left running: agents keep working while the daemon is down. They
// aren't under the daemon. What is, such as a clone or a reviewer, is ended: the service
// stops only the daemon, and the next daemon starts that work again, so a clone left going
// would write into the folder the new one clones into. So the daemon waits for it. Asked
// rather than killed, so git can remove its lock files. The wait blocks on purpose: left to
// run, the daemon would publish a reviewer it just ended as a failed review, where the next
// daemon would have run it again, and a refresh would go on to the next clone.
function endWhatItStarted(sockets: string[]): void {
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
}

// Listens on `port` for GitHub's webhooks, and has each repository send them, so a delivery
// wakes a sleeping Sprite and polls its repository at once.
// Without the listener, events wait until something else wakes the Sprite, and polling
// still sees them then.
function wakeOnWebhooks(db: Database, port: number, poll: (full: string) => void): void {
  // The Sprite sleeps again as soon as the delivery is answered, so it is held for a minute
  // first: long enough for the poll, and for keepAwake to hold it for any work the poll starts.
  const wake = async (repo: string) => {
    await holdAwhile(60).catch((error) =>
      console.log(`couldn't hold the Sprite awake: ${errorText(error)}`),
    );
    poll(repo);
  };
  try {
    listenForWebhooks(port, webhookSecret(), wake);
  } catch (error) {
    console.log(`couldn't listen for GitHub's webhooks on port ${port}: ${errorText(error)}`);
  }
  // Set again at each start, so a webhook deleted on GitHub, or one an older skel set with
  // other events, is put right.
  for (const { owner, repo } of repositories(db))
    hookRepository(`${owner}/${repo}`).catch((error) => console.log(errorText(error)));
}

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
  // Carries out a request the caller may make, and returns the reply to send. The switch has
  // no default, so the typecheck fails if a request is left out.
  const handle = async (request: Request, caller: Caller): Promise<object> => {
    switch (request.command) {
      case "status": {
        const thread = typeof caller === "object" ? { thread: threadName(db, caller) } : {};
        return { running: true, pid: process.pid, ...thread };
      }
      case "lead":
        await lead();
        recordAttachedFrom(db, request.from);
        // A lead that wasn't running kept its notes until now.
        tellLead(db, tmux);
        // Not waited on, so attaching never waits on GitHub.
        refreshClones(db).catch((error) => console.log(String(error)));
        return { lead: true };
      case "attached":
        return { note: attachedNote(db) };
      case "screen opened":
        for (const { owner, repo } of repositories(db)) poll(`${owner}/${repo}`);
        return { polling: true };
      case "page":
        return { page: await readPage(request.url) };
      case "repo ls":
        return { repositories: listRepositories(db) };
      case "ps":
        return { threads: listThreads(db, request.repo) };
      case "task ls":
        return { tasks: await listTasks(db, request.repo) };
      case "task show":
        return { task: await showTask(db, request.repo, request.task) };
      case "task create": {
        const { owner, repo, name } = findRepository(db, request.repo);
        const number = await createIssue(`${owner}/${repo}`, request.title, request.body);
        return { task: `${name}-${number}` };
      }
      case "review": {
        const thread = findThread(db, request.repo, request.task);
        rerunReview(db, tmux, thread.folder);
        return { reviewing: threadName(db, thread) };
      }
      case "stop": {
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
      case "submit": {
        const thread = callingThread(caller);
        submitRound(db, tmux, thread.folder, request.summary);
        return { submitted: threadName(db, thread) };
      }
      case "question asked":
        record(db, callingThread(caller).folder, { asking: true }, "its builder asked a question");
        tellLead(db, tmux);
        return { asking: true };
      case "question answered": {
        const { folder } = callingThread(caller);
        // Run before every message typed into the builder, so only a question that was open
        // is logged.
        if (readThread(db, folder).asking)
          record(db, folder, { asking: false }, "its builder's question is over");
        return { asking: false };
      }
      case "start": {
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
      }
    }
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
        bringInFirst(asked.data, caller).then(reply, (error) => reply({ error: errorText(error) }));
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
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => endWhatItStarted(sockets));
  console.log(`Listening on ${path}.`);
  await lead().catch((error) => console.log(errorText(error)));
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
  wakeOnWebhooks(db, port, poll);
}
