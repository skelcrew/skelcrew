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

// What a pyproject.toml may hold that says whether the repository uses pytest: its settings
// under [tool.pytest], and the places dependencies are declared, PEP 621's and PEP 735's as
// requirement strings and Poetry's as tables keyed by package name.
// Each part is optional, and one of the wrong shape counts as missing, so a pyproject.toml
// detection can't make sense of shows no pytest rather than stop the settings.
const Requirements = z.array(z.unknown()).optional().catch(undefined);
const Lists = z.record(z.string(), z.array(z.unknown())).optional().catch(undefined);
const Table = z.record(z.string(), z.unknown()).optional().catch(undefined);
const Poetry = z.looseObject({
  dependencies: Table,
  "dev-dependencies": Table,
  group: z
    .record(z.string(), z.looseObject({ dependencies: Table }))
    .optional()
    .catch(undefined),
});
const Pyproject = z.looseObject({
  project: z
    .looseObject({ dependencies: Requirements, "optional-dependencies": Lists })
    .optional()
    .catch(undefined),
  "dependency-groups": Lists,
  tool: z
    .looseObject({ pytest: z.unknown().optional(), poetry: Poetry.optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

// Where a repository's pytest comes from: installed by default, an optional-dependency extra, or
// a dependency group, which is only installed when named.
type Pytest = { extra?: string; group?: string };

// Returns where a pyproject.toml shows the repository's pytest comes from, or null when it shows
// none. Only a dependency on pytest or its settings section counts, never a mention elsewhere,
// such as in a description or a comment, as a wrong guess gives reviewers a command the
// repository can't run. A default dependency wins over an extra, and an extra over a group, so
// the commands ask for no more than they need. An extra or group whose name a shell would read
// as more than a word is skipped, as the name goes into a command. A file that isn't valid TOML
// shows nothing.
function pytestIn(pyproject: string): Pytest | null {
  let read: z.infer<typeof Pyproject>;
  try {
    read = Pyproject.parse(Bun.TOML.parse(pyproject));
  } catch {
    return null;
  }
  const { project, tool } = read;
  const poetry = tool?.poetry;
  // A requirement names its package first, such as "pytest>=8" or "pytest[testing]". Poetry's
  // tables name it as a key.
  const named = (requirements: unknown[] | undefined) =>
    (requirements ?? []).some(
      (each) => typeof each === "string" && /^\s*pytest(?![\w.-])/i.test(each),
    );
  const keyed = (table: Record<string, unknown> | undefined) =>
    table !== undefined && "pytest" in table;
  const word = (name: string) => /^[\w.-]+$/.test(name);
  if (
    named(project?.dependencies) ||
    keyed(poetry?.dependencies) ||
    keyed(poetry?.["dev-dependencies"])
  )
    return {};
  const extra = Object.entries(project?.["optional-dependencies"] ?? {}).find(
    ([name, requirements]) => word(name) && named(requirements),
  );
  if (extra) return { extra: extra[0] };
  const group =
    Object.entries(read["dependency-groups"] ?? {}).find(
      ([name, requirements]) => word(name) && named(requirements),
    ) ??
    Object.entries(poetry?.group ?? {}).find(
      ([name, group]) => word(name) && keyed(group.dependencies),
    );
  if (group) return { group: group[0] };
  // Settings alone say pytest is used, but not where it comes from, so it is taken as installed.
  return tool?.pytest !== undefined ? {} : null;
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
  // Python: a lockfile names its package manager, which sets it up and runs the tests, but not
  // its test runner. So pytest only when the repository shows it uses it, and with no lockfile,
  // no setup, as installing into the sandbox's system Python would fail.
  (f, has) => {
    const fromPyproject = pytestIn(f["pyproject.toml"] ?? "");
    const pytest: Pytest | null =
      fromPyproject ??
      (has("pytest.ini") || has("conftest.py") || f["setup.cfg"]?.includes("[tool:pytest]")
        ? {}
        : null);
    // The extra or group pytest comes from, as each package manager asks for it.
    const uv = pytest?.extra
      ? ` --extra ${pytest.extra}`
      : pytest?.group
        ? ` --group ${pytest.group}`
        : "";
    const poetry = pytest?.extra
      ? ` --extras ${pytest.extra}`
      : pytest?.group
        ? ` --with ${pytest.group}`
        : "";
    const tool = has("uv.lock")
      ? { setup: `uv sync${uv}`, run: `uv run${uv} pytest` }
      : has("poetry.lock")
        ? { setup: `poetry install${poetry}`, run: "poetry run pytest" }
        : { run: "python3 -m pytest" };
    if (!pytest && !tool.setup) return null;
    return { ...(tool.setup ? { setup: tool.setup } : {}), ...(pytest ? { test: tool.run } : {}) };
  },
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
