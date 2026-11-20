// The environment Skelcrew's tests give the processes they start: sc, its daemon and what
// those start.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { endFakeSessions, homeEnv, runSkel, startDaemon, until } from "./harness.ts";

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

// A test's clean-up can find a fake session whose process ID isn't written yet, such as one the
// daemon was starting as the test ended. Killing that group would kill the test's own worker.
test("ending the fake host's sessions ends each one's processes, and skips one not yet started", async () => {
  const sessions = mkdtempSync(join(tmpdir(), "skel-harness-sessions-"));
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
    endFakeSessions(sessions);
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
    rmSync(sessions, { recursive: true, force: true });
  }
});
