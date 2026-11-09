// The daemon, run by skel serve: keeps each repository's lead and the threads' builders
// running, and answers the CLI and the agents on their sockets.
import { dlopen, FFIType } from "bun:ffi";
import type { Database } from "bun:sqlite";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { processTree, stillRunning } from "../agents/tmux.ts";
import { openDb, type Repository } from "../db.ts";
import { createIssue } from "../github.ts";
import { setupDone } from "../machine/setup.ts";
import { holdAwhile, keepAwake, onSprite, urlPort } from "../machine/sprite.ts";
import { keepUpToDate } from "../machine/update.ts";
import { daemonSocket, threadSocket } from "../paths.ts";
import { installedPlugins, trackedBy } from "../plugins/plugin.ts";
import { errorText } from "../say.ts";
import { checkoutFolder, git, release, singleFile } from "../version.ts";
import {
  bringBack,
  failThread,
  setUpThread,
  startBuilder,
  startChoice,
  startThread,
  statusOnceBack,
} from "./builder.ts";
import { stopThread } from "./events.ts";
import { lastOpened, leadOf, openedRepositories, startLead, tellLead } from "./lead.ts";
import { listRepositories, listTasks, listThreads, showTask } from "./list.ts";
import { readPage } from "./page.ts";
import { pollGitHub } from "./poll.ts";
import { findRepository, fullNameIs, noRepositories, refreshClones, repositories } from "./repo.ts";
import { allowed, type Caller, DaemonRequest, parseJson } from "./requests.ts";
import { goOn, rerunReview, resumeRound, submitRound } from "./round.ts";
import { messageBuilder, messageLead } from "./tell.ts";
import {
  endedTurnAsks,
  findThread,
  hasWork,
  liveThreads,
  readThread,
  record,
  type Thread,
  threadName,
  threadOn,
} from "./thread.ts";
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

// Returns the thread whose builder is calling, or null when you or a lead call.
const builderOf = (caller: Caller): Thread | null =>
  caller === "you" || "lead" in caller ? null : caller;

// Returns the repository whose lead is calling, as owner and GitHub name, or null when you or
// a builder call.
const leadOfCaller = (caller: Caller) =>
  caller !== "you" && "lead" in caller ? caller.lead : null;

// Returns the thread whose builder is calling, for the requests only a builder may make.
// `allowed` already refuses them from anyone else, so the throw never runs: it is what tells
// the typecheck the caller is a thread.
function callingThread(caller: Caller): Thread {
  const thread = builderOf(caller);
  if (thread === null) throw new Error("only a builder can ask that, from its thread");
  return thread;
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
// wakes a sleeping Sprite and polls its repository at once. A delivery to a plugin's name
// polls the repositories it is the tracker of.
// Without the listener, events wait until something else wakes the Sprite, and polling
// still sees them then.
function wakeOnWebhooks(db: Database, port: number, poll: (fullName: string) => void): void {
  // The Sprite sleeps again as soon as the delivery is answered, so it is held for a minute
  // first: long enough for the poll, and for keepAwake to hold it for any work the poll starts.
  const wake = async (fullName: string) => {
    await holdAwhile(60).catch((error) =>
      console.log(`couldn't hold the Sprite awake: ${errorText(error)}`),
    );
    poll(fullName);
  };
  // A plugin's delivery polls each repository it is the tracker of.
  const wakePlugin = async (name: string) => {
    if (!installedPlugins(db).some((plugin) => plugin.name === name)) return false;
    const tracked = trackedBy(db, name);
    if (tracked.length > 0)
      await holdAwhile(60).catch((error) =>
        console.log(`couldn't hold the Sprite awake: ${errorText(error)}`),
      );
    for (const { owner, repo } of tracked) poll(`${owner}/${repo}`);
    return true;
  };
  try {
    listenForWebhooks(port, webhookSecret(), wake, wakePlugin);
  } catch (error) {
    console.log(`couldn't listen for GitHub's webhooks on port ${port}: ${errorText(error)}`);
  }
  // Set again at each start, so a webhook deleted on GitHub, or one that asks for other
  // events than this skel wants, is put right.
  for (const { owner, repo } of repositories(db))
    hookRepository(`${owner}/${repo}`).catch((error) => console.log(errorText(error)));
}

// Opens the daemon's sockets, brings back the lead of each repository you have opened and
// the builders of threads that were running, so commands and agents can reach it. Leaves the
// sockets listening after returning, and removes them when stopped, leaving every tmux
// session running. It never asks questions: systemd has nobody to answer. Polls GitHub every `every` milliseconds while
// a thread is active. On a Sprite, keeps the Sprite awake while there is work, and listens on
// `port` for GitHub's webhooks, which wake it while it sleeps.
export async function serve(tmux: string, every = 30_000, port = urlPort): Promise<void> {
  if (!setupDone()) throw new Error("the first run isn't done on this machine: run skel first");
  const db = openDb();
  // The checkout and commit this daemon's code came from, read once, as it loaded that code
  // when it started: a git pull since doesn't change what runs.
  const started = singleFile
    ? {}
    : { folder: checkoutFolder, commit: git("rev-parse", "--short", "HEAD") };
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
  let poll: (fullName: string) => void = () => {};
  const listening = new Set<string>();
  // Opens a thread's own socket, so the daemon knows which thread calls on it. A thread that
  // starts over keeps the socket it has.
  const listenFor = async (thread: Thread) => {
    const socket = threadSocket(thread.folder);
    if (listening.has(socket)) return;
    listening.add(socket);
    await open(socket, thread);
  };
  let starting: Promise<void> = Promise.resolve();
  // Opens a repository's lead's own socket, so the daemon knows which lead calls on it, then
  // keeps the lead running or starts it. One at a time, so two requests at once can't start
  // two sessions.
  const lead = (repository: Repository) => {
    starting = starting
      .catch(() => {})
      .then(async () => {
        const { owner, repo } = repository;
        const { socket } = leadOf(db, owner, repo);
        if (!listening.has(socket)) {
          listening.add(socket);
          await open(socket, { lead: { owner, repo } });
        }
        await startLead(db, tmux, repository);
      });
    return starting;
  };
  // Returns the request as a lead may make it: about its own repository. A lead sees only its
  // own, so a request about another is refused, and it asks you to open that one instead. skel
  // ps and skel task ls with no repository mean every one, which for a lead is its own. Your
  // requests and a builder's are left as they are.
  const within = (request: DaemonRequest, caller: Caller): DaemonRequest => {
    const yours = leadOfCaller(caller);
    if (yours === null) return request;
    const own = `${yours.owner}/${yours.repo}`;
    if ((request.command === "ps" || request.command === "task ls") && !request.repo)
      return { ...request, repo: own };
    if (!("repo" in request) || !request.repo || fullNameIs(findRepository(db, request.repo), own))
      return request;
    throw new Error(
      `you are the lead of ${own} only, so ${request.repo} isn't yours. Ask the human to open it with skel in a checkout of it: its own lead works on it.`,
    );
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
    const thread = record(db, stopped.folder, { status: statusOnceBack(stopped) }, "started again");
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
  const handle = async (request: DaemonRequest, caller: Caller): Promise<object> => {
    switch (request.command) {
      case "status": {
        const builder = builderOf(caller);
        const thread = builder ? { thread: threadName(db, builder) } : {};
        return { running: true, pid: process.pid, release, ...started, ...thread };
      }
      case "lead": {
        // From outside any repository skel has, the one you opened last.
        const repository =
          repositories(db).find((r) => fullNameIs(r, request.from)) ?? lastOpened(db);
        if (!repository) throw new Error(noRepositories);
        const { owner, repo } = repository;
        db.run("UPDATE repositories SET opened = ? WHERE owner = ? AND repo = ?", [
          Date.now(),
          owner,
          repo,
        ]);
        await lead(repository);
        // A lead that wasn't running kept its notes until now.
        tellLead(db, tmux);
        // Not waited on, so attaching never waits on GitHub.
        refreshClones(db).catch((error) => console.log(String(error)));
        return { lead: leadOf(db, owner, repo).name, repository: `${owner}/${repo}` };
      }
      case "screen opened":
        for (const { owner, repo } of repositories(db)) poll(`${owner}/${repo}`);
        return { polling: true };
      case "page":
        return { page: await readPage(request.url) };
      case "repo ls": {
        const yours = leadOfCaller(caller);
        const all = listRepositories(db);
        const own = yours && `${yours.owner}/${yours.repo}`;
        return { repositories: own ? all.filter((r) => r.github === own) : all };
      }
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
        await stopThread(db, tmux, thread);
        return { stopped: name };
      }
      case "tell": {
        const thread = findThread(db, request.repo, request.task);
        return { told: messageBuilder(db, tmux, thread, request.text) };
      }
      case "tell lead":
        messageLead(db, tmux, callingThread(caller), request.text);
        return { told: "lead" };
      case "submit": {
        const thread = callingThread(caller);
        submitRound(db, tmux, thread.folder, request.summary);
        return { submitted: threadName(db, thread) };
      }
      case "question asked":
        record(db, callingThread(caller).folder, { asking: true }, "its builder asked a question");
        tellLead(db, tmux);
        return { asking: true };
      case "turn ended": {
        const { folder } = callingThread(caller);
        if (!endedTurnAsks(readThread(db, folder))) return { asking: false };
        record(db, folder, { asking: true }, "its builder stopped without submitting");
        tellLead(db, tmux);
        return { asking: true };
      }
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
        const choice = startChoice(before);
        if (before && choice === "bring back") {
          const name = threadName(db, before);
          resume(before);
          return { started: `Started ${name} again: its builder is back where it was.` };
        }
        if (before && choice === "go on") {
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
      const asked = DaemonRequest.safeParse(parseJson(request.slice(0, end)));
      const kind = caller === "you" ? "you" : "lead" in caller ? "lead" : "builder";
      if (!asked.success || !allowed[kind].includes(asked.data.command))
        reply({ error: "the daemon doesn't know that request" });
      else
        Promise.resolve()
          .then(() => handle(within(asked.data, caller), caller))
          .then(reply, (error) => reply({ error: errorText(error) }));
    };
    connection.on("data", read);
    connection.on("error", () => {});
  };
  // The lock decides which of two daemons started together runs. The socket can't: both
  // could find one left by a daemon that was killed, and each remove the other's new one.
  const path = daemonSocket();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!lock(`${path}.lock`))
    throw new Error("the daemon is already running. Run skel to attach to a lead.");
  // Taken before any request comes in, so a thread started meanwhile, still setting up,
  // isn't taken for one whose setup the daemon's stop cut short.
  const before = liveThreads(db);
  await open(path, "you");
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => endWhatItStarted(sockets));
  console.log(`Listening on ${path}.`);
  for (const repository of openedRepositories(db))
    await lead(repository).catch((error) => console.log(errorText(error)));
  // A lead keeps its clone current as it starts, and a repository with no lead needs it too.
  refreshClones(db).catch((error) => console.log(String(error)));
  // Notes the daemon's stop kept from the leads.
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
  keepUpToDate();
  if (!onSprite()) return;
  keepAwake(() => hasWork(liveThreads(db)));
  wakeOnWebhooks(db, port, poll);
}
