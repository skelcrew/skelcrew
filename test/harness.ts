// What Skelcrew's tests share: finding Skelcrew's source files, waiting, and running sc and its
// daemon as a user would. Each test file keeps its own home folder and tmux socket and hands
// them in, so a test that outlives its file can never reach another file's home.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Subprocess } from "bun";
import { taskColumns } from "../src/db.ts";

// Returns the path of a file in src/, or of src/ itself, for a test that runs sc or hands
// its code to a process of its own.
export const source = (file = "") => join(import.meta.dir, "..", "src", file);

// Waits until `done` holds, for what a daemon or a session does in its own time, looking every
// `every` milliseconds. `done` may answer later, as asking a session host does. Past `timeout` it throws, naming `what` if given. `what` is a function
// so a test can show what is on screen at that moment, and pays for that only on failure.
// The limit is generous, as a busy machine can take many seconds to start a daemon or a
// sandbox. It only ends a wait that would never end.
export async function until(
  done: () => boolean | Promise<boolean>,
  options: { timeout?: number; every?: number; what?: () => string } = {},
): Promise<void> {
  const { timeout = 30_000, every = 50, what } = options;
  const deadline = Date.now() + timeout;
  while (!(await done())) {
    if (Date.now() > deadline)
      throw new Error(what ? `gave up waiting for ${what()}` : "gave up waiting");
    await Bun.sleep(every);
  }
}

// Returns the environment for a process of a test with this home. Skelcrew, its daemon and what
// they start find their state, their socket and the test's fake programs through it, and so
// never reach the real ones. The temporary folders the test was given pass through: inside
// Skelcrew's sandbox on a Mac /tmp is hidden, and tmux and temporary files must go elsewhere.
// Routine notes go into a lead as they come, rather than in a digest every 10 minutes, so a test
// waiting on one isn't held for the next digest. The digest has tests of its own.
export function homeEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {
    SKELCREW_DIGEST_MS: "0",
    HOME: home,
    XDG_RUNTIME_DIR: join(home, "run"),
    PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
  };
  for (const name of ["TMPDIR", "TMUX_TMPDIR"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

// Quotes a word for sh.
const quoteForSh = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

// Runs a program with a terminal as its input, as you run sc at yours, and types `typed` into
// it, then Ctrl-D, which ends the input. Skelcrew asks before installing a plugin only at a
// terminal, so a test that answers yes needs one. Bun gives the program the terminal, on Linux and
// macOS alike. The program's output goes to files through sh rather than to the terminal, so it
// reads as from a pipe, and the terminal's echo of what was typed stays out of it.
export async function inTerminal(
  argv: string[],
  options: { typed: string; env: Record<string, string>; cwd: string },
): Promise<{ out: string; err: string; code: number }> {
  const folder = mkdtempSync(join(tmpdir(), "skelcrew-terminal-"));
  const [out, err] = [join(folder, "out"), join(folder, "err")];
  try {
    const command = `exec ${argv.map(quoteForSh).join(" ")} >${quoteForSh(out)} 2>${quoteForSh(err)}`;
    // The terminal's own output is only the echo, read and dropped so it never fills up.
    const run = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: options.cwd,
      env: options.env,
      terminal: { cols: 120, rows: 40, data() {} },
    });
    run.terminal?.write(`${options.typed}\x04`);
    const code = await run.exited;
    run.terminal?.close();
    return { out: read(out), err: read(err), code };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Returns what a file holds, or nothing before it exists, for a test watching a file appear.
export const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

// Writes a shell script into the home's bin folder, where it stands in for a real program.
export function writeScript(home: string, name: string, body: string): void {
  writeFileSync(join(home, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// Runs git in a folder as a test's own user and returns what it printed, without the line end.
// A failure throws what git said, so a test's setup can't quietly go wrong.
export function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

// Claims task numbers 1 to `last` in a repository's bare remote, as tasks before would
// have, so the next task takes the number after. A test whose task starts on issue #12 then has
// task APP-12 too, which keeps its folders and names short to read.
export function numberedBefore(bare: string, last: number): void {
  const tree = git(bare, "hash-object", "-t", "tree", "-w", "/dev/null");
  const claim = git(bare, "commit-tree", tree, "-m", "Skelcrew claims tasks before");
  for (let n = 1; n <= last; n++) git(bare, "update-ref", `refs/skelcrew/names/t${n}`, claim);
}

// Returns where a path really leads, even before the file is there: a daemon makes its socket
// only once it starts. It goes one name at a time, as the system does, so a link is followed
// before a `..` after it: `link/..` is the folder above where the link leads, not the link's own.
function realPath(path: string): string {
  let real = "/";
  // Not resolve() or join(): both drop a `..` with the name before it.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  for (const name of absolute.split("/")) {
    if (name === "..") real = dirname(real);
    else if (name && name !== ".") {
      const next = join(real, name);
      real = existsSync(next) ? realpathSync(next) : next;
    }
  }
  return real;
}

// Throws unless this socket is in the test's own folder: the one in the temporary folder that
// holds the environment's HOME. A socket elsewhere, an agent's, another test's or a real one,
// would reach a daemon not the test's own.
function mustBeTestSocket(given: string, env: Record<string, string>): void {
  const socket = realPath(given);
  // An agent's sc gets a home of its own inside the test's folder, so the test's folder is
  // the first one under the temporary folder, not HOME itself.
  const temporary = realPath(tmpdir());
  const home = realPath(env.HOME ?? "/");
  const [own] = relative(temporary, home).split(sep);
  const folder = own && own !== ".." && !isAbsolute(own) ? join(temporary, own) : "";
  if (!folder || !socket.startsWith(`${folder}/`))
    throw new Error(`a test's Skelcrew must use a socket of its own, not one outside: ${given}`);
}

// Returns the socket the daemon listens on with this environment. It goes by XDG_RUNTIME_DIR
// alone, as SKELCREW_SOCKET only tells sc where to call. Without it, the daemon would take
// /run/user.
const daemonSocketIn = (env: Record<string, string>) =>
  env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "skelcrew.sock") : "/run/user";
// Returns the socket sc calls with this environment: an agent's own, or else the daemon's.
const scSocketIn = (env: Record<string, string>) => env.SKELCREW_SOCKET || daemonSocketIn(env);

// Starts a daemon on a test's tmux socket and adds it to `running` for the test to stop. It
// takes a process of its own, as homedir() keeps the HOME this process started with, so a
// daemon here would open your real database. `every` is how often it polls the forge, in
// milliseconds, for a test that waits on what the forge shows, rather than every 30 seconds.
export function startDaemon(
  socket: string,
  env: Record<string, string>,
  running: Subprocess[],
  every?: number,
): Subprocess {
  mustBeTestSocket(daemonSocketIn(env), env);
  const polls = every === undefined ? "" : `, ${every}`;
  const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)}${polls});`;
  // Reviews start at once on a repository without CI, unless the test asks for the wait. What
  // the daemon logs goes to daemon.log in the test's home.
  const run = Bun.spawn([process.execPath, "-e", code], {
    env: { SKELCREW_CHECK_WAIT_MS: "0", ...env },
    stdout: env.HOME ? Bun.file(join(env.HOME, "daemon.log")) : "ignore",
    stderr: "ignore",
  });
  running.push(run);
  return run;
}

// Runs sc with these arguments and environment, and gives back what it printed and its code.
// `input`, when given, is what sc reads on stdin, as from a file or a heredoc.
export async function runSkel(args: string[], env: Record<string, string>, input?: string) {
  mustBeTestSocket(scSocketIn(env), env);
  const run = Bun.spawn([process.execPath, source("main.ts"), ...args], {
    env,
    ...(input === undefined ? {} : { stdin: Buffer.from(input) }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { out, err, code };
}

// Kills the process group of each session the fake host with these settings keeps, for a
// test's clean-up, as those sessions outlive the daemon that started them. So do the host's
// calls, so one can still be starting a session: the calls end first. A session without a
// process ID is skipped, as its host died before starting it. Its ID would read as 0, and
// killing group 0 kills the caller's own group: in a parallel run, the whole test worker,
// which Bun then reports as crashed with SIGKILL.
export async function endFakeSessions(settings: string): Promise<void> {
  // The calls still running, by the IDs they noted. A call that ended took its note away. One
  // that was killed left it, so its process is looked for too. A call notes itself only once
  // Bun has started it, so the calls not yet noted are found too, by the settings folder in
  // their command.
  const calls = join(settings, "running-calls");
  const running = () =>
    living([
      ...(existsSync(calls) ? readdirSync(calls) : []).map(Number),
      ...hostCallsOf(settings),
    ]);
  // A start takes a moment. A call a test holds on purpose gets five seconds, then is killed
  // with its group: a held call hasn't started anything yet.
  const deadline = Date.now() + 5000;
  while (running().length > 0 && Date.now() < deadline) await Bun.sleep(50);
  for (const pid of running())
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  // A kill takes a moment, and a call still running could start a session after the sessions
  // are looked at. So they are looked at only once the calls have ended.
  const killed = Date.now() + 5000;
  while (running().length > 0 && Date.now() < killed) await Bun.sleep(20);
  if (running().length > 0) throw new Error(`the fake host's calls in ${settings} didn't end`);
  const sessions = join(settings, "sessions");
  for (const id of existsSync(sessions) ? readdirSync(sessions) : []) {
    const pid = Number(read(join(sessions, id, "pid")));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
}

// Returns those of these process IDs that still run. A process that ended but wasn't reaped,
// a zombie, runs nothing, though a signal still reaches it: the test run takes in the processes
// a daemon left and reaps them only when it ends.
function living(pids: number[]): number[] {
  const states = new Map(
    Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "stat="])
      .stdout.toString()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .map(([pid, state]) => [Number(pid), state ?? ""]),
  );
  return pids.filter((pid) => pid > 0 && !(states.get(pid) ?? "Z").startsWith("Z"));
}

// The command a runtime plugin's manifest gives to run the fake host with these settings. The
// settings folder, the test's own, goes as an argument the host ignores, so a test's clean-up
// can find its calls with ps, on Linux and macOS alike, even before a call has noted itself.
export const fakeHostCommand = (settings: string) => [
  "bun",
  join(import.meta.dir, "fake-host.ts"),
  settings,
];

// Returns the IDs of the fake host's calls running with these settings, noted or not, as
// fakeHostCommand starts them. A session the host started runs another command, so it never
// counts.
function hostCallsOf(settings: string): number[] {
  const listed = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=", "-o", "args="]);
  const call = `${fakeHostCommand(settings).slice(1).join(" ")}`;
  return listed.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(call))
    .map((line) => Number(line.split(/\s+/)[0]));
}

// Installs the fake tracker and forge as a plugin named `name`, doing `jobs`, for a test with
// this home, and returns its settings folder, where it keeps the questions it is asked and
// reads its answers. Its git_credentials lend nothing, as the tests' remotes are folders. With
// the job notifier, it is a notifier, which keeps each message it is handed the same way.
export function fakePlugin(
  home: string,
  name = "github",
  jobs: string[] = ["tracker", "forge"],
): string {
  const folder = join(home, `plugin-${name}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "skelcrew-plugin.yaml"),
    `name: ${name}
version: 0.1.0
skelcrew: 0.1.0
about: A tracker and forge for tests
${jobs.includes("notifier") ? "kind: io\nprovides: [notifier]" : `jobs: [${jobs.join(", ")}]`}
call: [bun, ${JSON.stringify(join(import.meta.dir, "fake-plugin.ts"))}]
git_credentials: ["true"]
`,
  );
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO plugins (name, folder) VALUES (?, ?)", [${JSON.stringify(name)}, ${JSON.stringify(folder)}]);`;
  const added = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, ...homeEnv(home) },
    stderr: "pipe",
  });
  if (!added.success) throw new Error(added.stderr.toString());
  const settings = join(home, ".config", "skelcrew", "plugins", name);
  mkdirSync(settings, { recursive: true });
  return settings;
}

// Has the fake plugin give this answer to a question from now on, such as the items of
// "changed".
export function answer(settings: string, ask: string, value: unknown): void {
  writeFileSync(join(settings, `${ask.replaceAll(" ", "-")}.json`), JSON.stringify(value));
}

// Returns the questions the fake plugin was asked, oldest first.
export function asked(settings: string): Record<string, unknown>[] {
  return read(join(settings, "asked"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Returns an open task as a tracker answers it, unlabeled unless given.
export function taskItem(id: string, title: string, more: object = {}): object {
  return {
    kind: "task",
    id,
    title,
    body: "",
    state: "open",
    author: { login: "simon", bot: false, you: true, push: true },
    labels: [],
    link: `https://github.com/simon/app/issues/${id}`,
    created: "2026-11-05T10:00:00Z",
    updated: "2026-11-05T10:00:00Z",
    closes: `Closes #${id}`,
    ref: `#${id}`,
    ...more,
  };
}

// Returns an open PR as a forge answers it, with no reviews, comments or checks unless given.
export function prItem(id: string, title: string, more: object = {}): object {
  return {
    kind: "pr",
    id,
    title,
    body: "",
    state: "open",
    author: { login: "skelcrew[bot]", bot: true, you: false, push: false },
    labels: [],
    link: `https://github.com/simon/app/pull/${id}`,
    created: "2026-11-05T10:00:00Z",
    updated: "2026-11-05T10:00:00Z",
    branch: `skelcrew/${id}`,
    base: "main",
    conflicts: false,
    checks: [],
    reviews: [],
    comments: [],
    ...more,
  };
}

// Returns SQL that puts an open issue or PR into Skelcrew's copy, as a poll would have saved it,
// for a test that reads the copy without a daemon. The repository's owner is simon. `more` sets the
// item's other fields, such as its body.
export function itemSql(
  repo: string,
  kind: "task" | "pr",
  id: number,
  title: string,
  created: string,
  more: object = {},
): string {
  const link = `https://github.com/simon/${repo}/${kind === "task" ? "issues" : "pull"}/${id}`;
  const common = { id: String(id), title, body: "", state: "open", author: null, labels: [] };
  const item =
    kind === "task"
      ? { kind, ...common, link, created, updated: created, closes: `Closes #${id}`, ref: `#${id}` }
      : { kind, ...common, link, created, updated: created, branch: `b${id}`, base: "main" };
  const pr = kind === "pr" ? { conflicts: false, checks: [], reviews: [], comments: [] } : {};
  const json = JSON.stringify({ ...item, ...pr, ...more }).replaceAll("'", "''");
  return `INSERT OR REPLACE INTO items (owner, repo, kind, id, state, created, item)
    VALUES ('simon', '${repo}', '${kind}', '${id}', 'open', '${created}', '${json}');`;
}

// Returns SQL that saves a thread and its task, as sc start and the rounds after it would have,
// for a test that reads them without a daemon. `row` names the thread's task, and anything else
// either holds, each saved where it belongs. Its repository is simon/app, its folder app-12 for
// task 12, which is t12 on issue #12, and its status working, unless `row` says otherwise. A
// thread already saved is left as it is, so a test can run it before each step.
export function threadSql(row: Record<string, string | number | null>): string {
  const { owner = "simon", repo = "app", task: given = "12" } = row;
  // A task given by a number, such as 12, is task t12 on GitHub's issue #12, named APP-12, as
  // Skelcrew saves a task started on an issue.
  const numbered = /^\d+$/.test(String(given));
  const task = numbered ? `t${given}` : given;
  const full: Record<string, string | number | null> = {
    owner,
    repo,
    folder: `${repo}-${given}`,
    branch: `skelcrew/${given}`,
    status: "working",
    ...(numbered ? { issue: String(given), issue_ref: `#${given}` } : {}),
    ...row,
    task,
  };
  // A text value is quoted for SQL, with its quotes doubled.
  const literal = (value: string | number | null) =>
    typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
  const insert = (table: string, columns: string[]) =>
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")})
      VALUES (${columns.map((column) => literal(full[column] ?? null)).join(", ")});`;
  const onTask = (column: string) => column in taskColumns;
  const columns = Object.keys(full);
  return `${insert(
    "threads",
    columns.filter((column) => !onTask(column)),
  )}
${insert("tasks", ["owner", "repo", "task", ...columns.filter(onTask)])}`;
}

// Runs sc with these arguments at a terminal of its own, in a tmux session on a socket of its
// own, for a command that asks you first. Types `answer` and Enter once the screen shows
// `question`, and returns the screen once sc has ended. The tmux server ends with it.
// `meanwhile` runs while the question is open, such as another request for the same thing.
export async function runSkelInTerminal(
  socket: string,
  env: Record<string, string>,
  args: string[],
  question: string,
  answer: string,
  meanwhile?: () => Promise<unknown>,
): Promise<string> {
  mustBeTestSocket(scSocketIn(env), env);
  const terminal = `${socket}-terminal`;
  const tmux = (...words: string[]) =>
    Bun.spawnSync(["tmux", "-L", terminal, "-f", "/dev/null", ...words], {
      stdout: "pipe",
      stderr: "pipe",
    });
  const screen = () => tmux("capture-pane", "-p", "-t", "sc").stdout.toString();
  const vars = Object.entries(env).map(([name, value]) => `${name}='${value}'`);
  const quoted = args.map((arg) => `'${arg}'`);
  try {
    tmux(
      "new-session",
      "-d",
      "-s",
      "sc",
      "-x",
      "200",
      "-y",
      "20",
      `env -i ${vars.join(" ")} ${process.execPath} ${source("main.ts")} ${quoted.join(" ")}; echo ENDED; sleep 30`,
    );
    await until(() => screen().includes(question), { what: screen });
    await meanwhile?.();
    tmux("send-keys", "-t", "sc", "-l", answer);
    tmux("send-keys", "-t", "sc", "Enter");
    await until(() => screen().includes("ENDED"), { timeout: 30_000, what: screen });
    return screen();
  } finally {
    tmux("kill-server");
  }
}

// Whether the run is inside Skelcrew's own sandbox, as when a builder runs these tests. There
// bubblewrap can't start, so tests that start a real sandbox skip. scripts/test.ts sets it, as
// the run itself must not inherit the agent's SKELCREW_SANDBOX.
export const insideSandbox = process.env.SKELCREW_TESTS_IN_SANDBOX === "1";
