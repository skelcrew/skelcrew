// The queue of tasks under limits.threads, against a running daemon: a start over the limit
// waits as queued, and starts in order once a builder ends. A builder already at work is a tmux
// session of the test's own, and every builder the queue starts stands in for Claude Code
// failing to start, so each start ends, and frees its place, at once. Which task leaves the
// queue, and when, is tested on the database alone in task-queue.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { leadPlaces } from "../src/paths.ts";
import {
  answer,
  asked,
  fakePlugin,
  git,
  homeEnv,
  read,
  runSkel,
  source,
  taskItem,
  threadSql,
  until as wait,
  writeScript,
} from "./harness.ts";

let home = "";
let socket = "";
// The fake plugin's settings folder, where it keeps what it is asked and its answers.
let plugin = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skelcrew");
const env = () => homeEnv(home);
const until = (done: () => boolean, timeout = 20_000) => wait(done, { timeout });

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-queued-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  // The lead waits at its prompt. A builder can't start, as without a login.
  writeScript(
    home,
    "claude",
    `case "$CLAUDE_CONFIG_DIR" in */lead-*) stty -echo; echo "❯"; exec cat > "$CLAUDE_CONFIG_DIR/typed" ;; esac
echo "Not logged in"; exit 1`,
  );
  writeScript(home, "systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  // sc install is done, so the daemon doesn't wait for it.
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${join(home, "github")}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Simon\n\temail = simon@example.com\n`,
  );
  plugin = fakePlugin(home);
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

// Runs the daemon, polling every 200 milliseconds and looking at the queue every 100.
function serve(): Subprocess {
  const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)}, 200);`;
  const run = Bun.spawn([process.execPath, "-e", code], {
    env: { ...env(), SKELCREW_CHECK_WAIT_MS: "0", SKELCREW_LOOK_MS: "100" },
    stdout: Bun.file(join(home, "daemon.log")),
    stderr: Bun.file(join(home, "daemon.err")),
  });
  running.push(run);
  return run;
}

// Waits until the daemon has looked at the queue since this call, so a task whose turn came has
// left it: a look moves it out of the queue at once. A look that found nothing leaves no trace,
// but the daemon's polls show on the fake plugin, and its timers run in the order they fall
// due. Polls come at least 200 ms apart, so by the third poll after this call, the look due
// every 100 ms fell due before it, and has run.
async function queueLooked(): Promise<void> {
  const polls = () => asked(plugin).filter((q) => q.ask === "changed").length;
  const before = polls();
  await until(() => polls() >= before + 3);
}

// Stops the daemon, as a restart of the engine does. Sessions keep running.
async function stopDaemon(): Promise<void> {
  for (const serve of running.splice(0)) {
    serve.kill();
    await serve.exited;
  }
}

// Puts simon/app on the fake GitHub, with a skelcrew.yaml allowing one builder at once, and tells
// Skelcrew about it, as a repository you have opened. Its issues 11 to 13 are open, labeled as
// given. Its task 11 already has a builder at work, in a tmux session of the test's own.
function addApp(labeled: string[] = []): void {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  writeFileSync(join(work, "skelcrew.yaml"), "tracker: github\nlimits: { threads: 1 }\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(home, "github", "simon", "app.git"));
  const working = threadSql({ task: "11", title: "Fix login", session: "s", host: "tmux" });
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, opened, forge, remote, claimed) VALUES ('app', 'simon', 'app', 1, 'github', 'https://github.com/simon/app.git', 1)");
db.exec(${JSON.stringify(working)});`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  Bun.spawnSync(["tmux", "-L", socket, "new-session", "-d", "-s", "app-11", "sleep 300"]);
  const issues = [
    ["11", "Fix login"],
    ["12", "Add export"],
    ["13", "Dark mode"],
  ].map(([id = "", title]) =>
    taskItem(id, title ?? "", { labels: labeled.includes(id) ? ["skelcrew"] : [] }),
  );
  answer(plugin, "changed", { items: issues, next: "2026-11-06T10:00:00Z" });
}

// Returns each thread's status, by its folder, as the database has it now.
function statuses(): Record<string, string> {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const rows = db.query("SELECT folder, status FROM threads").all();
    return Object.fromEntries(rows.map((row) => Object.values(Object(row)).map(String)));
  } finally {
    db.close();
  }
}

// Returns the thread's log, a line for each change, oldest first.
function logOf(folder: string): { at: string; status: string; why?: string }[] {
  const file = join(data(), "threads", `${folder}.log`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Returns each time the thread left the queue to start, from its log, in milliseconds.
function leftQueue(folder: string): number[] {
  return logOf(folder)
    .filter((line) => line.why === "its turn came in the queue of limits.threads")
    .map((line) => Date.parse(line.at));
}

// Returns when the thread first had a status other than working and queued, from its log, in
// milliseconds.
const endedAt = (folder: string) =>
  Date.parse(
    logOf(folder).find((line) => line.status !== "working" && line.status !== "queued")?.at ?? "",
  );

// Returns when the thread's task last joined the queue, in milliseconds.
function joinedAt(folder: string): number {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const row = db.query("SELECT queued_since FROM task_threads WHERE folder = ?").get(folder);
    return Number(Object.values(Object(row))[0]);
  } finally {
    db.close();
  }
}

// Returns how many claims Skelcrew has saved, whose outcome it doesn't know yet.
function claimsSaved(): number {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    return Number(Object.values(Object(db.query("SELECT COUNT(*) FROM claims").get()))[0]);
  } finally {
    db.close();
  }
}

// Returns what the lead was told, and what still waits to be typed into it: a lead can't start
// where the tests run inside Skelcrew's own sandbox, and its notes then wait.
function leadHears(): string {
  const typed = join(data(), "claude", leadPlaces("simon", "app").name, "typed");
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const notes = db.query("SELECT text FROM notes").all();
    return [read(typed), ...notes.map((row) => Object.values(Object(row)).join(""))].join("\n");
  } finally {
    db.close();
  }
}

// Runs sc and returns what it printed, failing the test on an error.
async function sc(...args: string[]): Promise<string> {
  const { out, err, code } = await runSkel(args, env());
  if (code !== 0) throw new Error(`sc ${args.join(" ")} failed: ${err}`);
  return out;
}

// Starts the daemon and waits until it has polled app's tracker. A daemon started again after a
// stop waits for a poll of its own.
async function serveApp(): Promise<void> {
  const polls = () => asked(plugin).filter((q) => q.ask === "changed").length;
  const before = polls();
  serve();
  await wait(() => polls() > before, {
    timeout: 20_000,
    what: () => readFileSync(join(home, "daemon.log"), "utf8"),
  });
}

test("a start over limits.threads waits as queued, and starts in order once a builder ends", async () => {
  addApp();
  await serveApp();
  expect(await sc("start", "APP-12")).toContain("APP-12 is queued");
  expect(await sc("start", "APP-13")).toContain("APP-13 is queued");
  // Starting it again keeps its place, rather than queueing it twice.
  expect(await sc("start", "APP-12")).toContain("APP-12 is queued");
  // Queued is a task at work, in stage working, whose thread waits for a builder.
  const tasks = JSON.parse(await sc("ls", "app", "--json"));
  const app12 = tasks.find((row: { task: string }) => row.task === "APP-12");
  expect(app12).toMatchObject({ stage: "working", thread: { status: "queued" } });
  expect(await sc("ps", "app")).toContain("queued");
  // Nothing starts while app-11's builder works.
  await queueLooked();
  expect(statuses()).toEqual({ "app-11": "working", "app-12": "queued", "app-13": "queued" });
  // Once it ends, app-12 starts, and app-13 only once app-12's builder has ended too.
  await sc("rm", "app-11");
  await until(() => statuses()["app-13"] === "failed");
  expect(statuses()).toMatchObject({ "app-11": "done", "app-12": "failed" });
  expect(leftQueue("app-12")).toHaveLength(1);
  expect(leftQueue("app-13")).toHaveLength(1);
  expect(leftQueue("app-12")[0] ?? 0).toBeGreaterThanOrEqual(endedAt("app-11"));
  expect(leftQueue("app-13")[0] ?? 0).toBeGreaterThanOrEqual(endedAt("app-12"));
}, 60_000);

// Moves app's queued task one place earlier or later, as a key in the list asks the daemon, and
// returns what the daemon said.
async function moveQueued(task: string, by: -1 | 1): Promise<string> {
  const code = `import { moveQueued } from ${JSON.stringify(source("client.ts"))};
try { console.log(await moveQueued("app", ${JSON.stringify(task)}, ${by})); }
catch (error) { console.log(String(error)); }`;
  const run = Bun.spawn([process.execPath, "-e", code], { env: env(), stdout: "pipe" });
  return (await new Response(run.stdout).text()).trim();
}

test("a task moved earlier in the queue starts first, and the queue keeps its order after a restart", async () => {
  addApp();
  await serveApp();
  await sc("start", "app-12");
  await sc("start", "app-13");
  expect(await moveQueued("13", -1)).toBe("APP-13 starts next");
  await stopDaemon();
  await serveApp();
  await queueLooked();
  expect(statuses()).toEqual({ "app-11": "working", "app-12": "queued", "app-13": "queued" });
  await sc("rm", "app-11");
  await until(() => statuses()["app-12"] === "failed");
  expect(leftQueue("app-13")).toHaveLength(1);
  expect(leftQueue("app-12")[0] ?? 0).toBeGreaterThanOrEqual(endedAt("app-13"));
}, 60_000);

test("sc rm takes a task out of the queue, back to its issue, and it never starts", async () => {
  addApp();
  await serveApp();
  await sc("start", "app-12");
  await sc("start", "app-13");
  expect(await sc("rm", "APP-12")).toContain("Removed APP-12");
  const tasks = JSON.parse(await sc("ls", "app", "--json"));
  const app12 = tasks.find((row: { task: string }) => row.task === "APP-12");
  expect(app12).toMatchObject({ stage: "issue", thread: { status: "done" } });
  await sc("rm", "app-11");
  await until(() => statuses()["app-13"] === "failed");
  expect(statuses()["app-12"]).toBe("done");
  expect(leftQueue("app-12")).toHaveLength(0);
  // Started again, it joins the queue afresh.
  expect(await sc("start", "app-12")).toContain("Started APP-12");
}, 60_000);

test("a labelled issue is claimed once as it joins the queue, after a restart too", async () => {
  addApp(["12", "13"]);
  answer(plugin, "took", { took: true });
  await serveApp();
  const bothQueued = { "app-11": "working", "app-12": "queued", "app-13": "queued" };
  await wait(() => statuses()["app-12"] === "queued" && statuses()["app-13"] === "queued", {
    timeout: 20_000,
    what: () => `${JSON.stringify(statuses())}\n${readFileSync(join(home, "daemon.log"), "utf8")}`,
  });
  expect(statuses()).toEqual(bothQueued);
  // Their claims were made, so none is left for a restart to take for one cut short.
  expect(claimsSaved()).toBe(0);
  const claims = () => asked(plugin).filter((q) => q.ask === "took");
  await stopDaemon();
  await serveApp();
  // A few polls later, nothing was claimed or queued again.
  const polls = () => asked(plugin).filter((q) => q.ask === "changed").length;
  const before = polls();
  await until(() => polls() >= before + 3);
  expect(
    claims()
      .map((q) => q.task)
      .sort(),
  ).toEqual(["12", "13"]);
  expect(statuses()).toEqual(bothQueued);
  // The lead is told of each one queued. A note is typed until the lead has it, so one the
  // restart caught while typing can be typed again: the claims above show nothing queued twice.
  expect(leadHears()).toContain("queued APP-12 from github");
  expect(leadHears()).toContain("queued APP-13 from github");
}, 60_000);

test("sc start of a stopped task over the limit waits as queued, and is brought back in its turn", async () => {
  addApp();
  const stopped = threadSql({ task: "12", title: "Add export", session: "t", status: "stopped" });
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(stopped)});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  await serveApp();
  expect(await sc("start", "APP-12")).toContain("APP-12 is queued");
  expect(statuses()["app-12"]).toBe("queued");
  await sc("rm", "app-11");
  await until(() => statuses()["app-12"] === "failed");
  expect(leftQueue("app-12")).toHaveLength(1);
}, 60_000);

test("a task the engine stopped while it left the queue goes back in the queue, and starts once", async () => {
  addApp();
  // app-12 left the queue, but the engine stopped before its builder's session was saved.
  const cut = threadSql({ task: "12", title: "Add export", queued_since: 1 });
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(cut)});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  await serveApp();
  await queueLooked();
  expect(statuses()).toEqual({ "app-11": "working", "app-12": "queued" });
  await sc("rm", "app-11");
  await until(() => statuses()["app-12"] === "failed");
  expect(leftQueue("app-12")).toHaveLength(1);
}, 60_000);

test("a queued sc start leaves the queue only once its claim is made, across a restart too", async () => {
  addApp();
  await serveApp();
  const failing = join(plugin, "fail-took");
  writeFileSync(failing, "network is down");
  const said = await sc("start", "app-12");
  expect(said).toContain("APP-12 is queued");
  expect(said).toContain("couldn't claim its issue yet");
  // A place frees up, but the task owes its claim, so it waits, after a restart too.
  await stopDaemon();
  await serveApp();
  await sc("rm", "app-11");
  await queueLooked();
  expect(statuses()["app-12"]).toBe("queued");
  // Once the tracker takes the claim, it starts, once.
  rmSync(failing);
  await until(() => statuses()["app-12"] === "failed");
  expect(leftQueue("app-12")).toHaveLength(1);
  const claims = asked(plugin).filter((q) => q.ask === "took");
  expect(claims.length).toBeGreaterThanOrEqual(2);
}, 60_000);

test("a labelled issue whose claim the engine's stop cut short starts nowhere twice, and the lead hears of it", async () => {
  addApp(["12", "13"]);
  // The engine stopped after asking to claim issue 12, before it recorded the task. The tracker
  // now says both issues are taken: 12 maybe by this machine, 13 by another.
  const cut = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO claims (owner, repo, task) VALUES ('simon', 'app', '12')");`;
  Bun.spawnSync([process.execPath, "-e", cut], { env: env() });
  answer(plugin, "took", { took: false });
  await serveApp();
  await until(() => leadHears().includes("APP-12's claim was cut short"));
  const polls = () => asked(plugin).filter((q) => q.ask === "changed").length;
  const before = polls();
  await until(() => polls() >= before + 3);
  expect(statuses()).toEqual({ "app-11": "working" });
  // Each issue was asked about once, and only 12's claim may be this machine's.
  const claims = asked(plugin).filter((q) => q.ask === "took");
  expect(claims.map((q) => q.task).sort()).toEqual(["12", "13"]);
  expect(leadHears()).toContain("If no other machine works on it, sc start APP-12.");
  expect(leadHears()).not.toContain("APP-13's claim");
}, 60_000);

test("a task that still owes its claim holds back the tasks that joined after it", async () => {
  addApp();
  // app-12 joined first and owes its claim, which the tracker fails. app-13 joined after it.
  const rows = `${threadSql({ task: "12", title: "Add export", status: "queued", queued_since: 1 })}
${threadSql({ task: "13", title: "Dark mode", status: "queued", queued_since: 2 })}
INSERT INTO claims (owner, repo, task) VALUES ('simon', 'app', '12');`;
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(rows)});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  const failing = join(plugin, "fail-took");
  writeFileSync(failing, "network is down");
  await serveApp();
  await sc("rm", "app-11");
  await queueLooked();
  expect(statuses()).toMatchObject({ "app-12": "queued", "app-13": "queued" });
  // Once app-12's claim is made, it starts first, and app-13 after it.
  rmSync(failing);
  await until(() => statuses()["app-13"] === "failed");
  expect(leftQueue("app-12")).toHaveLength(1);
  expect(leftQueue("app-13")[0] ?? 0).toBeGreaterThanOrEqual(endedAt("app-12"));
}, 60_000);

test("a labelled issue that can't start after its claim is told to the lead, not dropped", async () => {
  addApp(["12"]);
  answer(plugin, "took", { took: true });
  // A round limit that isn't valid refuses the start once the claim is made.
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    "harness: claude\nmax_rounds: 0\n",
  );
  await serveApp();
  await until(() =>
    leadHears().includes("couldn't start APP-12 from its label; once fixed, sc start APP-12"),
  );
  expect(statuses()["app-12"]).toBeUndefined();
}, 60_000);

test("a queued task whose issue another machine claimed while its claim failed leaves the queue, and the lead hears", async () => {
  addApp();
  await serveApp();
  const failing = join(plugin, "fail-took");
  writeFileSync(failing, "network is down");
  expect(await sc("start", "app-12")).toContain("couldn't claim its issue yet");
  // Meanwhile another machine claims it, and the tracker comes back.
  answer(plugin, "took", { took: false });
  rmSync(failing);
  await until(() => statuses()["app-12"] === "done");
  expect(leadHears()).toContain("APP-12 left the queue: its issue was claimed");
  // A place frees up, and app-12 never starts.
  await sc("rm", "app-11");
  await queueLooked();
  expect(leftQueue("app-12")).toHaveLength(0);
  const tasks = JSON.parse(await sc("ls", "app", "--json"));
  expect(tasks.find((row: { task: string }) => row.task === "APP-12")).toMatchObject({
    stage: "issue",
  });
}, 60_000);

// Which task goes first by these times is tested on the database alone. Here a start through
// the engine saves its own.
test("a task joins the queue after every task already in it, though the clock went back", async () => {
  addApp();
  // app-13 joined the queue at a time later than now, as before the clock was set back.
  const later = Date.now() + 60_000;
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(threadSql({ task: "13", title: "Dark mode", status: "queued", queued_since: later }))});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  await serveApp();
  expect(await sc("start", "app-12")).toContain("APP-12 is queued");
  expect(joinedAt("app-12")).toBeGreaterThan(later);
}, 60_000);

test("sc rm while a queued sc start waits for its claim leaves the issue unassigned", async () => {
  addApp();
  await serveApp();
  // The tracker takes its time to answer the claim, and sc rm comes in meanwhile.
  const hold = join(plugin, "hold-took");
  writeFileSync(hold, "");
  const starting = sc("start", "app-12");
  await until(() => asked(plugin).some((q) => q.ask === "took"));
  expect(await sc("rm", "APP-12")).toContain("Removed APP-12");
  rmSync(hold);
  expect(await starting).toContain("APP-12 is queued");
  // sc start's work with the tracker comes after its answer, so a few polls give it time.
  const polls = () => asked(plugin).filter((q) => q.ask === "changed").length;
  const before = polls();
  await until(() => polls() >= before + 3);
  expect(asked(plugin).filter((q) => q.ask === "assign" && q.on === true)).toHaveLength(0);
  expect(statuses()["app-12"]).toBe("done");
}, 60_000);

test("a claim the engine's stop cut short is told to the lead, though its label was removed meanwhile", async () => {
  addApp();
  // The engine stopped after asking to claim issue 12 from its label, before it recorded the
  // task. Before the restart, someone took the label off.
  const cut = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO claims (owner, repo, task) VALUES ('simon', 'app', '12')");`;
  Bun.spawnSync([process.execPath, "-e", cut], { env: env() });
  await serveApp();
  await until(() => leadHears().includes("APP-12's claim was cut short"));
  expect(leadHears()).toContain("sc start APP-12");
  expect(claimsSaved()).toBe(0);
  expect(statuses()).toEqual({ "app-11": "working" });
  // Nothing claims the issue now that nobody asks for it.
  expect(asked(plugin).filter((q) => q.ask === "took")).toHaveLength(0);
}, 60_000);

test("a task removed and started again while its claim was asked makes a claim of its own", async () => {
  addApp();
  await serveApp();
  const hold = join(plugin, "hold-took");
  writeFileSync(hold, "");
  const claims = () => asked(plugin).filter((q) => q.ask === "took").length;
  const first = sc("start", "app-12");
  await until(() => claims() === 1);
  await sc("rm", "app-12");
  // The answer to the first claim was for the task sc rm removed, so the new start asks anew.
  const again = sc("start", "app-12");
  await until(() => claims() === 2);
  rmSync(hold);
  await first;
  expect(await again).toContain("APP-12 is queued");
  await sc("rm", "app-11");
  await until(() => statuses()["app-12"] === "failed");
  expect(leftQueue("app-12")).toHaveLength(1);
}, 60_000);

test("a claim the engine's stop cut short after sc rm is told to the lead, not forgotten", async () => {
  addApp();
  await serveApp();
  const hold = join(plugin, "hold-took");
  writeFileSync(hold, "");
  const first = sc("start", "app-12");
  await until(() => asked(plugin).some((q) => q.ask === "took"));
  await sc("rm", "app-12");
  // The engine stops before the tracker answers, which may have granted the claim.
  await stopDaemon();
  await first.catch(() => "");
  expect(claimsSaved()).toBe(1);
  rmSync(hold);
  await serveApp();
  await until(() => leadHears().includes("APP-12's claim was cut short"));
  expect(leadHears()).toContain("sc start APP-12");
  expect(claimsSaved()).toBe(0);
  expect(statuses()["app-12"]).toBe("done");
}, 60_000);

test("a queued task sc rm is removing holds its place, and keeps it when sc rm fails", async () => {
  addApp();
  // app-12, stopped with a PR, waits first in the queue to come back. app-13 joined after it.
  const rows = `${threadSql({ task: "12", title: "Add export", status: "queued", session: "t", pr: 7, queued_since: 1 })}
${threadSql({ task: "13", title: "Dark mode", status: "queued", queued_since: 2 })}`;
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(rows)});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  await serveApp();
  // sc rm of app-12 waits on the forge to close its PR, which then fails.
  writeFileSync(join(plugin, "hold-close-pr"), "");
  writeFileSync(join(plugin, "fail-close-pr"), "the forge is down");
  const removal = runSkel(["rm", "app-12"], env());
  await until(() => asked(plugin).some((q) => q.ask === "close pr"));
  // A place frees up while app-12 is being removed: app-13, behind it, doesn't take it.
  await sc("rm", "app-11");
  await queueLooked();
  expect(statuses()).toMatchObject({ "app-12": "queued", "app-13": "queued" });
  rmSync(join(plugin, "hold-close-pr"));
  expect((await removal).code).not.toBe(0);
  // app-12 stays first, and leaves the queue before app-13.
  await until(() => statuses()["app-13"] === "failed");
  expect(leftQueue("app-12")).toHaveLength(1);
  expect(leftQueue("app-13")[0] ?? 0).toBeGreaterThanOrEqual(leftQueue("app-12")[0] ?? 0);
}, 60_000);

// Gives app's task a PR, as if its builder had opened one, so sc rm waits on the forge to close
// it.
function givePr(task: string, pr: number): void {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    db.run("UPDATE tasks SET pr = ? WHERE owner = 'simon' AND repo = 'app' AND task = ?", [
      pr,
      task,
    ]);
  } finally {
    db.close();
  }
}

test("a claim taken elsewhere while sc rm waits on the forge waits for sc rm, and ends the task when it fails", async () => {
  addApp();
  // app-12 waits in the queue, with a PR, and still owes the claim of its issue.
  const rows = `${threadSql({ task: "12", title: "Add export", status: "queued", session: "t", pr: 7, queued_since: 1 })}
INSERT INTO claims (owner, repo, task) VALUES ('simon', 'app', '12');`;
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(rows)});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  const failing = join(plugin, "fail-took");
  writeFileSync(failing, "network is down");
  await serveApp();
  // sc rm waits on the forge, and the tracker comes back saying another machine took the issue.
  writeFileSync(join(plugin, "hold-close-pr"), "");
  writeFileSync(join(plugin, "fail-close-pr"), "the forge is down");
  const removal = runSkel(["rm", "app-12"], env());
  await until(() => asked(plugin).some((q) => q.ask === "close pr"));
  answer(plugin, "took", { took: false });
  rmSync(failing);
  await until(() => asked(plugin).some((q) => q.ask === "took"));
  await queueLooked();
  // The answer waits for sc rm, so the task is still queued, and still owes its claim.
  expect(statuses()["app-12"]).toBe("queued");
  expect(claimsSaved()).toBe(1);
  // sc rm fails, and only then does the taken issue end the task, which the lead hears.
  rmSync(join(plugin, "hold-close-pr"));
  expect((await removal).code).not.toBe(0);
  await until(() => statuses()["app-12"] === "done");
  expect(claimsSaved()).toBe(0);
  expect(leadHears()).toContain("APP-12 left the queue: its issue was claimed");
}, 60_000);

test("a claim that answers while sc rm waits on the forge doesn't assign the issue again", async () => {
  addApp();
  await serveApp();
  // The tracker takes its time to answer the claim, and sc rm comes in meanwhile.
  const hold = join(plugin, "hold-took");
  writeFileSync(hold, "");
  const starting = sc("start", "app-12");
  await until(() => asked(plugin).some((q) => q.ask === "took"));
  // sc rm takes you off the issue, then waits on the forge to close the task's PR.
  givePr("12", 7);
  writeFileSync(join(plugin, "hold-close-pr"), "");
  const removal = runSkel(["rm", "app-12"], env());
  await until(() => asked(plugin).some((q) => q.ask === "close pr"));
  rmSync(hold);
  // sc start waits for sc rm, so the forge is let go first.
  rmSync(join(plugin, "hold-close-pr"));
  expect((await removal).code).toBe(0);
  expect(await starting).toContain("APP-12 is queued");
  // sc start's work with the tracker comes after its answer, so a few polls give it time.
  await queueLooked();
  expect(asked(plugin).filter((q) => q.ask === "assign" && q.on === true)).toHaveLength(0);
  expect(statuses()["app-12"]).toBe("done");
}, 60_000);

test("a claim that answers while sc rm waits on the forge assigns the issue once sc rm fails", async () => {
  addApp();
  await serveApp();
  const hold = join(plugin, "hold-took");
  writeFileSync(hold, "");
  const starting = sc("start", "app-12");
  await until(() => asked(plugin).some((q) => q.ask === "took"));
  // sc rm takes you off the issue, then waits on the forge, which fails.
  givePr("12", 7);
  writeFileSync(join(plugin, "hold-close-pr"), "");
  writeFileSync(join(plugin, "fail-close-pr"), "the forge is down");
  const removal = runSkel(["rm", "app-12"], env());
  await until(() => asked(plugin).some((q) => q.ask === "close pr"));
  rmSync(hold);
  await queueLooked();
  expect(asked(plugin).filter((q) => q.ask === "assign" && q.on === true)).toHaveLength(0);
  rmSync(join(plugin, "hold-close-pr"));
  expect((await removal).code).not.toBe(0);
  // The task stays queued, so you are put back on its issue.
  expect(await starting).toContain("APP-12 is queued");
  await until(() => asked(plugin).some((q) => q.ask === "assign" && q.on === true));
  expect(statuses()["app-12"]).toBe("queued");
}, 60_000);

test("a claim taken elsewhere while sc rm waits on the forge leaves the end to sc rm when it succeeds", async () => {
  addApp();
  // app-12 waits in the queue, with a PR, and still owes the claim of its issue.
  const rows = `${threadSql({ task: "12", title: "Add export", status: "queued", session: "t", pr: 7, queued_since: 1 })}
INSERT INTO claims (owner, repo, task) VALUES ('simon', 'app', '12');`;
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(rows)});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  const failing = join(plugin, "fail-took");
  writeFileSync(failing, "network is down");
  await serveApp();
  writeFileSync(join(plugin, "hold-close-pr"), "");
  const removal = runSkel(["rm", "app-12"], env());
  await until(() => asked(plugin).some((q) => q.ask === "close pr"));
  answer(plugin, "took", { took: false });
  rmSync(failing);
  await queueLooked();
  rmSync(join(plugin, "hold-close-pr"));
  expect((await removal).code).toBe(0);
  // sc rm removed it, so the lead hears nothing of the claim, and nothing stays owed.
  await until(() => claimsSaved() === 0);
  expect(statuses()["app-12"]).toBe("done");
  expect(leadHears()).not.toContain("APP-12 left the queue");
}, 60_000);

test("a claim that fails while sc rm waits on the forge doesn't assign the issue again", async () => {
  addApp();
  await serveApp();
  // The tracker takes its time to answer the claim, then fails.
  const hold = join(plugin, "hold-took");
  writeFileSync(hold, "");
  writeFileSync(join(plugin, "fail-took"), "network is down");
  const starting = sc("start", "app-12");
  await until(() => asked(plugin).some((q) => q.ask === "took"));
  // sc rm takes you off the issue, then waits on the forge to close the task's PR.
  givePr("12", 7);
  writeFileSync(join(plugin, "hold-close-pr"), "");
  const removal = runSkel(["rm", "app-12"], env());
  await until(() => asked(plugin).some((q) => q.ask === "close pr"));
  rmSync(hold);
  await queueLooked();
  rmSync(join(plugin, "hold-close-pr"));
  expect((await removal).code).toBe(0);
  expect(await starting).toContain("couldn't claim its issue yet");
  await queueLooked();
  expect(asked(plugin).filter((q) => q.ask === "assign" && q.on === true)).toHaveLength(0);
  expect(statuses()["app-12"]).toBe("done");
}, 60_000);
