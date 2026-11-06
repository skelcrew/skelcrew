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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const asMac = join(import.meta.dir, "as-mac.ts");
const source = (file: string) => JSON.stringify(join(import.meta.dir, "..", "src", file));
let home = "";
let bin = "";

// Writes a fake program that logs its calls and then does `body`.
function fake(name: string, body: string): void {
  const line = `#!/bin/sh\necho "${name} $*" >> "$LOG"\n${body}\n`;
  writeFileSync(join(bin, name), line, { mode: 0o755 });
}

const env = () => ({
  HOME: home,
  LOG: join(home, "calls"),
  PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
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
  const socket = join(home, ".local", "share", "skel", "run", "skel", "lead", "skel.sock");
  mkdirSync(join(socket, ".."), { recursive: true });
  const made = await asMacRun(`import { agentCommand } from ${source("sandbox.ts")};
console.log(JSON.stringify(agentCommand({ name: "lead", socket: ${JSON.stringify(socket)}, model: "opus" })));`);
  expect(made.err).toBe("");
  return { socket, ...Command(made.out) };
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-mac-test-")));
  bin = join(home, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, "tmp"));
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
  writeFileSync(join(home, ".gitconfig"), "");
  // Runs what it is given as is, for lack of a real sandbox.
  fake("sandbox-exec", 'test "$1" = -f && shift 2; exec "$@"');
  fake("claude", 'pwd > "$OUT/pwd"; env > "$OUT/env"');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("an agent starts under sandbox-exec, in its folder, with a home of its own", async () => {
  const { argv, env: given, socket } = await leadCommand();
  expect(argv[0]).toBe("sandbox-exec");
  expect(argv).not.toContain("bwrap");
  const out = join(home, "seen");
  mkdirSync(out);
  const run = Bun.spawnSync(argv, {
    env: { ...given, OUT: out, LOG: join(home, "calls") },
    stderr: "pipe",
  });
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
  const run = Bun.spawnSync(argv, { env: { ...given, LOG: join(home, "calls") }, stdout: "pipe" });
  const [where, ownHome] = run.stdout.toString().trim().split("\n");
  expect(where).toBe(clone);
  expect(ownHome).not.toBe(home);
  expect(readFileSync(argv[2] ?? "", "utf8")).toContain(
    `(allow file-read* file-write* (subpath "${clone}"))`,
  );
});
