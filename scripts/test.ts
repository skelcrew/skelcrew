// Runs Skelcrew's tests, for `bun run check` and for a builder running a few test files, as
// bun scripts/test.ts [files]. The same run inside Skelcrew's own sandbox and outside it.

// Skelcrew's sandbox gives every agent SKELCREW_SANDBOX and the daemon's SKELCREW_SOCKET. Tests
// would hand them on to every sc, daemon and tmux server they start: those would refuse what
// agents may not do, or call the real daemon. Bun hands a child the environment it started
// with, whatever process.env says later, so the run must start without them. Tests that start
// a real sandbox can't run inside one, and learn that they are inside from
// SKELCREW_TESTS_IN_SANDBOX instead, which nothing in Skelcrew reads.
const env: Record<string, string | undefined> = { ...process.env };
const inside = env.SKELCREW_SANDBOX === "1";
delete env.SKELCREW_SANDBOX;
delete env.SKELCREW_SOCKET;
delete env.SKELCREW_TESTS_IN_SANDBOX;
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
  process.exit(stopped || run.signalCode ? 1 : code);
});
