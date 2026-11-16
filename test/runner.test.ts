// The test runner, scripts/test.ts: a run that goes past its time limit is stopped and fails.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
