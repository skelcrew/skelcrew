// The test runner, scripts/test.ts: a run that goes past its time limit is stopped and fails,
// CI can ask it for a JUnit report, and what a run starts never reaches the daemon of the
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

// CI asks for a JUnit report, to see how long each test took where the tests that start a real
// sandbox run. A run without the variable, such as yours, writes none.
test("a run with SKELCREW_TESTS_REPORT set writes a JUnit report there, with each test's time", async () => {
  writeFileSync(
    join(folder, "quick.test.ts"),
    'import { test } from "bun:test";\ntest("quick", () => {});\n',
  );
  const report = join(folder, "report.xml");
  const run = Bun.spawn([process.execPath, runner, "./quick.test.ts"], {
    cwd: folder,
    env: { PATH: process.env.PATH ?? "", HOME: folder, SKELCREW_TESTS_REPORT: report },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await run.exited).toBe(0);
  expect(await Bun.file(report).text()).toMatch(/<testcase name="quick"[^>]* time="[\d.]+"/);
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
