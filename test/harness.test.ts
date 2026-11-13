// The environment Skelcrew's tests give the processes they start: sc, its daemon and what
// those start.
import { expect, test } from "bun:test";
import { homeEnv } from "./harness.ts";

test("a test's processes keep the temporary folders the test was given, as a sandbox hides /tmp", () => {
  const seen = Bun.spawnSync(["/bin/sh", "-c", 'echo "$TMPDIR|$TMUX_TMPDIR"'], {
    env: homeEnv("/nowhere"),
    stdout: "pipe",
  });
  const given = `${process.env.TMPDIR ?? ""}|${process.env.TMUX_TMPDIR ?? ""}\n`;
  expect(seen.stdout.toString()).toBe(given);
});
