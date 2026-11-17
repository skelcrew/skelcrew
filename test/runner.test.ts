// The test runner, scripts/test.ts: a run that goes past its time limit is stopped and fails,
// in CI it prints how long each test took, and what a run starts never reaches the daemon of the
// Skelcrew it runs in.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// loads no preload of Skelcrew's.
async function runIn(files: string[], ci: boolean, limit = "") {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: folder };
  if (ci) env.GITHUB_ACTIONS = "true";
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

// CI is where the tests that start a real sandbox run, so its log shows where a slow run went.
test("in CI a run prints its slowest tests and each file's time, and elsewhere neither", async () => {
  writeFileSync(
    join(folder, "slow.test.ts"),
    `import { test } from "bun:test";
test("takes a while", () => Bun.sleep(400));
test("takes no time", () => {});
`,
  );
  writeFileSync(
    join(folder, "other.test.ts"),
    'import { test } from "bun:test";\ntest("other", () => {});\n',
  );
  const files = ["./slow.test.ts", "./other.test.ts"];
  const { out, code } = await runIn(files, true);
  expect(code).toBe(0);
  const tests = out.slice(out.indexOf("The slowest tests:"), out.indexOf("Time per file:"));
  expect(tests).toMatch(/\n +0\.4 s {2}slow\.test\.ts {2}takes a while\n/);
  expect(tests.indexOf("takes a while")).toBeLessThan(tests.indexOf("takes no time"));
  expect(tests).toContain("other.test.ts  other");
  const perFile = out.slice(out.indexOf("Time per file:"));
  expect(perFile).toMatch(/\n +0\.4 s {2}slow\.test\.ts\n +0\.0 s {2}other\.test\.ts\n/);
  const local = await runIn(files, false);
  expect(local.code).toBe(0);
  expect(local.out).not.toContain("slowest");
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
  expect(out).toMatch(/\n +0\.1 s {2}quick\.test\.ts {2}quick\n/);
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
  expect(out).toMatch(/\n +0\.1 s {2}quick\.test\.ts {2}quick\n/);
  expect(out).toMatch(/\n +cut off {2}stubborn\.test\.ts\n/);
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
        SKELCREW_LAPTOP_SETUP: "laptop",
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
