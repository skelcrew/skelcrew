// Finds the commands that check a repository, for the `checks` in the
// workflow.yml that `skelcrew init` writes. It only looks at a few files
// and follows fixed rules, so anyone can tell why it chose what it did:
//
// - package.json: its test script, then its check script if it has one,
//   since a check script usually runs the typecheck and lint. A check
//   script that runs the test script by name, such as `npm test`, is
//   used alone. With no check script, its test, typecheck and lint
//   scripts, in that order.
//   They run with the package manager the project uses, as
//   packageManager below finds it. A test script
//   that does nothing, such as `exit 0` or `echo "no tests" && exit 0`,
//   counts as no test script. A test script that runs no test runner
//   init knows gives a warning.
// - Cargo.toml: cargo test.
// - go.mod: go test ./...
// - pyproject.toml with a [tool.pytest] or [tool.pytest.ini_options]
//   table: pytest. Without one, there is no telling how the tests run.
// - A makefile with a test target: make test, but only when nothing else
//   was found, since that target usually runs one of the commands above.
//   The makefile is the one make itself reads: GNUmakefile, makefile or
//   Makefile, whichever comes first.
//
// A file that can't be read is skipped, and the reason says so. Nothing
// here throws.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";

// Warnings are things to look at that don't stop init, such as a test
// script that may not run any tests.
export type Detected =
  | { ok: true; checks: [string, ...string[]]; warnings: string[] }
  | { ok: false; reason: string };

export function detectChecks(dir: string): Detected {
  if (!isFolder(dir)) return { ok: false, reason: `There is no folder at ${dir}.` };

  const notes: string[] = [];
  const checks: string[] = [];
  const warnings: string[] = [];

  const node = packageChecks(dir);
  if (node.ok) {
    checks.push(...node.checks);
    warnings.push(...node.warnings);
  } else if (node.note !== null) notes.push(node.note);
  if (existsSync(join(dir, "Cargo.toml"))) checks.push("cargo test");
  if (existsSync(join(dir, "go.mod"))) checks.push("go test ./...");
  const python = pytest(dir);
  if (python.ok) checks.push("pytest");
  else if (python.note !== null) notes.push(python.note);
  if (checks.length === 0) {
    const make = makeTarget(dir, "test");
    if (make.ok) checks.push("make test");
    else if (make.note !== null) notes.push(make.note);
  }

  const [first, ...rest] = checks;
  if (first !== undefined) return { ok: true, checks: [first, ...rest], warnings };
  return {
    ok: false,
    reason: [
      "Found no checks to run in this repository.",
      ...notes,
      "Skelcrew needs at least one command that checks the code, such as the one that runs the tests.",
      "Add a test script, or write .skelcrew/workflow.yml by hand with your commands under checks.",
    ].join(" "),
  };
}

// The commands that prepare a fresh copy of the code before the checks run
// there, for the `setup` in workflow.yml. A package.json gets its
// dependencies installed by the package manager the project uses. With a
// lock file, the install keeps it as it is where that manager has a flag
// for it. Yarn 1 calls that flag --frozen-lockfile and later Yarn
// --immutable, so yarn gets a plain install. With no lock file there is
// nothing to keep, so every manager gets a plain install. Cargo and Go
// fetch what they need themselves.
export function detectSetup(dir: string): string[] {
  if (!existsSync(join(dir, "package.json"))) return [];
  const { name, lock } = packageManager(dir);
  if (!lock || name === "yarn") return [`${name} install`];
  if (name === "npm") return ["npm ci"];
  return [`${name} install --frozen-lockfile`];
}

// Only the scripts matter. Everything else in package.json is let through.
const packageSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() });

// The test script `npm init` writes. It always fails, so it isn't a check.
const npmPlaceholder = 'echo "Error: no test specified" && exit 1';

// A command that passes without testing anything. `true` and `:` are
// shell commands that do nothing. An echo only prints. A comment after
// it, such as `true # todo`, changes nothing.
const noOp = /^(exit 0|true|:|echo\b[^&|#]*)?\s*(#.*)?$/;

// The commands a script runs, split at every ;, && and ||.
function commands(script: string): string[] {
  return script.split(/;|&&|\|\|/);
}

// A test script made only of such commands tests nothing, however they
// are joined. For example `echo "no tests yet" && exit 0`, `exit 0;` or
// `echo skip; exit 0`. The script is split at every ;, && and ||. If any
// piece does something else, such as `echo start && vitest`, it counts.
function doesNothing(script: string): boolean {
  return commands(script).every((piece) => noOp.test(piece.trim()));
}

// Running the test script by name, such as `npm test` or `bun run test`,
// with words after it or none. `bun test` isn't one: it is Bun's own test
// runner. Nor is `npm run test:unit`, which is another script.
const testScript = /^(npm|pnpm|yarn|bun) run test(\s|$)|^(npm|pnpm|yarn) test(\s|$)/;

// Whether any piece of the check script runs the test script. The script
// is split as doesNothing splits it, so `tsc && npm test` counts.
function runsTestScript(check: string): boolean {
  return commands(check).some((piece) => testScript.test(piece.trim()));
}

// The test runners init knows. A test script that runs none of them may
// still test something, through a shell script for example, so it is
// only a warning. The name must stand alone: "jest" but not "jester".
const testRunners =
  /(^|[\s;&|(/])(vitest|jest|mocha|ava|tap|uvu|bun test|node --test|playwright test)(\s|$)/;

type PackageChecks =
  | { ok: true; checks: string[]; warnings: string[] }
  | { ok: false; note: string | null };

function packageChecks(dir: string): PackageChecks {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return { ok: false, note: null };
  const text = readText(path);
  if (text === null) {
    return { ok: false, note: "package.json can't be read, so its scripts were skipped." };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, note: "package.json isn't valid JSON, so its scripts were skipped." };
  }
  const parsed = packageSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, note: "package.json's scripts aren't all text, so they were skipped." };
  }

  const scripts = parsed.data.scripts ?? {};
  const has = (name: string) => {
    const script = scripts[name];
    if (script === undefined) return false;
    const trimmed = script.trim();
    if (name === "test" && doesNothing(trimmed)) return false;
    return trimmed !== "" && script !== npmPlaceholder;
  };
  // A check script usually runs the typecheck and lint, so it stands in for
  // them. The test script runs beside a check script, since a check script
  // often runs no test: SvelteKit's is "svelte-check", which checks types
  // only. But when the check script runs the test script by name, as in
  // "bun run lint && bun run test", the check script alone runs both.
  // A test runner in the check script, such as "tsc && vitest run", isn't
  // enough. It may run only some of the tests, so the test script stays,
  // and the tests run twice, which is slower but safe. Tests go first, as
  // they do without a check script.
  const check = scripts.check;
  const names = has("check")
    ? check !== undefined && runsTestScript(check)
      ? ["check"]
      : ["test", "check"].filter(has)
    : ["test", "typecheck", "lint"].filter(has);
  const run = runner(dir);
  const warnings: string[] = [];
  const test = scripts.test;
  // A test script runs either as a check of its own or through the check
  // script. Either way, it gets the warning when it runs no known runner.
  if (has("test") && test !== undefined && !testRunners.test(test)) {
    warnings.push(
      `package.json's test script is "${test}", which runs no test runner Skelcrew knows. Check that it runs your tests.`,
    );
  }
  return { ok: true, checks: names.map((name) => `${run} ${name}`), warnings };
}

// How to run a package script with the package manager the project uses.
// Yarn runs a script by its name alone, so `yarn test`.
function runner(dir: string): string {
  const { name } = packageManager(dir);
  if (name === "bun") return "bun run";
  if (name === "pnpm") return "pnpm run";
  if (name === "yarn") return "yarn";
  return "npm run";
}

type Manager = "bun" | "pnpm" | "yarn" | "npm";

// The package manager a project uses, and whether it has a lock file.
// The signs are read in this order, and the first one found wins:
//
// 1. A lock file: bun.lock or bun.lockb, pnpm-lock.yaml, yarn.lock, or
//    package-lock.json. It shows what the project was last installed with.
// 2. The packageManager field in package.json, such as "pnpm@9.12.0".
//    The developer wrote it down on purpose, and Node's Corepack reads it.
//    A name init doesn't know, such as "deno@2.0.0", is skipped.
// 3. A bunfig.toml file. It is Bun's own settings file, and no other
//    package manager reads it.
// 4. A package.json script that runs bun or bunx, such as
//    "test": "bun test". That script only works with Bun installed. A
//    Bun project with no dependencies has no lock file, since bun install
//    makes none, so this is often the only sign.
// 5. Nothing else: npm, which comes with Node.
function packageManager(dir: string): { name: Manager; lock: boolean } {
  const has = (file: string) => existsSync(join(dir, file));
  if (has("bun.lock") || has("bun.lockb")) return { name: "bun", lock: true };
  if (has("pnpm-lock.yaml")) return { name: "pnpm", lock: true };
  if (has("yarn.lock")) return { name: "yarn", lock: true };
  if (has("package-lock.json")) return { name: "npm", lock: true };
  const data = readPackage(dir);
  const named = namedSchema.safeParse(data);
  if (named.success) return { name: named.data.packageManager, lock: false };
  if (has("bunfig.toml")) return { name: "bun", lock: false };
  const scripts = packageSchema.safeParse(data);
  const runs = scripts.success ? Object.values(scripts.data.scripts ?? {}) : [];
  if (runs.some((script) => runsBun.test(script))) return { name: "bun", lock: false };
  return { name: "npm", lock: false };
}

// The packageManager field is a name, an @ and a version, sometimes with a
// hash after a +: "bun@1.3.0" or "pnpm@9.12.0+sha512.abc". Only the name
// matters here.
const namedSchema = z.object({
  packageManager: z
    .string()
    .transform((field) => field.split("@")[0])
    .pipe(z.enum(["bun", "pnpm", "yarn", "npm"])),
});

// bun or bunx as a command of its own: "bun test" or "tsc && bunx biome",
// but not "bundle" or "./bun-setup.sh".
const runsBun = /(^|[\s;&|(])(bun|bunx)(\s|$)/;

// What package.json holds, or null when it is missing or not valid JSON.
function readPackage(dir: string): unknown {
  const text = readText(join(dir, "package.json"));
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A table header on a line of its own, such as [tool.pytest.ini_options].
const pytestTable = /^\s*\[tool\.pytest(\.ini_options)?\]\s*(#.*)?$/m;

function pytest(dir: string): { ok: true } | { ok: false; note: string | null } {
  const path = join(dir, "pyproject.toml");
  if (!existsSync(path)) return { ok: false, note: null };
  const text = readText(path);
  if (text === null) return { ok: false, note: "pyproject.toml can't be read, so it was skipped." };
  return pytestTable.test(text) ? { ok: true } : { ok: false, note: null };
}

// The makefiles make reads, in the order it looks for them. It uses the
// first one it finds. The names are matched against the folder's list of
// files, since on macOS a check for "makefile" also finds "Makefile".
const makefiles = ["GNUmakefile", "makefile", "Makefile"];

// A target is a line that starts with its name and a colon, such as
// `test:` or `test: build`. A variable is not one. Make sets a variable
// with colons followed by an equals sign: `test := -v`, `test ::= -v` or
// `test :::= -v`.
function makeTarget(
  dir: string,
  target: string,
): { ok: true } | { ok: false; note: string | null } {
  const files = fileNames(dir);
  const name = makefiles.find((file) => files.includes(file));
  if (name === undefined) return { ok: false, note: null };
  const text = readText(join(dir, name));
  if (text === null) return { ok: false, note: `${name} can't be read, so it was skipped.` };
  const pattern = new RegExp(`^${target}\\s*:(?!:*=)`);
  if (text.split("\n").some((line) => pattern.test(line))) return { ok: true };
  return { ok: false, note: null };
}

// The names of the files in a folder, or none if it can't be listed.
function fileNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// The file's text, or null if it can't be read, such as a folder.
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
