// The daemon, run by sc serve: keeps each repository's lead and the threads' builders
// running, and answers the CLI and the agents on their sockets.
import { dlopen, FFIType } from "bun:ffi";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { processTree, stillRunning } from "../agents/tmux.ts";
import { openDb, type Repository } from "../db.ts";
import { setupDone } from "../machine/setup.ts";
import { holdAwhile, keepAwake, onSprite, urlPort } from "../machine/sprite.ts";
import { keepUpToDate } from "../machine/update.ts";
import { cloneDir, daemonSocket, threadSocket } from "../paths.ts";
import { createTask, repositoryPlugins } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { checkoutFolder, git, release, singleFile } from "../version.ts";
import { assignIssue } from "./assign.ts";
import {
  bringBack,
  failThread,
  setUpThread,
  startBuilder,
  startChoice,
  startThread,
  statusOnceBack,
} from "./builder.ts";
import { saveItems } from "./copy.ts";
import { removeThread, stopThread } from "./events.ts";
import {
  closeExitedLeads,
  lastOpened,
  leadOf,
  openedRepositories,
  startLead,
  typeLeadNotes,
} from "./lead.ts";
import { listRepositories, listTasks, listThreads, showTask } from "./list.ts";
import { pollRepositories } from "./poll.ts";
import {
  findRepository,
  fullNameIs,
  noRepositories,
  refreshClones,
  repositories,
  repositoryAt,
} from "./repo.ts";
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
import { listenForWakeUps, wakeRepository } from "./wake.ts";

// Tries to hold the daemon lock and returns whether this process owns it, preventing
// duplicate daemons. The kernel lets go of it when the process ends, however it ends, so a
// daemon that was killed never leaves it held. Node has no flock, so it comes from libc.
function lock(path: string): boolean {
  // Load flock from the system's C library, as an exclusive lock that fails at once rather than
  // waiting when another daemon holds it.
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

// Returns the repository whose lead is calling, as its owner and name, or null when you or
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

// Ends the daemon on a signal: removes its sockets, ends the processes it started, and exits.
// The agents' tmux sessions aren't the daemon's processes, so agents keep working while the
// daemon is down. The processes it started, such as a git clone or a reviewer, are ended and
// waited for. The service stops only the daemon, and the next daemon starts that work again.
// A clone left running would write into the folder the next daemon clones into. Each process
// gets SIGTERM first, so git can remove its lock files. The wait blocks the daemon on purpose.
// Otherwise it would save a reviewer it just ended as a failed review, which the next daemon
// would have run again, and a clone refresh would move on to the next clone.
function endWhatItStarted(sockets: string[]): void {
  // Remove the sockets first, so no caller reaches a daemon on its way out.
  for (const socket of sockets) rmSync(socket, { force: true });
  // Ask everything the daemon started to end, give it five seconds, then kill what is left.
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

// Listens on `port` for wake-ups, and asks each repository's tracker and forge to send them.
// A delivery for a plugin wakes a sleeping Sprite, and polls at once every repository that
// uses the plugin. Without the listener, events wait until something else wakes the Sprite,
// and polling still sees them then.
function wakeOnDeliveries(
  db: Database,
  port: number,
  poll: (fullName: string) => Promise<void>,
): void {
  // Handles a delivery for the named plugin. Returns false when no repository uses the plugin,
  // so the delivery is refused. Otherwise polls each repository that uses it.
  const wakePlugin = async (name: string) => {
    const usingIt = repositories(db).filter((r) =>
      repositoryPlugins(db, r).some(({ plugin }) => plugin === name),
    );
    if (usingIt.length === 0) return false;
    // The Sprite sleeps again as soon as the delivery is answered, so it is held for a minute
    // first: long enough for the polls, and for keepAwake to hold it for any work they start.
    await holdAwhile(60).catch((error) =>
      console.log(`couldn't hold the Sprite awake: ${errorText(error)}`),
    );
    // Not waited on, so the plugin hears back at once. A poll that fails is logged, and the
    // next one tries again, but left uncaught it would end the daemon.
    for (const { owner, repo } of usingIt) poll(`${owner}/${repo}`).catch(() => {});
    return true;
  };
  // When the port can't be opened, only the wake-ups are lost, so the daemon goes on without them.
  try {
    listenForWakeUps(port, wakePlugin);
  } catch (error) {
    console.log(`couldn't listen for wake-ups on port ${port}: ${errorText(error)}`);
  }
  // Asked again at each start, so an address the service lost is put right.
  for (const repository of repositories(db))
    wakeRepository(db, repository).catch((error) =>
      console.log(`couldn't ask for wake-ups for ${repository.name}: ${errorText(error)}`),
    );
}

// Opens the daemon's sockets, brings back the lead of each repository you have opened and
// the builders of threads that were running, so commands and agents can reach it. Leaves the
// sockets listening after returning, and removes them when stopped, leaving every tmux
// session running. It never asks questions: systemd has nobody to answer. Polls each
// repository's tracker and forge every `every` milliseconds while a thread is active. On a
// Sprite, keeps the Sprite awake while there is work, and listens on `port` for wake-ups,
// which wake it while it sleeps.
export async function serve(tmux: string, every = 30_000, port = urlPort): Promise<void> {
  if (!setupDone()) throw new Error("the first run isn't done on this machine: run sc first");
  const db = openDb();
  // The checkout and commit this daemon's code came from, for sc status. Read once at start,
  // since a git pull afterwards doesn't change the code that runs.
  const runningCode = singleFile
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
  // The function that polls one repository at once, for sc start. It is set once polling
  // starts, and sc start waits for it until then. So a builder never starts from a task an
  // earlier daemon saved, which may be out of date.
  const polling = Promise.withResolvers<(fullName: string) => Promise<void>>();
  const listening = new Set<string>();
  // The tasks sc start is starting, as owner/repo#number, which no poll starts by its label.
  const startingTasks = new Set<string>();
  // Opens a thread's own socket, so the daemon knows which thread calls on it. A thread that
  // starts over keeps the socket it has.
  const listenFor = async (thread: Thread) => {
    const socket = threadSocket(thread.folder);
    if (listening.has(socket)) return;
    listening.add(socket);
    await open(socket, thread);
  };
  let leadStarts: Promise<void> = Promise.resolve();
  // Opens a repository's lead's own socket, so the daemon knows which lead calls on it, then
  // keeps the lead running or starts it. One at a time, so two requests at once can't start
  // two sessions.
  const ensureLead = (repository: Repository) => {
    leadStarts = leadStarts
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
    return leadStarts;
  };
  // Returns the request limited to the calling lead's own repository. A request about another
  // repository is refused, and the error tells the lead to ask you to open that one. sc ps and
  // sc issue ls with no repository mean every repository, which for a lead is its own. Your
  // requests and a builder's are returned unchanged.
  const limitToOwnRepository = (request: DaemonRequest, caller: Caller): DaemonRequest => {
    const leadRepository = leadOfCaller(caller);
    if (leadRepository === null) return request;
    // A request for every repository becomes one for the lead's own, and a request naming
    // another repository is refused.
    const own = `${leadRepository.owner}/${leadRepository.repo}`;
    if ((request.command === "ps" || request.command === "task ls") && !request.repo)
      return { ...request, repo: own };
    if (!("repo" in request) || !request.repo || fullNameIs(findRepository(db, request.repo), own))
      return request;
    throw new Error(
      `you are the lead of ${own} only, so ${request.repo} isn't yours. Ask the human to open it with sc in a checkout of it: its own lead works on it.`,
    );
  };
  // Sets up a new thread's clone, opens its socket and starts its builder, after sc start
  // has had its answer. Marks the thread failed, with the reason, when any of it fails.
  const setUpAndStart = async (thread: Thread) => {
    try {
      await setUpThread(db, thread);
      await listenFor(thread);
      await startBuilder(db, tmux, thread);
    } catch (error) {
      failThread(db, thread, error);
    }
  };
  // Brings back a stopped thread's builder for sc start, with --resume on its last session
  // in the same clone, then carries on the round its stop cut short, as after a restart.
  // Marks the thread failed, with the reason, when the builder can't start. A short title
  // given with it is saved with it.
  const resume = async (stopped: Thread, short?: string) => {
    const change = { status: statusOnceBack(stopped), ...(short ? { short } : {}) };
    const thread = record(db, stopped.folder, change, "started again");
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
        return { running: true, pid: process.pid, release, ...runningCode, ...thread };
      }
      case "lead": {
        // From outside any repository Skelcrew has, the one you opened last.
        const repository =
          (request.from === undefined ? undefined : repositoryAt(db, request.from)) ??
          lastOpened(db);
        if (!repository) throw new Error(noRepositories);
        const { owner, repo } = repository;
        // A lead you exited this second is closed first, so the daemon's next look can't close
        // the tab again while the lead starts, and a tab can't bring it back.
        closeExitedLeads(db, tmux);
        // A tab never brings back a lead you exited, not even from a screen that still shows
        // its tab. Only opening the repository does: sc in a checkout of it, sc repo add, or sc
        // attach on one of its threads.
        const closed = db
          .query("SELECT 1 FROM repositories WHERE owner = ? AND repo = ? AND tab_closed = 1")
          .get(owner, repo);
        if (request.tab && closed)
          throw new Error(
            `${owner}/${repo}'s tab is closed. Run sc in a checkout of it to open it.`,
          );
        // Opening a repository opens its tab too, if you had closed it by exiting its lead.
        db.run("UPDATE repositories SET opened = ?, tab_closed = 0 WHERE owner = ? AND repo = ?", [
          Date.now(),
          owner,
          repo,
        ]);
        await ensureLead(repository);
        // A lead that wasn't running kept its notes until now.
        typeLeadNotes(db, tmux);
        // Not waited on, so attaching never waits on a remote.
        refreshClones(db).catch((error) => console.log(errorText(error)));
        return { lead: leadOf(db, owner, repo).name, repository: `${owner}/${repo}` };
      }
      case "repo ls": {
        // A lead sees only its own repository in the list.
        const leadRepository = leadOfCaller(caller);
        const all = listRepositories(db);
        const own = leadRepository && `${leadRepository.owner}/${leadRepository.repo}`;
        return { repositories: own ? all.filter((r) => r.repository === own) : all };
      }
      case "ps":
        return { threads: listThreads(db, request.repo) };
      case "task ls":
        return { tasks: listTasks(db, request.repo) };
      case "task show":
        return { task: showTask(db, request.repo, request.task) };
      case "task create": {
        const repository = findRepository(db, request.repo);
        const task = await createTask(db, repository, request.title, request.body);
        saveItems(db, repository.owner, repository.repo, [task], []);
        return { task: `${repository.name}-${task.id}` };
      }
      case "review": {
        // A builder may ask only for its own thread, such as when you ask on its pull request
        // for another review. Its own thread's name is in the refusal, as nothing else tells it.
        const builder = builderOf(caller);
        if (builder && threadOn(db, request.repo, request.task)?.folder !== builder.folder)
          throw new Error(`you may ask for a review of ${threadName(db, builder)} only`);
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
      case "rm preview": {
        const thread = findThread(db, request.repo, request.task);
        return { thread: threadName(db, thread), status: thread.status, pr: thread.pr };
      }
      case "rm": {
        const thread = findThread(db, request.repo, request.task);
        const name = threadName(db, thread);
        await removeThread(db, tmux, thread, request.reason);
        // The issue it worked on stays open in the tracker, so sc rm can say so. A thread
        // started on what you told the lead is numbered with a t, such as app-t1, and has none.
        return { removed: name, issue: /^t\d+$/.test(thread.task) ? null : thread.task };
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
        typeLeadNotes(db, tmux);
        return { asking: true };
      case "turn ended": {
        const { folder } = callingThread(caller);
        if (!endedTurnAsks(readThread(db, folder))) return { asking: false };
        record(db, folder, { asking: true }, "its builder stopped without submitting");
        typeLeadNotes(db, tmux);
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
        // A thread the task already has is brought back or let past its round limit, with no
        // poll, as nothing new is read from the tracker.
        const before = threadOn(db, request.repo, request.task);
        // A short title for a thread already at work, such as one started from GitHub, only
        // names it for the sidebar. Its builder goes on as it was, and nothing else changes.
        if (before && request.short && ["working", "waiting"].includes(before.status)) {
          record(db, before.folder, { short: request.short }, "given a short title");
          return { started: `Gave ${threadName(db, before)} the short title "${request.short}".` };
        }
        const choice = startChoice(before);
        if (before && choice === "bring back") {
          const name = threadName(db, before);
          resume(before, request.short);
          // Its stop took you off its issue, so starting it again puts you back.
          assignIssue(db, before, true);
          return { started: `Started ${name} again: its builder is back where it was.` };
        }
        if (before && choice === "go on") {
          goOn(db, tmux, before.folder);
          return { started: `${threadName(db, before)} goes on past the round limit.` };
        }
        // Refused before the poll, which only a new thread needs, so a slow or failing remote
        // can't hold up the answer. startThread refuses it again, for a thread started meanwhile.
        if (before && before.status !== "failed" && before.status !== "done")
          throw new Error(`${threadName(db, before)} has a thread already`);
        // The task's title and body come from Skelcrew's copy, brought up to date first. Meanwhile
        // no poll starts the task by its label, which would leave out this start's options.
        const repository = findRepository(db, request.repo);
        const { owner, repo } = repository;
        const key = `${owner}/${repo}#${request.task}`;
        startingTasks.add(key);
        let thread: Thread;
        try {
          // Its skelcrew.yaml, which can name its tracker, is in Skelcrew's clone, which the daemon
          // may still be making.
          if (!existsSync(cloneDir(owner, repo))) await refreshClones(db);
          await (await polling.promise)(`${owner}/${repo}`);
          // A poll already past its labels as this began may have started the thread itself. A
          // short title given here still goes on that thread, so it isn't lost.
          const started = threadOn(db, request.repo, request.task);
          if (!before && started) {
            if (request.short)
              record(db, started.folder, { short: request.short }, "given a short title");
            return { started: `Started ${threadName(db, started)}.` };
          }
          thread = await startThread(db, request);
        } finally {
          startingTasks.delete(key);
        }
        // Not waited on: an agent's command must answer quickly, and setup can take minutes.
        // The claim and assignment wait on the tracker, and change only what it shows.
        assignIssue(db, thread, true);
        setUpAndStart(thread);
        return { started: `Started ${threadName(db, thread)}.` };
      }
      case "start new": {
        const thread = await startThread(db, request);
        setUpAndStart(thread);
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
      // Check the request, then refuse it unless this kind of caller may make it.
      const asked = DaemonRequest.safeParse(parseJson(request.slice(0, end)));
      const kind = caller === "you" ? "you" : "lead" in caller ? "lead" : "builder";
      if (!asked.success || !allowed[kind].includes(asked.data.command))
        reply({ error: "the daemon doesn't know that request" });
      else
        Promise.resolve()
          .then(() => handle(limitToOwnRepository(asked.data, caller), caller))
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
    throw new Error("the daemon is already running. Run sc to attach to a lead.");
  // Taken before any request comes in, so a thread started meanwhile, still setting up,
  // isn't taken for one whose setup the daemon's stop cut short.
  const before = liveThreads(db);
  // A lead you exited while the daemon was down closes its tab, before any request could open
  // it, and isn't brought back. From here on, the daemon looks each second for a lead you exit.
  closeExitedLeads(db, tmux);
  setInterval(() => closeExitedLeads(db, tmux), 1000);
  // Open your socket, and end cleanly on the service's stop or on Ctrl-C.
  await open(path, "you");
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => endWhatItStarted(sockets));
  console.log(`Listening on ${path}.`);
  // Bring back the lead of each repository you have opened. One that fails is logged, and the
  // rest still start.
  for (const repository of openedRepositories(db))
    await ensureLead(repository).catch((error) => console.log(errorText(error)));
  // A lead keeps its clone current as it starts, and a repository with no lead needs it too.
  refreshClones(db).catch((error) => console.log(errorText(error)));
  // Notes the daemon's stop kept from the leads.
  typeLeadNotes(db, tmux);
  // Bring back each thread's builder, without waiting on it, and carry on the round it was in.
  for (const thread of before) {
    await listenFor(thread);
    // After the builder is back, since the round may type into its session.
    bringBack(db, tmux, thread).then(
      () => resumeRound(db, tmux, thread.folder),
      (error) => failThread(db, thread, error),
    );
  }
  // Start polling, which also lets any sc start waiting on it go ahead, and keep Skelcrew itself
  // up to date. On a Sprite, also stay awake while there is work, and wake on deliveries.
  const poll = pollRepositories(db, tmux, every, setUpAndStart, startingTasks);
  polling.resolve(poll);
  keepUpToDate();
  if (!onSprite()) return;
  keepAwake(() => hasWork(liveThreads(db)));
  wakeOnDeliveries(db, port, poll);
}
