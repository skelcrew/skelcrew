// The first plain skel on a machine, run as you would run it, against fake tools.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");
let home = "";
let bin = "";

// Each fake writes its calls to a log, so a test can see what skel ran.
function fake(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`, {
    mode: 0o755,
  });
}

function loggedOutOfClaude(): void {
  fake("claude", `echo '{"loggedIn":false}'; exit 1`);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-setup-test-")));
  bin = join(home, "bin");
  mkdirSync(bin);
  // PATH holds only this folder, so a test can take a tool away.
  symlinkSync(Bun.which("git") ?? "git", join(bin, "git"));
  fake("tmux", "exit 0");
  fake("bwrap", "exit 0");
  fake(
    "gh",
    `case "$1 $2" in
  "auth status") test -f "$HOME/gh-login" ;;
  "auth login") : > "$HOME/gh-login" ;;
  "repo view") echo '{"name":"app","owner":{"login":"simon"}}' ;;
esac`,
  );
  fake("claude", `echo '{"loggedIn":true,"authMethod":"claude.ai"}'`);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function repository(): string {
  const path = join(home, "code", "app");
  mkdirSync(path, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", path]);
  Bun.spawnSync(["git", "-C", path, "remote", "add", "origin", "https://github.com/simon/app"]);
  return path;
}

function calls(): string {
  const log = join(home, "calls");
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

const config = () => join(home, ".config", "skel", "config.yaml");

async function skel(typed = "") {
  const run = Bun.spawn([process.execPath, main], {
    env: { PATH: bin, HOME: home },
    stdin: new Blob([typed]),
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

test("takes every step on the first run, and none on the second", async () => {
  const path = repository();
  const first = await skel(`${path}\ny\n1\n`);
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(calls()).toContain("gh auth login");
  expect(first.out).toContain("trust");
  expect(first.out).toContain("Claude Code");
  expect(first.out).toContain("done");
  expect(readFileSync(config(), "utf8")).toContain("harness: claude");

  writeFileSync(join(home, "calls"), "");
  const second = await skel();
  expect(second.err).toBe("");
  expect(second.code).toBe(0);
  expect(second.out).not.toContain("trust");
  expect(second.out).not.toContain("Claude Code");
  expect(second.out).toContain("done");
  expect(calls()).not.toContain("gh auth login");
});

test("lists the repository added on the first run", async () => {
  const path = repository();
  await skel(`${path}\ny\n1\n`);
  const run = Bun.spawnSync([process.execPath, main, "repo", "ls"], {
    env: { PATH: bin, HOME: home },
  });
  expect(run.stdout.toString()).toContain(path);
});

test("skips the GitHub login when gh is logged in already", async () => {
  writeFileSync(join(home, "gh-login"), "");
  const path = repository();
  const run = await skel(`${path}\ny\n1\n`);
  expect(run.code).toBe(0);
  expect(calls()).toContain("gh auth status");
  expect(calls()).not.toContain("gh auth login");
});

test("names each missing tool with what to install, and runs nothing else", async () => {
  unlinkSync(join(bin, "tmux"));
  unlinkSync(join(bin, "claude"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toContain("sudo apt install tmux");
  expect(run.err).toContain("curl -fsSL https://claude.ai/install.sh | bash");
  expect(run.err).not.toContain("bubblewrap");
  expect(calls()).toBe("");
});

test("gives the AppArmor advice when bwrap can't run", async () => {
  fake("bwrap", "echo 'bwrap: setting up uid map: Permission denied' >&2; exit 1");
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toContain("Permission denied");
  expect(run.err).toContain("AppArmor");
  expect(calls()).not.toContain("gh");
});

test("doesn't save a harness while Claude Code is logged out", async () => {
  loggedOutOfClaude();
  const path = repository();
  const run = await skel(`${path}\ny\n1\n`);
  expect(run.code).toBe(1);
  expect(run.err).toContain("run claude");
  expect(existsSync(config())).toBe(false);
});

test("keeps the other settings in config.yaml", async () => {
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(config(), "# mine\ncolor: blue\n");
  const path = repository();
  const run = await skel(`${path}\ny\n1\n`);
  expect(run.code).toBe(0);
  const saved = readFileSync(config(), "utf8");
  expect(saved).toContain("# mine");
  expect(saved).toContain("color: blue");
  expect(saved).toContain("harness: claude");
});

test("refuses a config.yaml it can't read", async () => {
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(config(), "harness: [1, 2]\n");
  writeFileSync(join(home, "gh-login"), "");
  const path = repository();
  const run = await skel(`${path}\ny\n1\n`);
  expect(run.code).toBe(1);
  expect(run.err).toContain("config.yaml");
});
