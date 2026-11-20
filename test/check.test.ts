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
// its shell's process in the checkout's `pid`. It holds its check slot until the test creates
// `done` in that checkout, and ends with the code the checkout's `code` file holds, or 0.
const suite = [
  'echo "start $(basename "$PWD")" >> "$HOME/log"',
  "echo $$ > pid",
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

// Starts the daemon and waits for its socket, which it makes once it listens. Returns the
// daemon, for a test that restarts it.
async function serve(): Promise<Subprocess> {
  rmSync(join(home, "run", "skelcrew.sock"), { force: true });
  const daemon = startDaemon(socket, env(), running);
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

// Returns whether the suite started in the checkout still runs. A suite that ended can stay a
// zombie, as the test runner takes in orphans without reaping them, so one counts as ended.
function suiteRuns(folder: string): boolean {
  const pid = read(join(folder, "pid")).trim();
  if (!pid) return false;
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", pid]).stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
}

test("a check killed while it waits gives back its place, and one killed while it runs ends its suite", async () => {
  await serve();
  const [a, b, c] = ["a", "b", "c"].map((name) => checkout(name));
  if (!a || !b || !c) throw new Error("no checkouts");
  const first = check(a);
  await until(() => log().includes("start a") && suiteRuns(a));
  const waiting = check(b);
  await until(() => waiting.said.out.includes("in line"));
  waiting.run.kill("SIGKILL");
  await waiting.run.exited;
  const third = check(c);
  await until(() => third.said.out.includes("number 1 in line"));
  // Killed outright, sc check takes its suite with it, which frees the slot for the next in
  // line, not for the one killed while waiting.
  first.run.kill("SIGKILL");
  await until(() => !suiteRuns(a));
  await until(() => log().includes("start c"));
  writeFileSync(join(c, "done"), "");
  expect((await third.ended).code).toBe(0);
  expect(log()).toBe("start a\nstart c\nend c\n");
}, 60_000);

test("a process the suite detaches is outside the check: it neither ends with sc check nor holds the slot", async () => {
  // The suite starts a process in a session of its own, as Bun's detached spawn does, without
  // the daemon's connection, then waits.
  const detach = `${JSON.stringify(process.execPath)} -e 'const c = Bun.spawn(["sleep", "60"], { detached: true, stdio: ["ignore", "ignore", "ignore"] }); await Bun.write("child", String(c.pid)); c.unref()'`;
  config(`limits: { checks: 1 }\ntest: ${JSON.stringify([detach, ...suite])}\n`);
  await serve();
  const [a, b] = ["a", "b"].map((name) => checkout(name));
  if (!a || !b) throw new Error("no checkouts");
  const first = check(a);
  await until(() => log().includes("start a") && suiteRuns(a));
  const child = Number(read(join(a, "child")));
  first.run.kill("SIGKILL");
  await until(() => !suiteRuns(a));
  // The slot is free for the next check while the detached process runs on.
  const second = check(b);
  await until(() => log().includes("start b"));
  const alive = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(child)])
    .stdout.toString()
    .trim();
  expect(alive).not.toBe("");
  expect(alive.startsWith("Z")).toBe(false);
  writeFileSync(join(b, "done"), "");
  expect((await second.ended).code).toBe(0);
  // The second suite detached one too. The test ends both, as nothing else will.
  for (const folder of [a, b]) process.kill(Number(read(join(folder, "child"))), "SIGKILL");
}, 60_000);

test("a server the suite leaves running, such as tmux, doesn't hold the slot once sc check ends", async () => {
  // tmux keeps every descriptor its caller had open and moves into a session of its own, so it
  // outlives the suite and its process group. It runs on a socket of this test's own.
  const leftover = `${socket}-leftover`;
  const start = `tmux -L ${leftover} -f /dev/null new-session -d 'sleep 60'`;
  config(`limits: { checks: 1 }\ntest: ${JSON.stringify([start, ...suite])}\n`);
  await serve();
  const [a, b] = ["a", "b"].map((name) => checkout(name));
  if (!a || !b) throw new Error("no checkouts");
  try {
    const first = check(a);
    await until(() => log().includes("start a"));
    writeFileSync(join(a, "done"), "");
    expect((await first.ended).code).toBe(0);
    // The leftover server runs on, and the next check starts without waiting in line.
    const alive = Bun.spawnSync(["tmux", "-L", leftover, "has-session"], {
      env: env(),
    });
    expect(alive.success).toBe(true);
    const second = check(b);
    await until(() => log().includes("start b"));
    expect(second.said.out).not.toContain("in line");
    writeFileSync(join(b, "done"), "");
    expect((await second.ended).code).toBe(0);
  } finally {
    Bun.spawnSync(["tmux", "-L", leftover, "kill-server"], { env: env() });
  }
}, 60_000);

test("sc check killed with its whole process group, as a reviewer is, ends the suite and frees the slot", async () => {
  await serve();
  const [a, b] = ["a", "b"].map((name) => checkout(name));
  if (!a || !b) throw new Error("no checkouts");
  // A reviewer runs sc check in a process group of its own, and ending a review kills the whole
  // group at once. The review itself is in submit-limits.test.ts, as it needs a real sandbox.
  const reviewer = Bun.spawn(
    ["sh", "-c", `${JSON.stringify(process.execPath)} "$0" check`, source("main.ts")],
    {
      cwd: a,
      env: env(),
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    },
  );
  await until(() => log().includes("start a") && suiteRuns(a));
  const second = check(b);
  await until(() => second.said.out.includes("number 1 in line"));
  process.kill(-reviewer.pid, "SIGKILL");
  await reviewer.exited;
  await until(() => !suiteRuns(a));
  await until(() => log().includes("start b"));
  writeFileSync(join(b, "done"), "");
  expect((await second.ended).code).toBe(0);
  expect(log()).toBe("start a\nstart b\nend b\n");
}, 60_000);

test("sc ps says who holds a check slot, naming only that it is another repository's for one asked about", async () => {
  // Skelcrew also has simon/other, whose sc ps must not name who holds a slot in simon/app.
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo, remote) VALUES ('other', 'simon', 'other', 'https://example.com/simon/other.git')");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  await serve();
  const folder = checkout("a");
  const ps = (...words: string[]) =>
    Bun.spawnSync([process.execPath, source("main.ts"), "ps", ...words], {
      env: env(),
      stdout: "pipe",
    }).stdout.toString();
  const running = check(folder);
  try {
    await until(() => log().includes("start a"));
    expect(ps()).toContain("You hold a check slot, for less than a minute.");
    expect(ps("app")).toContain("You hold a check slot");
    expect(ps("other")).toContain("Another repository holds a check slot");
  } finally {
    writeFileSync(join(folder, "done"), "");
  }
  expect((await running.ended).code).toBe(0);
  await until(() => !ps().includes("check slot"));
}, 60_000);

test("a daemon restart frees the slots, and a suite running then finishes on its own", async () => {
  const before = await serve();
  const [a, b] = ["a", "b"].map((name) => checkout(name));
  if (!a || !b) throw new Error("no checkouts");
  const first = check(a);
  await until(() => log().includes("start a") && suiteRuns(a));
  before.kill();
  await before.exited;
  await serve();
  // The new daemon counts from none, so the next check starts beside the running suite.
  const second = check(b);
  await until(() => log().includes("start b"));
  expect(second.said.out).not.toContain("in line");
  expect(suiteRuns(a)).toBe(true);
  writeFileSync(join(a, "code"), "3");
  writeFileSync(join(a, "done"), "");
  expect((await first.ended).code).toBe(3);
  writeFileSync(join(b, "done"), "");
  expect((await second.ended).code).toBe(0);
  expect(log()).toBe("start a\nstart b\nend a\nend b\n");
}, 60_000);

test("the test commands read what sc check is given on its input", async () => {
  config('test: [\'read answer; echo "got $answer" > "$HOME/answer"\']\n');
  await serve();
  const folder = checkout("a");
  const run = Bun.spawn([process.execPath, source("main.ts"), "check"], {
    cwd: folder,
    env: env(),
    stdin: Buffer.from("yes\n"),
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await run.exited).toBe(0);
  expect(read(join(home, "answer"))).toBe("got yes\n");
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
