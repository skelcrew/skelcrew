// Detects a repository's setup and test commands from the files at its top, for a repository
// whose skelcrew.yaml names none, so builders and reviewers know them without a file to commit.
// Pure: the settings loader reads the files and hands them in.
import { z } from "zod";

// The top-level files detection looks at, by name. Only those in `readsText` are read; for the
// rest, being there is enough, as a lockfile can be megabytes.
export const looksAt = [
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "uv.lock",
  "poetry.lock",
  "pytest.ini",
  "conftest.py",
  "pyproject.toml",
  "setup.cfg",
  "mix.exs",
  "gradlew",
  "pom.xml",
  "Gemfile",
  ".rspec",
  "Makefile",
  "makefile",
];
export const readsText = ["package.json", "pyproject.toml", "setup.cfg", "Makefile", "makefile"];

// The files a repository has at its top, among those detection looks at, each with its text,
// or "" for one whose text isn't read.
export type TopFiles = Record<string, string>;

// What one kind of repository says about itself: the command that sets it up, the one that
// checks it whole, such as lint, typecheck and tests together, and the one that runs its tests.
type Found = { setup?: string; check?: string; test?: string };

// What a package.json may hold that detection reads. One that isn't valid has no scripts.
const Package = z.looseObject({ scripts: z.record(z.string(), z.unknown()).optional() });

// Returns a JavaScript package's commands for the package manager `run`, from the scripts in
// its package.json: its check and test scripts, and `fallback` as its test with neither.
function scriptsOf(files: TopFiles, setup: string, run: string, fallback?: string): Found {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = Package.parse(JSON.parse(files["package.json"] ?? "")).scripts ?? {};
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
const kinds: ((files: TopFiles, has: (name: string) => boolean) => Found | null)[] = [
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
    f["pyproject.toml"]?.includes("[tool.pytest") ||
    f["setup.cfg"]?.includes("[tool:pytest]")
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
    const makefile = f.Makefile ?? f.makefile;
    if (makefile === undefined) return null;
    // Each rule's targets: what comes before the colon on a line that doesn't start with a
    // tab, as a recipe does. A rule can name several, with spaces around them. `:=` and `::=`
    // set a variable instead, and a line with `=` before any colon does too.
    const targets = makefile.split("\n").flatMap(
      (line) =>
        line
          .match(/^([^\t:=#][^:=#]*):(?!:?=)/)?.[1]
          ?.trim()
          .split(/\s+/) ?? [],
    );
    const target = (name: string) => targets.includes(name);
    return {
      ...(target("check") ? { check: "make check" } : {}),
      ...(target("test") ? { test: "make test" } : {}),
    };
  },
];

// Returns the setup and test commands a repository's top-level files point to, each a list as
// skelcrew.yaml holds them, empty when nothing points to one. Setup comes from the first kind
// that has one. A check runs more than the tests, so any kind's check beats every test command.
export function detectCommands(files: TopFiles): { setup: string[]; test: string[] } {
  const has = (name: string) => name in files;
  const found = kinds.map((kind) => kind(files, has)).filter((each) => each !== null);
  const setup = found.find((each) => each.setup)?.setup;
  const test = found.find((each) => each.check)?.check ?? found.find((each) => each.test)?.test;
  return { setup: setup ? [setup] : [], test: test ? [test] : [] };
}
