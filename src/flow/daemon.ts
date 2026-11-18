// The daemon, run by sc up: keeps each repository's lead and the threads' builders
// running, and answers the CLI and the agents on their sockets.

import { dlopen, FFIType } from "bun:ffi";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  agentRuns,
  interruptSession,
  processTree,
  readSession,
  stillRunning,
} from "../agents/sessions.ts";
import { repositoryCommands } from "../config.ts";
import { moveToTasks, openDb, type Repository } from "../db.ts";
import { setupDone } from "../machine/setup.ts";
import { keepUpToDate } from "../machine/update.ts";
import { cloneDir, daemonCodeFile, daemonSocket, reviewSocket, threadSocket } from "../paths.ts";
import { createTask, mergePr } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { checkoutFolder, git, release, singleFile } from "../version.ts";
import { assignIssue } from "./assign.ts";
import {
  bringBack,
  endEarlierBuilder,
  failThread,
  setUpThread,
  startBuilder,
  startChoice,
  startThread,
  statusOnceBack,
} from "./builder.ts";
import { holdCheckSlot } from "./checks.ts";
import { saveItems } from "./copy.ts";
import { removeThread, stopThread } from "./events.ts";
import { noCommits } from "./git.ts";
import { closeExitedLeads, lastOpened, leadOf, openedRepositories, startLead } from "./lead.ts";
import { restoreLimits, wakeAfterLimit } from "./limits.ts";
import { listRepositories, listTasks, listThreads, showTask } from "./list.ts";
import { armMerge, cancelMerge, refuseWithoutForge, threadToMerge } from "./merging.ts";
import { deliverAllWaiting, messageBuilder, messageLead, typeLeadNotes } from "./messages.ts";
import { pollRepositories } from "./poll.ts";
import {
  findRepository,
  fullNameIs,
  hasNoCommits,
  noRepositories,
  refreshClones,
  repositoryAt,
} from "./repo.ts";
import { allowed, type Caller, DaemonRequest, parseJson } from "./requests.ts";
import { endRound, goOn, rerunReview, resumeRound, submitRound } from "./round.ts";
import { doing, watchForStalls } from "./stall.ts";
import {
  keepState,
  noticeIdleScreens,
  questionAnswered,
  questionAsked,
  questionClosed,
  reportStatuses,
  stateAfter,
  turnEnded,
  turnFailed,
} from "./status.ts";
import {
  builderSession,
  findThread,
  liveThreads,
  record,
  type Thread,
  threadName,
  threadOn,
} from "./thread.ts";

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

// Returns the thread whose builder is calling, or null when you, a lead or a reviewer call.
const builderOf = (caller: Caller): Thread | null =>
  caller === "you" || "lead" in caller || "review" in caller ? null : caller;

// Returns the repository whose lead is calling, as its owner and name, or null when you, a
// builder or a reviewer call.
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
// The agents' sessions aren't the daemon's processes, so agents keep working while the
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

// Opens the daemon's sockets, brings back the lead of each repository you have opened and
// the builders of threads that were running, so commands and agents can reach it. Leaves the
// sockets listening after returning, and removes them when stopped, leaving every agent's
// session running. `sessions` names where the agents' sessions run. It never asks questions:
// systemd has nobody to answer. Polls each repository's tracker and forge every `every`
// milliseconds while a thread is active.
export async function serve(sessions: string, every = 30_000): Promise<void> {
  if (!setupDone()) throw new Error("the first run isn't done on this machine: run sc first");
  // The lock decides which of two daemons started together runs. The socket can't: both
  // could find one left by a daemon that was killed, and each remove the other's new one. It
  // comes before the database, whose threads move onto tasks only while no other daemon, such as
  // one of an earlier release, can still write to them.
  const path = daemonSocket();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!lock(`${path}.lock`))
    throw new Error("the daemon is already running. Run sc to attach to a lead.");
  const db = openDb();
  moveToTasks(db);
  // The checkout and commit this daemon's code came from, for sc status. Read once at start,
  // since a git pull afterwards doesn't change the code that runs.
  const runningCode = singleFile
    ? {}
    : { folder: checkoutFolder, commit: git("rev-parse", "--short", "HEAD") };
  // Written down too, for sc --remote, which checks from plain shell that the daemon runs the
  // code its checkout holds. Shell can't ask the socket.
  if (!singleFile)
    writeFileSync(daemonCodeFile(), `${git("rev-parse", "HEAD")} ${checkoutFolder}\n`);
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
  // Opens a thread's own socket, so the daemon knows which thread calls on it, and its
  // reviewer's, which may only run sc check. A thread that starts over keeps the sockets it has.
  const listenFor = async (thread: Thread) => {
    const socket = threadSocket(thread.folder);
    if (listening.has(socket)) return;
    listening.add(socket);
    await open(socket, thread);
    await open(reviewSocket(thread.folder), { review: thread });
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
        await startLead(db, sessions, repository);
      });
    return leadStarts;
  };
  // Returns the request limited to the calling lead's own repository. A request about another
  // repository is refused, and the error tells the lead to ask you to open that one. sc ps and
  // sc ls with no repository mean every repository, which for a lead is its own, and sc pr show
  // and sc merge --cancel with a PR number mean the lead's own repository, wherever it ran.
  // Your requests and a builder's are returned unchanged.
  const limitToOwnRepository = (request: DaemonRequest, caller: Caller): DaemonRequest => {
    const leadRepository = leadOfCaller(caller);
    if (leadRepository === null) return request;
    // A request for every repository becomes one for the lead's own, and a request naming
    // another repository is refused.
    const own = `${leadRepository.owner}/${leadRepository.repo}`;
    if ((request.command === "ps" || request.command === "task ls") && !request.repo)
      return { ...request, repo: own };
    if ((request.command === "task show" || request.command === "merge cancel") && !request.repo) {
      const { from, ...rest } = request;
      return { ...rest, repo: own };
    }
    if (!("repo" in request) || !request.repo || fullNameIs(findRepository(db, request.repo), own))
      return request;
    throw new Error(
      `you are the lead of ${own} only, so ${request.repo} isn't yours. Ask the human to open it with sc in a checkout of it: its own lead works on it.`,
    );
  };
  // Sets up a new thread's clone, opens its socket and starts its builder, after sc start
  // has had its answer, once any builder a failed start left running has ended. Marks the
  // thread failed, with the reason, when any of it fails.
  const setUpAndStart = async (thread: Thread) => {
    try {
      await endEarlierBuilder(db, sessions, thread);
      await setUpThread(db, thread);
      await listenFor(thread);
      await startBuilder(db, sessions, thread);
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
      await bringBack(db, sessions, thread);
      resumeRound(db, sessions, thread.folder);
    } catch (error) {
      failThread(db, thread, error);
    }
  };
  // Carries out a request the caller may make, and returns the reply to send. The switch has
  // no default, so the typecheck fails if a request is left out.
  const handle = async (request: DaemonRequest, caller: Caller): Promise<object> => {
    // A hook's request first keeps what the agent is doing. A lead's stops there: you see a lead
    // whenever you open its repository, so nothing it does flags needs you.
    const state = stateAfter(request.command);
    if (state !== null) {
      const lead = leadOfCaller(caller);
      keepState(db, lead ?? callingThread(caller), state);
      if (lead) return { state };
    }
    switch (request.command) {
      // sc check holds its connection open while it runs, so answer() hands it to the queue of
      // checks before it gets here.
      case "check":
        throw new Error("sc check can't be answered with one reply");
      case "status": {
        const builder = builderOf(caller);
        const thread = builder ? { thread: threadName(db, builder) } : {};
        return { running: true, pid: process.pid, release, ...runningCode, ...thread };
      }
      case "lead": {
        // A lead you exited this second is closed first, so the daemon's next look can't close
        // the tab again while the lead starts, and a tab can't bring it back. It comes before
        // the choice of repository, so plain sc doesn't pick the one whose tab just closed.
        closeExitedLeads(db, sessions);
        // From outside any repository Skelcrew has, the one you opened last.
        const repository =
          (request.from === undefined ? undefined : repositoryAt(db, request.from)) ??
          lastOpened(db);
        if (!repository) throw new Error(noRepositories);
        const { owner, repo } = repository;
        // A tab never brings back a lead you exited, not even from a screen that still shows
        // its tab. Only opening the repository does: sc in a checkout of it, sc repo add, or sc
        // attach on one of its threads.
        const closed = db
          .query("SELECT 1 FROM repositories WHERE owner = ? AND repo = ? AND tab_closed = 1")
          .get(owner, repo);
        // lastOpened puts open tabs first, so a closed one here means every tab is closed. Plain
        // sc then opens none, and says why in the words of the folder you ran it in.
        if (request.tab && closed && request.from === undefined) return { closed: true };
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
        typeLeadNotes(db, sessions);
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
        return { task: await showTask(db, request) };
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
        rerunReview(db, sessions, thread.folder, builder !== null);
        return { reviewing: threadName(db, thread) };
      }
      case "stop": {
        const thread = findThread(db, request.repo, request.task);
        const name = threadName(db, thread);
        await stopThread(db, sessions, thread);
        return { stopped: name };
      }
      // Both act only on a builder that runs: one that ended leaves its last screen behind,
      // which would read as what it shows now.
      case "peek": {
        const thread = findThread(db, request.repo, request.task);
        const name = threadName(db, thread);
        const { host, id } = builderSession(db, sessions, thread);
        if (!agentRuns(host, id))
          throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}`);
        return { thread: name, screen: readSession(host, id) };
      }
      case "interrupt": {
        const thread = findThread(db, request.repo, request.task);
        const name = threadName(db, thread);
        const { host, id } = builderSession(db, sessions, thread);
        if (!agentRuns(host, id))
          throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}`);
        interruptSession(host, id);
        return { interrupted: name };
      }
      case "rm preview": {
        const thread = findThread(db, request.repo, request.task);
        return { thread: threadName(db, thread), status: thread.status, pr: thread.pr };
      }
      case "rm": {
        const thread = findThread(db, request.repo, request.task);
        const name = threadName(db, thread);
        await removeThread(db, sessions, thread, request.reason, leadOfCaller(caller) !== null);
        // The issue it worked on stays open in the tracker, so sc rm can say so. A thread
        // started on what you told the lead is numbered with a t, such as app-t1, and has none.
        return { removed: name, issue: /^t\d+$/.test(thread.task) ? null : thread.task };
      }
      case "merge": {
        const repository = findRepository(db, request.repo);
        const { owner, repo } = repository;
        const refused = await mergePr(db, repository, { pr: request.pr, commit: request.commit });
        if (refused !== null) throw new Error(refused);
        // The merge ends the PR's thread and takes the PR off the screen's list once a poll
        // sees it. Polled now, so that happens before the screen stops saying it is merging. A
        // poll that fails changes nothing about the merge, which is done.
        await (await polling.promise)(`${owner}/${repo}`).catch((error) =>
          console.log(errorText(error)),
        );
        return { merged: `Merged ${repository.name}#${request.pr}.` };
      }
      // What sc merge --when-ready asks you about at your terminal before it arms.
      case "merge preview": {
        const thread = threadToMerge(db, request);
        refuseWithoutForge(db, thread);
        // Its whole title, not the short one, so you can tell which PR you agree to.
        return {
          thread: threadName(db, thread),
          pr: thread.pr,
          title: thread.title,
          started: thread.started,
        };
      }
      case "merge when ready":
        return { said: armMerge(db, threadToMerge(db, request), request.seen) };
      case "merge cancel":
        return { said: cancelMerge(db, threadToMerge(db, request)) };
      case "tell": {
        const thread = findThread(db, request.repo, request.task);
        return { told: await messageBuilder(db, sessions, caller, thread, request.text) };
      }
      case "tell lead":
        messageLead(db, sessions, caller, request.text);
        return { told: "lead" };
      case "submit": {
        const thread = callingThread(caller);
        submitRound(db, sessions, thread.folder, request.summary);
        return { submitted: threadName(db, thread) };
      }
      case "question asked":
        questionAsked(db, sessions, callingThread(caller).folder);
        return { asking: true };
      case "turn ended":
        return {
          asking: turnEnded(db, sessions, callingThread(caller).folder, request),
        };
      case "turn failed":
        turnFailed(db, sessions, callingThread(caller), request.error, request.message);
        return { erred: true };
      case "question closed":
        questionClosed(db, callingThread(caller).folder);
        return { asking: false };
      case "question answered":
        questionAnswered(db, callingThread(caller).folder);
        return { asking: false };
      // Esc on Codex flags nothing: you are looking at the builder anyway.
      case "turn interrupted":
        return { state };
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
          goOn(db, sessions, before.folder);
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
          if (await hasNoCommits(db, repository)) throw new Error(noCommits(repository));
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
        const repository = findRepository(db, request.repo);
        if (await hasNoCommits(db, repository)) throw new Error(noCommits(repository));
        const thread = await startThread(db, request);
        setUpAndStart(thread);
        return { started: `Started ${threadName(db, thread)}.` };
      }
    }
  };
  // Gives an sc check its place among the checks, with the test commands of the caller's
  // repository: the thread's for a builder or a reviewer, and for you the repository of the
  // checkout you ran it in.
  const checkFor = (
    connection: Socket,
    caller: Caller,
    { from }: { from?: string | undefined },
  ) => {
    try {
      const thread = caller !== "you" && "review" in caller ? caller.review : builderOf(caller);
      const repository = thread ?? (from === undefined ? undefined : repositoryAt(db, from));
      if (!repository) throw new Error("run sc check in a checkout of a repository Skelcrew has");
      holdCheckSlot(connection, repositoryCommands(repository).test);
    } catch (error) {
      connection.end(`${JSON.stringify({ error: errorText(error) })}\n`);
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
      const kind =
        caller === "you"
          ? "you"
          : "lead" in caller
            ? "lead"
            : "review" in caller
              ? "review"
              : "builder";
      if (!asked.success || !allowed[kind].includes(asked.data.command))
        reply({ error: "the daemon doesn't know that request" });
      else if (asked.data.command === "check") checkFor(connection, caller, asked.data);
      else
        Promise.resolve()
          .then(() => handle(limitToOwnRepository(asked.data, caller), caller))
          .then(reply, (error) => reply({ error: errorText(error) }));
    };
    connection.on("data", read);
    connection.on("error", () => {});
  };
  // The usage limits saved before the stop, read back before any review can start: a review
  // brought back below, or one a request starts while the leads come back. Read later, they
  // would overwrite a limit a review met meanwhile and forget when it was met, so a review
  // that started before it could end it by finishing.
  restoreLimits(db);
  // A freeze leaves nothing else in the log, so the daemon logs its own stalls.
  watchForStalls("The daemon");
  // Taken before any request comes in, so a thread started meanwhile, still setting up,
  // isn't taken for one whose setup the daemon's stop cut short.
  const before = liveThreads(db);
  // Reviews the daemon's stop cut short join the queue of reviews first, before any request or
  // builder could start one, and in the order they had: those that were running, then those
  // that waited, by when they joined. A review doesn't need its builder until it types changes
  // in, so those wait until the builder is back, or has failed and ended the round.
  const reviewsCutShort = before.filter((t) => t.submitting === null && t.reviewing !== null);
  reviewsCutShort.sort((a, b) => (a.queued ?? 0) - (b.queued ?? 0));
  const builderBack = new Map<string, () => void>();
  // Their sockets open first, so their reviewers can run sc check.
  for (const thread of reviewsCutShort) await listenFor(thread);
  for (const thread of reviewsCutShort) {
    const back = Promise.withResolvers<void>();
    builderBack.set(thread.folder, back.resolve);
    resumeRound(db, sessions, thread.folder, back.promise);
  }
  // A lead you exited while the daemon was down closes its tab, before any request could open
  // it, and isn't brought back. From here on, the daemon looks each second for a lead you exit.
  closeExitedLeads(db, sessions);
  setInterval(
    () => doing("closing the tabs of exited leads", () => closeExitedLeads(db, sessions)),
    1000,
  );
  // From here on, the daemon also looks every two seconds for a working agent whose screen
  // shows it idle, where no hook said so. A session that ends during a look only ends that look.
  setInterval(() => {
    try {
      doing("looking at the agents' screens", () => noticeIdleScreens(db, sessions));
    } catch (error) {
      console.log(`couldn't look at the agents' screens: ${errorText(error)}`);
    }
  }, 2000);
  // A host that shows status hears each builder's as it is now, and each change from here on.
  reportStatuses(db);
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
  typeLeadNotes(db, sessions);
  // Bring back each thread's builder, without waiting on it, and carry on the round it was in.
  // A thread whose builder can't come back ends its review, which would otherwise mark it
  // waiting again once it ended. Either way a review already brought back hears of it.
  for (const thread of before) {
    await listenFor(thread);
    const settled = builderBack.get(thread.folder) ?? (() => {});
    // After the builder is back, since the round may type into its session.
    // A builder that stopped on a usage limit is woken once it resets, as it would have been.
    bringBack(db, sessions, thread).then(
      () => {
        settled();
        resumeRound(db, sessions, thread.folder);
        if (thread.erred && thread.limited) wakeAfterLimit(db, sessions, thread.folder);
      },
      (error) => {
        endRound(thread.folder);
        settled();
        failThread(db, thread, error);
      },
    );
  }
  // Type the messages waiting for builders as soon as each can take them, looking every two
  // seconds, as a builder becomes idle with no word to the daemon, such as after Esc.
  setInterval(() => deliverAllWaiting(db, sessions), 2000);
  // Start polling, which also lets any sc start waiting on it go ahead, and keep Skelcrew itself
  // up to date.
  polling.resolve(pollRepositories(db, sessions, every, setUpAndStart, startingTasks));
  keepUpToDate();
}
