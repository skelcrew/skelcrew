// Runs Skelcrew's tests, for `bun run check` and for a builder running a few test files, as
// bun scripts/test.ts [files], and for one of CI's shards, as bun scripts/test.ts --shard=2/4. The same run inside Skelcrew's own sandbox and outside it.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketFolderInside } from "../src/agents/sandbox.ts";
import { shardFiles, timesOfFiles } from "./shards.ts";
import { timings } from "./timings.ts";

// CI splits the tests into shards, as --shard=2/4. The split is made here, by the time each
// file took as test/times.json keeps it, and the shard's files are handed to Bun by name. Bun's
// own --shard splits by name, so where the slow files land is luck.
const given = Bun.argv.slice(2);
const shardArg = given.find((arg) => arg.startsWith("--shard="));
let args = given;
if (shardArg) {
  const [index, count] = shardArg.slice("--shard=".length).split("/").map(Number);
  if (!index || !count || index > count) throw new Error(`${shardArg} isn't a shard such as 2/4`);
  const files = [...new Bun.Glob("**/*.test.ts").scanSync(".")].filter(
    (file) => !file.startsWith("node_modules/"),
  );
  const timesFile = join("test", "times.json");
  const times = existsSync(timesFile)
    ? timesOfFiles.parse(JSON.parse(readFileSync(timesFile, "utf8")))
    : {};
  const mine = shardFiles(files, times, index, count);
  // Bun given no file runs every file, so a shard with none ends here.
  if (mine.length === 0) {
    console.log(`Shard ${index} of ${count} has no test files.`);
    process.exit(0);
  }
  args = [...given.filter((arg) => arg !== shardArg), ...mine.map((file) => `./${file}`)];
}

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

// In CI, Bun writes a JUnit report with each test's time, a preload writes each file's, and the
// run prints where its time went once it ends, in its log and on its summary page. The tests
// that start a real sandbox run only outside Skelcrew's own, so CI is where their times show.
const report = process.env.GITHUB_ACTIONS === "true" ? join(own, "report.xml") : "";
const fileTimes = join(own, "file-times.jsonl");
const reporting = report
  ? [
      "--reporter=junit",
      `--reporter-outfile=${report}`,
      "--preload",
      join(import.meta.dir, "file-times.ts"),
    ]
  : [];
if (report) env.TEST_FILE_TIMES = fileTimes;
// Written when the run is stopped at its limit, so a file that would start after that never does.
const stoppedMark = join(own, "stopped");
env.TEST_RUN_STOPPED = stoppedMark;
// A dot per test as it ends, and each failure in full, so a slow run shows it is moving. Bun's
// usual output in a parallel run prints a file only once it has ended, so a long file leaves
// the screen silent for minutes. A test that hangs fails after a minute. Bun hands a whole file
// to one worker, so the slowest file sets the least a run can take. A file runs for each core,
// at least four and at most eight. Eight passed on eight cores, where the tests that start a real
// sandbox are skipped. With those, eight timed out tests on CI's smaller machine, and four didn't.
const workers = Math.min(8, Math.max(4, navigator.hardwareConcurrency));
const run = Bun.spawn(
  [
    process.execPath,
    "test",
    "--dots",
    "--timeout",
    "60000",
    `--parallel=${workers}`,
    "--preload",
    join(import.meta.dir, "stopped.ts"),
    ...reporting,
    ...args,
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
  // From now on, a file a worker would start ends that worker before any of its code runs.
  writeFileSync(stoppedMark, "");
  // Bun writes its report only when it ends by itself, so its workers are stopped rather than
  // Bun. It counts each file a worker had as cut off and hands each waiting file to a worker,
  // which ends at once, until Bun ends. Workers are Bun's own children, found by their parent,
  // never by name. Each is asked first, so the run's sweeps can end what its tests left running.
  // A worker still there two seconds later is killed, as a test can ignore being asked, and Bun
  // would then wait for it and never write the report.
  const asked = new Map<number, number>();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const children = Bun.spawnSync(["pgrep", "-P", String(run.pid)], { stdout: "pipe" });
    for (const pid of children.stdout.toString().split("\n").filter(Boolean).map(Number)) {
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
      const files = existsSync(fileTimes) ? await Bun.file(fileTimes).text() : "";
      const table = timings(await Bun.file(report).text(), files, 25);
      console.log(`\n${table}`);
      // The run's summary page shows it too, as anyone can read that page without the job's log.
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) appendFileSync(summary, `\n\`\`\`\n${table}\`\`\`\n`);
    } catch (error) {
      console.error(`The test report couldn't be read: ${error}`);
    }
  rmSync(own, { recursive: true, force: true });
  process.exit(stopped || run.signalCode ? 1 : code);
});
