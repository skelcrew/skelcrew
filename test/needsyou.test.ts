// Needs you, against a running daemon: a builder's question marks its thread needs you, and
// skel types a note into the lead's session when a thread starts needing you. A shell script
// stands in for Claude Code: as the builder it runs the hook commands in its settings, as
// Claude Code would around AskUserQuestion, and as the lead it waits at a ❯ prompt.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { leadPlaces } from "../src/paths.ts";
import {
  answer,
  fakePlugin,
  git,
  homeEnv,
  read,
  runSkel,
  source,
  startDaemon,
  taskItem,
  until as wait,
  writeScript,
} from "./harness.ts";

let home = "";
let socket = "";
// The fake plugin's settings folder, where it keeps what it is asked and its answers.
let plugin = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skel");
const builder = () => join(data(), "claude", "app-12");
// The config folder of a repository's lead, where the fake keeps what is typed into it.
const lead = (repo = "app") => join(data(), "claude", leadPlaces("simon", repo).name);

// Puts a program of the test's on its PATH.
const script = (name: string, body: string) => writeScript(home, name, body);

// Stands in for Claude Code. As the lead, it waits at a ❯ prompt and keeps what is typed into
// it, looking busy while the file busy is in its config folder. As the builder, it runs the
// hook commands its settings give for an event when the test leaves a file named for it:
// ask for AskUserQuestion's PreToolUse, answer for its PostToolUse, and talk for
// UserPromptSubmit. Each hook gets a line in the file ran once it has finished.
function fakeClaude(): void {
  script(
    "claude",
    `printf '%s\\n' "$@" > "$CLAUDE_CONFIG_DIR/args"
case "$CLAUDE_CONFIG_DIR" in */lead-*)
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
  fakeClaude();
  script("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  // The tracker answers every poll with issue 12.
  plugin = fakePlugin(home);
  answer(plugin, "changed", {
    items: [taskItem("12", "Add export", { body: "As JSON" })],
    next: null,
  });
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

// What this test's processes run with.
const env = () => homeEnv(home);

// Runs this test's daemon, which the test's clean-up stops.
const serve = () => startDaemon(socket, env(), running);

// Runs skel as you would, or as a builder's hook would with its thread's socket.
const skel = (args: string[], more: Record<string, string> = {}) =>
  runSkel(args, { ...env(), ...more });

// A daemon's work takes its time here, so a wait lasts 15 seconds unless a test says otherwise.
const until = (done: () => boolean, timeout = 15_000) => wait(done, { timeout });

// Puts simon/app, or another of simon's repositories, on the fake GitHub and tells skel about
// it.
function addApp(name = "app"): void {
  const work = join(home, "work", name);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), `${name}\n`);
  writeFileSync(join(work, "skel.yaml"), "tracker: github\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(home, "github", "simon", `${name}.git`));
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES (?, 'simon', ?)", [${JSON.stringify(name)}, ${JSON.stringify(name)}]);
openDb().run("UPDATE repositories SET forge = 'github', claimed = 1, remote = 'https://github.com/' || owner || '/' || repo || '.git'");`;
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

const notes = (repo = "app") => read(join(lead(repo), "typed")).split("\x1b[201~").length - 1;

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

// Starts the daemon and app-12, opening app first, as plain skel in its checkout does, unless
// told not to.
async function startApp12(open = true) {
  serve();
  await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
  if (open) expect(await askForLead("simon/app")).toContain(leadPlaces("simon", "app").name);
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

  // One repository's lead never mentions another's threads.
  test("a needs-you note is typed into the lead of the thread's repository, and no other", async () => {
    addApp();
    addApp("web");
    await startApp12();
    await until(() => existsSync(join(data(), "repos", "simon", "web", "README")));
    expect(await askForLead("simon/web")).toContain(leadPlaces("simon", "web").name);
    await hook("ask");
    await untilNeedsYou(true);
    await until(() => notes() === 1);
    await Bun.sleep(1000);
    expect(notes()).toBe(1);
    expect(read(join(lead(), "typed"))).toContain("app-12 needs you: its builder asked a question");
    expect(read(join(lead("web"), "typed"))).toBe("");
  }, 60_000);

  test("a note for a repository whose lead never started waits until you open it", async () => {
    addApp();
    await startApp12(false);
    await hook("ask");
    await untilNeedsYou(true);
    await Bun.sleep(1000);
    expect(notes()).toBe(0);
    expect(await askForLead("simon/app")).toContain(leadPlaces("simon", "app").name);
    await until(() => notes() === 1);
    expect(read(join(lead(), "typed"))).toContain("app-12 needs you: its builder asked a question");
  }, 60_000);

  test("a note for a lead that isn't running is typed once the lead starts again", async () => {
    addApp();
    await startApp12();
    const name = leadPlaces("simon", "app").name;
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", `=${name}`]);
    rmSync(join(lead(), "typed"), { force: true });
    await hook("ask");
    await untilNeedsYou(true);
    await Bun.sleep(1000);
    expect(await askForLead()).toContain(name);
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
