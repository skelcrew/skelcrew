// skel issue and skel start, run as you or the lead would run them, against a running daemon,
// a fake gh, a fake Claude Code and a folder of bare repositories standing in for GitHub.
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

const main = join(import.meta.dir, "..", "src", "main.ts");
const daemon = join(import.meta.dir, "..", "src", "daemon.ts");
let home = "";
let socket = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skel");
const config = (name: string) => join(data(), "claude", name);
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

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
*/lead) ${lead} ;;
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
  // The fake GitHub answers for issues from the files in ~/issues, and makes issue 13.
  mkdirSync(join(home, "issues"));
  fake(
    "gh",
    `case "$*" in
"api repos/simon/app/issues --method POST --input -") cat > "$HOME/issues/sent"; echo '{"number":13}' ;;
"api repos/"*"/issues/"*) cat "$HOME/issues/\${2##*/}" 2>/dev/null || { echo "Not Found" >&2; exit 1; } ;;
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

function issue(number: number, title: string, body: string): void {
  writeFileSync(join(home, "issues", String(number)), JSON.stringify({ number, title, body }));
}

const env = () => ({
  HOME: home,
  XDG_RUNTIME_DIR: join(home, "run"),
  PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
});

function serve(): Subprocess {
  const script = `import { serve } from ${JSON.stringify(daemon)};
await serve(${JSON.stringify(socket)});`;
  const run = Bun.spawn([process.execPath, "-e", script], {
    env: env(),
    stdout: "ignore",
    stderr: "ignore",
  });
  running.push(run);
  return run;
}

async function stop(run: Subprocess): Promise<void> {
  run.kill();
  await run.exited;
}

async function skel(...args: string[]) {
  const run = Bun.spawn([process.execPath, main, ...args], {
    env: env(),
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

async function until(done: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("gave up waiting");
    await Bun.sleep(50);
  }
}

async function untilAnswers() {
  await until(() => existsSync(join(home, "run", "skel.sock")));
  await Bun.sleep(100);
}

const github = () => join(home, "github");

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

// Puts simon/app on the fake GitHub with the files given, and tells skel about it. Returns a
// checkout to push more from.
function addApp(files: Record<string, string> = {}): string {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(github(), "simon", "app.git"));
  git(work, "remote", "add", "origin", join(github(), "simon", "app.git"));
  const script = `import { openDb } from ${JSON.stringify(join(import.meta.dir, "..", "src", "db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app')");`;
  const added = Bun.spawnSync([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  return work;
}

// skel's own clone, which the daemon makes when the lead starts.
const untilCloned = () => until(() => existsSync(join(data(), "repos", "simon", "app", "README")));

function thread(): Record<string, unknown> {
  const db = new Database(join(data(), "skel.db"));
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

test("skel issue creates the issue on GitHub and prints its number", async () => {
  addApp();
  serve();
  await untilAnswers();
  const made = await skel("issue", "app", "Add import", "From CSV");
  expect(made.err).toBe("");
  expect(made.out).toBe("13\n");
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
  await new Promise<void>((done) => {
    const connection = createConnection(join(home, "run", "skel.sock"));
    connection.on("connect", () => {
      connection.write('{"command":"issue","repo":"app","title":"t","body":"b"}\n');
      setTimeout(() => connection.write("more\n"), 200);
    });
    connection.on("data", () => {});
    connection.on("close", () => done());
  });
  expect(read(join(home, "calls")).match(/--method POST/g)).toHaveLength(1);
});

test("skel start refuses a repository skel doesn't have, and an issue GitHub doesn't", async () => {
  addApp();
  serve();
  await untilAnswers();
  const unknown = await skel("start", "site-1");
  expect(unknown.code).not.toBe(0);
  expect(unknown.err).toContain("no repository named site");
  const missing = await skel("start", "app-99");
  expect(missing.code).not.toBe(0);
  expect(missing.err).toContain("Not Found");
  expect(existsSync(join(data(), "threads", "app-99"))).toBe(false);
});

test("skel issue and skel start say when the daemon isn't running", async () => {
  const made = await skel("issue", "app", "Add import", "From CSV");
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
      `{ test -e ${data()}/repos || echo repos-hidden; git config user.name; git config --get-regexp '^remote' | grep -c github; } > "$CLAUDE_CONFIG_DIR/seen.new" 2>&1; mv "$CLAUDE_CONFIG_DIR/seen.new" "$CLAUDE_CONFIG_DIR/seen"`,
    );
    serve();
    await untilCloned();
    const started = await skel("start", "app-12");
    expect(started.err).toBe("");
    expect(started.out).toBe("Started app-12.\n");
    await until(() => read(join(config("app-12"), "seen")) !== "");
    expect(git(clone(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("skel/12-add-export");
    expect(read(join(clone(), "setup-ran"))).toBe("set up\ntoken-hidden\n");
    expect(read(join(config("app-12"), "pwd"))).toBe(`${clone()}\n`);
    expect(read(join(config("app-12"), "seen"))).toBe("repos-hidden\nSimon\n0\n");
    const args = read(join(config("app-12"), "args"));
    expect(args).toContain("--model\nopus\n");
    expect(args.endsWith("Add export\n\nAs JSON\n")).toBe(true);
    const env = read(join(config("app-12"), "env"));
    expect(env).toContain("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false\n");
    expect(env).toContain("SKEL_SANDBOX=1\n");
    expect(hasSession("app-12")).toBe(true);
    const row = thread();
    expect(row).toMatchObject({ owner: "simon", repo: "app", issue: 12, status: "working" });
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
      `{ ${ask('{"command":"status"}')}; ${ask('{"command":"issue","repo":"app","title":"t","body":"b"}')}; ${ask('{"command":"lead"}')}; } > "$CLAUDE_CONFIG_DIR/replies.new"; mv "$CLAUDE_CONFIG_DIR/replies.new" "$CLAUDE_CONFIG_DIR/replies"`,
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
      { error: "skel's daemon doesn't know that request" },
      { error: "skel's daemon doesn't know that request" },
    ]);
    expect(existsSync(join(home, "issues", "sent"))).toBe(false);
  }, 20_000);

  test("the lead runs skel issue and skel start from its sandbox, but can't trust", async () => {
    addApp();
    const asker = `const c = require("node:net").createConnection(process.env.SKEL_SOCKET);
c.on("connect", () => c.write('{"command":"lead"}\\n'));
c.on("data", (d) => process.stdout.write(d));`;
    writeFileSync(join(home, "bin", "ask.js"), asker);
    fakeClaude(
      `while ! test -e ${data()}/repos/simon/app/README; do sleep 0.1; done
{ skel issue app "Add import" "From CSV"; skel start app-12; skel trust simon/other; bun ${join(home, "bin", "ask.js")}; } > out.new 2>&1; mv out.new out`,
      "",
    );
    serve();
    const out = join(data(), "lead", "out");
    await until(() => read(out) !== "");
    expect(read(out)).toBe(
      `13\nStarted app-12.\nskel: only you can trust a repository, from your own terminal\n{"error":"skel's daemon doesn't know that request"}\n`,
    );
    await until(() => read(join(config("app-12"), "args")) !== "");
  }, 20_000);

  test("a thread whose setup fails is marked failed, and starting it again starts over", async () => {
    const work = addApp({ "skel.yaml": "setup: [echo fine, echo broken >&2 && exit 3]\n" });
    serve();
    await untilCloned();
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => thread().status === "failed");
    expect(read(join(data(), "threads", "app-12.log"))).toContain("broken");
    expect(hasSession("app-12")).toBe(false);
    writeFileSync(join(work, "skel.yaml"), "setup: [echo fixed > fixed]\n");
    git(work, "commit", "-q", "-am", "fix setup");
    git(work, "push", "-q", "origin", "main");
    expect((await skel("start", "app-12")).out).toBe("Started app-12.\n");
    await until(() => read(join(config("app-12"), "args")) !== "");
    expect(read(join(clone(), "fixed"))).toBe("fixed\n");
    expect(thread().status).toBe("working");
  }, 20_000);

  test("refuses a second thread on an issue that has one", async () => {
    addApp();
    serve();
    await untilCloned();
    await skel("start", "app-12");
    const again = await skel("start", "app-12");
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("app-12 has a thread already");
  }, 20_000);

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
    const script = `import { nameRepositories, openDb } from ${JSON.stringify(join(import.meta.dir, "..", "src", "db.ts"))};
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

  test("a builder that never saved a conversation starts again from the issue", async () => {
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
    expect(read(join(data(), "threads", "app-12.log"))).toContain("run skel start again");
    expect(hasSession("app-12")).toBe(false);
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
    const script = `import { nameRepositories, openDb } from ${JSON.stringify(join(import.meta.dir, "..", "src", "db.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo) VALUES ('x', 'bob', 'app'), ('y', 'bob', 'simon-app')");
nameRepositories(db);`;
    expect(Bun.spawnSync([process.execPath, "-e", script], { env: env() }).success).toBe(true);
    serve();
    await untilAnswers();
    expect((await skel("start", "simon/app-12")).err).toBe("");
    expect((await skel("start", "simon-app-12")).err).toBe("");
    const db = new Database(join(data(), "skel.db"));
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
});
