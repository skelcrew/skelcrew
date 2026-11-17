// sc check against a running daemon: the repository's test command runs in the folder sc check
// ran in, and at most limits.checks run at once on the machine, the rest waiting their turn.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { git, homeEnv, read, source, startDaemon, until } from "./harness.ts";

let home = "";
const running: Subprocess[] = [];
// The daemon starts no session here, but it is given a tmux socket of its own all the same.
const socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;

// The test command: notes in the shared log when it starts and ends in which checkout, and
// holds its check slot until the test creates `done` in that checkout. Ends with the code the
// checkout's `code` file holds, or 0.
const suite = [
  'echo "start $(basename "$PWD")" >> "$HOME/log"',
  'while [ ! -e done ]; do sleep 0.05; done; echo "end $(basename "$PWD")" >> "$HOME/log"; exit "$(cat code 2>/dev/null || echo 0)"',
];

// Writes your config.yaml with these lines after the harness, which a daemon needs to start.
function config(lines: string): void {
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), `harness: claude\n${lines}`);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-check-test-")));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  config(`limits: { checks: 1 }\ntest: ${JSON.stringify(suite)}\n`);
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
  // Skelcrew has simon/app, with no forge.
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo, remote) VALUES ('app', 'simon', 'app', 'https://example.com/simon/app.git')");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
});
afterEach(async () => {
  for (const serve of running.splice(0)) {
    serve.kill();
    await serve.exited;
  }
  rmSync(home, { recursive: true, force: true });
});

// What this test's processes run with.
const env = () => homeEnv(home);

// Makes a checkout of simon/app named `name`, as you would have one, and returns its folder.
function checkout(name: string, remote = "https://example.com/simon/app.git"): string {
  const folder = join(home, name);
  mkdirSync(folder);
  git(folder, "init", "-q");
  git(folder, "remote", "add", "origin", remote);
  return folder;
}

// Starts sc check in the folder, and returns what it printed and its exit code once it ends.
// What it printed so far is in `out` meanwhile.
function check(folder: string) {
  const run = Bun.spawn([process.execPath, source("main.ts"), "check"], {
    cwd: folder,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const said = { out: "" };
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of run.stdout) said.out += decoder.decode(chunk);
  })();
  const ended = Promise.all([reading, new Response(run.stderr).text(), run.exited]).then(
    ([, err, code]) => ({ out: said.out, err, code }),
  );
  return { said, ended, run };
}

// Starts the daemon and waits for its socket, which it makes once it listens. New checks wait
// `settle` milliseconds after it starts, for suites from before a restart to take their slots
// back: none, unless a test is about that. Returns the daemon, for a test that restarts it.
async function serve(settle = 0): Promise<Subprocess> {
  rmSync(join(home, "run", "skelcrew.sock"), { force: true });
  const daemon = startDaemon(
    socket,
    { ...env(), SKELCREW_CHECK_SLOT_SETTLE_MS: String(settle) },
    running,
  );
  await until(() => existsSync(join(home, "run", "skelcrew.sock")));
  return daemon;
}

const log = () => read(join(home, "log"));

test("runs the test commands in its own folder, one check at a time, the rest told their place", async () => {
  await serve();
  const [a, b, c] = ["a", "b", "c"].map((name) => checkout(name));
  if (!a || !b || !c) throw new Error("no checkouts");
  const first = check(a);
  await until(() => log().includes("start a"));
  const second = check(b);
  await until(() => second.said.out.includes("in line"));
  const third = check(c);
  await until(() => third.said.out.includes("in line"));
  expect(second.said.out).toContain("Waiting for a check slot: number 1 in line.");
  expect(third.said.out).toContain("Waiting for a check slot: number 2 in line.");
  // Neither starts while the first holds the only slot.
  await Bun.sleep(300);
  expect(log()).toBe("start a\n");
  // The first ending frees its slot for the next in line, and its code is sc check's.
  writeFileSync(join(a, "code"), "3");
  writeFileSync(join(a, "done"), "");
  expect((await first.ended).code).toBe(3);
  await until(() => log().includes("start b"));
  expect(log()).toBe("start a\nend a\nstart b\n");
  writeFileSync(join(b, "done"), "");
  writeFileSync(join(c, "done"), "");
  expect((await second.ended).code).toBe(0);
  expect((await third.ended).code).toBe(0);
  expect(log()).toBe("start a\nend a\nstart b\nend b\nstart c\nend c\n");
}, 60_000);

test("a check killed while it waits gives back its place, and one killed while it runs keeps it until its suite ends", async () => {
  await serve();
  const [a, b, c] = ["a", "b", "c"].map((name) => checkout(name));
  if (!a || !b || !c) throw new Error("no checkouts");
  const first = check(a);
  await until(() => log().includes("start a"));
  const waiting = check(b);
  await until(() => waiting.said.out.includes("in line"));
  waiting.run.kill("SIGKILL");
  await waiting.run.exited;
  // Its test shell runs on, holding the output open, so only the process is waited for.
  first.run.kill("SIGKILL");
  await first.run.exited;
  const third = check(c);
  await until(() => third.said.out.includes("number 1 in line"));
  await Bun.sleep(300);
  expect(log()).toBe("start a\n");
  // The suite ending frees the slot, for the next in line, not for the one killed while waiting.
  writeFileSync(join(a, "done"), "");
  await until(() => log().includes("start c"));
  writeFileSync(join(c, "done"), "");
  expect((await third.ended).code).toBe(0);
  expect(log()).toBe("start a\nend a\nstart c\nend c\n");
}, 60_000);

test("a suite running while the daemon restarts keeps its slot", async () => {
  const before = await serve();
  const [a, b] = ["a", "b"].map((name) => checkout(name));
  if (!a || !b) throw new Error("no checkouts");
  const first = check(a);
  await until(() => log().includes("start a"));
  before.kill();
  await before.exited;
  // The new daemon holds new checks back long enough for the running suite to come back first.
  await serve(2000);
  const second = check(b);
  await until(() => second.said.out.includes("number 1 in line"));
  await Bun.sleep(2500);
  expect(log()).toBe("start a\n");
  writeFileSync(join(a, "done"), "");
  expect((await first.ended).code).toBe(0);
  await until(() => log().includes("start b"));
  writeFileSync(join(b, "done"), "");
  expect((await second.ended).code).toBe(0);
}, 60_000);

test("runs the test commands in one shell, so a cd or an export holds for the next", async () => {
  config(
    'test: ["export WHO=me", "cd sub", "echo \\"$WHO $(basename \\"$PWD\\")\\" > \\"$HOME/where\\""]\n',
  );
  await serve();
  const folder = checkout("a");
  mkdirSync(join(folder, "sub"));
  expect((await check(folder).ended).code).toBe(0);
  expect(read(join(home, "where"))).toBe("me sub\n");
}, 60_000);

test("says when no test command is configured, and runs nothing when it is configured as none", async () => {
  config("");
  await serve();
  const folder = checkout("a");
  const missing = await check(folder).ended;
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("no test command is configured for this repository");
  config("test: []\n");
  const none = await check(folder).ended;
  expect(none.code).toBe(0);
  expect(none.out).toContain("configured with no tests");
}, 60_000);

test("refuses a checkout of a repository Skelcrew doesn't have", async () => {
  await serve();
  const other = await check(checkout("b", "https://example.com/simon/other.git")).ended;
  expect(other.code).toBe(1);
  expect(other.err).toContain("run sc check in a checkout of a repository Skelcrew has");
  expect(log()).toBe("");
}, 60_000);
