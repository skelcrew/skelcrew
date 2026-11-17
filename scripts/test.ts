// Runs Skelcrew's tests, for `bun run check` and for a builder running a few test files, as
// bun scripts/test.ts [files]. The same run inside Skelcrew's own sandbox and outside it.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketFolderInside } from "../src/agents/sandbox.ts";
import { timings } from "./timings.ts";

// Skelcrew's sandbox gives every agent SKELCREW_SANDBOX and the daemon's SKELCREW_SOCKET, and a
// laptop's server gets variables of its own. Tests would hand them on to every sc, daemon and
// tmux server they start: those would refuse what agents may not do, act as a laptop's server,
// or call the real daemon. So the run starts without any SKELCREW_ variable. Bun hands a child
// the environment it started with, whatever process.env says later, so this can't wait for
// the tests themselves.
const env: Record<string, string | undefined> = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith("SKELCREW_")) delete env[name];
// A test that spreads the run's environment into a process of its own, or gives none, would
// reach your real Skelcrew: its settings and data through HOME, and its daemon through
// XDG_RUNTIME_DIR, or /run/user without it. So the run gets a home and a runtime folder of its
// own, with nothing in them.
const own = mkdtempSync(join(tmpdir(), "skel-test-run-"));
mkdirSync(join(own, "run"), { mode: 0o700 });
env.HOME = own;
env.XDG_RUNTIME_DIR = join(own, "run");
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

// In CI, Bun writes a JUnit report with each test's time, and the run prints where its time went
// once it ends. The tests that start a real sandbox run only outside Skelcrew's own, so CI is
// where their times show.
const report = process.env.GITHUB_ACTIONS === "true" ? join(own, "report.xml") : "";
const reporting = report ? ["--reporter=junit", `--reporter-outfile=${report}`] : [];
// A dot per test as it ends, and each failure in full, so a slow run shows it is moving. Bun's
// usual output in a parallel run prints a file only once it has ended, so a long file leaves
// the screen silent for minutes. A test that hangs fails after a minute. Eight files run at once:
// most tests wait on tmux and timers rather than use the CPU, and Bun hands a whole file to one
// worker, so the slowest file sets the least a run can take.
const run = Bun.spawn(
  [
    process.execPath,
    "test",
    "--dots",
    "--timeout",
    "60000",
    "--parallel=8",
    ...reporting,
    ...Bun.argv.slice(2),
  ],
  { env, stdio: ["inherit", "inherit", "inherit"] },
);

// The whole run ends within this, even if something keeps it from ever finishing, such as a
// process a test started that never exits. A full run takes about two minutes on eight cores
// without the tests that start a real sandbox. CI runs those too, and took 13 to 16 minutes with
// four files at once, so the limit is 30. It can come down once CI shows its new time. Its own
// test sets a shorter limit, in milliseconds.
const limit = Number(process.env.SKELCREW_TESTS_LIMIT) || 30 * 60_000;
let stopped = false;
const stop = setTimeout(async () => {
  stopped = true;
  console.error(`\nThe tests ran past ${limit / 1000} seconds, so they were stopped.`);
  // Bun writes its report only when it ends by itself, so its workers are stopped rather than
  // Bun. It counts each file a worker had as cut off and hands the next to a new worker, which
  // is stopped in turn, until Bun ends. Workers are Bun's own children, found by their parent,
  // never by name. Each is asked first, so the run's sweeps can end what its tests left running.
  // A worker still there two seconds later is killed, as a test can ignore being asked, and Bun
  // would then wait for it and never write the report.
  const asked = new Map<number, number>();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const workers = Bun.spawnSync(["pgrep", "-P", String(run.pid)], { stdout: "pipe" });
    for (const pid of workers.stdout.toString().split("\n").filter(Boolean).map(Number)) {
      const since = asked.get(pid) ?? Date.now();
      asked.set(pid, since);
      try {
        process.kill(pid, Date.now() - since > 2000 ? "SIGKILL" : "SIGTERM");
      } catch {}
    }
    await Bun.sleep(200);
  }
  // A Bun still running then is asked to end, and killed if it doesn't.
  run.kill("SIGTERM");
  setTimeout(() => run.kill("SIGKILL"), 10_000).unref();
}, limit);
// A run that was stopped fails, whatever its code: a test that handles SIGTERM can leave with
// success.
run.exited.then(async (code) => {
  clearTimeout(stop);
  // A report that can't be read is said, and the run still ends as its tests did.
  if (report && existsSync(report))
    try {
      console.log(`\n${timings(await Bun.file(report).text(), 25)}`);
    } catch (error) {
      console.error(`The test report couldn't be read: ${error}`);
    }
  rmSync(own, { recursive: true, force: true });
  process.exit(stopped || run.signalCode ? 1 : code);
});
