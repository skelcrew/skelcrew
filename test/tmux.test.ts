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
import { endSession, hasSession, isIdle, startSession, typeInto } from "../src/tmux.ts";

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
// since tmux only sends the paste marks to an app that asked for them.
function harness(busySeconds = 0): string[] {
  const script = join(home, `harness-${busySeconds}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
if [ ${busySeconds} -gt 0 ]; then
  echo "Thinking (esc to interrupt)"
  timeout ${busySeconds} cat > lost.txt
  clear
fi
printf '\\033[?2004h'
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

async function until(done: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("gave up waiting");
    await Bun.sleep(20);
  }
}

const read = (file: string) =>
  existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8") : "";

test("a typed message with several lines arrives whole and is sent once", async () => {
  start("lead", harness());
  await typeInto(socket, "lead", "fix the bug\nthen run the tests", { moment });
  // The terminal turns the Enter tmux sends into a newline, so one newline means one Enter.
  await until(() => read("received.txt").endsWith("\n"));
  await Bun.sleep(moment * 3);
  expect(read("received.txt")).toBe("\x1b[200~fix the bug\nthen run the tests\x1b[201~\n");
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
  await expect(typing).rejects.toThrow("busy");
  expect(read("lost.txt")).toBe("");
});

test("a session runs its command in its folder, with its environment", async () => {
  start("builder", ["sh", "-c", 'echo "$SKEL_THREAD $(pwd)" > seen.txt; sleep 30'], {
    SKEL_THREAD: "app#12",
  });
  await until(() => read("seen.txt") !== "");
  expect(read("seen.txt")).toBe(`app#12 ${home}\n`);
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Ctrl-] detaches with no prefix, and there is no status bar", () => {
  start("lead", ["sleep", "30"]);
  const tmux = (args: string[]) => Bun.spawnSync(["tmux", "-L", socket, ...args]).stdout.toString();
  expect(tmux(["show-options", "-g", "status"])).toBe("status off\n");
  expect(tmux(["list-keys", "-T", "root", "C-]"])).toContain("detach-client");
});

test("a session that was never started doesn't exist", () => {
  expect(hasSession(socket, "nobody")).toBe(false);
});

test("idle means a quiet pane showing the prompt, and not busy", async () => {
  start("waiting", harness());
  start("busy", harness(30));
  start("drawing", ["sh", "-c", 'echo "❯"; while :; do date +%N; sleep 0.02; done']);
  start("other", ["sh", "-c", "echo ready; sleep 30"]);
  await Bun.sleep(moment * 3);
  expect(await isIdle(socket, "waiting", { moment })).toBe(true);
  expect(await isIdle(socket, "busy", { moment })).toBe(false);
  expect(await isIdle(socket, "drawing", { moment })).toBe(false);
  expect(await isIdle(socket, "other", { moment })).toBe(false);
});
