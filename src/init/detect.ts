// Finds the commands that check a repository, for the `checks` in the
// workflow.yml that `skelcrew init` writes. It only looks at a few files
// and follows fixed rules, so anyone can tell why it chose what it did:
//
// - package.json: its test script, then its check script if it has one,
//   since a check script usually runs the typecheck and lint. With no
//   check script, its test, typecheck and lint scripts, in that order.
//   They run with the package manager its lock file shows.
// - Cargo.toml: cargo test.
// - go.mod: go test ./...
// - A Makefile with a test target: make test, but only when nothing else
//   was found, since that target usually runs one of the commands above.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";

export type Detected = { ok: true; checks: [string, ...string[]] } | { ok: false; reason: string };

export function detectChecks(dir: string): Detected {
  if (!isFolder(dir)) return { ok: false, reason: `There is no folder at ${dir}.` };

  const notes: string[] = [];
  const checks: string[] = [];

  const node = packageChecks(dir);
  if (node.ok) checks.push(...node.checks);
  else if (node.note !== null) notes.push(node.note);
  if (existsSync(join(dir, "Cargo.toml"))) checks.push("cargo test");
  if (existsSync(join(dir, "go.mod"))) checks.push("go test ./...");
  if (checks.length === 0 && hasMakeTarget(dir, "test")) checks.push("make test");

  const [first, ...rest] = checks;
  if (first !== undefined) return { ok: true, checks: [first, ...rest] };
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

type PackageChecks = { ok: true; checks: string[] } | { ok: false; note: string | null };

function packageChecks(dir: string): PackageChecks {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return { ok: false, note: null };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
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
    return script !== undefined && script.trim() !== "" && script !== npmPlaceholder;
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
  return { ok: true, checks: names.map((name) => `${run} ${name}`) };
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

// A target is a line that starts with its name and a colon, such as
// `test:` or `test: build`. A variable such as `TEST := -v` is not one.
function hasMakeTarget(dir: string, target: string): boolean {
  const path = join(dir, "Makefile");
  if (!existsSync(path)) return false;
  const pattern = new RegExp(`^${target}\\s*:(?!=)`);
  return readFileSync(path, "utf8")
    .split("\n")
    .some((line) => pattern.test(line));
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
