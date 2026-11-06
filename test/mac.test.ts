// skel as it runs on a Mac, played out on Linux: each run loads test/as-mac.ts, so skel takes
// its Mac paths, with fake sandbox-exec and launchctl scripts in place of the real ones.
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

const asMac = join(import.meta.dir, "as-mac.ts");
const source = (file: string) => JSON.stringify(join(import.meta.dir, "..", "src", file));
let home = "";
let bin = "";
let socket = "";
const running: Subprocess[] = [];

// Writes a fake program that logs its calls and then does `body`. The log's path is written
// in, as a sandbox's environment holds only what skel lets in.
function fake(name: string, body: string): void {
  const line = `#!/bin/sh\necho "${name} $*" >> "${home}/calls"\n${body}\n`;
  writeFileSync(join(bin, name), line, { mode: 0o755 });
}

// XDG_RUNTIME_DIR is set, as a Mac has no /run/user but this machine does, and skel's real
// daemon listens there.
const env = () => ({
  HOME: home,
  XDG_RUNTIME_DIR: join(home, "run"),
  PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  TMPDIR: join(home, "tmp"),
  SECRET_TOKEN: "secret",
});

// Runs a script as a Mac would, in a process of its own: skel's home folder must be the
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

// Returns the command skel would start the lead with.
async function leadCommand() {
  const socket = join(home, "run", "skel", "lead", "skel.sock");
  mkdirSync(join(socket, ".."), { recursive: true });
  const made = await asMacRun(`import { agentCommand } from ${source("sandbox.ts")};
console.log(JSON.stringify(agentCommand({ name: "lead", socket: ${JSON.stringify(socket)}, model: "opus" })));`);
  expect(made.err).toBe("");
  return { socket, ...Command(made.out) };
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-mac-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  bin = join(home, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, "tmp"));
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
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

test("an agent starts under sandbox-exec, in its folder, with a home of its own", async () => {
  const { argv, env: given, socket } = await leadCommand();
  expect(argv[0]).toBe("sandbox-exec");
  expect(argv).not.toContain("bwrap");
  const out = join(home, ".local", "share", "skel", "claude", "lead");
  const run = Bun.spawnSync(argv, { env: given, stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  expect(readFileSync(join(out, "pwd"), "utf8").trim()).toBe(
    join(home, ".local", "share", "skel", "lead"),
  );
  const seen = readFileSync(join(out, "env"), "utf8");
  expect(seen).toContain("SKEL_SANDBOX=1\n");
  expect(seen).toContain(`SKEL_SOCKET=${socket}\n`);
  expect(seen).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-good\n");
  expect(seen).not.toContain("SECRET_TOKEN");
  // Your home folder is denied, and git refuses a ~/.gitconfig it may not read.
  expect(seen).not.toContain(`HOME=${home}\n`);
  const ownHome = seen.match(/^HOME=(.*)$/m)?.[1] ?? "";
  expect(ownHome.startsWith(join(home, "tmp", "skel-sandbox-"))).toBe(true);
  expect(existsSync(ownHome)).toBe(true);
  const ownTemp = seen.match(/^TMPDIR=(.*)$/m)?.[1] ?? "";
  expect(seen).toContain(`CLAUDE_CODE_TMPDIR=${ownTemp}\n`);
});

test("the profile hides your home folder and brings back the agent's folders", async () => {
  const { argv, socket } = await leadCommand();
  const text = readFileSync(argv[2] ?? "", "utf8");
  const skel = join(home, ".local", "share", "skel");
  for (const folder of [home, `/System/Volumes/Data${home}`, "/private/tmp"])
    expect(text).toContain(`(deny file-read* (subpath "${folder}"))`);
  expect(text).toContain(`(allow file-read* file-write* (subpath "${join(skel, "lead")}"))`);
  expect(text).toContain(
    `(allow file-read* file-write* (subpath "${join(skel, "claude", "lead")}"))`,
  );
  expect(text).toContain(`(allow file-read* (subpath "${join(skel, "repos")}"))`);
  expect(text).toContain(`(remote unix-socket (subpath "${socket}"))`);
  // Bun and claude are found on the PATH, and skel's own commands come back with them.
  expect(text).toContain(`(allow file-read* (subpath "${bin}"))`);
  expect(text).toContain(`${join(import.meta.dir, "..", "bin")}"`);
});

test("the agent can't reach the file its rules are in", async () => {
  const { argv } = await leadCommand();
  const file = argv[2] ?? "";
  const folder = join(file, "..");
  expect(readdirSync(folder).sort()).toEqual(["home", "profile.sb", "tmp"]);
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain(`file-write* (subpath "${folder}"))`);
  expect(text).not.toContain(`file-write* (subpath "${file}"))`);
});

test("a setup command runs in the sandbox with no socket", async () => {
  const clone = join(home, "clone");
  mkdirSync(clone);
  const made = await asMacRun(`import { setupCommand } from ${source("sandbox.ts")};
console.log(JSON.stringify(setupCommand(${JSON.stringify(clone)}, "pwd; echo \\"$HOME\\"")));`);
  expect(made.err).toBe("");
  const { argv, env: given } = Command(made.out);
  const run = Bun.spawnSync(argv, { env: given, stdout: "pipe" });
  const [where, ownHome] = run.stdout.toString().trim().split("\n");
  expect(where).toBe(clone);
  expect(ownHome).not.toBe(home);
  expect(readFileSync(argv[2] ?? "", "utf8")).toContain(
    `(allow file-read* file-write* (subpath "${clone}"))`,
  );
});

// Waits until `done` holds, for what a daemon does in its own time.
async function until(done: () => boolean, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("gave up waiting");
    await Bun.sleep(50);
  }
}

test("the daemon takes its lock from a Mac's system library, and the lead reaches it", async () => {
  // A Mac's library name, standing for the C library here. With no such name to load, the
  // daemon stops before it opens a socket.
  const libraries = join(home, "lib");
  mkdirSync(libraries);
  const known = ["/lib/x86_64-linux-gnu", "/lib/aarch64-linux-gnu", "/usr/lib", "/lib64"];
  const libc = known.map((folder) => join(folder, "libc.so.6")).find((file) => existsSync(file));
  if (process.platform === "linux") symlinkSync(libc ?? "", join(libraries, "libSystem.B.dylib"));
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "run.skel.daemon.plist"), "");
  writeFileSync(join(home, ".config", "skel", "config.yaml"), "harness: claude\n");
  fake("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  fake("gh", "exit 1");
  fake(
    "claude",
    'skel ps > "$CLAUDE_CONFIG_DIR/ps.new" 2>&1; mv "$CLAUDE_CONFIG_DIR/ps.new" "$CLAUDE_CONFIG_DIR/ps"; exec sleep 300',
  );
  const script = `import { serve } from ${source("daemon.ts")};
await serve(${JSON.stringify(socket)});`;
  const log = join(home, "daemon.log");
  const serve = Bun.spawn([process.execPath, "--preload", asMac, "-e", script], {
    env: { ...env(), LD_LIBRARY_PATH: libraries },
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  });
  running.push(serve);
  const daemon = join(home, "run", "skel.sock");
  await until(() => existsSync(daemon) || serve.exitCode !== null);
  expect(serve.exitCode).toBe(null);
  const said = join(home, ".local", "share", "skel", "claude", "lead", "ps");
  await until(() => existsSync(said));
  expect(readFileSync(said, "utf8")).toBe("There are no threads.\n");
  expect(readFileSync(join(home, "calls"), "utf8")).toContain("sandbox-exec -f");
});
