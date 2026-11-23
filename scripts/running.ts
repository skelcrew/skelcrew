// Loaded before each test file in CI by scripts/test.ts: notes which file and test this worker
// runs, and since when, so a run that hangs can say where. scripts/stuck.ts reads the notes.
import * as bunTest from "bun:test";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const folder = process.env.TEST_RUNNING;
if (folder) {
  // Named as times.json names it, from where the run started.
  const file = relative(process.cwd(), Bun.main);
  const fileSince = Date.now();
  // A test of null is a hook, or a test made with test.each or test.skipIf, whose name this
  // doesn't see.
  const note = (test: string | null) =>
    writeFileSync(
      join(folder, String(process.pid)),
      JSON.stringify({ file, fileSince, test, testSince: Date.now() }),
    );
  note(null);
  bunTest.afterEach(() => note(null));
  // Bun's hooks don't say which test runs, so each test notes its own name as it starts. The
  // test's own functions, such as test.skipIf, still get Bun's test as `this`.
  const named = new Proxy(bunTest.test, {
    apply(test, self, [name, body, ...rest]) {
      const run =
        typeof body === "function"
          ? function (this: unknown, ...args: unknown[]) {
              note(String(name));
              return Reflect.apply(body, this, args);
            }
          : body;
      return Reflect.apply(test, self, [name, run, ...rest]);
    },
    get(test, key) {
      const value = Reflect.get(test, key);
      return typeof value === "function" ? value.bind(test) : value;
    },
  });
  bunTest.mock.module("bun:test", () => ({ ...bunTest, test: named }));
}
