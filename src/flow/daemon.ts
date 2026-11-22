// The daemon, run by sc serve: keeps each repository's lead and the threads' builders
// running, and answers the CLI and the agents on their sockets.

import { dlopen, FFIType } from "bun:ffi";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import {
  agentRuns,
  endExitedSession,
  exitedCleanly,
  interruptSession,
  processTree,
  readSession,
  stillRunning,
  stopSession,
} from "../agents/sessions.ts";
import { agentsUnanswered } from "../approved-agents.ts";
import { checkFlow, graceMinutes, leadCanMerge, repositoryCommands } from "../config.ts";
import { finishUpgrade, moveToTasks, moveTurnEnded, openDb, type Repository } from "../db.ts";
import { flowRoles } from "../flows.ts";
import { errorText } from "../format.ts";
import { setupDone } from "../machine/setup.ts";
import { keepUpToDate } from "../machine/update.ts";
import { cloneDir, daemonCodeFile, daemonSocket, reviewSocket, threadSocket } from "../paths.ts";
import { closeTask, createTask, mergePr, trackerOf } from "../plugins/ask.ts";
import { checkoutFolder, git, release, singleFile } from "../version.ts";
import { assignIssue } from "./assign.ts";
import { filedTask, fileTask, unfileTask } from "./backlog.ts";
import {
  bringBack,
  endEarlierBuilder,
  failThread,
  refuseSecondBuilder,
  restartBuilder,
  setUpThread,
  startBuilder,
  startChoice,
  startThread,
  statusOnceBack,
} from "./builder.ts";
import { holdCheckSlot, slotHolders } from "./checks.ts";
import { issueRef, openTasks, prOf, saveItems } from "./copy.ts";
import { readyWhen } from "./decide.ts";
import { beingRemoved, removalEnded, removeThread, stopThread } from "./events.ts";
import { noCommits } from "./git.ts";
import {
  closeExitedLeads,
  closeTabAndEndLead,
  lastOpened,
  leadAgent,
  leadOf,
  leadPrompted,
  leadSession,
  openedRepositories,
  reopenTabsOfRunningLeads,
  startLead,
} from "./lead.ts";
import { roundOf } from "./ledger.ts";
import { restoreLimits, wakeAfterLimit } from "./limits.ts";
import { listRepositories, listTasks, listThreads, showTask } from "./list.ts";
import {
  agentsSaid,
  alreadyMerging,
  armMerge,
  cancelMerge,
  loginName,
  refuseWithoutForge,
  threadToMerge,
} from "./merging.ts";
import {
  briefLead,
  deliverAllWaiting,
  leadTurnEnded,
  leadTurnStarted,
  messageBuilder,
  messageLead,
  noteForLead,
  typeLeadNotes,
} from "./messages.ts";
import { pollRepositories } from "./poll.ts";
import {
  findRepository,
  forgeKnown,
  fullNameIs,
  hasNoCommits,
  noRepositories,
  refreshClone,
  refreshClones,
  repositories,
  repositoryAt,
  repositoryNamed,
} from "./repo.ts";
import { allowed, type Caller, DaemonRequest, parseJson } from "./requests.ts";
import { killReviewers } from "./reviewer.ts";
import {
  endRound,
  goOn,
  rerunReview,
  resumeRound,
  saveApprovedCommits,
  submitRound,
} from "./round.ts";
import { doing, watchForStalls } from "./stall.ts";
import {
  keepState,
  markForgotten,
  markNeedsYou,
  needsYou,
  noticeIdleScreens,
  questionAnswered,
  questionAsked,
  questionClosed,
  reportStatuses,
  stateAfter,
  stillAsks,
  turnEnded,
  turnFailed,
} from "./status.ts";
import {
  backToQueue,
  claimOwed,
  claimQueued,
  joinsQueue,
  joinTime,
  leaveQueue,
  moveInQueue,
  queuedText,
} from "./task-queue.ts";
import {
  builderSession,
  findThread,
  liveThreads,
  readThread,
  record,
  renameBuilders,
  resolveTask,
  type Thread,
  taskName,
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

// Returns what sc rm would remove of a task: its name, its task in the backlog if it never
// started, its thread if it has one, its issue while it may be open, and the issue sc rm closes,
// which is that one unless `keepIssue`, each by the tracker's ID. `shown` is the open issue as
// the tracker writes it, such as #12. An issue no task has yet, such as app#12, has only its
// issue. Throws when there is nothing to remove.
function removalOf(db: Database, repository: string, task: string, keepIssue: boolean) {
  const { owner, repo, name: repositoryName } = findRepository(db, repository);
  const name = taskName(repositoryName, task);
  const filed = filedOn(db, repository, task);
  const thread = threadOn(db, repository, task);
  const id = task.startsWith("#") ? task.slice(1) : (thread?.issue ?? null);
  // A task with a thread always closes its issue, unless its work merged, which closed it. The
  // copy is only as fresh as the last poll, and an issue reopened since would otherwise stay
  // open while sc rm says it closed. So does a retry after the tracker failed, once the work is
  // removed and its thread done. Closing an issue already closed changes nothing. A task with no
  // thread has only the copy to tell whether its issue is open.
  const inCopy = openTasks(db, owner, repo).find((item) => item.id === id);
  const worked = thread !== null && !thread.merged;
  const open = id !== null && (worked || inCopy) ? id : null;
  const issue = keepIssue ? null : open;
  if (!filed && !thread && open === null) throw new Error(`there is no task ${name}`);
  if (!filed && !thread && issue === null)
    throw new Error(
      `${name} never started, and --keep-issue keeps its issue open, so there is nothing to remove`,
    );
  const shown = open === null ? null : issueRef(inCopy ?? { id: open });
  return { name, filed, thread, open, issue, shown };
}

// Returns the thread whose builder is calling, or null when you, a lead or a reviewer call.
const builderOf = (caller: Caller): Thread | null =>
  caller === "you" || "lead" in caller || "review" in caller ? null : caller;

// Returns the repository whose lead is calling, as its owner and name, or null when you, a
// builder or a reviewer call.
const leadOfCaller = (caller: Caller) =>
  caller !== "you" && "lead" in caller ? caller.lead : null;

// Returns a task of the repository's backlog, with its name, such as APP-104, or null when the
// backlog has no task of that ID or a thread works on it, for sc rm.
function filedOn(db: Database, repository: string, task: string) {
  const { owner, repo, name } = findRepository(db, repository);
  const filed = threadOn(db, repository, task) ? null : filedTask(db, owner, repo, task);
  return filed && { ...filed, name: taskName(name, filed.task) };
}

// Returns the thread whose builder is calling, for the requests only a builder may make.
// `allowed` already refuses them from anyone else, so the throw never runs: it is what tells
// the typecheck the caller is a thread.
function callingThread(caller: Caller): Thread {
  const thread = builderOf(caller);
  if (thread === null) throw new Error("only a builder can ask that, from its thread");
  return thread;
}

// How long the processes the daemon started get to end once it stops, in milliseconds, before
// they are killed. Tests set SKELCREW_STOP_WAIT_MS shorter, so a process that ignores the stop
// doesn't cost them five seconds.
const stopWait = z.coerce
  .number()
  .min(0)
  .catch(5000)
  .parse(process.env.SKELCREW_STOP_WAIT_MS ?? 5000);

// How long to wait before trying again to start a lead a brief waits for, in milliseconds. Tests
// set SKELCREW_LEAD_RETRY_MS shorter, so they don't each wait a minute.
const leadRetry = z.coerce
  .number()
  .min(0)
  .catch(60_000)
  .parse(process.env.SKELCREW_LEAD_RETRY_MS ?? 60_000);

// How often the daemon looks for a lead you exited, to close its tab, in milliseconds. Tests of
// a brief to a lead just exited set SKELCREW_EXIT_LOOK_MS longer, so the look can't close the
// tab before the test has seen the exit and sent its brief.
const exitLook = z.coerce
  .number()
  .min(0)
  .catch(1000)
  .parse(process.env.SKELCREW_EXIT_LOOK_MS ?? 1000);

// How often, in milliseconds, the daemon looks for work that waits: the queue of limits.threads,
// the messages waiting for builders, and stopped builders for the safety net. Tests set
// SKELCREW_LOOK_MS shorter, so seeing that something doesn't happen takes a fraction of a
// second rather than several. The looks at agents' screens keep their two seconds, as telling
// a live status line from a still one depends on it.
const look = z.coerce
  .number()
  .min(0)
  .catch(2000)
  .parse(process.env.SKELCREW_LOOK_MS ?? 2000);

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
  // Ask everything the daemon started to end, give it a while, then kill what is left.
  const started = processTree(process.pid).slice(1);
  const end = (pids: number[], signal: NodeJS.Signals) => {
    for (const pid of pids)
      try {
        process.kill(pid, signal);
      } catch {}
  };
  end(started, "SIGTERM");
  const deadline = Date.now() + stopWait;
  while (stillRunning(started).length > 0 && Date.now() < deadline) Bun.sleepSync(50);
  end(stillRunning(started), "SIGKILL");
  // A reviewer's sandbox can leave a process that is no longer under the daemon, so the look
  // above misses it, and that would wait forever.
  killReviewers();
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
  // comes before the database, whose threads move onto tasks, and their turns that ended onto
  // turn_ended, only while no other daemon, such as one of an earlier release, can still write
  // to them.
  const path = daemonSocket();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!lock(`${path}.lock`))
    throw new Error("the daemon is already running. Run sc to attach to a lead.");
  const db = openDb();
  moveToTasks(db);
  moveTurnEnded(db);
  finishUpgrade(db);
  saveApprovedCommits(db);
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
  // End cleanly on the service's stop or on Ctrl-C, from here on. That comes before any review
  // is brought back, as a stop without it would leave the review running.
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => endWhatItStarted(sockets));
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
  // Returns how a repository's supervisor reaches its lead. Starting it opens the lead's own
  // socket first, so the daemon knows which lead calls on it, then keeps the lead running or
  // starts it. The supervisor starts one at a time for each repository, so two requests at once
  // can't start two sessions, while a host that hangs holds up no other repository's lead.
  const leadHost = (repository: Repository) => {
    const { owner, repo } = repository;
    const session = () => leadSession(db, sessions, owner, repo);
    return {
      start: async () => {
        const { socket } = leadOf(db, owner, repo);
        if (!listening.has(socket)) {
          listening.add(socket);
          await open(socket, { lead: { owner, repo } });
        }
        await startLead(db, sessions, repository);
      },
      runs: async () => {
        const lead = await session();
        return lead !== null && (await agentRuns(lead.host, lead.id));
      },
      clear: async () => {
        const lead = await session();
        if (lead !== null) await stopSession(lead.host, lead.id);
      },
    };
  };
  const ensureLead = (repository: Repository) =>
    leadAgent(repository.owner, repository.repo).start(leadHost(repository));
  // Starts a repository's lead, then types its notes in, such as a brief another lead sent it.
  // A lead that can't start, such as one whose clone is missing for now, would leave its notes
  // waiting with nobody told. So `from`, the lead that sent a brief, if one did, hears why, once,
  // and the start is tried again every minute while a note still waits for that lead and its tab
  // stays open, here and after the daemon starts again. A tab you close by exiting the lead ends
  // the tries, as that lead's notes then wait until you open it. Returns once the first try is
  // over, whichever way it went.
  const bringBackLead = (
    to: Repository,
    from: { owner: string; repo: string } | null,
  ): Promise<void> =>
    ensureLead(to)
      .then(() => typeLeadNotes(db, sessions))
      .catch((error) => {
        console.log(`couldn't start ${to.name}'s lead: ${errorText(error)}`);
        if (from)
          noteForLead(
            db,
            sessions,
            from,
            `${to.name}'s lead couldn't start to take your brief: ${errorText(error)}. Skelcrew tries again every minute while it waits.`,
          );
        // Asked again when the time comes, as meanwhile the lead may have started and you may
        // have exited it, closing its tab, or its notes may have gone in.
        const waits = () =>
          db
            .query(`SELECT 1 FROM notes JOIN repositories USING (owner, repo)
              WHERE owner = ? AND repo = ? AND tab_closed = 0 LIMIT 1`)
            .get(to.owner, to.repo) !== null;
        if (waits())
          setTimeout(() => {
            if (waits()) void bringBackLead(to, null);
          }, leadRetry);
      });
  // Returns the request limited to the calling lead's own repository. A request about another
  // repository is refused, and the error tells the lead to ask you to open that one. sc ps and
  // sc ls with no repository mean every repository, which for a lead is its own, and sc merge
  // with a PR number means the lead's own repository, wherever it ran.
  // Your requests and a builder's are returned unchanged.
  const limitToOwnRepository = (request: DaemonRequest, caller: Caller): DaemonRequest => {
    const leadRepository = leadOfCaller(caller);
    if (leadRepository === null) return request;
    // A request for every repository becomes one for the lead's own, and a request naming
    // another repository is refused.
    const own = `${leadRepository.owner}/${leadRepository.repo}`;
    if ((request.command === "ps" || request.command === "task ls") && !request.repo)
      return { ...request, repo: own };
    const byNumber =
      request.command === "merge when ready" ||
      request.command === "merge skip review" ||
      request.command === "merge cancel";
    if (byNumber && !request.repo) {
      const { from, ...rest } = request;
      return { ...rest, repo: own };
    }
    if (!("repo" in request) || !request.repo || fullNameIs(findRepository(db, request.repo), own))
      return request;
    throw new Error(
      `you are the lead of ${own} only, so ${request.repo} isn't yours. Ask the human to open it with sc in a checkout of it: its own lead works on it.`,
    );
  };
  // Returns the request with the task it names as Skelcrew stores it, such as t158 for APP-158
  // or for its old name APP-T158, or #12 for an issue no task has yet, as resolveTask says.
  const resolveName = (request: DaemonRequest): DaemonRequest =>
    "task" in request && request.task !== undefined && "repo" in request && request.repo
      ? { ...request, task: resolveTask(db, request.repo, request.task) }
      : request;
  const setUpAndStart = async (thread: Thread) => {
    try {
      await endEarlierBuilder(db, sessions, thread);
      await setUpThread(db, thread);
      await listenFor(thread);
      await startBuilder(db, sessions, thread);
    } catch (error) {
      failThread(db, sessions, thread, error);
    }
  };
  // Switches a thread at work, or a stopped one about to come back, to another flow, and gives it a short title too when one comes
  // with it. A task started from a label runs the default flow, and the lead can switch it to
  // one that fits better, but only until its builder first submits: after that, the review and
  // its round limit are under way, so the task keeps its flow to the end. Read again here, as
  // the builder may have submitted since the caller looked. The builder is already running, or
  // starting, on its flow's build role, with that role's instructions, harness and model, so a
  // flow that builds with another role is refused: it would run a builder it doesn't describe.
  // The round limit it would run with is read too, so a bad one refuses the switch.
  const switchFlow = (at: Thread, flow: string, short?: string) => {
    const now = readThread(db, at.folder);
    const name = threadName(db, now);
    // Any sign of a submit counts: a review under way sets `reviewing` and clears `submitting`
    // before it sets `review_at`, and a repository with no forge has no PR.
    const submitted = [
      now.pr,
      roundOf(now).submitting,
      roundOf(now).reviewing,
      roundOf(now).review_at,
      roundOf(now).review_round,
    ];
    if (submitted.some((sign) => sign !== null) || roundOf(now).rounds > 0)
      throw new Error(`${name} keeps the flow ${now.flow}, as its builder has submitted already.`);
    const repository = findRepository(db, `${now.owner}/${now.repo}`);
    checkFlow(now, repository.name, flow);
    const building = flowRoles(now).build;
    const wanted = flowRoles({ ...now, flow }).build;
    if (wanted !== building)
      throw new Error(
        `${name} keeps the flow ${now.flow}: its builder already runs as ${building}, and ${flow} builds as ${wanted}. To run ${flow}, start it over: sc rm ${name} --keep-issue, then sc start ${name} --flow ${flow}.`,
      );
    record(db, now.folder, { flow, ...(short ? { short } : {}) }, `given the flow ${flow}`);
  };
  const resume = async (stopped: Thread, short?: string) => {
    const change = { status: statusOnceBack(stopped), ...(short ? { short } : {}) };
    await comeBack(record(db, stopped.folder, change, "started again"));
  };
  const comeBack = async (thread: Thread) => {
    try {
      await listenFor(thread);
      if ((await bringBack(db, sessions, thread)) !== "not wanted")
        resumeRound(db, sessions, thread.folder);
    } catch (error) {
      failThread(db, sessions, thread, error);
    }
  };
  const startTask = async (
    request: Extract<DaemonRequest, { command: "start" }>,
  ): Promise<{ started: string }> => {
    const done = (said: string, change: () => void = () => {}) => {
      db.transaction(change)();
      return { started: said };
    };
    const before = threadOn(db, request.repo, request.task);
    const atWork = before !== null && ["working", "waiting", "queued"].includes(before.status);
    const switching = before !== null && request.flow !== undefined && request.flow !== before.flow;
    const startNowFromQueue = (queued: Thread) => {
      const name = threadName(db, queued);
      if (beingRemoved(queued.folder)) throw new Error(`${name} is being removed`);
      const { owner, repo, issue } = queued;
      const where = "WHERE owner = ? AND repo = ? AND task = ?";
      const owed = db.query(`SELECT 1 FROM claims ${where}`).get(owner, repo, issue) !== null;
      const status = queued.session === null ? "working" : statusOnceBack(queued);
      const short = request.short ? { short: request.short } : {};
      let started = queued;
      const answer = done(`Started ${name} now, out of the queue, over limits.threads.`, () => {
        db.run(`DELETE FROM claims ${where}`, [owner, repo, issue]);
        const change = { status, queued_since: null, ...short };
        started = record(db, queued.folder, change, "started now, over limits.threads");
        if (started.session === null) setUpAndStart(started);
        else comeBack(started);
      });
      assignIssue(db, started, owed);
      return answer;
    };
    if (before?.status === "queued" && request.now) {
      if (switching && request.flow) switchFlow(before, request.flow);
      return startNowFromQueue(readThread(db, before.folder));
    }
    if (before && atWork && switching && request.flow) {
      const flow = request.flow;
      return done(`${threadName(db, before)} now runs the flow ${flow}.`, () =>
        switchFlow(before, flow, request.short),
      );
    }
    if (before && request.short && atWork) {
      const short = request.short;
      return done(`Gave ${threadName(db, before)} the short title "${short}".`, () =>
        record(db, before.folder, { short }, "given a short title"),
      );
    }
    if (before?.status === "stopped" && switching && request.flow) switchFlow(before, request.flow);
    const choice = startChoice(before);
    if (before && choice === "bring back") {
      const name = threadName(db, before);
      await refuseSecondBuilder(db, sessions, before);
      const now = readThread(db, before.folder);
      if (now.status !== before.status || now.started !== before.started)
        throw new Error(`${name} changed while Skelcrew asked its host: run sc start again`);
      if (!request.now && joinsQueue(db, before)) {
        const change = { status: "queued" as const, queued_since: joinTime(db) };
        const short = request.short ? { short: request.short } : {};
        const queued = record(db, before.folder, { ...change, ...short }, "queued");
        assignIssue(db, before, true);
        return { started: queuedText(db, queued) };
      }
      const on = switching ? ` on the flow ${request.flow}` : "";
      const answer = done(`Started ${name} again${on}: its builder is back where it was.`, () => {
        void resume(before, request.short);
      });
      assignIssue(db, before, true);
      return answer;
    }
    if (before && choice === "go on")
      return done(`${threadName(db, before)} goes on past the round limit.`, () =>
        goOn(db, sessions, before.folder),
      );
    if (before?.status === "queued") return { started: queuedText(db, before) };
    if (before && before.status !== "failed" && before.status !== "done")
      throw new Error(`${threadName(db, before)} has a thread already`);
    const repository = findRepository(db, request.repo);
    const { owner, repo } = repository;
    const issue = request.task.startsWith("#") ? request.task.slice(1) : before?.issue;
    const key = `${owner}/${repo}#${issue ?? request.task}`;
    startingTasks.add(key);
    let thread: Thread;
    try {
      if (!existsSync(cloneDir(owner, repo))) await refreshClones(db);
      await (await polling.promise)(`${owner}/${repo}`);
      const started = threadOn(db, request.repo, request.task);
      if (!before && started?.status === "queued" && request.now) {
        if (request.flow && request.flow !== started.flow) switchFlow(started, request.flow);
        return startNowFromQueue(readThread(db, started.folder));
      }
      if (!before && started)
        return done(`Started ${threadName(db, started)}.`, () => {
          if (request.flow && request.flow !== started.flow)
            switchFlow(started, request.flow, request.short);
          else if (request.short)
            record(db, started.folder, { short: request.short }, "given a short title");
        });
      if (await hasNoCommits(db, repository)) throw new Error(noCommits(repository));
      thread = await startThread(db, request);
    } finally {
      startingTasks.delete(key);
    }
    if (thread.status === "queued") {
      const owed = await claimQueued(db, sessions, thread, false).then(
        () => "",
        (error) =>
          ` Skelcrew couldn't claim its issue yet, and tries again before it starts: ${errorText(error)}`,
      );
      await removalEnded(thread.folder);
      const now = readThread(db, thread.folder);
      if (now.status === "queued" && now.started === thread.started) assignIssue(db, thread, false);
      return { started: `${queuedText(db, thread)}${owed}` };
    }
    assignIssue(db, thread, true);
    setUpAndStart(thread);
    return { started: `Started ${threadName(db, thread)}.` };
  };
  // Carries out a request the caller may make, and returns the reply to send. The switch has
  // no default, so the typecheck fails if a request is left out.
  const handle = async (request: DaemonRequest, caller: Caller): Promise<object> => {
    // A hook's request first keeps what the agent is doing. A lead's stops there: you see a lead
    // whenever you open its repository, so nothing it does flags needs you. Its turns starting
    // and ending only open and close its reading window.
    const state = stateAfter(request.command);
    if (state !== null) {
      const lead = leadOfCaller(caller);
      keepState(db, lead ?? callingThread(caller), state);
      if (lead) {
        if (request.command === "question answered") {
          leadPrompted(db, lead.owner, lead.repo);
          leadTurnStarted(db, sessions, lead, request.prompt);
        }
        if (request.command === "turn ended" || request.command === "turn interrupted")
          leadTurnEnded(db, sessions, lead);
        return { state };
      }
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
        await closeExitedLeads(db, sessions);
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
        // Plain sc picks no repository itself, so the daemon hands back one whose .agents/ you
        // never answered for, and sc asks you before its lead starts. Started first, the lead
        // would run on the built-in roles even after a yes. Only you can approve, in your
        // terminal. With `from`, sc already asked as it brought the repository in.
        if (
          request.from === undefined &&
          request.asked !== `${owner}/${repo}` &&
          agentsUnanswered(repository)
        )
          return { agents: { owner, repo, name: repository.name } };
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
      // Done here, not by sc repo itself, so a host that fails says so in the daemon's log, never
      // in your terminal about a thread you didn't ask about. It answers at once, as a slow host
      // could take a minute over its builders, which sc repo has no reason to wait for.
      case "rename builders":
        renameBuilders(db);
        return {};
      case "end lead":
        return {
          ended: await closeTabAndEndLead(
            db,
            sessions,
            findRepository(db, request.repo),
            request.verb,
          ),
        };
      // Says only yes or no, so a lead learns no other repository's name from it.
      case "repo named":
        return { named: repositoryNamed(db, request.word) !== undefined };
      case "ps":
        return { threads: listThreads(db, request.repo), slots: slotsShown(request.repo) };
      case "task ls":
        return { tasks: listTasks(db, request.repo) };
      case "task show":
        return { task: await showTask(db, request) };
      case "task create": {
        const repository = findRepository(db, request.repo);
        if (trackerOf(db, repository) === null)
          throw new Error(
            `${repository.name} has no tracker, so --issue can't open an issue there. Without --issue, sc add files the task in Skelcrew's backlog`,
          );
        if (leadOfCaller(caller) !== null) {
          if (request.asked === undefined)
            throw new Error(
              "a lead creates an issue only when the human explicitly asks for one: write their words to a file with your file-writing tool and add --asked-file <file>. To park work for later, leave out --issue, and sc add files it in the backlog.",
            );
          console.log(
            `${repository.name}'s lead creates an issue, as the human asked: ${JSON.stringify(request.asked)}`,
          );
        }
        const task = await createTask(db, repository, request.title, request.body);
        saveItems(db, repository.owner, repository.repo, [task], []);
        return { task: taskName(repository.name, `#${task.id}`) };
      }
      case "task add": {
        const repository = findRepository(db, request.repo);
        const clone = cloneDir(repository.owner, repository.repo);
        if (!existsSync(clone) || !forgeKnown(db, repository)) await refreshClones(db);
        const by = leadOfCaller(caller) === null ? loginName() : `${loginName()} via the lead`;
        const { title, body } = request;
        const current = findRepository(db, request.repo);
        const { task, already } = await fileTask(db, current, clone, { title, body, by }).catch(
          (error) => {
            throw new Error(
              `${errorText(error)}. The remote may have taken the task: run the same sc add again once it can be reached, which never files it twice.`,
            );
          },
        );
        await refreshClone(db, current).catch((error) => console.log(errorText(error)));
        return { task: taskName(repository.name, task), already };
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
      // A restart ends the agent's session and starts it again, resuming its conversation, as
      // opening a closed lead or sc stop then sc start does. The tab and the task stay as they
      // were. Only an agent that runs is restarted: one that ended has its own way back.
      case "restart": {
        if (request.task === undefined) {
          const repository = findRepository(db, request.repo);
          const { owner, repo } = repository;
          const lead = await leadSession(db, sessions, owner, repo);
          if (lead === null || !(await agentRuns(lead.host, lead.id)))
            throw new Error(`${repository.name}'s lead isn't running`);
          const tabOpen = () =>
            db
              .query("SELECT 1 FROM repositories WHERE owner = ? AND repo = ? AND tab_closed = 0")
              .get(owner, repo) !== null;
          const restarted = await leadAgent(owner, repo).restart(leadHost(repository), tabOpen);
          if (restarted === "refused" || restarted === "stays ended")
            return { said: `${repository.name} was closed meanwhile, so its lead stays ended.` };
          if ("failed" in restarted) throw restarted.failed;
          typeLeadNotes(db, sessions);
          return { said: `Restarted ${repository.name}'s lead.` };
        }
        const thread = findThread(db, request.repo, request.task);
        const name = threadName(db, thread);
        const { host, id } = await builderSession(db, sessions, thread);
        const live = thread.status === "working" || thread.status === "waiting";
        if (!live || !(await agentRuns(host, id)))
          throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}`);
        const restarted = await restartBuilder(db, sessions, thread);
        if (restarted === "refused")
          throw new Error(`${name} is being stopped, so it isn't restarted`);
        if (restarted === "stays ended")
          return { said: `${name} was stopped or removed meanwhile, so its builder stays ended.` };
        if ("failed" in restarted) {
          failThread(db, sessions, thread, restarted.failed);
          return { said: `${name}'s builder couldn't start again: ${errorText(restarted.failed)}` };
        }
        const said =
          restarted.gone === null
            ? `Restarted ${name}'s builder.`
            : `Skelcrew can't tell whether its builder runs, as ${restarted.gone}.`;
        return { said };
      }
      case "queue move":
        return { said: moveInQueue(db, findThread(db, request.repo, request.task), request.by) };
      // Both act only on a builder that runs: one that ended leaves its last screen behind,
      // which would read as what it shows now.
      case "peek": {
        const thread = findThread(db, request.repo, request.task);
        const name = threadName(db, thread);
        const { host, id } = await builderSession(db, sessions, thread);
        if (!(await agentRuns(host, id)))
          throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}`);
        return { thread: name, screen: await readSession(host, id) };
      }
      case "interrupt": {
        const thread = findThread(db, request.repo, request.task);
        const name = threadName(db, thread);
        const { host, id } = await builderSession(db, sessions, thread);
        if (!(await agentRuns(host, id)))
          throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}`);
        await interruptSession(host, id);
        return { interrupted: name };
      }
      // What sc rm asks you about at your terminal before it removes anything.
      case "rm preview": {
        const { name, thread, issue, shown } = removalOf(
          db,
          request.repo,
          request.task,
          request.keepIssue,
        );
        const status = thread?.status ?? "not started";
        return { thread: name, status, pr: thread?.pr ?? null, issue: issue && shown };
      }
      // A task in the backlog never started, so removing it deletes only the task itself. On a
      // task with an open issue, the work ends first, then the issue closes. An issue that fails
      // to close leaves the work removed, and sc rm run again closes it.
      case "rm": {
        const { name, filed, thread, issue, shown } = removalOf(
          db,
          request.repo,
          request.task,
          request.keepIssue,
        );
        const repository = findRepository(db, request.repo);
        if (filed) {
          await unfileTask(db, repository, cloneDir(repository.owner, repository.repo), filed.task);
          return { removed: name, issue: null, unfiled: true, closed: false };
        }
        // Closing an issue goes out to other people, so a lead does it only when the human
        // explicitly asks, and gives their words, which the log keeps exactly. Refused before
        // anything is removed.
        const lead = leadOfCaller(caller) !== null;
        if (issue !== null && lead) {
          if (request.asked === undefined)
            throw new Error(
              `a lead closes an issue only when the human explicitly asks for it: write their words to a file with your file-writing tool and add --asked-file <file>. To end the work and keep the issue open, add --keep-issue: sc rm ${name} --keep-issue`,
            );
          console.log(
            `${repository.name}'s lead closes ${name}'s issue, as the human asked: ${JSON.stringify(request.asked)}`,
          );
        }
        // A thread that is done has no work left to end, so only its issue closes.
        if (thread && (thread.status !== "done" || issue === null))
          await removeThread(db, sessions, thread, request.reason, lead);
        if (issue !== null) {
          const comment = request.reason ? `Closed by Skelcrew: ${request.reason}` : null;
          await closeTask(db, repository, { task: issue, comment }).catch((error) => {
            const which = thread ? `${name}'s work is removed, but its issue` : `${name}'s issue`;
            throw new Error(
              `${which} didn't close: ${errorText(error)}. Run sc rm ${name} again to close it`,
            );
          });
          // Polled now, so the task shows closed at once. A poll that fails changes nothing
          // about the issue, which is closed.
          await (await polling.promise)(`${repository.owner}/${repository.repo}`).catch((error) =>
            console.log(errorText(error)),
          );
        }
        return { removed: name, issue: shown, unfiled: false, closed: issue !== null };
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
      // What sc merge asks you about at your terminal before it arms, and whether a merge is
      // armed already, so you aren't asked again. A merge without approval also shows the head
      // it would pin, as Skelcrew's copy of the PR has it, and what the review still asks.
      case "merge preview": {
        const thread = threadToMerge(db, request);
        refuseWithoutForge(db, thread);
        // Its whole title, not the short one, so you can tell which PR you agree to. What it
        // says of .agents/ is about the PR's head as Skelcrew's copy has it, the commit you see,
        // which a merge without approval pins.
        const pr = thread.pr === null ? null : prOf(db, thread.owner, thread.repo, thread.pr);
        return {
          agents:
            thread.pr === null
              ? ""
              : agentsSaid(db, thread.owner, thread.repo, pr, pr?.head ?? null),
          thread: threadName(db, thread),
          pr: thread.pr,
          title: thread.title,
          started: thread.started,
          merging: thread.merge_plan === null ? null : alreadyMerging(db, thread),
          head: pr?.head ?? null,
          asks: stillAsks(thread),
          ready: readyWhen(thread),
        };
      }
      // You arm one at your terminal, after saying y. A lead arms one only while your config
      // lets it, as it does unless you turn it off, and only with the words you asked it in,
      // which it gives in a file.
      case "merge when ready":
      case "merge skip review": {
        const thread = threadToMerge(db, request);
        const skip = request.command === "merge skip review";
        if (leadOfCaller(caller) === null) {
          if (request.asked !== undefined)
            throw new Error("--asked-file is the lead's: at your terminal, sc merge asks you y/N");
          return { said: armMerge(db, sessions, thread, { seen: request.seen }, skip) };
        }
        if (!leadCanMerge())
          throw new Error(
            skip
              ? "the human turned off your arming merges: ask them to run sc merge --skip-review in their own terminal, or to turn it on with lead: { can_merge: true } in ~/.config/skelcrew/config.yaml"
              : "the human turned off your arming merges: ask them to run sc merge --when-ready in their own terminal, or to turn it on with lead: { can_merge: true } in ~/.config/skelcrew/config.yaml",
          );
        if (!request.asked?.trim())
          throw new Error(
            "give what the human asked with --asked-file, a file holding their exact words",
          );
        return { said: armMerge(db, sessions, thread, { asked: request.asked }, skip) };
      }
      case "merge cancel":
        return { said: cancelMerge(db, threadToMerge(db, request)) };
      case "tell": {
        const thread = findThread(db, request.repo, request.task);
        return { told: await messageBuilder(db, sessions, caller, thread, request.text) };
      }
      // A lead's request names its own repository only, as limitToOwnRepository checked.
      case "needs you": {
        const thread = findThread(db, request.repo, request.task);
        const by = leadOfCaller(caller) === null ? "you" : "lead";
        const now = markNeedsYou(db, sessions, thread, request.reason, by);
        return { thread: threadName(db, now), needsYou: needsYou(now) };
      }
      case "tell lead":
        messageLead(db, sessions, caller, request.text);
        return { told: "lead" };
      case "brief lead": {
        // Only you bring a repository in, in your own terminal, so the lead is told how to ask.
        const to = repositories(db).find((r) => r.name === request.to || fullNameIs(r, request.to));
        if (!to)
          throw new Error(
            `${request.to} isn't in Skelcrew. Ask the human to add it in their own terminal, with sc repo add <owner/repo>.`,
          );
        // The lead is brought back if you closed its tab by exiting it, or started if it never
        // ran, as opening the repository does, so the brief reaches it. A lead you exited this
        // second leaves its ended session behind, which would be kept, and a look for exited
        // leads would close its tab again with the brief waiting. So that session goes first,
        // with its tab closed, as such a look would leave it. Then saving the brief and opening
        // the tab are one change. Nothing waits between the steps, and a daemon stopped after
        // any of them finds things as one of its own looks would: the lead closed with no brief,
        // or open with its brief, which its start brings back and types in. A repository never
        // opened gets its first time, or its lead would have no tab. One opened before keeps its
        // time, so plain sc still opens the one you opened last.
        // Only a lead on tmux keeps its session after you exit it.
        const { name, host, hostId } = leadOf(db, to.owner, to.repo);
        const id = hostId ?? name;
        if (host === "tmux" && exitedCleanly(sessions, id)) {
          db.run("UPDATE repositories SET tab_closed = 1 WHERE owner = ? AND repo = ?", [
            to.owner,
            to.repo,
          ]);
          endExitedSession(sessions, id);
        }
        db.transaction(() => {
          briefLead(db, sessions, caller, to, request.text, request.asked);
          db.run(
            "UPDATE repositories SET opened = COALESCE(opened, ?), tab_closed = 0 WHERE owner = ? AND repo = ?",
            [Date.now(), to.owner, to.repo],
          );
        })();
        // Starting the lead isn't waited on, as an agent's command answers at once. Its notes go
        // in once it runs.
        void bringBackLead(to, leadOfCaller(caller));
        return { briefed: to.name };
      }
      case "submit": {
        const thread = callingThread(caller);
        submitRound(db, sessions, thread.folder, request.summary);
        return { submitted: threadName(db, thread) };
      }
      case "question asked":
        questionAsked(db, sessions, callingThread(caller).folder);
        return { asking: true };
      case "turn ended":
        turnEnded(db, sessions, callingThread(caller).folder, request);
        return { asking: false };
      case "turn failed":
        turnFailed(db, sessions, callingThread(caller), request.error, request.message);
        return { erred: true };
      case "question closed":
        questionClosed(db, callingThread(caller).folder);
        return { asking: false };
      case "question answered":
        questionAnswered(db, callingThread(caller).folder, request.prompt);
        return { asking: false };
      // Esc on Codex flags nothing: you are looking at the builder anyway.
      case "turn interrupted":
        return { state };
      case "start":
        return startTask(request);
      case "start new": {
        const repository = findRepository(db, request.repo);
        if (await hasNoCommits(db, repository)) throw new Error(noCommits(repository));
        const thread = await startThread(db, request);
        if (thread.status === "queued") return { started: queuedText(db, thread) };
        setUpAndStart(thread);
        return { started: `Started ${threadName(db, thread)}.` };
      }
    }
  };
  // Returns who holds the check slots, for sc ps. Asked for one repository, as a lead always is,
  // a slot held in another is named only as that, so a lead learns no other repository's
  // threads, yet still sees why its checks wait.
  const slotsShown = (repository: string | undefined) => {
    const one = repository === undefined ? null : findRepository(db, repository);
    return slotHolders().map(({ holder, repository: of, since }) => ({
      holder: one === null || of === `${one.owner}/${one.repo}` ? holder : "another repository",
      since,
    }));
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
      const reviewer = caller !== "you" && "review" in caller ? caller.review : null;
      const thread = reviewer ?? builderOf(caller);
      const repository = thread ?? (from === undefined ? undefined : repositoryAt(db, from));
      if (!repository) throw new Error("run sc check in a checkout of a repository Skelcrew has");
      // sc ps names the slot's holder as it names threads, such as APP-12/reviewer.
      const holder =
        thread === null ? "you" : `${threadName(db, thread)}/${reviewer ? "reviewer" : "builder"}`;
      holdCheckSlot(connection, repositoryCommands(repository).test, {
        holder,
        repository: `${repository.owner}/${repository.repo}`,
      });
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
          .then(() => handle(resolveName(limitToOwnRepository(asked.data, caller)), caller))
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
  // A task that left the queue but whose builder's start the stop cut short goes back to it
  // first, as it can't be brought back.
  backToQueue(db);
  // Taken before any request comes in, so a thread started meanwhile, still setting up,
  // isn't taken for one whose setup the daemon's stop cut short.
  const before = liveThreads(db);
  // Reviews the daemon's stop cut short join the queue of reviews first, before any request or
  // builder could start one, and in the order they had: those that were running, then those
  // that waited, by when they joined. A review doesn't need its builder until it types changes
  // in, so those wait until the builder is back, or has failed and ended the round.
  const reviewsCutShort = before.filter(
    (t) => roundOf(t).submitting === null && roundOf(t).reviewing !== null,
  );
  reviewsCutShort.sort((a, b) => (a.queued ?? 0) - (b.queued ?? 0));
  const builderBack = new Map<string, () => void>();
  // Their sockets open first, so their reviewers can run sc check.
  for (const thread of reviewsCutShort) await listenFor(thread);
  for (const thread of reviewsCutShort) {
    const back = Promise.withResolvers<void>();
    builderBack.set(thread.folder, back.resolve);
    resumeRound(db, sessions, thread.folder, back.promise);
  }
  // A tab the daemon was closing as it stopped opens again if its lead still runs, before any
  // request could close it.
  await reopenTabsOfRunningLeads(db, sessions);
  // A lead you exited while the daemon was down closes its tab, before any request could open
  // it, and isn't brought back. From here on, the daemon looks each second for a lead you exit.
  await closeExitedLeads(db, sessions);
  setInterval(
    () =>
      doing("closing the tabs of exited leads", () =>
        closeExitedLeads(db, sessions).catch((error) =>
          console.log(`couldn't close the tabs of exited leads: ${errorText(error)}`),
        ),
      ),
    exitLook,
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
  // The safety net marks a builder that stopped, and that nobody acted on, as needing you. It
  // looks every few seconds, reading the wait from your config each time, so a change to it
  // counts at once.
  setInterval(() => {
    try {
      doing("marking stopped builders nobody acted on", () =>
        markForgotten(db, sessions, graceMinutes()),
      );
    } catch (error) {
      console.log(`couldn't mark stopped builders nobody acted on: ${errorText(error)}`);
    }
  }, look);
  // A host that shows status hears each builder's as it is now, and each change from here on.
  reportStatuses(db);
  // A host's own apps show each builder by its title as it is now, such as after an upgrade.
  renameBuilders(db);
  // Open your socket.
  await open(path, "you");
  console.log(`Listening on ${path}.`);
  // Bring back the lead of each repository you have opened, side by side, so a host that hangs
  // holds up no other lead. One that fails is logged, and the rest still start. One that fails
  // while notes wait for it, such as a brief, is tried again every minute, so the notes go in
  // once whatever stopped it clears. The builders and polling wait for them, as before leads
  // could run on other hosts, so a lead's start and the first poll never overlap. Requests are
  // answered meanwhile, as the socket is open.
  await Promise.all(openedRepositories(db).map((repository) => bringBackLead(repository, null)));
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
      (back) => {
        settled();
        if (back === "not wanted") return;
        resumeRound(db, sessions, thread.folder);
        if (thread.erred && thread.limited) wakeAfterLimit(db, sessions, thread.folder);
      },
      (error) => {
        endRound(thread.folder);
        settled();
        failThread(db, sessions, thread, error);
      },
    );
  }
  // Type the messages waiting for builders as soon as each can take them, looking every look,
  // as a builder becomes idle with no word to the daemon, such as after Esc.
  setInterval(() => deliverAllWaiting(db, sessions), look);
  // Start the tasks whose turn came in the queue of limits.threads, now and every look from
  // here on, as a builder ends in many ways, and a limit raised in a file frees places too.
  // Only after the threads above were brought back, so a task leaving the queue now is never
  // also taken for one whose setup the daemon's stop cut short. A thread sc rm is removing stays
  // queued, so it never starts while it is being removed, as does one that still owes its claim,
  // which is asked for again each time.
  const startFromQueue = () => {
    try {
      claimOwed(db, sessions);
      for (const thread of leaveQueue(db, beingRemoved))
        if (thread.session === null) setUpAndStart(thread);
        else comeBack(thread);
    } catch (error) {
      console.log(`couldn't start tasks from the queue: ${errorText(error)}`);
    }
  };
  startFromQueue();
  setInterval(() => doing("starting tasks from the queue", startFromQueue), look);
  // Start polling, which also lets any sc start waiting on it go ahead, and keep Skelcrew itself
  // up to date.
  polling.resolve(pollRepositories(db, sessions, every, setUpAndStart, startingTasks));
  keepUpToDate(db);
}
