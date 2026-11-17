// The daemon's log of a stall: when its main loop stops running, said while it is stuck and
// again once it runs.
import { expect, test } from "bun:test";
import { source } from "./harness.ts";

// Runs a process that watches itself for stalls, then blocks for `blocked` ms, as a call to
// tmux that hangs would, and returns what it logged.
async function logOfStall(blocked: number): Promise<string> {
  const script = `import { watchForStalls } from ${JSON.stringify(source("flow/stall.ts"))};
watchForStalls(500);
await Bun.sleep(300);
Bun.spawnSync(["sleep", "${blocked / 1000}"]);
await Bun.sleep(300);
process.exit(0);`;
  const run = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  return out;
}

test("logs that the daemon is stuck while it is, and how long once it runs again", async () => {
  const log = await logOfStall(2000);
  expect(log).toMatch(
    /^The daemon has been stuck for 0\.\ds\.\nThe daemon runs again after 2\.\ds stuck\.\n$/,
  );
});

test("logs nothing while the daemon keeps running", async () => {
  expect(await logOfStall(0)).toBe("");
});
