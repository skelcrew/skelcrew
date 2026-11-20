// The test runner, scripts/test.ts: a run that goes past its time limit is stopped and fails,
// in CI it prints how long each test took, and what a run starts never reaches the daemon of the
// Skelcrew it runs in.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dir, "..", "scripts", "test.ts");
let folder = "";
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "skel-runner-test-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

// A test that never ends, and leaves cleanly with success when asked to stop, as a process
// that handles SIGTERM can. Only the time limit can end the run.
test("a run stopped at its time limit fails, even if it then leaves with success", async () => {
  writeFileSync(
    join(folder, "hangs.test.ts"),
    `import { test } from "bun:test";
process.on("SIGTERM", () => process.exit(0));
test("hangs", () => new Promise(() => {}), 600_000);
`,
  );
  // In the test's folder, which has no bunfig.toml, so the run loads no preload of Skelcrew's.
  const run = Bun.spawn([process.execPath, runner, "./hangs.test.ts"], {
    cwd: folder,
    env: { PATH: process.env.PATH ?? "", HOME: folder, SKELCREW_TESTS_LIMIT: "2000" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  expect(err).toContain("so they were stopped");
  expect(code).toBe(1);
});

// Runs scripts/test.ts on the given test files in the test's folder, as CI runs it when `ci`,
// and gives back what it printed and its exit code. The folder has no bunfig.toml, so the run
// loads no preload of Skelcrew's. In CI, the run's summary page is the file `summary` in it.
async function runIn(files: string[], ci: boolean, limit = "") {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: folder };
  if (ci) {
    env.GITHUB_ACTIONS = "true";
    env.GITHUB_STEP_SUMMARY = join(folder, "summary");
  }
  if (limit) env.SKELCREW_TESTS_LIMIT = limit;
  const run = Bun.spawn([process.execPath, runner, ...files], {
    cwd: folder,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  return { out, code };
}

// The seconds a line of the timings gives for what follows them, such as a file and a test's
// name, and where that line is in what the run printed. A busy machine makes a sleep last
// longer, so tests check that a time is at least what was slept, and the order, never one value.
function timeOf(out: string, what: string): { seconds: number; at: number } {
  const lines = out.split("\n");
  const at = lines.findIndex((line) => line.trimStart().endsWith(` s  ${what}`));
  return { seconds: Number.parseFloat(lines[at]?.trim() ?? ""), at };
}

// CI is where the tests that start a real sandbox run, so its log shows where a slow run went.
// A file's time includes its hooks, such as a slow beforeAll, which no test's time has, and the
// preloads bunfig.toml names, which load before the runner's own. Here one takes half a second.
test("in CI a run prints its slowest tests and each file's time, and elsewhere neither", async () => {
  writeFileSync(join(folder, "bunfig.toml"), '[test]\npreload = ["./slow-preload.ts"]\n');
  writeFileSync(join(folder, "slow-preload.ts"), "Bun.sleepSync(500);\n");
  writeFileSync(
    join(folder, "slow.test.ts"),
    `import { test } from "bun:test";
test("takes a while", () => Bun.sleep(400));
test("takes no time", () => {});
`,
  );
  writeFileSync(
    join(folder, "other.test.ts"),
    `import { afterAll, beforeAll, test } from "bun:test";
beforeAll(() => Bun.sleep(800));
afterAll(() => Bun.sleep(400));
test("other", () => {});
`,
  );
  const files = ["./slow.test.ts", "./other.test.ts"];
  const { out, code } = await runIn(files, true);
  expect(code).toBe(0);
  const tests = out.slice(out.indexOf("The slowest tests:"), out.indexOf("Time per file:"));
  const slowTest = timeOf(tests, "slow.test.ts  takes a while");
  expect(slowTest.seconds).toBeGreaterThanOrEqual(0.4);
  expect(slowTest.at).toBeLessThan(timeOf(tests, "slow.test.ts  takes no time").at);
  expect(timeOf(tests, "other.test.ts  other").at).toBeGreaterThan(0);
  // Each file, with at least what its tests, hooks and the preload slept. A busy machine can
  // delay either file, so their order isn't checked.
  const perFile = out.slice(out.indexOf("Time per file:"));
  const [other, slow] = [timeOf(perFile, "other.test.ts"), timeOf(perFile, "slow.test.ts")];
  expect(other.seconds).toBeGreaterThanOrEqual(1.7);
  expect(slow.seconds).toBeGreaterThanOrEqual(0.9);
  expect(other.at).toBeGreaterThan(0);
  expect(slow.at).toBeGreaterThan(0);
  // The run's summary page shows the same times, as anyone can read it without the job's log.
  const summary = readFileSync(join(folder, "summary"), "utf8");
  expect(summary).toContain("Time per file:");
  expect(summary).toContain("slow.test.ts  takes a while");
  rmSync(join(folder, "summary"));
  const local = await runIn(files, false);
  expect(local.code).toBe(0);
  expect(local.out).not.toContain("slowest");
  expect(existsSync(join(folder, "summary"))).toBe(false);
});

// A run stopped at its limit is the one whose times matter most.
test("in CI a run stopped at its limit still prints the times it has, and names the files it stopped", async () => {
  writeFileSync(
    join(folder, "quick.test.ts"),
    'import { test } from "bun:test";\ntest("quick", () => Bun.sleep(100));\n',
  );
  writeFileSync(
    join(folder, "hangs.test.ts"),
    'import { test } from "bun:test";\ntest("hangs", () => new Promise(() => {}), 600_000);\n',
  );
  const { out, code } = await runIn(["./quick.test.ts", "./hangs.test.ts"], true, "3000");
  expect(code).toBe(1);
  expect(timeOf(out, "quick.test.ts  quick").seconds).toBeGreaterThanOrEqual(0.1);
  expect(out).toMatch(/\n +cut off {2}hangs\.test\.ts\n/);
});

// A test that hangs and ignores being asked to stop, so only a kill ends its worker.
test("in CI a run stopped at its limit prints its times even when a worker ignores SIGTERM", async () => {
  writeFileSync(
    join(folder, "quick.test.ts"),
    'import { test } from "bun:test";\ntest("quick", () => Bun.sleep(100));\n',
  );
  writeFileSync(
    join(folder, "stubborn.test.ts"),
    `import { test } from "bun:test";
process.on("SIGTERM", () => {});
test("hangs", () => new Promise(() => {}), 600_000);
`,
  );
  const { out, code } = await runIn(["./quick.test.ts", "./stubborn.test.ts"], true, "3000");
  expect(code).toBe(1);
  expect(timeOf(out, "quick.test.ts  quick").seconds).toBeGreaterThanOrEqual(0.1);
  expect(out).toMatch(/\n +cut off {2}stubborn\.test\.ts\n/);
});

// Files still waiting for a worker when the run is stopped never start: one that did could set
// up after the limit and be killed before it cleared up. Nine files hang, more than a run's
// workers, so the last one waits for a worker.
test("a file still waiting when the run is stopped never starts, and is named as cut off", async () => {
  const hangs =
    'import { test } from "bun:test";\ntest("hangs", () => new Promise(() => {}), 600_000);\n';
  const files = Array.from({ length: 9 }, (_, i) => `./hangs-${i}.test.ts`);
  for (const file of files) writeFileSync(join(folder, file), hangs);
  writeFileSync(
    join(folder, "late.test.ts"),
    `import { writeFileSync } from "node:fs";
import { test } from "bun:test";
writeFileSync(${JSON.stringify(join(folder, "late-started"))}, "");
test("late", () => {});
`,
  );
  const { out, code } = await runIn([...files, "./late.test.ts"], true, "3000");
  expect(code).toBe(1);
  expect(existsSync(join(folder, "late-started"))).toBe(false);
  expect(out).toMatch(/\n +cut off {2}late\.test\.ts\n/);
});

// Stands in for the daemon of the Skelcrew a builder runs in, listening on this socket, and
// counts what connects to it.
function outerDaemon(socket: string) {
  let reached = 0;
  const server = createServer((connection) => {
    reached++;
    connection.end();
  });
  server.listen(socket);
  return { reached: () => reached, close: () => server.close() };
}

// A builder's tests run with its sandbox's Skelcrew variables set. No sc a test starts may reach
// the daemon those point to: not with the harness's environment, nor with the run's own spread
// into it, nor with none given. Nor may the run or what it starts find that Skelcrew's settings
// and data in its home.
test("a nested sc never reaches the outer daemon, whatever the outer variables say", async () => {
  const outer = outerDaemon(join(folder, "skelcrew.sock"));
  writeFileSync(
    join(folder, "nested.test.ts"),
    `import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeEnv, runSkel, source } from ${JSON.stringify(join(import.meta.dir, "harness.ts"))};
test("submits", async () => {
  const home = mkdtempSync(join(tmpdir(), "nested-"));
  // The folder is outside the outer test's, so it goes here, whatever happens.
  try {
    mkdirSync(join(home, "run"));
    await runSkel(["submit", "Round 1"], { ...process.env, ...homeEnv(home) });
    const sc = [process.execPath, source("main.ts"), "submit", "Round 1"];
    for (const env of [{ ...process.env, HOME: home }, undefined]) {
      const run = Bun.spawn(sc, { env, stdout: "pipe", stderr: "pipe" });
      const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
      if (!err.includes("the daemon didn't answer")) throw new Error(\`sc ended with \${code}: \${err}\`);
    }
    // Skelcrew's settings and data, in this run and in a process that inherits its environment.
    const paths = ${JSON.stringify(join(import.meta.dir, "..", "src", "paths.ts"))};
    const code = \`import { configDir, dataDir } from \${JSON.stringify(paths)}; console.log(configDir(), dataDir());\`;
    const child = Bun.spawnSync([process.execPath, "-e", code]).stdout.toString();
    for (const seen of [child, (await import(paths)).configDir()])
      if (!seen.includes("skelcrew") || seen.includes(${JSON.stringify(folder)})) throw new Error(\`reached the outer home: \${seen}\`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
`,
  );
  try {
    const run = Bun.spawn([process.execPath, runner, "./nested.test.ts"], {
      cwd: folder,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: folder,
        XDG_RUNTIME_DIR: folder,
        SKELCREW_SOCKET: join(folder, "skelcrew.sock"),
        SKELCREW_SANDBOX: "1",
        SKELCREW_LAPTOP_LOCK: "laptop",
        SKELCREW_LAPTOP_BUILD: "laptop",
        SKELCREW_REMOTE_NAME: "laptop",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    expect(err).toContain("1 pass\n0 fail");
    expect(code).toBe(0);
    expect(outer.reached()).toBe(0);
  } finally {
    outer.close();
  }
});

// A plain bun test skips scripts/test.ts, so the preload stops it before any of its sc can
// find the outer daemon.
test("a plain bun test with an outer Skelcrew variable set stops and says how to run the tests", async () => {
  writeFileSync(
    join(folder, "nothing.test.ts"),
    'import { test } from "bun:test";\ntest("x", () => {});\n',
  );
  const preload = join(import.meta.dir, "inherited.ts");
  const run = Bun.spawn([process.execPath, "test", "--preload", preload, "./nothing.test.ts"], {
    cwd: folder,
    env: { PATH: process.env.PATH ?? "", HOME: folder, SKELCREW_REMOTE_NAME: "laptop" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  expect(err).toContain("Run the tests with `bun run test`");
  expect(code).toBe(1);
});
