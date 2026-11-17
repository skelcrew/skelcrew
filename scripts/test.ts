// Runs Skelcrew's tests, for `bun run check` and for a builder running a few test files, as
// bun scripts/test.ts [files]. The same run inside Skelcrew's own sandbox and outside it.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketFolderInside } from "../src/agents/sandbox.ts";

// Skelcrew's sandbox gives every agent SKELCREW_SANDBOX and the daemon's SKELCREW_SOCKET, and a
// laptop's server gets variables of its own. Tests would hand them on to every sc, daemon and
// tmux server they start: those would refuse what agents may not do, act as a laptop's server,
// or call the real daemon. So the run starts without any SKELCREW_ variable. Bun hands a child
// the environment it started with, whatever process.env says later, so this can't wait for
// the tests themselves.
const env: Record<string, string | undefined> = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith("SKELCREW_")) delete env[name];
// Without a variable, sc finds the daemon in XDG_RUNTIME_DIR, or in /run/user. A test that
// spreads the run's environment into a process of its own would reach the real daemon there,
// so the run gets a runtime folder of its own, with nothing listening in it.
const runtime = mkdtempSync(join(tmpdir(), "skel-test-runtime-"));
env.XDG_RUNTIME_DIR = runtime;
// Tests that start a real sandbox can't run inside one, and learn that they are inside from
// SKELCREW_TESTS_IN_SANDBOX, which nothing in Skelcrew reads. The sandbox's socket folder tells
// too, so a run that dropped SKELCREW_SANDBOX by hand still skips them. A stand-in for bubblewrap
// would point their builder at that folder without hiding it, and reach the real daemon.
const inside = process.env.SKELCREW_SANDBOX === "1" || existsSync(socketFolderInside);
if (inside) {
  env.SKELCREW_TESTS_IN_SANDBOX = "1";
  console.log(
    "Inside Skelcrew's sandbox, tests that start a real sandbox are skipped, as bubblewrap can't start inside another.",
  );
}

// A dot per test as it ends, and each failure in full, so a slow run shows it is moving. Bun's
// usual output in a parallel run prints a file only once it has ended, so a long file leaves
// the screen silent for minutes. A test that hangs fails after a minute.
const run = Bun.spawn(
  [process.execPath, "test", "--dots", "--timeout", "60000", "--parallel=4", ...Bun.argv.slice(2)],
  { env, stdio: ["inherit", "inherit", "inherit"] },
);

// The whole run ends within this, even if something keeps it from ever finishing, such as a
// process a test started that never exits. A full run takes a few minutes. Its own test sets a
// shorter limit, in milliseconds.
const limit = Number(process.env.SKELCREW_TESTS_LIMIT) || 15 * 60_000;
let stopped = false;
const stop = setTimeout(() => {
  stopped = true;
  console.error(`\nThe tests ran past ${limit / 1000} seconds, so they were stopped.`);
  run.kill("SIGTERM");
  // Asked first, so the run's sweeps can end what its tests left running.
  setTimeout(() => run.kill("SIGKILL"), 10_000).unref();
}, limit);
// A run that was stopped fails, whatever its code: a test that handles SIGTERM can leave with
// success.
run.exited.then((code) => {
  clearTimeout(stop);
  rmSync(runtime, { recursive: true, force: true });
  process.exit(stopped || run.signalCode ? 1 : code);
});
