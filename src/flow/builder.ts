// Starting work on a thread: recording it, setting up its clone, starting its builder or
// bringing it back, and marking the thread failed when any of that goes wrong.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { harnessNamed } from "../agents/harness.ts";
import instructions from "../agents/prompts/builder.md" with { type: "text" };
import { refuseCredentials, setupCommand } from "../agents/sandbox.ts";
import {
  agentRuns,
  checkAgentStarted,
  endSession,
  hasSession,
  startServer,
  startSession,
} from "../agents/tmux.ts";
import { repositorySetup, threadConfig } from "../config.ts";
import { cloneDir, threadSocket } from "../paths.ts";
import { trackerOf } from "../plugins/ask.ts";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { taskOf } from "./copy.ts";
import { pastRoundLimit } from "./decide.ts";
import { fetchBranch } from "./git.ts";
import { findRepository, forgeAuthor, refreshClones } from "./repo.ts";
import {
  builderHarness,
  cloneOf,
  folderName,
  log,
  readThread,
  record,
  repositoryOf,
  Thread,
} from "./thread.ts";

// Returns what sc start means for a task, given its thread if it has one: bring back a
// stopped thread, let a live one past the round limit go on, or else start a new thread, which
// startThread refuses when the task's thread can't start over. The config is read only for a
// live thread: a bad max_rounds must fail a thread with the reason, not refuse sc start.
export function startChoice(thread: Thread | null): "bring back" | "go on" | "new thread" {
  if (thread?.status === "stopped") return "bring back";
  const live = thread?.status === "working" || thread?.status === "waiting";
  if (thread && live && pastRoundLimit(thread, threadConfig(thread).maxRounds)) return "go on";
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

// Records a new thread and returns it. Its task is either one of the tracker's, with its title
// and body from Skelcrew's copy, which sc start brings up to date first, or a given title and
// body. A given one becomes a task of the repository's own, named t1, t2 and on. That works
// with a tracker too, so you can start work without filing it. Refuses a task the copy doesn't
// have open. Refuses a task that has a thread already, unless that thread failed or is done,
// such as after sc rm: then it starts over in the same folder. It only records the thread,
// since the lead waits on the answer. Setting up its clone and starting its builder come
// after, and can take minutes. `given` is a start request, so its `repo` is the repository's
// name in Skelcrew or its owner/name.
export async function startThread(
  db: Database,
  given:
    | { repo: string; task: string; from?: string | undefined }
    | { repo: string; title: string; body: string },
): Promise<Thread> {
  // Find the repository and whether a tracker holds its tasks, which decides where a named
  // task's title and body come from.
  const repository = findRepository(db, given.repo);
  const { owner, repo, name } = repository;
  const tracked = trackerOf(db, repository) !== null;
  const where = "WHERE owner = ? AND repo = ? AND task = ?";
  let task: string;
  let title: string;
  let body: string;
  if ("title" in given) {
    // The highest number of the repository's own tasks, to name the next one.
    const ownTaskNumbers = db
      .query("SELECT task FROM threads WHERE owner = ? AND repo = ? AND task GLOB 't[0-9]*'")
      .all(owner, repo)
      .map((row) => Number(z.object({ task: z.string() }).parse(row).task.slice(1)));
    task = `t${Math.max(0, ...ownTaskNumbers) + 1}`;
    ({ title, body } = given);
  } else {
    // A named task takes its words from Skelcrew's copy of the tracker. One of the repository's
    // own, or one the tracker no longer has, can only start over on the words its failed or
    // done thread kept.
    task = given.task;
    const had = Thread.nullable().parse(
      db.query(`SELECT * FROM threads ${where}`).get(owner, repo, task),
    );
    if (tracked && !/^t\d+$/.test(task)) {
      const found = taskOf(db, owner, repo, task);
      if (found.state !== "open") throw new Error(`there is no open issue ${task} in ${name}`);
      ({ title, body } = found);
    } else if (had?.title) {
      title = had.title;
      body = had.body ?? "";
    } else
      throw new Error(
        tracked
          ? `there is no open issue ${task} in ${name}`
          : `${name} has no tracker, and no thread ${name}-${task}: start one with sc start ${name} "<title>" "<body>"`,
      );
  }
  // The branch is named by the task and a short form of its title, so you can tell branches
  // apart on the forge.
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-|-$/g, "");
  // Returns a folder name no other thread holds, adding a number when needed. Different
  // names can make the same folder, such as simon/app and simon-app.
  const freeFolder = (folder: string) => {
    // Whether another thread holds that folder.
    const taken = (f: string) => db.query("SELECT 1 FROM threads WHERE folder = ?").get(f);
    let free = folder;
    for (let n = 2; taken(free); n++) free = `${folder}-${n}`;
    return free;
  };
  // Check again for a thread and record the new one in one transaction, so a failed or done
  // thread's row is never removed without the new one taking its place.
  return db.transaction(() => {
    const before = Thread.nullable().parse(
      db.query(`SELECT * FROM threads ${where}`).get(owner, repo, task),
    );
    if (before && before.status !== "failed" && before.status !== "done")
      throw new Error(`${name}-${task} has a thread already`);
    const thread: Thread = {
      owner,
      repo,
      task,
      // A thread that failed or is done starts over in its folder, named when it first started.
      folder: before?.folder ?? freeFolder(`${folderName(name)}-${task}`),
      branch: slug ? `skelcrew/${task}-${slug}` : `skelcrew/${task}`,
      base: "from" in given ? (given.from ?? null) : null,
      status: "working",
      session: null,
      rounds: 0,
      pr: null,
      needs_you: false,
      submitting: null,
      reviewing: null,
      telling: null,
      held: null,
      // A new thread has no PR yet, so everything on the one it opens is new.
      seen: [],
      last_review: null,
      last_comment: null,
      last_check: null,
      asking: false,
      noting: null,
      title,
      body,
      started: Date.now(),
      checks: null,
      reviewer: null,
      reviewed_by: null,
      review_round: null,
      verdict: null,
      review_line: null,
      harness: null,
    };
    // A failed or done thread's row gives way to the new one.
    db.run(`DELETE FROM threads ${where}`, [owner, repo, task]);
    db.run(
      `INSERT INTO threads (owner, repo, task, folder, branch, base, status, session, title,
        body, started, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
      [
        owner,
        repo,
        task,
        thread.folder,
        thread.branch,
        thread.base,
        thread.status,
        null,
        title,
        body,
        thread.started,
      ],
    );
    log(thread);
    return thread;
  })();
}

// Runs a command and waits for it, throwing with the end of its output when it fails, so a
// failed setup says why. `doing` names what failed, since a sandboxed command's own words
// are mostly bwrap's.
async function mustRun(
  argv: string[],
  doing = argv.join(" "),
  env: Record<string, string | undefined> = process.env,
) {
  const { said, ok } = await quietly(argv, { env });
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
  await mustRun([
    "git",
    "clone",
    "--quiet",
    "--no-checkout",
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
  for (const command of repositorySetup(thread)) {
    const { argv, env } = setupCommand(clone, command);
    await mustRun(argv, `the repository's skelcrew.yaml setup command "${command}"`, env);
  }
}

// Starts the thread's builder in tmux, in the sandbox in its clone: bringing back the conversation
// it saved, or else afresh with the task's title and body from Skelcrew's copy as its first
// message. Throws when it exits as soon as it starts. A builder's first start picks the harness
// your config names, and saves it with the thread, which keeps it from then on: a conversation
// can't move to another harness. The session id is stored before the builder starts, so the builder
// can be brought back after its session is gone.
export async function startBuilder(db: Database, tmux: string, thread: Thread): Promise<void> {
  // Pick the harness: your config's for a first start, the saved one for a builder coming back.
  // A saved conversation the harness can't find starts afresh under a new id.
  const clone = cloneOf(thread);
  const stored = thread.session;
  const role = threadConfig(thread).builder;
  const harness = stored === null ? harnessNamed(role.harness) : builderHarness(thread);
  const resume = stored === null ? null : harness.saved(thread.folder, clone, stored);
  const session = resume ?? crypto.randomUUID();
  let start: { resume: string } | { sessionId: string; prompt: string } = { resume: session };
  if (!resume) {
    // Saved as the thread started, from Skelcrew's copy brought up to date just before.
    const title = thread.title ?? "";
    const body = thread.body ?? "";
    start = { sessionId: session, prompt: body ? `${title}\n\n${body}` : title };
  }
  record(db, thread.folder, { session, harness: harness.name });
  const { argv, env } = await harness.start({
    name: thread.folder,
    socket: threadSocket(thread.folder),
    // A model name belongs to its harness, so a thread on another one than your config now
    // names for builders gets that harness's default.
    model: role.harness === harness.name ? role.model : undefined,
    thread: clone,
    // Gone once you remove the repository from Skelcrew, and bwrap can't mount what is missing.
    ...(existsSync(cloneDir(thread.owner, thread.repo))
      ? { origin: cloneDir(thread.owner, thread.repo) }
      : {}),
    // In the system prompt rather than the first message, so the first message stays the
    // task in its own words, and the builder still has it after a long conversation is
    // compacted. It asks the builder to ask you only when it must: its question waits on a
    // screen nobody watches.
    system: instructions,
    ...start,
  });
  // Start it in its own tmux session, then watch a moment for it to exit at once, so a broken
  // start fails the thread with a reason.
  startServer(tmux);
  startSession(tmux, thread.folder, { folder: clone, command: argv, env });
  console.log(`${resume ? "Brought back" : "Started"} the builder of ${thread.folder}.`);
  await checkAgentStarted(tmux, thread.folder, "builder");
}

// Brings back a thread's builder after the daemon restarts, or for sc start after sc stop. A
// builder still running is left alone. One whose session is gone or ended is started again.
// Throws for a thread with no session: the daemon stopped before its setup finished, and the
// error says to run sc start again.
export async function bringBack(db: Database, tmux: string, thread: Thread): Promise<void> {
  if (thread.session === null)
    throw new Error("the daemon stopped while setting up the thread: run sc start again");
  // A session whose agent ended is ended too, so the new one can take its name.
  if (agentRuns(tmux, thread.folder)) return;
  if (hasSession(tmux, thread.folder)) endSession(tmux, thread.folder);
  await startBuilder(db, tmux, thread);
}

// Marks the thread failed and logs why, in its log and the daemon's, so you can see what
// stopped it and start it again. A thread that sc stop stopped, or that its PR's merge or
// close ended, meanwhile stays as it is: its builder ended because of that, such as within
// the moment Skelcrew watches it start.
export function failThread(db: Database, thread: Thread, error: unknown): void {
  // Read the thread afresh, as sc stop or a merge may have changed it while it was starting.
  const why = errorText(error);
  const { status } = readThread(db, thread.folder);
  if (status === "stopped" || status === "done") {
    console.log(`${thread.folder} stays ${status}: ${why}`);
    return;
  }
  record(db, thread.folder, { status: "failed" }, why);
  console.log(`${thread.folder} failed: ${why}`);
}
