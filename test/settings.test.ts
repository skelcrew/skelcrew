// Settings in two layers: the repository's committed skelcrew.yaml, read from Skelcrew's clone of
// it, over your own config.yaml.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const script = `import { repositorySetup, threadConfig } from ${JSON.stringify(source("config.ts"))};
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
  });
});

test("without a skelcrew.yaml, your config decides", () => {
  settings("harness: claude\nmodel: sonnet\nmax_rounds: 5\nreviewer: { harness: codex }\n", null);
  expect(forApp()).toEqual({
    lead: { harness: "claude", model: "sonnet" },
    builder: { harness: "claude", model: "sonnet" },
    reviewer: { harness: "codex" },
    maxRounds: 5,
  });
});

// A model name belongs to its harness.
test("your model for a role doesn't follow it onto the harness skelcrew.yaml picks", () => {
  settings("harness: claude\nreviewer: { model: sonnet }\n", "reviewer: { harness: codex }\n");
  expect(forApp().reviewer).toEqual({ harness: "codex" });
  settings("harness: claude\nreviewer: { model: sonnet }\n", "reviewer: { harness: claude }\n");
  expect(forApp().reviewer).toEqual({ harness: "claude", model: "sonnet" });
});

test("setup comes from the skelcrew.yaml in Skelcrew's clone", () => {
  settings("harness: claude\n", "setup: [bun install, make]\ntest: [bun test]\n");
  expect(run("console.log(JSON.stringify(repositorySetup(app)));").out).toBe(
    '["bun install","make"]\n',
  );
  settings("harness: claude\n", null);
  expect(run("console.log(JSON.stringify(repositorySetup(app)));").out).toBe("[]\n");
});

test("a skelcrew.yaml that isn't valid, or isn't a plain file, says so rather than be ignored", () => {
  settings("harness: claude\n", "max_rounds: -1\n");
  expect(run("threadConfig(app);").err).toContain("the repository's skelcrew.yaml isn't valid");
  settings("harness: claude\n", null);
  writeFileSync(join(home, "secret"), "setup: [cat secret]\n");
  symlinkSync(join(home, "secret"), join(clone(), "skelcrew.yaml"));
  expect(run("repositorySetup(app);").err).toContain("isn't a plain file");
});
