// sc serve and the lead it keeps, against a fake Claude Code on a tmux server of the test's own.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { leadPlaces } from "../src/paths.ts";
import { asked, fakePlugin, read, source, until as wait } from "./harness.ts";

const main = source("main.ts");
const daemon = source("flow/daemon.ts");
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

// The name of a repository's lead's session and config folder, and the folder it works in.
const leadName = (repo = "app") => leadPlaces("simon", repo).name;
const leadFolder = (repo = "app") =>
  join(home, ".local", "share", "skelcrew", "leads", "simon", repo);

// Stands in for Claude Code, staying up like the real one until its session ends. It runs in
// the lead's sandbox, where the home folder is hidden, so it notes its calls in the folder it
// starts in, the lead's own, one line each, though the lead's instructions span several.
function fakeClaude(body: string): void {
  writeFileSync(
    join(home, "bin", "claude"),
    `#!/bin/sh\necho "claude $*" | tr '\\n' ' ' >> calls\necho >> calls\n${body}\n`,
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
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
}

// Runs the daemon as Skelcrew serve would, but on the test's own tmux server. Given a port, a
// daemon on a Sprite listens there for wake-ups, in place of the Sprite's own.
function serve(runtime = join(home, "run"), port?: number): Subprocess<"ignore", "pipe", "pipe"> {
  const more = port === undefined ? "" : `, 30_000, ${port}`;
  const script = `import { serve } from ${JSON.stringify(daemon)};
await serve(${JSON.stringify(socket)}${more});`;
  const run = Bun.spawn([process.execPath, "-e", script], {
    env: {
      HOME: home,
      XDG_RUNTIME_DIR: runtime,
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

// Waits for what the daemon does in its own time, looking often. A busy machine can take many
// seconds to start a daemon, so the limit is generous: it only ends a test that hangs.
const until = (done: () => boolean) => wait(done, { timeout: 30_000, every: 20 });

const hasServer = () =>
  Bun.spawnSync(["tmux", "-L", socket, "list-sessions"], { stderr: "pipe" }).success;
const hasLead = (name = leadName()) =>
  Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", `=${name}`], { stderr: "pipe" })
    .success;
// Ends a lead's session, as when it exited or the machine restarted.
const endLead = (name = leadName()) =>
  Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", `=${name}`]);
const calls = () =>
  existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";
const claudeLines = (folder = leadFolder()) =>
  existsSync(join(folder, "calls"))
    ? readFileSync(join(folder, "calls"), "utf8").split("\n").filter(Boolean)
    : [];
// Only how each start picks its session, which is what these tests are about.
const claudeCalls = (folder = leadFolder()) =>
  claudeLines(folder)
    .map((line) => `${line.match(/--(session-id|resume) \S+/)?.[0] ?? line}\n`)
    .join("");
const cliSocket = () => join(home, "run", "skelcrew.sock");

// What the daemon replies on the CLI socket, or null when nothing answers. The error
// listener goes on before connecting: in a test, Bun can report a connect to a missing
// socket as an error of the test when the listener is added after createConnection.
function ask(request: object): Promise<unknown> {
  return new Promise((done) => {
    const connection = new Socket();
    connection.on("error", () => {});
    let reply = "";
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (data) => {
      reply += data.toString();
    });
    connection.on("close", () => done(reply ? JSON.parse(reply) : null));
    connection.connect(cliSocket());
  });
}

async function answers(): Promise<boolean> {
  const reply = await ask({ command: "status" });
  return Boolean(reply && typeof reply === "object" && "running" in reply && reply.running);
}

async function untilAnswers() {
  const deadline = Date.now() + 30_000;
  while (!(await answers())) {
    if (Date.now() > deadline) throw new Error("the daemon never answered");
    await Bun.sleep(20);
  }
}

// Runs SQL on Skelcrew's database, as the daemon may be using it at the same time.
function onDb<T>(use: (db: Database) => T): T {
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  // The daemon may be writing, and a read that meets a write fails without a wait.
  db.run("PRAGMA busy_timeout = 5000");
  try {
    return use(db);
  } finally {
    db.close();
  }
}

function storedSession(repo = "app"): string {
  const row = onDb((db) =>
    db.query("SELECT lead_session FROM repositories WHERE repo = ?").get(repo),
  );
  return row && typeof row === "object" && "lead_session" in row ? String(row.lead_session) : "";
}

// Marks a repository as one you opened before, whose lead the daemon brings back as it starts.
const openedBefore = (repo = "app") =>
  onDb((db) => db.run("UPDATE repositories SET opened = 1 WHERE repo = ?", [repo]));

// git in the test reaches GitHub through this folder: its ~/.gitconfig sends every
// https://github.com/ URL here.
const github = () => join(home, "github");

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    {
      stderr: "pipe",
    },
  );
  if (!run.success) throw new Error(run.stderr.toString());
}

// Puts a repository with one file on the fake GitHub, and returns a checkout to push from.
function onGitHub(name: string): string {
  const work = join(home, "work", name);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), `${name}\n`);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(github(), "simon", `${name}.git`));
  git(work, "remote", "add", "origin", join(github(), "simon", `${name}.git`));
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${github()}/"]\n\tinsteadOf = https://github.com/\n`,
  );
  return work;
}

// A repository Skelcrew knows of, as one brought in before leaves it. Returns where Skelcrew keeps
// its clone.
function addRepository(name: string): string {
  onGitHub(name);
  const db = source("db.ts");
  const script = `import { openDb } from ${JSON.stringify(db)};
openDb().run("INSERT INTO repositories (name, owner, repo, remote) VALUES (?, 'simon', ?, ?)", [${JSON.stringify(name)}, ${JSON.stringify(name)}, ${JSON.stringify(`https://github.com/simon/${name}.git`)}]);`;
  const added = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home },
    stderr: "pipe",
  });
  if (!added.success) throw new Error(added.stderr.toString());
  return join(home, ".local", "share", "skelcrew", "repos", "simon", name);
}

// Claude Code saves a conversation once it has a message, which a fake can't send. It keeps
// it in the session's own config folder, under projects/, in a folder named after the
// session's folder with every character but letters and digits made a dash.
function saveTranscript(id: string, name = leadName(), lead = leadFolder()): void {
  const projects = join(home, ".local", "share", "skelcrew", "claude", name, "projects");
  const folder = join(projects, lead.replace(/[^a-zA-Z0-9]/g, "-"));
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

test("refuses to start before the first run, and says to run sc", async () => {
  const run = await ended(serve());
  expect(run.code).not.toBe(0);
  expect(run.err).toContain("run sc");
  expect(hasLead()).toBe(false);
});

test("sc serve refuses inside Skelcrew's sandbox, where Skelcrew's state is hidden", async () => {
  setUp();
  const run = Bun.spawnSync([process.execPath, main, "serve"], {
    env: {
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      SKELCREW_SANDBOX: "1",
    },
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toBe(
    "Skelcrew: running the daemon is only for your own terminal, not for agents\n",
  );
  expect(existsSync(join(home, "run", "skelcrew.sock"))).toBe(false);
});

// As on a Sprite, where the socket's folder is one of Skelcrew's own, not one systemd made.
test("makes the folder for its socket, which only you can open", async () => {
  setUp();
  const folder = join(home, "fresh", "run");
  serve(folder);
  await until(() => existsSync(join(folder, "skelcrew.sock")));
  expect(statSync(folder).mode & 0o777).toBe(0o700);
});

test("says which release it runs, so Skelcrew can restart one on an older release", async () => {
  setUp();
  const script = `import { serve } from ${JSON.stringify(daemon)};
await serve(${JSON.stringify(socket)});`;
  running.push(
    Bun.spawn([process.execPath, "--define", 'SKELCREW_BUILD="0.4.2"', "-e", script], {
      env: {
        HOME: home,
        XDG_RUNTIME_DIR: join(home, "run"),
        PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      },
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  await until(() => existsSync(cliSocket()));
  expect(await ask({ command: "status" })).toMatchObject({ running: true, release: "0.4.2" });
});

test("says which checkout and commit it started from, so Skelcrew can restart it after git pull", async () => {
  setUp();
  serve();
  await until(() => existsSync(cliSocket()));
  const checkout = join(source(), "..");
  const commit = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "--short", "HEAD"])
    .stdout.toString()
    .trim();
  expect(await ask({ command: "status" })).toMatchObject({ folder: checkout, commit });
});

// Skelcrew takes a machine with sprite-env, the Sprite's own tool, on its PATH for a Sprite. Like
// the real one, it starts a service as it creates it.
function onSprite(): void {
  fake(
    "sprite-env",
    `case "$*" in
  "services get skelcrew") exit 0 ;;
  info) echo '{"sprite_name":"demo","sprite_url":"https://demo-simon.sprites.app"}'; exit 0 ;;
  "services create skelcrew-tmux-${socket} --cmd tmux --args -L,${socket},-f,/dev/null,-D --no-stream")
    test -f "$HOME/tmux-service" && exit 0
    : > "$HOME/tmux-service"
    setsid tmux -L ${socket} -f /dev/null -D < /dev/null > /dev/null 2>&1 &
    exit 0 ;;
  "services start skelcrew-tmux-${socket}")
    setsid tmux -L ${socket} -f /dev/null -D < /dev/null > /dev/null 2>&1 &
    exit 0 ;;
esac
exit 1`,
  );
}

test("on a Sprite, starts once the first run installed its Sprite service", async () => {
  setUp();
  rmSync(join(home, ".config", "systemd"), { recursive: true });
  onSprite();
  serve();
  await until(() => existsSync(cliSocket()));
  expect(await answers()).toBe(true);
});

// Creating a service that exists already does nothing, even when it is stopped, and a tmux
// server started without it would end with the daemon's service.
test("on a Sprite, starts Skelcrew's tmux service again when it has stopped", async () => {
  setUp();
  onSprite();
  addRepository("app");
  openedBefore();
  writeFileSync(join(home, "tmux-service"), "");
  serve();
  await until(() => calls().includes("services start skelcrew-tmux"));
  await until(hasServer);
  expect(calls()).not.toContain("systemd-run");
});

// A Sprite service ends every process it started when it stops, so a tmux server the
// daemon started would take every agent with it.
test("on a Sprite, starts Skelcrew's tmux server as a Sprite service of its own", async () => {
  setUp();
  onSprite();
  addRepository("app");
  openedBefore();
  serve();
  await until(() => calls().includes("tmux"));
  await until(hasServer);
  expect(calls()).toContain(
    `sprite-env services create skelcrew-tmux-${socket} --cmd tmux --args -L,${socket},-f,/dev/null,-D --no-stream\n`,
  );
});

// A port nothing listens on, for the daemon's listener for wake-ups.
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

// The fake forge's settings folder, where it keeps what it is asked.
let forge = "";

// Makes the fake plugin the forge of the repositories Skelcrew has. It fails every poll, which
// still counts as one.
function fakeForge(): void {
  forge = fakePlugin(home, "github", ["forge"]);
  writeFileSync(join(forge, "fail-changed"), "HTTP 502: Bad Gateway");
  onDb((db) =>
    db.run(
      "UPDATE repositories SET forge = 'github', claimed = 1, remote = 'https://github.com/' || owner || '/' || repo || '.git'",
    ),
  );
}

const polls = () => asked(forge).filter((q) => q.ask === "changed").length;

// Sends a delivery to the daemon's listener, for a plugin's name.
const deliver = (port: number, plugin: string) =>
  fetch(`http://127.0.0.1:${port}/${plugin}`, { method: "POST", body: "{}" });

// Returns whether anything answers on the port.
const listening = (port: number) =>
  fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  );

async function untilListening(port: number) {
  const deadline = Date.now() + 30_000;
  while (!(await listening(port))) {
    if (Date.now() > deadline) throw new Error("nothing listened");
    await Bun.sleep(20);
  }
}

// A forge can't wake a sleeping Sprite's daemon any other way, and polling is what reads it.
test("on a Sprite, a delivery for a plugin has the daemon poll its repositories at once", async () => {
  setUp();
  onSprite();
  addRepository("app");
  fakeForge();
  const port = freePort();
  serve(undefined, port);
  await until(() => polls() === 1);
  await untilListening(port);
  expect((await deliver(port, "github")).status).toBe(202);
  await until(() => polls() === 2);
});

// A wake-up comes while the forge may be failing, and the daemon must outlive the poll it
// starts.
test("on a Sprite, a plugin's wake-up whose poll fails leaves the daemon running", async () => {
  setUp();
  onSprite();
  addRepository("app");
  fakeForge();
  const port = freePort();
  const run = serve(undefined, port);
  await until(() => polls() === 1);
  await untilListening(port);
  expect((await deliver(port, "github")).status).toBe(202);
  await until(() => polls() === 2);
  await Bun.sleep(500);
  expect(run.exitCode).toBeNull();
  expect(await answers()).toBe(true);
});

test("on a Sprite, a delivery for no plugin of a repository polls nothing", async () => {
  setUp();
  onSprite();
  addRepository("app");
  fakeForge();
  const port = freePort();
  serve(undefined, port);
  await until(() => polls() === 1);
  await untilListening(port);
  expect((await deliver(port, "other")).status).toBe(404);
  expect((await deliver(port, "")).status).toBe(404);
  await Bun.sleep(500);
  expect(polls()).toBe(1);
});

test("on a Sprite, asks each repository's forge to pass on its wake-ups to the Sprite", async () => {
  setUp();
  onSprite();
  addRepository("app");
  fakeForge();
  serve(undefined, freePort());
  await until(() => asked(forge).some((q) => q.ask === "wake"));
  expect(asked(forge).filter((q) => q.ask === "wake")).toEqual([
    { ask: "wake", repository: "simon/app", url: "https://demo-simon.sprites.app/github" },
  ]);
});

// A server stays awake, so polling alone sees every event soon enough.
test("on a server, neither listens for wake-ups nor asks for them", async () => {
  setUp();
  addRepository("app");
  fakeForge();
  const port = freePort();
  serve(undefined, port);
  await until(() => polls() === 1);
  await Bun.sleep(500);
  expect(await listening(port)).toBe(false);
  expect(asked(forge).filter((q) => q.ask === "wake")).toEqual([]);
});

// Asks the daemon to open a repository, as plain sc in a checkout of it does.
const open = (repo = "app") => ask({ command: "lead", from: `simon/${repo}` });

// The socket the daemon opens for a repository's lead, which tells it which lead calls. The
// lead from before keeps its own.
const leadSocket = (repo = "app") => {
  const short = new Bun.CryptoHasher("sha256").update(`simon/${repo}`).digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "leads", short, "skelcrew.sock");
};
const keptSocket = () => join(home, "run", "skelcrew", "lead", "skelcrew.sock");

// What the daemon replies on a lead's socket, or null when nothing answers. Like ask, it
// listens for errors before connecting.
function askAsLead(request: object, path = leadSocket()): Promise<unknown> {
  return new Promise((done) => {
    const connection = new Socket();
    connection.on("error", () => {});
    let reply = "";
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (data) => {
      reply += data.toString();
    });
    connection.on("close", () => done(reply ? JSON.parse(reply) : null));
    connection.connect(path);
  });
}

// Removes a repository as sc repo rm does, but on the test's own tmux server, never Skelcrew's.
// Returns what it said on stderr.
function removeRepo(name: string): string {
  const script = `import { removeRepo } from ${JSON.stringify(source("flow/repo.ts"))};
await removeRepo(${JSON.stringify(name)}, ${JSON.stringify(socket)});`;
  const removed = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}` },
    stderr: "pipe",
  });
  return removed.stderr.toString();
}

// Has the fake lead wait until the test tells it to exit, then exit with the given code. The
// wait also ends when its folder goes.
function leadExitsWhenTold(code: number): void {
  fakeClaude(`while [ ! -e exit-now ] && [ -d "$PWD" ]; do sleep 0.1; done; exit ${code}`);
}
const tellLeadToExit = () => writeFileSync(join(leadFolder(), "exit-now"), "");

// Whether the lead's session is there with its agent ended, as a lead kept on exit leaves it.
const leadDead = () =>
  Bun.spawnSync([
    "tmux",
    "-L",
    socket,
    "display-message",
    "-p",
    "-t",
    `=${leadName()}:`,
    "#{pane_dead}",
  ])
    .stdout.toString()
    .trim() === "1";

// Whether Skelcrew has closed the repository's tab.
const tabClosed = (repo = "app") =>
  JSON.stringify(
    onDb((db) => db.query("SELECT tab_closed FROM repositories WHERE repo = ?").get(repo)),
  ) === '{"tab_closed":1}';

// A stopped thread of the repository, for what lists threads.
function addThread(repo: string, task: number): void {
  onDb((db) =>
    db.run(
      `INSERT INTO threads (owner, repo, task, folder, branch, status)
        VALUES ('simon', ?, ?, ?, 'skelcrew/x', 'stopped')`,
      [repo, task, `${repo}-${task}`],
    ),
  );
}

// bubblewrap can't start inside Skelcrew's own sandbox, so only there a lead can't start.
describe.skipIf(process.env.SKELCREW_SANDBOX === "1")("with a lead per repository", () => {
  test("starts a repository's lead the first time you open it, in its own folder, with a session id it stores", async () => {
    setUp();
    addRepository("app");
    serve();
    await untilAnswers();
    await Bun.sleep(500);
    expect(hasLead()).toBe(false);
    expect(await open()).toEqual({ lead: leadName(), repository: "simon/app" });
    const id = storedSession();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(claudeCalls()).toBe(`--session-id ${id}\n`);
    expect(hasLead()).toBe(true);
  });

  test("each repository you open gets a lead of its own, which sees only its own clone", async () => {
    setUp();
    const app = addRepository("app");
    const web = addRepository("web");
    fakeClaude(
      `for r in ${app} ${web}; do test -e $r/README && echo "$r" >> seen; done; exec sleep 300`,
    );
    serve();
    await untilAnswers();
    expect(await open("app")).toEqual({ lead: leadName("app"), repository: "simon/app" });
    expect(await open("web")).toEqual({ lead: leadName("web"), repository: "simon/web" });
    expect(leadName("app")).not.toBe(leadName("web"));
    expect(hasLead(leadName("app")) && hasLead(leadName("web"))).toBe(true);
    const seen = (folder: string) => readFileSync(join(folder, "seen"), "utf8");
    await until(() => existsSync(join(leadFolder("app"), "seen")));
    await until(() => existsSync(join(leadFolder("web"), "seen")));
    expect(seen(leadFolder("app"))).toBe(`${app}\n`);
    expect(seen(leadFolder("web"))).toBe(`${web}\n`);
  });

  test("stopping the daemon leaves the lead running", async () => {
    setUp();
    addRepository("app");
    const first = serve();
    await untilAnswers();
    await open();
    await stop(first);
    expect(hasLead()).toBe(true);
  });

  test("brings back the lead of each repository you opened, with --resume on its stored id", async () => {
    setUp();
    addRepository("app");
    addRepository("web");
    const first = serve();
    await untilAnswers();
    await open();
    const id = storedSession();
    saveTranscript(id);
    await stop(first);
    endLead();
    serve();
    await until(() => claudeCalls().includes("--resume"));
    expect(claudeCalls()).toBe(`--session-id ${id}\n--resume ${id}\n`);
    expect(storedSession()).toBe(id);
    // web was never opened, so it has no lead to bring back.
    expect(hasLead(leadName("web"))).toBe(false);
  });

  // Without them it would edit code in its own folder rather than hand the work to a thread.
  test("starts and brings back the lead with its instructions, naming its repository", async () => {
    setUp();
    addRepository("app");
    const first = serve();
    await untilAnswers();
    await open();
    saveTranscript(storedSession());
    await stop(first);
    endLead();
    serve();
    await until(() => claudeCalls().includes("--resume"));
    for (const line of claudeLines()) {
      expect(line).toContain("--append-system-prompt You are a lead");
      expect(line).toContain("sc issue create");
      // The lead talks to the human, who sees issues and threads, never Skelcrew's word task.
      expect(line).not.toMatch(/\btasks?\b/i);
      expect(line).toContain("You are the lead of simon/app.");
    }
  });

  // Claude Code can't resume a conversation it never saved, nor start a new one under its id.
  test("starts a lead nobody talked to afresh, with a new session id", async () => {
    setUp();
    addRepository("app");
    const first = serve();
    await untilAnswers();
    await open();
    const id = storedSession();
    await stop(first);
    endLead();
    serve();
    await until(() => claudeLines().length > 1);
    const fresh = storedSession();
    expect(fresh).not.toBe(id);
    expect(claudeCalls()).toBe(`--session-id ${id}\n--session-id ${fresh}\n`);
  });

  test("brings back a lead that exited while the daemon runs, when Skelcrew asks", async () => {
    setUp();
    addRepository("app");
    serve();
    await untilAnswers();
    await open();
    endLead();
    expect(await open()).toEqual({ lead: leadName(), repository: "simon/app" });
    expect(hasLead()).toBe(true);
  });

  test("says why when the lead exits as soon as it starts", async () => {
    setUp();
    addRepository("app");
    openedBefore();
    fakeClaude("echo 'claude: something broke'; exit 1");
    const run = serve();
    await untilAnswers();
    const reply = await open();
    expect(JSON.stringify(reply)).toContain("something broke");
    await stop(run);
    expect(await output(run)).toContain("something broke");
  });

  test("outside a repository, opens the one you opened last", async () => {
    setUp();
    addRepository("app");
    addRepository("web");
    serve();
    await untilAnswers();
    // Before you have opened any, the first by name.
    expect(await ask({ command: "lead" })).toEqual({
      lead: leadName("app"),
      repository: "simon/app",
    });
    await open("web");
    expect(await ask({ command: "lead" })).toEqual({
      lead: leadName("web"),
      repository: "simon/web",
    });
    // One Skelcrew doesn't have, such as one waiting for sc repo trust, is no repository to open.
    expect(await ask({ command: "lead", from: "other/tool" })).toEqual({
      lead: leadName("web"),
      repository: "simon/web",
    });
  });

  test("with no repositories, there is no lead to open", async () => {
    setUp();
    serve();
    await untilAnswers();
    expect(await ask({ command: "lead" })).toEqual({
      error: "Skelcrew has no repositories yet. Run sc in a checkout of one.",
    });
  });

  // Exiting a repository's lead closes its tab, as exiting a shell closes a terminal's.
  test("a lead that exits cleanly closes its tab, changes nothing else, and comes back with its conversation", async () => {
    setUp();
    const clone = addRepository("app");
    addThread("app", 1);
    leadExitsWhenTold(0);
    serve();
    await untilAnswers();
    await open();
    const id = storedSession();
    saveTranscript(id);
    tellLeadToExit();
    await until(() => tabClosed());
    // The daemon ends the session, so nothing brings the lead back by itself.
    await until(() => !hasLead());
    expect(storedSession()).toBe(id);
    expect(existsSync(join(clone, "README"))).toBe(true);
    expect(await ask({ command: "ps" })).toEqual({
      threads: [{ thread: "app-1", status: "stopped", needsYou: false }],
    });
    expect(await ask({ command: "repo ls" })).toMatchObject({
      repositories: [{ name: "app", tabClosed: true }],
    });
    // A tab never brings it back, not even one a screen still shows, and the daemon's start
    // doesn't either.
    expect(await ask({ command: "lead", from: "simon/app", tab: true })).toEqual({
      error: "simon/app's tab is closed. Run sc in a checkout of it to open it.",
    });
    expect(tabClosed()).toBe(true);
    expect(hasLead()).toBe(false);
    // Opening the repository again opens its tab and resumes its lead.
    rmSync(join(leadFolder(), "exit-now"));
    expect(await open()).toEqual({ lead: leadName(), repository: "simon/app" });
    expect(tabClosed()).toBe(false);
    expect(claudeCalls()).toBe(`--session-id ${id}\n--resume ${id}\n`);
    expect(hasLead()).toBe(true);
  });

  test("a lead that fails keeps its tab, and opening it brings the lead back", async () => {
    setUp();
    addRepository("app");
    leadExitsWhenTold(1);
    serve();
    await untilAnswers();
    await open();
    saveTranscript(storedSession());
    tellLeadToExit();
    await until(() => leadDead());
    // Longer than the daemon takes to close a tab.
    await Bun.sleep(2000);
    expect(tabClosed()).toBe(false);
    rmSync(join(leadFolder(), "exit-now"));
    await open();
    expect(claudeCalls()).toContain("--resume");
    expect(hasLead() && !leadDead()).toBe(true);
  });

  test("a lead that exited while the daemon was down has its tab closed, and isn't brought back", async () => {
    setUp();
    addRepository("app");
    addRepository("web");
    leadExitsWhenTold(0);
    const first = serve();
    await untilAnswers();
    await open("web");
    await open("app");
    await stop(first);
    tellLeadToExit();
    await until(() => leadDead());
    const second = serve();
    await untilAnswers();
    await until(() => tabClosed());
    expect(claudeLines()).toHaveLength(1);
    // Nor at the start after.
    await stop(second);
    serve();
    await untilAnswers();
    await Bun.sleep(1000);
    expect(hasLead()).toBe(false);
    expect(claudeLines()).toHaveLength(1);
    // Outside any repository, sc opens the one you opened last whose tab is open.
    expect(await ask({ command: "lead" })).toEqual({
      lead: leadName("web"),
      repository: "simon/web",
    });
  });

  // A lead sees only its own repository, so it mustn't act on another's threads or tasks.
  test("a lead's commands reach only its own repository", async () => {
    setUp();
    addRepository("app");
    addRepository("web");
    addThread("app", 1);
    addThread("web", 2);
    serve();
    await untilAnswers();
    await open();
    expect(await askAsLead({ command: "repo ls" })).toMatchObject({
      repositories: [{ name: "app", repository: "simon/app" }],
    });
    expect(await askAsLead({ command: "ps" })).toEqual({
      threads: [{ thread: "app-1", status: "stopped", needsYou: false }],
    });
    const refused = {
      error:
        "you are the lead of simon/app only, so web isn't yours. Ask the human to open it with sc in a checkout of it: its own lead works on it.",
    };
    expect(await askAsLead({ command: "ps", repo: "web" })).toEqual(refused);
    expect(await askAsLead({ command: "stop", repo: "web", task: "2" })).toEqual(refused);
    expect(
      await askAsLead({ command: "task create", repo: "web", title: "Fix", body: "it" }),
    ).toEqual(refused);
    // Bringing in a repository by its name is gone: you add one in your own terminal.
    expect(await askAsLead({ command: "task ls", repo: "simon/site" })).toEqual({
      error: "there is no repository named simon/site",
    });
  });

  // Left running, it would go on with no repository behind it, and nothing would end it.
  test("removing a repository ends its lead, and leaves another's running", async () => {
    setUp();
    addRepository("app");
    addRepository("web");
    serve();
    await untilAnswers();
    await open("app");
    await open("web");
    expect(removeRepo("app")).toBe("");
    expect(hasLead(leadName("app"))).toBe(false);
    expect(hasLead(leadName("web"))).toBe(true);
  });

  // Its own scope keeps tmux out of skelcrew.service's cgroup, so stopping or OOM-killing the
  // service can't take the agents down.
  test("starts Skelcrew's tmux server in a systemd scope of its own", async () => {
    setUp();
    addRepository("app");
    serve();
    await untilAnswers();
    await open();
    expect(calls()).toContain(
      `systemd-run --user --scope --quiet --unit=skelcrew-tmux-${socket} -- tmux -L ${socket} `,
    );
  });

  test("of two daemons started together, exactly one keeps running", async () => {
    setUp();
    addRepository("app");
    openedBefore();
    const both = [serve(), serve()];
    await untilAnswers();
    await Bun.sleep(1000);
    expect(both.filter((run) => run.exitCode === null)).toHaveLength(1);
    expect(claudeLines()).toHaveLength(1);
  });

  test("leaves a lead that is still running alone", async () => {
    setUp();
    addRepository("app");
    openedBefore();
    const first = serve();
    await until(() => claudeLines().length > 0);
    await stop(first);
    expect(existsSync(cliSocket())).toBe(false);
    const second = serve();
    await untilAnswers();
    await stop(second);
    expect(claudeCalls()).toBe(`--session-id ${storedSession()}\n`);
  });

  test("refuses a second daemon and points to Skelcrew", async () => {
    setUp();
    serve();
    await untilAnswers();
    const second = await ended(serve());
    expect(second.code).not.toBe(0);
    expect(second.err).toContain("already running");
    expect(second.err).toContain("Run sc");
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

  test("starts the lead in its sandbox, with opus, seeing its own clone", async () => {
    setUp();
    const repo = addRepository("app");
    fakeClaude(
      `ls ${repo} > seen; test -S "$SKELCREW_SOCKET" && echo socket >> seen; test -e ${home}/.config/skelcrew/claude-token || echo token-hidden >> seen; exec sleep 300`,
    );
    serve();
    await untilAnswers();
    await open();
    await until(() => existsSync(join(leadFolder(), "seen")));
    await until(() => readFileSync(join(leadFolder(), "seen"), "utf8").includes("hidden"));
    expect(readFileSync(join(leadFolder(), "seen"), "utf8")).toBe("README\nsocket\ntoken-hidden\n");
    expect(claudeLines()[0]).toContain("--model opus");
  });

  test("starts the lead on the model your config names for it", async () => {
    setUp();
    addRepository("app");
    writeFileSync(
      join(home, ".config", "skelcrew", "config.yaml"),
      "harness: claude\nmodel: sonnet\nlead: { model: haiku }\n",
    );
    serve();
    await untilAnswers();
    await open();
    expect(claudeLines()[0]).toContain("--model haiku");
  });

  test("a transcript in your own ~/.claude doesn't bring the lead back", async () => {
    setUp();
    addRepository("app");
    const first = serve();
    await untilAnswers();
    await open();
    const id = storedSession();
    mkdirSync(join(home, ".claude", "projects", "-some-folder"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "-some-folder", `${id}.jsonl`), "{}\n");
    await stop(first);
    endLead();
    serve();
    await until(() => claudeLines().length > 1);
    expect(claudeCalls()).not.toContain("--resume");
  });

  test("of two daemons started together over a stale socket, exactly one keeps running", async () => {
    setUp();
    addRepository("app");
    openedBefore();
    const first = serve();
    await untilAnswers();
    await until(() => claudeLines().length > 0);
    first.kill("SIGKILL");
    await first.exited;
    endLead();
    const both = [serve(), serve()];
    await untilAnswers();
    await Bun.sleep(1000);
    expect(both.filter((run) => run.exitCode === null)).toHaveLength(1);
    expect(await answers()).toBe(true);
  });

  // The lead outlives the daemon, so it must reach the next one on the socket it was given.
  test("the lead reaches the daemon again after it restarts", async () => {
    setUp();
    addRepository("app");
    openedBefore();
    const asker = `const c = require("node:net").createConnection(process.env.SKELCREW_SOCKET);
c.on("connect", () => c.write('{"command":"status"}\\n'));
c.on("data", (d) => process.stdout.write(d));
c.on("error", () => process.exit(1));`;
    writeFileSync(join(home, "bin", "ask.js"), asker);
    fakeClaude(
      `for i in $(seq 300); do bun ${join(home, "bin", "ask.js")} > reply.new 2>/dev/null; mv reply.new reply; sleep 0.2; done`,
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
  }, 60_000);

  test("makes the clones of repositories whose lead never started as it starts", async () => {
    setUp();
    const clone = addRepository("app");
    serve();
    await until(() => existsSync(join(clone, "README")));
    expect(hasLead()).toBe(false);
  });

  test("moves Skelcrew's clones to the latest default branch when the lead starts", async () => {
    setUp();
    const clone = addRepository("app");
    openedBefore();
    const first = serve();
    await until(() => existsSync(join(clone, "README")));
    await until(() => claudeLines().length > 0);
    await stop(first);
    endLead();
    const work = join(home, "work", "app");
    writeFileSync(join(work, "NEWS"), "more\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "more");
    git(work, "push", "-q", "origin", "main");
    serve();
    await until(() => existsSync(join(clone, "NEWS")));
  });

  test("moves Skelcrew's clones to the latest after answering a lead request, not before", async () => {
    setUp();
    const clone = addRepository("app");
    serve();
    await until(() => existsSync(join(clone, "README")));
    await open();
    const work = join(home, "work", "app");
    writeFileSync(join(work, "NEWS"), "more\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "more");
    git(work, "push", "-q", "origin", "main");
    // A fetch held while the test leaves a file named hold, so a reply that waited for it
    // would come only once the clone had moved. Timing the reply instead failed on a busy
    // machine. The hold ends after 30 seconds, or once the test's folder is gone.
    const real = Bun.which("git") ?? "git";
    const hold = join(home, "hold");
    writeFileSync(hold, "");
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh
case " $* " in *" fetch "*)
  for i in $(seq 600); do [ -e "${hold}" ] || break; sleep 0.05; done ;;
esac
exec ${real} "$@"
`,
      { mode: 0o755 },
    );
    expect(await open()).toEqual({ lead: leadName(), repository: "simon/app" });
    expect(existsSync(join(clone, "NEWS"))).toBe(false);
    rmSync(hold);
    await until(() => existsSync(join(clone, "NEWS")));
  }, 60_000);

  test("a repository removed while it is being cloned stays removed", async () => {
    setUp();
    const clone = addRepository("app");
    const real = Bun.which("git") ?? "git";
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\ncase " $* " in *" clone "*) sleep 2 ;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    serve();
    await untilAnswers();
    expect(removeRepo("app")).toBe("");
    // Long enough for the slow clone to finish and be moved in, had nothing stopped it.
    await Bun.sleep(4000);
    expect(existsSync(clone)).toBe(false);
  }, 60_000);
});

// A machine that ran sc with one lead for all its repositories, as the release before leads
// per repository left it: the lead's session, where you last attached from, and a note still
// waiting for the lead.
function oneLeadBefore(session: string, from: string | null): void {
  mkdirSync(join(home, ".local", "share", "skelcrew"), { recursive: true });
  onDb((db) => {
    db.run(`CREATE TABLE repositories (owner TEXT NOT NULL, repo TEXT NOT NULL,
      name TEXT NOT NULL UNIQUE, PRIMARY KEY (owner, repo))`);
    db.run("CREATE TABLE lead (one INTEGER PRIMARY KEY CHECK (one = 1), session TEXT NOT NULL)");
    db.run("CREATE TABLE attached_from (one INTEGER PRIMARY KEY CHECK (one = 1), repo TEXT)");
    db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
    for (const name of ["app", "web"]) {
      onGitHub(name);
      db.run("INSERT INTO repositories (owner, repo, name) VALUES ('simon', ?, ?)", [name, name]);
    }
    db.run("INSERT INTO lead (one, session) VALUES (1, ?)", [session]);
    db.run("INSERT INTO attached_from (one, repo) VALUES (1, ?)", [from]);
    db.run("INSERT INTO notes (text) VALUES ('started web-3 from GitHub: Fix the footer')");
  });
}

// The lead from before keeps its name, folder and socket.
const keptLead = () => join(home, ".local", "share", "skelcrew", "lead");

// A Claude Code at its prompt, which keeps what is typed into it in typed.
const atPrompt = `exec 3<&0
while IFS= read -r line; do echo "$line" >> typed; done <&3 &
echo "❯"
exec sleep 300`;

describe.skipIf(process.env.SKELCREW_SANDBOX === "1")("the lead from before", () => {
  test("a lead running through the upgrade becomes the lead of the repository you last attached from", async () => {
    setUp();
    const id = crypto.randomUUID();
    oneLeadBefore(id, "Simon/Web");
    fakeClaude(atPrompt);
    // Still running from the release before, in its folder and session.
    mkdirSync(keptLead(), { recursive: true });
    const claude = `${join(home, "bin", "claude")} --resume old`;
    const tmux = ["tmux", "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "lead"];
    const started = Bun.spawnSync([...tmux, "-c", keptLead(), claude], { stderr: "pipe" });
    expect(started.stderr.toString()).toBe("");
    await until(() => claudeLines(keptLead()).length > 0);
    serve();
    await untilAnswers();
    const typed = () => read(join(keptLead(), "typed"));
    await until(() => typed().includes("you are the lead of web"));
    expect(typed()).toContain("started web-3 from GitHub: Fix the footer");
    // It kept running: Skelcrew started no other.
    expect(claudeCalls(keptLead())).toBe("--resume old\n");
    expect(storedSession("web")).toBe(id);
    expect(await ask({ command: "lead" })).toEqual({ lead: "lead", repository: "simon/web" });
    expect(await open("web")).toEqual({ lead: "lead", repository: "simon/web" });
    // Every other repository gets a lead of its own, in a folder of its own.
    expect(await open("app")).toEqual({ lead: leadName("app"), repository: "simon/app" });
    expect(claudeLines(leadFolder("app"))).toHaveLength(1);
  }, 60_000);

  test("brought back after a restart, it keeps its conversation, folder and socket", async () => {
    setUp();
    const id = crypto.randomUUID();
    oneLeadBefore(id, null);
    saveTranscript(id, "lead", keptLead());
    fakeClaude(atPrompt);
    serve();
    await untilAnswers();
    await until(() => claudeLines(keptLead()).length > 0);
    expect(claudeCalls(keptLead())).toBe(`--resume ${id}\n`);
    // With nowhere you attached from, the first repository by name.
    expect(await askAsLead({ command: "repo ls" }, keptSocket())).toMatchObject({
      repositories: [{ name: "app" }],
    });
    await until(() => read(join(keptLead(), "typed")).includes("you are the lead of app"));
  }, 60_000);
});

// A lead started by the release before calls it with each message, until it restarts.
test("Skelcrew attached prints nothing, for a lead from before", async () => {
  const run = Bun.spawnSync([process.execPath, main, "attached"], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stdout.toString()).toBe("");
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
});
