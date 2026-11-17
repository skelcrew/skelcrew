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

test("Python with uv, poetry, or pytest alone", () => {
  expect(detectCommands({ "uv.lock": "", "pyproject.toml": "" })).toEqual({
    setup: ["uv sync"],
    test: ["uv run pytest"],
  });
  expect(detectCommands({ "poetry.lock": "", "pyproject.toml": "" })).toEqual({
    setup: ["poetry install"],
    test: ["poetry run pytest"],
  });
  const pytest = { setup: [], test: ["python3 -m pytest"] };
  expect(detectCommands({ "pyproject.toml": "[tool.pytest.ini_options]\n" })).toEqual(pytest);
  expect(detectCommands({ "setup.cfg": "[tool:pytest]\n" })).toEqual(pytest);
  expect(detectCommands({ "pytest.ini": "" })).toEqual(pytest);
  expect(detectCommands({ "pyproject.toml": "[project]\n" })).toEqual({ setup: [], test: [] });
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

// A check runs more than the tests, such as lint and the typecheck, so it wins wherever it is.
test("a Makefile's check beats a package's test script, and setup comes from the package", () => {
  expect(
    detectCommands({ "bun.lock": "", "package.json": scripts("test"), Makefile: "check:\n" }),
  ).toEqual({ setup: ["bun install"], test: ["make check"] });
});

test("a repository with none of these gives no commands", () => {
  expect(detectCommands({})).toEqual({ setup: [], test: [] });
});
