// Starting work on a thread: recording it, setting up its clone, starting its builder or
// bringing it back, and marking the thread failed when any of that goes wrong.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessNamed } from "../agents/harness.ts";
import { refuseCredentials, setupCommand } from "../agents/sandbox.ts";
import {
  agentRuns,
  checkAgentStarted,
  hasSession,
  type Labels,
  startSession,
  stopSession,
} from "../agents/sessions.ts";
import { approvedAgents } from "../approved-agents.ts";
import { agentRole, checkFlow, repositoryCommands, roundLimit, sessionHost } from "../config.ts";
import { flowRoles } from "../flows.ts";
import { errorText } from "../format.ts";
import { cloneDir, threadSocket } from "../paths.ts";
import { trackerOf } from "../plugins/ask.ts";
import { installedPlugins } from "../plugins/plugin.ts";
import { needsInstall } from "../plugins/repository.ts";
import { filesFor, type Host, hostNamed, pluginHost } from "../plugins/runtime.ts";
import { repositoryRole } from "../roles.ts";
import { capture } from "../run.ts";
import type { Settings } from "../settings.ts";
import { claimOwnName, type Filed, filedTask, startFiled } from "./backlog.ts";
import { ownTask, taskOf, threadTask } from "./copy.ts";
import { pastRoundLimit } from "./decide.ts";
import { fetchBranch, noMaintenance } from "./git.ts";
import { dropEndNotes, noteForLead, typeLeadNotes } from "./messages.ts";
import { findRepository, forgeAuthor, forgeKnown, refreshClones } from "./repo.ts";
import { forgetStatus, needsYou } from "./status.ts";
import { type BroughtBack, type Restarted, supervisor } from "./supervisor.ts";
import { joinsQueue, joinTime } from "./task-queue.ts";
import {
  builderHarness,
  builderSession,
  cloneOf,
  folderName,
  hostGone,
  hostMissing,
  labelledBuilders,
  log,
  markBeforeHost,
  readThread,
  record,
  renameOnHost,
  repositoryOf,
  sessionTitle,
  Thread,
  taskName,
  threadName,
} from "./thread.ts";

// Returns what sc start means for a task, given its thread if it has one: bring back a
// stopped thread, let a live one past the round limit go on, or else start a new thread, which
// startThread refuses when the task's thread can't start over. The config is read only for a
// live thread: a bad max_rounds must fail a thread with the reason, not refuse sc start.
export function startChoice(thread: Thread | null): "bring back" | "go on" | "new thread" {
  if (thread?.status === "stopped") return "bring back";
  const live = thread?.status === "working" || thread?.status === "waiting";
  if (thread && live && pastRoundLimit(thread, roundLimit(thread))) return "go on";
  return "new thread";
}

// Returns the status of a stopped thread that sc start brings back. Its builder sits at its
// prompt once back, as its turn ended with the stop. It waits when a round or its PR will wake
// it: a submit or review under way, or the PR's checks, reviews and comments. It works when it
// has a review's changes to be typed in, or no PR yet.
export function statusOnceBack(stopped: Thread): "waiting" | "working" {
  const { pr, submitting, reviewing, telling } = stopped;
  const waitsOnRound =
    telling === null && (pr !== null || submitting !== null || reviewing !== null);
  return waitsOnRound ? "waiting" : "working";
}

export function startThread(
  db: Database,
  given:
    | {
        repo: string;
        task: string;
        from?: string | undefined;
        short?: string | undefined;
        flow?: string | undefined;
        now?: boolean | undefined;
      }
    | {
        repo: string;
        title: string;
        body: string;
        short?: string | undefined;
        flow?: string | undefined;
      },
  claimed = false,
): Promise<Thread> {
  const start = startsBefore.then(() => recordThread(db, given, claimed));
  startsBefore = start.catch(() => {});
  return start;
}

// The last start under way, which the next one waits for.
let startsBefore: Promise<unknown> = Promise.resolve();

async function recordThread(
  db: Database,
  given: Parameters<typeof startThread>[1],
  claimed: boolean,
): Promise<Thread> {
  const repository = findRepository(db, given.repo);
  const { owner, repo, name } = repository;
  const tracked = trackerOf(db, repository) !== null;
  const agents = approvedAgents({ owner, repo });
  const flow = given.flow ?? "default";
  checkFlow({ owner, repo, agents }, name, flow);
  const refuseMissingPlugins = () => {
    if (needsInstall(cloneDir(owner, repo)))
      throw new Error(
        `${name}'s plugins aren't all installed here, so its tasks can't start. Run sc install in your own terminal, then start it again.`,
      );
  };
  const where = "WHERE owner = ? AND repo = ? AND task = ?";
  let task: string;
  let title: string;
  let body: string;
  let issueLink: string | null = null;
  let closes: string | null = null;
  let fromBacklog: Filed | null = null;
  if ("title" in given) {
    const clone = cloneDir(owner, repo);
    if (!existsSync(clone) || !forgeKnown(db, repository)) await refreshClones(db);
    const current = findRepository(db, given.repo);
    refuseMissingPlugins();
    task = await claimOwnName(db, current, clone);
    ({ title, body } = given);
    closes = "";
  } else {
    refuseMissingPlugins();
    task = given.task;
    const had = Thread.nullable().parse(
      db.query(`SELECT * FROM task_threads ${where}`).get(owner, repo, task),
    );
    const filed = filedTask(db, owner, repo, task);
    if (tracked && !ownTask(task)) {
      const found = taskOf(db, owner, repo, task);
      if (found.state !== "open") throw new Error(`there is no open issue ${task} in ${name}`);
      ({ title, body } = found);
      issueLink = found.link;
      closes = found.closes;
    } else if (filed && !had) {
      fromBacklog = filed;
      ({ title, body } = filed);
      closes = "";
    } else if (had?.title) {
      title = had.title;
      body = had.body ?? "";
      issueLink = had.issue_link;
      closes = had.closes;
    } else
      throw new Error(
        tracked
          ? `there is no open issue ${task} in ${name}`
          : `${name} has no tracker, and no thread ${taskName(name, task)}: start one with sc start ${name} "<title>" "<body>"`,
      );
  }
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-|-$/g, "");
  const freeFolder = (folder: string) => {
    const taken = (f: string) => db.query("SELECT 1 FROM threads WHERE folder = ?").get(f);
    let free = folder;
    for (let n = 2; taken(free); n++) free = `${folder}-${n}`;
    return free;
  };
  const ended = Thread.nullable().parse(
    db
      .query(`SELECT * FROM task_threads ${where} AND status IN ('failed', 'done')`)
      .get(owner, repo, task),
  );
  const git = (...args: string[]) => capture(["git", "-C", cloneDir(owner, repo), ...args]);
  if (ended)
    for (const kind of ["threads", "bases", "remote", "approved"]) {
      const ref = `refs/skelcrew/${kind}/${ended.folder}`;
      if (!(await git("rev-parse", "--verify", "--quiet", ref)).ok) continue;
      const { ok, said } = await git("update-ref", "-d", ref);
      if (!ok)
        throw new Error(
          `couldn't start ${taskName(name, task)} over, as Skelcrew couldn't delete ${ref}: ${said}`,
        );
    }
  const record = db.transaction(() => {
    const before = Thread.nullable().parse(
      db.query(`SELECT * FROM task_threads ${where}`).get(owner, repo, task),
    );
    if (before && before.status !== "failed" && before.status !== "done")
      throw new Error(`${taskName(name, task)} has a thread already`);
    const queued = !("now" in given && given.now) && joinsQueue(db, repository);
    const thread: Thread = {
      owner,
      repo,
      task,
      folder: before?.folder ?? freeFolder(`${folderName(name)}-${task}`),
      branch: slug ? `skelcrew/${task}-${slug}` : `skelcrew/${task}`,
      base: "from" in given ? (given.from ?? null) : null,
      status: queued ? "queued" : "working",
      session: null,
      rounds: 0,
      pr: null,
      needs_you: false,
      submitting: null,
      reviewing: null,
      queued: null,
      telling: null,
      held: null,
      seen: [],
      last_review: null,
      last_comment: null,
      last_check: null,
      asking: false,
      turn_ended: false,
      submitted: false,
      told_lead: false,
      erred: false,
      limited: false,
      limit_reset: null,
      review_limited: false,
      review_reset: null,
      noting: null,
      title,
      body,
      started: Date.now(),
      checks: null,
      conflicts: null,
      ci_passed: false,
      reviewer: null,
      reviewed_by: null,
      review_round: null,
      top_round: null,
      verdict: null,
      review_line: null,
      reviewed_commit: null,
      no_ci: null,
      ci_shown: [],
      review_at: null,
      harness: null,
      short: given.short ?? null,
      assigned: before?.assigned ?? false,
      changed: null,
      updates: [],
      state: null,
      host: before?.host ?? null,
      host_id: before?.host_id ?? null,
      merged: false,
      issue_link: issueLink,
      closes,
      merge_plan: null,
      merge_id: null,
      merge_by: null,
      merge_at: null,
      merge_asked: null,
      merge_waits: null,
      merge_noted: null,
      merge_noted_for: [],
      merge_pinned: null,
      merge_record: null,
      merge_record_id: null,
      merge_followup: null,
      needs_you_for: null,
      limit_decided: false,
      ended_at: null,
      ended_said: null,
      review_failed: false,
      agents,
      flow,
      review_post: null,
      posting: null,
      review_findings: null,
      queued_since: queued ? joinTime(db) : null,
    };
    db.run(`DELETE FROM threads ${where}`, [owner, repo, task]);
    db.run("DELETE FROM messages WHERE folder = ?", [thread.folder]);
    dropEndNotes(db, thread.folder);
    db.run(
      `INSERT INTO threads (owner, repo, task, folder, branch, base, status, session, started, turn_ended, host, host_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        owner,
        repo,
        task,
        thread.folder,
        thread.branch,
        thread.base,
        thread.status,
        null,
        thread.started,
        thread.host,
        thread.host_id,
      ],
    );
    db.run(
      `INSERT OR REPLACE INTO tasks
        (owner, repo, task, title, body, short, assigned, seen, issue_link, closes, agents, flow,
          queued_since)
        VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
      [
        owner,
        repo,
        task,
        title,
        body,
        thread.short,
        thread.assigned,
        issueLink,
        closes,
        thread.agents,
        thread.flow,
        thread.queued_since,
      ],
    );
    const claims = [owner, repo, task];
    if (claimed) db.run("DELETE FROM claims WHERE owner = ? AND repo = ? AND task = ?", claims);
    else if (queued && tracked && !ownTask(task))
      db.run("INSERT OR IGNORE INTO claims (owner, repo, task) VALUES (?, ?, ?)", claims);
    log(db, thread);
    return thread;
  });
  if (fromBacklog)
    return startFiled(db, repository, cloneDir(owner, repo), fromBacklog.task, record);
  return record();
}

// Runs a command and waits for it, throwing with the end of its output when it fails, so a
// failed setup says why. `doing` names what failed, since a sandboxed command's own words
// are mostly bwrap's.
async function mustRun(
  argv: string[],
  doing = argv.join(" "),
  env: Record<string, string | undefined> = process.env,
) {
  const { said, ok } = await capture(argv, { env });
  if (!ok) throw new Error(`${doing} failed: ${said.slice(-2000)}`);
}

// Quotes a word for sh, which runs the hook that adds you as co-author.
const shellQuoted = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

// Returns the branch the thread's PR goes into: the one it started from with --from, or else
// the default branch, which Skelcrew's clone is on.
export function baseOf(thread: Thread): string {
  if (thread.base) return thread.base;
  const head = Bun.spawnSync(
    ["git", "-C", cloneDir(thread.owner, thread.repo), "symbolic-ref", "--short", "HEAD"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!head.success) throw new Error(`git symbolic-ref failed: ${head.stderr.toString().trim()}`);
  return head.stdout.toString().trim();
}

// Makes the thread's clone afresh: cloned from Skelcrew's clone, on the thread's branch from the
// default branch or the one given with --from, with your name for commits, and the setup
// commands run once in the sandbox. The daemon runs git in the thread's clone only here,
// before anything from the repository has run in it. After that the builder controls
// everything in the folder, .git included.
export async function setUpThread(db: Database, thread: Thread): Promise<void> {
  const clone = cloneOf(thread);
  // Skelcrew's clone of the repository can still be on its way, as the daemon refreshes clones as
  // it starts, and its skelcrew.yaml, which sets up the thread, must be the latest pushed. Asking
  // for a refresh joins the one under way.
  await refreshClones(db);
  // A failed thread starting over leaves its old clone behind, so it goes first.
  rmSync(clone, { recursive: true, force: true });
  // From Skelcrew's own clone on the same disk, so git links its files rather than copying them.
  // Maintenance stays off in the thread's clone too, so the builder's git doesn't leave it running
  // in the background. A fetch from the clone, as the daemon makes, is safe from it either way.
  await mustRun([
    "git",
    "clone",
    "--quiet",
    "--no-checkout",
    ...noMaintenance,
    cloneDir(thread.owner, thread.repo),
    clone,
  ]);
  // The branch starts from the base as the forge has it now, not as Skelcrew's clone last saw it.
  await fetchBranch(db, repositoryOf(db, thread), clone, thread.base);
  await mustRun(["git", "-C", clone, "checkout", "--quiet", "-b", thread.branch, "FETCH_HEAD"]);
  // The reviewer reads the diff against origin/<base>, which must be where the branch
  // started. Cloned from Skelcrew's clone, the thread's clone has only the default branch there,
  // and as Skelcrew's clone last saw it, which can be older.
  await mustRun([
    "git",
    "-C",
    clone,
    "update-ref",
    `refs/remotes/origin/${baseOf(thread)}`,
    "FETCH_HEAD",
  ]);
  // Your git config is hidden from the builder. Its commits are authored by the forge's own,
  // such as its app's bot, with you as co-author, so it is always clear who wrote what. With a
  // forge that names none, or no forge, they are authored by you. Only your global config,
  // since the folder the daemon started in makes no difference.
  const globalGitConfig = (key: string) =>
    Bun.spawnSync(["git", "config", "--global", "--get", key], { stdout: "pipe" })
      .stdout.toString()
      .trim();
  const you = { name: globalGitConfig("user.name"), email: globalGitConfig("user.email") };
  const author = forgeAuthor(db, thread)?.match(/^(.+) <(.+)>$/);
  const committer = author ? { name: author[1] ?? "", email: author[2] ?? "" } : you;
  if (committer.name) await mustRun(["git", "-C", clone, "config", "user.name", committer.name]);
  if (committer.email) await mustRun(["git", "-C", clone, "config", "user.email", committer.email]);
  // A hook adds you as co-author to each commit the forge's author makes, since the builder
  // writes the message and could leave the trailer out.
  if (author && you.name && you.email) {
    mkdirSync(join(clone, ".git", "hooks"), { recursive: true });
    writeFileSync(
      join(clone, ".git", "hooks", "commit-msg"),
      `#!/bin/sh\nexec git interpret-trailers --in-place --if-exists addIfDifferent --trailer ${shellQuoted(`Co-authored-by: ${you.name} <${you.email}>`)} "$1"\n`,
      { mode: 0o755 },
    );
  }
  // Make sure no git login reached the clone's settings before the builder can read them,
  // then run the repository's setup commands in the sandbox.
  refuseCredentials(clone);
  for (const command of repositoryCommands(thread).setup ?? []) {
    const { argv, env } = setupCommand(clone, command);
    await mustRun(argv, `the setup command "${command}"`, env);
  }
}

// Returns the builder's instructions: its role's, from `role`, then the setup and test commands the
// repository's skelcrew.yaml or your config names, each on its own, or that none is configured.
// The builder can't read your config from its sandbox, so it is told. A builder told one it
// needs isn't configured asks the lead rather than guess, as a guessed command is often wrong
// and nobody would see it was a guess.
export function builderInstructions(
  role: string,
  commands: Pick<Settings, "setup" | "test">,
): string {
  const instructions = role.replace(/\n$/, "");
  const { setup, test } = commands;
  const shown = (list: string[]) => `\`${list.join(" && ")}\``;
  // A missing command is one the builder may need to ask about. An empty list says on purpose
  // that there is none, so the builder isn't sent to the lead for it.
  const setupTold =
    setup === undefined
      ? "No setup command is configured."
      : setup.length === 0
        ? "Setup is configured as none, so Skelcrew ran no setup command."
        : `Skelcrew set up your clone with ${shown(setup)}.`;
  const testTold =
    test === undefined
      ? "No test command is configured."
      : test.length === 0
        ? "Test is configured as none, so the repository has no test suite to run."
        : `The repository's whole test suite runs with ${shown(test)}. That is for CI and the reviewer, so don't run it yourself. If you ever must, run \`sc check\`, which runs it once one of this machine's check slots is free, never the command itself. It shows how the repository runs its tests, lint and typecheck, so run the parts near your change.`;
  return `${instructions}\n\n${setupTold} ${testTold}\n`;
}

// Starts the thread's builder in a session, in the sandbox in its clone: bringing back the
// conversation it saved, or else afresh with the task as its reviewer gets it as its first
// message: the title and body from Skelcrew's copy, and the lead's messages after them. Throws
// when it exits as soon as it starts, or when its settings, its round limit included, aren't
// valid. A builder's first start picks the harness your config names, and saves it with the
// thread, which keeps it from then on: a conversation can't move to another harness. The session id is stored before the builder starts, so the builder can be
// brought back after its session is gone. It starts on the session host your config names now,
// which the thread keeps until its builder ends, and throws when that host isn't installed.
export function startBuilder(db: Database, sessions: string, thread: Thread): Promise<void> {
  return supervisor(thread.folder).start(builderHost(db, sessions, thread, false));
}

// Prepares the builder's start for startBuilder, then starts it on its host, in the turn its
// supervisor gives. A restart is no new stretch of work, so it keeps the time the sidebar shows.
async function startOnConfiguredHost(
  db: Database,
  sessions: string,
  thread: Thread,
  restarting: boolean,
): Promise<void> {
  const hostName = sessionHost();
  const host = hostNamed(db, sessions, hostName);
  if (host === null)
    throw new Error(
      `your session host ${hostName} isn't installed as a runtime plugin that provides sessions`,
    );

  const clone = cloneOf(thread);
  const stored = thread.session;
  const role = agentRole("builder", thread);
  roundLimit(thread);
  const harness = stored === null ? harnessNamed(role.harness) : builderHarness(thread);
  const resume = stored === null ? null : harness.saved(thread.folder, clone, stored);
  const session = resume ?? crypto.randomUUID();
  let start: { resume: string } | { sessionId: string; prompt: string } = { resume: session };
  if (!resume) {
    const { title, body } = threadTask(db, thread);
    start = { sessionId: session, prompt: body ? `${title}\n\n${body}` : title };
  }
  record(db, thread.folder, { session, harness: harness.name, queued_since: null });
  if (!restarting)
    db.run("UPDATE threads SET working_since = ? WHERE folder = ?", [Date.now(), thread.folder]);
  const files = filesFor(host);
  const { argv, env } = await harness.start({
    name: thread.folder,
    socket: threadSocket(thread.folder),
    model: role.harness === harness.name ? role.model : undefined,
    thread: clone,
    ...(existsSync(cloneDir(thread.owner, thread.repo))
      ? { origin: cloneDir(thread.owner, thread.repo) }
      : {}),
    system: builderInstructions(
      repositoryRole(flowRoles(thread).build, thread).instructions,
      repositoryCommands(thread),
    ),
    skills: thread,
    files,
    ...start,
  });
  const on = { host, name: hostName };
  await startSessionOn(db, thread, on, { folder: clone, command: argv, env, files });
  console.log(`${resume ? "Brought back" : "Started"} the builder of ${threadName(db, thread)}.`);
}

type BuilderSession = {
  folder: string;
  command: string[];
  env: Record<string, string>;
  files?: string | undefined;
};

// Starts the thread's builder in a session of its own on the host, running `command`, then
// watches a moment for it to exit at once, so a broken start fails the thread with a reason. It
// takes its turn with the builder's ends, so a stop that comes while the host starts it waits,
// and then ends the builder it started. A thread stopped or ended while this waited its turn
// starts nothing, and this throws.
export function startOnHost(
  db: Database,
  thread: Thread,
  on: { host: Host; name: string },
  session: BuilderSession,
): Promise<void> {
  return supervisor(thread.folder).start({ start: () => startSessionOn(db, thread, on, session) });
}

async function startSessionOn(
  db: Database,
  thread: Thread,
  on: { host: Host; name: string },
  session: BuilderSession,
): Promise<void> {
  const now = readThread(db, thread.folder);
  if (now.status !== "working" && now.status !== "waiting")
    throw new Error(`the thread was ${now.status} while its builder started`);
  const repository = `${thread.owner}/${thread.repo}`;
  const title = sessionTitle(db, now);
  const labels: Labels = {
    repository,
    role: "builder",
    task: threadName(db, thread).toLowerCase(),
    title,
  };
  record(db, thread.folder, { host: on.name, host_id: null });
  const id = await startSession(on.host, thread.folder, { ...session, labels });
  forgetStatus(on.name, id);
  record(db, thread.folder, { host_id: id });
  const latest = readThread(db, thread.folder);
  if (sessionTitle(db, latest) !== title) renameOnHost(db, thread.folder);
  await checkAgentStarted(on.host, id, "builder");
}

// Returns how the thread's supervisor reaches its builder, wherever it runs now. A builder you
// stopped has no host left to look on. A builder whose host plugin is gone may still run there,
// out of reach, so the thread needs you rather than its builder starting a second time
// elsewhere. Once the plugin is back, such as after sc install, the mark that asked for it goes,
// and any mark the thread had before comes back. A plugin's host that can't be reached for now,
// such as one restarting with the machine, is asked again: its builder may well still run there.
function builderHost(db: Database, sessions: string, thread: Thread, restarting: boolean) {
  const session = () => builderSession(db, sessions, readThread(db, thread.folder));
  return {
    start: () => startOnConfiguredHost(db, sessions, readThread(db, thread.folder), restarting),
    runs: async () => {
      if (readThread(db, thread.folder).host === null) return false;
      const { host, id } = await session();
      return agentRuns(host, id);
    },
    clear: async () => {
      if (readThread(db, thread.folder).host === null) return;
      const { host, id } = await session();
      if (await hasSession(host, id)) await stopSession(host, id);
    },
    gone: () => markHostGone(db, sessions, readThread(db, thread.folder)),
    ...(thread.host === "tmux"
      ? {}
      : {
          retry: (error: unknown) => {
            log(
              db,
              readThread(db, thread.folder),
              `couldn't reach ${thread.host}, trying again: ${errorText(error)}`,
            );
          },
        }),
  };
}

// Marks a thread whose builder's host plugin is gone as needing you, and returns why nobody can
// tell whether its builder runs, or null once its host is there. A thread marked already, such
// as after a restart while the plugin stays gone, keeps the mark it had after the instruction.
function markHostGone(db: Database, sessions: string, thread: Thread): string | null {
  if (thread.host === null) return null;
  if (hostNamed(db, sessions, thread.host) !== null) {
    const before = markBeforeHost(thread.host, thread.needs_you_for);
    if (before !== undefined)
      record(
        db,
        thread.folder,
        { needs_you_for: before },
        `its session host ${thread.host} is back`,
      );
    return null;
  }
  const had = markBeforeHost(thread.host, thread.needs_you_for);
  const mark = hostMissing(thread.host, had === undefined ? thread.needs_you_for : had);
  if (needsYou(thread) && had === undefined)
    noteForLead(db, sessions, thread, `${threadName(db, thread)} needs you: ${mark}`, null, true);
  record(db, thread.folder, { needs_you_for: mark }, hostGone(thread));
  typeLeadNotes(db, sessions);
  return hostGone(thread);
}

// Ends the builder an earlier start of a thread starting over may have left running, before its
// clone is set up again, so two builders never share the clone. Such as a builder a host started
// whose answer was lost, so the thread failed without saving its ID: it is found by its labels.
// The thread then has no host. A host that can't be reached throws and keeps the thread's host,
// so the next start tries again.
export function endEarlierBuilder(db: Database, sessions: string, thread: Thread): Promise<void> {
  if (thread.host === null) return Promise.resolve();
  return supervisor(thread.folder).end({
    stop: async () => {
      const { host, id } = await builderSession(db, sessions, thread);
      if (await hasSession(host, id)) await stopSession(host, id);
      record(db, thread.folder, { host: null, host_id: null });
    },
  });
}

// Brings back a thread's builder after the daemon restarts, or for sc start after sc stop. A
// builder still running is left alone, on whichever host it runs. One whose session is gone or
// ended is started again, on the host your config names now. Throws for a thread with no
// session: the daemon stopped before its setup finished, and the error says to run sc start
// again. A host that can't be reached is asked again for as long as the thread stays as it was,
// which stays live meanwhile, with its round and messages waiting for it. Gives back "back" once
// the builder runs, or, for a host plugin that is gone, why nobody can tell whether it does. A
// thread stopped, removed or started over meanwhile is no longer this one's: it gives back "not
// wanted", having touched nothing of the thread as it is now.
export async function bringBack(
  db: Database,
  sessions: string,
  thread: Thread,
): Promise<BroughtBack> {
  if (thread.session === null)
    throw new Error("the daemon stopped while setting up the thread: run sc start again");
  return supervisor(thread.folder).bringBack(
    builderHost(db, sessions, thread, false),
    sameLiveThread(db, thread),
  );
}

// Ends the builder's session and starts it again, resuming its conversation, for sc restart. A
// stop or removal under way, or one that came while the session ended, wins, as does the thread
// changing: then the builder stays ended. Its round goes on untouched, as nothing cut it short,
// and the stretch of work the sidebar times goes on too.
export function restartBuilder(db: Database, sessions: string, thread: Thread): Promise<Restarted> {
  const same = sameLiveThread(db, thread);
  const unchanged = () => same() && readThread(db, thread.folder).session === thread.session;
  return supervisor(thread.folder).restart(builderHost(db, sessions, thread, true), unchanged);
}

// Returns whether the thread is still the live one it was, by when it started.
function sameLiveThread(db: Database, thread: Thread) {
  return () => {
    const now = readThread(db, thread.folder);
    const live = now.status === "working" || now.status === "waiting";
    return now.started === thread.started && live;
  };
}

// Throws when a builder of the thread still runs on any host, though the thread keeps none, for
// sc start on a stopped thread. Every host is looked on, tmux by the builder's name and each
// installed plugin by its labels, as the thread doesn't say where its last builder ran, and
// your config may name another host since. Such a builder outlived a stop, such as on a host
// that said it ended a session it didn't, and a second one would share its clone. A host that
// can't be asked fails the start, as nobody can tell whether the builder runs there.
export async function refuseSecondBuilder(
  db: Database,
  sessions: string,
  thread: Thread,
): Promise<void> {
  const plugins = installedPlugins(db).flatMap(({ name }) => {
    const host = pluginHost(db, name);
    return host === null ? [] : [{ name, host }];
  });
  for (const { name: hostName, host } of [{ name: "tmux", host: sessions }, ...plugins]) {
    // One whose agent ended left only its last screen, and works in the clone no more.
    const id =
      typeof host === "string"
        ? (await agentRuns(host, thread.folder))
          ? thread.folder
          : undefined
        : (await labelledBuilders(host, thread)).find(({ running }) => running)?.name;
    if (id === undefined) continue;
    const name = threadName(db, thread);
    throw new Error(
      `${name}'s last builder still runs on ${hostName}, as ${id}. End it there, then run sc start ${name} again.`,
    );
  }
}

// Marks the thread failed and logs why, in its log and the daemon's, so you can see what
// stopped it and start it again. The lead hears of it in a note that goes ahead of routine
// ones, such as "app-12 failed: its setup command failed", as the human should see it soon. A thread that sc stop stopped, or that its PR's merge or
// close ended, meanwhile stays as it is: its builder ended because of that, such as within
// the moment Skelcrew watches it start.
export function failThread(db: Database, sessions: string, thread: Thread, error: unknown): void {
  // Read the thread afresh, as sc stop or a merge may have changed it while it was starting.
  const why = errorText(error);
  const { status } = readThread(db, thread.folder);
  if (status === "stopped" || status === "done") {
    console.log(`${threadName(db, thread)} stays ${status}: ${why}`);
    return;
  }
  record(db, thread.folder, { status: "failed" }, why);
  console.log(`${threadName(db, thread)} failed: ${why}`);
  // Every note to the lead is one line, as an error's text may not be. It names the thread's
  // folder as one that ended, so starting the thread over drops it, should it still wait: the
  // lead would otherwise ask you to start a thread that already runs again.
  const line = `${threadName(db, thread)} failed: ${why}`.replace(/\s+/g, " ").slice(0, 200);
  noteForLead(db, sessions, thread, line, thread.folder, true);
}
