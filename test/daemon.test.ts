// skel serve and the lead it keeps, against a fake Claude Code on a tmux server of the test's own.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

const leadFolder = () => join(home, ".local", "share", "skel", "lead");

// Stands in for Claude Code, staying up like the real one until its session ends. It runs in
// the lead's sandbox, where the home folder is hidden, so it notes its calls in the lead's
// folder.
function fakeClaude(body: string): void {
  writeFileSync(
    join(home, "bin", "claude"),
    `#!/bin/sh\necho "claude $*" >> "${leadFolder()}/calls"\n${body}\n`,
    { mode: 0o755 },
  );
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-daemon-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  fakeClaude("exec sleep 300");
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
const claudeLines = () =>
  existsSync(join(leadFolder(), "calls"))
    ? readFileSync(join(leadFolder(), "calls"), "utf8").split("\n").filter(Boolean)
    : [];
// Only how each start picks its session, which is what these tests are about.
const claudeCalls = () =>
  claudeLines()
    .map((line) => `${line.match(/--(session-id|resume) \S+/)?.[0] ?? line}\n`)
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

// Adds a repository as skel init would leave it, with one file in it.
function addRepository(name: string): string {
  const repo = join(home, "code", name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README"), `${name}\n`);
  Bun.spawnSync(["git", "-C", repo, "init", "-q"]);
  const db = join(import.meta.dir, "..", "src", "db.ts");
  const script = `import { openDb } from ${JSON.stringify(db)};
openDb().run("INSERT INTO repositories (name, path, owner, repo) VALUES (?, ?, 'simon', ?)", [${JSON.stringify(name)}, ${JSON.stringify(repo)}, ${JSON.stringify(name)}]);`;
  const added = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home },
    stderr: "pipe",
  });
  if (!added.success) throw new Error(added.stderr.toString());
  return repo;
}

// Claude Code saves a conversation once it has a message, which a fake can't send. It keeps
// it in the session's own config folder, under projects/, in a folder named after the
// session's folder with every character but letters and digits made a dash.
function saveTranscript(id: string, folderName = leadFolder().replace(/[^a-zA-Z0-9]/g, "-")): void {
  const folder = join(home, ".local", "share", "skel", "claude", "lead", "projects", folderName);
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

// bubblewrap can't start inside skel's own sandbox, so only there the lead can't start.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("with the lead", () => {
  test("starts the lead in its folder with a session id it stores", async () => {
    setUp();
    serve();
    await until(() => claudeLines().length > 0);
    const id = storedSession();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(claudeCalls()).toBe(`--session-id ${id}\n`);
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
    await until(() => claudeLines().length > 0);
    const id = storedSession();
    saveTranscript(id);
    await stop(first);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
    serve();
    await until(() => claudeCalls().includes("--resume"));
    expect(claudeCalls()).toBe(`--session-id ${id}\n--resume ${id}\n`);
    expect(storedSession()).toBe(id);
  });

  // Claude Code can't resume a conversation it never saved, nor start a new one under its id.
  test("starts a lead nobody talked to afresh, with a new session id", async () => {
    setUp();
    const first = serve();
    await until(() => claudeLines().length > 0);
    const id = storedSession();
    await stop(first);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
    serve();
    await until(() => claudeLines().length > 1);
    const fresh = storedSession();
    expect(fresh).not.toBe(id);
    expect(claudeCalls()).toBe(`--session-id ${id}\n--session-id ${fresh}\n`);
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
    fakeClaude("echo 'claude: something broke'; exit 1");
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
    await until(hasLead);
    expect(calls()).toContain(
      `systemd-run --user --scope --quiet --unit=skel-tmux-${socket} -- tmux -L ${socket} `,
    );
  });

  test("of two daemons started together, exactly one keeps running", async () => {
    setUp();
    const both = [serve(), serve()];
    await untilAnswers();
    await Bun.sleep(1000);
    expect(both.filter((run) => run.exitCode === null)).toHaveLength(1);
    expect(claudeLines()).toHaveLength(1);
  });

  test("leaves a lead that is still running alone", async () => {
    setUp();
    const first = serve();
    await until(() => claudeLines().length > 0);
    await stop(first);
    expect(existsSync(cliSocket())).toBe(false);
    const second = serve();
    await untilAnswers();
    await stop(second);
    expect(claudeCalls()).toBe(`--session-id ${storedSession()}\n`);
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

  test("starts the lead in its sandbox, with opus, seeing every added repository", async () => {
    setUp();
    const repo = addRepository("app");
    fakeClaude(
      `ls ${repo} > seen; test -S "$SKEL_SOCKET" && echo socket >> seen; test -e ${home}/.config/skel/claude-token || echo token-hidden >> seen; exec sleep 300`,
    );
    serve();
    await until(() => existsSync(join(leadFolder(), "seen")));
    await until(() => readFileSync(join(leadFolder(), "seen"), "utf8").includes("hidden"));
    expect(readFileSync(join(leadFolder(), "seen"), "utf8")).toBe("README\nsocket\ntoken-hidden\n");
    expect(claudeLines()[0]).toContain("--model opus");
  });

  test("a transcript in your own ~/.claude doesn't bring the lead back", async () => {
    setUp();
    const first = serve();
    await until(() => claudeLines().length > 0);
    const id = storedSession();
    mkdirSync(join(home, ".claude", "projects", "-some-folder"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "-some-folder", `${id}.jsonl`), "{}\n");
    await stop(first);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
    serve();
    await until(() => claudeLines().length > 1);
    expect(claudeCalls()).not.toContain("--resume");
  });

  test("of two daemons started together over a stale socket, exactly one keeps running", async () => {
    setUp();
    const first = serve();
    await untilAnswers();
    first.kill("SIGKILL");
    await first.exited;
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
    const both = [serve(), serve()];
    await untilAnswers();
    await Bun.sleep(1000);
    expect(both.filter((run) => run.exitCode === null)).toHaveLength(1);
    expect(await answers()).toBe(true);
  });

  test("restarts the lead with --resume when asked, so it sees a repository added since", async () => {
    setUp();
    const repo = join(home, "code", "app");
    fakeClaude(`ls ${repo} > seen 2>/dev/null; exec sleep 300`);
    serve();
    await until(() => claudeLines().length > 0);
    const id = storedSession();
    saveTranscript(id);
    addRepository("app");
    expect(await ask({ command: "lead", restart: true })).toEqual({ lead: true });
    expect(claudeCalls()).toBe(`--session-id ${id}\n--resume ${id}\n`);
    expect(readFileSync(join(leadFolder(), "seen"), "utf8")).toBe("README\n");
    expect(hasLead()).toBe(true);
  });

  // The lead outlives the daemon, so it must reach the next one on the socket it was given.
  test("the lead reaches the daemon again after it restarts", async () => {
    setUp();
    const asker = `const c = require("node:net").createConnection(process.env.SKEL_SOCKET);
c.on("connect", () => c.write('{"command":"status"}\\n'));
c.on("data", (d) => process.stdout.write(d));
c.on("error", () => process.exit(1));`;
    writeFileSync(join(home, "bin", "ask.js"), asker);
    fakeClaude(
      `while true; do bun ${join(home, "bin", "ask.js")} > reply.new 2>/dev/null; mv reply.new reply; sleep 0.2; done`,
    );
    const reply = () =>
      existsSync(join(leadFolder(), "reply"))
        ? readFileSync(join(leadFolder(), "reply"), "utf8")
        : "";
    const first = serve();
    await until(() => reply().includes(`"pid":${first.pid}`));
    await stop(first);
    const second = serve();
    await until(() => reply().includes(`"pid":${second.pid}`));
  }, 15_000);
});
