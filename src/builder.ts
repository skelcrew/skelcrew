// Starting work on a thread: recording it, setting up its clone, starting its builder or
// bringing it back, and marking the thread failed when any of that goes wrong.
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { agentCommand, hasTranscript } from "./claude.ts";
import { threadConfig } from "./config.ts";
import { fetchBranch, readIssue } from "./github.ts";
import { cloneDir, threadSocket } from "./paths.ts";
import instructions from "./prompts/builder.md" with { type: "text" };
import { findRepository, refreshClones } from "./repo.ts";
import { refuseCredentials, setupCommand } from "./sandbox.ts";
import { errorText } from "./say.ts";
import { cloneOf, folderName, github, log, readThread, record, Thread } from "./thread.ts";
import {
  agentRuns,
  checkItLived,
  endSession,
  hasSession,
  startServer,
  startSession,
} from "./tmux.ts";

// Records a new thread on a task, with its folder and branch, and returns it. Refuses a
// task that has a thread already, unless that one failed: then it starts over in the same
// folder. Only records it, since the lead waits on the answer. Setting up its clone and
// starting its builder come after, and can take minutes.
export async function startThread(
  db: Database,
  given: { repo: string; task: number; from?: string | undefined },
): Promise<Thread> {
  const { owner, repo, name } = findRepository(db, given.repo);
  const { task } = given;
  const { title } = await readIssue(`${owner}/${repo}`, task);
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
async function run(
  argv: string[],
  doing = argv.join(" "),
  env: Record<string, string | undefined> = process.env,
) {
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${doing} failed: ${(out + err).trim().slice(-2000)}`);
}

const SkelYaml = z.looseObject({ setup: z.array(z.string()).optional() }).nullable();

// Returns the setup commands in the clone's skel.yaml, or none when it has no skel.yaml.
// Throws when skel.yaml isn't valid, so the thread fails with the reason.
function setupCommands(clone: string): string[] {
  const file = join(clone, "skel.yaml");
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return [];
  // skel reads it with your rights, so a link could show it any file of yours.
  if (!stat.isFile()) throw new Error("skel.yaml isn't a plain file, so skel won't read it");
  const read = SkelYaml.safeParse(parse(readFileSync(file, "utf8")));
  if (!read.success) throw new Error(`skel.yaml isn't valid: ${z.prettifyError(read.error)}`);
  return read.data?.setup ?? [];
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
  // skel's clone of the repository can still be on its way, as the daemon makes it once it
  // has started the lead. Asking for a refresh joins the one under way.
  if (!existsSync(cloneDir(thread.owner, thread.repo))) await refreshClones(db);
  rmSync(clone, { recursive: true, force: true });
  // From skel's own clone on the same disk, so git links its files rather than copying them.
  await run([
    "git",
    "clone",
    "--quiet",
    "--no-checkout",
    cloneDir(thread.owner, thread.repo),
    clone,
  ]);
  await fetchBranch(clone, github(thread), thread.base);
  await run(["git", "-C", clone, "checkout", "--quiet", "-b", thread.branch, "FETCH_HEAD"]);
  // The reviewer reads the diff against origin/<base>, which must be where the branch
  // started. Cloned from skel's clone, the thread's clone has only the default branch there,
  // and as skel's clone last saw it, which can be older.
  await run([
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
    if (yours.success && value) await run(["git", "-C", clone, "config", key, value]);
  }
  refuseCredentials(clone);
  for (const command of setupCommands(clone)) {
    const { argv, env } = setupCommand(clone, command);
    await run(argv, `skel.yaml's setup command "${command}"`, env);
  }
}

// Starts the thread's builder in tmux, in the sandbox in its clone: with --resume when it
// saved a conversation, or else afresh with the task's title and body as its first message.
// Throws when it exits as soon as it starts. skel picks the session id rather than Claude
// Code, so it is stored before the builder starts and the builder can be brought back with
// --resume after its session is gone.
export async function startBuilder(db: Database, tmux: string, thread: Thread): Promise<void> {
  const clone = cloneOf(thread);
  const stored = thread.session;
  const resume = stored !== null && hasTranscript(thread.folder, clone, stored) ? stored : null;
  const session = resume ?? crypto.randomUUID();
  let start: { resume: string } | { sessionId: string; prompt: string } = { resume: session };
  if (!resume) {
    const { title, body } = await readIssue(github(thread), thread.task);
    start = { sessionId: session, prompt: body ? `${title}\n\n${body}` : title };
  }
  record(db, thread.folder, { session });
  const { argv, env } = agentCommand({
    name: thread.folder,
    socket: threadSocket(thread.folder),
    model: threadConfig().model,
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
