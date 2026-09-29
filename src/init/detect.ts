// Finds the commands that check a repository, for the `checks` in the
// workflow.yml that `skelcrew init` writes. It only looks at a few files
// and follows fixed rules, so anyone can tell why it chose what it did:
//
// - package.json: its test script, then its check script if it has one,
//   since a check script usually runs the typecheck and lint. With no
//   check script, its test, typecheck and lint scripts, in that order.
//   They run with the package manager its lock file shows. A test script
//   that does nothing, such as `exit 0`, counts as no test script. A test
//   script that runs no test runner init knows gives a warning.
// - Cargo.toml: cargo test.
// - go.mod: go test ./...
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

// Only the scripts matter. Everything else in package.json is let through.
const packageSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() });

// The test script `npm init` writes. It always fails, so it isn't a check.
const npmPlaceholder = 'echo "Error: no test specified" && exit 1';

// Test scripts that pass without testing anything. `true` and `:` are
// shell commands that do nothing. An echo alone only prints.
const doesNothing = /^(exit 0|true|:|echo\b[^;&|]*)$/;

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
    if (name === "test" && doesNothing.test(trimmed)) return false;
    return trimmed !== "" && script !== npmPlaceholder;
  };
  // A check script usually runs the typecheck and lint, so it stands in for
  // them. The test script always runs when there is one, even beside a
  // check script. A check script often runs no test: SvelteKit's is
  // "svelte-check", which checks types only. If it does run the tests too,
  // they run twice, which is slower but safe. Tests go first, as they do
  // without a check script.
  const names = has("check")
    ? ["test", "check"].filter(has)
    : ["test", "typecheck", "lint"].filter(has);
  const run = runner(dir);
  const warnings: string[] = [];
  const test = scripts.test;
  if (names.includes("test") && test !== undefined && !testRunners.test(test)) {
    warnings.push(
      `package.json's test script is "${test}", which runs no test runner Skelcrew knows. Check that it runs your tests.`,
    );
  }
  return { ok: true, checks: names.map((name) => `${run} ${name}`), warnings };
}

// How to run a package script, from the lock file. Yarn runs a script by
// its name alone, so `yarn test`.
function runner(dir: string): string {
  const has = (file: string) => existsSync(join(dir, file));
  if (has("bun.lock") || has("bun.lockb")) return "bun run";
  if (has("pnpm-lock.yaml")) return "pnpm run";
  if (has("yarn.lock")) return "yarn";
  return "npm run";
}

// The makefiles make reads, in the order it looks for them. It uses the
// first one it finds. The names are matched against the folder's list of
// files, since on macOS a check for "makefile" also finds "Makefile".
const makefiles = ["GNUmakefile", "makefile", "Makefile"];

// A target is a line that starts with its name and a colon, such as
// `test:` or `test: build`. A variable such as `TEST := -v` is not one.
function makeTarget(
  dir: string,
  target: string,
): { ok: true } | { ok: false; note: string | null } {
  const files = fileNames(dir);
  const name = makefiles.find((file) => files.includes(file));
  if (name === undefined) return { ok: false, note: null };
  const text = readText(join(dir, name));
  if (text === null) return { ok: false, note: `${name} can't be read, so it was skipped.` };
  const pattern = new RegExp(`^${target}\\s*:(?!=)`);
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
