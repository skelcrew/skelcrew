// What the tests of needs you share: a home with fake programs, a daemon, the stand-in for Claude
// Code that runs its hooks, and ways to read a thread's state and the lead's notes.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { leadPlaces } from "../src/paths.ts";
import {
  answer,
  fakePlugin,
  git,
  homeEnv,
  numberedBefore,
  read,
  runSkel,
  source,
  startDaemon,
  taskItem,
  until as wait,
  writeScript,
} from "./harness.ts";
export let home = "";
export let socket = "";
// The fake plugin's settings folder, where it keeps what it is asked and its answers.
export let plugin = "";
export const running: Subprocess[] = [];

export const data = () => join(home, ".local", "share", "skelcrew");
export const builder = () => join(data(), "claude", "app-12");
// The config folder of a repository's lead, where the fake keeps what is typed into it.
export const lead = (repo = "app") => join(data(), "claude", leadPlaces("simon", repo).name);

// Puts a program of the test's on its PATH.
export const script = (name: string, body: string) => writeScript(home, name, body);

// Stands in for Claude Code. As the lead, it waits at a ❯ prompt and keeps what is typed into
// it, looking busy while the file busy is in its config folder. As the builder, it runs the
// hook commands its settings give for an event when the test leaves a file named for it:
// ask for AskUserQuestion's PreToolUse, answer for its PostToolUse, talk for UserPromptSubmit,
// stop for Stop, which Claude Code runs when a turn ends, and fail for StopFailure, which it runs
// in Stop's place when a turn ends on an error such as a lapsed login. limit runs StopFailure too,
// for a usage limit. interrupt runs no hook at all, as Claude Code's hooks reference says of a
// turn you stop with Esc. A hook's input is what the test left in its file, or {}. Each hook gets
// a line in the file ran once it has finished. Text typed into the builder goes in its file
// typed, and runs UserPromptSubmit with what was pasted as its prompt, as Claude Code does. It looks busy while the file busy is in its
// config folder. While the file quoting is there, it is idle with a reply that quotes the busy
// mark, so each look at its screen takes a while.
export function fakeClaude(): void {
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
  input=$3; [ -n "$input" ] || input='{}'
  bun -e 'const [settings, event, tool] = process.argv.slice(1);
for (const group of JSON.parse(settings).hooks?.[event] ?? [])
  if (!group.matcher || group.matcher === tool)
    for (const hook of group.hooks) console.log(hook.command);' "$settings" "$1" "$2" |
  while IFS= read -r command; do printf '%s' "$input" | sh -c "$command" >> "$CLAUDE_CONFIG_DIR/hooks" 2>&1; done
  echo "$1" >> "$CLAUDE_CONFIG_DIR/ran"
}
printf '\\033[?2004h'
stty -echo
exec 3<&0
end=$(printf '\\033[201~')
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$CLAUDE_CONFIG_DIR/typed"
  printf '%s\\n' "$line" >> "$CLAUDE_CONFIG_DIR/pasting"
  case "$line" in *"$end"*)
    bun -e 'const text = require("fs").readFileSync(process.argv[1], "utf8");
console.log(JSON.stringify({ prompt: text.replace(/\\x1b\\[20[01]~/g, "") }));' "$CLAUDE_CONFIG_DIR/pasting" > "$CLAUDE_CONFIG_DIR/talk.part"
    rm "$CLAUDE_CONFIG_DIR/pasting"; mv "$CLAUDE_CONFIG_DIR/talk.part" "$CLAUDE_CONFIG_DIR/talk" ;;
  esac
done <&3 &
echo "❯"
for i in $(seq 3000); do
  test -e "$CLAUDE_CONFIG_DIR/ask" && { said=$(cat "$CLAUDE_CONFIG_DIR/ask"); rm "$CLAUDE_CONFIG_DIR/ask"; hook PreToolUse AskUserQuestion "$said"; }
  test -e "$CLAUDE_CONFIG_DIR/answer" && { rm "$CLAUDE_CONFIG_DIR/answer"; hook PostToolUse AskUserQuestion; }
  test -e "$CLAUDE_CONFIG_DIR/talk" && { said=$(cat "$CLAUDE_CONFIG_DIR/talk"); rm "$CLAUDE_CONFIG_DIR/talk"; hook UserPromptSubmit "" "$said"; }
  test -e "$CLAUDE_CONFIG_DIR/fail" && { rm "$CLAUDE_CONFIG_DIR/fail"; hook StopFailure authentication_failed; }
  test -e "$CLAUDE_CONFIG_DIR/interrupt" && { rm "$CLAUDE_CONFIG_DIR/interrupt"; echo Esc >> "$CLAUDE_CONFIG_DIR/ran"; }
  test -e "$CLAUDE_CONFIG_DIR/stop" && { said=$(cat "$CLAUDE_CONFIG_DIR/stop"); rm "$CLAUDE_CONFIG_DIR/stop"; hook Stop "" "$said"; }
  if [ -e "$CLAUDE_CONFIG_DIR/busy" ]; then
    [ "$look" = busy ] || { clear; echo "esc to interrupt"; look=busy; }
  elif [ -e "$CLAUDE_CONFIG_DIR/quoting" ]; then
    [ "$look" = quoting ] || { clear; echo '● It presses Esc while the screen shows "esc to interrupt".'; echo; echo "❯"; look=quoting; }
  elif [ -n "$look" ] && [ "$look" != idle ]; then clear; echo "❯"; look=idle; fi
  test -e "$CLAUDE_CONFIG_DIR/limit" && { given=$(cat "$CLAUDE_CONFIG_DIR/limit"); rm "$CLAUDE_CONFIG_DIR/limit"; hook StopFailure rate_limit "$given"; }
  sleep 0.1
done`,
  );
}

// Gives each test a home of its own, with the fake programs Skelcrew finds there, and a tmux
// socket of its own.
export function setUp(): void {
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
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${join(home, "github")}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Simon\n\temail = simon@example.com\n`,
  );
}
// Ends what the test started: its daemons and tmux server, and removes its home.
export async function tearDown(): Promise<void> {
  for (const serve of running.splice(0)) {
    serve.kill();
    await serve.exited;
  }
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
}

// What this test's processes run with.
export const env = () => homeEnv(home);

// Runs this test's daemon, which the test's clean-up stops.
export const serve = () => startDaemon(socket, env(), running);

// Runs sc as you would, or as a builder's hook would with its thread's socket.
export const skel = (args: string[], more: Record<string, string> = {}) =>
  runSkel(args, { ...env(), ...more });

// A daemon's work takes its time here, so a wait lasts 15 seconds unless a test says otherwise.
export const until = (done: () => boolean, timeout = 15_000) => wait(done, { timeout });

// Puts simon/app, or another of simon's repositories, on the fake GitHub and tells Skelcrew about
// it. Its lead had a conversation before, so it starts with no opening turn, which would be one
// more paste among those the tests count.
export function addApp(name = "app"): void {
  const work = join(home, "work", name);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), `${name}\n`);
  writeFileSync(
    join(work, "skelcrew.yaml"),
    "tracker: github\nsetup: []\ntest: []\nlimits: { threads: 9 }\n",
  );
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(home, "github", "simon", `${name}.git`));
  // Its task on issue #12 is APP-12.
  numberedBefore(join(home, "github", "simon", `${name}.git`), 11);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo, lead_session) VALUES (?, 'simon', ?, ?)", [${JSON.stringify(name)}, ${JSON.stringify(name)}, crypto.randomUUID()]);
openDb().run("UPDATE repositories SET forge = 'github', claimed = 1, remote = 'https://github.com/' || owner || '/' || repo || '.git'");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
}

// What sc ps --json shows you about app-12.
export async function needsYou(): Promise<boolean> {
  const ps = await skel(["ps", "--json"]);
  return JSON.parse(ps.out).find((t: { thread: string }) => t.thread === "APP-12")?.needsYou;
}

// What sc ps --json says app-12 needs you for, or null.
export async function needsYouFor(): Promise<string | null> {
  const ps = await skel(["ps", "--json"]);
  return JSON.parse(ps.out).find((t: { thread: string }) => t.thread === "APP-12")?.needsYouFor;
}

// Runs sc as app's lead does, from its sandbox.
export const asLead = (args: string[]) =>
  skel(args, { SKELCREW_SANDBOX: "1", SKELCREW_SOCKET: leadSocket() });

export async function untilNeedsYou(wanted: boolean) {
  const deadline = Date.now() + 15_000;
  while ((await needsYou()) !== wanted) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for needs you to be ${wanted}`);
    await Bun.sleep(100);
  }
}

// Has the fake builder run the hooks for an event, as Claude Code would, with `input` as what
// the hook reads, and waits for them.
export async function hook(
  step: "ask" | "answer" | "talk" | "fail" | "stop" | "interrupt" | "limit",
  input = "",
) {
  const before = read(join(builder(), "ran")).split("\n").length;
  writeFileSync(join(builder(), step), input);
  await until(() => read(join(builder(), "ran")).split("\n").length > before);
}

export const notes = (repo = "app") =>
  read(join(lead(repo), "typed")).split("\x1b[201~").length - 1;

// When app-12's builder's current stretch of work began, which the sidebar times.
export function workingSince(): number | null {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT working_since FROM threads WHERE folder = 'app-12'").get();
  db.close();
  return z.object({ working_since: z.number().nullable() }).parse(row).working_since;
}

// What app-12's builder shows on its screen now.
export const builderScreen = () =>
  Bun.spawnSync(["tmux", "-L", socket, "capture-pane", "-p", "-t", "=app-12:"], {
    stdout: "pipe",
    stderr: "pipe",
  }).stdout.toString();

// app-12's row in Skelcrew's database.
export function thread(): Record<string, unknown> {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT * FROM task_threads WHERE folder = 'app-12'").get();
  db.close();
  return row && typeof row === "object" ? { ...row } : {};
}

// What app-12's builder is doing, as Skelcrew keeps it.
export const builderState = () => thread().state;

// What app's lead is doing, as Skelcrew keeps it.
export function leadState(): unknown {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT lead_state FROM repositories WHERE repo = 'app'").get();
  db.close();
  return z.object({ lead_state: z.string().nullable() }).parse(row).lead_state;
}

// Returns how many notes and messages for the leads Skelcrew still keeps, as not yet sent.
export function notesWaiting(): number {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT COUNT(*) AS count FROM notes").get();
  db.close();
  return z.object({ count: z.number() }).parse(row).count;
}

// Sets one of app-12's flags, as a review, or with submitted as sc submit, would.
export function setColumn(column: "needs_you" | "submitted"): void {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`UPDATE threads SET ${column} = 1`);
  db.close();
}

// Runs SQL on Skelcrew's database while the daemon runs, such as to set a thread's round as a
// review would have.
export function sql(statements: string): void {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  db.run(statements);
  db.close();
}

// Stands in for a submit whose review is under way: Skelcrew's clone holds the commit app-12's
// clone has checked out as the one it last pushed, and the thread reviews it.
export function submittedAsReviewing(): void {
  const clone = join(data(), "repos", "simon", "app");
  const ref = "refs/skelcrew/threads/app-12";
  git(clone, "fetch", "-q", join(data(), "threads", "app-12"), `+HEAD:${ref}`);
  const sha = git(clone, "rev-parse", ref);
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  db.run("UPDATE tasks SET reviewing = ?", [sha]);
  db.close();
}

// The socket the daemon opens for app-12's builder, which tells it the builder calls. It is
// named by a short hash.
export function builderSocket(): string {
  const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "threads", short, "skelcrew.sock");
}

// The socket the daemon opens for app's lead, which tells it the lead calls. It is named by a
// short hash.
export function leadSocket(): string {
  const short = new Bun.CryptoHasher("sha256").update("simon/app").digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "leads", short, "skelcrew.sock");
}

// Asks the daemon for the lead, as plain sc does before attaching, without attaching.
export function askForLead(from?: string): Promise<string> {
  return new Promise((done) => {
    const connection = createConnection(join(home, "run", "skelcrew.sock"));
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

// Starts the daemon and app-12, opening app first, as plain sc in its checkout does, unless
// told not to.
export async function startApp12(open = true) {
  serve();
  await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
  if (open) expect(await askForLead("simon/app")).toContain(leadPlaces("simon", "app").name);
  expect((await skel(["start", "app-12"])).err).toBe("");
  await until(() => read(join(builder(), "args")) !== "", 30_000);
}
