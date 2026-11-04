// skel serve and the lead it keeps, against a fake Claude Code on a tmux server of the test's own.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const main = join(import.meta.dir, "..", "src", "main.ts");
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
// folder, one line each, though the lead's instructions span several.
function fakeClaude(body: string): void {
  writeFileSync(
    join(home, "bin", "claude"),
    `#!/bin/sh\necho "claude $*" | tr '\\n' ' ' >> "${leadFolder()}/calls"\necho >> "${leadFolder()}/calls"\n${body}\n`,
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
function serve(runtime = join(home, "run")): Subprocess<"ignore", "pipe", "pipe"> {
  const script = `import { serve } from ${JSON.stringify(daemon)};
await serve(${JSON.stringify(socket)});`;
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

async function until(done: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("gave up waiting");
    await Bun.sleep(20);
  }
}

const hasServer = () =>
  Bun.spawnSync(["tmux", "-L", socket, "list-sessions"], { stderr: "pipe" }).success;
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
  // The daemon may be writing, and a read that meets a write fails without a wait.
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const row = db.query("SELECT session FROM lead").get();
    return row && typeof row === "object" && "session" in row ? String(row.session) : "";
  } finally {
    db.close();
  }
}

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

// A repository skel knows of, as one brought in before leaves it. Returns where skel keeps
// its clone.
function addRepository(name: string): string {
  onGitHub(name);
  const db = join(import.meta.dir, "..", "src", "db.ts");
  const script = `import { openDb } from ${JSON.stringify(db)};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES (?, 'simon', ?)", [${JSON.stringify(name)}, ${JSON.stringify(name)}]);`;
  const added = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home },
    stderr: "pipe",
  });
  if (!added.success) throw new Error(added.stderr.toString());
  return join(home, ".local", "share", "skel", "repos", "simon", name);
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

test("skel serve refuses inside skel's sandbox, where skel's state is hidden", async () => {
  setUp();
  const run = Bun.spawnSync([process.execPath, main, "serve"], {
    env: {
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      SKEL_SANDBOX: "1",
    },
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toBe(
    "skel: running the daemon is only for your own terminal, not for agents\n",
  );
  expect(existsSync(join(home, "run", "skel.sock"))).toBe(false);
});

// As on a Sprite, where the socket's folder is one of skel's own, not one systemd made.
test("makes the folder for its socket, which only you can open", async () => {
  setUp();
  const folder = join(home, "fresh", "run");
  serve(folder);
  await until(() => existsSync(join(folder, "skel.sock")));
  expect(statSync(folder).mode & 0o777).toBe(0o700);
});

// skel takes a machine with sprite-env, the Sprite's own tool, on its PATH for a Sprite. Like
// the real one, it starts a service as it creates it.
function onSprite(): void {
  fake(
    "sprite-env",
    `case "$*" in
  "services get skel") exit 0 ;;
  "services create skel-tmux-${socket} --cmd tmux --args -L,${socket},-f,/dev/null,-D --no-stream")
    test -f "$HOME/tmux-service" && exit 0
    : > "$HOME/tmux-service"
    setsid tmux -L ${socket} -f /dev/null -D < /dev/null > /dev/null 2>&1 &
    exit 0 ;;
  "services start skel-tmux-${socket}")
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
test("on a Sprite, starts skel's tmux service again when it has stopped", async () => {
  setUp();
  onSprite();
  writeFileSync(join(home, "tmux-service"), "");
  serve();
  await until(() => calls().includes("services start skel-tmux"));
  await until(hasServer);
  expect(calls()).not.toContain("systemd-run");
});

// A Sprite service ends every process it started when it stops, so a tmux server the
// daemon started would take every agent with it.
test("on a Sprite, starts skel's tmux server as a Sprite service of its own", async () => {
  setUp();
  onSprite();
  serve();
  await until(() => calls().includes("tmux"));
  await until(hasServer);
  expect(calls()).toContain(
    `sprite-env services create skel-tmux-${socket} --cmd tmux --args -L,${socket},-f,/dev/null,-D --no-stream\n`,
  );
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

  // Without them it would edit code in its own folder rather than hand the work to a thread.
  test("starts and brings back the lead with its instructions", async () => {
    setUp();
    const first = serve();
    await until(() => claudeLines().length > 0);
    saveTranscript(storedSession());
    await stop(first);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
    serve();
    await until(() => claudeCalls().includes("--resume"));
    for (const line of claudeLines()) {
      expect(line).toContain("--append-system-prompt You are the lead");
      expect(line).toContain("skel task create");
      expect(line).toContain("skel start");
    }
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

  test("starts the lead in its sandbox, with opus, seeing skel's clone of every repository", async () => {
    setUp();
    const repo = addRepository("app");
    fakeClaude(
      `while ! test -e ${repo}/README; do sleep 0.1; done; ls ${repo} > seen; test -S "$SKEL_SOCKET" && echo socket >> seen; test -e ${home}/.config/skel/claude-token || echo token-hidden >> seen; exec sleep 300`,
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
  test("the lead sees a repository brought in after it started, without a restart", async () => {
    setUp();
    const clone = join(home, ".local", "share", "skel", "repos", "simon", "app");
    fakeClaude(
      `while ! test -e ${clone}/README; do sleep 0.1; done; cat ${clone}/README > seen.new; mv seen.new seen; exec sleep 300`,
    );
    serve();
    await until(hasLead);
    onGitHub("app");
    // Moved in once whole, as skel brings a repository in.
    git(home, "clone", "-q", join(github(), "simon", "app.git"), join(home, "cloning"));
    mkdirSync(join(clone, ".."));
    renameSync(join(home, "cloning"), clone);
    await until(() => existsSync(join(leadFolder(), "seen")));
    expect(readFileSync(join(leadFolder(), "seen"), "utf8")).toBe("app\n");
    expect(claudeLines()).toHaveLength(1);
  });

  test("moves skel's clones to the latest default branch when the lead starts", async () => {
    setUp();
    const clone = addRepository("app");
    const first = serve();
    await until(() => existsSync(join(clone, "README")));
    await stop(first);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
    const work = join(home, "work", "app");
    writeFileSync(join(work, "NEWS"), "more\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "more");
    git(work, "push", "-q", "origin", "main");
    serve();
    await until(() => existsSync(join(clone, "NEWS")));
  });
  test("moves skel's clones to the latest after answering a lead request, not before", async () => {
    setUp();
    const clone = addRepository("app");
    serve();
    await until(() => existsSync(join(clone, "README")));
    await until(hasLead);
    const work = join(home, "work", "app");
    writeFileSync(join(work, "NEWS"), "more\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "more");
    git(work, "push", "-q", "origin", "main");
    // A slow fetch, so a reply that waited for it would show.
    const real = Bun.which("git") ?? "git";
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\ncase " $* " in *" fetch "*) sleep 2 ;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const asked = Date.now();
    expect(await ask({ command: "lead" })).toEqual({ lead: true });
    expect(Date.now() - asked).toBeLessThan(1500);
    expect(existsSync(join(clone, "NEWS"))).toBe(false);
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(clone, "NEWS"))) {
      if (Date.now() > deadline) throw new Error("the clone never moved to the new commit");
      await Bun.sleep(50);
    }
  }, 15_000);
  // The CLI gives up on the daemon after 15 seconds, and GitHub can be slow or away.
  test("starts the lead without waiting for clones, and makes them after", async () => {
    setUp();
    const clone = addRepository("app");
    const real = Bun.which("git") ?? "git";
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\ncase " $* " in *" clone "*|*" fetch "*) sleep 4 ;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const started = Date.now();
    serve();
    await untilAnswers();
    expect(await ask({ command: "lead" })).toEqual({ lead: true });
    expect(Date.now() - started).toBeLessThan(3500);
    expect(existsSync(clone)).toBe(false);
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(clone, "README"))) {
      if (Date.now() > deadline) throw new Error("the clone was never made");
      await Bun.sleep(50);
    }
  }, 25_000);

  // A Claude Code at its prompt, noting each message it is sent.
  const listening = `echo "❯"; while IFS= read -r line; do echo "$line" >> heard; echo "❯"; done`;
  const heard = () =>
    existsSync(join(leadFolder(), "heard"))
      ? readFileSync(join(leadFolder(), "heard"), "utf8").split("\n").filter(Boolean)
      : [];
  const outside = "you attached from outside any of skel's repositories";

  // The notes are typed in order, so a note that came when the repository stayed the same
  // would show up before the next one.
  test("tells the lead the repository you attached from, only when it changes", async () => {
    setUp();
    addRepository("app");
    addRepository("web");
    fakeClaude(listening);
    serve();
    await untilAnswers();
    expect(await ask({ command: "lead" })).toEqual({ lead: true });
    expect(await ask({ command: "lead", from: "simon/app" })).toEqual({ lead: true });
    expect(await ask({ command: "lead", from: "Simon/App" })).toEqual({ lead: true });
    expect(await ask({ command: "lead", from: "simon/web" })).toEqual({ lead: true });
    expect(await ask({ command: "lead", from: "simon/web" })).toEqual({ lead: true });
    expect(await ask({ command: "lead" })).toEqual({ lead: true });
    expect(await ask({ command: "lead" })).toEqual({ lead: true });
    expect(await ask({ command: "lead", from: "simon/app" })).toEqual({ lead: true });
    await until(() => heard().length === 4);
    await Bun.sleep(1500);
    expect(heard()).toEqual([
      "you attached from app",
      "you attached from web",
      outside,
      "you attached from app",
    ]);
  }, 15_000);

  test("remembers the repository you attached from when the daemon restarts", async () => {
    setUp();
    addRepository("app");
    fakeClaude(listening);
    const first = serve();
    await untilAnswers();
    await ask({ command: "lead", from: "simon/app" });
    await until(() => heard().length === 1);
    await stop(first);
    serve();
    await untilAnswers();
    await ask({ command: "lead", from: "simon/app" });
    await ask({ command: "lead" });
    await until(() => heard().length === 2);
    expect(heard()).toEqual(["you attached from app", outside]);
  }, 15_000);

  // A lead started afresh never saw the note the one before it got.
  test("tells a lead that started a new conversation again", async () => {
    setUp();
    addRepository("app");
    fakeClaude(listening);
    const first = serve();
    await untilAnswers();
    await ask({ command: "lead", from: "simon/app" });
    await until(() => heard().length === 1);
    await stop(first);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
    serve();
    await untilAnswers();
    await ask({ command: "lead", from: "simon/app" });
    await until(() => heard().length === 2);
    expect(heard()).toEqual(["you attached from app", "you attached from app"]);
  }, 15_000);

  // Otherwise the lead would keep a name that no longer finds the repository.
  test("tells the lead again when the repository's name in skel changed", async () => {
    setUp();
    addRepository("app");
    fakeClaude(listening);
    serve();
    await untilAnswers();
    await ask({ command: "lead", from: "simon/app" });
    await until(() => heard().length === 1);
    const db = new Database(join(home, ".local", "share", "skel", "skel.db"));
    db.run("INSERT INTO repositories (name, owner, repo) VALUES ('other/app', 'other', 'app')");
    db.run("UPDATE repositories SET name = 'simon/app' WHERE owner = 'simon'");
    db.close();
    await ask({ command: "lead", from: "simon/app" });
    await until(() => heard().length === 2);
    expect(heard()).toEqual(["you attached from app", "you attached from simon/app"]);
  }, 15_000);

  // A repository waiting for skel repo trust isn't in yet, so the lead couldn't work on it.
  test("a repository skel doesn't have is no default", async () => {
    setUp();
    addRepository("app");
    fakeClaude(listening);
    serve();
    await untilAnswers();
    await ask({ command: "lead", from: "simon/app" });
    await ask({ command: "lead", from: "other/tool" });
    await until(() => heard().length === 2);
    expect(heard()).toEqual(["you attached from app", outside]);
  }, 15_000);

  test("names the repository with its owner while two share a name", async () => {
    setUp();
    addRepository("app");
    const db = new Database(join(home, ".local", "share", "skel", "skel.db"));
    db.run("INSERT INTO repositories (name, owner, repo) VALUES ('other/app', 'other', 'app')");
    db.run("UPDATE repositories SET name = 'simon/app' WHERE owner = 'simon'");
    db.close();
    fakeClaude(listening);
    serve();
    await untilAnswers();
    await ask({ command: "lead", from: "simon/app" });
    await until(() => heard().length === 1);
    expect(heard()).toEqual(["you attached from simon/app"]);
  });

  // You land in the lead at once, and the note waits until the lead is ready for it.
  test("attaching doesn't wait for the note, which comes once the lead is idle", async () => {
    setUp();
    addRepository("app");
    fakeClaude(
      `echo "working (esc to interrupt)"; while ! test -e done; do sleep 0.1; done; printf '\\033[2J\\033[H'; ${listening}`,
    );
    serve();
    await untilAnswers();
    // Once the lead has started, so the timing is the note's alone.
    await ask({ command: "lead" });
    const asked = Date.now();
    expect(await ask({ command: "lead", from: "simon/app" })).toEqual({ lead: true });
    expect(Date.now() - asked).toBeLessThan(1000);
    await Bun.sleep(1500);
    expect(heard()).toEqual([]);
    writeFileSync(join(leadFolder(), "done"), "");
    await until(() => heard().length === 1);
    expect(heard()).toEqual(["you attached from app"]);
  }, 15_000);

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
    expect(await ask({ command: "lead" })).toEqual({ lead: true });
    const removed = Bun.spawnSync([process.execPath, main, "repo", "rm", "app"], {
      env: { HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}` },
      stderr: "pipe",
    });
    expect(removed.stderr.toString()).toBe("");
    // Long enough for the slow clone to finish and be moved in, had nothing stopped it.
    await Bun.sleep(4000);
    expect(existsSync(clone)).toBe(false);
  }, 15_000);
});
