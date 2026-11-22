// sc add --issue and sc start, run as you or the lead would run them, against a running daemon,
// a fake tracker and forge, a fake Claude Code and a folder of bare repositories standing in
// for GitHub.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { stillRunning } from "../src/agents/sessions.ts";
import {
  answer,
  asked,
  endFakeSessions,
  fakeHostCommand,
  fakePlugin,
  git,
  homeEnv,
  insideSandbox,
  numberedBefore,
  read,
  runSkel,
  runSkelInTerminal,
  source,
  startDaemon,
  taskItem,
  threadSql,
  until,
} from "./harness.ts";

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
  // The fake session host's sessions end with the test too.
  await endFakeSessions(join(home, ".config", "skelcrew", "plugins", "fake"));
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

// Opens app's lead socket, as plain sc does, and returns what sc runs with as that lead.
async function leadEnv(): Promise<Record<string, string>> {
  const short = new Bun.CryptoHasher("sha256").update("simon/app").digest("hex").slice(0, 16);
  const leadSocket = join(home, "run", "skelcrew", "leads", short, "skelcrew.sock");
  const connection = createConnection(join(home, "run", "skelcrew.sock"));
  connection.on("error", () => {});
  connection.write(`${JSON.stringify({ command: "lead", from: "simon/app" })}\n`);
  await until(() => existsSync(leadSocket));
  connection.destroy();
  return { ...env(), SKELCREW_SANDBOX: "1", SKELCREW_SOCKET: leadSocket };
}

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
  knowApp(repo);
  return work;
}

// addApp by another name, for the tests with a builder whose first task is numbered 1.
const addAppWithNoTasks = addApp;

// Adds simon/<repo> as addApp does, with eleven task numbers claimed on its remote before, so
// the task on issue #12 is APP-12, in the folder app-12, as the tests with a builder name it.
function addAppAfterEleven(files: Record<string, string> = {}, repo = "app"): string {
  const work = addApp(files, repo);
  numberedBefore(join(github(), "simon", `${repo}.git`), 11);
  return work;
}

// Tells Skelcrew about simon/<repo>, already on the fake GitHub.
function knowApp(repo = "app"): void {
  const script = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES (?, 'simon', ?)", [${JSON.stringify(repo)}, ${JSON.stringify(repo)}]);
openDb().run("UPDATE repositories SET forge = 'github', claimed = 1, remote = 'https://github.com/' || owner || '/' || repo || '.git'");`;
  const added = Bun.spawnSync([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
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
case "$*" in *"clone --quiet "*" https://github.com/"*)
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

// Installs the fake session host as a runtime plugin named fake, providing `provides`, and
// returns its settings folder, where it keeps its sessions and notes what it is asked.
function fakeHost(provides: string): string {
  const folder = join(home, "plugin-fake");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "skelcrew-plugin.yaml"),
    `name: fake
version: 0.1.0
skelcrew: 0.1.0
about: A session host for tests
kind: runtime
provides: [${provides}]
session: ${JSON.stringify(fakeHostCommand(join(home, ".config", "skelcrew", "plugins", "fake")))}
attach: ["true"]
`,
  );
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  db.run("INSERT INTO plugins (name, folder) VALUES ('fake', ?)", [folder]);
  db.close();
  const settings = join(home, ".config", "skelcrew", "plugins", "fake");
  mkdirSync(settings, { recursive: true });
  return settings;
}

// Has your config name `host` as the session host from now on.
const useHost = (host: string) =>
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    `harness: claude\nsession: ${host}\n`,
  );

test("sc add --issue creates a task in the repository's tracker and prints its name", async () => {
  addApp();
  serve();
  await untilAnswers();
  const made = await skel("add", "app", "Add import", "From CSV", "--issue");
  expect(made.err).toBe("");
  expect(made.out).toBe("Opened APP#13 as an issue in the tracker. sc start APP#13 starts it.\n");
  expect(asked(plugin).filter((q) => q.ask === "create task")).toEqual([
    { ask: "create task", repository: "simon/app", title: "Add import", body: "From CSV" },
  ]);
  // With the title and body on stdin, the options come first.
  const piped = await runSkel(["add", "app", "--issue"], env(), "# Add notes\n\nAs text\n");
  expect(piped.err).toBe("");
  expect(
    asked(plugin)
      .filter((q) => q.ask === "create task")
      .at(-1),
  ).toMatchObject({
    title: "Add notes",
    body: "As text\n",
  });
});

// A lead parks work in the backlog, and creates an issue only when the human explicitly asks,
// giving their words. The human's own sc add --issue needs none.
test("a lead's sc add --issue is refused without the human's words, and goes through with them", async () => {
  addApp();
  serve();
  await untilCloned();
  const lead = await leadEnv();
  const refused = await runSkel(["add", "app", "Add import", "From CSV", "--issue"], lead);
  expect(refused.err).toContain("a lead creates an issue only when the human explicitly asks");
  expect(refused.err).toContain("leave out --issue");
  const words = join(home, "asked.txt");
  writeFileSync(words, "");
  const empty = await runSkel(
    ["add", "app", "Add import", "From CSV", "--issue", "--asked-file", words],
    lead,
  );
  expect(empty.err).toContain("is empty");
  expect(asked(plugin).filter((q) => q.ask === "create task")).toEqual([]);
  writeFileSync(words, "File an issue for the CSV import.\n");
  const made = await runSkel(
    ["add", "app", "Add import", "From CSV", "--issue", "--asked-file", words],
    lead,
  );
  expect(made.err).toBe("");
  expect(made.out).toBe("Opened APP#13 as an issue in the tracker. sc start APP#13 starts it.\n");
  expect(asked(plugin).filter((q) => q.ask === "create task")).toHaveLength(1);
  // --asked-file goes only with --issue, as only an issue needs the human's words.
  const backlog = await runSkel(["add", "app", "t", "b", "--asked-file", words], lead);
  expect(backlog.err).toContain("sc add was given arguments it doesn't take");
}, 60_000);

// An issue that never started has only its issue, which sc rm closes, with the reason as its
// comment. Closing one goes out to other people, so a lead needs the human's words for it, and
// --keep-issue leaves it nothing to remove.
test("sc rm closes an issue that never started, and the lead needs the human's words for it", async () => {
  addApp();
  serve();
  await untilCloned();
  const lead = await leadEnv();
  // The copy has issue 12 once a poll has read it.
  const copied = () => {
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    try {
      return db.query("SELECT 1 FROM items WHERE kind = 'task' AND id = '12'").get() !== null;
    } finally {
      db.close();
    }
  };
  await until(copied);
  const closes = () => asked(plugin).filter((q) => q.ask === "close task");
  // At a terminal it says it closes the issue, and asks first.
  const question = "Remove APP#12? It never started, and this closes issue #12. [y/N]";
  const no = await runSkelInTerminal(socket, env(), ["rm", "app#12"], question, "n");
  expect(no).toContain("Skelcrew didn't remove APP#12.");
  expect(closes()).toEqual([]);
  const refused = await runSkel(["rm", "app#12"], lead);
  expect(refused.err).toContain("a lead closes an issue only when the human explicitly asks");
  expect(refused.err).toContain("sc rm APP#12 --keep-issue");
  const kept = await runSkel(["rm", "app#12", "--keep-issue"], lead);
  expect(kept.err).toBe(
    "Skelcrew: APP#12 never started, and --keep-issue keeps its issue open, so there is nothing to remove\n",
  );
  expect(closes()).toEqual([]);
  const words = join(home, "asked.txt");
  writeFileSync(words, "Drop the export, we don't need it.\n");
  const closed = await runSkel(["rm", "app#12", "not needed", "--asked-file", words], lead);
  expect(closed.err).toBe("");
  expect(closed.out).toBe("Removed APP#12 and closed issue #12.\n");
  expect(closes()).toEqual([
    {
      ask: "close task",
      repository: "simon/app",
      task: "12",
      comment: "Closed by Skelcrew: not needed",
    },
  ]);
  // You need no words of your own, and with no reason the issue gets no comment.
  const yours = await skel("rm", "app#12");
  expect(yours.err).toBe("");
  expect(closes().at(-1)).toEqual({
    ask: "close task",
    repository: "simon/app",
    task: "12",
    comment: null,
  });
  // A tracker that fails to close it says so, and how to try again.
  writeFileSync(join(plugin, "fail-close-task"), "GitHub is down");
  const failed = await skel("rm", "app#12");
  expect(failed.err).toContain("APP#12's issue didn't close: github failed: GitHub is down");
  expect(failed.err).toContain("Run sc rm APP#12 again to close it");
}, 60_000);

// The copy is only as fresh as the last poll, so an issue reopened since may be missing from it.
// Work still under way closes its issue all the same, rather than say it closed and leave it open.
test("sc rm on work closes its issue, though the copy doesn't have it open, and again after a failed try", async () => {
  addApp();
  serve();
  await untilCloned();
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  db.exec(threadSql({ task: "14", title: "Reopened", status: "stopped" }));
  db.close();
  // The tracker fails once the work is removed, and sc rm run again still closes the issue.
  writeFileSync(join(plugin, "fail-close-task"), "GitHub is down");
  const failed = await skel("rm", "app-14");
  expect(failed.err).toContain("APP-14's work is removed, but its issue didn't close");
  expect(thread()).toMatchObject({ status: "done" });
  rmSync(join(plugin, "fail-close-task"));
  const removed = await skel("rm", "app-14");
  expect(removed.err).toBe("");
  expect(removed.out).toBe("Removed APP-14 and closed issue #14.\n");
  expect(asked(plugin).filter((q) => q.ask === "close task")).toEqual([
    { ask: "close task", repository: "simon/app", task: "14", comment: null },
    { ask: "close task", repository: "simon/app", task: "14", comment: null },
  ]);
}, 60_000);

// A builder sees only the title and body. A heredoc that failed inside $(...) leaves the
// body empty while the command still runs, and an issue with no body can't be taken back.
test("sc add --issue and --start refuse an empty body, and ask the tracker nothing", async () => {
  addApp();
  serve();
  await untilAnswers();
  for (const body of ["", " \n\t"]) {
    const made = await skel("add", "app", "Add import", body, "--issue");
    expect(made.code).toBe(1);
    expect(made.err).toBe(
      "Skelcrew: sc add --issue needs a body, which is all a builder sees besides its title.\n",
    );
    const started = await skel("add", "app", "Add import", body, "--start");
    expect(started.code).toBe(1);
    expect(started.err).toBe(
      "Skelcrew: sc add --start needs a body, which is all a builder sees besides its title.\n",
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

test("sc add --start says what its stdin left out, and starts nothing", async () => {
  addApp();
  serve();
  await untilAnswers();
  const empty = await runSkel(["add", "app", "--start"], env(), "");
  expect(empty.code).toBe(1);
  expect(empty.err).toContain("no title");
  const titleOnly = await runSkel(["add", "app", "--start"], env(), "# Add export\n\n");
  expect(titleOnly.code).toBe(1);
  expect(titleOnly.err).toContain("no body");
  expect(thread()).toEqual({});
});

// --from picks the branch an issue's thread starts from. A task with no issue takes none, so
// sc add refuses it rather than read it as the title, with words or on stdin.
test("sc add --start refuses --from, with the task as words or on stdin, and starts nothing", async () => {
  addApp();
  serve();
  await untilAnswers();
  const refused =
    "Skelcrew: sc add takes no --from. Only sc start <issue> starts from another branch.\n";
  const words = await skel("add", "app", "--from", "feature", "--start");
  expect(words.code).toBe(1);
  expect(words.err).toBe(refused);
  const withShort = await skel(
    "add",
    "app",
    "T",
    "B",
    "--start",
    "--short",
    "x",
    "--from",
    "feature",
  );
  expect(withShort.code).toBe(1);
  expect(withShort.err).toBe(refused);
  const stdin = await runSkel(
    ["add", "app", "--start", "--from", "feature", "--short", "x"],
    env(),
    "# Add export\n\nAs JSON\n",
  );
  expect(stdin.code).toBe(1);
  expect(stdin.err).toBe(refused);
  expect(thread()).toEqual({});
  // A description that says "--from" is the task's own words, so that task starts.
  const described = await skel("add", "app", "Document the option", "--from", "--start");
  expect(described.err).toBe("");
  expect(described.out).toBe(`Started APP-1.\n`);
  expect(thread()).toMatchObject({ title: "Document the option", body: "--from" });
});

// A repository's name can end like a task's, as skelcrew-herdr-v2 does, even beside one named
// skelcrew-herdr. sc add --start takes it by any of its names, sc start points such a
// name to it, and sc start only splits the others into a repository and a task.
test("sc add --start takes a repository whose name ends like a task, by any of its names", async () => {
  addApp({}, "skelcrew-herdr");
  addApp({}, "skelcrew-herdr-v2");
  serve();
  await untilAnswers();
  const byName = await runSkel(
    ["add", "skelcrew-herdr-v2", "--start"],
    env(),
    "# Add export\n\nAs JSON\n",
  );
  expect(byName.err).toBe("");
  expect(byName.out).toBe(`Started SKELCREW-HERDR-V2-1.\n`);
  const byFullName = await skel(
    "add",
    "simon/skelcrew-herdr-v2",
    "Add import",
    "From CSV",
    "--start",
  );
  expect(byFullName.err).toBe("");
  expect(byFullName.out).toBe(`Started SKELCREW-HERDR-V2-2.\n`);
  const byUrl = await skel(
    "add",
    "https://github.com/simon/skelcrew-herdr-v2",
    "Add a",
    "B",
    "--start",
  );
  expect(byUrl.err).toBe("");
  expect(byUrl.out).toBe(`Started SKELCREW-HERDR-V2-3.\n`);
  // A name of that repository still splits at its last dash: its old name for issue #12 starts
  // the issue, which takes the next number.
  const task = await skel("start", "skelcrew-herdr-v2-12");
  expect(task.err).toBe("");
  expect(task.out).toBe("Started SKELCREW-HERDR-V2-4.\n");
  // And a name of the other repository is still its own.
  const other = await skel("start", "skelcrew-herdr#12");
  expect(other.err).toBe("");
  expect(other.out).toBe("Started SKELCREW-HERDR-1.\n");
  // The repository's own name, given to sc start, points to sc add --start.
  const named = await runSkel(["start", "skelcrew-herdr-v2"], env(), "# Add export\n\nAs JSON\n");
  expect(named.code).toBe(1);
  expect(named.err).toContain('run sc add skelcrew-herdr-v2 "<title>" "<body>" --start');
});

// Leads started before sc add --start still have sc start <repo> in their instructions,
// so it names the command that replaced it, and starts nothing.
test("sc start <repo>, with words or on stdin, names sc add --start, and starts nothing", async () => {
  addApp();
  serve();
  await untilAnswers();
  const pointer =
    'Skelcrew: sc start takes only a task now, such as sc start APP-12. To start new work in app, run sc add app "<title>" "<body>" --start, or sc add app --start with the title and body on stdin. It takes --short and --flow as sc start did.\n';
  const words = await skel("start", "app", "t", "b");
  expect(words.code).toBe(1);
  expect(words.err).toBe(pointer);
  const short = await skel("start", "app", "t", "b", "--short", "x");
  expect(short.err).toBe(pointer);
  const stdin = await runSkel(["start", "app"], env(), "# Add export\n\nAs JSON\n");
  expect(stdin.code).toBe(1);
  expect(stdin.err).toBe(pointer);
  expect(thread()).toEqual({});
});

// Only a start takes a start's options, and a task is either opened as an issue or started.
test("sc add refuses --short, --flow and --now that don't fit, and --issue with --start", async () => {
  addApp();
  serve();
  await untilAnswers();
  const used =
    "Skelcrew: sc add was given arguments it doesn't take. Run sc --help to see how to use it.\n";
  for (const args of [
    ["app", "t", "b", "--short", "x"],
    ["app", "t", "b", "--flow", "quick"],
    ["app", "t", "b", "--start", "--short"],
    ["app", "t", "b", "--start", "--start"],
  ]) {
    const run = await skel("add", ...args);
    expect(run.code).toBe(1);
    expect(run.err).toBe(used);
  }
  const now = await skel("add", "app", "t", "b", "--start", "--now");
  expect(now.err).toBe(
    "Skelcrew: Only sc start <task> takes --now, such as sc start APP-12 --now.\n",
  );
  const both = await skel("add", "app", "t", "b", "--issue", "--start");
  expect(both.code).toBe(1);
  expect(both.err).toBe(
    "Skelcrew: sc add takes --issue or --start, not both. Open the issue with --issue, then run sc start on the task it names.\n",
  );
  expect(asked(plugin).filter((q) => q.ask === "create task")).toEqual([]);
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

// GitHub's plugin from before it said how GitHub writes an issue gives its number alone. GitHub
// writes it #40, so that is how sc ls shows it.
test("an issue from GitHub's older plugin, which gives its number alone, shows as #40", async () => {
  addApp();
  known.push({ ...taskItem("40", "Add search", { body: "Find notes." }), ref: undefined });
  answer(plugin, "changed", { items: known, next: null });
  serve();
  await untilAnswers();
  await until(async () => (await skel("ls", "app", "--json")).out.includes("APP#40"));
  const listed = JSON.parse((await skel("ls", "app", "--json")).out);
  expect(listed).toContainEqual(expect.objectContaining({ task: "APP#40", issue: "#40" }));
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
  expect(missing.err).toContain("there is no task APP-99");
  expect(existsSync(join(data(), "threads", "app-99"))).toBe(false);
});

// Only you can install a plugin, at your terminal, so a task waits for you rather than start
// without one its repository names, such as its forge.
test("a repository whose plugins aren't all installed starts no task, and sc ps says to run sc install", async () => {
  addApp({ "skelcrew.yaml": "plugins: [simon/skelcrew-other]\n" });
  serve();
  await untilCloned();
  const start = await skel("add", "app", "Fix typo", "In the README", "--start");
  expect(start.err).toBe(
    "Skelcrew: app's plugins aren't all installed here, so its tasks can't start. Run sc install in your own terminal, then start it again.\n",
  );
  expect(flows()).toEqual([]);
  expect((await skel("ps")).out).toContain(
    "app needs you: its plugins aren't all installed here, so its tasks wait. Run sc install.\n",
  );
  expect((await skel("ps", "--json")).out).toBe("[]\n");
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
  const before = await skel(
    "add",
    "app",
    "Fix typo",
    "In the README",
    "--start",
    "--flow",
    "quick",
  );
  expect(before.err).toBe("Skelcrew: app has no flow quick. Its flows are default.\n");
  await untilApproved();
  const quick = await skel("add", "app", "Fix typo", "In the README", "--start", "--flow", "quick");
  expect(quick.err).toBe("");
  expect(quick.out).toBe(`Started APP-1.\n`);
  expect(flows()).toEqual([{ task: `t1`, flow: "quick" }]);
  const missing = await skel("start", "app-12", "--flow", "slow");
  expect(missing.err).toBe("Skelcrew: app has no flow slow. Its flows are default, quick.\n");
  // A flow's name can't reach outside .agents/flows/.
  expect((await skel("start", "app-12", "--flow", "../x")).code).not.toBe(0);
  expect((await skel("start", "app-12", "--flow")).code).not.toBe(0);
  // Without --flow, a task runs default.
  expect((await skel("add", "app", "Add notes", "As text", "--start")).out).toBe(
    `Started APP-2.\n`,
  );
  expect(flows()).toEqual([
    { task: `t1`, flow: "quick" },
    { task: `t2`, flow: "default" },
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
  const bad = await skel("add", "app", "Fix typo", "In the README", "--start", "--flow", "quick");
  expect(bad.err).toContain("app's flow quick (.agents/flows/quick.yaml) has no valid round limit");
  expect(bad.err).toContain(".agents/flows/quick.yaml in simon/app");
  const config = join(home, ".config", "skelcrew", "config.yaml");
  writeFileSync(config, "harness: claude\nmax_rounds: 0\n");
  // The flow names no rounds, so your config's bad max_rounds is its round limit.
  const builtIn = "app's flow default (Skelcrew's built-in default flow) has no valid round limit";
  const yours = await skel("add", "app", "Fix typo", "In the README", "--start");
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
    const listed = await skel("ls", name);
    expect(listed.code).not.toBe(0);
    expect(listed.err).toBe(`Skelcrew: there is no repository named ${name}\n`);
  }
  expect(asked(plugin).filter((q) => q.ask === "claims")).toEqual([]);
});

describe("a clone the daemon makes as it starts", () => {
  // Left running, it would write into the folder the next daemon clones into.
  // The plugins a repository needs are in Skelcrew's clone, so a start made before the clone is
  // there waits for it rather than read no plugins at all.
  test("sc start of a new task waits for the clone before checking the repository's plugins", async () => {
    addApp({ "skelcrew.yaml": "plugins: [simon/skelcrew-other]\n" }, "site");
    holdClones();
    serve();
    await untilAnswers();
    await until(() => existsSync(join(home, "held")));
    const started = skel("add", "site", "Fix typo", "In the README", "--start");
    await Bun.sleep(500);
    expect(existsSync(join(data(), "repos", "simon", "site"))).toBe(false);
    writeFileSync(join(home, "go"), "");
    expect((await started).err).toBe(
      "Skelcrew: site's plugins aren't all installed here, so its tasks can't start. Run sc install in your own terminal, then start it again.\n",
    );
  }, 60_000);

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
case "$*" in *"clone --quiet "*" https://github.com/"*)
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
case "$*" in *"clone --quiet "*" https://github.com/"*)
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

test("sc add --issue and sc start say when the daemon isn't running", async () => {
  const made = await skel("add", "app", "Add import", "From CSV", "--issue");
  expect(made.code).not.toBe(0);
  expect(made.err).toContain("run sc");
});

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("with a builder", () => {
  const addApp = addAppAfterEleven;
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
    expect(started.out).toBe("Started APP-12.\n");
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
    expect(row).toMatchObject({ owner: "simon", repo: "app", task: "t12", status: "working" });
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
    expect(JSON.parse(replies[0] ?? "")).toMatchObject({ running: true, thread: "APP-12" });
    expect(replies.slice(1).map((reply) => JSON.parse(reply))).toEqual([
      { error: "the daemon doesn't know that request" },
      { error: "the daemon doesn't know that request" },
    ]);
    expect(existsSync(join(home, "issues", "sent"))).toBe(false);
  }, 60_000);

  // The lead gives the human's words for an issue, in a file it writes in its own folder.
  test("the lead runs sc add --issue and sc start from its sandbox, but can't trust", async () => {
    addApp();
    const asker = `const c = require("node:net").createConnection(process.env.SKELCREW_SOCKET);
c.on("connect", () => c.write('{"command":"lead"}\\n'));
c.on("data", (d) => process.stdout.write(d));`;
    writeFileSync(join(home, "bin", "ask.js"), asker);
    fakeClaude(
      `{ printf 'File an issue for the CSV import.' > asked.txt; sc add app "Add import" "From CSV" --issue --asked-file asked.txt; sc start app-12; sc repo trust simon/other; bun ${join(home, "bin", "ask.js")}; } > out.new 2>&1; mv out.new out`,
      "",
    );
    // Opened before, so the daemon starts app's lead as it starts.
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    db.run("UPDATE repositories SET opened = 1");
    db.close();
    serve();
    const out = join(data(), "leads", "simon", "app", "out");
    await until(() => read(out) !== "");
    expect(read(out)).toBe(
      `Opened APP#13 as an issue in the tracker. sc start APP#13 starts it.\nStarted APP-12.\nSkelcrew: trusting a repository is only for your own terminal, not for agents\n{"error":"the daemon doesn't know that request"}\n`,
    );
    await until(() => read(join(config("app-12"), "args")) !== "");
  }, 60_000);

  test("a thread whose setup fails is marked failed, and starting it again starts over", async () => {
    const work = addApp({ "skelcrew.yaml": "setup: [echo fine, echo broken >&2 && exit 3]\n" });
    serve();
    await untilCloned();
    expect((await skel("start", "APP-12")).out).toBe("Started APP-12.\n");
    await until(() => thread().status === "failed");
    // The daemon saves a thread before it appends the thread to its log.
    await until(() => read(join(data(), "threads", "app-12.log")).includes("broken"));
    expect(hasSession("app-12")).toBe(false);
    writeFileSync(join(work, "skelcrew.yaml"), "setup: [echo fixed > fixed]\n");
    git(work, "commit", "-q", "-am", "fix setup");
    git(work, "push", "-q", "origin", "main");
    expect((await skel("start", "APP-12")).out).toBe("Started APP-12.\n");
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
    db.run("PRAGMA busy_timeout = 5000");
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
    expect(again.err).toBe("Skelcrew: APP-12 has a thread already\n");
  }, 60_000);

  test("sc stop ends the builder and keeps its clone, a restart leaves it stopped, and sc start brings it back with --resume", async () => {
    addApp();
    // Opened before, so the daemon starts app's lead, whose socket the stop comes from.
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
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
    expect(fromLead.stdout.toString()).toContain("Stopped APP-12.");
    expect(hasSession("app-12")).toBe(false);
    expect(existsSync(join(clone(), "README"))).toBe(true);
    expect(thread().status).toBe("stopped");
    expect((await skel("stop", "APP-12")).err).toContain("APP-12 is stopped already");

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
    expect(started.out).toContain("Started APP-12 again");
    expect(thread().short).toBe("Export");
    await until(() => read(join(config("app-12"), "calls")).includes("--resume"));
    expect(read(join(config("app-12"), "calls"))).toContain(`--resume ${session}`);
    // The fake harness writes where it runs after it logs its call, so the test waits for both.
    await until(() => read(join(config("app-12"), "pwd")) !== "");
    expect(read(join(config("app-12"), "pwd"))).toBe(`${clone()}\n`);
    expect(hasSession("app-12")).toBe(true);
    expect(thread().status).toBe("working");
  }, 60_000);

  // A restart picks up new skills, settings and environment, which a builder reads only as it
  // starts. Only you can ask for one, from the screen.
  test("restarting a builder ends its session and starts it again with --resume, its thread as it was", async () => {
    addApp();
    serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => read(join(config("app-12"), "args")) !== "");
    const session = String(thread().session);
    // Claude Code saves a conversation once it has a message, which a fake can't send.
    const project = clone().replace(/[^a-zA-Z0-9]/g, "-");
    mkdirSync(join(config("app-12"), "projects", project), { recursive: true });
    writeFileSync(join(config("app-12"), "projects", project, `${session}.jsonl`), "{}\n");
    const before = { ...thread() };
    rmSync(join(config("app-12"), "calls"));
    const restarted = await new Promise<string>((done) => {
      const connection = createConnection(join(home, "run", "skelcrew.sock"));
      let reply = "";
      connection.on("connect", () =>
        connection.write(
          `${JSON.stringify({ command: "restart", repo: "simon/app", task: "12" })}\n`,
        ),
      );
      connection.on("data", (data) => {
        reply += data.toString();
      });
      connection.on("close", () => done(reply));
    });
    expect(JSON.parse(restarted)).toEqual({ said: "Restarted APP-12's builder." });
    await until(() => read(join(config("app-12"), "calls")).includes("--resume"));
    expect(read(join(config("app-12"), "calls"))).toContain(`--resume ${session}`);
    expect(hasSession("app-12")).toBe(true);
    // The thread is as it was: its status, its conversation, its folder, its round and the time
    // its stretch of work began, which the sidebar shows.
    const after = thread();
    const timed = [
      "status",
      "session",
      "folder",
      "branch",
      "rounds",
      "pr",
      "started",
      "working_since",
    ];
    for (const key of timed) expect(after[key]).toEqual(before[key]);
  }, 60_000);

  test("a builder starts on the session host your config names, which hears its status", async () => {
    addApp();
    const host = fakeHost("sessions, transport, status");
    useHost("fake");
    serve();
    await untilCloned();
    expect((await skel("start", "app-12")).err).toBe("");
    // The host is saved as the builder starts, and its session's ID once the host gave it.
    await until(() => thread().host_id === "fake-app-12");
    expect(thread().host_id).toBe("fake-app-12");
    expect(hasSession("app-12")).toBe(false);
    expect(existsSync(join(host, "sessions", "fake-app-12"))).toBe(true);
    // The builder runs in its sandbox on the host, as on tmux.
    await until(() => read(join(config("app-12"), "pwd")) !== "");
    expect(read(join(config("app-12"), "pwd"))).toBe(`${clone()}\n`);
    expect((await skel("peek", "app-12")).code).toBe(0);
    await until(() => read(join(host, "statuses")) !== "");
    expect(JSON.parse(read(join(host, "statuses")).split("\n")[0] ?? "")).toEqual({
      id: "fake-app-12",
      status: "working",
      reason: "working",
    });
    // Stopping ends it on the host, and the thread no longer has one.
    expect((await skel("stop", "app-12")).err).toBe("");
    expect(existsSync(join(host, "sessions", "fake-app-12"))).toBe(false);
    expect(thread().host).toBe(null);
  }, 60_000);

  // A Mac's agents get no dropped files, as test/mac.test.ts checks.
  test.skipIf(process.platform === "darwin")(
    "a builder on a host that provides files reads the files you drop on it, and only those",
    async () => {
      addApp();
      const host = fakeHost("sessions, files");
      useHost("fake");
      // Where the host saves what you drop on the builder, and the path it types for it.
      const drops = join(host, "sessions", "fake-app-12", "files");
      const shot = join(drops, "shot.png");
      fakeClaude(
        "",
        `for i in $(seq 300); do [ -f ${shot} ] && break; sleep 0.1; done; { cat ${shot}; touch ${drops}/new 2>/dev/null || echo drops-read-only; test -e ${host}/asked || echo host-hidden; } > "$CLAUDE_CONFIG_DIR/seen.new" 2>&1; mv "$CLAUDE_CONFIG_DIR/seen.new" "$CLAUDE_CONFIG_DIR/seen"`,
      );
      serve();
      await untilCloned();
      expect((await skel("start", "app-12")).err).toBe("");
      await until(() => existsSync(drops));
      writeFileSync(shot, "a picture\n");
      await until(() => read(join(config("app-12"), "seen")) !== "");
      expect(read(join(config("app-12"), "seen"))).toBe(
        "a picture\ndrops-read-only\nhost-hidden\n",
      );
      // The host was handed the placeholder, which the command held only in its read-only mount.
      const start = read(join(host, "asked"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((question) => question.ask === "start");
      expect(start.files).toMatch(/^\/skelcrew-files-[0-9a-f]{32}$/);
      const at = start.command.indexOf(start.files);
      expect(start.command.slice(at - 1, at + 2)).toEqual(["--ro-bind", start.files, start.files]);
    },
    60_000,
  );

  test("a builder started on tmux stays there after the host changes, until it starts again", async () => {
    addApp();
    const first = serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => hasSession("app-12"));
    expect(thread().host).toBe("tmux");
    const host = fakeHost("sessions");
    useHost("fake");
    // A daemon that starts again finds the builder still running on tmux.
    await stop(first);
    serve();
    await untilAnswers();
    await Bun.sleep(2000);
    expect(hasSession("app-12")).toBe(true);
    expect(thread().host).toBe("tmux");
    expect(read(join(host, "asked"))).not.toContain('"start"');
    // Once stopped and started, it comes back on the host your config names now.
    await skel("stop", "app-12");
    await skel("start", "app-12");
    await until(() => thread().host === "fake");
    expect(hasSession("app-12")).toBe(false);
  }, 60_000);

  test("a builder whose host plugin is gone needs you once the daemon starts, rather than moving, until it is back", async () => {
    addApp();
    fakeHost("sessions");
    useHost("fake");
    const first = serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => thread().host_id === "fake-app-12");
    await stop(first);
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    db.run("DELETE FROM plugins WHERE name = 'fake'");
    db.close();
    const second = serve();
    // Only you can bring the plugin back, so its mark says what to do.
    await until(
      () => thread().needs_you_for === "run sc install: its session host fake is missing",
    );
    // The log says why it changed. The log is written just after the database, so it is waited
    // for.
    const log = () => read(join(data(), "threads", "app-12.log"));
    await until(() => log().includes("session host fake isn't installed any more"));
    expect(thread().host).toBe("fake");
    expect(hasSession("app-12")).toBe(false);
    // You install it again, and the daemon finds it as it starts, so the mark goes.
    await stop(second);
    fakeHost("sessions");
    serve();
    await until(() => thread().needs_you_for === null);
    await until(() => log().includes("its session host fake is back"));
  }, 60_000);

  // One broken plugin must never keep the daemon from starting: every other thread comes back.
  test("a plugin whose folder went leaves the daemon starting, its threads needing you, and tmux's builders running", async () => {
    addApp();
    issue(13, "Add export", "To CSV");
    const first = serve();
    await untilCloned();
    await skel("start", "app-12");
    await until(() => hasSession("app-12"));
    await stop(first);
    // app-13's builder ran on a plugin whose folder has gone since.
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    db.run("INSERT INTO plugins (name, folder) VALUES ('broken', ?)", [join(home, "gone")]);
    db.exec(threadSql({ task: "13", session: "s", host: "broken", host_id: "broken-app-13" }));
    db.close();
    serve();
    await untilAnswers();
    // Reads one thread's row by its folder.
    const row = (folder: string) => {
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      try {
        return z
          .object({
            status: z.string(),
            host: z.string().nullable(),
            needs_you_for: z.string().nullable(),
          })
          .parse(db.query("SELECT * FROM task_threads WHERE folder = ?").get(folder));
      } finally {
        db.close();
      }
    };
    await until(() => row("app-13").needs_you_for !== null);
    expect(row("app-12")).toEqual({ status: "working", host: "tmux", needs_you_for: null });
    expect(hasSession("app-12")).toBe(true);
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
    expect((await skel("start", "SIMON/APP-12")).err).toContain(
      "SIMON/APP-12 has a thread already",
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
    db.run("PRAGMA busy_timeout = 5000");
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
      "APP-12 is still setting up: stop it once its builder has started",
    );
    await until(() => thread().status === "failed");
    expect((await skel("stop", "app-12")).err).toContain(
      "APP-12 is failed, so it has no builder to stop",
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
      expect((await skel("start", "APP-12")).out).toContain("Started APP-12 again");
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
    expect((await skel("start", "APP-12")).out).toBe("Started APP-12.\n");
    await until(() => read(join(config("app-12"), "args")) !== "");
    expect(thread().status).toBe("working");
  }, 60_000);

  test("gives two threads whose names would make the same folder a folder each", async () => {
    addApp();
    onGitHub({}, "app", "bob");
    onGitHub({}, "simon-app", "bob");
    // Its task on issue #12 is BOB/SIMON-APP-12 too.
    numberedBefore(join(github(), "bob", "simon-app.git"), 11);
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
    expect((await skel("start", "APP-12")).out).toBe("Started APP-12.\n");
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
    expect((await started).out).toBe("Started SITE-12.\n");
    await until(() => read(join(config("site-12"), "args")) !== "");
    expect(thread()).toMatchObject({ owner: "simon", repo: "site", status: "working" });
  }, 60_000);

  // You can start work straight from the lead, with no issue filed first, even where the
  // repository plans in a tracker.
  test("sc start on what you said starts a thread of Skelcrew's own in a repository with a tracker", async () => {
    addAppWithNoTasks();
    serve();
    await untilAnswers();
    const run = await skel("add", "app", "Add export", "As JSON", "--start");
    expect(run.err).toBe("");
    expect(run.out).toBe(`Started APP-1.\n`);
    await until(() => read(join(config(`app-1`), "args")) !== "");
    expect(read(join(config(`app-1`), "args"))).toContain("Add export\n\nAs JSON");
    expect(thread()).toMatchObject({ task: `t1`, title: "Add export", body: "As JSON" });
    expect(asked(plugin).filter((q) => q.ask === "create task")).toEqual([]);
  }, 60_000);

  // A first message that starts like an option, such as a title of "--fast", must reach the
  // builder as its message. Claude Code would otherwise read it as an option and exit at once.
  test("a title that starts with dashes reaches the builder as its first message", async () => {
    addAppWithNoTasks();
    serve();
    await untilAnswers();
    const run = await skel("add", "app", "--fast", "Make the build quicker", "--start");
    expect(run.err).toBe("");
    await until(() => read(join(config(`app-1`), "args")) !== "");
    expect(read(join(config(`app-1`), "args"))).toEndWith(
      "\n--\n--fast\n\nMake the build quicker\n",
    );
  }, 60_000);

  // A long body needs no shell quoting when the lead gives the task on stdin, from a heredoc.
  test("sc add --start reads the task from stdin, its title on the first line", async () => {
    addAppWithNoTasks();
    serve();
    await untilAnswers();
    const task = '# Add export\n\n\nAs JSON, with "quotes" and $HOME.\nAnd dates.\n';
    const run = await runSkel(["add", "app", "--start"], env(), task);
    expect(run.err).toBe("");
    expect(run.out).toBe(`Started APP-1.\n`);
    expect(thread()).toMatchObject({
      task: `t1`,
      title: "Add export",
      body: 'As JSON, with "quotes" and $HOME.\nAnd dates.\n',
    });
  }, 60_000);

  // Names stay apart across machines: another machine already claimed the name of its first
  // thread on the remote, so this one takes the next number and claims it.
  test("sc start on what you said skips a name another machine claimed, and claims its own", async () => {
    const work = addAppWithNoTasks();
    git(work, "push", "-q", "origin", `main:refs/skelcrew/names/t1`);
    serve();
    await untilCloned();
    const run = await skel("add", "app", "Add export", "As JSON", "--start");
    expect(run.err).toBe("");
    expect(run.out).toBe(`Started APP-2.\n`);
    expect(thread()).toMatchObject({ task: `t2`, branch: `skelcrew/2-add-export` });
    const claims = git(work, "ls-remote", "origin", "refs/skelcrew/names/*");
    expect(claims).toContain(`refs/skelcrew/names/t2`);
  }, 60_000);

  // No task is named after its issue, so an issue with the shape of a task's own ID, such as t1,
  // is kept, and is started by its ID after a #. It takes a number as any task does.
  test("an issue with the shape of a task's own ID starts by its ID, and takes a number", async () => {
    addAppWithNoTasks();
    known.push(taskItem(`t1`, "Add import", { body: "From CSV" }));
    answer(plugin, "changed", { items: known, next: null });
    serve();
    await untilCloned();
    const issue = await skel("start", `app#t1`);
    expect(issue.err).toBe("");
    expect(issue.out).toBe(`Started APP-1.\n`);
    expect(thread()).toMatchObject({ task: `t1`, issue: "t1", title: "Add import" });
    const run = await skel("add", "app", "Add export", "As JSON", "--start");
    expect(run.out).toBe(`Started APP-2.\n`);
  }, 60_000);

  // The lead names each thread it starts in two or three words, for the sidebar's row.
  test("sc start --short gives a thread its short title, however the task is given", async () => {
    addAppWithNoTasks();
    serve();
    await untilCloned();
    const named = await skel(
      "add",
      "app",
      "Add export",
      "As JSON",
      "--start",
      "--short",
      "JSON export",
    );
    expect(named.err).toBe("");
    expect(named.out).toBe(`Started APP-1.\n`);
    expect(thread()).toMatchObject({ task: `t1`, title: "Add export", short: "JSON export" });
    const piped = await runSkel(
      ["add", "app", "--start", "--short", "Notes"],
      env(),
      "Add notes\n\nAs text",
    );
    expect(piped.err).toBe("");
    expect(piped.out).toBe(`Started APP-2.\n`);
    const issue = await skel("start", "app#12", "--short", "Export");
    expect(issue.err).toBe("");
    expect(issue.out).toBe("Started APP-3.\n");
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    const shorts = db.query("SELECT task, short FROM tasks ORDER BY task").all();
    db.close();
    expect(shorts).toEqual([
      { task: `t1`, short: "JSON export" },
      { task: `t2`, short: "Notes" },
      { task: `t3`, short: "Export" },
    ]);
    expect((await skel("start", "app-3", "--short", " ")).code).not.toBe(0);
    expect((await skel("start", "app-3", "--short")).code).not.toBe(0);
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
    expect(named.out).toBe('Gave APP-12 the short title "Export".\n');
    // The tracker would hear of a claim or assignment within moments of the answer.
    await Bun.sleep(1000);
    expect(tracker()).toHaveLength(asks);
    // Naming it goes in its log, which is a change the list of threads shows.
    expect(thread()).toEqual({ ...before, short: "Export", changed: expect.any(Number) });
    expect(read(join(config("app-12"), "calls"))).toBe(calls);
    expect(hasSession("app-12")).toBe(true);
    // Without --short, starting it again is still refused.
    expect((await skel("start", "APP-12")).err).toBe("Skelcrew: APP-12 has a thread already\n");
  }, 60_000);

  // A task started from a label runs the default flow, and the lead can switch it to another
  // until its builder first submits.
  test("sc start --flow switches a thread at work until its builder submits", async () => {
    // A third flow, careful, builds with a role of the repository's own.
    const work = addFlows();
    numberedBefore(join(github(), "simon", "app.git"), 11);
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
    expect((await skel("start", "APP-12")).out).toBe("Started APP-12.\n");
    expect(flows()).toEqual([{ task: "t12", flow: "default" }]);
    const switched = await skel("start", "app-12", "--flow", "quick");
    expect(switched.err).toBe("");
    expect(switched.out).toBe("APP-12 now runs the flow quick.\n");
    expect(flows()).toEqual([{ task: "t12", flow: "quick" }]);
    expect((await skel("start", "app-12", "--flow", "slow")).err).toBe(
      "Skelcrew: app has no flow slow. Its flows are default, careful, lax, quick.\n",
    );
    // Its builder already runs as builder, so a flow that builds as another role is refused, and
    // the builder keeps the instructions it started with.
    expect((await skel("start", "app-12", "--flow", "careful")).err).toBe(
      "Skelcrew: APP-12 keeps the flow quick: its builder already runs as builder, and careful builds as tester. To run careful, start it over: sc rm APP-12 --keep-issue, then sc start APP-12 --flow careful.\n",
    );
    expect(flows()).toEqual([{ task: "t12", flow: "quick" }]);
    expect(read(join(config("app-12"), "args"))).not.toContain("Write the test first.");
    // A switch to a flow whose round limit isn't valid is refused, naming where it is.
    const yours = join(home, ".config", "skelcrew", "config.yaml");
    writeFileSync(yours, "harness: claude\nmax_rounds: 0\n");
    const lax = (await skel("start", "app-12", "--flow", "lax")).err;
    expect(lax).toContain("app's flow lax (.agents/flows/lax.yaml) has no valid round limit");
    expect(lax).toContain(`${yours} isn't valid`);
    expect(flows()).toEqual([{ task: "t12", flow: "quick" }]);
    writeFileSync(yours, "harness: claude\n");
    // A stopped thread whose builder hasn't submitted switches too, and comes back on that flow.
    expect((await skel("stop", "app-12")).code).toBe(0);
    expect((await skel("start", "app-12", "--flow", "careful")).err).toBe(
      "Skelcrew: APP-12 keeps the flow quick: its builder already runs as builder, and careful builds as tester. To run careful, start it over: sc rm APP-12 --keep-issue, then sc start APP-12 --flow careful.\n",
    );
    expect(thread().status).toBe("stopped");
    const back = await skel("start", "app-12", "--flow", "default");
    expect(back.err).toBe("");
    expect(back.out).toBe(
      "Started APP-12 again on the flow default: its builder is back where it was.\n",
    );
    expect(flows()).toEqual([{ task: "t12", flow: "default" }]);
    await until(() => thread().status === "working" && hasSession("app-12"));
    expect((await skel("start", "app-12", "--flow", "quick")).out).toBe(
      "APP-12 now runs the flow quick.\n",
    );
    // Once its builder has submitted, the task keeps its flow to the end.
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    // A first review under way, before it is timed, as in a repository with no forge.
    db.run("UPDATE tasks SET reviewing = 'abc' WHERE task = 't12'");
    expect((await skel("start", "app-12", "--flow", "default")).err).toBe(
      "Skelcrew: APP-12 keeps the flow quick, as its builder has submitted already.\n",
    );
    db.run("UPDATE tasks SET reviewing = NULL, review_at = 1 WHERE task = 't12'");
    db.close();
    expect((await skel("start", "app-12", "--flow", "default")).err).toBe(
      "Skelcrew: APP-12 keeps the flow quick, as its builder has submitted already.\n",
    );
    // The flow it runs already is no switch, so sc start does what it would without --flow.
    const same = await skel("start", "app-12", "--flow", "quick", "--short", "Quick fix");
    expect(same.err).toBe("");
    expect(same.out).toBe('Gave APP-12 the short title "Quick fix".\n');
    // So does a stopped one, which stays stopped.
    expect((await skel("stop", "app-12")).code).toBe(0);
    expect((await skel("start", "app-12", "--flow", "default")).err).toBe(
      "Skelcrew: APP-12 keeps the flow quick, as its builder has submitted already.\n",
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
    expect((await skel("start", ".github-12")).out).toBe("Started .GITHUB-12.\n");
    expect((await skel("start", `${long}-12`)).err).toBe("");
    const folders = [`github-12`, `${long.slice(0, 60)}-12`];
    for (const folder of folders) await until(() => read(join(config(folder), "args")) !== "");
  }, 60_000);
});

// Tasks filed in Skelcrew alone, with no issue in a tracker, kept on the repository's remote so
// every machine shows the same backlog.
describe("the backlog", () => {
  // The task's JSON as sc ls --json gives it.
  const listed = async (name: string) => {
    const tasks = z.array(z.object({ task: z.string() }).passthrough());
    return tasks.parse(JSON.parse((await skel("ls", "--json")).out)).find((t) => t.task === name);
  };

  test("sc add files a task that sc ls and sc show show, and starts nothing", async () => {
    const work = addApp();
    serve();
    await untilCloned();
    const filed = await skel("add", "app", "Add export", "As JSON");
    expect(filed.err).toBe("");
    expect(filed.out).toBe("Filed APP-1 in the backlog. sc start APP-1 starts it.\n");
    // Its words and stdin, as sc add --start takes them.
    const piped = await runSkel(["add", "app"], env(), "# Add notes\n\nAs text\n");
    expect(piped.out).toBe("Filed APP-2 in the backlog. sc start APP-2 starts it.\n");
    // The same task filed again on purpose is a task of its own.
    const again = await skel("add", "app", "Add export", "As JSON");
    expect(again.out).toBe("Filed APP-3 in the backlog. sc start APP-3 starts it.\n");
    // The title and body are the first two words, so a body that reads like an option stays
    // the body.
    const flagLike = await skel("add", "app", "Add flags", "--issue");
    expect(flagLike.out).toBe("Filed APP-4 in the backlog. sc start APP-4 starts it.\n");
    // On the remote, under hidden refs, never as a branch, and never in the tracker.
    const refs = git(work, "ls-remote", "origin");
    expect(refs).toContain("refs/skelcrew/tasks/t1");
    expect(refs).toContain("refs/skelcrew/names/t1");
    expect(git(work, "ls-remote", "--heads", "origin")).not.toContain("t1");
    expect(asked(plugin).filter((q) => q.ask === "create task")).toEqual([]);
    expect(await listed("APP-1")).toEqual({
      task: "APP-1",
      stage: "issue",
      title: "Add export",
      short: null,
      issue: null,
      thread: null,
      pr: null,
      checks: null,
      review: null,
      asks: false,
    });
    const shown = await skel("show", "APP-2");
    expect(shown.err).toBe("");
    expect(shown.out).toStartWith("APP-2  Add notes\nStage   issue\nIssue   none\nFiled   by ");
    expect(shown.out).toContain("\nDescription\nAs text\n");
    expect(thread()).toEqual({});
    // A description is all a builder sees besides its title.
    expect((await skel("add", "app", "Add import", " ")).code).not.toBe(0);
  }, 60_000);

  // A second machine is this one with nothing of its own left: a new database and clone. All it
  // shares with the first is the remote.
  test("a task filed on one machine shows on another, through the remote, and starts there", async () => {
    addApp();
    const first = serve();
    await untilCloned();
    expect((await skel("add", "app", "Add export", "As JSON")).err).toBe("");
    await stop(first);
    rmSync(data(), { recursive: true, force: true });
    knowApp();
    serve();
    await untilCloned();
    await until(async () => (await listed("APP-1")) !== undefined);
    expect(await listed("APP-1")).toMatchObject({ title: "Add export", stage: "issue" });
    const started = await skel("start", "APP-1");
    expect(started.err).toBe("");
    expect(started.out).toBe("Started APP-1.\n");
    expect(thread()).toMatchObject({ task: "t1", title: "Add export", body: "As JSON" });
    // Started, it leaves the backlog on the remote, so no other machine starts it too.
    expect(git(join(home, "work", "simon", "app"), "ls-remote", "origin")).not.toContain(
      "refs/skelcrew/tasks/t1",
    );
    expect(await listed("APP-1")).toMatchObject({ thread: expect.anything() });
  }, 60_000);

  // The remote refuses to let the task go, as when another machine started it a moment before.
  // The start is refused, and the task stays in the backlog, with no thread left behind.
  test("a start the remote refuses keeps the task in the backlog and records no thread", async () => {
    const work = addApp();
    serve();
    await untilCloned();
    await skel("add", "app", "Add export", "As JSON");
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\ncase "$*" in *push*":refs/skelcrew/tasks/"*) echo refused >&2; exit 1 ;; esac\nexec ${Bun.which("git") ?? "git"} "$@"\n`,
      { mode: 0o755 },
    );
    const refused = await skel("start", "APP-1");
    expect(refused.err).toContain("APP-1 was started or removed on another machine");
    expect(thread()).toEqual({});
    expect(git(work, "ls-remote", "origin")).toContain("refs/skelcrew/tasks/t1");
    expect(await listed("APP-1")).toMatchObject({ title: "Add export", thread: null });
  }, 60_000);

  // Leaves the remote as a start on some machine leaves it when a stop cuts it short: the task
  // moved off the backlog onto a claim of its start. Returns the claim's commit.
  const cutStart = (work: string, name: string) => {
    git(work, "fetch", "-q", "origin", `refs/skelcrew/tasks/${name}`);
    const commit = git(work, "rev-parse", "FETCH_HEAD").trim();
    git(
      work,
      "push",
      "-q",
      "--atomic",
      "origin",
      `${commit}:refs/skelcrew/started/${name}`,
      `:refs/skelcrew/tasks/${name}`,
    );
    return commit;
  };

  // Writes to this machine's database while its daemon is stopped.
  const write = (sql: string) => {
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    db.run(sql);
    db.close();
  };

  // A stop after this machine claimed the start, but before its thread was recorded, puts the
  // task back in the backlog, so it is never lost.
  test("a start of this machine's cut short before its thread puts the task back", async () => {
    const work = addApp();
    const first = serve();
    await untilCloned();
    await skel("add", "app", "Add export", "As JSON");
    await stop(first);
    const commit = cutStart(work, "t1");
    write(`INSERT INTO backlog_starts (owner, repo, task, started_commit)
      VALUES ('simon', 'app', 't1', '${commit}')`);
    serve();
    await until(() => !git(work, "ls-remote", "origin").includes("refs/skelcrew/started/t1"));
    expect(git(work, "ls-remote", "origin")).toContain("refs/skelcrew/tasks/t1");
    await until(async () => (await listed("APP-1")) !== undefined);
    expect(await listed("APP-1")).toMatchObject({ title: "Add export", thread: null });
  }, 60_000);

  // A stop after the thread was recorded leaves only the claim to remove. Another machine's claim,
  // which this machine never noted, is that machine's to finish, so it stays, and neither task
  // shows in this machine's backlog.
  test("a claim whose thread is recorded here goes, and another machine's claim stays", async () => {
    const work = addApp();
    const first = serve();
    await untilCloned();
    await skel("add", "app", "Add export", "As JSON");
    await skel("add", "app", "Add import", "From CSV");
    await stop(first);
    cutStart(work, "t1");
    cutStart(work, "t2");
    write(threadSql({ task: "t1", title: "Add export", body: "As JSON", status: "stopped" }));
    serve();
    await until(() => !git(work, "ls-remote", "origin").includes("refs/skelcrew/started/t1"));
    expect(git(work, "ls-remote", "origin")).toContain("refs/skelcrew/started/t2");
    expect(await listed("APP-1")).toMatchObject({ thread: { status: "stopped" } });
    expect(await listed("APP-2")).toBeUndefined();
  }, 60_000);

  // The remote takes the push that claims the start, and the connection drops before git hears
  // so. The claim is this machine's, so the start goes on.
  test("a start whose claim reached the remote though git said it failed goes on", async () => {
    const work = addApp();
    serve();
    await untilCloned();
    await skel("add", "app", "Add export", "As JSON");
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\ncase "$*" in *":refs/skelcrew/started/"*) ${Bun.which("git") ?? "git"} "$@"; echo "connection lost" >&2; exit 1 ;; esac\nexec ${Bun.which("git") ?? "git"} "$@"\n`,
      { mode: 0o755 },
    );
    const started = await skel("start", "APP-1");
    expect(started.err).toBe("");
    expect(started.out).toBe("Started APP-1.\n");
    expect(thread()).toMatchObject({ task: "t1", title: "Add export" });
    const refs = git(work, "ls-remote", "origin");
    expect(refs).not.toContain("refs/skelcrew/tasks/t1");
    expect(refs).not.toContain("refs/skelcrew/started/t1");
  }, 60_000);

  // A refresh reads the backlog, and sc rm removes a task before the refresh writes what it read.
  // The refresh must not bring the task back. The refresh is the one filing another task runs,
  // so no poll mends the copy before the test looks.
  test("a refresh that overlaps sc rm doesn't bring the task back", async () => {
    addApp();
    serve();
    await untilCloned();
    await skel("add", "app", "Add export", "As JSON");
    // Each fetch of the backlog waits, once it has read the remote, while the file hold is there.
    const real = Bun.which("git") ?? "git";
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\ncase "$*" in *"refs/skelcrew/tasks/*"*) ${real} "$@"; code=$?
  if [ -e "$HOME/hold" ]; then touch "$HOME/held"; while [ -e "$HOME/hold" ] && [ -d "$HOME" ]; do sleep 0.05; done; fi
  exit $code ;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(home, "hold"), "");
    const added = skel("add", "app", "Add import", "From CSV");
    await until(() => existsSync(join(home, "held")));
    const removed = skel("rm", "APP-1");
    await Bun.sleep(500);
    rmSync(join(home, "hold"));
    expect((await added).err).toBe("");
    expect((await removed).out).toBe("Removed APP-1 from the backlog.\n");
    expect(await listed("APP-1")).toBeUndefined();
    expect(await listed("APP-2")).toMatchObject({ title: "Add import" });
  }, 60_000);

  // The remote takes the push that files the task, and the connection drops before git hears
  // so. The claim is this machine's, so the task is filed once, under that name.
  test("a filing whose push reached the remote though git said it failed files the task once", async () => {
    const work = addApp();
    serve();
    await untilCloned();
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\ncase "$*" in *push*":refs/skelcrew/tasks/"*) ${Bun.which("git") ?? "git"} "$@"; echo "connection lost" >&2; exit 1 ;; esac\nexec ${Bun.which("git") ?? "git"} "$@"\n`,
      { mode: 0o755 },
    );
    const filed = await skel("add", "app", "Add export", "As JSON");
    expect(filed.err).toBe("");
    expect(filed.out).toBe("Filed APP-1 in the backlog. sc start APP-1 starts it.\n");
    const refs = git(work, "ls-remote", "origin", "refs/skelcrew/tasks/*");
    expect(refs).toContain("refs/skelcrew/tasks/t1");
    expect(refs).not.toContain("refs/skelcrew/tasks/t2");
  }, 60_000);

  // A description given on stdin can be longer than the system lets one argument be, as
  // sc add takes it, so filing and starting never pass it as one.
  test("a task with a description too long for one argument is filed and starts", async () => {
    addApp();
    serve();
    await untilCloned();
    const body = `${"Export every row as JSON. ".repeat(8000)}\n`;
    const filed = await runSkel(["add", "app"], env(), `Add export\n\n${body}`);
    expect(filed.err).toBe("");
    expect(filed.out).toBe("Filed APP-1 in the backlog. sc start APP-1 starts it.\n");
    expect((await skel("start", "APP-1")).out).toBe("Started APP-1.\n");
    expect(thread()).toMatchObject({ task: "t1", title: "Add export", body });
  }, 60_000);

  // The remote takes the push that files the task, then can't be reached at all, so Skelcrew
  // can't tell it took it. Running sc add again once the remote is back files nothing twice.
  test("sc add again after a filing nobody could confirm files the task once", async () => {
    const work = addApp();
    serve();
    await untilCloned();
    const real = Bun.which("git") ?? "git";
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh
case "$*" in *push*":refs/skelcrew/tasks/"*) ${real} "$@"; touch "$HOME/down"; exit 1 ;; esac
if [ -e "$HOME/down" ]; then case "$*" in *ls-remote*|*" fetch "*) echo "unreachable" >&2; exit 1 ;; esac; fi
exec ${real} "$@"
`,
      { mode: 0o755 },
    );
    const failed = await skel("add", "app", "Add export", "As JSON");
    expect(failed.err).toContain("run the same sc add again once it can be reached");
    // While the remote is out of reach, nothing is filed.
    const meanwhile = await skel("add", "app", "Add export", "As JSON");
    expect(meanwhile.err).toContain("run the same sc add again once it can be reached");
    rmSync(join(home, "down"));
    const again = await skel("add", "app", "Add export", "As JSON");
    expect(again.err).toBe("");
    expect(again.out).toBe(
      "APP-1 already holds this task in the backlog, so nothing more was filed. sc start APP-1 starts it.\n",
    );
    const refs = git(work, "ls-remote", "origin", "refs/skelcrew/tasks/*");
    expect(refs).toContain("refs/skelcrew/tasks/t1");
    expect(refs).not.toContain("refs/skelcrew/tasks/t2");
    // That try is settled, so the same task filed again on purpose is a task of its own.
    rmSync(join(home, "bin", "git"));
    const twice = await skel("add", "app", "Add export", "As JSON");
    expect(twice.out).toBe("Filed APP-2 in the backlog. sc start APP-2 starts it.\n");
  }, 60_000);

  // The remote takes the push that files the task and the answer is lost. Then the first look at
  // the name's claim fails, while the remote answers again after. The claim must not be taken for
  // another machine's, which would file the task again under the next name.
  test("a filing whose claim can't be looked up once is never filed again under another name", async () => {
    const work = addApp();
    serve();
    await untilCloned();
    const real = Bun.which("git") ?? "git";
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh
case "$*" in *push*":refs/skelcrew/tasks/"*) ${real} "$@"; touch "$HOME/flaky"; exit 1 ;; esac
case "$*" in *"ls-remote "*" refs/skelcrew/names/t"[0-9]*) if [ -e "$HOME/flaky" ]; then rm "$HOME/flaky"; exit 1; fi ;; esac
exec ${real} "$@"
`,
      { mode: 0o755 },
    );
    const failed = await skel("add", "app", "Add export", "As JSON");
    expect(failed.err).toContain("run the same sc add again once it can be reached");
    rmSync(join(home, "bin", "git"));
    const again = await skel("add", "app", "Add export", "As JSON");
    expect(again.out).toStartWith("APP-1 already holds this task");
    expect(git(work, "ls-remote", "origin", "refs/skelcrew/tasks/*")).not.toContain("t2");
  }, 60_000);

  // Two filings at once whose answers are both lost each keep a note of their own, so each is
  // settled by its own retry, and neither is filed twice.
  test("two filings at once whose answers are lost are each filed once", async () => {
    const work = addApp();
    serve();
    await untilCloned();
    const real = Bun.which("git") ?? "git";
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh
case "$*" in *push*":refs/skelcrew/tasks/"*) ${real} "$@"; exit 1 ;; esac
case "$*" in *"ls-remote "*" refs/skelcrew/names/t"[0-9]*) exit 1 ;; esac
exec ${real} "$@"
`,
      { mode: 0o755 },
    );
    const both = await Promise.all([
      skel("add", "app", "Add export", "As JSON"),
      skel("add", "app", "Add import", "From CSV"),
    ]);
    for (const run of both) expect(run.err).toContain("run the same sc add again");
    rmSync(join(home, "bin", "git"));
    const exported = await skel("add", "app", "Add export", "As JSON");
    const imported = await skel("add", "app", "Add import", "From CSV");
    expect([exported.out, imported.out].every((out) => out.includes("already holds"))).toBe(true);
    const refs = git(work, "ls-remote", "origin", "refs/skelcrew/tasks/*").trim().split("\n");
    expect(refs).toHaveLength(2);
  }, 60_000);

  // A start's claim reaches the remote, then neither its answer nor a look at the remote comes
  // back. Started again before any refresh settles it, the earlier claim is found and goes on, so
  // the task is neither lost nor hidden behind a claim nobody owns.
  test("a start retried after its claim's outcome was lost goes on from that claim", async () => {
    const work = addApp();
    serve();
    await untilCloned();
    await skel("add", "app", "Add export", "As JSON");
    const real = Bun.which("git") ?? "git";
    // down: the remote can't be read at all. nofetch: only the backlog's fetch fails, so no
    // refresh settles the start before the retry does.
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh
case "$*" in *push*":refs/skelcrew/started/"*) ${real} "$@"; touch "$HOME/down" "$HOME/nofetch"; exit 1 ;; esac
if [ -e "$HOME/down" ]; then case "$*" in *ls-remote*|*" fetch "*) exit 1 ;; esac; fi
if [ -e "$HOME/nofetch" ]; then case "$*" in *" fetch "*refs/skelcrew/*) exit 1 ;; esac; fi
exec ${real} "$@"
`,
      { mode: 0o755 },
    );
    const failed = await skel("start", "APP-1");
    expect(failed.err).toContain("APP-1");
    expect(thread()).toEqual({});
    rmSync(join(home, "down"));
    const again = await skel("start", "APP-1");
    expect(again.err).toBe("");
    expect(again.out).toBe("Started APP-1.\n");
    expect(thread()).toMatchObject({ task: "t1", title: "Add export", body: "As JSON" });
    const refs = git(work, "ls-remote", "origin");
    expect(refs).not.toContain("refs/skelcrew/started/t1");
    expect(refs).not.toContain("refs/skelcrew/tasks/t1");
  }, 60_000);

  test("sc rm deletes a task that never started, here and on the remote, and keeps its name", async () => {
    const work = addApp();
    serve();
    await untilCloned();
    await skel("add", "app", "Add export", "As JSON");
    const removed = await skel("rm", "APP-1");
    expect(removed.err).toBe("");
    expect(removed.out).toBe("Removed APP-1 from the backlog.\n");
    expect(git(work, "ls-remote", "origin")).not.toContain("refs/skelcrew/tasks/t1");
    // Its words are on no ref left: the name's claim holds none of them.
    git(work, "fetch", "-q", "origin", "+refs/skelcrew/*:refs/skelcrew/*");
    expect(git(work, "log", "--format=%B", "--glob=refs/skelcrew/*")).not.toContain("As JSON");
    expect(await listed("APP-1")).toBeUndefined();
    expect((await skel("show", "APP-1")).err).toBe("Skelcrew: there is no task APP-1\n");
    // The name stays claimed, so it never names other work.
    const next = await skel("add", "app", "Add import", "From CSV");
    expect(next.out).toBe("Filed APP-2 in the backlog. sc start APP-2 starts it.\n");
  }, 60_000);
});
