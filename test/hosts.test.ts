// The sessions module and the transport on a runtime plugin's host, against a fake host that
// keeps its sessions in a folder: once providing only sessions, so the built-in transport types
// through the host's paste, keys and read, and once providing its own transport and status too.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claude } from "../src/agents/claude.ts";
import {
  agentRuns,
  failedScreen,
  hasSession,
  interruptSession,
  type Labels,
  listSessions,
  readSession,
  startSession,
  stillRunning,
  stopSession,
} from "../src/agents/sessions.ts";
import { deliver, forQuestion, idle, whyBusy } from "../src/agents/transport.ts";
import type { PluginHost } from "../src/plugins/runtime.ts";
import { homeEnv, source, threadSql, until as wait } from "./harness.ts";

const moment = 100;
let home = "";
// The fake host's name, a new one for each test, so each has a settings folder of its own.
let name = "";

// The fake host's settings folder, where it keeps its sessions and notes what it is asked.
const settings = () => join(homedir(), ".config", "skelcrew", "plugins", name);

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skelcrew-host-test-")));
  name = `fake-${Math.random().toString(36).slice(2)}`;
});
afterEach(() => {
  // Each session's process group ends with the test, whatever it left running, on the host
  // this process asks and on the one a process of the test's own home asks.
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  for (const sessions of [join(settings(), "sessions"), join(fake, "sessions")])
    for (const id of existsSync(sessions) ? readdirSync(sessions) : [])
      try {
        process.kill(-Number(readFileSync(join(sessions, id, "pid"), "utf8")), "SIGKILL");
      } catch {}
  rmSync(settings(), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// The fake host, providing sessions and, when asked, its own transport and status.
const host = (own: { transport?: boolean; status?: boolean } = {}): PluginHost => ({
  plugin: name,
  folder: home,
  session: ["bun", join(import.meta.dir, "fake-host.ts")],
  attach: ["true"],
  transport: own.transport ?? false,
  status: own.status ?? false,
});

// A stand-in for Claude Code: busy for a while, losing what is typed then, as the real one can,
// then its prompt, keeping every byte it receives. It stays in the session's process group, as
// timeout would leave it for one of its own, which ending the session wouldn't reach.
function harness(busySeconds = 0): string[] {
  const script = join(home, "harness.sh");
  writeFileSync(
    script,
    `#!/bin/sh
if [ ${busySeconds} -gt 0 ]; then
  echo "Thinking (${claude.marks.busy})"
  cat <&0 > lost.txt &
  sleep ${busySeconds}
  kill $!
  printf '\\033[2J'
fi
echo "${claude.marks.prompt}"
cat > received.txt
`,
    { mode: 0o755 },
  );
  return [script];
}

// The labels every session in these tests carries.
const labels: Labels = { repository: "simon/app", role: "builder", task: "app-12" };

// Starts a session on the host and returns its ID there.
const start = (on: PluginHost, command: string[]) =>
  startSession(on, "app-12", {
    folder: home,
    command,
    env: { PATH: process.env.PATH ?? "" },
    labels,
  });

const until = (done: () => boolean | Promise<boolean>) =>
  wait(done, { timeout: 30_000, every: 20 });
const read = (file: string) =>
  existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8") : "";
// The questions the host was asked, by what each asked.
const asked = () =>
  readFileSync(join(settings(), "asked"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).ask);

test("a session on the host runs its command, carries its labels and can be read", async () => {
  const on = host();
  const id = await start(on, [
    "sh",
    "-c",
    'pwd; echo $PATH; [ -n "$HOME" ] || echo no home; sleep 30',
  ]);
  expect(id).toBe("fake-app-12");
  await until(async () => (await readSession(on, id)).includes("no home"));
  expect(await readSession(on, id)).toBe(`${home}\n${process.env.PATH}\nno home\n`);
  expect(await listSessions(on)).toEqual([{ name: id, running: true, labels }]);
  expect(await hasSession(on, id)).toBe(true);
  expect(await agentRuns(on, id)).toBe(true);
});

test("an agent that ended is no longer running, and its last screen says why", async () => {
  const on = host();
  const id = await start(on, ["sh", "-c", "echo not logged in; exit 1"]);
  await until(async () => !(await agentRuns(on, id)));
  expect(await hasSession(on, id)).toBe(true);
  expect(await failedScreen(on, id)).toBe("not logged in");
});

test("stopping a session ends its process and the host forgets it", async () => {
  const on = host();
  const id = await start(on, ["sleep", "30"]);
  const pid = Number(readFileSync(join(settings(), "sessions", id, "pid"), "utf8"));
  await stopSession(on, id);
  expect(await hasSession(on, id)).toBe(false);
  expect(stillRunning([pid])).toEqual([]);
  // Stopping one that is gone does nothing.
  await stopSession(on, id);
});

test("interrupting a session sends its agent Esc", async () => {
  const on = host();
  const id = await start(on, ["sh", "-c", "echo ready; exec cat > keys.txt"]);
  await until(async () => (await readSession(on, id)).includes("ready"));
  await interruptSession(on, id);
  await until(() => read("keys.txt") === "\x1b");
});

test("with sessions only, the built-in transport types through the host's paste and keys", async () => {
  const on = host();
  const id = await start(on, harness(1));
  await deliver(on, id, claude.marks, "fix the bug\nthen run the tests", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("lost.txt")).toBe("");
  expect(read("received.txt")).toBe("\x1b[200~fix the bug\nthen run the tests\x1b[201~\n");
  expect(asked()).toContain("paste");
  expect(asked()).toContain("keys");
  expect(asked()).not.toContain("deliver");
  expect(asked()).not.toContain("idle");
});

test("with sessions only, idle comes from the agent's screen", async () => {
  const on = host();
  const id = await start(on, harness(30));
  await until(async () => (await readSession(on, id)).includes(claude.marks.busy));
  expect(await whyBusy(on, id, claude.marks, { moment })).toContain(claude.marks.busy);
  const typing = deliver(on, id, claude.marks, "hello", { moment, timeout: 500 });
  await expect(typing).rejects.toThrow(claude.marks.busy);
  expect(read("lost.txt")).toBe("");
});

test("a host with its own transport says when its agent is idle and delivers itself", async () => {
  const on = host({ transport: true });
  const id = await start(on, harness(1));
  await until(async () => (await readSession(on, id)).includes(claude.marks.busy));
  expect(await idle(on, id, claude.marks, { moment })).toBe(false);
  expect(await deliver(on, id, claude.marks, "hello", { moment })).toBe("typed");
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
  expect(await idle(on, id, claude.marks, { moment })).toBe(true);
  expect(asked()).toContain("deliver");
  expect(asked()).not.toContain("paste");
});

test("a message cancelled while the host waits to deliver it is never typed", async () => {
  const on = host({ transport: true });
  const id = await start(on, harness(2));
  await until(async () => (await readSession(on, id)).includes(claude.marks.busy));
  const cancel = new AbortController();
  const typing = deliver(on, id, claude.marks, "stale", { moment, signal: cancel.signal });
  await until(() => asked().includes("deliver"));
  cancel.abort();
  expect(await typing).toBe("not typed");
  await deliver(on, id, claude.marks, "fresh", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~fresh\x1b[201~\n");
});

test("a host that fails says what failed, naming the plugin", async () => {
  const on = host();
  mkdirSync(join(settings(), "sessions", "fake-app-12"), { recursive: true });
  await expect(readSession(on, "fake-app-12")).rejects.toThrow(`${name} couldn't read`);
});

// Runs `code` against Skelcrew's database in a process of its own with the test's home, where a
// thread app-12 runs on the fake host, installed as fake with sessions and status, and returns
// what the host was told of its status, in order.
function statusesAfter(code: string): { id: string; status: string; reason: string }[] {
  runWithFakeHost("sessions, status", code, { host: "fake", host_id: "fake-app-12" });
  const said = join(home, ".config", "skelcrew", "plugins", "fake", "statuses");
  return readFileSync(said, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

// Runs `code` in a process of its own with the test's home, after installing the fake host as a
// plugin named fake, providing `provides`, and saving thread app-12 with `row`. Returns what
// the code printed.
function runWithFakeHost(
  provides: string,
  code: string,
  row: Record<string, string | number | null>,
) {
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
session: [bun, ${JSON.stringify(join(import.meta.dir, "fake-host.ts"))}]
attach: ["true"]
`,
  );
  const script = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { record } from ${JSON.stringify(source("flow/thread.ts"))};
import { forgetStatus, keepState } from ${JSON.stringify(source("flow/status.ts"))};
import { builderSession, readThread } from ${JSON.stringify(source("flow/thread.ts"))};
import { endThread, removeThread, stopThread } from ${JSON.stringify(source("flow/events.ts"))};
import { noticeIdleScreens } from ${JSON.stringify(source("flow/status.ts"))};
import { wakeAfterLimit } from ${JSON.stringify(source("flow/limits.ts"))};
import { hasSession, startSession } from ${JSON.stringify(source("agents/sessions.ts"))};
import { bringBack, endEarlierBuilder, startOnHost } from ${JSON.stringify(source("flow/builder.ts"))};
import { deliverMessages, dropOldEvents, queueMessage } from ${JSON.stringify(source("flow/messages.ts"))};
const db = openDb();
db.run("INSERT INTO plugins (name, folder) VALUES ('fake', ?)", [${JSON.stringify(folder)}]);
db.exec(${JSON.stringify(threadSql({ task: "12", session: "s", ...row }))});
${code}`;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, ...homeEnv(home) },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}

test("a host that shows status hears every change, in order, even quick ones", () => {
  const said = statusesAfter(`record(db, "app-12", { needs_you: true }, "a review failed");
record(db, "app-12", { needs_you: false });
keepState(db, { folder: "app-12" }, "idle");
keepState(db, { folder: "app-12" }, "working");
record(db, "app-12", { rounds: 1 });`);
  expect(said).toEqual([
    { id: "fake-app-12", status: "needs you", reason: "needs you" },
    { id: "fake-app-12", status: "working", reason: "working" },
    { id: "fake-app-12", status: "idle", reason: "working" },
    { id: "fake-app-12", status: "working", reason: "working" },
  ]);
});

test("a session starting again under the same ID hears its status afresh", () => {
  const said = statusesAfter(`keepState(db, { folder: "app-12" }, "idle");
keepState(db, { folder: "app-12" }, "idle");
forgetStatus("fake", "fake-app-12");
keepState(db, { folder: "app-12" }, "idle");`);
  expect(said.map(({ status }) => status)).toEqual(["idle", "idle"]);
});

test("a builder whose ID never got saved is found on its host by its labels", () => {
  const said = runWithFakeHost(
    "sessions",
    `const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "builder", task: "app-12" } });
console.log((await builderSession(db, "unused", readThread(db, "app-12"))).id);
console.log(readThread(db, "app-12").host_id);`,
    { host: "fake", host_id: null },
  );
  expect(said).toBe("fake-app-12\nfake-app-12\n");
});

test("a lead whose ID never got saved is found on its host by its labels", () => {
  const said = runWithFakeHost(
    "sessions",
    `const { leadSession } = await import(${JSON.stringify(source("flow/lead.ts"))});
db.run("INSERT INTO repositories (name, owner, repo, remote, lead_host) VALUES ('app', 'simon', 'app', '', 'fake')");
const { host } = await leadSession(db, "unused", "simon", "app");
await startSession(host, "lead-app", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "lead" } });
console.log((await leadSession(db, "unused", "simon", "app")).id);
console.log(db.query("SELECT lead_host_id FROM repositories WHERE repo = 'app'").get().lead_host_id);`,
    {},
  );
  expect(said).toBe("fake-lead-app\nfake-lead-app\n");
});

test("a lead on a plugin no longer installed is out of reach, and isn't started elsewhere", () => {
  const said = runWithFakeHost(
    "sessions",
    `const { leadSession, startLead } = await import(${JSON.stringify(source("flow/lead.ts"))});
db.run("INSERT INTO repositories (name, owner, repo, remote, lead_host, lead_host_id) VALUES ('app', 'simon', 'app', '', 'gone', 'gone-1')");
console.log(await leadSession(db, "unused", "simon", "app"));
const repository = { name: "app", owner: "simon", repo: "app", forge: null, remote: "" };
console.log(await startLead(db, "unused", repository).catch((error) => error.message));`,
    {},
  );
  expect(said).toBe(
    "null\nsimon/app's lead ran on gone, which isn't installed now: install it again to reach the lead\n",
  );
});

test("a lead on a host that shows status hears each change of what it does", () => {
  const said =
    statusesAfter(`db.run("INSERT INTO repositories (name, owner, repo, remote, lead_host, lead_host_id) VALUES ('app', 'simon', 'app', '', 'fake', 'fake-lead-app')");
keepState(db, { owner: "simon", repo: "app" }, "working");
keepState(db, { owner: "simon", repo: "app" }, "asking");
keepState(db, { owner: "simon", repo: "app" }, "asking");
keepState(db, { owner: "simon", repo: "app" }, "error");
keepState(db, { owner: "simon", repo: "app" }, "idle");`);
  expect(said).toEqual([
    { id: "fake-lead-app", status: "working", reason: "working" },
    { id: "fake-lead-app", status: "needs you", reason: "question" },
    { id: "fake-lead-app", status: "error", reason: "error" },
    { id: "fake-lead-app", status: "idle", reason: "idle" },
  ]);
});

test("removing a repository refuses while its lead's host plugin isn't installed, and keeps it", () => {
  const said = runWithFakeHost(
    "sessions",
    `const { removeRepo } = await import(${JSON.stringify(source("flow/repo.ts"))});
const { cloneDir } = await import(${JSON.stringify(source("paths.ts"))});
const fs = require("node:fs");
db.run("INSERT INTO repositories (name, owner, repo, remote, lead_host, lead_host_id) VALUES ('app', 'simon', 'app', '', 'gone', 'gone-1')");
db.run("DELETE FROM threads");
fs.mkdirSync(cloneDir("simon", "app"), { recursive: true });
console.log(await removeRepo("app", "unused").then(() => "removed", (error) => error.message));
const row = db.query("SELECT tab_closed FROM repositories WHERE repo = 'app'").get();
console.log(fs.existsSync(cloneDir("simon", "app")), row.tab_closed);`,
    {},
  );
  expect(said).toBe(
    "app's lead runs on gone, which isn't installed now, so it can't be ended. Install gone again, then remove app.\ntrue 0\n",
  );
});

test("a lead still starting on a slow host when its repository is removed is ended, not left running", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const { startLead } = await import(${JSON.stringify(source("flow/lead.ts"))});
const { removeRepo } = await import(${JSON.stringify(source("flow/repo.ts"))});
const { cloneDir } = await import(${JSON.stringify(source("paths.ts"))});
const { pluginHost } = await import(${JSON.stringify(source("plugins/runtime.ts"))});
const fs = require("node:fs");
fs.mkdirSync(${JSON.stringify(fake)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(home, ".config", "skelcrew", "config.yaml"))}, "harness: claude\\nsession: fake\\n");
fs.writeFileSync(${JSON.stringify(join(home, ".config", "skelcrew", "claude-token"))}, "sk-ant-oat01-good\\n");
db.run("INSERT INTO repositories (name, owner, repo, remote, opened) VALUES ('app', 'simon', 'app', '', 1)");
db.run("DELETE FROM threads");
fs.mkdirSync(cloneDir("simon", "app"), { recursive: true });
Bun.spawnSync(["git", "init", "-q", cloneDir("simon", "app")]);
const host = pluginHost(db, "fake");
// The host takes two seconds to start the lead, and the removal looks for it meanwhile.
fs.writeFileSync(${JSON.stringify(join(fake, "slow-start"))}, "");
const repository = { name: "app", owner: "simon", repo: "app", forge: null, remote: "" };
const starting = startLead(db, "unused", repository).then(() => "started", (error) => error.message);
await Bun.sleep(500);
await removeRepo("app", "unused");
console.log(await starting);
const sessions = await (await import(${JSON.stringify(source("agents/sessions.ts"))})).listSessions(host);
console.log(sessions.length);`,
    {},
  );
  expect(said).toBe(
    "Removed app and Skelcrew's clone of it.\nsimon/app was closed or removed while its lead started\n0\n",
  );
}, 20_000);

test("removing a repository whose lead's host fails keeps it, with its tab open", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const { removeRepo } = await import(${JSON.stringify(source("flow/repo.ts"))});
const { cloneDir } = await import(${JSON.stringify(source("paths.ts"))});
const fs = require("node:fs");
db.run("INSERT INTO repositories (name, owner, repo, remote, lead_host, lead_host_id) VALUES ('app', 'simon', 'app', '', 'fake', 'fake-lead-app')");
db.run("DELETE FROM threads");
fs.mkdirSync(cloneDir("simon", "app"), { recursive: true });
fs.mkdirSync(${JSON.stringify(fake)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(fake, "fail-list"))}, "");
console.log(await removeRepo("app", "unused").then(() => "removed", () => "refused"));
const row = db.query("SELECT tab_closed FROM repositories WHERE repo = 'app'").get();
console.log(fs.existsSync(cloneDir("simon", "app")), row.tab_closed);`,
    {},
  );
  expect(said).toBe("refused\ntrue 0\n");
});

test("removing a repository ends its lead on a plugin's host, found by its labels", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const { removeRepo } = await import(${JSON.stringify(source("flow/repo.ts"))});
const { pluginHost } = await import(${JSON.stringify(source("plugins/runtime.ts"))});
db.run("INSERT INTO repositories (name, owner, repo, remote, lead_host) VALUES ('app', 'simon', 'app', '', 'fake')");
const host = pluginHost(db, "fake");
await startSession(host, "lead-app", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "lead" } });
db.run("DELETE FROM threads");
await removeRepo("app", "unused");
console.log(await hasSession(host, "fake-lead-app"));`,
    {},
  );
  expect(said).toBe("Removed app and Skelcrew's clone of it.\nfalse\n");
  expect(readFileSync(join(fake, "asked"), "utf8")).toContain('"ask":"end"');
});

test("a builder that can't be ended keeps its host, and stopping it again tries again", () => {
  const said = runWithFakeHost(
    "sessions",
    `const thread = readThread(db, "app-12");
const error = await stopThread(db, "unused", thread).catch((error) => error.message);
console.log(error);
const after = readThread(db, "app-12");
console.log(after.status, after.host);
const again = await stopThread(db, "unused", after).catch((error) => error.message);
console.log(again);`,
    { host: "gone", host_id: "gone-app-12" },
  );
  // The thread stays as it was, with its host, so stopping it again tries again.
  const reason = "its builder's session host gone isn't installed any more";
  expect(said).toBe(`${reason}\nworking gone\n${reason}\n`);
});

test("a host that hangs on one status is ended, and hears the changes after it", () => {
  const settings = join(home, ".config", "skelcrew", "plugins", "fake");
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "hang-status"), "");
  const said = statusesAfter(`record(db, "app-12", { needs_you: true }, "a review failed");
record(db, "app-12", { needs_you: false });`);
  expect(said).toEqual([{ id: "fake-app-12", status: "working", reason: "working" }]);
}, 30_000);

// Labels the host gives back that Skelcrew can't read could be the lost builder's, so recovery
// fails rather than take the builder for gone and start a second one in the same clone.
test("a builder whose ID never got saved isn't taken for gone when its host garbles its labels", () => {
  const stored = join(home, ".config", "skelcrew", "plugins", "fake", "sessions", "fake-app-12");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "builder", task: "app-12" } });
fs.writeFileSync(${JSON.stringify(join(stored, "labels.json"))}, JSON.stringify({ repository: "simon/app", role: "boss" }));
console.log(await builderSession(db, "unused", readThread(db, "app-12")).then(() => "found", (error) => error.message));
console.log(readThread(db, "app-12").host_id);`,
    { host: "fake", host_id: null },
  );
  expect(said).toBe("fake answered list in a way Skelcrew doesn't understand\nnull\n");
});

test("recovery never takes the builder of a task whose ID only ends the same", () => {
  const said = runWithFakeHost(
    "sessions",
    `const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
await startSession(host, "app-other-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "builder", task: "app-other-12" } });
console.log((await builderSession(db, "unused", readThread(db, "app-12"))).id);
console.log(readThread(db, "app-12").host_id);`,
    { host: "fake", host_id: null },
  );
  expect(said).toBe("app-12\nnull\n");
});

test("a host that answers a delivery with nothing hasn't delivered it", async () => {
  const on = host({ transport: true });
  const id = await start(on, harness());
  await until(async () => (await readSession(on, id)).includes(claude.marks.prompt));
  writeFileSync(join(settings(), "garble-deliver"), "");
  const typing = deliver(on, id, claude.marks, "hello", { moment });
  await expect(typing).rejects.toThrow(
    `${name} answered deliver in a way Skelcrew doesn't understand`,
  );
});

test("a builder whose host started it but lost the answer is ended before the thread starts over", () => {
  const settings = join(home, ".config", "skelcrew", "plugins", "fake");
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "lose-start"), "");
  const said = runWithFakeHost(
    "sessions",
    `const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
const error = await (async () => { try { await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels }); } catch (error) { return error.message; } })();
console.log(error, await hasSession(host, "fake-app-12"));
await endEarlierBuilder(db, "unused", readThread(db, "app-12"));
console.log(await hasSession(host, "fake-app-12"), readThread(db, "app-12").host);`,
    { host: "fake", host_id: null, status: "failed" },
  );
  expect(said).toBe("fake couldn't start: lost the answer true\nfalse null\n");
});

test("a builder whose host fails to end it goes back to working, with its host", () => {
  const settings = join(home, ".config", "skelcrew", "plugins", "fake");
  mkdirSync(settings, { recursive: true });
  const said = runWithFakeHost(
    "sessions",
    `const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels });
require("node:fs").writeFileSync(${JSON.stringify(join(home, ".config", "skelcrew", "plugins", "fake", "garble-end"))}, "");
const error = await stopThread(db, "unused", readThread(db, "app-12")).catch((error) => error.message);
const after = readThread(db, "app-12");
console.log(error);
console.log(after.status, after.host, after.host_id, await hasSession(host, "fake-app-12"));`,
    { host: "fake", host_id: "fake-app-12" },
  );
  expect(said).toBe(
    "fake answered end in a way Skelcrew doesn't understand\nworking fake fake-app-12 true\n",
  );
});

// Both a stop and an end a poll asks for, such as for a merge, cancel the wake as they start.
for (const [by, ending] of [
  ["a stop", `stopThread(db, "unused", readThread(db, "app-12"))`],
  ["a merge's end", `endThread(db, "unused", readThread(db, "app-12"), "its PR was merged", null)`],
]) {
  test(`a builder on its usage limit is still woken after ${by} that failed`, () => {
    const prompt = join(home, "prompt.sh");
    writeFileSync(prompt, `#!/bin/sh\necho "${claude.marks.prompt}"\ncat > received.txt\n`, {
      mode: 0o755,
    });
    const said = runWithFakeHost(
      "sessions",
      `const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [${JSON.stringify(prompt)}], env: { PATH: process.env.PATH }, labels });
require("node:fs").writeFileSync(${JSON.stringify(join(home, ".config", "skelcrew", "plugins", "fake", "garble-end"))}, "");
console.log(await ${ending}.catch((error) => error.message));
const received = ${JSON.stringify(join(home, "received.txt"))};
const fs = require("node:fs");
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && !(fs.existsSync(received) && fs.readFileSync(received, "utf8").endsWith("\\n"))) await Bun.sleep(100);
console.log(JSON.stringify(fs.existsSync(received) ? fs.readFileSync(received, "utf8") : ""));
process.exit(0);`,
      { host: "fake", host_id: "fake-app-12", erred: 1, limited: 1, limit_reset: 1 },
    );
    expect(said).toBe(
      `fake answered end in a way Skelcrew doesn't understand\n${JSON.stringify("\x1b[200~continue\x1b[201~\n")}\n`,
    );
  }, 40_000);
}

test("a message a host answers with nothing stays queued, and goes in on the next try", () => {
  const prompt = join(home, "prompt.sh");
  writeFileSync(prompt, `#!/bin/sh\necho "${claude.marks.prompt}"\ncat > received.txt\n`, {
    mode: 0o755,
  });
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions, transport",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [${JSON.stringify(prompt)}], env: { PATH: process.env.PATH }, labels });
const waiting = () => db.query("SELECT COUNT(*) AS n FROM messages").get().n;
const asked = () => fs.existsSync(${JSON.stringify(join(fake, "asked"))}) ? fs.readFileSync(${JSON.stringify(join(fake, "asked"))}, "utf8") : "";
const until = async (done) => { const deadline = Date.now() + 15_000; while (!done() && Date.now() < deadline) await Bun.sleep(50); };
await until(() => asked().includes('"start"'));
fs.writeFileSync(${JSON.stringify(join(fake, "garble-deliver"))}, "");
queueMessage(db, "unused", "app-12", { sender: "lead", text: "hello", said: "hello", typed_in: [] });
await until(() => asked().includes('"deliver"'));
await Bun.sleep(500);
console.log(waiting(), fs.existsSync(${JSON.stringify(join(home, "received.txt"))}) ? fs.readFileSync(${JSON.stringify(join(home, "received.txt"))}, "utf8").length : 0);
fs.rmSync(${JSON.stringify(join(fake, "garble-deliver"))});
deliverMessages(db, "unused", "app-12");
await until(() => waiting() === 0);
const received = ${JSON.stringify(join(home, "received.txt"))};
await until(() => fs.readFileSync(received, "utf8").endsWith("\\n"));
console.log(waiting(), JSON.stringify(fs.readFileSync(received, "utf8")));
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  // The failed try is logged, and the message waits, with nothing typed in.
  const failed = `couldn't type into app-12's builder: fake answered deliver in a way Skelcrew doesn't understand`;
  expect(said).toBe(`${failed}\n1 0\n0 ${JSON.stringify("\x1b[200~hello\x1b[201~\n")}\n`);
}, 40_000);

test("a status a host failed to hear is told again, so it doesn't stay stale", () => {
  const settings = join(home, ".config", "skelcrew", "plugins", "fake");
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "fail-status"), "");
  const said = statusesAfter(`record(db, "app-12", { needs_you: true }, "a review failed");`);
  expect(said).toEqual([{ id: "fake-app-12", status: "needs you", reason: "needs you" }]);
}, 30_000);

test("a builder that can't be ended keeps its waiting messages when its thread ends", () => {
  const said = runWithFakeHost(
    "sessions",
    `queueMessage(db, "unused", "app-12", { sender: "lead", text: "hello", said: "hello", typed_in: [] });
const thread = readThread(db, "app-12");
console.log(await endThread(db, "unused", thread, "its PR was merged", null).catch((error) => error.message));
const after = readThread(db, "app-12");
console.log(after.status, db.query("SELECT COUNT(*) AS n FROM messages").get().n);
process.exit(0);`,
    { host: "gone", host_id: "gone-app-12" },
  );
  expect(said).toBe("its builder's session host gone isn't installed any more\nworking 1\n");
});

test("a host that never answers holds up neither the daemon nor the agents on another host", () => {
  const prompt = join(home, "prompt.sh");
  writeFileSync(prompt, `#!/bin/sh\necho "${claude.marks.prompt}"\ncat > received.txt\n`, {
    mode: 0o755,
  });
  // A host named stuck whose every answer waits until the test lets it go.
  const stuck = join(home, "plugin-stuck");
  const held = join(home, "held");
  mkdirSync(stuck, { recursive: true });
  writeFileSync(held, "");
  writeFileSync(
    join(stuck, "skelcrew-plugin.yaml"),
    `name: stuck
version: 0.1.0
skelcrew: 0.1.0
about: A host that never answers
kind: runtime
provides: [sessions]
session: [sh, -c, ${JSON.stringify(`while [ -e ${held} ]; do sleep 0.1; done`)}]
attach: ["true"]
`,
  );
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
db.run("INSERT INTO plugins (name, folder) VALUES ('stuck', ?)", [${JSON.stringify(stuck)}]);
db.exec(${JSON.stringify(threadSql({ task: "13", host: "stuck", host_id: "stuck-app-13", state: "working" }))});
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [${JSON.stringify(prompt)}], env: { PATH: process.env.PATH }, labels });
// Looks every two seconds, as the daemon does, and notes how long each pass held it up.
let slowest = 0;
const deadline = Date.now() + 20_000;
while (readThread(db, "app-12").state === "working" && Date.now() < deadline) {
  const started = Date.now();
  noticeIdleScreens(db, "unused");
  slowest = Math.max(slowest, Date.now() - started);
  await Bun.sleep(2000);
}
console.log(readThread(db, "app-12").state, readThread(db, "app-13").state, slowest < 500);
fs.rmSync(${JSON.stringify(held)});
await Bun.sleep(500);
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12", state: "working" },
  );
  // Let go at last, the stuck host's look ends with nothing understood, which is only logged.
  const released =
    "couldn't look at stuck-app-13's screen: stuck answered list in a way Skelcrew doesn't understand";
  expect(said).toBe(`idle working true\n${released}\n`);
}, 40_000);

// A host can fail the Enter after the paste went in, which leaves the message at the prompt. It
// is known as the message's own draft, not a person's, so the next attempt sends it with Enter
// alone, once, instead of waiting behind it forever.
test("a message whose Enter the host failed is sent by the next attempt, once", () => {
  const agent = join(home, "agent.ts");
  // Shows the prompt, bare or with what was pasted at it, and logs each line sent.
  writeFileSync(
    agent,
    `const fs = require("node:fs");
let draft = "";
const show = () => process.stdout.write("\\x1b[2J${claude.marks.prompt}" + (draft ? " " + draft : "") + "\\n");
show();
for await (const chunk of Bun.stdin.stream()) {
  for (const key of new TextDecoder().decode(chunk).replace(/\\x1b\\[20[01]~/g, "")) {
    if (key === "\\n") {
      fs.appendFileSync("received.txt", draft + "\\n");
      draft = "";
    } else draft += key;
  }
  show();
}
`,
  );
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const received = join(home, "received.txt");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [process.execPath, ${JSON.stringify(agent)}], env: { PATH: process.env.PATH }, labels });
const typed = () => fs.existsSync(${JSON.stringify(received)}) ? fs.readFileSync(${JSON.stringify(received)}, "utf8") : "";
const row = () => db.query("SELECT COUNT(*) AS n, MAX(pasted) AS pasted FROM messages").get();
db.run("INSERT INTO messages (folder, sender, text, said, at, typed_in) VALUES ('app-12', 'lead', 'hello', 'hello', 0, '[]')");
// The host fails the next keys it is asked to press, which is the message's Enter.
fs.writeFileSync(${JSON.stringify(join(fake, "fail-keys"))}, "");
await deliverMessages(db, "unused", "app-12");
console.log(JSON.stringify(row()), JSON.stringify(typed()));
await deliverMessages(db, "unused", "app-12");
console.log(JSON.stringify(row()), JSON.stringify(typed()));
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  // The failed Enter is logged, and the message stays, marked as pasted.
  expect(said).toBe(
    `couldn't type into app-12's builder: fake couldn't keys: the host is down for a moment
{"n":1,"pasted":1} ""
{"n":0,"pasted":null} ${JSON.stringify("hello\n")}
`,
  );
}, 40_000);

// A new round drops Skelcrew's old notices, but one whose paste is already on its way to the host
// may land, so it is kept until that typing ends. Its Enter failing then leaves it known as the
// draft at the prompt, and the next attempt sends it, rather than wait behind it forever.
test("a notice whose paste is on its way when a new round drops it is kept, and sent", () => {
  const agent = join(home, "agent.ts");
  // Shows the prompt, bare or with what was pasted at it, and logs each line sent.
  writeFileSync(
    agent,
    `const fs = require("node:fs");
let draft = "";
const show = () => process.stdout.write("\\x1b[2J${claude.marks.prompt}" + (draft ? " " + draft : "") + "\\n");
show();
for await (const chunk of Bun.stdin.stream()) {
  for (const key of new TextDecoder().decode(chunk).replace(/\\x1b\\[20[01]~/g, "")) {
    if (key === "\\n") {
      fs.appendFileSync("received.txt", draft + "\\n");
      draft = "";
    } else draft += key;
  }
  show();
}
`,
  );
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const received = join(home, "received.txt");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [process.execPath, ${JSON.stringify(agent)}], env: { PATH: process.env.PATH }, labels });
const typed = () => fs.existsSync(${JSON.stringify(received)}) ? fs.readFileSync(${JSON.stringify(received)}, "utf8") : "";
const rows = () => JSON.stringify(db.query("SELECT text, pasted FROM messages ORDER BY id").all());
db.run("INSERT INTO messages (folder, sender, text, said, at, typed_in) VALUES ('app-12', 'skelcrew', 'old', 'old', 0, '[]')");
// The host takes two seconds over the paste, then fails the Enter after it.
fs.writeFileSync(${JSON.stringify(join(fake, "slow-paste"))}, "");
fs.writeFileSync(${JSON.stringify(join(fake, "fail-keys"))}, "");
const asked = () => fs.readFileSync(${JSON.stringify(join(fake, "asked"))}, "utf8");
const typing = deliverMessages(db, "unused", "app-12");
while (!asked().includes('"ask":"paste"')) await Bun.sleep(20);
// A notice of the new round is saved after the drop, and the drop leaves it alone.
const { dropped, later } = dropOldEvents(db, "unused", "app-12");
db.run("INSERT INTO messages (folder, sender, text, said, at, typed_in) VALUES ('app-12', 'skelcrew', 'new', 'new', 0, '[]')");
console.log(JSON.stringify(dropped), rows());
await typing;
console.log(JSON.stringify(await later), rows());
const deadline = Date.now() + 15_000;
while (typed() !== "old\\nnew\\n" && Date.now() < deadline) await deliverMessages(db, "unused", "app-12");
console.log(JSON.stringify(typed()), rows());
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  const both = `[{"text":"old","pasted":0},{"text":"new","pasted":0}]`;
  expect(said).toBe(
    `[] ${both}
couldn't type into app-12's builder: fake couldn't keys: the host is down for a moment
[] [{"text":"old","pasted":1},{"text":"new","pasted":0}]
${JSON.stringify("old\nnew\n")} []
`,
  );
}, 40_000);

// A merge can end the thread while a stop waits its turn to end the builder. The stop then says
// the thread is done, rather than mark it stopped as if sc start could bring its work back.
test("a stop that waits on a merge's end of the builder leaves the thread done", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels });
// The host takes two seconds to end the builder, so the stop comes while the merge's end runs.
fs.writeFileSync(${JSON.stringify(join(fake, "slow-end"))}, "");
const merge = endThread(db, "unused", readThread(db, "app-12"), "its PR was merged", null, true);
await Bun.sleep(500);
const stop = stopThread(db, "unused", readThread(db, "app-12")).then(() => "stopped", (error) => error.message);
await merge;
console.log(await stop);
console.log(readThread(db, "app-12").status);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  expect(said).toBe("SIMON/APP-12 is done already\ndone\n");
}, 40_000);

// A host that can't be reached as the daemon starts may still run the builder, so the daemon asks
// it again rather than fail the thread or start a second builder.
test("a builder whose host fails as the daemon starts is found once the host answers", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels });
// The host fails the next list it is asked for, once.
fs.writeFileSync(${JSON.stringify(join(fake, "fail-list"))}, "");
const back = await bringBack(db, "unused", readThread(db, "app-12")).then(() => "back", (error) => error.message);
const thread = readThread(db, "app-12");
const starts = fs.readFileSync(${JSON.stringify(join(fake, "asked"))}, "utf8").split("\\n").filter((line) => line.includes('"ask":"start"'));
console.log(back, thread.status, thread.host_id, starts.length);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  expect(said).toBe("back working fake-app-12 1\n");
}, 40_000);

// A plugin whose manifest went missing can't hear a status, but every change to a thread reports
// one, the daemon's start included, so it is logged once rather than thrown.
test("a change to a thread on a plugin whose manifest is gone is still saved", () => {
  const manifest = join(home, "plugin-fake", "skelcrew-plugin.yaml");
  const said = runWithFakeHost(
    "sessions, status",
    `require("node:fs").rmSync(${JSON.stringify(manifest)});
record(db, "app-12", { needs_you: true }, "a review failed");
record(db, "app-12", { needs_you: false });
console.log(readThread(db, "app-12").needs_you);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  expect(said).toStartWith("the runtime plugin fake can't be used: ");
  expect(said.split("\n").slice(1)).toEqual(["false", ""]);
});

test("nothing is typed into a builder while a slow host fails to end it, and its messages wait", () => {
  const prompt = join(home, "prompt.sh");
  writeFileSync(prompt, `#!/bin/sh\necho "${claude.marks.prompt}"\ncat > received.txt\n`, {
    mode: 0o755,
  });
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const received = join(home, "received.txt");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [${JSON.stringify(prompt)}], env: { PATH: process.env.PATH }, labels });
const waiting = () => db.query("SELECT COUNT(*) AS n FROM messages").get().n;
const typed = () => fs.existsSync(${JSON.stringify(received)}) ? fs.readFileSync(${JSON.stringify(received)}, "utf8") : "";
// The host takes two seconds to end it, then fails.
fs.writeFileSync(${JSON.stringify(join(fake, "slow-end"))}, "");
fs.writeFileSync(${JSON.stringify(join(fake, "fail-end"))}, "");
db.run("INSERT INTO messages (folder, sender, text, said, at, typed_in) VALUES ('app-12', 'lead', 'hello', 'hello', 0, '[]')");
const ending = endThread(db, "unused", readThread(db, "app-12"), "its PR was merged", null).catch((error) => error.message);
// The daemon tries to type waiting messages every two seconds, here more often.
let done = false;
ending.then(() => (done = true));
while (!done) {
  deliverMessages(db, "unused", "app-12");
  await Bun.sleep(100);
}
console.log(await ending);
console.log(waiting(), JSON.stringify(typed()));
fs.rmSync(${JSON.stringify(join(fake, "slow-end"))});
// Once the end failed, typing goes on as before.
deliverMessages(db, "unused", "app-12");
const deadline = Date.now() + 15_000;
// The message is deleted once the host has answered its Enter, a moment after the agent got it.
while ((!typed().endsWith("\\n") || waiting() !== 0) && Date.now() < deadline) await Bun.sleep(100);
console.log(waiting(), JSON.stringify(typed()));
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  expect(said).toBe(
    `fake couldn't end: the host is down for a moment\n1 ""\n0 ${JSON.stringify("\x1b[200~hello\x1b[201~\n")}\n`,
  );
}, 40_000);

test("a screen look the host answered late doesn't count once a new turn has started", () => {
  const prompt = join(home, "prompt.sh");
  writeFileSync(prompt, `#!/bin/sh\necho "${claude.marks.prompt}"\ncat > received.txt\n`, {
    mode: 0o755,
  });
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [${JSON.stringify(prompt)}], env: { PATH: process.env.PATH }, labels });
// The host takes two seconds over each read of the screen.
fs.writeFileSync(${JSON.stringify(join(fake, "slow-read"))}, "");
const state = () => readThread(db, "app-12").state;
// A look starts, and a new turn starts while the host is still reading the screen.
noticeIdleScreens(db, "unused");
await Bun.sleep(500);
keepState(db, { folder: "app-12" }, "working");
await Bun.sleep(2500);
// Only a second look of the new turn may make it idle.
noticeIdleScreens(db, "unused");
await Bun.sleep(2500);
const afterOne = state();
noticeIdleScreens(db, "unused");
await Bun.sleep(2500);
console.log(afterOne, state());
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12", state: "working" },
  );
  expect(said).toBe("working idle\n");
}, 40_000);

test("a builder sc rm can't end stays working, with its host and its waiting messages", () => {
  const said = runWithFakeHost(
    "sessions",
    `db.run("INSERT INTO messages (folder, sender, text, said, at, typed_in) VALUES ('app-12', 'lead', 'hello', 'hello', 0, '[]')");
console.log(await removeThread(db, "unused", readThread(db, "app-12"), undefined, true).catch((error) => error.message));
const after = readThread(db, "app-12");
console.log(after.status, after.host, db.query("SELECT COUNT(*) AS n FROM messages").get().n);
process.exit(0);`,
    { host: "gone", host_id: "gone-app-12" },
  );
  expect(said).toBe("its builder's session host gone isn't installed any more\nworking gone 1\n");
});

test("an end that starts while a message is being typed waits for its Enter first", () => {
  const prompt = join(home, "prompt.sh");
  writeFileSync(prompt, `#!/bin/sh\necho "${claude.marks.prompt}"\ncat > received.txt\n`, {
    mode: 0o755,
  });
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [${JSON.stringify(prompt)}], env: { PATH: process.env.PATH }, labels });
const asked = () => fs.readFileSync(${JSON.stringify(join(fake, "asked"))}, "utf8").trim().split("\\n").map((line) => JSON.parse(line).ask);
db.run("INSERT INTO messages (folder, sender, text, said, at, typed_in) VALUES ('app-12', 'lead', 'hello', 'hello', 0, '[]')");
deliverMessages(db, "unused", "app-12");
// The end starts the moment the message is pasted, before its Enter.
const deadline = Date.now() + 15_000;
while (!asked().includes("paste") && Date.now() < deadline) await Bun.sleep(5);
await endThread(db, "unused", readThread(db, "app-12"), "its PR was merged", null);
const order = asked().filter((ask) => ask === "paste" || ask === "keys" || ask === "end");
console.log(order.join(" "));
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  expect(said).toBe("paste keys end\n");
}, 40_000);

test("a second stop while one is under way joins it, and a restart after keeps its builder", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const { record } = await import(${JSON.stringify(source("flow/thread.ts"))});
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
const run = () => startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels });
await run();
// The host takes two seconds to end it.
fs.writeFileSync(${JSON.stringify(join(fake, "slow-end"))}, "");
const first = stopThread(db, "unused", readThread(db, "app-12")).then(() => "stopped", (error) => error.message);
const second = await stopThread(db, "unused", readThread(db, "app-12")).then(() => "stopped", (error) => error.message);
console.log(second);
console.log(await first);
console.log(fs.readFileSync(${JSON.stringify(join(fake, "asked"))}, "utf8").split("\\n").filter((line) => line.includes('"end"')).length);
// It starts again on the host, and nothing of the stops changes it after.
fs.rmSync(${JSON.stringify(join(fake, "slow-end"))});
const id = await run();
record(db, "app-12", { status: "working", host: "fake", host_id: id });
await Bun.sleep(2500);
const after = readThread(db, "app-12");
console.log(after.status, after.host, await hasSession(host, id));
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  // The host was asked to end it once, and both stops say it stopped.
  expect(said).toBe("stopped\nstopped\n1\nworking fake true\n");
}, 40_000);

test("a question asked while the host is still on the last look before a paste stops the paste", async () => {
  const on = host();
  const id = await start(on, harness());
  await until(async () => (await readSession(on, id)).includes(claude.marks.prompt));
  // Two looks find it idle, and the host holds the third, the last before the paste.
  const before = asked().filter((ask) => ask === "read").length;
  writeFileSync(join(settings(), "hold-read"), String(before + 3));
  const cancel = new AbortController();
  const typing = deliver(on, id, claude.marks, "hello", { moment, signal: cancel.signal });
  await until(() => asked().filter((ask) => ask === "read").length === before + 3);
  cancel.abort(forQuestion);
  rmSync(join(settings(), "hold-read"));
  expect(await typing).toBe("not typed");
  expect(asked()).not.toContain("paste");
  expect(read("received.txt")).toBe("");
});

test("a builder started while a slow stop ends the one before keeps its host, and its thread runs", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const { record } = await import(${JSON.stringify(source("flow/thread.ts"))});
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels });
fs.writeFileSync(${JSON.stringify(join(fake, "slow-end"))}, "");
const stopped = stopThread(db, "unused", readThread(db, "app-12"));
// A new builder's session is saved while the host still ends the old one.
await Bun.sleep(500);
record(db, "app-12", { host_id: "fake-new" });
await stopped;
const after = readThread(db, "app-12");
console.log(after.status, after.host, after.host_id);
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12" },
  );
  expect(said).toBe("working fake fake-new\n");
}, 40_000);

test("a stop that comes while the host is still starting the builder ends the builder it starts", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
// The host takes two seconds to start the builder, and the stop comes meanwhile.
fs.writeFileSync(${JSON.stringify(join(fake, "slow-start"))}, "");
const starting = startOnHost(db, readThread(db, "app-12"), { host, name: "fake" }, { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {} });
await Bun.sleep(500);
console.log(await stopThread(db, "unused", readThread(db, "app-12")).then(() => "stopped", (error) => error.message));
await starting;
const after = readThread(db, "app-12");
const asked = fs.readFileSync(${JSON.stringify(join(fake, "asked"))}, "utf8").trim().split("\\n").map((line) => JSON.parse(line).ask);
console.log(after.status, after.host, asked.filter((ask) => ask === "start" || ask === "end").join(" "), await hasSession(host, "fake-app-12"));
process.exit(0);`,
    { host: "fake", host_id: null },
  );
  // The stop waited for the start, ended what it started, and left nothing running.
  expect(said).toBe("stopped\nstopped null start end false\n");
}, 40_000);

test("a builder found on its host by its labels is stopped, and its thread marked stopped", () => {
  const said = runWithFakeHost(
    "sessions",
    `const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels });
console.log(await stopThread(db, "unused", readThread(db, "app-12")).then(() => "stopped", (error) => error.message));
const after = readThread(db, "app-12");
console.log(after.status, after.host, after.host_id, await hasSession(host, "fake-app-12"));
process.exit(0);`,
    { host: "fake", host_id: null },
  );
  expect(said).toBe("stopped\nstopped null null false\n");
});

test("a stop while a wake types continue waits for its Enter before the host ends the builder", () => {
  const prompt = join(home, "prompt.sh");
  writeFileSync(prompt, `#!/bin/sh\necho "${claude.marks.prompt}"\ncat > received.txt\n`, {
    mode: 0o755,
  });
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [${JSON.stringify(prompt)}], env: { PATH: process.env.PATH }, labels });
const asked = () => fs.readFileSync(${JSON.stringify(join(fake, "asked"))}, "utf8").trim().split("\\n").map((line) => JSON.parse(line).ask);
// The limit reset long ago, so the wake types continue at once, and the stop comes as it pastes.
wakeAfterLimit(db, "unused", "app-12");
const deadline = Date.now() + 15_000;
while (!asked().includes("paste") && Date.now() < deadline) await Bun.sleep(5);
await stopThread(db, "unused", readThread(db, "app-12"));
console.log(asked().filter((ask) => ask === "paste" || ask === "keys" || ask === "end").join(" "));
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12", erred: 1, limited: 1, limit_reset: 1 },
  );
  expect(said).toBe("paste keys end\n");
}, 40_000);

test("a wake a failed stop cut short leaves the builder at its usage limit, as it was", () => {
  // A builder busy for a while, so the wake waits to type continue when the stop comes.
  const busy = join(home, "busy.sh");
  writeFileSync(busy, `#!/bin/sh\necho "Thinking (${claude.marks.busy})"\nexec sleep 30\n`, {
    mode: 0o755,
  });
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: [${JSON.stringify(busy)}], env: { PATH: process.env.PATH }, labels });
wakeAfterLimit(db, "unused", "app-12");
// The wake has cleared the limit and waits for the builder to be idle.
const deadline = Date.now() + 15_000;
while (readThread(db, "app-12").limited && Date.now() < deadline) await Bun.sleep(20);
fs.writeFileSync(${JSON.stringify(join(fake, "garble-end"))}, "");
console.log(await stopThread(db, "unused", readThread(db, "app-12")).catch((error) => error.message));
const after = readThread(db, "app-12");
console.log(after.status, after.erred, after.limited, after.limit_reset);
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12", erred: 1, limited: 1, limit_reset: 1 },
  );
  expect(said).toBe(
    "fake answered end in a way Skelcrew doesn't understand\nworking true true 1\n",
  );
}, 40_000);

// The last is a row from before Skelcrew saved a thread's title, which takes the issue's from
// Skelcrew's copy of the tracker.
for (const [short, title, saved] of [
  ["login redirect", "login redirect", "Fix the login redirect"],
  [null, "Fix the login redirect", "Fix the login redirect"],
  [null, "Fix the login redirect", null],
] as const)
  test(`a builder's session is labelled with its short title, else its full title: ${title}, saved ${saved}`, () => {
    const fake = join(home, ".config", "skelcrew", "plugins", "fake");
    const labels = runWithFakeHost(
      "sessions",
      `const issue = { kind: "task", id: "12", title: "Fix the login redirect", body: "", state: "open", author: null, labels: [], link: "https://github.com/simon/app/issues/12", created: "2026-11-18T00:00:00Z", updated: "2026-11-18T00:00:00Z", closes: "Closes #12" };
db.run("INSERT INTO items (owner, repo, kind, id, state, created, item) VALUES ('simon', 'app', 'task', '12', 'open', '2026-11-18T00:00:00Z', ?)", [JSON.stringify(issue)]);
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
await startOnHost(db, readThread(db, "app-12"), { host, name: "fake" }, { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {} });
console.log(require("node:fs").readFileSync(${JSON.stringify(join(fake, "sessions", "fake-app-12", "labels.json"))}, "utf8"));
process.exit(0);`,
      { host: "fake", host_id: null, title: saved, short },
    );
    expect(JSON.parse(labels).title).toBe(title);
  }, 40_000);

test("a new short title on a running builder reaches its host as a rename", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  runWithFakeHost(
    "sessions",
    `record(db, "app-12", { short: "login redirect" }, "given a short title");
record(db, "app-12", { rounds: 1 });
await Bun.sleep(1000);`,
    { host: "fake", host_id: "fake-app-12", title: "Fix the login redirect" },
  );
  const renames = readFileSync(join(fake, "asked"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((question) => question.ask === "rename");
  // Only the change of title renames it, not every change to the thread.
  expect(renames).toEqual([{ ask: "rename", id: "fake-app-12", title: "login redirect" }]);
}, 40_000);

test("a short title given while the host starts the builder still reaches the host", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
// The host takes two seconds to start the builder, and the short title comes meanwhile.
fs.writeFileSync(${JSON.stringify(join(fake, "slow-start"))}, "");
const starting = startOnHost(db, readThread(db, "app-12"), { host, name: "fake" }, { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {} });
await Bun.sleep(500);
record(db, "app-12", { short: "login redirect" }, "given a short title");
await starting;
await Bun.sleep(1500);
process.exit(0);`,
    { host: "fake", host_id: null, title: "Fix the login redirect" },
  );
  const renames = readFileSync(join(fake, "asked"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((question) => question.ask === "rename");
  expect(renames).toEqual([{ ask: "rename", id: "fake-app-12", title: "login redirect" }]);
}, 40_000);

test("renames reach the host one at a time, and the last says the latest title", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const fs = require("node:fs");
const asked = () => fs.readFileSync(${JSON.stringify(join(fake, "asked"))}, "utf8").trim().split("\\n").map((line) => JSON.parse(line)).filter((q) => q.ask === "rename");
const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "builder", task: "app-12" } });
// The host holds every rename until the file goes.
fs.writeFileSync(${JSON.stringify(join(fake, "hold-rename"))}, "1");
record(db, "app-12", { short: "first" });
await Bun.sleep(300);
record(db, "app-12", { short: "second" });
await Bun.sleep(1000);
console.log(asked().length);
fs.rmSync(${JSON.stringify(join(fake, "hold-rename"))});
await Bun.sleep(1500);
console.log(asked().map((q) => q.title).join(" "));
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12", title: "Fix the login redirect" },
  );
  // The second waited for the first to finish, so the host ends on the latest title.
  expect(said).toBe("1\nfirst second\n");
}, 40_000);

test("a rename the host does but answers with nothing counts as done", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  const said = runWithFakeHost(
    "sessions",
    `const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "builder", task: "app-12", title: "Fix the login redirect" } });
record(db, "app-12", { short: "login redirect" });
await Bun.sleep(1000);
process.exit(0);`,
    { host: "fake", host_id: "fake-app-12", title: "Fix the login redirect" },
  );
  const labels = readFileSync(join(fake, "sessions", "fake-app-12", "labels.json"), "utf8");
  expect(JSON.parse(labels).title).toBe("login redirect");
  expect(said).not.toContain("couldn't rename");
}, 40_000);

test("a builder found on its host after a restart is renamed if its title changed meanwhile", () => {
  const fake = join(home, ".config", "skelcrew", "plugins", "fake");
  runWithFakeHost(
    "sessions",
    `const host = (await builderSession(db, "unused", readThread(db, "app-12"))).host;
// The host started the builder under its old title, and the daemon stopped before saving its ID.
await startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "builder", task: "app-12", title: "Fix the login redirect" } });
record(db, "app-12", { short: "login redirect" });
await builderSession(db, "unused", readThread(db, "app-12"));
await Bun.sleep(1000);
process.exit(0);`,
    { host: "fake", host_id: null, title: "Fix the login redirect" },
  );
  const labels = readFileSync(join(fake, "sessions", "fake-app-12", "labels.json"), "utf8");
  expect(JSON.parse(labels).title).toBe("login redirect");
}, 40_000);
