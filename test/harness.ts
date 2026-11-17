// What Skelcrew's tests share: finding Skelcrew's source files, waiting, and running sc and its
// daemon as a user would. Each test file keeps its own home folder and tmux socket and hands
// them in, so a test that outlives its file can never reach another file's home.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Subprocess } from "bun";

// Returns the path of a file in src/, or of src/ itself, for a test that runs sc or hands
// its code to a process of its own.
export const source = (file = "") => join(import.meta.dir, "..", "src", file);

// Waits until `done` holds, for what a daemon or a session does in its own time, looking every
// `every` milliseconds. Past `timeout` it throws, naming `what` if given. `what` is a function
// so a test can show what is on screen at that moment, and pays for that only on failure.
// The limit is generous, as a busy machine can take many seconds to start a daemon or a
// sandbox. It only ends a wait that would never end.
export async function until(
  done: () => boolean,
  options: { timeout?: number; every?: number; what?: () => string } = {},
): Promise<void> {
  const { timeout = 30_000, every = 50, what } = options;
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error(what ? `gave up waiting for ${what()}` : "gave up waiting");
    await Bun.sleep(every);
  }
}

// Returns the environment for a process of a test with this home. Skelcrew, its daemon and what
// they start find their state, their socket and the test's fake programs through it, and so
// never reach the real ones. The temporary folders the test was given pass through: inside
// Skelcrew's sandbox on a Mac /tmp is hidden, and tmux and temporary files must go elsewhere.
export function homeEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {
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
// daemon here would open your real database.
export function startDaemon(
  socket: string,
  env: Record<string, string>,
  running: Subprocess[],
): Subprocess {
  mustBeTestSocket(daemonSocketIn(env), env);
  const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)});`;
  // Reviews start at once on a repository without CI, unless the test asks for the wait.
  const run = Bun.spawn([process.execPath, "-e", code], {
    env: { SKELCREW_CHECK_WAIT_MS: "0", ...env },
    stdout: "ignore",
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

// Installs the fake tracker and forge as a plugin named `name`, doing `jobs`, for a test with
// this home, and returns its settings folder, where it keeps the questions it is asked and
// reads its answers. Its git_credentials lend nothing, as the tests' remotes are folders.
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
jobs: [${jobs.join(", ")}]
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
      ? { kind, ...common, link, created, updated: created, closes: `Closes #${id}` }
      : { kind, ...common, link, created, updated: created, branch: `b${id}`, base: "main" };
  const pr = kind === "pr" ? { conflicts: false, checks: [], reviews: [], comments: [] } : {};
  const json = JSON.stringify({ ...item, ...pr, ...more }).replaceAll("'", "''");
  return `INSERT OR REPLACE INTO items (owner, repo, kind, id, state, created, item)
    VALUES ('simon', '${repo}', '${kind}', '${id}', 'open', '${created}', '${json}');`;
}

// Runs sc with these arguments at a terminal of its own, in a tmux session on a socket of its
// own, for a command that asks you first. Types `answer` and Enter once the screen shows
// `question`, and returns the screen once sc has ended. The tmux server ends with it.
export async function runSkelInTerminal(
  socket: string,
  env: Record<string, string>,
  args: string[],
  question: string,
  answer: string,
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
