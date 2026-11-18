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
import { deliver, idle, whyBusy } from "../src/agents/transport.ts";
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

const until = (done: () => boolean) => wait(done, { timeout: 30_000, every: 20 });
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
  const id = start(on, ["sh", "-c", 'pwd; echo $PATH; [ -n "$HOME" ] || echo no home; sleep 30']);
  expect(id).toBe("fake-app-12");
  await until(() => readSession(on, id).includes("no home"));
  expect(readSession(on, id)).toBe(`${home}\n${process.env.PATH}\nno home\n`);
  expect(listSessions(on)).toEqual([{ name: id, running: true, labels }]);
  expect(hasSession(on, id)).toBe(true);
  expect(agentRuns(on, id)).toBe(true);
});

test("an agent that ended is no longer running, and its last screen says why", async () => {
  const on = host();
  const id = start(on, ["sh", "-c", "echo not logged in; exit 1"]);
  await until(() => !agentRuns(on, id));
  expect(hasSession(on, id)).toBe(true);
  expect(failedScreen(on, id)).toBe("not logged in");
});

test("stopping a session ends its process and the host forgets it", async () => {
  const on = host();
  const id = start(on, ["sleep", "30"]);
  const pid = Number(readFileSync(join(settings(), "sessions", id, "pid"), "utf8"));
  await stopSession(on, id);
  expect(hasSession(on, id)).toBe(false);
  expect(stillRunning([pid])).toEqual([]);
  // Stopping one that is gone does nothing.
  await stopSession(on, id);
});

test("interrupting a session sends its agent Esc", async () => {
  const on = host();
  const id = start(on, ["sh", "-c", "echo ready; exec cat > keys.txt"]);
  await until(() => readSession(on, id).includes("ready"));
  interruptSession(on, id);
  await until(() => read("keys.txt") === "\x1b");
});

test("with sessions only, the built-in transport types through the host's paste and keys", async () => {
  const on = host();
  const id = start(on, harness(1));
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
  const id = start(on, harness(30));
  await until(() => readSession(on, id).includes(claude.marks.busy));
  expect(await whyBusy(on, id, claude.marks, { moment })).toContain(claude.marks.busy);
  const typing = deliver(on, id, claude.marks, "hello", { moment, timeout: 500 });
  await expect(typing).rejects.toThrow(claude.marks.busy);
  expect(read("lost.txt")).toBe("");
});

test("a host with its own transport says when its agent is idle and delivers itself", async () => {
  const on = host({ transport: true });
  const id = start(on, harness(1));
  await until(() => readSession(on, id).includes(claude.marks.busy));
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
  const id = start(on, harness(2));
  await until(() => readSession(on, id).includes(claude.marks.busy));
  const cancel = new AbortController();
  const typing = deliver(on, id, claude.marks, "stale", { moment, signal: cancel.signal });
  await until(() => asked().includes("deliver"));
  cancel.abort();
  expect(await typing).toBe("not typed");
  await deliver(on, id, claude.marks, "fresh", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~fresh\x1b[201~\n");
});

test("a host that fails says what failed, naming the plugin", () => {
  const on = host();
  mkdirSync(join(settings(), "sessions", "fake-app-12"), { recursive: true });
  expect(() => readSession(on, "fake-app-12")).toThrow(`${name} couldn't read`);
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
function runWithFakeHost(provides: string, code: string, row: Record<string, string | null>) {
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
import { stopThread } from ${JSON.stringify(source("flow/events.ts"))};
import { hasSession, startSession } from ${JSON.stringify(source("agents/sessions.ts"))};
import { endEarlierBuilder } from ${JSON.stringify(source("flow/builder.ts"))};
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
    `const host = builderSession(db, "unused", readThread(db, "app-12")).host;
startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "builder", task: "app-12" } });
console.log(builderSession(db, "unused", readThread(db, "app-12")).id);
console.log(readThread(db, "app-12").host_id);`,
    { host: "fake", host_id: null },
  );
  expect(said).toBe("fake-app-12\nfake-app-12\n");
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
  // Stopping again tries again, rather than taking the thread for stopped already.
  const reason = "its builder's session host gone isn't installed any more";
  expect(said).toBe(`${reason}\nstopped gone\n${reason}\n`);
});

test("a host that hangs on one status is ended, and hears the changes after it", () => {
  const settings = join(home, ".config", "skelcrew", "plugins", "fake");
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "hang-status"), "");
  const said = statusesAfter(`record(db, "app-12", { needs_you: true }, "a review failed");
record(db, "app-12", { needs_you: false });`);
  expect(said).toEqual([{ id: "fake-app-12", status: "working", reason: "working" }]);
}, 30_000);

test("recovery never takes the builder of a task whose ID only ends the same", () => {
  const said = runWithFakeHost(
    "sessions",
    `const host = builderSession(db, "unused", readThread(db, "app-12")).host;
startSession(host, "app-other-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels: { repository: "simon/app", role: "builder", task: "app-other-12" } });
console.log(builderSession(db, "unused", readThread(db, "app-12")).id);
console.log(readThread(db, "app-12").host_id);`,
    { host: "fake", host_id: null },
  );
  expect(said).toBe("app-12\nnull\n");
});

test("a host that answers a delivery with nothing hasn't delivered it", async () => {
  const on = host({ transport: true });
  const id = start(on, harness());
  await until(() => readSession(on, id).includes(claude.marks.prompt));
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
    `const host = builderSession(db, "unused", readThread(db, "app-12")).host;
const labels = { repository: "simon/app", role: "builder", task: "app-12" };
const error = (() => { try { startSession(host, "app-12", { folder: ${JSON.stringify(home)}, command: ["sleep", "30"], env: {}, labels }); } catch (error) { return error.message; } })();
console.log(error, hasSession(host, "fake-app-12"));
await endEarlierBuilder(db, "unused", readThread(db, "app-12"));
console.log(hasSession(host, "fake-app-12"), readThread(db, "app-12").host);`,
    { host: "fake", host_id: null, status: "failed" },
  );
  expect(said).toBe("fake couldn't start: lost the answer true\nfalse null\n");
});
