// sc issue create and sc start, run as you or the lead would run them, against a running daemon,
// a fake tracker and forge, a fake Claude Code and a folder of bare repositories standing in
// for GitHub.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { stillRunning } from "../src/agents/sessions.ts";
import { codeOf } from "../src/db.ts";
import {
  answer,
  asked,
  fakePlugin,
  git,
  homeEnv,
  insideSandbox,
  read,
  runSkel,
  source,
  startDaemon,
  taskItem,
  threadSql,
  until,
} from "./harness.ts";

// This machine's code, which names the threads sc start begins with no issue, such as app-wr1.
const own = codeOf(hostname());
const main = source("main.ts");
let home = "";
let socket = "";
// The fake plugin's settings folder, where it keeps what it is asked and its answers.
let plugin = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skelcrew");
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
  // The fake tracker answers a poll with the issues added, and makes issue 13.
  known.length = 0;
  plugin = fakePlugin(home);
  answer(plugin, "create task", taskItem("13", "Add import", { body: "From CSV", author: null }));
  issue(12, "Add export", "As JSON");
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
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

// The issues in the fake tracker. Each one added answers the next poll along with the others.
const known: object[] = [];
function issue(number: number, title: string, body: string): void {
  known.push(taskItem(String(number), title, { body }));
  answer(plugin, "changed", { items: known, next: null });
}

// What this test's processes run with.
const env = () => homeEnv(home);

// Runs this test's daemon, which the test's clean-up stops.
const serve = () => startDaemon(socket, env(), running);

async function stop(run: Subprocess): Promise<void> {
  run.kill();
  await run.exited;
}

// Runs sc as you or the lead would.
const skel = (...args: string[]) => runSkel(args, env());

async function untilAnswers() {
  await until(() => existsSync(join(home, "run", "skelcrew.sock")));
  await Bun.sleep(100);
}

const github = () => join(home, "github");

// Puts <owner>/<repo> on the fake GitHub with the files given. Returns a checkout to push more
// from.
function onGitHub(files: Record<string, string>, repo: string, owner = "simon"): string {
  const work = join(home, "work", owner, repo);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  // The fake plugin is the tracker, whatever else skelcrew.yaml says.
  const shared = { ...files, "skelcrew.yaml": `tracker: github\n${files["skelcrew.yaml"] ?? ""}` };
  for (const [name, text] of Object.entries(shared)) writeFileSync(join(work, name), text);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(github(), owner, `${repo}.git`));
  git(work, "remote", "add", "origin", join(github(), owner, `${repo}.git`));
  return work;
}

// Puts simon/<repo> on the fake GitHub with the files given, and tells Skelcrew about it.
// Returns a checkout to push more from.
function addApp(files: Record<string, string> = {}, repo = "app"): string {
  const work = onGitHub(files, repo);
  const script = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES (?, 'simon', ?)", [${JSON.stringify(repo)}, ${JSON.stringify(repo)}]);
openDb().run("UPDATE repositories SET forge = 'github', claimed = 1, remote = 'https://github.com/' || owner || '/' || repo || '.git'");`;
  const added = Bun.spawnSync([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  return work;
}

// Skelcrew's own clone, which the daemon makes as it starts.
const untilCloned = () => until(() => existsSync(join(data(), "repos", "simon", "app", "README")));

// Holds every clone from GitHub until the test lets it go, so a test can see that Skelcrew
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
  const db = new Database(join(data(), "skelcrew.db"));
  // The daemon may be writing, and a read that meets a write fails without a wait.
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const row = db.query("SELECT * FROM task_threads").get();
    return row && typeof row === "object" ? { ...row } : {};
  } finally {
    db.close();
  }
}

const hasSession = (name: string) =>
  Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", `=${name}`], { stderr: "pipe" })
    .success;

const clone = () => join(data(), "threads", "app-12");

test("sc issue create creates a task in the repository's tracker and prints its name", async () => {
  addApp();
  serve();
  await untilAnswers();
  const made = await skel("issue", "create", "app", "Add import", "From CSV");
  expect(made.err).toBe("");
  expect(made.out).toBe("app-13\n");
  expect(asked(plugin).filter((q) => q.ask === "create task")).toEqual([
    { ask: "create task", repository: "simon/app", title: "Add import", body: "From CSV" },
  ]);
});

// A builder sees only the title and body. A heredoc that failed inside $(...) leaves the
// body empty while the command still runs, and an issue with no body can't be taken back.
test("sc issue create and sc start <repo> refuse an empty body, and ask the tracker nothing", async () => {
  addApp();
  serve();
  await untilAnswers();
  for (const body of ["", " \n\t"]) {
    const made = await skel("issue", "create", "app", "Add import", body);
    expect(made.code).toBe(1);
    expect(made.err).toBe(
      "Skelcrew: sc issue create needs a body, which is all a builder sees besides its title.\n",
    );
    const started = await skel("start", "app", "Add import", body);
    expect(started.code).toBe(1);
    expect(started.err).toBe(
      "Skelcrew: sc start needs a body, which is all a builder sees besides its title.\n",
    );
  }
  // The daemon refuses one too, from a client that doesn't check.
  await new Promise<void>((done, failed) => {
    const connection = createConnection(join(home, "run", "skelcrew.sock"));
    connection.on("error", failed);
    connection.on("connect", () =>
      connection.write('{"command":"task create","repo":"app","title":"t","body":"  "}\n'),
    );
    connection.on("data", () => {});
    connection.on("close", () => done());
  });
  expect(asked(plugin).filter((q) => q.ask === "create task")).toEqual([]);
  expect(thread()).toEqual({});
});

test("sc start <repo> says what its stdin left out, and starts nothing", async () => {
  addApp();
  serve();
  await untilAnswers();
  const empty = await runSkel(["start", "app"], env(), "");
  expect(empty.code).toBe(1);
  expect(empty.err).toContain("no title");
  const titleOnly = await runSkel(["start", "app"], env(), "# Add export\n\n");
  expect(titleOnly.code).toBe(1);
  expect(titleOnly.err).toContain("no body");
  expect(thread()).toEqual({});
});

test("more data on a connection doesn't run its request again", async () => {
  addApp();
  serve();
  await untilAnswers();
  // The tracker takes a moment, so more data comes while the request runs.
  writeFileSync(join(plugin, "hold-create-task"), "");
  setTimeout(() => rmSync(join(plugin, "hold-create-task"), { force: true }), 1000);
  // An error with nobody listening would be thrown outside the test, failing a run without
  // saying which test it came from.
  await new Promise<void>((done, failed) => {
    const connection = createConnection(join(home, "run", "skelcrew.sock"));
    connection.on("error", failed);
    connection.on("connect", () => {
      connection.write('{"command":"task create","repo":"app","title":"t","body":"b"}\n');
      setTimeout(() => connection.write("more\n"), 200);
    });
    connection.on("data", () => {});
    connection.on("close", () => done());
  });
  expect(asked(plugin).filter((q) => q.ask === "create task")).toHaveLength(1);
});

test("sc start refuses a repository Skelcrew doesn't have, and a task its tracker doesn't have", async () => {
  addApp();
  serve();
  await untilAnswers();
  const unknown = await skel("start", "site-1");
  expect(unknown.code).not.toBe(0);
  expect(unknown.err).toContain("no repository named site");
  const missing = await skel("start", "app-99");
  expect(missing.code).not.toBe(0);
  expect(missing.err).toContain("there is no open issue 99 in simon/app");
  expect(existsSync(join(data(), "threads", "app-99"))).toBe(false);
});

// Puts simon/app on the fake GitHub with a flow file of its own, quick, and tells Skelcrew about
// it. Returns a checkout to push more from.
function addFlows(): string {
  const work = addApp();
  mkdirSync(join(work, ".agents", "flows"), { recursive: true });
  writeFileSync(join(work, ".agents", "flows", "quick.yaml"), "review:\n  rounds: 1\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "flows");
  git(work, "push", "-q", "origin", "main");
  return work;
}

// Approves the .agents/ in Skelcrew's clone of simon/app, as sc repo trust would, once it is
// there.
async function untilApproved(): Promise<void> {
  const skelClone = join(data(), "repos", "simon", "app");
  await until(() => existsSync(join(skelClone, ".agents")));
  const tree = git(skelClone, "rev-parse", "HEAD:.agents");
  writeFileSync(join(home, ".config", "skelcrew", "approved-agents.yaml"), `simon/app: ${tree}\n`);
}

// Returns each task's flow, as Skelcrew's database keeps it.
function flows(): unknown[] {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    return db.query("SELECT task, flow FROM tasks ORDER BY task").all();
  } finally {
    db.close();
  }
}

// In a repository with flow files of its own, the lead picks a task's flow as it starts it. Only
// a flow file of the .agents/ you approved counts.
test("sc start --flow runs a task on a flow file of the repository, and refuses one it lacks", async () => {
  addFlows();
  serve();
  await untilCloned();
  const before = await skel("start", "app", "Fix typo", "In the README", "--flow", "quick");
  expect(before.err).toBe("Skelcrew: app has no flow quick. Its flows are default.\n");
  await untilApproved();
  const quick = await skel("start", "app", "Fix typo", "In the README", "--flow", "quick");
  expect(quick.err).toBe("");
  expect(quick.out).toBe(`Started app-${own}1.\n`);
  expect(flows()).toEqual([{ task: `${own}1`, flow: "quick" }]);
  const missing = await skel("start", "app-12", "--flow", "slow");
  expect(missing.err).toBe("Skelcrew: app has no flow slow. Its flows are default, quick.\n");
  // A flow's name can't reach outside .agents/flows/.
  expect((await skel("start", "app-12", "--flow", "../x")).code).not.toBe(0);
  expect((await skel("start", "app-12", "--flow")).code).not.toBe(0);
  // Without --flow, a task runs default.
  expect((await skel("start", "app", "Add notes", "As text")).out).toBe(`Started app-${own}2.\n`);
  expect(flows()).toEqual([
    { task: `${own}1`, flow: "quick" },
    { task: `${own}2`, flow: "default" },
  ]);
});

// A round limit that isn't valid, wherever it comes from, refuses the start before any work
// begins, naming where it is.
test("sc start refuses a task whose round limit isn't valid, from its flow file or your config", async () => {
  const work = addFlows();
  writeFileSync(join(work, ".agents", "flows", "quick.yaml"), "review:\n  rounds: 0\n");
  git(work, "commit", "-q", "-am", "bad rounds");
  git(work, "push", "-q", "origin", "main");
  serve();
  await untilCloned();
  await untilApproved();
  const bad = await skel("start", "app", "Fix typo", "In the README", "--flow", "quick");
  expect(bad.err).toContain("app's flow quick (.agents/flows/quick.yaml) has no valid round limit");
  expect(bad.err).toContain(".agents/flows/quick.yaml in simon/app");
  const config = join(home, ".config", "skelcrew", "config.yaml");
  writeFileSync(config, "harness: claude\nmax_rounds: 0\n");
  // The flow names no rounds, so your config's bad max_rounds is its round limit.
  const builtIn = "app's flow default (Skelcrew's built-in default flow) has no valid round limit";
  const yours = await skel("start", "app", "Fix typo", "In the README");
  expect(yours.err).toContain(builtIn);
  expect(yours.err).toContain(`${config} isn't valid`);
  const issue = await skel("start", "app-12");
  expect(issue.err).toContain(builtIn);
  expect(issue.err).toContain(`${config} isn't valid`);
  expect(flows()).toEqual([]);
});

// Bringing a repository in by naming it is gone: you add one in your own terminal.
test("a repository Skelcrew doesn't have, named by its owner/name, is no repository", async () => {
  onGitHub({}, "site");
  serve();
  await untilAnswers();
  for (const name of ["simon/site", "site", "-x/site"]) {
    const listed = await skel("issue", "ls", name);
    expect(listed.code).not.toBe(0);
    expect(listed.err).toBe(`Skelcrew: there is no repository named ${name}\n`);
  }
  expect(asked(plugin).filter((q) => q.ask === "claims")).toEqual([]);
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
    // The daemon gives it half a second to end, rather than its usual five.
    const run = startDaemon(socket, { ...env(), SKELCREW_STOP_WAIT_MS: "500" }, running);
    await until(() => read(join(home, "held")) !== "");
    await stop(run);
    expect(stillRunning([Number(read(join(home, "held")))])).toEqual([]);
  }, 60_000);
});

test("sc issue create and sc start say when the daemon isn't running", async () => {
  const made = await skel("issue", "create", "app", "Add import", "From CSV");
  expect(made.code).not.toBe(0);
  expect(made.err).toContain("run sc");
});

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("with a builder", () => {
  test("starts the builder in the sandbox, in a clone of its own, on a branch of its own", async () => {
    addApp({
      "skelcrew.yaml":
        "setup:\n  - echo set up > setup-ran\n  - test -e $HOME/.config/skelcrew/claude-token || echo token-hidden >> setup-ran\n",
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
    expect(git(clone(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("skelcrew/12-add-export");
    expect(read(join(clone(), "setup-ran"))).toBe("set up\ntoken-hidden\n");
    expect(read(join(config("app-12"), "pwd"))).toBe(`${clone()}\n`);
    // Its own repository's clone is its origin, read-only; Skelcrew's other clones stay hidden.
    expect(read(join(config("app-12"), "seen"))).toBe(
      "others-hidden\norigin-read-only\nSimon\n0\n",
    );
    const args = read(join(config("app-12"), "args"));
    expect(args).toContain("--model\nopus\n");
    expect(args.endsWith("Add export\n\nAs JSON\n")).toBe(true);
    const env = read(join(config("app-12"), "env"));
    expect(env).toContain("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false\n");
    expect(env).toContain("SKELCREW_SANDBOX=1\n");
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
  }, 60_000);

  test("starts from the branch given with --from, on the model in your config", async () => {
    const work = addApp();
    git(work, "checkout", "-q", "-b", "next");
    writeFileSync(join(work, "NEXT"), "next\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "next");
    git(work, "push", "-q", "origin", "next");
    writeFileSync(
      join(home, ".config", "skelcrew", "config.yaml"),
      "harness: claude\nbuilder: { model: sonnet }\n",
    );
    serve();
    await untilCloned();
    expect((await skel("start", "app-12", "--from", "next")).err).toBe("");
    await until(() => read(join(config("app-12"), "args")) !== "");
    expect(existsSync(join(clone(), "NEXT"))).toBe(true);
    expect(read(join(config("app-12"), "args"))).toContain("--model\nsonnet\n");
  }, 60_000);

  test("the builder's socket tells Skelcrew which thread calls, and answers nothing else", async () => {
    addApp();
    const asker = `const [request] = process.argv.slice(2);
const c = require("node:net").createConnection(process.env.SKELCREW_SOCKET);
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
  }, 60_000);

  test("the lead runs sc issue create and sc start from its sandbox, but can't trust", async () => {
    addApp();
    const asker = `const c = require("node:net").createConnection(process.env.SKELCREW_SOCKET);
c.on("connect", () => c.write('{"command":"lead"}\\n'));
c.on("data", (d) => process.stdout.write(d));`;
    writeFileSync(join(home, "bin", "ask.js"), asker);
    fakeClaude(
      `{ sc issue create app "Add import" "From CSV"; sc start app-12; sc repo trust simon/other; bun ${join(home, "bin", "ask.js")}; } > out.new 2>&1; mv out.new out`,
      "",
    );
    // Opened before, so the daemon starts app's lead as it starts.
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("UPDATE repositories SET opened = 1");
    db.close();
    serve();
    const out = join(data(), "leads", "simon", "app", "out");
    await until(() => read(out) !== "");
    expect(read(out)).toBe(
      `app-13\nStarted app-12.\nSkelcrew: trusting a repository is only for your own terminal, not for agents\n{"error":"the daemon doesn't know that request"}\n`,
    );
    await until(() => read(join(config("app-12"), "args")) !== "");
  }, 60_000);

  test("a thread whose setup fails is marked failed, and starting it again starts over", async () => {
    const work = addApp({ "skelcrew.yaml": "setup: [echo fine, echo broken >&2 && exit 3]\n" });
    serve();
    await untilCloned();
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => thread().status === "failed");
    // The daemon saves a thread before it appends the thread to its log.
    await until(() => read(join(data(), "threads", "app-12.log")).includes("broken"));
    expect(hasSession("app-12")).toBe(false);
    writeFileSync(join(work, "skelcrew.yaml"), "setup: [echo fixed > fixed]\n");
    git(work, "commit", "-q", "-am", "fix setup");
    git(work, "push", "-q", "origin", "main");
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => read(join(config("app-12"), "args")) !== "");
    expect(read(join(clone(), "fixed"))).toBe("fixed\n");
    expect(thread().status).toBe("working");
  }, 60_000);

  // Setup deletes the thread's folder before it clones, outside the sandbox, so a folder name
  // that climbs out of Skelcrew's threads folder must never be deleted, however it was saved.
  test("starting over refuses a thread folder outside Skelcrew's threads folder, and deletes nothing", async () => {
    addApp();
    const victim = join(data(), "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep"), "mine\n");
    const db = new Database(join(data(), "skelcrew.db"));
    db.run(threadSql({ task: "12", folder: "../victim", status: "failed" }));
    db.close();
    serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => thread().status === "failed" && thread().started !== null);
    expect(read(join(victim, "keep"))).toBe("mine\n");
  }, 60_000);

  test("refuses a second thread on a task that has one", async () => {
    addApp();
    serve();
    await untilCloned();
    await skel("start", "app-12");
    // The tracker is failing now, and the refusal needs nothing from it.
    writeFileSync(join(plugin, "fail-changed"), "HTTP 502: Bad Gateway");
    const again = await skel("start", "app-12");
    expect(again.code).not.toBe(0);
    expect(again.err).toBe("Skelcrew: app-12 has a thread already\n");
  }, 60_000);

  test("sc stop ends the builder and keeps its clone, a restart leaves it stopped, and sc start brings it back with --resume", async () => {
    addApp();
    // Opened before, so the daemon starts app's lead, whose socket the stop comes from.
    const db = new Database(join(data(), "skelcrew.db"));
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
    // Runs sc stop as an agent would, with its own socket.
    const stopFrom = (agent: string) =>
      Bun.spawnSync([process.execPath, main, "stop", "app-12"], {
        env: { ...env(), SKELCREW_SOCKET: agent },
        stderr: "pipe",
        stdout: "pipe",
      });
    const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
    const fromBuilder = stopFrom(join(home, "run", "skelcrew", "threads", short, "skelcrew.sock"));
    expect(fromBuilder.stderr.toString()).toContain("doesn't know that request");
    expect(hasSession("app-12")).toBe(true);

    const lead = new Bun.CryptoHasher("sha256").update("simon/app").digest("hex").slice(0, 16);
    const fromLead = stopFrom(join(home, "run", "skelcrew", "leads", lead, "skelcrew.sock"));
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

    // A short title given as it comes back is saved with it.
    const started = await skel("start", "app-12", "--short", "Export");
    expect(started.err).toBe("");
    expect(started.out).toContain("Started app-12 again");
    expect(thread().short).toBe("Export");
    await until(() => read(join(config("app-12"), "calls")).includes("--resume"));
    expect(read(join(config("app-12"), "calls"))).toContain(`--resume ${session}`);
    // The fake harness writes where it runs after it logs its call, so the test waits for both.
    await until(() => read(join(config("app-12"), "pwd")) !== "");
    expect(read(join(config("app-12"), "pwd"))).toBe(`${clone()}\n`);
    expect(hasSession("app-12")).toBe(true);
    expect(thread().status).toBe("working");
  }, 60_000);

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
    await until(() => read(join(config("app-12"), "pwd")) !== "");
    expect(read(join(config("app-12"), "pwd"))).toBe(`${clone()}\n`);
    expect(hasSession("app-12")).toBe(true);
    expect(thread().session).toBe(session);
    expect((await skel("start", "simon/app-12")).err).toContain(
      "simon/app-12 has a thread already",
    );
  }, 60_000);

  // The lead's messages change the task, and the reviewer judges the builder by them, so a
  // builder starting afresh gets them too.
  test("a builder that never saved a conversation starts again from the task, with the lead's messages", async () => {
    addApp();
    const first = serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "");
    const session = String(thread().session);
    await stop(first);
    const db = new Database(join(data(), "skelcrew.db"));
    const updates = [{ from: "lead", at: Date.UTC(2026, 10, 16, 9, 30), text: "Keep CSV too." }];
    db.run("UPDATE tasks SET updates = ?", [JSON.stringify(updates)]);
    db.close();
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    rmSync(join(config("app-12"), "args"));
    serve();
    await until(() => read(join(config("app-12"), "args")) !== "");
    const fresh = String(thread().session);
    expect(fresh).not.toBe(session);
    const args = read(join(config("app-12"), "args"));
    expect(args).toContain(`--session-id\n${fresh}\n`);
    expect(
      args.endsWith(
        "Add export\n\nAs JSON\n\n## Changes to the task from the lead, after the thread started\n\nThese override the task above where they differ. The latest comes last.\n\n### 2026-11-16 09:30 UTC\n\nKeep CSV too.\n",
      ),
    ).toBe(true);
  }, 60_000);

  test("a thread whose setup the daemon's stop cut short is marked failed when it comes back", async () => {
    addApp({ "skelcrew.yaml": "setup: [sleep 30]\n" });
    const first = serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => existsSync(join(clone(), "skelcrew.yaml")));
    await stop(first);
    serve();
    await until(() => thread().status === "failed");
    await until(() => read(join(data(), "threads", "app-12.log")).includes("run sc start again"));
    expect(hasSession("app-12")).toBe(false);
  }, 60_000);

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
  }, 60_000);

  test("sc stop refuses a thread still setting up, and one with no builder", async () => {
    addApp({ "skelcrew.yaml": "setup: [sleep 2, exit 3]\n" });
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
  }, 60_000);

  // A stopped thread's builder sits at its prompt once back, so sc start must say whether
  // something will wake it. Sets the row while the thread is stopped, as a round would have.
  test("a stopped thread comes back waiting on its PR, or working on a review's changes", async () => {
    addApp();
    serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "");
    const stoppedWith = async (columns: string) => {
      await skel("stop", "app-12");
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      db.run(`UPDATE tasks SET ${columns}`);
      db.close();
      expect((await skel("start", "app-12")).out).toContain("Started app-12 again");
      return thread().status;
    };
    expect(await stoppedWith("pr = 7")).toBe("waiting");
    expect(await stoppedWith("telling = 'Add a test.'")).toBe("working");
  }, 60_000);

  // The daemon brings back threads once the lead has started, which takes a moment.
  test("a thread started while the daemon starts the lead isn't taken for one cut short", async () => {
    addApp({ "skelcrew.yaml": "setup: [sleep 3]\n" });
    serve();
    await untilAnswers();
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => read(join(config("app-12"), "args")) !== "");
    expect(thread().status).toBe("working");
  }, 60_000);

  test("gives two threads whose names would make the same folder a folder each", async () => {
    addApp();
    onGitHub({}, "app", "bob");
    onGitHub({}, "simon-app", "bob");
    const script = `import { nameRepositories, openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo) VALUES ('x', 'bob', 'app'), ('y', 'bob', 'simon-app')");
db.run("UPDATE repositories SET forge = 'github', claimed = 1, remote = 'https://github.com/' || owner || '/' || repo || '.git'");
nameRepositories(db);`;
    expect(Bun.spawnSync([process.execPath, "-e", script], { env: env() }).success).toBe(true);
    serve();
    await untilAnswers();
    expect((await skel("start", "simon/app-12")).err).toBe("");
    expect((await skel("start", "simon-app-12")).err).toBe("");
    const db = new Database(join(data(), "skelcrew.db"));
    // The daemon may be writing, and a read that meets a write fails without a wait.
    db.run("PRAGMA busy_timeout = 5000");
    const folders = db.query("SELECT folder FROM threads ORDER BY owner DESC").values();
    db.close();
    expect(folders).toEqual([["simon-app-12"], ["simon-app-12-2"]]);
  }, 60_000);

  test("a thread started before Skelcrew's clone of its repository is made waits for it", async () => {
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
  }, 60_000);

  // Its skelcrew.yaml, which names its tracker, is in Skelcrew's clone.
  test("sc start on a repository whose clone isn't there yet waits for Skelcrew's clone", async () => {
    addApp({}, "site");
    holdClones();
    serve();
    await untilAnswers();
    const started = skel("start", "site-12");
    await until(() => existsSync(join(home, "held")));
    await Bun.sleep(300);
    expect(existsSync(join(data(), "repos", "simon", "site"))).toBe(false);
    writeFileSync(join(home, "go"), "");
    expect((await started).out).toBe("Started site-12.\n");
    await until(() => read(join(config("site-12"), "args")) !== "");
    expect(thread()).toMatchObject({ owner: "simon", repo: "site", status: "working" });
  }, 60_000);

  // You can start work straight from the lead, with no issue filed first, even where the
  // repository plans in a tracker.
  test("sc start on what you said starts a thread of Skelcrew's own in a repository with a tracker", async () => {
    addApp();
    serve();
    await untilAnswers();
    const run = await skel("start", "app", "Add export", "As JSON");
    expect(run.err).toBe("");
    expect(run.out).toBe(`Started app-${own}1.\n`);
    await until(() => read(join(config(`app-${own}1`), "args")) !== "");
    expect(read(join(config(`app-${own}1`), "args"))).toContain("Add export\n\nAs JSON");
    expect(thread()).toMatchObject({ task: `${own}1`, title: "Add export", body: "As JSON" });
    expect(asked(plugin).filter((q) => q.ask === "create task")).toEqual([]);
  }, 60_000);

  // A long body needs no shell quoting when the lead gives the task on stdin, from a heredoc.
  test("sc start <repo> reads the task from stdin, its title on the first line", async () => {
    addApp();
    serve();
    await untilAnswers();
    const task = '# Add export\n\n\nAs JSON, with "quotes" and $HOME.\nAnd dates.\n';
    const run = await runSkel(["start", "app"], env(), task);
    expect(run.err).toBe("");
    expect(run.out).toBe(`Started app-${own}1.\n`);
    expect(thread()).toMatchObject({
      task: `${own}1`,
      title: "Add export",
      body: 'As JSON, with "quotes" and $HOME.\nAnd dates.\n',
    });
  }, 60_000);

  // Names stay apart across machines: another machine with the same code already claimed the
  // name of its first thread on the remote, so this one takes the next number and claims it.
  test("sc start on what you said skips a name another machine claimed, and claims its own", async () => {
    const work = addApp();
    git(work, "push", "-q", "origin", `main:refs/skelcrew/names/${own}1`);
    serve();
    await untilCloned();
    const run = await skel("start", "app", "Add export", "As JSON");
    expect(run.err).toBe("");
    expect(run.out).toBe(`Started app-${own}2.\n`);
    expect(thread()).toMatchObject({ task: `${own}2`, branch: `skelcrew/${own}2-add-export` });
    const claims = git(work, "ls-remote", "origin", "refs/skelcrew/names/*");
    expect(claims).toContain(`refs/skelcrew/names/${own}2`);
  }, 60_000);

  // An issue with the shape of Skelcrew's own ID, such as wr1, would share its name with a thread
  // started with no issue. Skelcrew leaves it out, so the name stays the thread's.
  test("an issue whose ID has the shape of a machine's own is left out", async () => {
    addApp();
    known.push(taskItem(`${own}1`, "Add import", { body: "From CSV" }));
    answer(plugin, "changed", { items: known, next: null });
    serve();
    await untilCloned();
    const refused = await skel("start", `app-${own}1`);
    expect(refused.err).toContain(`there is no open issue ${own}1 in app`);
    const run = await skel("start", "app", "Add export", "As JSON");
    expect(run.out).toBe(`Started app-${own}1.\n`);
    expect(thread()).toMatchObject({ task: `${own}1`, title: "Add export" });
  }, 60_000);

  // The lead names each thread it starts in two or three words, for the sidebar's row.
  test("sc start --short gives a thread its short title, however the task is given", async () => {
    addApp();
    serve();
    await untilCloned();
    const named = await skel("start", "app", "Add export", "As JSON", "--short", "JSON export");
    expect(named.err).toBe("");
    expect(named.out).toBe(`Started app-${own}1.\n`);
    expect(thread()).toMatchObject({ task: `${own}1`, title: "Add export", short: "JSON export" });
    const piped = await runSkel(
      ["start", "app", "--short", "Notes"],
      env(),
      "Add notes\n\nAs text",
    );
    expect(piped.err).toBe("");
    expect(piped.out).toBe(`Started app-${own}2.\n`);
    const issue = await skel("start", "app-12", "--short", "Export");
    expect(issue.err).toBe("");
    expect(issue.out).toBe("Started app-12.\n");
    const db = new Database(join(data(), "skelcrew.db"));
    const shorts = db.query("SELECT task, short FROM tasks ORDER BY task").all();
    db.close();
    expect(shorts).toEqual([
      { task: 12, short: "Export" },
      { task: `${own}1`, short: "JSON export" },
      { task: `${own}2`, short: "Notes" },
    ]);
    expect((await skel("start", "app-12", "--short", " ")).code).not.toBe(0);
    expect((await skel("start", "app-12", "--short")).code).not.toBe(0);
  }, 60_000);

  // A thread started from GitHub gets its short title once the lead hears of it, while its
  // builder works. Naming it must not start, stop or tell the builder anything.
  test("sc start --short on a thread at work sets only its short title", async () => {
    addApp();
    serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "");
    // Starting it claimed the issue and assigned it to you, which naming it mustn't do again.
    const tracker = () => asked(plugin).filter((q) => q.ask === "took" || q.ask === "assign");
    await until(() => tracker().some((q) => q.ask === "assign") && thread().assigned === 1);
    const asks = tracker().length;
    const before = thread();
    const calls = read(join(config("app-12"), "calls"));
    const named = await skel("start", "app-12", "--short", "Export");
    expect(named.err).toBe("");
    expect(named.out).toBe('Gave app-12 the short title "Export".\n');
    // The tracker would hear of a claim or assignment within moments of the answer.
    await Bun.sleep(1000);
    expect(tracker()).toHaveLength(asks);
    // Naming it goes in its log, which is a change the list of threads shows.
    expect(thread()).toEqual({ ...before, short: "Export", changed: expect.any(Number) });
    expect(read(join(config("app-12"), "calls"))).toBe(calls);
    expect(hasSession("app-12")).toBe(true);
    // Without --short, starting it again is still refused.
    expect((await skel("start", "app-12")).err).toBe("Skelcrew: app-12 has a thread already\n");
  }, 60_000);

  // A task started from a label runs the default flow, and the lead can switch it to another
  // until its builder first submits.
  test("sc start --flow switches a thread at work until its builder submits", async () => {
    // A third flow, careful, builds with a role of the repository's own.
    const work = addFlows();
    mkdirSync(join(work, ".agents", "roles"), { recursive: true });
    writeFileSync(join(work, ".agents", "flows", "careful.yaml"), "build:\n  role: tester\n");
    writeFileSync(join(work, ".agents", "roles", "tester.md"), "Write the test first.\n");
    // And lax names no rounds, so your config's max_rounds gives its round limit.
    writeFileSync(join(work, ".agents", "flows", "lax.yaml"), "build:\n  role: builder\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "careful");
    git(work, "push", "-q", "origin", "main");
    serve();
    await untilCloned();
    await untilApproved();
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    expect(flows()).toEqual([{ task: 12, flow: "default" }]);
    const switched = await skel("start", "app-12", "--flow", "quick");
    expect(switched.err).toBe("");
    expect(switched.out).toBe("app-12 now runs the flow quick.\n");
    expect(flows()).toEqual([{ task: 12, flow: "quick" }]);
    expect((await skel("start", "app-12", "--flow", "slow")).err).toBe(
      "Skelcrew: app has no flow slow. Its flows are default, careful, lax, quick.\n",
    );
    // Its builder already runs as builder, so a flow that builds as another role is refused, and
    // the builder keeps the instructions it started with.
    expect((await skel("start", "app-12", "--flow", "careful")).err).toBe(
      "Skelcrew: app-12 keeps the flow quick: its builder already runs as builder, and careful builds as tester. To run careful, start it over: sc rm app-12, then sc start app-12 --flow careful.\n",
    );
    expect(flows()).toEqual([{ task: 12, flow: "quick" }]);
    expect(read(join(config("app-12"), "args"))).not.toContain("Write the test first.");
    // A switch to a flow whose round limit isn't valid is refused, naming where it is.
    const yours = join(home, ".config", "skelcrew", "config.yaml");
    writeFileSync(yours, "harness: claude\nmax_rounds: 0\n");
    const lax = (await skel("start", "app-12", "--flow", "lax")).err;
    expect(lax).toContain("app's flow lax (.agents/flows/lax.yaml) has no valid round limit");
    expect(lax).toContain(`${yours} isn't valid`);
    expect(flows()).toEqual([{ task: 12, flow: "quick" }]);
    writeFileSync(yours, "harness: claude\n");
    // A stopped thread whose builder hasn't submitted switches too, and comes back on that flow.
    expect((await skel("stop", "app-12")).code).toBe(0);
    expect((await skel("start", "app-12", "--flow", "careful")).err).toBe(
      "Skelcrew: app-12 keeps the flow quick: its builder already runs as builder, and careful builds as tester. To run careful, start it over: sc rm app-12, then sc start app-12 --flow careful.\n",
    );
    expect(thread().status).toBe("stopped");
    const back = await skel("start", "app-12", "--flow", "default");
    expect(back.err).toBe("");
    expect(back.out).toBe(
      "Started app-12 again on the flow default: its builder is back where it was.\n",
    );
    expect(flows()).toEqual([{ task: 12, flow: "default" }]);
    await until(() => thread().status === "working" && hasSession("app-12"));
    expect((await skel("start", "app-12", "--flow", "quick")).out).toBe(
      "app-12 now runs the flow quick.\n",
    );
    // Once its builder has submitted, the task keeps its flow to the end.
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    // A first review under way, before it is timed, as in a repository with no forge.
    db.run("UPDATE tasks SET reviewing = 'abc' WHERE task = 12");
    expect((await skel("start", "app-12", "--flow", "default")).err).toBe(
      "Skelcrew: app-12 keeps the flow quick, as its builder has submitted already.\n",
    );
    db.run("UPDATE tasks SET reviewing = NULL, review_at = 1 WHERE task = 12");
    db.close();
    expect((await skel("start", "app-12", "--flow", "default")).err).toBe(
      "Skelcrew: app-12 keeps the flow quick, as its builder has submitted already.\n",
    );
    // So does a stopped one, which stays stopped.
    expect((await skel("stop", "app-12")).code).toBe(0);
    expect((await skel("start", "app-12", "--flow", "default")).err).toBe(
      "Skelcrew: app-12 keeps the flow quick, as its builder has submitted already.\n",
    );
    expect(thread().status).toBe("stopped");
  }, 60_000);

  // Programs often live under the home folder, which the sandbox hides, as npm does under nvm.
  test("a setup command finds its program under your home folder", async () => {
    addApp({ "skelcrew.yaml": "setup: [cd . && X=1 tool --flag]\n" });
    mkdirSync(join(home, "tools"));
    writeFileSync(join(home, "tools", "tool"), '#!/bin/sh\necho "ran $1" > ran\n', { mode: 0o755 });
    startDaemon(socket, { ...env(), PATH: `${join(home, "tools")}:${env().PATH}` }, running);
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "" || thread().status === "failed");
    expect(read(join(clone(), "ran"))).toBe("ran --flag\n");
  }, 60_000);

  // Skelcrew never guesses a setup command from the repository's files, as a wrong guess
  // would run unseen. The lead settles it with you instead.
  test("without a skelcrew.yaml, no setup command runs, even where one could be guessed", async () => {
    addApp({ "go.mod": "module app\n" });
    mkdirSync(join(home, "tools"));
    writeFileSync(join(home, "tools", "go"), '#!/bin/sh\necho "ran go $*" > ran\n', {
      mode: 0o755,
    });
    startDaemon(socket, { ...env(), PATH: `${join(home, "tools")}:${env().PATH}` }, running);
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "" || thread().status === "failed");
    expect(thread().status).not.toBe("failed");
    expect(existsSync(join(clone(), "ran"))).toBe(false);
  }, 60_000);

  test("a setup command can't bring back a folder of yours by naming a program in it", async () => {
    mkdirSync(join(home, "tools"));
    writeFileSync(join(home, "tools", "tool"), "#!/bin/sh\necho ran > ran\n", { mode: 0o755 });
    addApp({ "skelcrew.yaml": `setup: ["${join(home, "tools", "tool")} || echo hidden > ran"]\n` });
    serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "" || thread().status === "failed");
    expect(read(join(clone(), "ran"))).toBe("hidden\n");
  }, 60_000);

  // A builder's config folder and session are named after the thread's folder, which must
  // start with a letter or digit. A long folder would make Claude Code hash the name of
  // the folder its conversations are saved in, and Skelcrew would miss them when bringing the
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
  }, 60_000);
});
