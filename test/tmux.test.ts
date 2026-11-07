// skel's tmux sessions, against a fake harness on a tmux server of the test's own.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  endSession,
  hasSession,
  isIdle,
  startSession,
  stillRunning,
  stopSession,
  typeInto,
} from "../src/tmux.ts";
import { source, until as wait } from "./harness.ts";

const moment = 100;
let home = "";
let socket = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-tmux-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
});
afterEach(() => {
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  // tmux leaves the socket file behind after kill-server.
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
});

// A stand-in for Claude Code: busy for a while (losing what is typed then, as the real one
// can), then a ❯ prompt that logs every byte it receives. It turns on bracketed paste mode,
// since tmux only sends the paste marks to an app that asked for them. The space in its name
// would break it if tmux ran it through a shell.
function harness(busySeconds = 0): string[] {
  const script = join(home, `fake harness ${busySeconds}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
if [ ${busySeconds} -gt 0 ]; then
  echo "Thinking (esc to interrupt)"
  timeout ${busySeconds} cat > lost.txt
  clear
fi
printf '\\033[?2004h'
# Like Claude Code, it draws its own screen, which may not change at once when text arrives.
stty -echo
echo "❯"
cat > received.txt
`,
    { mode: 0o755 },
  );
  return [script];
}

function start(name: string, command: string[], env: Record<string, string> = {}) {
  startSession(socket, name, { folder: home, command, env });
}

// Waits as long as this file's tests expect anything to take, looking often.
const until = (done: () => boolean) => wait(done, { timeout: 5000, every: 20 });

const read = (file: string) =>
  existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8") : "";

test("a typed message with several lines arrives whole, as one paste and one Enter", async () => {
  start("lead", harness());
  await typeInto(socket, "lead", "fix the bug\nthen run the tests", { moment });
  // The terminal turns the Enter tmux sends into a newline, so one newline means one Enter.
  await until(() => read("received.txt").endsWith("\n"));
  await Bun.sleep(moment * 3);
  expect(read("received.txt")).toBe("\x1b[200~fix the bug\nthen run the tests\x1b[201~\n");
});

test("a message arrives whole while someone is scrolled back, and the agent reads as idle", async () => {
  start("lead", harness());
  await until(() => Bun.spawnSync(["tmux", "-L", socket, "capture-pane", "-p"]).success);
  await Bun.sleep(moment * 2);
  Bun.spawnSync(["tmux", "-L", socket, "copy-mode", "-t", "=lead:"]);
  expect(await isIdle(socket, "lead", { moment })).toBe(true);
  await typeInto(socket, "lead", "fix the bug", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~fix the bug\x1b[201~\n");
});

test("typing waits while the harness is busy, then goes through", async () => {
  start("lead", harness(1));
  await typeInto(socket, "lead", "hello", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("lost.txt")).toBe("");
  expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
});

test("typing gives up when the harness stays busy", async () => {
  start("lead", harness(30));
  const typing = typeInto(socket, "lead", "hello", { moment, timeout: 500 });
  await expect(typing).rejects.toThrow("esc to interrupt");
  expect(read("lost.txt")).toBe("");
});

test("a message cancelled while the harness is busy is never typed", async () => {
  start("lead", harness(1));
  const cancel = new AbortController();
  const typing = typeInto(socket, "lead", "stale", { moment, signal: cancel.signal });
  await Bun.sleep(300);
  cancel.abort();
  await typing;
  typeInto(socket, "lead", "fresh", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~fresh\x1b[201~\n");
});

test("typing says so when it gives up because there is no prompt", async () => {
  start("lead", ["sh", "-c", "echo starting; sleep 30"]);
  const typing = typeInto(socket, "lead", "hello", { moment, timeout: 300 });
  await expect(typing).rejects.toThrow("prompt");
});

test("two messages typed at once both arrive whole, in order, each sent", async () => {
  start("lead", harness());
  await Promise.all([
    typeInto(socket, "lead", "first\nmessage", { moment }),
    typeInto(socket, "lead", "second", { moment }),
  ]);
  await until(() => read("received.txt").endsWith("second\x1b[201~\n"));
  expect(read("received.txt")).toBe("\x1b[200~first\nmessage\x1b[201~\n\x1b[200~second\x1b[201~\n");
});

test("a session runs its command in its folder, with its environment", async () => {
  start("builder", ["sh", "-c", 'echo "$SKEL_THREAD $(pwd)" > seen.txt; sleep 30'], {
    SKEL_THREAD: "app-12",
  });
  await until(() => read("seen.txt") !== "");
  expect(read("seen.txt")).toBe(`app-12 ${home}\n`);
});

// tmux reads a word ending in ";" as the end of a command.
test("a first message and an environment value ending in ; arrive as given", async () => {
  start("builder", ["sh", "-c", 'printf "%s|%s" "$1" "$X" > seen.txt; sleep 30', "sh", "fix it;"], {
    X: "a;",
  });
  await until(() => read("seen.txt") !== "");
  expect(read("seen.txt")).toBe("fix it;|a;");
});

// The tmux server hands its own environment to every session, so a token in the daemon's
// environment would reach every agent.
test("a session gets only the environment it is given, and tmux's TERM", async () => {
  const tmux = source("tmux.ts");
  const script = `import { startSession } from ${JSON.stringify(tmux)};
startSession(${JSON.stringify(socket)}, "builder", {
  folder: ${JSON.stringify(home)},
  command: ["sh", "-c", "env > env.txt; sleep 30"],
  env: { PATH: process.env.PATH, KEPT: "yes", TERM: "dumb" },
});`;
  const run = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, GH_TOKEN: "secret", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1" },
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  await until(() => read("env.txt").includes("KEPT="));
  const names = read("env.txt")
    .split("\n")
    .flatMap((line) => (/^[A-Z_]+=/.test(line) ? [line.slice(0, line.indexOf("="))] : []));
  expect(names.filter((name) => !["PWD", "SHLVL", "_"].includes(name)).sort()).toEqual([
    "KEPT",
    "PATH",
    "TERM",
  ]);
  expect(read("env.txt")).not.toContain("TERM=dumb");
});

test("a name tmux would change is refused", () => {
  expect(() => start("app.1", ["sleep", "30"])).toThrow("app.1");
  expect(() => start("app:1", ["sleep", "30"])).toThrow("app:1");
  expect(hasSession(socket, "app_1")).toBe(false);
});

test("ending a session ends its process", async () => {
  start("builder", ["sh", "-c", "echo $$ > pid.txt; sleep 30"]);
  await until(() => read("pid.txt") !== "");
  expect(hasSession(socket, "builder")).toBe(true);
  endSession(socket, "builder");
  expect(hasSession(socket, "builder")).toBe(false);
  const pid = Number(read("pid.txt").trim());
  await until(() => !alive(pid));
});

// Claude Code can outlive its session for a few seconds, still writing in its folder.
test("stopping a session waits until what it started has exited", async () => {
  const slow = `trap 'sleep 1; echo out > gone.txt; exit' HUP TERM; echo $$ > pid.txt; sleep 30 & wait`;
  start("builder", ["sh", "-c", slow]);
  await until(() => read("pid.txt") !== "");
  await stopSession(socket, "builder");
  expect(hasSession(socket, "builder")).toBe(false);
  expect(read("gone.txt")).toBe("out\n");
  expect(alive(Number(read("pid.txt").trim()))).toBe(false);
});

test("stopping a session that doesn't run does nothing", async () => {
  await stopSession(socket, "nobody");
});

test("stopping a session kills what won't exit", async () => {
  start("builder", [
    "sh",
    "-c",
    "trap '' HUP TERM; echo $$ > pid.txt; for i in $(seq 300); do sleep 0.1; done",
  ]);
  await until(() => read("pid.txt") !== "");
  await stopSession(socket, "builder", 500);
  expect(alive(Number(read("pid.txt").trim()))).toBe(false);
});

// Returns whether a process is still running. One that exited stays a zombie until the test
// run ends, as the run adopts orphans, so asking the system for its ID would still find it.
const alive = (pid: number) => stillRunning([pid]).length > 0;

test("Ctrl-Q detaches with no prefix, and there is no status bar", () => {
  start("lead", ["sleep", "30"]);
  const tmux = (args: string[]) => Bun.spawnSync(["tmux", "-L", socket, ...args]).stdout.toString();
  expect(tmux(["show-options", "-g", "status"])).toBe("status off\n");
  expect(tmux(["list-keys", "-T", "root", "C-q"])).toContain("detach-client");
  expect(tmux(["list-keys", "-T", "root", "C-]"])).toBe("");
});

// Without it, tmux draws Claude Code's redraws in pieces, and over a slow link such as a
// Sprite's the prompt visibly flickers.
test("tmux passes synchronized output through to your terminal", () => {
  start("lead", ["sleep", "30"]);
  const features = Bun.spawnSync(["tmux", "-L", socket, "show-options", "-s", "terminal-features"]);
  expect(features.stdout.toString()).toContain("*:sync");
});

test("a session that was never started doesn't exist", () => {
  expect(hasSession(socket, "nobody")).toBe(false);
});

test("idle means a quiet pane showing the prompt, and not busy", async () => {
  start("waiting", harness());
  start("busy", harness(30));
  start("drawing", ["sh", "-c", 'echo "❯"; for i in $(seq 1500); do date +%N; sleep 0.02; done']);
  start("other", ["sh", "-c", "echo ready; sleep 30"]);
  await Bun.sleep(moment * 3);
  expect(await isIdle(socket, "waiting", { moment })).toBe(true);
  expect(await isIdle(socket, "busy", { moment })).toBe(false);
  expect(await isIdle(socket, "drawing", { moment })).toBe(false);
  expect(await isIdle(socket, "other", { moment })).toBe(false);
});
