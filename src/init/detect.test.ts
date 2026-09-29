import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectChecks } from "./detect";

let dirs: string[] = [];
// A throwaway repository folder holding the files it is given.
function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "skelcrew-detect-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function packageJson(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "app", scripts });
}

const allThree = { lint: "biome ci .", typecheck: "tsc", test: "vitest" };

describe("detectChecks", () => {
  test("runs a package's scripts with npm when there is no lock file", () => {
    const found = detectChecks(repo({ "package.json": packageJson(allThree) }));
    expect(found).toEqual({
      ok: true,
      checks: ["npm run test", "npm run typecheck", "npm run lint"],
      warnings: [],
    });
  });

  test("uses the package manager the lock file shows", () => {
    const withLock = (lock: string) =>
      detectChecks(repo({ "package.json": packageJson({ test: "vitest" }), [lock]: "" }));
    expect(withLock("bun.lock")).toEqual({ ok: true, checks: ["bun run test"], warnings: [] });
    expect(withLock("bun.lockb")).toEqual({ ok: true, checks: ["bun run test"], warnings: [] });
    expect(withLock("pnpm-lock.yaml")).toEqual({
      ok: true,
      checks: ["pnpm run test"],
      warnings: [],
    });
    expect(withLock("yarn.lock")).toEqual({ ok: true, checks: ["yarn test"], warnings: [] });
    expect(withLock("package-lock.json")).toEqual({
      ok: true,
      checks: ["npm run test"],
      warnings: [],
    });
  });

  test("uses a check script in place of the typecheck and lint scripts", () => {
    const found = detectChecks(
      repo({
        "package.json": packageJson({
          typecheck: "tsc",
          lint: "biome ci .",
          check: "tsc && biome ci .",
        }),
        "bun.lock": "",
      }),
    );
    expect(found).toEqual({ ok: true, checks: ["bun run check"], warnings: [] });
  });

  // SvelteKit's template has "check": "svelte-check", which checks types
  // only, with the tests in "test". A check script alone would run no test.
  test("runs the test script as well as a check script", () => {
    const found = detectChecks(
      repo({
        "package.json": packageJson({
          check: "svelte-check --tsconfig ./tsconfig.json",
          test: "vitest",
        }),
        "bun.lock": "",
      }),
    );
    expect(found).toEqual({ ok: true, checks: ["bun run test", "bun run check"], warnings: [] });
  });

  test("ignores scripts it doesn't know, such as build and dev", () => {
    const found = detectChecks(
      repo({ "package.json": packageJson({ build: "tsc", dev: "vite", test: "vitest" }) }),
    );
    expect(found).toEqual({ ok: true, checks: ["npm run test"], warnings: [] });
  });

  // `npm init` writes this test script. It always fails, so it isn't a check.
  test("skips the placeholder test script npm init writes", () => {
    const found = detectChecks(
      repo({
        "package.json": packageJson({ test: 'echo "Error: no test specified" && exit 1' }),
      }),
    );
    expect(found.ok).toBe(false);
  });

  // A test script like "exit 0" always passes, so it would pass every gate
  // without testing anything.
  test("skips a test script that does nothing", () => {
    for (const test of ["exit 0", "true", ":", 'echo "no tests yet"', "echo"]) {
      const found = detectChecks(repo({ "package.json": packageJson({ test }) }));
      expect(found.ok).toBe(false);
    }
  });

  test("still runs the other scripts when the test script does nothing", () => {
    const found = detectChecks(
      repo({ "package.json": packageJson({ test: "exit 0", lint: "biome ci ." }) }),
    );
    expect(found).toEqual({ ok: true, checks: ["npm run lint"], warnings: [] });
  });

  test("gives no warning when the test script runs a known test runner", () => {
    for (const test of [
      "vitest run",
      "jest --ci",
      "bun test",
      "node --test",
      "mocha",
      "npx vitest",
    ]) {
      const found = detectChecks(repo({ "package.json": packageJson({ test }) }));
      expect(found.ok && found.warnings).toEqual([]);
    }
  });

  test("warns when the test script runs no test runner it knows", () => {
    const found = detectChecks(
      repo({ "package.json": packageJson({ test: "./scripts/run-all.sh" }) }),
    );
    expect(found.ok && found.checks).toEqual(["npm run test"]);
    const warnings = found.ok ? found.warnings : [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("./scripts/run-all.sh");
  });

  test("runs cargo test for a Rust crate", () => {
    expect(detectChecks(repo({ "Cargo.toml": "[package]\nname = 'app'\n" }))).toEqual({
      ok: true,
      checks: ["cargo test"],
      warnings: [],
    });
  });

  test("runs go test for a Go module", () => {
    expect(detectChecks(repo({ "go.mod": "module example.com/app\n" }))).toEqual({
      ok: true,
      checks: ["go test ./..."],
      warnings: [],
    });
  });

  test("runs make test for a Makefile with a test target", () => {
    const makefile = "build:\n\tcc -o app app.c\n\ntest: build\n\t./app --self-test\n";
    expect(detectChecks(repo({ Makefile: makefile }))).toEqual({
      ok: true,
      checks: ["make test"],
      warnings: [],
    });
  });

  test("doesn't run make test when the Makefile has no test target", () => {
    const makefile = "build:\n\tcc -o app app.c\nTEST_FLAGS := -v\n";
    expect(detectChecks(repo({ Makefile: makefile })).ok).toBe(false);
  });

  test("doesn't take a variable named test for a test target", () => {
    const makefile = "test := -v\nbuild:\n\tgo build ./...\n";
    expect(detectChecks(repo({ Makefile: makefile })).ok).toBe(false);
  });

  // A Makefile's test target usually wraps the project's own test command,
  // so running both would run the tests twice.
  test("leaves out make test when another check was found", () => {
    const found = detectChecks(
      repo({ "go.mod": "module example.com/app\n", Makefile: "test:\n\tgo test ./...\n" }),
    );
    expect(found).toEqual({ ok: true, checks: ["go test ./..."], warnings: [] });
  });

  test("finds the checks of every language in the repository", () => {
    const found = detectChecks(
      repo({
        "package.json": packageJson({ test: "vitest" }),
        "Cargo.toml": "[package]\nname = 'core'\n",
        "go.mod": "module example.com/app\n",
      }),
    );
    expect(found).toEqual({
      ok: true,
      checks: ["npm run test", "cargo test", "go test ./..."],
      warnings: [],
    });
  });

  test("says plainly when it finds nothing to run", () => {
    const found = detectChecks(repo({ "README.md": "# app\n" }));
    expect(found.ok).toBe(false);
    const reason = !found.ok ? found.reason : "";
    expect(reason).toContain("Found no checks to run");
    expect(reason).toContain("workflow.yml");
  });

  test("skips a package.json it can't read, and says so if nothing else is found", () => {
    const found = detectChecks(repo({ "package.json": "{ not json" }));
    expect(found.ok).toBe(false);
    const reason = !found.ok ? found.reason : "";
    expect(reason).toContain("package.json");
  });

  // make reads GNUmakefile first, then makefile, then Makefile.
  test("reads the makefile make would read", () => {
    const target = "test:\n\t./self-test\n";
    for (const name of ["GNUmakefile", "makefile"]) {
      expect(detectChecks(repo({ [name]: target }))).toEqual({
        ok: true,
        checks: ["make test"],
        warnings: [],
      });
    }
    const both = repo({ GNUmakefile: "build:\n\tcc app.c\n", Makefile: target });
    expect(detectChecks(both).ok).toBe(false);
  });

  // A folder where a file should be can't be read. That must end in an
  // answer, not a crash.
  test("says what it couldn't read instead of failing", () => {
    for (const name of ["Makefile", "package.json"]) {
      const dir = repo();
      mkdirSync(join(dir, name));
      const found = detectChecks(dir);
      expect(found.ok).toBe(false);
      expect(!found.ok && found.reason).toContain(name);
    }
  });

  test("says so when the folder doesn't exist", () => {
    const found = detectChecks(join(tmpdir(), "skelcrew-no-such-folder"));
    expect(found.ok).toBe(false);
    const reason = !found.ok ? found.reason : "";
    expect(reason).toContain("There is no folder");
  });
});
