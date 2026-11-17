// Loaded before each test file in CI, by scripts/test.ts: writes how long the whole file took to
// the file TEST_FILE_TIMES names. Bun's report counts only the tests, not a file's imports and
// hooks, so a slow beforeAll would hide there.
import { afterAll } from "bun:test";
import { appendFileSync } from "node:fs";
import { relative } from "node:path";

const times = process.env.TEST_FILE_TIMES;
if (times) {
  const start = performance.now();
  // Bun.main is the test file, named as Bun's report names it, from where the run started.
  const file = relative(process.cwd(), Bun.main);
  // A preload's afterAll runs after the file's own, so the time covers its hooks. Workers run at
  // once, and each writes one short line, so appending keeps them apart.
  afterAll(() => {
    const seconds = (performance.now() - start) / 1000;
    appendFileSync(times, `${JSON.stringify({ file, seconds })}\n`);
  });
}
