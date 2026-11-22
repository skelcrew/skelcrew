// Codex as the lead and a builder, against a running daemon. A shell script stands in for
// Codex: it keeps what it was started with in its CODEX_HOME, saves a conversation as Codex
// does, waits at Codex's prompt, and runs the hook commands Skelcrew gives it on the command line.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { leadPlaces } from "../src/paths.ts";
import {
  answer,
  asked,
  fakePlugin,
  git,
  homeEnv,
  insideSandbox,
  numberedBefore,
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

const data = () => join(home, ".local", "share", "skelcrew");
// The CODEX_HOME of app-12's builder, and of app's lead.
const builder = () => join(data(), "codex-sessions", "app-12");
const lead = () => join(data(), "codex-sessions", leadPlaces("simon", "app").name);

// Puts a program of the test's on its PATH.
const script = (name: string, body: string) => writeScript(home, name, body);

// The conversation the fake saves, as Codex does in its CODEX_HOME, and one a sub-agent
// started from it saves later, which must never be taken for it.
const conversation = "01a1c003-09b8-7380-b6d9-c7ec08342361";
const subagent = "01a1c003-ffff-7380-b6d9-c7ec08342361";

// Stands in for Codex. codex debug models lists two models, slowly while the home folder holds a
// file named slow, and leaves a file named listed once done. Otherwise it keeps its arguments,
// environment and folder, and a new session saves its conversation. As the lead, it waits at
// Codex's prompt and keeps what is typed into it. As a builder, it runs the hook commands the
// command line gives for an event when the test leaves a file named for it, then adds a line to
// the file ran: the hook's event, then the ID on the first line of the test's file. stop runs
// Stop, talk UserPromptSubmit, and interrupt Interrupt. Interrupt is what Codex runs when you
// press Esc: an interrupted turn returns before its Stop hooks, and its abort runs the Interrupt
// hooks instead. A hook's input is the rest of the test's file, or {}. Text typed into the
// builder goes in its file typed, and runs UserPromptSubmit, as talk does, with no ID. Both
// look busy while the file busy is in their CODEX_HOME, with a Working line that counts seconds,
// as Codex's does. error ends the builder's turn on an error as an unknown model does: Codex
// prints it and sits at its prompt, with no hook. renew renews the login as Codex does from
// 0.167: it follows the link to it, writes the renewal beside its target and renames it over it.
// Its arguments are written aside and moved into place, so a test that sees the file never reads
// them half written. The builder leaves a file named ready once it looks for the test's files.
function fakeCodex(): void {
  script(
    "codex",
    `if [ "$1" = debug ]; then
  : > "$HOME/listing"
  # Slow while the test leaves a file named slow, for 15 seconds at most.
  for i in $(seq 150); do [ -e "$HOME/slow" ] || break; sleep 0.1; done
  : > "$HOME/listed"
  echo '{"models":[{"slug":"gpt-6.1-sol"},{"slug":"gpt-6-luna"}]}'; exit 0
fi
cd "$CODEX_HOME"
# Its arguments last, as tests wait for them before reading the others. The profile -p names,
# which holds its developer instructions, goes in told, moved into place like its arguments.
: > told.part
for a; do [ "$prev" = -p ] && cat "$a.config.toml" > told.part; prev=$a; done
mv told.part told
env > env; echo "$OLDPWD" > pwd; printf '%s\\n' "$@" > args.part; mv args.part args
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
    now=idle; test -e busy && now="busy $i"
    if [ "$now" != "$shown" ]; then
      clear; if [ "$now" != idle ]; then echo "• Working (\${i}s • esc to interrupt)"; fi
      echo "› Ask Codex to do anything"; shown=$now
    fi
    sleep 0.1
  done ;;
esac
hook() {
  input=$2; [ -n "$input" ] || input='{}'
  bun -e 'const name = \`hooks.\${process.argv[1]}=\`;
for (const arg of (await Bun.file("args").text()).split("\\n"))
  if (arg.startsWith(name))
    for (const group of Bun.TOML.parse(\`x=\${arg.slice(name.length)}\`).x)
      for (const hook of group.hooks) console.log(hook.command);' "$1" |
  while IFS= read -r command; do printf '%s' "$input" | sh -c "$command" >> hooks 2>&1; done
  echo "$1\${3:+ $3}" >> ran
}
printf '\\033[?2004h'
stty -echo
exec 3<&0
end=$(printf '\\033[201~')
while IFS= read -r line; do
  printf '%s\\n' "$line" >> typed
  case "$line" in *"$end"*) : > typed-talk ;; esac
done <&3 &
echo "› Ask Codex to do anything"
: > ready
shown=idle
for i in $(seq 3000); do
  now=idle; test -e busy && now="busy $i"
  if [ "$now" != "$shown" ]; then
    clear; if [ "$now" != idle ]; then echo "• Working (\${i}s • esc to interrupt)"; fi
    echo "› Ask Codex to do anything"; shown=$now
  fi
  test -e error && { id=$(head -n 1 error); rm -f error busy; clear; echo "■ unexpected status 400 Bad Request"; echo "› Ask Codex to do anything"; shown=idle; echo "error $id" >> ran; }
  test -e stop && { id=$(head -n 1 stop); said=$(tail -n +2 stop); rm stop; hook Stop "$said" "$id"; }
  test -e interrupt && { id=$(head -n 1 interrupt); rm interrupt; hook Interrupt "" "$id"; }
  test -e talk && { id=$(head -n 1 talk); rm talk; hook UserPromptSubmit "" "$id"; }
  test -e typed-talk && { rm typed-talk; hook UserPromptSubmit; }
  test -e renew && { id=$(head -n 1 renew); rm renew; login=$(readlink -f auth.json); echo renewed > "$login.new" && mv "$login.new" "$login"; echo "renewed $id" >> ran; }
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
  // The tracker answers every poll with issue 12.
  plugin = fakePlugin(home);
  answer(plugin, "changed", {
    items: [taskItem("12", "Add export", { body: "-n as JSON" })],
    next: null,
  });
  config("lead: { harness: codex }\nbuilder: { harness: codex, model: gpt-6.1-sol }\n");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
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
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), `harness: claude\n${roles}`);
}

// What this test's processes run with.
const env = () => homeEnv(home);

// Runs sc as you would.
const skel = (args: string[]) => runSkel(args, env());

// A daemon's work takes its time here, and longer on a busy CI runner, so a wait lasts 30
// seconds unless a test says otherwise.
const until = (done: () => boolean, timeout = 30_000) => wait(done, { timeout });

// Puts simon/app on the fake GitHub and tells Skelcrew about it.
function addApp(): void {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  writeFileSync(join(work, "skelcrew.yaml"), "tracker: github\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(home, "github", "simon", "app.git"));
  // Its task on issue #12 is APP-12.
  numberedBefore(join(home, "github", "simon", "app.git"), 11);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app')");
openDb().run("UPDATE repositories SET forge = 'github', claimed = 1, remote = 'https://github.com/' || owner || '/' || repo || '.git'");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
}

// What sc ps --json shows you about app-12.
async function app12(): Promise<{ status: string; needsYou: boolean } | undefined> {
  const ps = await skel(["ps", "--json"]);
  return JSON.parse(ps.out).find((t: { thread: string }) => t.thread === "APP-12");
}

// The line the fake builder adds to its file ran once it has done each step.
const ranLine = {
  stop: "Stop",
  talk: "UserPromptSubmit",
  interrupt: "Interrupt",
  error: "error",
  renew: "renewed",
};

// Has the fake builder do something, as Codex would, with `input` as what its hooks read, and
// waits until it has. The step gets an ID of its own, and the wait is for its line in ran: text
// typed into the builder runs UserPromptSubmit too, whose line must not pass for this step's,
// even while one is under way as the step starts. The file is written aside and moved into
// place, so the builder never reads it half written.
async function act(step: keyof typeof ranLine, input = "") {
  const id = crypto.randomUUID();
  const file = join(builder(), step);
  writeFileSync(`${file}.part`, `${id}\n${input}`);
  renameSync(`${file}.part`, file);
  await until(() => read(join(builder(), "ran")).split("\n").includes(`${ranLine[step]} ${id}`));
}

// The fake builder's arguments, one to a line.
const args = (folder = builder()) => read(join(folder, "args")).trimEnd().split("\n");

// Asks the daemon for app's lead, as plain sc does before attaching, without attaching.
function askForLead(): Promise<string> {
  return new Promise((done) => {
    const connection = createConnection(join(home, "run", "skelcrew.sock"));
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
  // Its arguments come first, so only ready says it now takes the test's steps.
  await until(() => existsSync(join(builder(), "ready")), 30_000);
}

// How many notes about app-12 needing you the lead has been typed.
const notesAbout12 = () => read(join(lead(), "typed")).split("app-12 needs you").length - 1;

// How many times app-12's builder has told the lead its turn ended without a submit.
const turnsEndedTold = () =>
  read(join(lead(), "typed")).split("My turn ended without a submit").length - 1;

// The socket the daemon opens for app's lead, which tells it the lead calls. It is named by a
// short hash.
function leadSocket(): string {
  const short = new Bun.CryptoHasher("sha256").update("simon/app").digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "leads", short, "skelcrew.sock");
}

// The socket the daemon opens for app-12's builder, which tells it the builder calls.
function builderSocket(): string {
  const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "threads", short, "skelcrew.sock");
}

// What app-12's builder is doing, as Skelcrew keeps it.
function builderState(): unknown {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT state FROM threads WHERE folder = 'app-12'").get();
  db.close();
  return z.object({ state: z.string().nullable() }).parse(row).state;
}

// Changes app-12 in the database, as a round would.
// Returns whether app-12 shows turn ended: its builder stopped without submitting.
function turnEnded(): boolean {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT turn_ended FROM threads WHERE folder = 'app-12'").get();
  db.close();
  return z.object({ turn_ended: z.number() }).parse(row).turn_ended === 1;
}

// Returns how many notes and messages for the leads Skelcrew still keeps, as not yet sent.
function notesWaiting(): number {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT COUNT(*) AS count FROM notes").get();
  db.close();
  return z.object({ count: z.number() }).parse(row).count;
}

function setThread(sql: string): void {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  db.run(sql);
  db.close();
}

// bubblewrap can't start inside Skelcrew's own sandbox, so only there agents can't start.
describe.skipIf(insideSandbox)("codex", () => {
  // tmux refuses a start command past about 16 KB, so instructions that long once stopped
  // agents from starting.
  // Linux refuses a single argument past 128 KB, so these are longer than that.
  test("a lead and a builder on Codex start with 200 KB of instructions, and each reads them to their end", async () => {
    const long = `${"x".repeat(200 * 1024)} the end of the instructions`;
    config(
      `lead: { harness: codex }\nbuilder: { harness: codex, model: gpt-6.1-sol }\ntest: [${JSON.stringify(long)}]\n`,
    );
    await startApp12();
    expect(read(join(builder(), "told"))).toContain(`runs with \`${long}\`.`);
    await until(() => read(join(lead(), "args")) !== "");
    expect(read(join(lead(), "told"))).toContain(`the test command was \`${long}\`.`);
  });

  test("a builder starts on Codex in a folder of its own, with the task after -- and Skelcrew's settings", async () => {
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
    // The lead runs on Codex too, with its own folder, and the same hooks as the builder.
    await until(() => read(join(lead(), "args")) !== "");
    const hooks = (given: string[]) =>
      given.filter((arg) => arg.startsWith("hooks.")).map((arg) => arg.split("=")[0]);
    expect(hooks(args())).toEqual(["hooks.Stop", "hooks.UserPromptSubmit", "hooks.Interrupt"]);
    expect(hooks(args(lead()))).toEqual(hooks(args()));
  }, 60_000);

  // Codex has no tool for asking, so a builder asks by ending its turn. The lead reads its words
  // and brings the question to you.
  test("a builder that stops without submitting shows turn ended, and the Codex lead gets what it said", async () => {
    await startApp12();
    const said = "Should the export keep empty rows?\nI can do either.";
    await act("stop", JSON.stringify({ hook_event_name: "Stop", last_assistant_message: said }));
    expect(read(join(builder(), "hooks"))).toBe("");
    await until(turnEnded);
    // The message reaches the lead a piece at a time, so the test waits for all of it.
    await until(() => read(join(lead(), "typed")).includes("I can do either."));
    expect(read(join(lead(), "typed"))).toContain("My turn ended without a submit, saying:");
    expect((await app12())?.needsYou).toBe(false);
    expect(notesAbout12()).toBe(0);
    // What you type to it next ends that.
    await act("talk");
    await until(() => !turnEnded());
    // A turn that ends once the builder has submitted in it waits on its review, even when the
    // review already set the thread working again.
    setThread("UPDATE threads SET submitted = 1, status = 'working'");
    await act("stop");
    await Bun.sleep(500);
    expect(turnEnded()).toBe(false);
    // A review's changes typed in start a new turn, which shows turn ended if it ends without a
    // submit, though the thread waits on its review.
    await act("talk");
    setThread("UPDATE threads SET status = 'waiting'");
    await act("stop");
    await until(turnEnded);
  }, 60_000);

  test("a Codex builder that stopped without submitting can be told, which clears it", async () => {
    await startApp12();
    await act("stop");
    await until(turnEnded);
    const told = await runSkel(["tell", "app-12", "Keep them."], {
      ...env(),
      SKELCREW_SANDBOX: "1",
      SKELCREW_SOCKET: leadSocket(),
    });
    expect(told.err).toBe("");
    await until(() => read(join(builder(), "typed")).includes("Keep them."));
    await until(() => !turnEnded());
  }, 60_000);

  test("a Codex builder still shows turn ended after the daemon starts again, and the lead hears it once", async () => {
    await startApp12();
    await act("stop");
    await until(turnEnded);
    await until(() => turnsEndedTold() === 1);
    // The message shows at the lead's prompt before its Enter, and is kept until it is sent. A
    // daemon stopped in between types it again when it starts, so the test waits for the send.
    await until(() => notesWaiting() === 0);
    for (const daemon of running.splice(0)) {
      daemon.kill();
      await daemon.exited;
    }
    // The new daemon asks the tracker last as it starts. Before that, it has opened app-12's
    // socket and brought the builder back: one still running is only looked up in tmux, and the
    // round it resumes has nothing to do, so neither waits on anything.
    const polls = () => asked(plugin).filter((question) => question.ask === "changed").length;
    const before = polls();
    startDaemon(socket, env(), running);
    await until(() => polls() > before);
    // The lead's notes go in one after another, so the builder's message to the lead comes
    // after any the new daemon typed again as it started. Once the lead has it and no note is
    // left to send, a second message about the ended turn would be there already.
    const told = await runSkel(["tell", "lead", "Still waiting."], {
      ...env(),
      SKELCREW_SANDBOX: "1",
      SKELCREW_SOCKET: builderSocket(),
    });
    expect(told.err).toBe("");
    await until(() => read(join(lead(), "typed")).includes("Still waiting."));
    await until(() => notesWaiting() === 0);
    expect(turnEnded()).toBe(true);
    expect((await app12())?.needsYou).toBe(false);
    expect(turnsEndedTold()).toBe(1);
  }, 60_000);

  test("each of Codex's hooks puts the builder in its state", async () => {
    await startApp12();
    // The builder shows its busy mark throughout, so its screen never says it idles.
    writeFileSync(join(builder(), "busy"), "");
    await act("talk");
    expect(builderState()).toBe("working");
    await act("stop");
    expect(builderState()).toBe("idle");
    await act("talk");
    expect(builderState()).toBe("working");
    await act("interrupt");
    expect(builderState()).toBe("idle");
    expect(read(join(builder(), "hooks"))).toBe("");
  }, 60_000);

  // Esc runs Codex's Interrupt hooks, not Stop: you are looking at the builder when you press
  // Esc. So it shows idle, and doesn't need you.
  test("pressing Esc in a Codex builder's turn shows it idle, and doesn't mark it needing you", async () => {
    await startApp12();
    await act("interrupt");
    expect(builderState()).toBe("idle");
    await Bun.sleep(1000);
    expect((await app12())?.needsYou).toBe(false);
  }, 60_000);

  // An error runs no hook on Codex, so only the screen can tell.
  test("a Codex builder whose turn ends on an error shows idle once its busy mark is gone", async () => {
    await startApp12();
    writeFileSync(join(builder(), "busy"), "");
    await act("talk");
    // While its busy mark shows, it works, however long the turn takes.
    await Bun.sleep(5000);
    expect(builderState()).toBe("working");
    await act("error");
    await until(() => builderState() === "idle");
    expect((await app12())?.needsYou).toBe(false);
  }, 60_000);

  test("a lead keeps the harness it started on, for notes and when it comes back", async () => {
    await startApp12();
    // Your config moving leads to Claude Code doesn't move the lead already on Codex.
    config("lead: { harness: claude }\nbuilder: { harness: codex }\n");
    await act("stop");
    await until(() => turnsEndedTold() === 1);
    const name = leadPlaces("simon", "app").name;
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", `=${name}`]);
    rmSync(join(lead(), "args"));
    expect(await askForLead()).toContain(name);
    await until(() => read(join(lead(), "args")) !== "");
    expect(args(lead())[0]).toBe("resume");
    expect(args(lead()).at(-1)).toBe(conversation);
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
    // Coming back ends no turn, so it isn't taken for a builder waiting on you.
    await Bun.sleep(1000);
    expect((await app12())?.needsYou).toBe(false);
  }, 60_000);

  test("the daemon keeps answering while Codex lists its models", async () => {
    writeFileSync(join(home, "slow"), "");
    startDaemon(socket, env(), running);
    await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => existsSync(join(home, "listing")), 30_000);
    // The answer comes while the listing is still held. Timing the answer instead failed on a
    // busy machine, where sc itself can take seconds to start.
    expect((await app12())?.status).toBe("working");
    expect(existsSync(join(home, "listed"))).toBe(false);
    rmSync(join(home, "slow"));
    await until(() => read(join(builder(), "args")) !== "", 30_000);
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

  test("a session renewing the login renews Skelcrew's own, which every session shares", async () => {
    mkdirSync(join(data(), "codex"), { recursive: true });
    writeFileSync(join(data(), "codex", "auth.json"), "mine\n");
    await startApp12();
    await act("renew");
    expect(read(join(data(), "codex", "auth.json"))).toBe("renewed\n");
    expect(read(join(lead(), "auth.json"))).toBe("renewed\n");
  }, 60_000);
});
