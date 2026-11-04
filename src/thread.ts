// Threads: the work on one issue, in a clone and branch of its own, with a builder working in
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
  issue: z.number(),
  folder: z.string(),
  branch: z.string(),
  base: z.string().nullable(),
  status: z.enum(["working", "waiting", "failed", "done"]),
  session: z.string().nullable(),
});
export type Thread = z.infer<typeof Thread>;

const github = (thread: Thread) => `${thread.owner}/${thread.repo}`;
const cloneOf = (thread: Thread) => join(threadsDir(), thread.folder);

// Each change is also a line in the thread's log, the whole thread as it now is, so its
// history can be read and replayed.
function log(thread: Thread, why?: string): void {
  mkdirSync(threadsDir(), { recursive: true });
  const line = { at: new Date().toISOString(), ...thread, ...(why ? { why } : {}) };
  appendFileSync(join(threadsDir(), `${thread.folder}.log`), `${JSON.stringify(line)}\n`);
}

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

// Named by the repository's name now, which can gain its owner since the thread started.
export function threadName(db: Database, thread: Thread): string {
  const row = db
    .query("SELECT name FROM repositories WHERE owner = ? AND repo = ?")
    .get(thread.owner, thread.repo);
  const name = z.object({ name: z.string() }).nullable().parse(row)?.name ?? github(thread);
  return `${name}#${thread.issue}`;
}

export function liveThreads(db: Database): Thread[] {
  return db
    .query("SELECT * FROM threads WHERE status IN ('working', 'waiting')")
    .all()
    .map((row) => Thread.parse(row));
}

// Only records the thread, since the lead waits on it. Setting up its clone and starting its
// builder come after, and can take minutes.
export async function startThread(
  db: Database,
  given: { repo: string; issue: number; from?: string | undefined },
): Promise<Thread> {
  const { owner, repo, name } = findRepository(db, given.repo);
  const { issue } = given;
  const { title } = await readIssue(`${owner}/${repo}`, issue);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-|-$/g, "");
  // Different names can make the same folder, such as simon/app and simon-app.
  const freeFolder = (folder: string) => {
    const taken = (f: string) => db.query("SELECT 1 FROM threads WHERE folder = ?").get(f);
    let free = folder;
    for (let n = 2; taken(free); n++) free = `${folder}-${n}`;
    return free;
  };
  return db.transaction(() => {
    const where = "WHERE owner = ? AND repo = ? AND issue = ?";
    const before = Thread.nullable().parse(
      db.query(`SELECT * FROM threads ${where}`).get(owner, repo, issue),
    );
    if (before && before.status !== "failed")
      throw new Error(`${name}#${issue} has a thread already`);
    const thread: Thread = {
      owner,
      repo,
      issue,
      // A thread that failed starts over in its folder, named when it first started. tmux
      // changes . and : in a session's name, and / would make a folder.
      folder: before?.folder ?? freeFolder(`${name}-${issue}`.replace(/[^\w-]/g, "-")),
      branch: slug ? `skel/${issue}-${slug}` : `skel/${issue}`,
      base: given.from ?? null,
      status: "working",
      session: null,
    };
    db.run(`DELETE FROM threads ${where}`, [owner, repo, issue]);
    db.run(
      `INSERT INTO threads (owner, repo, issue, folder, branch, base, status, session)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner, repo, issue, thread.folder, thread.branch, thread.base, thread.status, null],
    );
    log(thread);
    return thread;
  })();
}

// `doing` says what failed, since a sandboxed command's own words are mostly bwrap's.
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

// The daemon runs git in the thread's clone only here, before anything from the repository
// has run in it. After that the builder controls everything in the folder, .git included.
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

function builderModel(): string {
  const file = join(configDir(), "config.yaml");
  if (!existsSync(file)) return "opus";
  const read = Config.safeParse(parse(readFileSync(file, "utf8")) ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return read.data.builder?.model ?? "opus";
}

// skel picks the session id rather than Claude Code, so it is stored before the builder
// starts and the builder can be brought back with --resume after its session is gone. A
// builder whose conversation was never saved starts again from the issue.
export async function startBuilder(db: Database, tmux: string, thread: Thread): Promise<void> {
  const clone = cloneOf(thread);
  const stored = thread.session;
  const resume = stored !== null && hasTranscript(thread.folder, clone, stored) ? stored : null;
  const session = resume ?? crypto.randomUUID();
  let start: { resume: string } | { sessionId: string; prompt: string } = { resume: session };
  if (!resume) {
    const { title, body } = await readIssue(github(thread), thread.issue);
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

// A thread with no session never got past its setup, which the daemon stopping cut short.
export async function bringBack(db: Database, tmux: string, thread: Thread): Promise<void> {
  if (thread.session === null)
    throw new Error("skel's daemon stopped while setting up the thread: run skel start again");
  if (hasSession(tmux, thread.folder)) {
    if (failedScreen(tmux, thread.folder) === null) return;
    endSession(tmux, thread.folder);
  }
  await startBuilder(db, tmux, thread);
}

export function failThread(db: Database, thread: Thread, error: unknown): void {
  const why = error instanceof Error ? error.message : String(error);
  record(db, thread.folder, { status: "failed" }, why);
  console.log(`${thread.folder} failed: ${why}`);
}
