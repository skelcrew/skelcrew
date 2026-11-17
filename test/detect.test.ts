// Detecting a repository's setup and test commands from its top-level files, for a repository
// whose skelcrew.yaml names none. Each sample is a checkout's files, as the loader hands them in.
import { expect, test } from "bun:test";
import { detectCommands } from "../src/detect.ts";

// A package.json with these scripts.
const scripts = (...names: string[]) =>
  JSON.stringify({ scripts: Object.fromEntries(names.map((n) => [n, "true"])) });

test("bun prefers a check script, then a test script, then bun test", () => {
  expect(detectCommands({ "bun.lock": "", "package.json": scripts("test", "check") })).toEqual({
    setup: ["bun install"],
    test: ["bun run check"],
  });
  expect(detectCommands({ "bun.lock": "", "package.json": scripts("test") })).toEqual({
    setup: ["bun install"],
    test: ["bun run test"],
  });
  expect(detectCommands({ "bun.lock": "", "package.json": scripts() })).toEqual({
    setup: ["bun install"],
    test: ["bun test"],
  });
});

test("bun's older binary lockfile counts too", () => {
  expect(detectCommands({ "bun.lockb": "", "package.json": "{}" })).toEqual({
    setup: ["bun install"],
    test: ["bun test"],
  });
});

test("npm, pnpm and yarn by their lockfile and scripts", () => {
  expect(detectCommands({ "package-lock.json": "", "package.json": scripts("test") })).toEqual({
    setup: ["npm ci"],
    test: ["npm run test"],
  });
  expect(
    detectCommands({ "pnpm-lock.yaml": "", "package.json": scripts("check", "test") }),
  ).toEqual({ setup: ["pnpm install --frozen-lockfile"], test: ["pnpm run check"] });
  expect(detectCommands({ "yarn.lock": "", "package.json": scripts("test") })).toEqual({
    setup: ["yarn install"],
    test: ["yarn run test"],
  });
});

test("a package.json with no lockfile installs with npm, and has no tests without a script", () => {
  expect(detectCommands({ "package.json": scripts() })).toEqual({
    setup: ["npm install"],
    test: [],
  });
});

test("a package.json that isn't valid gives no scripts", () => {
  expect(detectCommands({ "bun.lock": "", "package.json": "{ not json" })).toEqual({
    setup: ["bun install"],
    test: ["bun test"],
  });
});

test("Cargo, Go, Elixir, Maven, Gradle and Ruby", () => {
  expect(detectCommands({ "Cargo.toml": "" })).toEqual({
    setup: ["cargo fetch"],
    test: ["cargo test"],
  });
  expect(detectCommands({ "go.mod": "" })).toEqual({
    setup: ["go mod download"],
    test: ["go test ./..."],
  });
  expect(detectCommands({ "mix.exs": "" })).toEqual({
    setup: ["mix deps.get"],
    test: ["mix test"],
  });
  expect(detectCommands({ "pom.xml": "" })).toEqual({ setup: [], test: ["mvn verify"] });
  expect(detectCommands({ gradlew: "" })).toEqual({ setup: [], test: ["./gradlew check"] });
  expect(detectCommands({ Gemfile: "" })).toEqual({ setup: ["bundle install"], test: [] });
  expect(detectCommands({ Gemfile: "", ".rspec": "" })).toEqual({
    setup: ["bundle install"],
    test: ["bundle exec rspec"],
  });
});

test("Python with uv, poetry, or neither, runs pytest only where the repository uses it", () => {
  const usesPytest = '[project]\ndependencies = ["pytest"]\n';
  expect(detectCommands({ "uv.lock": "", "pyproject.toml": usesPytest })).toEqual({
    setup: ["uv sync"],
    test: ["uv run pytest"],
  });
  expect(detectCommands({ "poetry.lock": "", "pyproject.toml": "", "conftest.py": "" })).toEqual({
    setup: ["poetry install"],
    test: ["poetry run pytest"],
  });
  const pytest = { setup: [], test: ["python3 -m pytest"] };
  expect(detectCommands({ "pyproject.toml": "[tool.pytest.ini_options]\n" })).toEqual(pytest);
  expect(detectCommands({ "setup.cfg": "[tool:pytest]\n" })).toEqual(pytest);
  expect(detectCommands({ "pytest.ini": "" })).toEqual(pytest);
  expect(detectCommands({ "pyproject.toml": "[project]\n" })).toEqual({ setup: [], test: [] });
});

// pyproject.toml shows pytest by a dependency on it, in PEP 621's or Poetry's form, or by its
// settings. A comment, a description or a project named after it shows nothing.
test("pyproject.toml counts as pytest only for a dependency on it or its settings", () => {
  const uses = (pyproject: string) =>
    detectCommands({ "uv.lock": "", "pyproject.toml": pyproject }).test;
  expect(uses('[dependency-groups]\ndev = ["pytest>=8", "ruff"]\n')).toEqual(["uv run pytest"]);
  expect(uses("[project.optional-dependencies]\ntest = ['pytest']\n")).toEqual(["uv run pytest"]);
  expect(uses('[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n')).toEqual([
    "uv run pytest",
  ]);
  expect(uses('[tool.pytest.ini_options]\naddopts = "-q"\n')).toEqual(["uv run pytest"]);
  expect(
    uses(
      '# We use unittest, not pytest.\n[project]\nname = "pytest-free"\ndescription = "No pytest here"\ndependencies = []\n',
    ),
  ).toEqual([]);
  expect(uses('[project]\ndescription = "pytest is not used"\ndependencies = []\n')).toEqual([]);
  expect(uses('[project]\nkeywords = ["pytest"]\n')).toEqual([]);
  expect(uses("[project\nnot toml")).toEqual([]);
});

// A lockfile names the package manager, not the test runner, such as unittest.
test("a locked Python repository with no sign of pytest gets its setup and no test", () => {
  expect(detectCommands({ "uv.lock": "", "pyproject.toml": "[project]\n" })).toEqual({
    setup: ["uv sync"],
    test: [],
  });
  expect(detectCommands({ "poetry.lock": "", "pyproject.toml": "[project]\n" })).toEqual({
    setup: ["poetry install"],
    test: [],
  });
});

test("a Makefile's check target, then its test target", () => {
  expect(detectCommands({ Makefile: "build:\n\tcc x.c\ntest:\n\t./x\n" })).toEqual({
    setup: [],
    test: ["make test"],
  });
  expect(detectCommands({ makefile: "test: build\n\t./x\ncheck: test lint\n" })).toEqual({
    setup: [],
    test: ["make check"],
  });
});

// A rule can name several targets, with spaces around them, and `:=` sets a variable instead.
test("a Makefile target counts among several, and with a space before its colon", () => {
  expect(detectCommands({ Makefile: "test :\n\t./x\n" })).toEqual({
    setup: [],
    test: ["make test"],
  });
  expect(detectCommands({ Makefile: "lint test check: build\n" })).toEqual({
    setup: [],
    test: ["make check"],
  });
  expect(detectCommands({ Makefile: "check := yes\ntest = no\n\tcheck: x\n" })).toEqual({
    setup: [],
    test: [],
  });
});

// A check runs more than the tests, such as lint and the typecheck, so it wins wherever it is.
test("a Makefile's check beats a package's test script, and setup comes from the package", () => {
  expect(
    detectCommands({ "bun.lock": "", "package.json": scripts("test"), Makefile: "check:\n" }),
  ).toEqual({ setup: ["bun install"], test: ["make check"] });
});

test("a repository with none of these gives no commands", () => {
  expect(detectCommands({})).toEqual({ setup: [], test: [] });
});
