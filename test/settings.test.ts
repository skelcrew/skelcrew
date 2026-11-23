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
  const script = `import { agentRole, checkLimit, leadCanMerge, repositoryCommands, reviewConfig, reviewLimit, roundLimit, sessionHost, threadLimit } from ${JSON.stringify(source("config.ts"))};
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

test("your general settings override the repository", () => {
  settings(
    "harness: claude\nmodel: sonnet\nmax_rounds: 5\n",
    "lead: { model: opus }\nreviewer: { harness: codex }\nmax_rounds: 2\n",
  );
  expect(forApp()).toEqual({
    lead: { harness: "claude", model: "sonnet" },
    builder: { harness: "claude", model: "sonnet" },
    reviewer: { harness: "claude", model: "sonnet" },
    maxRounds: 5,
    fallback: null,
    reviewMinutes: 30,
  });
});

// Every repository Skelcrew works on has a skelcrew.yaml, so neither your config nor an override
// for the repository under repos: stands in for one.
test("without a skelcrew.yaml, no role, command or limit of the repository is read", () => {
  const missing =
    "simon/app has no skelcrew.yaml. Run sc init in a checkout of it to create one, then commit and push it.";
  settings(
    "harness: claude\nsetup: [make]\ntest: [make test]\nrepos:\n  simon/app: { limits: { threads: 2 } }\n",
    null,
  );
  for (const read of [
    'agentRole("builder", app)',
    'agentRole("lead", app)',
    "reviewConfig(app)",
    "repositoryCommands(app)",
    "threadLimit(app)",
  ])
    expect(run(`${read};`).err).toContain(missing);
  settings("harness: claude\nsetup: [make]\ntest: [make test]\n", "limits: { threads: 2 }\n");
  expect(run("console.log(threadLimit(app));").out).toBe("2\n");
});

// No role has a built-in harness: one no file names is an error naming the line to add.
test("a role no file gives a harness is an error naming the line to add", () => {
  settings("", "roles: { builder: { model: opus }, reviewer: { harness: codex } }\n");
  expect(run('agentRole("builder", app);').err).toContain(
    "simon/app's skelcrew.yaml names no harness for the builder. Add one under roles:, such as roles: { builder: { harness: claude } }, naming claude, codex or pi, then commit and push it.",
  );
  expect(run('agentRole("lead", app);').err).toContain("names no harness for the lead");
  expect(run('console.log(JSON.stringify(agentRole("reviewer", app)));').out).toBe(
    '{"harness":"codex"}\n',
  );
  // Your harness for every role still goes over the repository's.
  settings("harness: pi\n", "roles: { builder: { model: opus } }\n");
  expect(run('console.log(JSON.stringify(agentRole("builder", app)));').out).toBe(
    '{"harness":"pi","model":"opus"}\n',
  );
});

// A usage limit and a review's time are yours, so only your config sets them.
test("the reviewer's fallback and a review's time limit come from your config alone", () => {
  settings(
    "harness: claude\nreviewer: { harness: codex, fallback: claude }\nreview: { timeout_minutes: 10 }\n",
    "reviewer: { fallback: codex }\nreview: { timeout_minutes: 99 }\n",
  );
  expect(forApp()).toMatchObject({ fallback: "claude", reviewMinutes: 10 });
  // A fallback that is the reviewer's own harness is none.
  settings("harness: claude\nreviewer: { fallback: claude }\n", "");
  expect(forApp()).toMatchObject({ fallback: null, reviewMinutes: 30 });
});

// Letting the lead merge when you ask grants an agent what is yours, so only your config can
// turn it off or on, and it is on until you turn it off.
test("only your config lets the lead merge, and it is on by default", () => {
  const leadMerges = () => run("console.log(leadCanMerge());").out.trim();
  settings("harness: claude\n", null);
  expect(leadMerges()).toBe("true");
  settings("harness: claude\nlead: { can_merge: false }\n", null);
  expect(leadMerges()).toBe("false");
  settings("harness: claude\nlead: { can_merge: true }\n", null);
  expect(leadMerges()).toBe("true");
  // The old name still counts as the same setting, and where both are set, can_merge wins.
  settings("harness: claude\nlead: { may_arm_merges: false }\n", null);
  expect(leadMerges()).toBe("false");
  settings("harness: claude\nlead: { may_arm_merges: false, can_merge: true }\n", null);
  expect(leadMerges()).toBe("true");
  settings("harness: claude\nlead: { may_arm_merges: true, can_merge: false }\n", null);
  expect(leadMerges()).toBe("false");
  // A repository cannot turn it on or replace your harness.
  settings(
    "harness: claude\nlead: { can_merge: false }\n",
    "lead: { harness: codex, can_merge: true, may_arm_merges: true }\n",
  );
  expect(leadMerges()).toBe("false");
  expect(forApp().lead).toEqual({ harness: "claude" });
  // Nor can it turn yours off.
  settings("harness: claude\n", "lead: { can_merge: false }\n");
  expect(leadMerges()).toBe("true");
  // Nor can an override for one repository under repos:, as only your general settings count.
  settings(
    "harness: claude\nlead: { can_merge: false }\nrepos:\n  simon/app:\n    lead: { can_merge: true }\n",
    null,
  );
  expect(leadMerges()).toBe("false");
  // Nor can anything in the repository's .agents/, such as a settings file put there.
  settings("harness: claude\nlead: { can_merge: false }\n", null);
  mkdirSync(join(clone(), ".agents"), { recursive: true });
  writeFileSync(join(clone(), ".agents", "skelcrew.yaml"), "lead: { can_merge: true }\n");
  writeFileSync(join(clone(), ".agents", "config.yaml"), "lead: { can_merge: true }\n");
  expect(leadMerges()).toBe("false");
  rmSync(join(clone(), ".agents"), { recursive: true });
  // A top-level line counts for nothing, and a value that isn't true or false is refused.
  settings("harness: claude\ncan_merge: false\n", null);
  expect(leadMerges()).toBe("true");
  settings("harness: claude\nlead: { can_merge: yes please }\n", null);
  expect(run("leadCanMerge();").err).toContain("isn't valid");
});

// A model name belongs to its harness.
test("your harness and role model override the repository harness", () => {
  settings("harness: claude\nreviewer: { model: sonnet }\n", "reviewer: { harness: codex }\n");
  expect(forApp().reviewer).toEqual({ harness: "claude", model: "sonnet" });
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
// and reviewers would use it without anyone seeing it was a guess. A missing line is an error
// that says how to add it.
test("a skelcrew.yaml missing setup or test is an error naming the line to add", () => {
  settings("harness: claude\n", "test: [make check]\n");
  writeFileSync(join(clone(), "go.mod"), "");
  writeFileSync(join(clone(), "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  expect(run("repositoryCommands(app);").err).toContain(
    "simon/app's skelcrew.yaml has no setup: line. Add the commands that set up a fresh clone, such as setup: [bun install], or setup: [] when it needs none, then commit and push it.",
  );
  settings("harness: claude\n", "setup: []\n");
  expect(run("repositoryCommands(app);").err).toContain(
    "simon/app's skelcrew.yaml has no test: line.",
  );
  settings("harness: claude\n", "setup: []\ntest: []\n");
  expect(commands()).toEqual({ setup: [], test: [] });
});

// Your config goes over the repository's skelcrew.yaml. Each of setup and test comes from your
// config, else the repository's skelcrew.yaml, and an empty list there counts as named.
test("setup and test come from your config, then the repository", () => {
  settings("harness: claude\nsetup: [make deps]\ntest: [make test]\n", "");
  expect(commands()).toEqual({ setup: ["make deps"], test: ["make test"] });
  settings(
    "harness: claude\nsetup: [make deps]\ntest: [make test]\n",
    "setup: []\ntest: [bun run check]\n",
  );
  expect(commands()).toEqual({ setup: ["make deps"], test: ["make test"] });
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

test("how many builders run at once comes from the repository or your override for it, and must be set", () => {
  const limit = () => run("console.log(threadLimit(app));").out.trim();
  settings("harness: claude\n", "");
  expect(run("threadLimit(app);").err).toContain(
    "simon/app's skelcrew.yaml has no limits: { threads: … } line. Add the most builders to run at once in it, such as limits: { threads: 4 }, then commit and push it.",
  );
  settings("harness: claude\n", "limits: { threads: 2 }\n");
  expect(limit()).toBe("2");
  // Your general limits are about your machine, so they don't limit a repository's builders.
  settings("harness: claude\nlimits: { threads: 5 }\n", "");
  expect(run("threadLimit(app);").err).toContain("has no limits: { threads: … } line");
  // An override for the repository wins, and one for another repository changes nothing.
  const overrides =
    "repos:\n  simon/app: { limits: { threads: 3 } }\n  simon/other: { limits: { threads: 7 } }\n";
  settings(`harness: claude\n${overrides}`, "limits: { threads: 2 }\n");
  expect(limit()).toBe("3");
  // A repository still can't set your limits alongside it.
  settings("harness: claude\n", "limits: { threads: 2, reviews: 9 }\n");
  const quarter = Math.max(1, Math.floor(availableParallelism() / 4));
  expect(Number(run("console.log(reviewLimit());").out)).toBe(quarter);
  settings("harness: claude\n", "limits: { threads: 0 }\n");
  expect(run("threadLimit(app);").err).toContain("isn't valid");
});
