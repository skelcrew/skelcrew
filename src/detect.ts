// Detects a repository's setup and test commands from its files, for a repository whose
// skelcrew.yaml names none, so builders and reviewers know them without a file to commit.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// What one kind of repository says about itself: the command that sets it up, the one that
// checks it whole, such as lint, typecheck and tests together, and the one that runs its tests.
type Found = { setup?: string; check?: string; test?: string };

// What a package.json may hold that detection reads. One that isn't valid has no scripts.
const Package = z.looseObject({ scripts: z.record(z.string(), z.unknown()).optional() });

// Returns the text of a plain file at the top of the folder, or null when there is none. A link
// is never followed, since a repository's link could point at any file of yours.
function plainFile(folder: string, name: string): string | null {
  const stat = lstatSync(join(folder, name), { throwIfNoEntry: false });
  return stat?.isFile() ? readFileSync(join(folder, name), "utf8") : null;
}

// Returns a JavaScript package's commands for the package manager `run`, from the scripts in
// its package.json: its check and test scripts, and `fallback` as its test with neither.
function scriptsOf(folder: string, setup: string, run: string, fallback?: string): Found {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = Package.parse(JSON.parse(plainFile(folder, "package.json") ?? "")).scripts ?? {};
  } catch {
    // A package.json that isn't JSON still says which package manager installs it.
  }
  // `run test`, never plain `test`: `bun test` runs Bun's own test runner, not the script.
  const test = "test" in scripts ? `${run} run test` : fallback;
  return {
    setup,
    ...("check" in scripts ? { check: `${run} run check` } : {}),
    ...(test ? { test } : {}),
  };
}

// Each kind of repository: what tells it apart, and what it says about itself. They are tried in
// order, and a repository can match several, such as a package with a Makefile. A lockfile
// names its package manager, so those come before a package.json alone.
const kinds: ((folder: string, has: (name: string) => boolean) => Found | null)[] = [
  (f, has) =>
    has("bun.lock") || has("bun.lockb") ? scriptsOf(f, "bun install", "bun", "bun test") : null,
  (f, has) =>
    has("pnpm-lock.yaml") ? scriptsOf(f, "pnpm install --frozen-lockfile", "pnpm") : null,
  (f, has) => (has("yarn.lock") ? scriptsOf(f, "yarn install", "yarn") : null),
  (f, has) => (has("package-lock.json") ? scriptsOf(f, "npm ci", "npm") : null),
  (f, has) => (has("package.json") ? scriptsOf(f, "npm install", "npm") : null),
  (_, has) => (has("Cargo.toml") ? { setup: "cargo fetch", test: "cargo test" } : null),
  (_, has) => (has("go.mod") ? { setup: "go mod download", test: "go test ./..." } : null),
  (_, has) => (has("uv.lock") ? { setup: "uv sync", test: "uv run pytest" } : null),
  (_, has) => (has("poetry.lock") ? { setup: "poetry install", test: "poetry run pytest" } : null),
  // Python with neither: pytest only when the repository shows it uses it, and no setup, as
  // installing into the sandbox's system Python would fail.
  (f, has) =>
    has("pytest.ini") ||
    has("conftest.py") ||
    plainFile(f, "pyproject.toml")?.includes("[tool.pytest") ||
    plainFile(f, "setup.cfg")?.includes("[tool:pytest]")
      ? { test: "python3 -m pytest" }
      : null,
  (_, has) => (has("mix.exs") ? { setup: "mix deps.get", test: "mix test" } : null),
  // Gradle's own check runs the tests and every other check, and Maven's verify does likewise.
  (_, has) => (has("gradlew") ? { check: "./gradlew check" } : null),
  (_, has) => (has("pom.xml") ? { check: "mvn verify" } : null),
  (_, has) =>
    has("Gemfile")
      ? { setup: "bundle install", ...(has(".rspec") ? { test: "bundle exec rspec" } : {}) }
      : null,
  (f) => {
    const makefile = plainFile(f, "Makefile") ?? plainFile(f, "makefile");
    if (makefile === null) return null;
    const target = (name: string) => new RegExp(`^${name}:`, "m").test(makefile);
    return {
      ...(target("check") ? { check: "make check" } : {}),
      ...(target("test") ? { test: "make test" } : {}),
    };
  },
];

// Returns the setup and test commands the repository's files in `folder` point to, each a list
// as skelcrew.yaml holds them, empty when nothing points to one. Setup comes from the first kind
// that has one. A check runs more than the tests, so any kind's check beats every test command.
export function detectCommands(folder: string): { setup: string[]; test: string[] } {
  const has = (name: string) => plainFile(folder, name) !== null;
  const found = kinds.map((kind) => kind(folder, has)).filter((each) => each !== null);
  const setup = found.find((each) => each.setup)?.setup;
  const test = found.find((each) => each.check)?.check ?? found.find((each) => each.test)?.test;
  return { setup: setup ? [setup] : [], test: test ? [test] : [] };
}
