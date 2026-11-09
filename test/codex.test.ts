// Codex as the lead and a builder, against a running daemon. A shell script stands in for
// Codex: it keeps what it was started with in its CODEX_HOME, saves a conversation as Codex
// does, waits at Codex's prompt, and runs the hook commands skel gives it on the command line.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { leadPlaces } from "../src/paths.ts";
import {
  git,
  homeEnv,
  read,
  runSkel,
  source,
  startDaemon,
  until as wait,
  writeScript,
} from "./harness.ts";

let home = "";
let socket = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skel");
// The CODEX_HOME of app-12's builder, and of app's lead.
const builder = () => join(data(), "codex-sessions", "app-12");
const lead = () => join(data(), "codex-sessions", leadPlaces("simon", "app").name);

// Puts a program of the test's on its PATH.
const script = (name: string, body: string) => writeScript(home, name, body);

// The conversation the fake saves, as Codex does in its CODEX_HOME, and one a sub-agent
// started from it saves later, which must never be taken for it.
const conversation = "01a1c003-09b8-7380-b6d9-c7ec08342361";
const subagent = "01a1c003-ffff-7380-b6d9-c7ec08342361";

// Stands in for Codex. codex debug models lists one model. Otherwise it keeps its arguments,
// environment and folder, and a new session saves its conversation. As the lead, it waits at
// Codex's prompt and keeps what is typed into it. As a builder, it runs the hook commands the
// command line gives for an event when the test leaves a file named for it: stop for Stop and
// talk for UserPromptSubmit, adding a line to the file ran once they have finished. renew
// renews the login as Codex does from 0.167: it follows the link to it, writes the renewal
// beside its target and renames it over it.
function fakeCodex(): void {
  script(
    "codex",
    `[ "$1" = debug ] && { echo '{"models":[{"slug":"gpt-6.1-sol"},{"slug":"gpt-6-luna"}]}'; exit 0; }
cd "$CODEX_HOME"
printf '%s\\n' "$@" > args; env > env; echo "$OLDPWD" > pwd
if [ "$1" != resume ]; then
  mkdir -p sessions/2026/11/09
  meta() { printf '{"type":"session_meta","payload":{"id":"%s","cwd":"%s","source":%s}}\\n' "$1" "$OLDPWD" "$2"; }
  meta ${conversation} '"cli"' > sessions/2026/11/09/rollout-2026-11-09T10-00-00-${conversation}.jsonl
  meta ${subagent} '{"subagent":"review"}' > sessions/2026/11/09/rollout-2026-11-09T11-00-00-${subagent}.jsonl
fi
case "$CODEX_HOME" in */lead-*)
  printf '\\033[?2004h'
  stty -echo
  # A shell gives a command run in the background /dev/null as its input, unless told.
  exec 3<&0
  while IFS= read -r line; do printf '%s\\n' "$line" >> typed; done <&3 &
  for i in $(seq 3000); do
    now=idle; test -e busy && now=busy
    if [ "$now" != "$shown" ]; then
      clear; if [ $now = busy ]; then echo "• Working (esc to interrupt)"; fi
      echo "› Ask Codex to do anything"; shown=$now
    fi
    sleep 0.1
  done ;;
esac
hook() {
  bun -e 'const name = \`hooks.\${process.argv[1]}=\`;
for (const arg of (await Bun.file("args").text()).split("\\n"))
  if (arg.startsWith(name))
    for (const group of Bun.TOML.parse(\`x=\${arg.slice(name.length)}\`).x)
      for (const hook of group.hooks) console.log(hook.command);' "$1" |
  while IFS= read -r command; do echo '{}' | sh -c "$command" >> hooks 2>&1; done
  echo "$1" >> ran
}
echo "› Ask Codex to do anything"
for i in $(seq 3000); do
  test -e stop && { rm stop; hook Stop; }
  test -e talk && { rm talk; hook UserPromptSubmit; }
  test -e renew && { rm renew; login=$(readlink -f auth.json); echo renewed > "$login.new" && mv "$login.new" "$login"; echo renewed >> ran; }
  sleep 0.1
done`,
  );
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-codex-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  fakeCodex();
  script("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  script(
    "gh",
    `case "$*" in
"api repos/simon/app/issues/12") echo '{"number":12,"title":"Add export","body":"-n as JSON"}' ;;
*) echo "the fake gh doesn't know $*" >&2; exit 1 ;;
esac`,
  );
  config("lead: { harness: codex }\nbuilder: { harness: codex, model: gpt-6.1-sol }\n");
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skel.service"), "");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${join(home, "github")}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Simon\n\temail = simon@example.com\n`,
  );
  addApp();
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

// Writes your config.yaml, with Claude Code as your harness and what `roles` adds.
function config(roles: string): void {
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "config.yaml"), `harness: claude\n${roles}`);
}

// What this test's processes run with.
const env = () => homeEnv(home);

// Runs skel as you would.
const skel = (args: string[]) => runSkel(args, env());

// A daemon's work takes its time here, so a wait lasts 15 seconds unless a test says otherwise.
const until = (done: () => boolean, timeout = 15_000) => wait(done, { timeout });

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
async function app12(): Promise<{ status: string; needsYou: boolean } | undefined> {
  const ps = await skel(["ps", "--json"]);
  return JSON.parse(ps.out).find((t: { thread: string }) => t.thread === "app-12");
}

// Waits until app-12 needs you, or no longer does.
async function untilNeedsYou(wanted: boolean) {
  const deadline = Date.now() + 15_000;
  while ((await app12())?.needsYou !== wanted) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for needs you to be ${wanted}`);
    await Bun.sleep(100);
  }
}

// Has the fake builder do something, as Codex would, and waits until it has.
async function act(step: "stop" | "talk" | "renew") {
  const before = read(join(builder(), "ran")).split("\n").length;
  writeFileSync(join(builder(), step), "");
  await until(() => read(join(builder(), "ran")).split("\n").length > before);
}

// The fake builder's arguments, one to a line.
const args = (folder = builder()) => read(join(folder, "args")).trimEnd().split("\n");

// Asks the daemon for app's lead, as plain skel does before attaching, without attaching.
function askForLead(): Promise<string> {
  return new Promise((done) => {
    const connection = createConnection(join(home, "run", "skel.sock"));
    let reply = "";
    connection.on("connect", () =>
      connection.write(`${JSON.stringify({ command: "lead", from: "simon/app" })}\n`),
    );
    connection.on("data", (more) => {
      reply += more.toString();
    });
    connection.on("close", () => done(reply));
  });
}

// Starts the daemon, opens app, and starts app-12, waiting until its builder is up.
async function startApp12() {
  startDaemon(socket, env(), running);
  await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
  expect(await askForLead()).toContain(leadPlaces("simon", "app").name);
  expect((await skel(["start", "app-12"])).err).toBe("");
  await until(() => read(join(builder(), "args")) !== "", 30_000);
}

// Changes app-12 in the database, as a round would.
function setThread(sql: string): void {
  const db = new Database(join(data(), "skel.db"));
  db.run("PRAGMA busy_timeout = 5000");
  db.run(sql);
  db.close();
}

// bubblewrap can't start inside skel's own sandbox, so only there agents can't start.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("codex", () => {
  test("a builder starts on Codex in a folder of its own, with the task after -- and skel's settings", async () => {
    await startApp12();
    const given = args();
    const clone = join(data(), "threads", "app-12");
    expect(read(join(builder(), "pwd")).trim()).toBe(clone);
    expect(read(join(builder(), "env"))).toContain(`CODEX_HOME=${builder()}\n`);
    expect(given.slice(0, 1)).toEqual(["--no-daemon"]);
    for (const flag of [
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      `projects.${JSON.stringify(clone)}.trust_level="trusted"`,
      "features.hooks=true",
    ])
      expect(given).toContain(flag);
    expect(given[given.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
    // The task's body starts with -, which mustn't be read as an option.
    expect(read(join(builder(), "args"))).toEndWith("\n--\nAdd export\n\n-n as JSON\n");
    // The lead runs on Codex too, with its own folder.
    await until(() => read(join(lead(), "args")) !== "");
    expect(args(lead()).filter((arg) => arg.startsWith("hooks."))).toEqual([]);
    expect(args().filter((arg) => arg.startsWith("hooks."))).toHaveLength(2);
  }, 60_000);

  test("a builder that stops without submitting needs you, and the Codex lead hears it", async () => {
    await startApp12();
    await act("stop");
    expect(read(join(builder(), "hooks"))).toBe("");
    await untilNeedsYou(true);
    await until(() => read(join(lead(), "typed")).includes("app-12 needs you"));
    expect(read(join(lead(), "typed"))).toContain(
      "app-12 needs you: its builder stopped without submitting",
    );
    // What you type to it next ends that.
    await act("talk");
    await untilNeedsYou(false);
    // A turn that ends once the builder has submitted waits on its review, not on you.
    setThread("UPDATE threads SET status = 'waiting'");
    await act("stop");
    await Bun.sleep(500);
    expect((await app12())?.needsYou).toBe(false);
  }, 60_000);

  test("a stopped builder comes back on Codex with its own conversation, not a sub-agent's", async () => {
    await startApp12();
    expect((await skel(["stop", "app-12"])).err).toBe("");
    // Your config moving builders to Claude Code doesn't move a thread that started on Codex.
    config("builder: { harness: claude }\n");
    rmSync(join(builder(), "args"));
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => read(join(builder(), "args")) !== "", 30_000);
    const given = args();
    expect(given[0]).toBe("resume");
    expect(given.at(-1)).toBe(conversation);
    // A model named for Claude Code isn't Codex's.
    expect(given).not.toContain("-m");
  }, 60_000);

  test("a model Codex doesn't offer fails the thread, saying which it does", async () => {
    config("builder: { harness: codex, model: gpt-5-codex }\n");
    startDaemon(socket, env(), running);
    await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
    expect((await skel(["start", "app-12"])).err).toBe("");
    const log = join(data(), "threads", "app-12.log");
    await until(() => read(log).includes('"status":"failed"'), 30_000);
    expect(read(log)).toContain(
      "Codex doesn't offer the model gpt-5-codex. It offers gpt-6.1-sol, gpt-6-luna",
    );
    expect(existsSync(join(builder(), "args"))).toBe(false);
  }, 60_000);

  test("a session renewing the login renews skel's own, which every session shares", async () => {
    mkdirSync(join(data(), "codex"), { recursive: true });
    writeFileSync(join(data(), "codex", "auth.json"), "mine\n");
    await startApp12();
    await act("renew");
    expect(read(join(data(), "codex", "auth.json"))).toBe("renewed\n");
    expect(read(join(lead(), "auth.json"))).toBe("renewed\n");
  }, 60_000);
});
