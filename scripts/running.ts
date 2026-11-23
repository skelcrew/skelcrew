// Loaded before each test file in CI by scripts/test.ts: notes which file and test this worker
// runs, and since when, so a run that hangs can say where. scripts/stuck.ts reads the notes.
import * as bunTest from "bun:test";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { format } from "node:util";

const folder = process.env.TEST_RUNNING;
if (folder) {
  // Named as times.json names it, from where the run started.
  const file = relative(process.cwd(), Bun.main);
  const fileSince = Date.now();
  // A test of null is a hook, or the time between tests.
  const note = (test: string | null) =>
    writeFileSync(
      join(folder, String(process.pid)),
      JSON.stringify({ file, fileSince, test, testSince: Date.now() }),
    );
  note(null);
  bunTest.afterEach(() => note(null));
  // Bun's hooks don't say which test runs, so each test notes its own name as it starts. A test
  // of test.each notes its name as Bun fills it in from the row, close enough to find it. What
  // test.skipIf or test.each give back, to make a test with, notes the same way. Each body
  // keeps its number of parameters, by which Bun tells a test that takes a done callback.
  const named = <T extends (...args: never[]) => unknown>(register: T): T =>
    new Proxy(register, {
      apply(target, self, [name, body, ...rest]) {
        const run =
          typeof body === "function"
            ? Object.defineProperty(
                function (this: unknown, ...args: unknown[]) {
                  note(args.length > 0 ? format(String(name), ...args) : String(name));
                  return Reflect.apply(body, this, args);
                },
                "length",
                { value: body.length },
              )
            : body;
        return Reflect.apply(target, self, [name, run, ...rest]);
      },
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const made = Reflect.apply(value, target, args);
          return typeof made === "function" ? named(made) : made;
        };
      },
    });
  bunTest.mock.module("bun:test", () => ({ ...bunTest, test: named(bunTest.test) }));
}
