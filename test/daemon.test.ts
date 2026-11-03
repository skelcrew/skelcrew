// skel serve and the lead it keeps, against a fake Claude Code on a tmux server of the test's own.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const daemon = join(import.meta.dir, "..", "src", "daemon.ts");
let home = "";
let socket = "";
const running: Subprocess[] = [];

function fake(name: string, body: string): void {
  writeFileSync(
    join(home, "bin", name),
    `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`,
    { mode: 0o755 },
  );
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-daemon-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  // Stands in for Claude Code, staying up like the real one until its session ends.
  fake("claude", "exec sleep 300");
  // serve has no reason to call these, but if it did, the real ones must never run.
  fake("systemctl", "exit 0");
  fake("loginctl", "exit 0");
  // Runs what it is given in place, so the test sees the call without touching your systemd.
  fake("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
});
afterEach(async () => {
  for (const serve of running.splice(0)) {
    serve.kill();
    await serve.exited;
  }
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  // tmux leaves the socket file behind after kill-server.
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
});

function setUp(): void {
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skel.service"), "");
}

// Runs the daemon as skel serve would, but on the test's own tmux server.
function serve(): Subprocess<"ignore", "pipe", "pipe"> {
  const script = `import { serve } from ${JSON.stringify(daemon)};
await serve(${JSON.stringify(socket)});`;
  const run = Bun.spawn([process.execPath, "-e", script], {
    env: {
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(run);
  return run;
}

async function stop(run: Subprocess): Promise<void> {
  run.kill();
  await run.exited;
}

async function until(done: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("gave up waiting");
    await Bun.sleep(20);
  }
}

const hasLead = () =>
  Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", "=lead"], { stderr: "pipe" }).success;
const calls = () =>
  existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";
const claudeCalls = () =>
  calls()
    .split("\n")
    .filter((line) => line.startsWith("claude"))
    .map((line) => `${line}\n`)
    .join("");
const cliSocket = () => join(home, "run", "skel.sock");

// What the daemon replies on the CLI socket, or null when nothing answers.
function ask(request: object): Promise<unknown> {
  return new Promise((done) => {
    const connection = createConnection(cliSocket());
    let reply = "";
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (data) => {
      reply += data.toString();
    });
    connection.on("close", () => done(reply ? JSON.parse(reply) : null));
    connection.on("error", () => {});
  });
}

async function answers(): Promise<boolean> {
  const reply = await ask({ command: "status" });
  return Boolean(reply && typeof reply === "object" && "running" in reply && reply.running);
}

async function untilAnswers() {
  const deadline = Date.now() + 5000;
  while (!(await answers())) {
    if (Date.now() > deadline) throw new Error("the daemon never answered");
    await Bun.sleep(20);
  }
}

function storedSession(): string {
  const db = new Database(join(home, ".local", "share", "skel", "skel.db"));
  try {
    const row = db.query("SELECT session FROM lead").get();
    return row && typeof row === "object" && "session" in row ? String(row.session) : "";
  } finally {
    db.close();
  }
}

// Claude Code saves a conversation once it has a message, which a fake can't send.
function saveTranscript(id: string): void {
  const folder = join(home, ".claude", "projects", "-some-folder");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.jsonl`), "{}\n");
}

async function output(run: Subprocess<"ignore", "pipe", "pipe">) {
  const [out, err] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return out + err;
}

async function ended(run: Subprocess<"ignore", "pipe", "pipe">) {
  const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  return { err, code };
}

test("refuses to start before the first run, and says to run skel", async () => {
  const run = await ended(serve());
  expect(run.code).not.toBe(0);
  expect(run.err).toContain("run skel");
  expect(hasLead()).toBe(false);
});

test("starts the lead in its folder with a session id it stores", async () => {
  setUp();
  serve();
  await until(() => calls().includes("claude"));
  const id = storedSession();
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(claudeCalls()).toBe(`claude --session-id ${id}\n`);
  expect(existsSync(join(home, ".local", "share", "skel", "lead"))).toBe(true);
});

test("stopping the daemon leaves the lead running", async () => {
  setUp();
  const first = serve();
  await until(hasLead);
  await stop(first);
  expect(hasLead()).toBe(true);
});

test("brings back a lead whose session is gone with --resume on its stored id", async () => {
  setUp();
  const first = serve();
  await until(() => calls().includes("claude"));
  const id = storedSession();
  saveTranscript(id);
  await stop(first);
  Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
  serve();
  await until(() => calls().includes("--resume"));
  expect(claudeCalls()).toBe(`claude --session-id ${id}\nclaude --resume ${id}\n`);
  expect(storedSession()).toBe(id);
});

// Claude Code can't resume a conversation it never saved, nor start a new one under its id.
test("starts a lead nobody talked to afresh, with a new session id", async () => {
  setUp();
  const first = serve();
  await until(() => calls().includes("claude"));
  const id = storedSession();
  await stop(first);
  Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
  serve();
  await until(() => claudeCalls().split("\n").length > 2);
  const fresh = storedSession();
  expect(fresh).not.toBe(id);
  expect(claudeCalls()).toBe(`claude --session-id ${id}\nclaude --session-id ${fresh}\n`);
});

test("brings back a lead that exited while the daemon runs, when skel asks", async () => {
  setUp();
  serve();
  await untilAnswers();
  Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
  expect(await ask({ command: "lead" })).toEqual({ lead: true });
  expect(hasLead()).toBe(true);
});

test("says why when the lead exits as soon as it starts", async () => {
  setUp();
  fake("claude", "echo 'claude: something broke'; exit 1");
  const run = serve();
  await untilAnswers();
  const reply = await ask({ command: "lead" });
  expect(JSON.stringify(reply)).toContain("something broke");
  await stop(run);
  expect(await output(run)).toContain("something broke");
});

// Its own scope keeps tmux out of skel.service's cgroup, so stopping or OOM-killing the
// service can't take the agents down.
test("starts skel's tmux server in a systemd scope of its own", async () => {
  setUp();
  serve();
  await untilAnswers();
  expect(calls()).toContain(
    `systemd-run --user --scope --quiet --unit=skel-tmux-${socket} -- tmux -L ${socket} `,
  );
  expect(hasLead()).toBe(true);
});

test("of two daemons started together, exactly one keeps running", async () => {
  setUp();
  const both = [serve(), serve()];
  await untilAnswers();
  await Bun.sleep(1000);
  expect(both.filter((run) => run.exitCode === null)).toHaveLength(1);
  expect(claudeCalls().split("\n")).toHaveLength(2);
});

test("leaves a lead that is still running alone", async () => {
  setUp();
  const first = serve();
  await untilAnswers();
  await stop(first);
  expect(existsSync(cliSocket())).toBe(false);
  const second = serve();
  await untilAnswers();
  await stop(second);
  expect(claudeCalls()).toBe(`claude --session-id ${storedSession()}\n`);
});

test("refuses a second daemon and points to skel", async () => {
  setUp();
  serve();
  await untilAnswers();
  const second = await ended(serve());
  expect(second.code).not.toBe(0);
  expect(second.err).toContain("already running");
  expect(second.err).toContain("skel");
  expect(await answers()).toBe(true);
});

test("starts after a daemon that was killed left its socket behind", async () => {
  setUp();
  const first = serve();
  await untilAnswers();
  first.kill("SIGKILL");
  await first.exited;
  expect(await answers()).toBe(false);
  serve();
  await untilAnswers();
});
