// skel task create and skel start, run as you or the lead would run them, against a running daemon,
// a fake gh, a fake Claude Code and a folder of bare repositories standing in for GitHub.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { stillRunning } from "../src/agents/tmux.ts";
import {
  git,
  homeEnv,
  issueNode,
  pollAnswer,
  read,
  runSkel,
  source,
  startDaemon,
  until,
} from "./harness.ts";

const main = source("main.ts");
let home = "";
let socket = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skel");
const config = (name: string) => join(data(), "claude", name);

function fake(name: string, body: string): void {
  writeFileSync(
    join(home, "bin", name),
    `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`,
    { mode: 0o755 },
  );
}

// Stands in for Claude Code, for the lead and for builders. It runs in the sandbox, where the
// home folder is hidden, so it notes what it was given in its own config folder. args comes
// last and whole, so a test that sees it can read the rest.
function fakeClaude(lead: string, builder: string): void {
  writeFileSync(
    join(home, "bin", "claude"),
    `#!/bin/sh
echo "claude $*" >> "$CLAUDE_CONFIG_DIR/calls"
case "$CLAUDE_CONFIG_DIR" in
*/lead-*) ${lead} ;;
*) env > "$CLAUDE_CONFIG_DIR/env"; pwd > "$CLAUDE_CONFIG_DIR/pwd"
printf '%s\\n' "$@" > "$CLAUDE_CONFIG_DIR/args.new"; mv "$CLAUDE_CONFIG_DIR/args.new" "$CLAUDE_CONFIG_DIR/args"
${builder} ;;
esac
exec sleep 300
`,
    { mode: 0o755 },
  );
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-threads-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  fakeClaude("", "");
  fake("systemctl", "exit 0");
  fake("loginctl", "exit 0");
  fake("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  // The fake GitHub answers a poll with the issues in ~/issues/poll, and makes issue 13. It
  // reports your permission on a repository, and whether it is a fork, from the files beside
  // its bare repository.
  mkdirSync(join(home, "issues"));
  known.length = 0;
  fake(
    "gh",
    `case "$*" in
"api repos/"*"/issues --method POST --input -") cat > "$HOME/issues/sent"
  echo '{"number":13,"title":"Add import","body":"From CSV","user":null,"labels":[],"html_url":"https://github.com/simon/app/issues/13","created_at":"2026-11-05T10:00:00Z","updated_at":"2026-11-05T10:00:00Z"}' ;;
"api graphql --input -") cat > /dev/null; cat "$HOME/issues/poll" ;;
"api repos/"*"/labels --method POST --input -") cat > /dev/null; echo '{"name":"skel"}' ;;
"repo view "*) full=$3
  test -e "$HOME/github/$full.permission" || { echo "Could not resolve to a Repository" >&2; exit 1; }
  fork=$(test -e "$HOME/github/$full.fork" && echo true || echo false)
  echo "{\\"name\\":\\"\${full#*/}\\",\\"owner\\":{\\"login\\":\\"\${full%/*}\\"},\\"viewerPermission\\":\\"$(cat "$HOME/github/$full.permission")\\",\\"isFork\\":$fork}" ;;
*) exit 1 ;;
esac`,
  );
  issue(12, "Add export", "As JSON");
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skel.service"), "");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${github()}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Simon\n\temail = simon@example.com\n`,
  );
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

// The issues on the fake GitHub. Each one added answers the next poll along with the others.
const known: object[] = [];
function issue(number: number, title: string, body: string): void {
  known.push(issueNode(number, title, { body }));
  writeFileSync(join(home, "issues", "poll"), JSON.stringify(pollAnswer(known)));
}

// What this test's processes run with.
const env = () => homeEnv(home);

// Runs this test's daemon, which the test's clean-up stops.
const serve = () => startDaemon(socket, env(), running);

async function stop(run: Subprocess): Promise<void> {
  run.kill();
  await run.exited;
}

// Runs skel as you or the lead would.
const skel = (...args: string[]) => runSkel(args, env());

async function untilAnswers() {
  await until(() => existsSync(join(home, "run", "skel.sock")));
  await Bun.sleep(100);
}

const github = () => join(home, "github");

// Puts simon/<repo> on the fake GitHub with the files given, with your permission on it.
// Returns a checkout to push more from.
function onGitHub(files: Record<string, string>, repo: string, permission = "WRITE"): string {
  const work = join(home, "work", repo);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(github(), "simon", `${repo}.git`));
  git(work, "remote", "add", "origin", join(github(), "simon", `${repo}.git`));
  writeFileSync(join(github(), "simon", `${repo}.permission`), permission);
  return work;
}

// Puts simon/<repo> on the fake GitHub with the files given, and tells skel about it.
// Returns a checkout to push more from.
function addApp(files: Record<string, string> = {}, repo = "app"): string {
  const work = onGitHub(files, repo);
  const script = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES (?, 'simon', ?)", [${JSON.stringify(repo)}, ${JSON.stringify(repo)}]);`;
  const added = Bun.spawnSync([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  return work;
}

// skel's own clone, which the daemon makes as it starts.
const untilCloned = () => until(() => existsSync(join(data(), "repos", "simon", "app", "README")));

// Holds every clone from GitHub until the test lets it go, so a test can see that skel
// answered before the clone was there. It notes in held that it started and in released that
// it went on. The test can remove the folder in the moment between two looks for the file go,
// so the wait also ends when the folder goes, and in any case after a minute.
function holdClones(): void {
  writeFileSync(
    join(home, "bin", "git"),
    `#!/bin/sh
case "$*" in *"clone --quiet https://github.com/"*)
  touch "$HOME/held"
  for i in $(seq 1200); do
    if [ -e "$HOME/go" ] || [ ! -d "$HOME" ]; then break; fi
    sleep 0.05
  done
  touch "$HOME/released" ;;
esac
exec ${Bun.which("git") ?? "git"} "$@"
`,
    { mode: 0o755 },
  );
}

function thread(): Record<string, unknown> {
  const db = new Database(join(data(), "skel.db"));
  // The daemon may be writing, and a read that meets a write fails without a wait.
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const row = db.query("SELECT * FROM threads").get();
    return row && typeof row === "object" ? { ...row } : {};
  } finally {
    db.close();
  }
}

const hasSession = (name: string) =>
  Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", `=${name}`], { stderr: "pipe" })
    .success;

const clone = () => join(data(), "threads", "app-12");

test("skel task create creates a GitHub issue and prints the task's name", async () => {
  addApp();
  serve();
  await untilAnswers();
  const made = await skel("task", "create", "app", "Add import", "From CSV");
  expect(made.err).toBe("");
  expect(made.out).toBe("app-13\n");
  expect(JSON.parse(read(join(home, "issues", "sent")))).toEqual({
    title: "Add import",
    body: "From CSV",
  });
});

test("more data on a connection doesn't run its request again", async () => {
  addApp();
  serve();
  await untilAnswers();
  const real = read(join(home, "bin", "gh"));
  writeFileSync(
    join(home, "bin", "gh"),
    real.replace('"$HOME/calls"\n', '"$HOME/calls"\nsleep 1\n'),
  );
  // An error with nobody listening would be thrown outside the test, failing a run without
  // saying which test it came from.
  await new Promise<void>((done, failed) => {
    const connection = createConnection(join(home, "run", "skel.sock"));
    connection.on("error", failed);
    connection.on("connect", () => {
      connection.write('{"command":"task create","repo":"app","title":"t","body":"b"}\n');
      setTimeout(() => connection.write("more\n"), 200);
    });
    connection.on("data", () => {});
    connection.on("close", () => done());
  });
  expect(read(join(home, "calls")).match(/issues --method POST/g)).toHaveLength(1);
});

test("skel start refuses a repository skel doesn't have, and a task GitHub doesn't have", async () => {
  addApp();
  serve();
  await untilAnswers();
  const unknown = await skel("start", "site-1");
  expect(unknown.code).not.toBe(0);
  expect(unknown.err).toContain("no repository named site");
  const missing = await skel("start", "app-99");
  expect(missing.code).not.toBe(0);
  expect(missing.err).toContain("there is no open task #99 in simon/app");
  expect(existsSync(join(data(), "threads", "app-99"))).toBe(false);
});

// Bringing a repository in by naming it is gone: you add one in your own terminal.
test("a repository skel doesn't have, named by its GitHub name, is no repository", async () => {
  onGitHub({}, "site");
  serve();
  await untilAnswers();
  for (const name of ["simon/site", "site", "-x/site"]) {
    const listed = await skel("task", "ls", name);
    expect(listed.code).not.toBe(0);
    expect(listed.err).toBe(`skel: there is no repository named ${name}\n`);
  }
  expect(read(join(home, "calls"))).not.toContain("repo view");
});

describe("a clone the daemon makes as it starts", () => {
  // Left running, it would write into the folder the next daemon clones into.
  test("stopping the daemon stops a clone it started", async () => {
    addApp({}, "site");
    holdClones();
    const run = serve();
    await until(() => existsSync(join(home, "held")));
    await stop(run);
    writeFileSync(join(home, "go"), "");
    await Bun.sleep(300);
    expect(existsSync(join(home, "released"))).toBe(false);
  });

  test("the daemon waits for a clone it stops to end, so the next daemon can't meet it", async () => {
    addApp({}, "site");
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh
case "$*" in *"clone --quiet https://github.com/"*)
  trap 'sleep 0.5; touch "$HOME/ended"; exit' TERM
  touch "$HOME/held"
  for i in $(seq 1200); do sleep 0.05; done ;;
esac
exec ${Bun.which("git") ?? "git"} "$@"
`,
      { mode: 0o755 },
    );
    const run = serve();
    await until(() => existsSync(join(home, "held")));
    await stop(run);
    expect(existsSync(join(home, "ended"))).toBe(true);
  });

  test("a clone that ignores the daemon's stop is killed", async () => {
    addApp({}, "site");
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh
case "$*" in *"clone --quiet https://github.com/"*)
  trap '' TERM
  echo $$ > "$HOME/held"
  for i in $(seq 1200); do sleep 0.05; done ;;
esac
exec ${Bun.which("git") ?? "git"} "$@"
`,
      { mode: 0o755 },
    );
    const run = serve();
    await until(() => read(join(home, "held")) !== "");
    await stop(run);
    expect(stillRunning([Number(read(join(home, "held")))])).toEqual([]);
  }, 20_000);
});

test("skel task create and skel start say when the daemon isn't running", async () => {
  const made = await skel("task", "create", "app", "Add import", "From CSV");
  expect(made.code).not.toBe(0);
  expect(made.err).toContain("run skel");
});

// bubblewrap can't start inside skel's own sandbox, so only there builders can't start.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("with a builder", () => {
  test("starts the builder in the sandbox, in a clone of its own, on a branch of its own", async () => {
    addApp({
      "skel.yaml":
        "setup:\n  - echo set up > setup-ran\n  - test -e $HOME/.config/skel/claude-token || echo token-hidden >> setup-ran\n",
    });
    fakeClaude(
      "",
      `{ test -e ${data()}/repos/simon/site || echo others-hidden; touch ${data()}/repos/simon/app/x 2>/dev/null || echo origin-read-only; git config user.name; git config --get-regexp '^remote' | grep -c github; } > "$CLAUDE_CONFIG_DIR/seen.new" 2>&1; mv "$CLAUDE_CONFIG_DIR/seen.new" "$CLAUDE_CONFIG_DIR/seen"`,
    );
    // Another repository's clone, which the lead sees but no builder of app's should.
    mkdirSync(join(data(), "repos", "simon", "site"), { recursive: true });
    git(join(data(), "repos", "simon", "site"), "init", "-q");
    serve();
    await untilCloned();
    const started = await skel("start", "app-12");
    expect(started.err).toBe("");
    expect(started.out).toBe("Started app-12.\n");
    await until(() => read(join(config("app-12"), "seen")) !== "");
    expect(git(clone(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("skel/12-add-export");
    expect(read(join(clone(), "setup-ran"))).toBe("set up\ntoken-hidden\n");
    expect(read(join(config("app-12"), "pwd"))).toBe(`${clone()}\n`);
    // Its own repository's clone is its origin, read-only; skel's other clones stay hidden.
    expect(read(join(config("app-12"), "seen"))).toBe(
      "others-hidden\norigin-read-only\nSimon\n0\n",
    );
    const args = read(join(config("app-12"), "args"));
    expect(args).toContain("--model\nopus\n");
    expect(args.endsWith("Add export\n\nAs JSON\n")).toBe(true);
    const env = read(join(config("app-12"), "env"));
    expect(env).toContain("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false\n");
    expect(env).toContain("SKEL_SANDBOX=1\n");
    expect(hasSession("app-12")).toBe(true);
    const row = thread();
    expect(row).toMatchObject({ owner: "simon", repo: "app", task: 12, status: "working" });
    expect(Date.now() - Number(row.started)).toBeLessThan(60_000);
    expect(String(row.session)).toMatch(/^[0-9a-f-]{36}$/);
    expect(args).toContain(`--session-id\n${row.session}\n`);
    const log = read(join(data(), "threads", "app-12.log"))
      .trim()
      .split("\n");
    expect(log.length).toBeGreaterThan(1);
    expect(JSON.parse(log.at(-1) ?? "")).toMatchObject({ status: "working", session: row.session });
  }, 20_000);

  test("starts from the branch given with --from, on the model in your config", async () => {
    const work = addApp();
    git(work, "checkout", "-q", "-b", "next");
    writeFileSync(join(work, "NEXT"), "next\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "next");
    git(work, "push", "-q", "origin", "next");
    writeFileSync(
      join(home, ".config", "skel", "config.yaml"),
      "harness: claude\nbuilder: { model: sonnet }\n",
    );
    serve();
    await untilCloned();
    expect((await skel("start", "app-12", "--from", "next")).err).toBe("");
    await until(() => read(join(config("app-12"), "args")) !== "");
    expect(existsSync(join(clone(), "NEXT"))).toBe(true);
    expect(read(join(config("app-12"), "args"))).toContain("--model\nsonnet\n");
  }, 20_000);

  test("the builder's socket tells skel which thread calls, and answers nothing else", async () => {
    addApp();
    const asker = `const [request] = process.argv.slice(2);
const c = require("node:net").createConnection(process.env.SKEL_SOCKET);
c.on("connect", () => c.write(request + "\\n"));
c.on("data", (d) => process.stdout.write(d));`;
    writeFileSync(join(home, "bin", "ask.js"), asker);
    const ask = (request: string) => `bun ${join(home, "bin", "ask.js")} '${request}'`;
    fakeClaude(
      "",
      `{ ${ask('{"command":"status"}')}; ${ask('{"command":"task create","repo":"app","title":"t","body":"b"}')}; ${ask('{"command":"lead"}')}; } > "$CLAUDE_CONFIG_DIR/replies.new"; mv "$CLAUDE_CONFIG_DIR/replies.new" "$CLAUDE_CONFIG_DIR/replies"`,
    );
    serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "replies")) !== "");
    const replies = read(join(config("app-12"), "replies"))
      .trim()
      .split("\n");
    expect(JSON.parse(replies[0] ?? "")).toMatchObject({ running: true, thread: "app-12" });
    expect(replies.slice(1).map((reply) => JSON.parse(reply))).toEqual([
      { error: "the daemon doesn't know that request" },
      { error: "the daemon doesn't know that request" },
    ]);
    expect(existsSync(join(home, "issues", "sent"))).toBe(false);
  }, 20_000);

  test("the lead runs skel task create and skel start from its sandbox, but can't trust", async () => {
    addApp();
    const asker = `const c = require("node:net").createConnection(process.env.SKEL_SOCKET);
c.on("connect", () => c.write('{"command":"lead"}\\n'));
c.on("data", (d) => process.stdout.write(d));`;
    writeFileSync(join(home, "bin", "ask.js"), asker);
    fakeClaude(
      `{ skel task create app "Add import" "From CSV"; skel start app-12; skel repo trust simon/other; bun ${join(home, "bin", "ask.js")}; } > out.new 2>&1; mv out.new out`,
      "",
    );
    // Opened before, so the daemon starts app's lead as it starts.
    const db = new Database(join(data(), "skel.db"));
    db.run("UPDATE repositories SET opened = 1");
    db.close();
    serve();
    const out = join(data(), "leads", "simon", "app", "out");
    await until(() => read(out) !== "");
    expect(read(out)).toBe(
      `app-13\nStarted app-12.\nskel: trusting a repository is only for your own terminal, not for agents\n{"error":"the daemon doesn't know that request"}\n`,
    );
    await until(() => read(join(config("app-12"), "args")) !== "");
  }, 20_000);

  test("a thread whose setup fails is marked failed, and starting it again starts over", async () => {
    const work = addApp({ "skel.yaml": "setup: [echo fine, echo broken >&2 && exit 3]\n" });
    serve();
    await untilCloned();
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => thread().status === "failed");
    // The daemon saves a thread before it appends the thread to its log.
    await until(() => read(join(data(), "threads", "app-12.log")).includes("broken"));
    expect(hasSession("app-12")).toBe(false);
    writeFileSync(join(work, "skel.yaml"), "setup: [echo fixed > fixed]\n");
    git(work, "commit", "-q", "-am", "fix setup");
    git(work, "push", "-q", "origin", "main");
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => read(join(config("app-12"), "args")) !== "");
    expect(read(join(clone(), "fixed"))).toBe("fixed\n");
    expect(thread().status).toBe("working");
  }, 20_000);

  test("refuses a second thread on a task that has one", async () => {
    addApp();
    serve();
    await untilCloned();
    await skel("start", "app-12");
    // GitHub is down now, and the refusal needs nothing from it.
    rmSync(join(home, "issues", "poll"));
    const again = await skel("start", "app-12");
    expect(again.code).not.toBe(0);
    expect(again.err).toBe("skel: app-12 has a thread already\n");
  }, 20_000);

  test("skel stop ends the builder and keeps its clone, a restart leaves it stopped, and skel start brings it back with --resume", async () => {
    addApp();
    // Opened before, so the daemon starts app's lead, whose socket the stop comes from.
    const db = new Database(join(data(), "skel.db"));
    db.run("UPDATE repositories SET opened = 1");
    db.close();
    const first = serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "");
    const session = String(thread().session);
    // Claude Code saves a conversation once it has a message, which a fake can't send.
    const project = clone().replace(/[^a-zA-Z0-9]/g, "-");
    mkdirSync(join(config("app-12"), "projects", project), { recursive: true });
    writeFileSync(join(config("app-12"), "projects", project, `${session}.jsonl`), "{}\n");
    // Runs skel stop as an agent would, with its own socket.
    const stopFrom = (agent: string) =>
      Bun.spawnSync([process.execPath, main, "stop", "app-12"], {
        env: { ...env(), SKEL_SOCKET: agent },
        stderr: "pipe",
        stdout: "pipe",
      });
    const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
    const fromBuilder = stopFrom(join(home, "run", "skel", "threads", short, "skel.sock"));
    expect(fromBuilder.stderr.toString()).toContain("doesn't know that request");
    expect(hasSession("app-12")).toBe(true);

    const lead = new Bun.CryptoHasher("sha256").update("simon/app").digest("hex").slice(0, 16);
    const fromLead = stopFrom(join(home, "run", "skel", "leads", lead, "skel.sock"));
    expect(fromLead.stderr.toString()).toBe("");
    expect(fromLead.stdout.toString()).toContain("Stopped app-12.");
    expect(hasSession("app-12")).toBe(false);
    expect(existsSync(join(clone(), "README"))).toBe(true);
    expect(thread().status).toBe("stopped");
    expect((await skel("stop", "app-12")).err).toContain("app-12 is stopped already");

    await stop(first);
    rmSync(join(config("app-12"), "calls"));
    serve();
    await untilAnswers();
    await Bun.sleep(2000);
    expect(hasSession("app-12")).toBe(false);
    expect(read(join(config("app-12"), "calls"))).toBe("");
    expect(thread().status).toBe("stopped");

    const started = await skel("start", "app-12");
    expect(started.err).toBe("");
    expect(started.out).toContain("Started app-12 again");
    await until(() => read(join(config("app-12"), "calls")).includes("--resume"));
    expect(read(join(config("app-12"), "calls"))).toContain(`--resume ${session}`);
    expect(read(join(config("app-12"), "pwd"))).toBe(`${clone()}\n`);
    expect(hasSession("app-12")).toBe(true);
    expect(thread().status).toBe("working");
  }, 40_000);

  test("brings back a builder whose session is gone with --resume, where it was, after its repository is renamed", async () => {
    addApp();
    const first = serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "");
    const session = String(thread().session);
    // Claude Code saves a conversation once it has a message, which a fake can't send.
    const project = clone().replace(/[^a-zA-Z0-9]/g, "-");
    mkdirSync(join(config("app-12"), "projects", project), { recursive: true });
    writeFileSync(join(config("app-12"), "projects", project, `${session}.jsonl`), "{}\n");
    await stop(first);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    // A second app comes in, so simon/app is named with its owner from now on.
    const script = `import { nameRepositories, openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo) VALUES ('bob/app', 'bob', 'app')");
nameRepositories(db);`;
    expect(Bun.spawnSync([process.execPath, "-e", script], { env: env() }).success).toBe(true);
    serve();
    await until(() => read(join(config("app-12"), "calls")).includes("--resume"));
    expect(read(join(config("app-12"), "calls"))).toContain(`--resume ${session}`);
    expect(read(join(config("app-12"), "pwd"))).toBe(`${clone()}\n`);
    expect(hasSession("app-12")).toBe(true);
    expect(thread().session).toBe(session);
    expect((await skel("start", "simon/app-12")).err).toContain(
      "simon/app-12 has a thread already",
    );
  }, 30_000);

  test("a builder that never saved a conversation starts again from the task", async () => {
    addApp();
    const first = serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "");
    const session = String(thread().session);
    await stop(first);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    rmSync(join(config("app-12"), "args"));
    serve();
    await until(() => read(join(config("app-12"), "args")) !== "");
    const fresh = String(thread().session);
    expect(fresh).not.toBe(session);
    const args = read(join(config("app-12"), "args"));
    expect(args).toContain(`--session-id\n${fresh}\n`);
    expect(args.endsWith("Add export\n\nAs JSON\n")).toBe(true);
  }, 30_000);

  test("a thread whose setup the daemon's stop cut short is marked failed when it comes back", async () => {
    addApp({ "skel.yaml": "setup: [sleep 30]\n" });
    const first = serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => existsSync(join(clone(), "skel.yaml")));
    await stop(first);
    serve();
    await until(() => thread().status === "failed");
    await until(() => read(join(data(), "threads", "app-12.log")).includes("run skel start again"));
    expect(hasSession("app-12")).toBe(false);
  }, 30_000);

  test("a builder that exits as soon as it starts fails the thread and says why", async () => {
    fakeClaude("", "echo 'claude: not logged in'; exit 1");
    addApp();
    serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => thread().status === "failed");
    await until(() => {
      const log = read(join(data(), "threads", "app-12.log"));
      return log.includes("the builder exited as soon as it started") && log.includes("logged in");
    });
    expect(hasSession("app-12")).toBe(false);
  }, 30_000);

  test("skel stop refuses a thread still setting up, and one with no builder", async () => {
    addApp({ "skel.yaml": "setup: [sleep 2, exit 3]\n" });
    serve();
    await untilCloned();
    await skel("start", "app-12");
    expect((await skel("stop", "app-12")).err).toContain(
      "app-12 is still setting up: stop it once its builder has started",
    );
    await until(() => thread().status === "failed");
    expect((await skel("stop", "app-12")).err).toContain(
      "app-12 is failed, so it has no builder to stop",
    );
  }, 30_000);

  // A stopped thread's builder sits at its prompt once back, so skel start must say whether
  // something will wake it. Sets the row while the thread is stopped, as a round would have.
  test("a stopped thread comes back waiting on its PR, or working on a review's changes", async () => {
    addApp();
    serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "");
    const stoppedWith = async (columns: string) => {
      await skel("stop", "app-12");
      const db = new Database(join(data(), "skel.db"));
      db.run("PRAGMA busy_timeout = 5000");
      db.run(`UPDATE threads SET ${columns}`);
      db.close();
      expect((await skel("start", "app-12")).out).toContain("Started app-12 again");
      return thread().status;
    };
    expect(await stoppedWith("pr = 7")).toBe("waiting");
    expect(await stoppedWith("telling = 'Add a test.'")).toBe("working");
  }, 30_000);

  // The round limit is read only for a thread it can matter to, so a bad one fails the new
  // thread with the reason rather than refusing skel start.
  test("a bad max_rounds fails a new thread, and skel start still answers", async () => {
    addApp();
    writeFileSync(join(home, ".config", "skel", "config.yaml"), "harness: claude\nmax_rounds: 0\n");
    serve();
    await untilCloned();
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => thread().status === "failed");
    await until(() => read(join(data(), "threads", "app-12.log")).includes("isn't valid"));
  }, 30_000);

  // The daemon brings back threads once the lead has started, which takes a moment.
  test("a thread started while the daemon starts the lead isn't taken for one cut short", async () => {
    addApp({ "skel.yaml": "setup: [sleep 3]\n" });
    serve();
    await untilAnswers();
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => read(join(config("app-12"), "args")) !== "");
    expect(thread().status).toBe("working");
  }, 30_000);

  test("gives two threads whose names would make the same folder a folder each", async () => {
    addApp();
    const script = `import { nameRepositories, openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo) VALUES ('x', 'bob', 'app'), ('y', 'bob', 'simon-app')");
nameRepositories(db);`;
    expect(Bun.spawnSync([process.execPath, "-e", script], { env: env() }).success).toBe(true);
    serve();
    await untilAnswers();
    expect((await skel("start", "simon/app-12")).err).toBe("");
    expect((await skel("start", "simon-app-12")).err).toBe("");
    const db = new Database(join(data(), "skel.db"));
    // The daemon may be writing, and a read that meets a write fails without a wait.
    db.run("PRAGMA busy_timeout = 5000");
    const folders = db.query("SELECT folder FROM threads ORDER BY owner DESC").values();
    db.close();
    expect(folders).toEqual([["simon-app-12"], ["simon-app-12-2"]]);
  }, 30_000);

  test("a thread started before skel's clone of its repository is made waits for it", async () => {
    addApp();
    const real = Bun.which("git") ?? "git";
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\ncase " $* " in *" clone "*github*) sleep 3 ;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    serve();
    await untilAnswers();
    expect(existsSync(join(data(), "repos", "simon", "app"))).toBe(false);
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => read(join(config("app-12"), "args")) !== "");
    expect(thread().status).toBe("working");
  }, 30_000);

  test("a thread on a repository whose clone isn't there yet starts once skel's clone is", async () => {
    addApp({}, "site");
    holdClones();
    serve();
    await untilAnswers();
    const started = await skel("start", "site-12");
    expect(started.out).toBe("Started site-12.\n");
    expect(existsSync(join(data(), "repos", "simon", "site"))).toBe(false);
    writeFileSync(join(home, "go"), "");
    await until(() => read(join(config("site-12"), "args")) !== "");
    expect(thread()).toMatchObject({ owner: "simon", repo: "site", status: "working" });
  }, 30_000);

  // Programs often live under the home folder, which the sandbox hides, as npm does under nvm.
  test("a setup command finds its program under your home folder", async () => {
    addApp({ "skel.yaml": "setup: [cd . && X=1 tool --flag]\n" });
    mkdirSync(join(home, "tools"));
    writeFileSync(join(home, "tools", "tool"), '#!/bin/sh\necho "ran $1" > ran\n', { mode: 0o755 });
    startDaemon(socket, { ...env(), PATH: `${join(home, "tools")}:${env().PATH}` }, running);
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "" || thread().status === "failed");
    expect(read(join(clone(), "ran"))).toBe("ran --flag\n");
  }, 30_000);

  test("a setup command can't bring back a folder of yours by naming a program in it", async () => {
    mkdirSync(join(home, "tools"));
    writeFileSync(join(home, "tools", "tool"), "#!/bin/sh\necho ran > ran\n", { mode: 0o755 });
    addApp({ "skel.yaml": `setup: ["${join(home, "tools", "tool")} || echo hidden > ran"]\n` });
    serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "" || thread().status === "failed");
    expect(read(join(clone(), "ran"))).toBe("hidden\n");
  }, 30_000);

  // A builder's config folder and session are named after the thread's folder, which must
  // start with a letter or digit. A long folder would make Claude Code hash the name of
  // the folder its conversations are saved in, and skel would miss them when bringing the
  // builder back.
  test("names a thread's folder so its builder starts, whatever the repository's name", async () => {
    const long = `x${"y".repeat(98)}`;
    for (const repo of [".github", long]) addApp({}, repo);
    serve();
    await until(() => existsSync(join(data(), "repos", "simon", long, "README")));
    await until(() => existsSync(join(data(), "repos", "simon", ".github", "README")));
    expect((await skel("start", ".github-12")).out).toBe("Started .github-12.\n");
    expect((await skel("start", `${long}-12`)).err).toBe("");
    const folders = [`github-12`, `${long.slice(0, 60)}-12`];
    for (const folder of folders) await until(() => read(join(config(folder), "args")) !== "");
  }, 30_000);
});
