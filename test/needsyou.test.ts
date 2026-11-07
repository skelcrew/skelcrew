// Needs you, against a running daemon: a builder's question marks its thread needs you, and
// skel types a note into the lead's session when a thread starts needing you. A shell script
// stands in for Claude Code: as the builder it runs the hook commands in its settings, as
// Claude Code would around AskUserQuestion, and as the lead it waits at a ❯ prompt.
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
import { source } from "./harness.ts";

const main = source("main.ts");
const daemon = source("daemon.ts");
let home = "";
let socket = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skel");
const builder = () => join(data(), "claude", "app-12");
const lead = () => join(data(), "claude", "lead");
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

function script(name: string, body: string): void {
  writeFileSync(join(home, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// Stands in for Claude Code. As the lead, it waits at a ❯ prompt and keeps what is typed into
// it, looking busy while the file busy is in its config folder. As the builder, it runs the
// hook commands its settings give for an event when the test leaves a file named for it:
// ask for AskUserQuestion's PreToolUse, answer for its PostToolUse, and talk for
// UserPromptSubmit. Each hook gets a line in the file ran once it has finished.
function fakeClaude(): void {
  script(
    "claude",
    `printf '%s\\n' "$@" > "$CLAUDE_CONFIG_DIR/args"
case "$CLAUDE_CONFIG_DIR" in */lead)
  printf '\\033[?2004h'
  stty -echo
  # A shell gives a command run in the background /dev/null as its input, unless told.
  exec 3<&0
  while IFS= read -r line; do printf '%s\\n' "$line" >> "$CLAUDE_CONFIG_DIR/typed"; done <&3 &
  for i in $(seq 3000); do
    now=idle; test -e "$CLAUDE_CONFIG_DIR/busy" && now=busy
    if [ "$now" != "$shown" ]; then
      clear; if [ $now = busy ]; then echo "esc to interrupt"; else echo "❯"; fi; shown=$now
    fi
    sleep 0.1
  done ;;
esac
for a; do [ "$prev" = --settings ] && settings=$a; prev=$a; done
hook() {
  bun -e 'const [settings, event, tool] = process.argv.slice(1);
for (const group of JSON.parse(settings).hooks?.[event] ?? [])
  if (!group.matcher || group.matcher === tool)
    for (const hook of group.hooks) console.log(hook.command);' "$settings" "$1" "$2" |
  while IFS= read -r command; do echo '{}' | sh -c "$command" >> "$CLAUDE_CONFIG_DIR/hooks" 2>&1; done
  echo "$1" >> "$CLAUDE_CONFIG_DIR/ran"
}
echo "❯"
for i in $(seq 3000); do
  test -e "$CLAUDE_CONFIG_DIR/ask" && { rm "$CLAUDE_CONFIG_DIR/ask"; hook PreToolUse AskUserQuestion; }
  test -e "$CLAUDE_CONFIG_DIR/answer" && { rm "$CLAUDE_CONFIG_DIR/answer"; hook PostToolUse AskUserQuestion; }
  test -e "$CLAUDE_CONFIG_DIR/talk" && { rm "$CLAUDE_CONFIG_DIR/talk"; hook UserPromptSubmit; }
  sleep 0.1
done`,
  );
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-needsyou-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  mkdirSync(join(home, "gh"));
  fakeClaude();
  script("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  script(
    "gh",
    `case "$*" in
"api repos/simon/app/issues/12") echo '{"number":12,"title":"Add export","body":"As JSON"}' ;;
*) echo "the fake gh doesn't know $*" >&2; exit 1 ;;
esac`,
  );
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skel.service"), "");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${join(home, "github")}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Simon\n\temail = simon@example.com\n`,
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

const env = () => ({
  HOME: home,
  XDG_RUNTIME_DIR: join(home, "run"),
  PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
});

function serve(): Subprocess {
  const code = `import { serve } from ${JSON.stringify(daemon)};
await serve(${JSON.stringify(socket)});`;
  const run = Bun.spawn([process.execPath, "-e", code], {
    env: env(),
    stdout: "ignore",
    stderr: "ignore",
  });
  running.push(run);
  return run;
}

// Runs skel as you would, or as a builder's hook would with its thread's socket.
async function skel(args: string[], more: Record<string, string> = {}) {
  const run = Bun.spawn([process.execPath, main, ...args], {
    env: { ...env(), ...more },
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

async function until(done: () => boolean, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("gave up waiting");
    await Bun.sleep(50);
  }
}

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

// Puts simon/app on the fake GitHub and tells skel about it.
function addApp(): void {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(home, "github", "simon", "app.git"));
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app')");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
}

// What skel ps --json shows you about app-12.
async function needsYou(): Promise<boolean> {
  const ps = await skel(["ps", "--json"]);
  return JSON.parse(ps.out).find((t: { thread: string }) => t.thread === "app-12")?.needsYou;
}

async function untilNeedsYou(wanted: boolean) {
  const deadline = Date.now() + 15_000;
  while ((await needsYou()) !== wanted) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for needs you to be ${wanted}`);
    await Bun.sleep(100);
  }
}

// Has the fake builder run the hooks for an event, as Claude Code would, and waits for them.
async function hook(step: "ask" | "answer" | "talk") {
  const before = read(join(builder(), "ran")).split("\n").length;
  writeFileSync(join(builder(), step), "");
  await until(() => read(join(builder(), "ran")).split("\n").length > before);
}

const notes = () => read(join(lead(), "typed")).split("\x1b[201~").length - 1;

function setNeedsYou(): void {
  const db = new Database(join(data(), "skel.db"));
  db.run("PRAGMA busy_timeout = 5000");
  db.run("UPDATE threads SET needs_you = 1");
  db.close();
}

// Asks the daemon for the lead, as plain skel does before attaching, without attaching.
function askForLead(from?: string): Promise<string> {
  return new Promise((done) => {
    const connection = createConnection(join(home, "run", "skel.sock"));
    let reply = "";
    connection.on("connect", () =>
      connection.write(`${JSON.stringify({ command: "lead", from })}\n`),
    );
    connection.on("data", (more) => {
      reply += more.toString();
    });
    connection.on("close", () => done(reply));
  });
}

async function startApp12() {
  serve();
  await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
  expect((await skel(["start", "app-12"])).err).toBe("");
  await until(() => read(join(builder(), "args")) !== "", 30_000);
}

// bubblewrap can't start inside skel's own sandbox, so only there builders can't start.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("needs you", () => {
  test("a builder's question marks the thread needs you, tells the lead once, and clears when answered", async () => {
    addApp();
    await startApp12();
    expect(await needsYou()).toBe(false);

    await hook("ask");
    expect(read(join(builder(), "hooks"))).toBe("");
    await untilNeedsYou(true);
    await until(() => notes() === 1);
    expect(read(join(lead(), "typed"))).toContain("app-12 needs you: its builder asked a question");

    // A second question while the first still waits is no news.
    await hook("ask");
    await hook("answer");
    expect(read(join(builder(), "hooks"))).toBe("");
    await untilNeedsYou(false);
    await Bun.sleep(1500);
    expect(notes()).toBe(1);

    // A question you set aside, then talked past, is over too.
    await hook("ask");
    await untilNeedsYou(true);
    await until(() => notes() === 2);
    await hook("talk");
    await untilNeedsYou(false);
  }, 60_000);

  test("answering a question leaves the thread needing you for another reason", async () => {
    addApp();
    await startApp12();
    setNeedsYou();
    await hook("ask");
    await hook("answer");
    await Bun.sleep(500);
    expect(await needsYou()).toBe(true);
    expect(notes()).toBe(0);
  }, 60_000);

  test("a note waits while the lead is busy, and drops once the thread no longer needs you", async () => {
    addApp();
    mkdirSync(lead(), { recursive: true });
    writeFileSync(join(lead(), "busy"), "");
    await startApp12();
    await hook("ask");
    await untilNeedsYou(true);
    await Bun.sleep(1500);
    expect(notes()).toBe(0);
    rmSync(join(lead(), "busy"));
    await until(() => notes() === 1);

    writeFileSync(join(lead(), "busy"), "");
    await hook("answer");
    await hook("ask");
    await Bun.sleep(1000);
    await hook("answer");
    await untilNeedsYou(false);
    rmSync(join(lead(), "busy"));
    await Bun.sleep(2000);
    expect(notes()).toBe(1);
  }, 60_000);

  // A needs-you note must reach you when you haven't typed anything. Where you attached from
  // waits for your next message instead.
  test("a needs-you note is typed into the lead, and where you attached from is not", async () => {
    addApp();
    await startApp12();
    expect(await askForLead("simon/app")).toContain('"lead":true');
    await hook("ask");
    await untilNeedsYou(true);
    await until(() => notes() === 1);
    await Bun.sleep(1000);
    expect(notes()).toBe(1);
    expect(read(join(lead(), "typed"))).toContain("app-12 needs you: its builder asked a question");
    expect(read(join(lead(), "typed"))).not.toContain("attached");
  }, 60_000);

  test("a note for a lead that isn't running is typed once the lead starts again", async () => {
    addApp();
    await startApp12();
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=lead"]);
    rmSync(join(lead(), "typed"), { force: true });
    await hook("ask");
    await untilNeedsYou(true);
    await Bun.sleep(1000);
    expect(await askForLead()).toContain('"lead":true');
    await until(() => notes() === 1);
    expect(read(join(lead(), "typed"))).toContain("app-12 needs you: its builder asked a question");
  }, 60_000);
});

test("only a builder can say it is asking you a question", async () => {
  serve();
  await until(() => existsSync(join(home, "run", "skel.sock")));
  await Bun.sleep(100);
  for (const args of [
    ["question", "asked"],
    ["question", "answered"],
  ]) {
    const run = await skel(args);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("doesn't know that request");
  }
});
