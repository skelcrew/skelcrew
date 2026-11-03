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
const cliSocket = () => join(home, "run", "skel.sock");

// Whether a daemon answers a status request on the CLI socket.
function answers(): Promise<boolean> {
  return new Promise((done) => {
    const connection = createConnection(cliSocket());
    connection.on("connect", () => connection.write('{"command":"status"}\n'));
    connection.on("data", (data) => {
      connection.end();
      done(JSON.parse(data.toString()).running === true);
    });
    connection.on("error", () => done(false));
  });
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
  expect(calls()).toBe(`claude --session-id ${id}\n`);
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
  await stop(first);
  Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
  serve();
  await until(() => calls().includes("--resume"));
  expect(calls()).toBe(`claude --session-id ${id}\nclaude --resume ${id}\n`);
  expect(storedSession()).toBe(id);
});

test("leaves a lead that is still running alone", async () => {
  setUp();
  const first = serve();
  await until(hasLead);
  await stop(first);
  expect(existsSync(cliSocket())).toBe(false);
  const second = serve();
  await untilAnswers();
  await stop(second);
  expect(calls()).toBe(`claude --session-id ${storedSession()}\n`);
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
