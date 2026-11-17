// Detecting a repository's setup and test commands from its files, for a repository whose
// skelcrew.yaml names none.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCommands } from "../src/detect.ts";

let folder = "";

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "skel-detect-test-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

// Writes each file into the repository's folder.
function files(given: Record<string, string>): void {
  for (const [name, text] of Object.entries(given)) {
    mkdirSync(join(folder, name, ".."), { recursive: true });
    writeFileSync(join(folder, name), text);
  }
}

// A package.json with these scripts.
const scripts = (...names: string[]) =>
  JSON.stringify({ scripts: Object.fromEntries(names.map((n) => [n, "true"])) });

test("bun prefers a check script, then a test script, then bun test", () => {
  files({ "bun.lock": "", "package.json": scripts("test", "check") });
  expect(detectCommands(folder)).toEqual({ setup: ["bun install"], test: ["bun run check"] });
  files({ "package.json": scripts("test") });
  expect(detectCommands(folder)).toEqual({ setup: ["bun install"], test: ["bun run test"] });
  files({ "package.json": scripts() });
  expect(detectCommands(folder)).toEqual({ setup: ["bun install"], test: ["bun test"] });
});

test("bun's older binary lockfile counts too", () => {
  files({ "bun.lockb": "", "package.json": "{}" });
  expect(detectCommands(folder)).toEqual({ setup: ["bun install"], test: ["bun test"] });
});

test("npm, pnpm and yarn by their lockfile and scripts", () => {
  files({ "package-lock.json": "{}", "package.json": scripts("test") });
  expect(detectCommands(folder)).toEqual({ setup: ["npm ci"], test: ["npm run test"] });
  rmSync(join(folder, "package-lock.json"));
  files({ "pnpm-lock.yaml": "", "package.json": scripts("check", "test") });
  expect(detectCommands(folder)).toEqual({
    setup: ["pnpm install --frozen-lockfile"],
    test: ["pnpm run check"],
  });
  rmSync(join(folder, "pnpm-lock.yaml"));
  files({ "yarn.lock": "", "package.json": scripts("test") });
  expect(detectCommands(folder)).toEqual({ setup: ["yarn install"], test: ["yarn run test"] });
});

test("a package.json with no lockfile installs with npm, and has no tests without a script", () => {
  files({ "package.json": scripts() });
  expect(detectCommands(folder)).toEqual({ setup: ["npm install"], test: [] });
});

test("a package.json that isn't valid gives no scripts", () => {
  files({ "bun.lock": "", "package.json": "{ not json" });
  expect(detectCommands(folder)).toEqual({ setup: ["bun install"], test: ["bun test"] });
});

test("Cargo, Go, Elixir, Maven, Gradle and Ruby", () => {
  const cases: [Record<string, string>, { setup: string[]; test: string[] }][] = [
    [{ "Cargo.toml": "" }, { setup: ["cargo fetch"], test: ["cargo test"] }],
    [{ "go.mod": "" }, { setup: ["go mod download"], test: ["go test ./..."] }],
    [{ "mix.exs": "" }, { setup: ["mix deps.get"], test: ["mix test"] }],
    [{ "pom.xml": "" }, { setup: [], test: ["mvn verify"] }],
    [{ gradlew: "" }, { setup: [], test: ["./gradlew check"] }],
    [{ Gemfile: "" }, { setup: ["bundle install"], test: [] }],
    [
      { Gemfile: "", ".rspec": "" },
      { setup: ["bundle install"], test: ["bundle exec rspec"] },
    ],
  ];
  for (const [given, expected] of cases) {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder);
    files(given);
    expect(detectCommands(folder)).toEqual(expected);
  }
});

test("Python with uv, poetry, or pytest alone", () => {
  files({ "uv.lock": "", "pyproject.toml": "" });
  expect(detectCommands(folder)).toEqual({ setup: ["uv sync"], test: ["uv run pytest"] });
  rmSync(join(folder, "uv.lock"));
  files({ "poetry.lock": "" });
  expect(detectCommands(folder)).toEqual({
    setup: ["poetry install"],
    test: ["poetry run pytest"],
  });
  rmSync(join(folder, "poetry.lock"));
  files({ "pyproject.toml": "[tool.pytest.ini_options]\n" });
  expect(detectCommands(folder)).toEqual({ setup: [], test: ["python3 -m pytest"] });
  rmSync(join(folder, "pyproject.toml"));
  files({ "pytest.ini": "" });
  expect(detectCommands(folder)).toEqual({ setup: [], test: ["python3 -m pytest"] });
});

test("a Makefile's check target, then its test target", () => {
  files({ Makefile: "build:\n\tcc x.c\ntest:\n\t./x\n" });
  expect(detectCommands(folder)).toEqual({ setup: [], test: ["make test"] });
  files({ Makefile: "test: build\n\t./x\ncheck: test lint\n" });
  expect(detectCommands(folder)).toEqual({ setup: [], test: ["make check"] });
});

// A check runs more than the tests, such as lint and the typecheck, so it wins wherever it is.
test("a Makefile's check beats a package's test script, and setup comes from the package", () => {
  files({ "bun.lock": "", "package.json": scripts("test"), Makefile: "check:\n\ttrue\n" });
  expect(detectCommands(folder)).toEqual({ setup: ["bun install"], test: ["make check"] });
});

test("a repository with none of these gives no commands", () => {
  files({ "README.md": "hello" });
  expect(detectCommands(folder)).toEqual({ setup: [], test: [] });
});

// A link could point at any file of yours, so it is never read.
test("a linked file counts for nothing", () => {
  files({ "elsewhere/Makefile": "check:\n" });
  symlinkSync(join(folder, "elsewhere", "Makefile"), join(folder, "Makefile"));
  expect(detectCommands(folder)).toEqual({ setup: [], test: [] });
});
