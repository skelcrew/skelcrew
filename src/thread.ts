// Threads: the work on one task, in a clone and branch of its own, with a builder working in
// it. Starting one, setting up its clone, starting or bringing back its builder.
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { fetchBranch, readIssue } from "./github.ts";
import { cloneDir, configDir, threadSocket, threadsDir } from "./paths.ts";
import { findRepository, refreshClones } from "./repo.ts";
import { agentCommand, hasTranscript, refuseCredentials, setupCommand } from "./sandbox.ts";
import { endSession, failedScreen, hasSession, startServer, startSession } from "./tmux.ts";

export const Thread = z.object({
  owner: z.string(),
  repo: z.string(),
  task: z.number(),
  folder: z.string(),
  branch: z.string(),
  base: z.string().nullable(),
  status: z.enum(["working", "waiting", "failed", "done"]),
  session: z.string().nullable(),
});
export type Thread = z.infer<typeof Thread>;

// Returns the thread's repository as owner/name, as GitHub calls want it.
const github = (thread: Thread) => `${thread.owner}/${thread.repo}`;
// Returns the thread's clone folder. It comes from the folder name chosen at start, so it
// stays put when the repository's name changes.
const cloneOf = (thread: Thread) => join(threadsDir(), thread.folder);

// Appends the whole thread as it now is, with the reason when there is one, as a line to
// its log. Every change goes there too, so the thread's history can be read and replayed.
function log(thread: Thread, why?: string): void {
  mkdirSync(threadsDir(), { recursive: true });
  const line = { at: new Date().toISOString(), ...thread, ...(why ? { why } : {}) };
  appendFileSync(join(threadsDir(), `${thread.folder}.log`), `${JSON.stringify(line)}\n`);
}

// Saves a change to the thread's status or session, logs the thread as it now is, and
// returns it. `why` goes in the log, so a failure says what went wrong.
function record(
  db: Database,
  folder: string,
  change: { status?: Thread["status"]; session?: string },
  why?: string,
): Thread {
  if (change.status)
    db.run("UPDATE threads SET status = ? WHERE folder = ?", [change.status, folder]);
  if (change.session)
    db.run("UPDATE threads SET session = ? WHERE folder = ?", [change.session, folder]);
  const thread = Thread.parse(db.query("SELECT * FROM threads WHERE folder = ?").get(folder));
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
    };
    db.run(`DELETE FROM threads ${where}`, [owner, repo, task]);
    db.run(
      `INSERT INTO threads (owner, repo, task, folder, branch, base, status, session)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner, repo, task, thread.folder, thread.branch, thread.base, thread.status, null],
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
});

// Returns the builder's model from your config's builder.model, or opus when it names none.
// Throws when the config isn't valid, rather than start a builder on a model you didn't pick.
function builderModel(): string {
  const file = join(configDir(), "config.yaml");
  if (!existsSync(file)) return "opus";
  const read = Config.safeParse(parse(readFileSync(file, "utf8")) ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return read.data.builder?.model ?? "opus";
}

// Starts the thread's builder in tmux, in the sandbox in its clone: with --resume when it
// saved a conversation, or else afresh with the task's title and body as its first message. Throws when it
// exits as soon as it starts. skel picks the session id rather than Claude Code, so it is
// stored before the builder starts and the builder can be brought back with --resume after
// its session is gone.
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
    model: builderModel(),
    thread: clone,
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

// Brings back a thread's builder after the daemon restarts: leaves one that runs alone, and
// starts again one whose session is gone or ended. Throws for a thread with no session,
// which never got past its setup because the daemon stopped, so it can be started again.
export async function bringBack(db: Database, tmux: string, thread: Thread): Promise<void> {
  if (thread.session === null)
    throw new Error("skel's daemon stopped while setting up the thread: run skel start again");
  if (hasSession(tmux, thread.folder)) {
    if (failedScreen(tmux, thread.folder) === null) return;
    endSession(tmux, thread.folder);
  }
  await startBuilder(db, tmux, thread);
}

// Marks the thread failed and logs why, in its log and the daemon's, so you can see what
// stopped it and start it again.
export function failThread(db: Database, thread: Thread, error: unknown): void {
  const why = error instanceof Error ? error.message : String(error);
  record(db, thread.folder, { status: "failed" }, why);
  console.log(`${thread.folder} failed: ${why}`);
}
