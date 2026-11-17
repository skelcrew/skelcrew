// Settings in two layers: the repository's committed skelcrew.yaml, read from Skelcrew's clone of
// it, over your own config.yaml.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

let home = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-settings-test-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Skelcrew's clone of simon/app, where Skelcrew reads its skelcrew.yaml.
const clone = () => join(home, ".local", "share", "skelcrew", "repos", "simon", "app");

// Writes your config.yaml and, unless it is null, app's skelcrew.yaml in Skelcrew's clone.
function settings(yours: string, shared: string | null): void {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), yours);
  mkdirSync(clone(), { recursive: true });
  rmSync(join(clone(), "skelcrew.yaml"), { force: true });
  if (shared !== null) writeFileSync(join(clone(), "skelcrew.yaml"), shared);
}

// Runs code against config.ts in a process of its own, as homedir() keeps the HOME this one
// started with, and returns what it printed and the error it ended with, if any.
function run(code: string): { out: string; err: string } {
  const script = `import { repositoryCommands, reviewLimit, threadConfig } from ${JSON.stringify(source("config.ts"))};
const app = { owner: "simon", repo: "app" };
${code}`;
  const done = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out: done.stdout.toString(), err: done.stderr.toString() };
}

// Returns what a thread of app runs with: each role's harness and model, and the round limit.
const forApp = () => JSON.parse(run("console.log(JSON.stringify(threadConfig(app)));").out);

test("the repository's skelcrew.yaml sets each role and the round limit, over your config", () => {
  settings(
    "harness: claude\nmodel: sonnet\nmax_rounds: 5\n",
    "lead: { model: opus }\nreviewer: { harness: codex }\nmax_rounds: 2\n",
  );
  expect(forApp()).toEqual({
    lead: { harness: "claude", model: "opus" },
    builder: { harness: "claude", model: "sonnet" },
    reviewer: { harness: "codex" },
    maxRounds: 2,
    fallback: null,
    reviewMinutes: 30,
  });
});

test("without a skelcrew.yaml, your config decides", () => {
  settings("harness: claude\nmodel: sonnet\nmax_rounds: 5\nreviewer: { harness: codex }\n", null);
  expect(forApp()).toEqual({
    lead: { harness: "claude", model: "sonnet" },
    builder: { harness: "claude", model: "sonnet" },
    reviewer: { harness: "codex" },
    maxRounds: 5,
    fallback: null,
    reviewMinutes: 30,
  });
});

// A usage limit and a review's time are yours, so only your config sets them.
test("the reviewer's fallback and a review's time limit come from your config alone", () => {
  settings(
    "harness: claude\nreviewer: { harness: codex, fallback: claude }\nreview: { timeout_minutes: 10 }\n",
    "reviewer: { fallback: codex }\nreview: { timeout_minutes: 99 }\n",
  );
  expect(forApp()).toMatchObject({ fallback: "claude", reviewMinutes: 10 });
  // A fallback that is the reviewer's own harness is none.
  settings("harness: claude\nreviewer: { fallback: claude }\n", null);
  expect(forApp()).toMatchObject({ fallback: null, reviewMinutes: 30 });
});

// A model name belongs to its harness.
test("your model for a role doesn't follow it onto the harness skelcrew.yaml picks", () => {
  settings("harness: claude\nreviewer: { model: sonnet }\n", "reviewer: { harness: codex }\n");
  expect(forApp().reviewer).toEqual({ harness: "codex" });
  settings("harness: claude\nreviewer: { model: sonnet }\n", "reviewer: { harness: claude }\n");
  expect(forApp().reviewer).toEqual({ harness: "claude", model: "sonnet" });
});

// Returns app's setup and test commands, and whether each was detected.
const commands = () => JSON.parse(run("console.log(JSON.stringify(repositoryCommands(app)));").out);

test("setup and test come from the skelcrew.yaml in Skelcrew's clone", () => {
  settings("harness: claude\n", "setup: [bun install, make]\ntest: [bun test]\n");
  writeFileSync(join(clone(), "go.mod"), "");
  expect(commands()).toEqual({
    setup: { commands: ["bun install", "make"], detected: false },
    test: { commands: ["bun test"], detected: false },
  });
});

test("what skelcrew.yaml doesn't name is detected from the repository's files", () => {
  settings("harness: claude\n", "test: [make check]\n");
  writeFileSync(join(clone(), "go.mod"), "");
  expect(commands()).toEqual({
    setup: { commands: ["go mod download"], detected: true },
    test: { commands: ["make check"], detected: false },
  });
  settings("harness: claude\n", null);
  expect(commands()).toEqual({
    setup: { commands: ["go mod download"], detected: true },
    test: { commands: ["go test ./..."], detected: true },
  });
});

// Skelcrew's clone follows the default branch, so what is detected follows it too.
test("detection follows the files in Skelcrew's clone as they change", () => {
  settings("harness: claude\n", null);
  writeFileSync(join(clone(), "go.mod"), "");
  expect(commands().test.commands).toEqual(["go test ./..."]);
  rmSync(join(clone(), "go.mod"));
  writeFileSync(join(clone(), "Cargo.toml"), "");
  expect(commands().test.commands).toEqual(["cargo test"]);
});

// A link could point at any file of yours, so it is never read.
test("a linked file in the clone counts for nothing in detection", () => {
  settings("harness: claude\n", null);
  writeFileSync(join(home, "Makefile"), "check:\n");
  symlinkSync(join(home, "Makefile"), join(clone(), "Makefile"));
  expect(commands().test).toEqual({ commands: [], detected: true });
});

// Detection only stands in for what no file names, so a file it can't read never stops
// commands that are named.
test("named setup and test never read the files detection looks at", () => {
  settings("harness: claude\nsetup: []\n", "test: [make test]\n");
  writeFileSync(join(clone(), "package.json"), "{}");
  chmodSync(join(clone(), "package.json"), 0);
  expect(commands()).toEqual({
    setup: { commands: [], detected: false },
    test: { commands: ["make test"], detected: false },
  });
  // With one left to detect, the unreadable file is read and says so.
  settings("harness: claude\n", "test: [make test]\n");
  expect(run("repositoryCommands(app);").err).toContain("EACCES");
});

// An empty list says the repository has no setup, which detection mustn't override.
test("an empty list in skelcrew.yaml counts as named", () => {
  settings("harness: claude\n", "setup: []\n");
  writeFileSync(join(clone(), "go.mod"), "");
  expect(commands().setup).toEqual({ commands: [], detected: false });
});

// Each of setup and test comes from the repository's skelcrew.yaml, else your config, else
// detection. Your empty list turns detection off, as the repository's does.
test("setup and test come from the repository, then your config, then detection", () => {
  settings("harness: claude\nsetup: []\ntest: [make test]\n", "test: [bun run check]\n");
  writeFileSync(join(clone(), "go.mod"), "");
  expect(commands()).toEqual({
    setup: { commands: [], detected: false },
    test: { commands: ["bun run check"], detected: false },
  });
  settings("harness: claude\ntest: [make test]\n", null);
  writeFileSync(join(clone(), "go.mod"), "");
  expect(commands()).toEqual({
    setup: { commands: ["go mod download"], detected: true },
    test: { commands: ["make test"], detected: false },
  });
});

test("a skelcrew.yaml that isn't valid, or isn't a plain file, says so rather than be ignored", () => {
  settings("harness: claude\n", "max_rounds: -1\n");
  expect(run("threadConfig(app);").err).toContain("the repository's skelcrew.yaml isn't valid");
  settings("harness: claude\n", null);
  writeFileSync(join(home, "secret"), "setup: [cat secret]\n");
  symlinkSync(join(home, "secret"), join(clone(), "skelcrew.yaml"));
  expect(run("repositoryCommands(app);").err).toContain("isn't a plain file");
});

test("how many reviews run at once comes from your config only, else a quarter of the cores", () => {
  // Skelcrew's own default, worked out here the same way, as the cores differ by machine.
  const quarter = Math.max(1, Math.floor(availableParallelism() / 4));
  const limit = () => Number(run("console.log(reviewLimit());").out);
  settings("harness: claude\n", null);
  expect(limit()).toBe(quarter);
  settings("harness: claude\nlimits: { reviews: 3 }\n", "limits: { reviews: 9 }\n");
  expect(limit()).toBe(3);
  settings("harness: claude\n", "limits: { reviews: 9 }\n");
  expect(limit()).toBe(quarter);
  settings("harness: claude\nlimits: { reviews: 0 }\n", null);
  expect(run("reviewLimit();").err).toContain("isn't valid");
});
