// Starting work on a thread: recording it, setting up its clone, starting its builder or
// bringing it back, and marking the thread failed when any of that goes wrong.
import type { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import instructions from "../agents/prompts/builder.md" with { type: "text" };
import { refuseCredentials, setupCommand } from "../agents/sandbox.ts";
import {
  agentRuns,
  checkItLived,
  endSession,
  hasSession,
  startServer,
  startSession,
} from "../agents/tmux.ts";
import { agentHarness, repositorySetup, threadConfig } from "../config.ts";
import { fetchBranch } from "../github.ts";
import { cloneDir, threadSocket } from "../paths.ts";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { taskOf } from "./copy.ts";
import { pastLimit } from "./decide.ts";
import { findRepository, refreshClones } from "./repo.ts";
import { cloneOf, folderName, fullNameOf, log, readThread, record, Thread } from "./thread.ts";

// Returns what skel start means for a task, given its thread if it has one: bring back a
// stopped thread, let a live one past the round limit go on, or else start a new thread, which
// startThread refuses when the task's thread can't start over. The config is read only for a
// live thread: a bad max_rounds must fail a thread with the reason, not refuse skel start.
export function startChoice(thread: Thread | null): "bring back" | "go on" | "new thread" {
  if (thread?.status === "stopped") return "bring back";
  const live = thread?.status === "working" || thread?.status === "waiting";
  if (thread && live && pastLimit(thread, threadConfig(thread).maxRounds)) return "go on";
  return "new thread";
}

// Returns the status of a stopped thread that skel start brings back. Its builder sits at its
// prompt once back, as its turn ended with the stop. It waits when a round or its PR will wake
// it: a submit or review under way, or the PR's checks, reviews and comments. It works when it
// has a review's changes to be typed in, or no PR yet.
export function statusOnceBack(stopped: Thread): "waiting" | "working" {
  const { pr, submitting, reviewing, telling } = stopped;
  const handed = telling === null && (pr !== null || submitting !== null || reviewing !== null);
  return handed ? "waiting" : "working";
}

// Records a new thread on a task, with its folder and branch, and returns it. The task's title
// comes from skel's copy, which skel start brings up to date first. Refuses a task the copy
// doesn't have, and a task that has a thread already, unless that one failed: then it starts
// over in the same folder. Only records it, since the lead waits on the answer. Setting up its clone and
// starting its builder come after, and can take minutes. `given` is a start request, so its
// `repo` is the repository's name in skel or its full GitHub name.
export async function startThread(
  db: Database,
  given: { repo: string; task: number; from?: string | undefined },
): Promise<Thread> {
  const { owner, repo, name } = findRepository(db, given.repo);
  const { task } = given;
  const { title } = taskOf(db, owner, repo, task);
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
  return db.transaction(() => {
    const where = "WHERE owner = ? AND repo = ? AND task = ?";
    const before = Thread.nullable().parse(
      db.query(`SELECT * FROM threads ${where}`).get(owner, repo, task),
    );
    if (before && before.status !== "failed")
      throw new Error(`${name}-${task} has a thread already`);
    const thread: Thread = {
      owner,
      repo,
      task,
      // A thread that failed starts over in its folder, named when it first started.
      folder: before?.folder ?? freeFolder(`${folderName(name)}-${task}`),
      branch: slug ? `skel/${task}-${slug}` : `skel/${task}`,
      base: given.from ?? null,
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
      last_review: 0,
      last_comment: 0,
      last_check: 0,
      asking: false,
      noting: null,
      title,
      started: Date.now(),
      checks: null,
      reviewer: null,
      reviewed_by: null,
      review_round: null,
      verdict: null,
      review_line: null,
    };
    db.run(`DELETE FROM threads ${where}`, [owner, repo, task]);
    db.run(
      `INSERT INTO threads (owner, repo, task, folder, branch, base, status, session, title,
        started, last_review, last_comment, last_check)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
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

// Returns the branch the thread's PR goes into: the one it started from with --from, or else
// the default branch, which skel's clone is on.
export function baseOf(thread: Thread): string {
  if (thread.base) return thread.base;
  const head = Bun.spawnSync(
    ["git", "-C", cloneDir(thread.owner, thread.repo), "symbolic-ref", "--short", "HEAD"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!head.success) throw new Error(`git symbolic-ref failed: ${head.stderr.toString().trim()}`);
  return head.stdout.toString().trim();
}

// Makes the thread's clone afresh: cloned from skel's clone, on the thread's branch from the
// default branch or the one given with --from, with your name for commits, and the setup
// commands run once in the sandbox. The daemon runs git in the thread's clone only here,
// before anything from the repository has run in it. After that the builder controls
// everything in the folder, .git included.
export async function setUpThread(db: Database, thread: Thread): Promise<void> {
  const clone = cloneOf(thread);
  // skel's clone of the repository can still be on its way, as the daemon refreshes clones as
  // it starts, and its skel.yaml, which sets up the thread, must be the latest pushed. Asking
  // for a refresh joins the one under way.
  await refreshClones(db);
  rmSync(clone, { recursive: true, force: true });
  // From skel's own clone on the same disk, so git links its files rather than copying them.
  await mustRun([
    "git",
    "clone",
    "--quiet",
    "--no-checkout",
    cloneDir(thread.owner, thread.repo),
    clone,
  ]);
  await fetchBranch(clone, fullNameOf(thread), thread.base);
  await mustRun(["git", "-C", clone, "checkout", "--quiet", "-b", thread.branch, "FETCH_HEAD"]);
  // The reviewer reads the diff against origin/<base>, which must be where the branch
  // started. Cloned from skel's clone, the thread's clone has only the default branch there,
  // and as skel's clone last saw it, which can be older.
  await mustRun([
    "git",
    "-C",
    clone,
    "update-ref",
    `refs/remotes/origin/${baseOf(thread)}`,
    "FETCH_HEAD",
  ]);
  // Your git config is hidden from the builder, and its commits are authored by you. Only
  // your global config, since the folder the daemon started in makes no difference.
  for (const key of ["user.name", "user.email"]) {
    const yours = Bun.spawnSync(["git", "config", "--global", "--get", key], { stdout: "pipe" });
    const value = yours.stdout.toString().trim();
    if (yours.success && value) await mustRun(["git", "-C", clone, "config", key, value]);
  }
  refuseCredentials(clone);
  for (const command of repositorySetup(thread)) {
    const { argv, env } = setupCommand(clone, command);
    await mustRun(argv, `the repository's skel.yaml setup command "${command}"`, env);
  }
}

// Starts the thread's builder in tmux, in the sandbox in its clone: with --resume when it
// saved a conversation, or else afresh with the task's title and body from skel's copy as its
// first message. Throws when it exits as soon as it starts. skel picks the session id rather
// than Claude Code, so it is stored before the builder starts and the builder can be brought
// back with --resume after its session is gone.
export async function startBuilder(db: Database, tmux: string, thread: Thread): Promise<void> {
  const clone = cloneOf(thread);
  const stored = thread.session;
  const harness = agentHarness();
  const resume = stored !== null && harness.saved(thread.folder, clone, stored) ? stored : null;
  const session = resume ?? crypto.randomUUID();
  let start: { resume: string } | { sessionId: string; prompt: string } = { resume: session };
  if (!resume) {
    const { title, body } = taskOf(db, thread.owner, thread.repo, thread.task);
    start = { sessionId: session, prompt: body ? `${title}\n\n${body}` : title };
  }
  record(db, thread.folder, { session });
  const { argv, env } = harness.start({
    name: thread.folder,
    socket: threadSocket(thread.folder),
    model: threadConfig(thread).builder.model,
    thread: clone,
    // Gone once you remove the repository from skel, and bwrap can't mount what is missing.
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
  startServer(tmux);
  startSession(tmux, thread.folder, { folder: clone, command: argv, env });
  console.log(`${resume ? "Brought back" : "Started"} the builder of ${thread.folder}.`);
  await checkItLived(tmux, thread.folder, "builder");
}

// Brings back a thread's builder after the daemon restarts, or after skel stop for skel
// start: leaves one that runs alone, and starts again one whose session is gone or ended.
// Throws for a thread with no session, which never got past its setup because the daemon
// stopped, so it can be started again.
export async function bringBack(db: Database, tmux: string, thread: Thread): Promise<void> {
  if (thread.session === null)
    throw new Error("the daemon stopped while setting up the thread: run skel start again");
  if (agentRuns(tmux, thread.folder)) return;
  if (hasSession(tmux, thread.folder)) endSession(tmux, thread.folder);
  await startBuilder(db, tmux, thread);
}

// Marks the thread failed and logs why, in its log and the daemon's, so you can see what
// stopped it and start it again. A thread that skel stop stopped, or that its PR's merge or
// close ended, meanwhile stays as it is: its builder ended because of that, such as within
// the moment skel watches it start.
export function failThread(db: Database, thread: Thread, error: unknown): void {
  const why = errorText(error);
  const { status } = readThread(db, thread.folder);
  if (status === "stopped" || status === "done") {
    console.log(`${thread.folder} stays ${status}: ${why}`);
    return;
  }
  record(db, thread.folder, { status: "failed" }, why);
  console.log(`${thread.folder} failed: ${why}`);
}
