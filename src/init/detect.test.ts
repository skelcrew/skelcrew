import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectChecks, detectSetup } from "./detect";

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

// The package.json from Skelcrew's first real run. It has no
// dependencies, so bun install makes no lock file.
const bunWithoutLock = JSON.stringify({
  name: "app",
  type: "module",
  scripts: { test: "bun test" },
});

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

  // Skelcrew's first real run: a Bun project with no dependencies, so
  // bun install made no lock file. Init chose npm run test.
  test("runs a Bun project's scripts with bun when there is no lock file", () => {
    const found = detectChecks(repo({ "package.json": bunWithoutLock }));
    expect(found).toEqual({ ok: true, checks: ["bun run test"], warnings: [] });
  });

  test("uses the package manager package.json names when there is no lock file", () => {
    const named = (packageManager: string) =>
      detectChecks(
        repo({ "package.json": JSON.stringify({ packageManager, scripts: { test: "vitest" } }) }),
      );
    expect(named("bun@1.3.0")).toEqual({ ok: true, checks: ["bun run test"], warnings: [] });
    expect(named("pnpm@9.12.0")).toEqual({ ok: true, checks: ["pnpm run test"], warnings: [] });
    expect(named("yarn@4.5.0")).toEqual({ ok: true, checks: ["yarn test"], warnings: [] });
  });

  // package.json names pnpm, but the test script runs bun. The name says
  // what the developer chose, so it wins.
  test("goes by the named package manager over a script that runs bun", () => {
    const found = detectChecks(
      repo({
        "package.json": JSON.stringify({
          packageManager: "pnpm@9.12.0",
          scripts: { test: "bun test" },
        }),
      }),
    );
    expect(found).toEqual({ ok: true, checks: ["pnpm run test"], warnings: [] });
  });

  test("goes by the lock file over every other sign", () => {
    const found = detectChecks(
      repo({
        "package.json": JSON.stringify({
          packageManager: "bun@1.3.0",
          scripts: { test: "bun test" },
        }),
        "yarn.lock": "",
      }),
    );
    expect(found).toEqual({ ok: true, checks: ["yarn test"], warnings: [] });
  });

  // A packageManager init doesn't know, or one that isn't text, is ignored.
  // The scripts are still read.
  test("ignores a packageManager it doesn't know", () => {
    for (const packageManager of ["deno@2.0.0", 42]) {
      const found = detectChecks(
        repo({ "package.json": JSON.stringify({ packageManager, scripts: { test: "vitest" } }) }),
      );
      expect(found).toEqual({ ok: true, checks: ["npm run test"], warnings: [] });
    }
  });

  test("runs a package's scripts with bun when there is a bunfig.toml", () => {
    const dir = repo({ "package.json": packageJson({ test: "vitest" }), "bunfig.toml": "" });
    expect(detectChecks(dir)).toEqual({ ok: true, checks: ["bun run test"], warnings: [] });
    expect(detectSetup(dir)).toEqual(["bun install"]);
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

  // Skelcrew's own check script. Running the test script beside it would
  // run the tests twice.
  test("runs only the check script when it runs the test script", () => {
    const found = detectChecks(
      repo({
        "package.json": packageJson({
          check: "bun run lint && bun run typecheck && bun run test",
          test: "bun test",
        }),
        "bun.lock": "",
      }),
    );
    expect(found).toEqual({ ok: true, checks: ["bun run check"], warnings: [] });
  });

  test("counts the test script run by name with any package manager", () => {
    for (const run of [
      "npm run test",
      "pnpm run test",
      "yarn run test",
      "bun run test",
      "npm test",
      "pnpm test",
      "yarn test",
    ]) {
      for (const check of [run, `tsc; ${run}`, `tsc && ${run} || exit 1`, `${run} -- --coverage`]) {
        const found = detectChecks(
          repo({ "package.json": packageJson({ check, test: "vitest" }), "package-lock.json": "" }),
        );
        expect({ check, found }).toEqual({
          check,
          found: { ok: true, checks: ["npm run check"], warnings: [] },
        });
      }
    }
  });

  // Only the test script itself counts. `bun test` is Bun's own test
  // runner, and a runner may run only some of the tests.
  test("keeps the test script when the check script doesn't run it by name", () => {
    for (const check of [
      "npm run test:unit",
      "bun run tests",
      "bun test",
      "tsc && vitest run",
      "npm run testing",
      "echo npm test",
    ]) {
      const found = detectChecks(
        repo({ "package.json": packageJson({ check, test: "vitest" }), "package-lock.json": "" }),
      );
      expect({ check, found }).toEqual({
        check,
        found: { ok: true, checks: ["npm run test", "npm run check"], warnings: [] },
      });
    }
  });

  test("still warns about a test script run only through the check script", () => {
    const found = detectChecks(
      repo({
        "package.json": packageJson({ check: "npm run test", test: "./scripts/run-all.sh" }),
      }),
    );
    expect(found.ok && found.checks).toEqual(["npm run check"]);
    const warnings = found.ok ? found.warnings : [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("./scripts/run-all.sh");
  });

  test("gives no warning when the check script runs a test script that does nothing", () => {
    const found = detectChecks(
      repo({ "package.json": packageJson({ check: "npm run test", test: "exit 0" }) }),
    );
    expect(found).toEqual({ ok: true, checks: ["npm run check"], warnings: [] });
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

  // Several do-nothing commands joined together still do nothing.
  test("skips a test script made only of commands that do nothing", () => {
    for (const test of [
      'echo "no tests yet" && exit 0',
      "exit 0;",
      "true # todo",
      "echo skip; exit 0",
      "echo a || true",
      ": ; true ;; ",
    ]) {
      const found = detectChecks(repo({ "package.json": packageJson({ test }) }));
      expect(found.ok).toBe(false);
    }
  });

  test("keeps a test script that runs something beside a do-nothing command", () => {
    // A script that runs bun shows a Bun project, so it runs with bun.
    for (const { test, check } of [
      { test: "echo start && vitest", check: "npm run test" },
      { test: "vitest; exit 0", check: "npm run test" },
      { test: "true && bun test", check: "bun run test" },
    ]) {
      const found = detectChecks(repo({ "package.json": packageJson({ test }) }));
      expect(found.ok && found.checks).toEqual([check]);
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

  test("runs pytest for a Python project that sets up pytest", () => {
    for (const table of ["[tool.pytest.ini_options]", "[tool.pytest]"]) {
      const pyproject = `[project]\nname = "app"\n\n${table}\ntestpaths = ["tests"]\n`;
      expect(detectChecks(repo({ "pyproject.toml": pyproject }))).toEqual({
        ok: true,
        checks: ["pytest"],
        warnings: [],
      });
    }
  });

  // Without pytest's settings there is no telling how the tests run.
  test("doesn't guess a test command for a pyproject.toml without pytest", () => {
    const pyproject = '[project]\nname = "app"\ndependencies = ["pytest-cov"]\n';
    expect(detectChecks(repo({ "pyproject.toml": pyproject })).ok).toBe(false);
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

  // GNU make also sets a variable with ::= and :::=.
  test("doesn't take a variable set with ::= or :::= for a test target", () => {
    for (const line of ["test ::= -v", "test :::= -v", "test::=-v"]) {
      const makefile = `${line}\nbuild:\n\tgo build ./...\n`;
      expect(detectChecks(repo({ Makefile: makefile })).ok).toBe(false);
    }
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

// The checks run in a fresh copy of the code, which has no dependencies
// installed. The setup installs them first, with the project's package
// manager.
describe("detectSetup", () => {
  test("installs a package's dependencies from its lock file, without changing it", () => {
    const withLock = (lock: string) =>
      detectSetup(repo({ "package.json": packageJson({ test: "vitest" }), [lock]: "" }));
    expect(withLock("bun.lock")).toEqual(["bun install --frozen-lockfile"]);
    expect(withLock("bun.lockb")).toEqual(["bun install --frozen-lockfile"]);
    expect(withLock("pnpm-lock.yaml")).toEqual(["pnpm install --frozen-lockfile"]);
    expect(withLock("package-lock.json")).toEqual(["npm ci"]);
  });

  // Yarn 1 and later Yarn name the flag that keeps the lock file
  // differently, so plain yarn install works with both.
  test("installs with plain yarn install for yarn", () => {
    const dir = repo({ "package.json": packageJson({ test: "vitest" }), "yarn.lock": "" });
    expect(detectSetup(dir)).toEqual(["yarn install"]);
  });

  test("installs with npm install when there is no lock file", () => {
    const dir = repo({ "package.json": packageJson({ test: "vitest" }) });
    expect(detectSetup(dir)).toEqual(["npm install"]);
  });

  test("installs with bun install for a Bun project with no lock file", () => {
    expect(detectSetup(repo({ "package.json": bunWithoutLock }))).toEqual(["bun install"]);
  });

  test("installs with the package manager package.json names when there is no lock file", () => {
    const named = (packageManager: string) =>
      detectSetup(repo({ "package.json": JSON.stringify({ packageManager }) }));
    expect(named("bun@1.3.0")).toEqual(["bun install"]);
    expect(named("pnpm@9.12.0")).toEqual(["pnpm install"]);
    expect(named("yarn@4.5.0")).toEqual(["yarn install"]);
    expect(named("npm@10.8.0")).toEqual(["npm install"]);
  });

  test("installs from the lock file over every other sign", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        packageManager: "bun@1.3.0",
        scripts: { test: "bun test" },
      }),
      "package-lock.json": "",
    });
    expect(detectSetup(dir)).toEqual(["npm ci"]);
  });

  test("sets up nothing without a package.json", () => {
    expect(detectSetup(repo({ "Cargo.toml": "[package]\n" }))).toEqual([]);
    expect(detectSetup(repo({ "go.mod": "module app\n" }))).toEqual([]);
  });
});
