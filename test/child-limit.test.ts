// The limit on a process a test waits for, from test/child-limit.ts: a child that ignores
// being asked to end can't hold up the run past it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let folder = "";
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), "skel-child-limit-test-")));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

// Bun ends a test's child with SIGTERM once the test times out, and waits for it. One that
// ignores SIGTERM would hold its worker, and the whole run, until CI kills it.
test("a child that ignores being asked to end is killed at the limit", async () => {
  const stubborn = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  writeFileSync(
    join(folder, "stubborn.test.ts"),
    `import { test } from "bun:test";
test("waits on a stubborn child", () => {
  const ended = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(stubborn)}]);
  console.log(\`ended by \${ended.signalCode}\`);
});`,
  );
  const started = Date.now();
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--timeout",
      "500",
      "--preload",
      join(import.meta.dir, "child-limit.ts"),
      "./stubborn.test.ts",
    ],
    {
      cwd: folder,
      env: { ...process.env, TEST_CHILD_LIMIT_MS: "2000" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const said = (await new Response(run.stdout).text()) + (await new Response(run.stderr).text());
  await run.exited;
  expect(said).toContain("ended by SIGKILL");
  expect(Date.now() - started).toBeLessThan(15_000);
}, 30_000);
