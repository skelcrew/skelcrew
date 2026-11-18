// The log of a stall in the daemon or the screen's sidebar: when its main loop stops running,
// and at which step, said while it is stuck and again once it runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

let folder = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "skel-stall-test-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

// Runs a process that watches itself for stalls, as `watching` starts it, then blocks for
// `blocked` ms in a step named "asking tmux", as a call to tmux that hangs would. Returns what
// it printed.
async function stall(watching: string, blocked: number): Promise<string> {
  const script = `import { doing, watchForStalls } from ${JSON.stringify(source("flow/stall.ts"))};
${watching};
await Bun.sleep(300);
doing("asking tmux", () => Bun.spawnSync(["sleep", "${blocked / 1000}"]));
await Bun.sleep(300);
process.exit(0);`;
  const run = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  return out;
}

test("logs that the daemon is stuck while it is, at which step, and how long once it runs again", async () => {
  const log = await stall('watchForStalls("The daemon", undefined, 500)', 2000);
  expect(log).toMatch(
    /^The daemon has been stuck for 0\.\ds, while asking tmux\.\nThe daemon runs again after 2\.\ds stuck\.\n$/,
  );
});

// The sidebar draws in your terminal, so its log goes to a file, with the time of each line.
test("logs the screen's stalls to its file, with the time", async () => {
  const file = join(folder, "screen.log");
  const watching = `watchForStalls("The screen's sidebar", ${JSON.stringify(file)}, 500)`;
  expect(await stall(watching, 2000)).toBe("");
  const lines = readFileSync(file, "utf8").split("\n");
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z The screen's sidebar has been stuck for /);
  expect(lines[0]).toEndWith(", while asking tmux.");
  expect(lines[1]).toMatch(/ The screen's sidebar runs again after 2\.\ds stuck\.$/);
});

test("logs nothing while the main loop keeps running", async () => {
  expect(await stall('watchForStalls("The daemon", undefined, 500)', 0)).toBe("");
});
