// Skelcrew as it runs on a Mac, played out on Linux: each run loads test/as-mac.ts, so Skelcrew
// takes its Mac paths, with fake sandbox-exec and launchctl scripts in place of the real ones.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { stillRunning } from "../src/agents/tmux.ts";
import { leadPlaces } from "../src/paths.ts";
import { source, until as wait } from "./harness.ts";

const asMac = join(import.meta.dir, "as-mac.ts");
let home = "";
let bin = "";
let socket = "";
const running: Subprocess[] = [];

// Writes a fake program that logs its calls and then does `body`. The log's path is written
// in, as a sandbox's environment holds only what Skelcrew lets in.
function fake(name: string, body: string): void {
  const line = `#!/bin/sh\necho "${name} $*" >> "${home}/calls"\n${body}\n`;
  writeFileSync(join(bin, name), line, { mode: 0o755 });
}

// XDG_RUNTIME_DIR is set, as a Mac has no /run/user but this machine does, and Skelcrew's real
// daemon listens there.
const env = () => ({
  HOME: home,
  XDG_RUNTIME_DIR: join(home, "run"),
  PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  TMPDIR: join(home, "tmp"),
  SECRET_TOKEN: "secret",
});

// Runs a script as a Mac would, in a process of its own: Skelcrew's home folder must be the
// test's, and only a HOME set from the start reaches it.
async function asMacRun(script: string) {
  const run = Bun.spawn([process.execPath, "--preload", asMac, "-e", script], {
    env: env(),
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

const Command = (text: string) => {
  const { argv, env } = JSON.parse(text);
  return { argv: [...argv].map(String), env: { ...env } };
};

// Skelcrew's clone of simon/app, which its lead sees, made as a repository is added.
function appClone(): string {
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  Bun.spawnSync(["git", "-C", clone, "init", "-q"]);
  return clone;
}

// Returns what starts app's lead, with its folder and its clone, as Skelcrew gives them.
const leadStart = (socket: string) =>
  JSON.stringify({
    name: "lead",
    socket,
    model: "opus",
    folder: join(home, ".local", "share", "skelcrew", "leads", "simon", "app"),
    origin: appClone(),
  });

// Returns the command Skelcrew would start the lead with.
async function leadCommand() {
  const socket = join(home, "run", "skelcrew", "lead", "skelcrew.sock");
  mkdirSync(join(socket, ".."), { recursive: true });
  const made = await asMacRun(`import { claude } from ${JSON.stringify(source("agents/claude.ts"))};
console.log(JSON.stringify(claude.start(${leadStart(socket)})));`);
  expect(made.err).toBe("");
  return { socket, ...Command(made.out) };
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-mac-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  bin = join(home, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, "tmp"));
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  writeFileSync(join(home, ".gitconfig"), "");
  // Runs what it is given as is, for lack of a real sandbox.
  fake("sandbox-exec", 'test "$1" = -f && shift 2; exec "$@"');
  fake("claude", 'pwd > "$CLAUDE_CONFIG_DIR/pwd"; env > "$CLAUDE_CONFIG_DIR/env"');
});
afterEach(async () => {
  for (const serve of running.splice(0)) {
    serve.kill();
    await serve.exited;
  }
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
});

// Returns the file holding a command's sandbox rules.
const rules = (argv: string[]) => argv[argv.indexOf("-f") + 1] ?? "";

test("a sandbox's home and temporary folder go when it ends, and its exit code stays", async () => {
  const clone = join(home, "clone");
  mkdirSync(clone);
  const made =
    await asMacRun(`import { setupCommand } from ${JSON.stringify(source("agents/sandbox.ts"))};
console.log(JSON.stringify(setupCommand(${JSON.stringify(clone)}, "echo left > $TMPDIR/file; exit 3")));`);
  const { argv, env: given } = Command(made.out);
  expect(existsSync(rules(argv))).toBe(true);
  const run = Bun.spawnSync(argv, { env: given });
  expect(run.exitCode).toBe(3);
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("a sandbox's folders go even when the terminal hangs up on it", async () => {
  fake("claude", 'trap "exit 0" HUP; echo up > "$CLAUDE_CONFIG_DIR/up"; sleep 30 & wait');
  const { argv, env: given } = await leadCommand();
  const run = Bun.spawn(argv, { env: given, detached: true, stdout: "ignore", stderr: "ignore" });
  const up = join(home, ".local", "share", "skelcrew", "claude", "lead", "up");
  await until(() => existsSync(up));
  process.kill(-run.pid, "SIGHUP");
  await run.exited;
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("an agent starts under sandbox-exec, in its folder, with a home of its own", async () => {
  const { argv, env: given, socket } = await leadCommand();
  expect(argv).toContain("sandbox-exec");
  expect(argv).not.toContain("bwrap");
  const out = join(home, ".local", "share", "skelcrew", "claude", "lead");
  const run = Bun.spawnSync(argv, { env: given, stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  expect(readFileSync(join(out, "pwd"), "utf8").trim()).toBe(
    join(home, ".local", "share", "skelcrew", "leads", "simon", "app"),
  );
  const seen = readFileSync(join(out, "env"), "utf8");
  expect(seen).toContain("SKELCREW_SANDBOX=1\n");
  expect(seen).toContain(`SKELCREW_SOCKET=${socket}\n`);
  expect(seen).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-good\n");
  expect(seen).not.toContain("SECRET_TOKEN");
  // Your home folder is denied, and git refuses a ~/.gitconfig it may not read.
  expect(seen).not.toContain(`HOME=${home}\n`);
  const ownHome = seen.match(/^HOME=(.*)$/m)?.[1] ?? "";
  expect(ownHome.startsWith(join(home, "tmp", "skelcrew-sandbox-"))).toBe(true);
  const ownTemp = seen.match(/^TMPDIR=(.*)$/m)?.[1] ?? "";
  expect(seen).toContain(`CLAUDE_CODE_TMPDIR=${ownTemp}\n`);
  // Postgres clients default to a socket in /tmp, which the sandbox hides.
  expect(seen).toContain("PGHOST=localhost\n");
});

test("the agent's socket is never resolved itself, as a Mac can't open one to find its real path", async () => {
  const socket = join(home, "run", "skelcrew", "lead", "skelcrew.sock");
  mkdirSync(join(socket, ".."), { recursive: true });
  // A link stands in for the socket, which Linux would resolve without complaint. The last part
  // of the path going unresolved is what keeps a Mac from failing with EOPNOTSUPP.
  symlinkSync(join(home, "elsewhere"), socket);
  writeFileSync(join(home, "elsewhere"), "");
  const made = await asMacRun(`import { claude } from ${JSON.stringify(source("agents/claude.ts"))};
console.log(JSON.stringify(claude.start(${leadStart(socket)})));`);
  expect(made.err).toBe("");
  const text = readFileSync(rules(Command(made.out).argv), "utf8");
  expect(text).toContain(`(remote unix-socket (subpath "${socket}"))`);
});

test("the profile hides your home folder and brings back the agent's folders", async () => {
  const { argv, socket } = await leadCommand();
  const text = readFileSync(rules(argv), "utf8");
  const skel = join(home, ".local", "share", "skelcrew");
  for (const folder of [home, `/System/Volumes/Data${home}`, "/private/tmp"])
    expect(text).toContain(`(deny file-read* (subpath "${folder}"))`);
  const folder = join(skel, "leads", "simon", "app");
  expect(text).toContain(`(allow file-read* file-write* (subpath "${folder}"))`);
  expect(text).toContain(
    `(allow file-read* file-write* (subpath "${join(skel, "claude", "lead")}"))`,
  );
  expect(text).toContain(`(allow file-read* (subpath "${join(skel, "repos", "simon", "app")}"))`);
  expect(text).toContain(`(remote unix-socket (subpath "${socket}"))`);
  // Bun and claude are found on the PATH, and Skelcrew's own commands come back with them.
  expect(text).toContain(`(allow file-read* (subpath "${bin}"))`);
  expect(text).toContain(`${join(import.meta.dir, "..", "bin")}"`);
});

test("what comes back of your home folder keeps its place under the agent's own", async () => {
  const { argv } = await leadCommand();
  const ownHome = join(rules(argv), "..", "home");
  // The lead's instructions name its repository's clone by this path.
  const clone = join(ownHome, ".local", "share", "skelcrew", "repos", "simon", "app");
  expect(realpathSync(clone)).toBe(
    join(home, ".local", "share", "skelcrew", "repos", "simon", "app"),
  );
  // Nothing else of yours is put there.
  expect(existsSync(join(ownHome, ".config"))).toBe(false);
});

test("the agent can't reach the file its rules are in", async () => {
  const { argv } = await leadCommand();
  const file = rules(argv);
  const folder = join(file, "..");
  expect(readdirSync(folder).sort()).toEqual(["home", "profile.sb", "tmp"]);
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain(`file-write* (subpath "${folder}"))`);
  expect(text).not.toContain(`file-write* (subpath "${file}"))`);
});

test("a setup command runs in the sandbox with no socket", async () => {
  const clone = join(home, "clone");
  mkdirSync(clone);
  const made =
    await asMacRun(`import { setupCommand } from ${JSON.stringify(source("agents/sandbox.ts"))};
console.log(JSON.stringify(setupCommand(${JSON.stringify(clone)}, "pwd; echo \\"$HOME\\"")));`);
  expect(made.err).toBe("");
  const { argv, env: given } = Command(made.out);
  expect(readFileSync(rules(argv), "utf8")).toContain(
    `(allow file-read* file-write* (subpath "${clone}"))`,
  );
  const run = Bun.spawnSync(argv, { env: given, stdout: "pipe" });
  const [where, ownHome] = run.stdout.toString().trim().split("\n");
  expect(where).toBe(clone);
  expect(ownHome).not.toBe(home);
});

test("a setup command runs at a lower CPU priority, and the lead at normal", async () => {
  const clone = join(home, "clone");
  mkdirSync(clone);
  const made =
    await asMacRun(`import { setupCommand } from ${JSON.stringify(source("agents/sandbox.ts"))};
console.log(JSON.stringify(setupCommand(${JSON.stringify(clone)}, "nice")));`);
  expect(made.err).toBe("");
  const setup = Command(made.out);
  const own = Number(Bun.spawnSync(["nice"], { stdout: "pipe" }).stdout.toString());
  const run = Bun.spawnSync(setup.argv, { env: setup.env, stdout: "pipe" });
  expect(Number(run.stdout.toString())).toBe(Math.min(own + 10, 19));
  const { argv } = await leadCommand();
  expect(argv[0]).toBe("/bin/sh");
});

// Waits until `done` holds, for what a daemon does in its own time.
const until = (done: () => boolean, timeout = 15_000) => wait(done, { timeout });

test("the daemon takes its lock from a Mac's system library, and the lead reaches it", async () => {
  // A Mac's library name, standing for the C library here. With no such name to load, the
  // daemon stops before it opens a socket.
  const libraries = join(home, "lib");
  mkdirSync(libraries);
  const known = ["/lib/x86_64-linux-gnu", "/lib/aarch64-linux-gnu", "/usr/lib", "/lib64"];
  const libc = known.map((folder) => join(folder, "libc.so.6")).find((file) => existsSync(file));
  if (process.platform === "linux") symlinkSync(libc ?? "", join(libraries, "libSystem.B.dylib"));
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "dev.skelcrew.daemon.plist"), "");
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\n");
  fake("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  // simon/app, opened before, so the daemon starts its lead as it starts.
  appClone();
  const opened = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo, opened) VALUES ('app', 'simon', 'app', 1)");`;
  expect((await asMacRun(opened)).err).toBe("");
  // Ends when its terminal goes, as Claude Code does: the sandbox's wrapper stays for it, as it
  // keeps going through a hangup to remove its folder once the agent has ended.
  fake(
    "claude",
    'sc ps > "$CLAUDE_CONFIG_DIR/ps.new" 2>&1; mv "$CLAUDE_CONFIG_DIR/ps.new" "$CLAUDE_CONFIG_DIR/ps"; read -r line',
  );
  const script = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)});`;
  const log = join(home, "daemon.log");
  const serve = Bun.spawn([process.execPath, "--preload", asMac, "-e", script], {
    env: { ...env(), LD_LIBRARY_PATH: libraries },
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  });
  running.push(serve);
  const daemon = join(home, "run", "skelcrew.sock");
  await until(() => existsSync(daemon) || serve.exitCode !== null);
  expect(serve.exitCode).toBe(null);
  const lead = leadPlaces("simon", "app").name;
  const said = join(home, ".local", "share", "skelcrew", "claude", lead, "ps");
  await until(() => existsSync(said));
  expect(readFileSync(said, "utf8")).toBe("There are no threads.\n");
  expect(readFileSync(join(home, "calls"), "utf8")).toContain("sandbox-exec -f");
});

test("stopping a session asks ps, as a Mac has no /proc", async () => {
  const ps = Bun.which("ps") ?? "ps";
  fake("ps", `exec ${ps} "$@"`);
  const script = `import { startServer, startSession, stopSession } from ${JSON.stringify(source("agents/tmux.ts"))};
startServer(${JSON.stringify(socket)});
startSession(${JSON.stringify(socket)}, "agent", { folder: "/", command: ["sleep", "300"], env: { PATH: process.env.PATH ?? "" } });
await stopSession(${JSON.stringify(socket)}, "agent");`;
  fake("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  const stopped = await asMacRun(script);
  expect(stopped.err).toBe("");
  // Each column is asked for apart: a Mac's ps reads the rest of the word as the first's title.
  expect(readFileSync(join(home, "calls"), "utf8")).toContain("ps -A -o pid= -o ppid= -o stat=");
});

const codexHome = () => join(home, ".local", "share", "skelcrew", "codex");

// Runs git in the clone and returns what it printed.
const git = (clone: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();

// Writes a clone with a commit to review, and a fake Codex that answers as told, after
// running `extra`.
function reviewable(extra: string): string {
  const clone = join(home, ".local", "share", "skelcrew", "threads", "app-12");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "README"), "app\n");
  git(clone, "init", "-q");
  git(clone, "add", ".");
  git(clone, "commit", "-qm", "submitted");
  mkdirSync(codexHome(), { recursive: true });
  // Linux's cp doesn't know the word a Mac's has for sharing blocks.
  const cp = Bun.which("cp") ?? "cp";
  fake("cp", `test "$2" = -c && { shift 2; exec ${cp} -a "$@"; }; exit 1`);
  writeFileSync(join(codexHome(), "config.toml"), "model = 1\n");
  writeFileSync(join(codexHome(), "auth.json"), "login\n");
  fake(
    "codex",
    `for a; do [ "$prev" = -o ] && out=$a; prev=$a; done
${extra}
printf '%s' '{"verdict":"approve","body":"Fine."}' > "$out"`,
  );
  return clone;
}

// Runs a review as a Mac would, and returns its verdict.
async function reviewOnMac(clone: string, more = "") {
  const ran = await asMacRun(`import { review } from ${JSON.stringify(source("flow/reviewer.ts"))};
console.log(JSON.stringify(await review({ clone: ${JSON.stringify(clone)}, issue: { title: "t", body: "b" }, base: "origin/main", commit: ${JSON.stringify(git(clone, "rev-parse", "HEAD"))}, model: "opus", harness: "codex", ${more} })));
process.exit(0);`);
  expect(ran.err).toBe("");
  return JSON.parse(ran.out);
}

test("a reviewer works in a copy, and only its login and sessions reach Skelcrew's", async () => {
  const clone = reviewable(`mkdir -p "$CODEX_HOME/sessions"
pwd > "$CODEX_HOME/sessions/where"
cat README >> "$CODEX_HOME/sessions/where"
echo "$CODEX_HOME" > "$CODEX_HOME/sessions/home"
echo changed > README
echo evil > "$CODEX_HOME/config.toml"
echo renewed > "$CODEX_HOME/auth.json"`);
  expect(await reviewOnMac(clone)).toEqual({ verdict: "approve", body: "Fine." });
  const [where, seen] = readFileSync(join(codexHome(), "sessions", "where"), "utf8").split("\n");
  expect(where).not.toBe(clone);
  expect(seen).toBe("app");
  expect(readFileSync(join(clone, "README"), "utf8")).toBe("app\n");
  expect(readFileSync(join(codexHome(), "sessions", "home"), "utf8").trim()).not.toBe(codexHome());
  expect(readFileSync(join(codexHome(), "config.toml"), "utf8")).toBe("model = 1\n");
  expect(readFileSync(join(codexHome(), "auth.json"), "utf8")).toBe("renewed\n");
  expect(readFileSync(join(home, "calls"), "utf8")).toContain("sandbox-exec -f");
});

test("a reviewer gets a plain copy where the disk can't share blocks", async () => {
  const clone = reviewable("");
  const cp = Bun.which("cp") ?? "cp";
  fake("cp", `test "$2" = -c && exit 1; exec ${cp} "$@"`);
  expect(await reviewOnMac(clone)).toEqual({ verdict: "approve", body: "Fine." });
});

test("nothing a reviewer started outlives it, or keeps the review waiting", async () => {
  const pid = join(home, "pid");
  const clone = reviewable(`sleep 300 &\necho $! > ${pid}`);
  expect((await reviewOnMac(clone)).verdict).toBe("approve");
  const left = Number(readFileSync(pid, "utf8"));
  await until(() => stillRunning([left]).length === 0);
});

test("a process that left the reviewer's group can't keep the review waiting", async () => {
  const pid = join(home, "pid");
  const leave = join(home, "leave.ts");
  writeFileSync(
    leave,
    `const left = Bun.spawn(["sleep", "60"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
await Bun.write(${JSON.stringify(pid)}, String(left.pid));
left.unref();`,
  );
  const clone = reviewable(`bun ${leave}`);
  try {
    expect((await reviewOnMac(clone)).verdict).toBe("approve");
  } finally {
    process.kill(Number(readFileSync(pid, "utf8")), "SIGKILL");
  }
});

test("a review that runs out of time ends, with all it started", async () => {
  const clone = reviewable("sleep 300");
  const verdict = await reviewOnMac(clone, "limit: 500");
  expect(verdict.verdict).toBe("failed");
  expect(verdict.body).toContain("ran past");
});
