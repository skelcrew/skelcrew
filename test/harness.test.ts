// The environment Skelcrew's tests give the processes they start: sc, its daemon and what
// those start.
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import { endFakeSessions, homeEnv, runSkel, startDaemon, until } from "./harness.ts";

// Reports whether the process group of the fake host's session `id` still runs something. A
// process that exited but wasn't reaped runs nothing. A session with no process ID never started.
function sessionGroupRunning(settings: string, id: string): boolean {
  const file = join(settings, "sessions", id, "pid");
  const pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return Bun.spawnSync(["ps", "-A", "-o", "pgid=", "-o", "stat="])
    .stdout.toString()
    .split("\n")
    .some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state?.startsWith("Z");
    });
}

// Kills what a test of the fake host started, whether or not it got that far: the host call, in
// the group of its own the test gave it, and each session's group. A test that fails before its
// clean-up ran would otherwise leave them running.
function endProcesses(settings: string, host?: Subprocess): void {
  const groups = host ? [host.pid] : [];
  const sessions = join(settings, "sessions");
  for (const id of existsSync(sessions) ? readdirSync(sessions) : []) {
    const file = join(sessions, id, "pid");
    groups.push(existsSync(file) ? Number(readFileSync(file, "utf8")) : 0);
  }
  // Group 0 is the caller's own, which would kill this test's worker.
  for (const group of groups.filter((pid) => Number.isInteger(pid) && pid > 0))
    try {
      process.kill(-group, "SIGKILL");
    } catch {}
}

test("a test's processes keep the temporary folders the test was given, as a sandbox hides /tmp", () => {
  const seen = Bun.spawnSync(["/bin/sh", "-c", 'echo "$TMPDIR|$TMUX_TMPDIR"'], {
    env: homeEnv("/nowhere"),
    stdout: "pipe",
  });
  const given = `${process.env.TMPDIR ?? ""}|${process.env.TMUX_TMPDIR ?? ""}\n`;
  expect(seen.stdout.toString()).toBe(given);
});

// sc finds the daemon by SKELCREW_SOCKET, or by XDG_RUNTIME_DIR, or else by /run/user. A test
// that hands it one outside its own folder would reach a daemon not its own, so it fails first.
test("refuses to run sc on a socket outside the test's own folder", async () => {
  const path = process.env.PATH ?? "";
  const home = mkdtempSync(join(tmpdir(), "skel-harness-test-"));
  const other = mkdtempSync(join(tmpdir(), "skel-harness-other-"));
  try {
    const inside = homeEnv(home);
    const at = (socket: string) => ({ ...inside, SKELCREW_SOCKET: socket });
    symlinkSync(other, join(home, "link"));
    for (const socket of [
      "/run/skelcrew/skelcrew.sock",
      join(other, "skelcrew.sock"),
      join(home, "..", basename(other), "skelcrew.sock"),
      join(home, "link", "skelcrew.sock"),
      // The link is followed first, so this is the folder above the other one.
      `${home}/link/../skelcrew.sock`,
    ])
      await expect(runSkel(["ps"], at(socket))).rejects.toThrow(socket);
    await expect(runSkel(["ps"], { HOME: home, PATH: path })).rejects.toThrow("outside");
    // The daemon listens in XDG_RUNTIME_DIR whatever SKELCREW_SOCKET says.
    const daemon = { ...at(join(home, "run", "s.sock")), XDG_RUNTIME_DIR: other };
    expect(() => startDaemon("t", daemon, [])).toThrow(join(other, "skelcrew.sock"));
    // An agent's home inside the test's folder still reaches the test's own sockets.
    const agent = { ...at(join(home, "run", "a", "s.sock")), HOME: join(home, "agent") };
    expect((await runSkel(["--version"], agent)).code).toBe(0);
    expect((await runSkel(["--version"], inside)).code).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

// A test's clean-up can find a fake session without a process ID, as its host died before
// starting it, or with one only half written. Killing that group would kill the test's own worker.
test("ending the fake host's sessions ends each one's processes, and skips one not yet started", async () => {
  const settings = mkdtempSync(join(tmpdir(), "skel-harness-host-"));
  const sessions = join(settings, "sessions");
  mkdirSync(sessions);
  try {
    const run = Bun.spawn(["sleep", "60"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    mkdirSync(join(sessions, "fake-running"));
    writeFileSync(join(sessions, "fake-running", "pid"), String(run.pid));
    mkdirSync(join(sessions, "fake-starting"));
    mkdirSync(join(sessions, "fake-half-written"));
    writeFileSync(join(sessions, "fake-half-written", "pid"), "");
    await endFakeSessions(settings);
    await run.exited;
    // A process that exited but wasn't reaped has no command.
    const gone = () => {
      try {
        return readFileSync(`/proc/${run.pid}/cmdline`).length === 0;
      } catch {
        return true;
      }
    };
    await until(gone, { what: () => "the session's process to end" });
  } finally {
    endProcesses(settings);
    rmSync(settings, { recursive: true, force: true });
  }
});

// The fake host runs on after the daemon that asked it has stopped, so it can start a session
// after a test's clean-up began. That session must still end, or it would outlive its test.
test("ending the fake host's sessions waits for a session the host is still starting", async () => {
  const settings = mkdtempSync(join(tmpdir(), "skel-harness-host-"));
  let host: Subprocess | undefined;
  try {
    // A slow start, so the clean-up begins before the session's folder exists.
    writeFileSync(join(settings, "slow-start"), "");
    const question = { ask: "start", name: "late", labels: {}, env: {}, folder: settings };
    host = Bun.spawn([process.execPath, join(import.meta.dir, "fake-host.ts")], {
      env: { ...process.env, SKELCREW_PLUGIN_CONFIG: settings },
      stdin: new Blob([JSON.stringify({ ...question, command: ["sleep", "60"] })]),
      stdout: "ignore",
      stderr: "ignore",
      // In a group of its own, as the daemon runs it.
      detached: true,
    });
    await until(() => existsSync(join(settings, "asked")), { what: () => "the host to be asked" });
    await endFakeSessions(settings);
    await host.exited;
    expect(existsSync(join(settings, "sessions", "fake-late", "pid"))).toBe(true);
    // A killed process takes a moment to go.
    await until(() => !sessionGroupRunning(settings, "fake-late"), {
      timeout: 5000,
      what: () => "the session's processes to end",
    });
  } finally {
    endProcesses(settings, host);
    rmSync(settings, { recursive: true, force: true });
  }
});

// The daemon can start a host call just before a test's clean-up, and the call notes itself only
// once Bun has started it. The clean-up must still wait for it, or the session it then starts
// would outlive the test.
test("ending the fake host's sessions waits for a call that hasn't noted itself yet", async () => {
  const settings = mkdtempSync(join(tmpdir(), "skel-harness-host-"));
  let host: Subprocess | undefined;
  try {
    const question = { ask: "start", name: "early", labels: {}, env: {}, folder: settings };
    host = Bun.spawn([process.execPath, join(import.meta.dir, "fake-host.ts")], {
      env: { ...process.env, SKELCREW_PLUGIN_CONFIG: settings },
      stdin: new Blob([JSON.stringify({ ...question, command: ["sleep", "60"] })]),
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    await endFakeSessions(settings);
    await host.exited;
    // A killed process takes a moment to go.
    await until(() => !sessionGroupRunning(settings, "fake-early"), {
      timeout: 5000,
      what: () => "the session's processes to end",
    });
  } finally {
    endProcesses(settings, host);
    rmSync(settings, { recursive: true, force: true });
  }
});
