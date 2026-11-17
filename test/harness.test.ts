// The environment Skelcrew's tests give the processes they start: sc, its daemon and what
// those start.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { homeEnv, runSkel, startDaemon } from "./harness.ts";

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
    ])
      await expect(runSkel(["ps"], at(socket))).rejects.toThrow(socket);
    await expect(runSkel(["ps"], { HOME: home, PATH: path })).rejects.toThrow("outside");
    expect(() => startDaemon("t", at(join(other, "s.sock")), [])).toThrow("outside");
    // An agent's home inside the test's folder still reaches the test's own sockets.
    const agent = { ...at(join(home, "run", "a", "s.sock")), HOME: join(home, "agent") };
    expect((await runSkel(["--version"], agent)).code).toBe(0);
    expect((await runSkel(["--version"], inside)).code).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
