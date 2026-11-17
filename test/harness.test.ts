// The environment Skelcrew's tests give the processes they start: sc, its daemon and what
// those start.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// that hands it one outside its temporary folder would reach a real daemon, so it fails first.
test("refuses to run sc on a socket outside the test's temporary folder", async () => {
  const path = process.env.PATH ?? "";
  const home = mkdtempSync(join(tmpdir(), "skel-harness-test-"));
  try {
    const inside = homeEnv(home);
    const away = { ...inside, SKELCREW_SOCKET: "/run/skelcrew/skelcrew.sock" };
    expect(runSkel(["ps"], away)).rejects.toThrow("/run/skelcrew/skelcrew.sock");
    expect(runSkel(["ps"], { HOME: home, PATH: path })).rejects.toThrow("outside");
    expect(() => startDaemon("t", away, [])).toThrow("outside");
    expect((await runSkel(["--version"], inside)).code).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
