// Settings in two layers: the repository's committed skelcrew.yaml, read from Skelcrew's clone of
// it, over your own config.yaml.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  const script = `import { agentRole, checkLimit, leadMayArmMerges, repositoryCommands, reviewConfig, reviewLimit, roundLimit, sessionHost } from ${JSON.stringify(source("config.ts"))};
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
const forApp = () =>
  JSON.parse(
    run(
      'console.log(JSON.stringify({ lead: agentRole("lead", app), builder: agentRole("builder", app), ...reviewConfig(app) }));',
    ).out,
  );

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

// Letting the lead arm a merge when ready grants an agent what is yours, so only your config can,
// and it is off until you turn it on.
test("only your config lets the lead arm merges, and it is off by default", () => {
  const leadArms = () => run("console.log(leadMayArmMerges());").out.trim();
  settings("harness: claude\n", null);
  expect(leadArms()).toBe("false");
  settings("harness: claude\nlead: { may_arm_merges: true }\n", null);
  expect(leadArms()).toBe("true");
  // A repository's skelcrew.yaml can't turn it on, and the lead's harness still comes from it.
  settings("harness: claude\n", "lead: { harness: codex, may_arm_merges: true }\n");
  expect(leadArms()).toBe("false");
  expect(forApp().lead).toEqual({ harness: "codex" });
  // Nor can it turn yours off.
  settings(
    "harness: claude\nlead: { may_arm_merges: true }\n",
    "lead: { may_arm_merges: false }\n",
  );
  expect(leadArms()).toBe("true");
  // Nor can an override for one repository under repos:, as only your general settings count.
  settings("harness: claude\nrepos:\n  simon/app:\n    lead: { may_arm_merges: true }\n", null);
  expect(leadArms()).toBe("false");
  // Nor can anything in the repository's .agents/, such as a settings file put there.
  settings("harness: claude\n", null);
  mkdirSync(join(clone(), ".agents"), { recursive: true });
  writeFileSync(join(clone(), ".agents", "skelcrew.yaml"), "lead: { may_arm_merges: true }\n");
  writeFileSync(join(clone(), ".agents", "config.yaml"), "lead: { may_arm_merges: true }\n");
  expect(leadArms()).toBe("false");
  rmSync(join(clone(), ".agents"), { recursive: true });
  // A top-level line counts for nothing, and a value that isn't true or false is refused.
  settings("harness: claude\nmay_arm_merges: true\n", null);
  expect(leadArms()).toBe("false");
  settings("harness: claude\nlead: { may_arm_merges: yes please }\n", null);
  expect(run("leadMayArmMerges();").err).toContain("isn't valid");
});

// A model name belongs to its harness.
test("your model for a role doesn't follow it onto the harness skelcrew.yaml picks", () => {
  settings("harness: claude\nreviewer: { model: sonnet }\n", "reviewer: { harness: codex }\n");
  expect(forApp().reviewer).toEqual({ harness: "codex" });
  settings("harness: claude\nreviewer: { model: sonnet }\n", "reviewer: { harness: claude }\n");
  expect(forApp().reviewer).toEqual({ harness: "claude", model: "sonnet" });
});

// Returns app's setup and test commands.
const commands = () => JSON.parse(run("console.log(JSON.stringify(repositoryCommands(app)));").out);

// Skelcrew's own skelcrew.yaml names the commands CI runs, so its threads set up and test the
// same way. Your config is left empty so only the file counts.
test("this repository's own skelcrew.yaml names CI's setup and test", () => {
  settings("", readFileSync(join(import.meta.dir, "..", "skelcrew.yaml"), "utf8"));
  expect(commands()).toEqual({ setup: ["bun install"], test: ["bun run check"] });
});

test("setup and test come from the skelcrew.yaml in Skelcrew's clone", () => {
  settings("harness: claude\n", "setup: [bun install, make]\ntest: [bun test]\n");
  expect(commands()).toEqual({ setup: ["bun install", "make"], test: ["bun test"] });
});

// Skelcrew never guesses them from the repository's files: a guess is often wrong, and builders
// and reviewers would use it without anyone seeing it was a guess.
test("with no skelcrew.yaml naming them, there are no setup or test commands", () => {
  settings("harness: claude\n", null);
  writeFileSync(join(clone(), "go.mod"), "");
  writeFileSync(join(clone(), "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  // JSON drops a setting no file names, so it reads as missing here.
  expect(commands()).toEqual({});
  settings("harness: claude\n", "test: [make check]\n");
  expect(commands()).toEqual({ test: ["make check"] });
});

// Your config stands in for a repository you don't want to commit a skelcrew.yaml to. Each of
// setup and test comes from the repository's skelcrew.yaml, else your config, and an empty list
// in skelcrew.yaml counts as named.
test("setup and test come from the repository, then your config", () => {
  settings("harness: claude\nsetup: [make deps]\ntest: [make test]\n", null);
  expect(commands()).toEqual({ setup: ["make deps"], test: ["make test"] });
  settings(
    "harness: claude\nsetup: [make deps]\ntest: [make test]\n",
    "setup: []\ntest: [bun run check]\n",
  );
  expect(commands()).toEqual({ setup: [], test: ["bun run check"] });
  settings("harness: claude\ntest: [make test]\n", "setup: [bun install]\n");
  expect(commands()).toEqual({ setup: ["bun install"], test: ["make test"] });
});

test("a skelcrew.yaml that isn't valid, or isn't a plain file, says so rather than be ignored", () => {
  settings("harness: claude\n", "max_rounds: -1\n");
  expect(run("roundLimit(app);").err).toContain("the repository's skelcrew.yaml isn't valid");
  settings("harness: claude\n", null);
  writeFileSync(join(home, "secret"), "setup: [cat secret]\n");
  symlinkSync(join(home, "secret"), join(clone(), "skelcrew.yaml"));
  expect(run("repositoryCommands(app);").err).toContain("isn't a plain file");
});

test("the session host comes from your config only, else tmux", () => {
  const host = () => run("console.log(sessionHost());").out;
  settings("harness: claude\n", null);
  expect(host()).toBe("tmux\n");
  settings("harness: claude\nsession: herdr\n", "session: rex\n");
  expect(host()).toBe("herdr\n");
  settings("harness: claude\n", "session: rex\n");
  expect(host()).toBe("tmux\n");
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

test("how many checks run at once comes from your config only, else half the cores over four", () => {
  // Skelcrew's own default, worked out here the same way, as the cores differ by machine.
  const eighth = Math.max(1, Math.floor(availableParallelism() / 2 / 4));
  const limit = () => Number(run("console.log(checkLimit());").out);
  settings("harness: claude\n", null);
  expect(limit()).toBe(eighth);
  settings("harness: claude\nlimits: { checks: 3, reviews: 2 }\n", "limits: { checks: 9 }\n");
  expect(limit()).toBe(3);
  settings("harness: claude\n", "limits: { checks: 9 }\n");
  expect(limit()).toBe(eighth);
  settings("harness: claude\nlimits: { checks: 0 }\n", null);
  expect(run("checkLimit();").err).toContain("isn't valid");
});
