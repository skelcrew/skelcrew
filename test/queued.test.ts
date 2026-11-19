// The queue of tasks under limits.threads, against a running daemon: a start over the limit
// waits as queued, and starts in order once a builder ends. A builder already at work is a tmux
// session of the test's own, and every builder the queue starts stands in for Claude Code
// failing to start, so each start ends, and frees its place, at once.
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

// Runs the daemon, polling every 200 milliseconds.
function serve(): Subprocess {
  const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)}, 200);`;
  const run = Bun.spawn([process.execPath, "-e", code], {
    env: { ...env(), SKELCREW_CHECK_WAIT_MS: "0" },
    stdout: Bun.file(join(home, "daemon.log")),
    stderr: Bun.file(join(home, "daemon.err")),
  });
  running.push(run);
  return run;
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
  expect(await sc("start", "app-12")).toContain("app-12 is queued");
  expect(await sc("start", "app-13")).toContain("app-13 is queued");
  // Starting it again keeps its place, rather than queueing it twice.
  expect(await sc("start", "app-12")).toContain("app-12 is queued");
  // Queued is a task at work, in stage working, whose thread waits for a builder.
  const tasks = JSON.parse(await sc("ls", "app", "--json"));
  const app12 = tasks.find((row: { task: string }) => row.task === "app-12");
  expect(app12).toMatchObject({ stage: "working", thread: { status: "queued" } });
  expect(await sc("ps", "app")).toContain("queued");
  // Nothing starts while app-11's builder works.
  await Bun.sleep(3000);
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

test("a queued task keeps its place after a restart of the engine", async () => {
  addApp();
  await serveApp();
  await sc("start", "app-13");
  await sc("start", "app-12");
  await stopDaemon();
  await serveApp();
  await Bun.sleep(3000);
  expect(statuses()).toEqual({ "app-11": "working", "app-12": "queued", "app-13": "queued" });
  // app-13 joined first, so it starts first.
  await sc("rm", "app-11");
  await until(() => statuses()["app-12"] === "failed");
  expect(leftQueue("app-13")).toHaveLength(1);
  expect(leftQueue("app-12")).toHaveLength(1);
  expect(leftQueue("app-12")[0] ?? 0).toBeGreaterThanOrEqual(endedAt("app-13"));
}, 60_000);

test("sc rm takes a task out of the queue, back to its issue, and it never starts", async () => {
  addApp();
  await serveApp();
  await sc("start", "app-12");
  await sc("start", "app-13");
  expect(await sc("rm", "app-12")).toContain("Removed app-12");
  const tasks = JSON.parse(await sc("ls", "app", "--json"));
  const app12 = tasks.find((row: { task: string }) => row.task === "app-12");
  expect(app12).toMatchObject({ stage: "issue", thread: { status: "done" } });
  await sc("rm", "app-11");
  await until(() => statuses()["app-13"] === "failed");
  expect(statuses()["app-12"]).toBe("done");
  expect(leftQueue("app-12")).toHaveLength(0);
  // Started again, it joins the queue afresh.
  expect(await sc("start", "app-12")).toContain("Started app-12");
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
  expect(leadHears()).toContain("queued app-12 from github");
  expect(leadHears()).toContain("queued app-13 from github");
}, 60_000);

test("sc start of a stopped task over the limit waits as queued, and is brought back in its turn", async () => {
  addApp();
  const stopped = threadSql({ task: "12", title: "Add export", session: "t", status: "stopped" });
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(stopped)});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  await serveApp();
  expect(await sc("start", "app-12")).toContain("app-12 is queued");
  expect(statuses()["app-12"]).toBe("queued");
  await sc("rm", "app-11");
  await until(() => statuses()["app-12"] === "failed");
  expect(leftQueue("app-12")).toHaveLength(1);
}, 60_000);

test("a task the engine stopped while it left the queue goes back in its place, and starts once", async () => {
  addApp();
  // app-12 left the queue, but the engine stopped before its builder's session was saved.
  const cut = threadSql({ task: "12", title: "Add export", queued_since: 1 });
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(cut)});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  await serveApp();
  await sc("start", "app-13");
  await Bun.sleep(3000);
  expect(statuses()).toEqual({ "app-11": "working", "app-12": "queued", "app-13": "queued" });
  // It joined first, so it starts first.
  await sc("rm", "app-11");
  await until(() => statuses()["app-13"] === "failed");
  expect(leftQueue("app-12")).toHaveLength(1);
  expect(leftQueue("app-13")[0] ?? 0).toBeGreaterThanOrEqual(endedAt("app-12"));
}, 60_000);

test("a queued sc start leaves the queue only once its claim is made, across a restart too", async () => {
  addApp();
  await serveApp();
  const failing = join(plugin, "fail-took");
  writeFileSync(failing, "network is down");
  const said = await sc("start", "app-12");
  expect(said).toContain("app-12 is queued");
  expect(said).toContain("couldn't claim its issue yet");
  // A place frees up, but the task owes its claim, so it waits, after a restart too.
  await stopDaemon();
  await serveApp();
  await sc("rm", "app-11");
  await Bun.sleep(3000);
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
  await until(() => leadHears().includes("app-12's claim was cut short"));
  const polls = () => asked(plugin).filter((q) => q.ask === "changed").length;
  const before = polls();
  await until(() => polls() >= before + 3);
  expect(statuses()).toEqual({ "app-11": "working" });
  // Each issue was asked about once, and only 12's claim may be this machine's.
  const claims = asked(plugin).filter((q) => q.ask === "took");
  expect(claims.map((q) => q.task).sort()).toEqual(["12", "13"]);
  expect(leadHears()).toContain("If no other machine works on it, sc start app-12.");
  expect(leadHears()).not.toContain("app-13's claim");
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
  await Bun.sleep(3000);
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
    leadHears().includes("couldn't start app-12 from its label; once fixed, sc start app-12"),
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
  expect(leadHears()).toContain("app-12 left the queue: its issue was claimed");
  // A place frees up, and app-12 never starts.
  await sc("rm", "app-11");
  await Bun.sleep(3000);
  expect(leftQueue("app-12")).toHaveLength(0);
  const tasks = JSON.parse(await sc("ls", "app", "--json"));
  expect(tasks.find((row: { task: string }) => row.task === "app-12")).toMatchObject({
    stage: "issue",
  });
}, 60_000);

test("a task joins the queue after every task already in it, though the clock went back", async () => {
  addApp();
  // app-13 joined the queue at a time later than now, as before the clock was set back.
  const later = threadSql({
    task: "13",
    title: "Dark mode",
    status: "queued",
    queued_since: Date.now() + 60_000,
  });
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().exec(${JSON.stringify(later)});`;
  Bun.spawnSync([process.execPath, "-e", code], { env: env() });
  await serveApp();
  await sc("start", "app-12");
  // app-13 joined first, so it starts first.
  await sc("rm", "app-11");
  await until(() => statuses()["app-12"] === "failed");
  expect(leftQueue("app-12")[0] ?? 0).toBeGreaterThanOrEqual(endedAt("app-13"));
}, 60_000);
