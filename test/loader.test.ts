// The one loader every setting is read through: the repository's skelcrew.yaml first, then your
// config.yaml, then the built-in defaults.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

let home = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-loader-test-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Writes your config.yaml and app's skelcrew.yaml in Skelcrew's clone, each unless it is null.
function files(yours: string | null, shared: string | null): void {
  const config = join(home, ".config", "skelcrew");
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(config, { recursive: true });
  mkdirSync(clone, { recursive: true });
  rmSync(join(config, "config.yaml"), { force: true });
  rmSync(join(clone, "skelcrew.yaml"), { force: true });
  if (yours !== null) writeFileSync(join(config, "config.yaml"), yours);
  if (shared !== null) writeFileSync(join(clone, "skelcrew.yaml"), shared);
}

// Reads the settings in `groups` for app in a process of its own, as homedir() keeps the HOME
// this one started with. Returns them, or the error the read ended with.
function read(groups: string[]): { settings?: Record<string, unknown>; err: string } {
  const script = `import { readSettings } from ${JSON.stringify(source("settings.ts"))};
console.log(JSON.stringify(readSettings(${JSON.stringify(groups)}, { owner: "simon", repo: "app" })));`;
  const done = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = done.stdout.toString();
  return { settings: out ? JSON.parse(out) : undefined, err: done.stderr.toString() };
}

const all = [
  "roles",
  "rounds",
  "reviews",
  "checks",
  "setup",
  "test",
  "tracker",
  "fallback",
  "reviewMinutes",
  "yourHarness",
  "yourReviewer",
  "declined",
  "leadArms",
];
const quarter = Math.max(1, Math.floor(availableParallelism() / 4));
const eighth = Math.max(1, Math.floor(availableParallelism() / 2 / 4));

test("with no files, every setting is the built-in default", () => {
  files(null, null);
  expect(read(all).settings).toEqual({
    roles: {
      lead: { harness: "claude" },
      builder: { harness: "claude" },
      reviewer: { harness: "claude" },
    },
    rounds: 3,
    reviews: quarter,
    checks: eighth,
    reviewMinutes: 30,
    declined: [],
    leadArms: false,
  });
});

test("your config goes over the built-in defaults", () => {
  files("harness: codex\nmodel: gpt-6\nmax_rounds: 5\nlimits: { reviews: 2 }\n", null);
  expect(read(all).settings).toEqual({
    roles: {
      lead: { harness: "codex", model: "gpt-6" },
      builder: { harness: "codex", model: "gpt-6" },
      reviewer: { harness: "codex", model: "gpt-6" },
    },
    rounds: 5,
    reviews: 2,
    checks: eighth,
    reviewMinutes: 30,
    yourHarness: "codex",
    declined: [],
    leadArms: false,
  });
});

test("the repository's skelcrew.yaml goes over your config, key by key", () => {
  files(
    "harness: claude\nmodel: opus\nmax_rounds: 5\nbuilder: { model: sonnet }\n",
    "max_rounds: 2\nlead: { model: haiku }\nsetup: [make]\ntracker: none\n",
  );
  expect(read(all).settings).toEqual({
    roles: {
      lead: { harness: "claude", model: "haiku" },
      builder: { harness: "claude", model: "sonnet" },
      reviewer: { harness: "claude", model: "opus" },
    },
    rounds: 2,
    reviews: quarter,
    checks: eighth,
    setup: ["make"],
    tracker: "none",
    reviewMinutes: 30,
    yourHarness: "claude",
    declined: [],
    leadArms: false,
  });
});

test("a role your config puts on another harness gets your model back when skelcrew.yaml puts it on yours", () => {
  files(
    "harness: claude\nmodel: opus\nreviewer: { harness: codex, model: gpt-6 }\n",
    "reviewer: { harness: claude }\n",
  );
  expect(read(["roles"]).settings?.roles).toMatchObject({
    reviewer: { harness: "claude", model: "opus" },
  });
});

test("a file sets only what is its own", () => {
  // Your harness, model and limits fit you, so a repository's lines for them count for nothing.
  // The tracker belongs to the repository, so yours counts for nothing. Only you can let the lead
  // arm merges, so the repository's line for that counts for nothing too.
  files(
    "tracker: linear\n",
    "harness: codex\nmodel: gpt-6\nlimits: { reviews: 9 }\nlead: { may_arm_merges: true }\n",
  );
  expect(read(all).settings).toEqual({
    roles: {
      lead: { harness: "claude" },
      builder: { harness: "claude" },
      reviewer: { harness: "claude" },
    },
    rounds: 3,
    reviews: quarter,
    checks: eighth,
    reviewMinutes: 30,
    declined: [],
    leadArms: false,
  });
});

test("only the settings asked for are checked, and a bad one names its file", () => {
  files("harness: claude\nmax_rounds: 0\n", "setup: make\n");
  expect(read(["roles"]).settings?.roles).toBeDefined();
  expect(read(["rounds"]).err).toContain("config.yaml isn't valid");
  expect(read(["setup"]).err).toContain("the repository's skelcrew.yaml isn't valid");
});

test("a setting skelcrew.yaml sets isn't read from your config, so a bad one there stops nothing", () => {
  files("harness: claude\nmax_rounds: 0\nsetup: 5\n", "max_rounds: 2\n");
  expect(read(["rounds"]).settings?.rounds).toBe(2);
  // A role is merged with yours, so yours is still read and checked.
  files("harness: claude\nreviewer: { harness: nope }\n", "reviewer: { harness: codex }\n");
  expect(read(["roles"]).err).toContain("config.yaml isn't valid");
});

test("the reviewer's fallback and a review's time come from your config alone, else the defaults", () => {
  files(null, "reviewer: { fallback: codex }\nreview: { timeout_minutes: 99 }\n");
  expect(read(["fallback", "reviewMinutes"]).settings).toMatchObject({ reviewMinutes: 30 });
  expect(read(["fallback"]).settings?.fallback).toBeUndefined();
  files("reviewer: { fallback: codex }\nreview: { timeout_minutes: 10 }\n", null);
  expect(read(["fallback", "reviewMinutes"]).settings).toMatchObject({
    fallback: "codex",
    reviewMinutes: 10,
  });
  // A bad fallback stops only what reads it, not the roles the lead needs.
  files("reviewer: { fallback: nope }\n", null);
  expect(read(["roles"]).settings?.roles).toBeDefined();
  expect(read(["fallback"]).err).toContain("config.yaml isn't valid");
});

test("a fallback counts only under reviewer:", () => {
  files("harness: claude\nfallback: codex\n", null);
  expect(read(["fallback"]).settings?.fallback).toBeUndefined();
  files("harness: claude\nfallback: nope\n", null);
  expect(read(["fallback"]).err).toBe("");
});

// The first run asks for what you haven't picked, so it must tell your choice from the default.
test("what your config saved reads apart from the defaults", () => {
  files(null, "reviewer: { harness: codex }\n");
  expect(read(["yourHarness", "yourReviewer", "declined"]).settings).toMatchObject({
    declined: [],
    leadArms: false,
  });
  expect(read(["yourHarness"]).settings?.yourHarness).toBeUndefined();
  expect(read(["yourReviewer"]).settings?.yourReviewer).toBeUndefined();
  files("harness: codex\nreviewer: { harness: claude }\ngithub_declined: [simon/app]\n", null);
  expect(read(["yourHarness", "yourReviewer", "declined"]).settings).toMatchObject({
    yourHarness: "codex",
    yourReviewer: "claude",
    declined: ["simon/app"],
  });
});
