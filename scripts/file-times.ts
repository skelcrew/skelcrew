// Loaded before each test file in CI, by scripts/test.ts: writes how long the whole file took to
// the file TEST_FILE_TIMES names. Bun's report can't give this: its time for a file leaves out
// the file's hooks, so a slow beforeAll would hide there. In Bun 1.3.14, a file whose beforeAll
// takes 1 s and afterAll 0.5 s, with one instant test, has <testsuite time="0">.
import { afterAll } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { z } from "zod";

const times = process.env.TEST_FILE_TIMES;
if (times) {
  // A worker runs its files one after another, and this loads after the preloads bunfig.toml
  // names. So a file's time runs from when the worker ended its last file, or from when the
  // worker started, and those preloads count too. performance.now() counts from the worker's
  // start, whichever file it is on. The worker notes each end in a file of its own.
  const lastEnd = `${times}.${process.pid}`;
  const start = existsSync(lastEnd) ? z.coerce.number().parse(readFileSync(lastEnd, "utf8")) : 0;
  // Bun.main is the test file, named as Bun's report names it, from where the run started.
  const file = relative(process.cwd(), Bun.main);
  // A preload passed to bun test runs its afterAll after the file's own and bunfig.toml's
  // preloads', so the time covers them. Workers run at once, and each writes one short line,
  // so appending keeps them apart.
  afterAll(() => {
    const end = performance.now();
    writeFileSync(lastEnd, String(end));
    appendFileSync(times, `${JSON.stringify({ file, seconds: (end - start) / 1000 })}\n`);
  });
}
