// Threads: the work on one task, in a clone and branch of its own, with a builder working in
// it. Starting one, setting up its clone, starting or bringing back its builder.
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { agentCommand, hasTranscript } from "./claude.ts";
import { fetchBranch, readIssue } from "./github.ts";
import { cloneDir, configDir, threadSocket, threadsDir } from "./paths.ts";
import instructions from "./prompts/builder.md" with { type: "text" };
import { findRepository, refreshClones } from "./repo.ts";
import { refuseCredentials, setupCommand } from "./sandbox.ts";
import { errorText } from "./say.ts";
import { endSession, failedScreen, hasSession, startServer, startSession } from "./tmux.ts";

export const Thread = z.object({
  owner: z.string(),
  repo: z.string(),
  task: z.number(),
  folder: z.string(),
  branch: z.string(),
  base: z.string().nullable(),
  status: z.enum(["working", "waiting", "failed", "stopped", "done"]),
  session: z.string().nullable(),
  // Rounds whose review asked for changes, counted against max_rounds.
  rounds: z.number(),
  pr: z.number().nullable(),
  needs_you: z.coerce.boolean(),
  // The summary of a submit not yet pushed and reviewed.
  submitting: z.string().nullable(),
  // The commit whose skel/review check is pending, while its review waits or runs.
  reviewing: z.string().nullable(),
  // A posted review's changes, until they are typed into the builder.
  telling: z.string().nullable(),
  // The changes of a review past the round limit, which aren't typed in, kept for when you
  // let the thread go on with skel start.
  held: z.string().nullable(),
  // The ID of the last review, PR comment and check run handled, so each event is handled
  // once, across restarts too. Null until the PR is first polled, for threads an older skel
  // started: that poll starts after the PR's history rather than replaying it.
  last_review: z.number().nullable(),
  last_comment: z.number().nullable(),
  last_check: z.number().nullable(),
  // Whether the builder is asking you a question with AskUserQuestion. Kept apart from
  // needs_you, so answering it leaves the thread needing you for any other reason.
  asking: z.coerce.boolean(),
  // Why the thread started needing you, until a note saying so is typed into the lead.
  noting: z.string().nullable(),
  // The task's title when the thread started, for the strip, which looks each second and so
  // can't ask GitHub. Null on a thread an older skel started.
  title: z.string().nullable(),
  // When the thread started, in milliseconds since 1970, for its running time in the sidebar.
  // Null on a thread an older skel started.
  started: z.number().nullable(),
  // What the PR's CI says, without skel's own review check, as last polled. Null with no CI,
  // or while the commit it would be about is still on its way to GitHub.
  checks: z.enum(["passing", "failing", "pending"]).nullable(),
  // The harness of the review waiting or running, which can differ from the latest finished
  // one's once you change your config.
  reviewer: z.enum(["codex", "claude"]).nullable(),
  // The latest finished review: its round, reviewer, verdict and the first line of what it said.
  // Each one is saved here, so it reaches the thread's log with the rest of the thread.
  reviewed_by: z.enum(["codex", "claude"]).nullable(),
  review_round: z.number().nullable(),
  verdict: z.enum(["approve", "changes", "failed"]).nullable(),
  review_line: z.string().nullable(),
});
export type Thread = z.infer<typeof Thread>;

// Returns whether the thread needs you: for a review, the round limit or an approval, or for
// the builder's question.
export const needsYou = (thread: Thread) => thread.needs_you || thread.asking;

// Returns whether any thread has work under way that the machine must stay awake for: a
// builder working, a review waiting or running, or a PR waiting on CI. A thread that only
// waits on you is no work, and a builder working on your comment past the round limit is.
// A round that failed keeps its submit or review saved, to carry on after a restart, so those
// don't count as work on a thread that needs you.
export const hasWork = (threads: Thread[]) =>
  threads.some(
    (t) => (t.status === "working" && !t.asking) || (t.status === "waiting" && !needsYou(t)),
  );

// Returns the thread's repository as owner/name, as GitHub calls want it.
export const github = (thread: Thread) => `${thread.owner}/${thread.repo}`;
// Returns the thread's clone folder. It comes from the folder name chosen at start, so it
// stays put when the repository's name changes.
export const cloneOf = (thread: Thread) => join(threadsDir(), thread.folder);

// Appends the whole thread as it now is, with the reason when there is one, as a line to
// its log. Every change goes there too, so the thread's history can be read and replayed.
function log(thread: Thread, why?: string): void {
  mkdirSync(threadsDir(), { recursive: true });
  const line = { at: new Date().toISOString(), ...thread, ...(why ? { why } : {}) };
  appendFileSync(join(threadsDir(), `${thread.folder}.log`), `${JSON.stringify(line)}\n`);
}

// Returns the thread in the given folder as it is now in the database.
export const readThread = (db: Database, folder: string) =>
  Thread.parse(db.query("SELECT * FROM threads WHERE folder = ?").get(folder));

// Saves a change to the thread, logs the thread as it now is, and returns it. `why` goes in
// the log, so a failure says what went wrong. When the change makes the thread start needing
// you, `why` is also saved as the note for the lead, on one line; once it no longer needs you,
// a note not yet typed is dropped. The daemon types saved notes with tellLead.
export function record(
  db: Database,
  folder: string,
  change: Partial<
    Omit<Thread, "owner" | "repo" | "task" | "folder" | "branch" | "base" | "title" | "started">
  >,
  why?: string,
): Thread {
  const before = readThread(db, folder);
  let { noting } = change;
  if (!needsYou({ ...before, ...change })) noting = null;
  else if (!needsYou(before)) noting = (why ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  // The column names come from the keys of Thread above, never from outside. One statement,
  // so a change is saved whole or not at all.
  const full = noting === undefined ? change : { ...change, noting };
  const set = Object.entries(full).filter(([, value]) => value !== undefined);
  if (set.length > 0)
    db.run(
      `UPDATE threads SET ${set.map(([column]) => `${column} = ?`).join(", ")} WHERE folder = ?`,
      [...set.map(([, value]) => value), folder],
    );
  const thread = readThread(db, folder);
  log(thread, why);
  return thread;
}

// Returns the thread's name, such as app-12, for replies. It uses the repository's name
// now, which can gain its owner since the thread started, or owner/name once skel no longer
// has the repository.
export function threadName(db: Database, thread: Thread): string {
  const row = db
    .query("SELECT name FROM repositories WHERE owner = ? AND repo = ?")
    .get(thread.owner, thread.repo);
  const name = z.object({ name: z.string() }).nullable().parse(row)?.name ?? github(thread);
  return `${name}-${thread.task}`;
}

// Returns the thread named repo-task, such as app-12, or null when the task has none. Throws
// when skel doesn't have the repository.
export function threadOn(db: Database, repo: string, task: number): Thread | null {
  const { owner, repo: name } = findRepository(db, repo);
  return Thread.nullable().parse(
    db
      .query("SELECT * FROM threads WHERE owner = ? AND repo = ? AND task = ?")
      .get(owner, name, task),
  );
}

// Returns the thread named repo-task, such as app-12, and throws when there is none.
export function findThread(db: Database, repo: string, task: number): Thread {
  const thread = threadOn(db, repo, task);
  if (!thread) throw new Error(`there is no thread ${repo}-${task}`);
  return thread;
}

// Returns the threads that are working or waiting, whose builders the daemon brings back
// and whose sockets it opens again when it starts.
export function liveThreads(db: Database): Thread[] {
  return db
    .query("SELECT * FROM threads WHERE status IN ('working', 'waiting')")
    .all()
    .map((row) => Thread.parse(row));
}

// Returns the start of a thread's folder name, made from its repository's name. The builder's
// config folder and session are named after it too, so it starts with a letter or digit, as
// they must. tmux changes . and : in a session's name, and / would make a folder. It stays
// short: Claude Code hashes the name of the folder it saves a conversation in once the path
// passes 200 characters, and skel would then miss it when bringing the builder back.
function folderName(repository: string): string {
  const name = repository
    .replace(/[^\w-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 60);
  return name || "thread";
}

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

const Config = z.looseObject({
  builder: z.looseObject({ model: z.string().min(1).optional() }).optional(),
  reviewer: z.looseObject({ harness: z.enum(["codex", "claude"]).optional() }).optional(),
  max_rounds: z.number().int().positive().optional(),
});

// Returns what your config sets for threads: the builder's model (opus when it names none),
// the reviewer's harness (none when it names none, so the reviewer picks), and the round
// limit (3 when it names none). Throws when the config isn't valid, rather than run a thread
// on settings you didn't pick.
export function threadConfig(): {
  model: string;
  reviewer: "codex" | "claude" | undefined;
  maxRounds: number;
} {
  const file = join(configDir(), "config.yaml");
  const read = Config.safeParse(existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  const { builder, reviewer, max_rounds } = read.data;
  return {
    model: builder?.model ?? "opus",
    reviewer: reviewer?.harness,
    maxRounds: max_rounds ?? 3,
  };
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
  // A builder that can't start, such as one whose login is gone, ends within moments.
  await Bun.sleep(1000);
  const failed = failedScreen(tmux, thread.folder);
  if (failed !== null) endSession(tmux, thread.folder);
  if (failed !== null || !hasSession(tmux, thread.folder))
    throw new Error(`the builder exited as soon as it started:\n${failed ?? ""}`);
}

// Brings back a thread's builder after the daemon restarts, or after skel stop for skel
// start: leaves one that runs alone, and starts again one whose session is gone or ended.
// Throws for a thread with no session, which never got past its setup because the daemon
// stopped, so it can be started again.
export async function bringBack(db: Database, tmux: string, thread: Thread): Promise<void> {
  if (thread.session === null)
    throw new Error("the daemon stopped while setting up the thread: run skel start again");
  if (hasSession(tmux, thread.folder)) {
    if (failedScreen(tmux, thread.folder) === null) return;
    endSession(tmux, thread.folder);
  }
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
