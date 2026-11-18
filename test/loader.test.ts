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
function read(groups: string[], repo = "app"): { settings?: Record<string, unknown>; err: string } {
  const script = `import { readSettings } from ${JSON.stringify(source("settings.ts"))};
console.log(JSON.stringify(readSettings(${JSON.stringify(groups)}, { owner: "simon", repo: ${JSON.stringify(repo)} })));`;
  const done = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = done.stdout.toString();
  return { settings: out ? JSON.parse(out) : undefined, err: done.stderr.toString() };
}

const roleGroups = ["lead", "builder", "reviewer"];
const all = [
  ...roleGroups,
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
];
const quarter = Math.max(1, Math.floor(availableParallelism() / 4));
const eighth = Math.max(1, Math.floor(availableParallelism() / 2 / 4));

test("with no files, every setting is the built-in default", () => {
  files(null, null);
  expect(read(all).settings).toEqual({
    lead: { harness: "claude" },
    builder: { harness: "claude" },
    reviewer: { harness: "claude" },
    rounds: 3,
    reviews: quarter,
    checks: eighth,
    reviewMinutes: 30,
    declined: [],
  });
});

test("your config goes over the built-in defaults", () => {
  files("harness: codex\nmodel: gpt-6\nmax_rounds: 5\nlimits: { reviews: 2 }\n", null);
  expect(read(all).settings).toEqual({
    lead: { harness: "codex", model: "gpt-6" },
    builder: { harness: "codex", model: "gpt-6" },
    reviewer: { harness: "codex", model: "gpt-6" },
    rounds: 5,
    reviews: 2,
    checks: eighth,
    reviewMinutes: 30,
    yourHarness: "codex",
    declined: [],
  });
});

test("the repository's skelcrew.yaml goes over your config, key by key", () => {
  files(
    "harness: claude\nmodel: opus\nmax_rounds: 5\nbuilder: { model: sonnet }\n",
    "max_rounds: 2\nlead: { model: haiku }\nsetup: [make]\ntracker: none\n",
  );
  expect(read(all).settings).toEqual({
    lead: { harness: "claude", model: "haiku" },
    builder: { harness: "claude", model: "sonnet" },
    reviewer: { harness: "claude", model: "opus" },
    rounds: 2,
    reviews: quarter,
    checks: eighth,
    setup: ["make"],
    tracker: "none",
    reviewMinutes: 30,
    yourHarness: "claude",
    declined: [],
  });
});

test("a role your config puts on another harness gets your model back when skelcrew.yaml puts it on yours", () => {
  files(
    "harness: claude\nmodel: opus\nreviewer: { harness: codex, model: gpt-6 }\n",
    "reviewer: { harness: claude }\n",
  );
  expect(read(roleGroups).settings).toMatchObject({
    reviewer: { harness: "claude", model: "opus" },
  });
});

test("a file sets only what is its own", () => {
  // Your harness, model and limits fit you, so a repository's lines for them count for nothing.
  // The tracker belongs to the repository, so yours counts for nothing.
  files("tracker: linear\n", "harness: codex\nmodel: gpt-6\nlimits: { reviews: 9 }\n");
  expect(read(all).settings).toEqual({
    lead: { harness: "claude" },
    builder: { harness: "claude" },
    reviewer: { harness: "claude" },
    rounds: 3,
    reviews: quarter,
    checks: eighth,
    reviewMinutes: 30,
    declined: [],
  });
});

test("only the settings asked for are checked, and a bad one names its file", () => {
  files("harness: claude\nmax_rounds: 0\n", "setup: make\n");
  expect(read(roleGroups).settings?.lead).toBeDefined();
  expect(read(["rounds"]).err).toContain("config.yaml isn't valid");
  expect(read(["setup"]).err).toContain("the repository's skelcrew.yaml isn't valid");
});

test("a setting skelcrew.yaml sets isn't read from your config, so a bad one there stops nothing", () => {
  files("harness: claude\nmax_rounds: 0\nsetup: 5\n", "max_rounds: 2\n");
  expect(read(["rounds"]).settings?.rounds).toBe(2);
  // A role is merged with yours, so yours is still read and checked.
  files("harness: claude\nreviewer: { harness: nope }\n", "reviewer: { harness: codex }\n");
  expect(read(roleGroups).err).toContain("config.yaml isn't valid");
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
  expect(read(roleGroups).settings?.lead).toBeDefined();
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

test("roles: in your config is read as lead:, builder: and reviewer: were, and wins key by key", () => {
  files(
    "harness: claude\nmodel: opus\nbuilder: { harness: claude, model: sonnet }\nroles:\n  builder: { model: haiku }\n  reviewer: { harness: codex }\n",
    null,
  );
  expect(read(roleGroups).settings).toMatchObject({
    lead: { harness: "claude", model: "opus" },
    builder: { harness: "claude", model: "haiku" },
    reviewer: { harness: "codex" },
  });
  // A role put on another harness in the new shape drops the old shape's model.
  files(
    "builder: { harness: claude, model: opus }\nroles: { builder: { harness: codex } }\n",
    null,
  );
  expect(read(roleGroups).settings).toMatchObject({ builder: { harness: "codex" } });
  files("roles: { builder: { harness: emacs } }\n", null);
  expect(read(roleGroups).err).toContain("config.yaml isn't valid");
});

test("repos: overrides go over the repository's files, for the repository they name only", () => {
  files(
    "harness: claude\nrepos:\n  simon/app:\n    setup: [make app]\n    max_rounds: 7\n    roles: { builder: { model: sonnet } }\n  simon/other:\n    setup: [make other]\n",
    "setup: [make]\nmax_rounds: 2\nbuilder: { model: haiku }\n",
  );
  expect(read([...roleGroups, "rounds", "setup"]).settings).toMatchObject({
    builder: { harness: "claude", model: "sonnet" },
    lead: { harness: "claude" },
    rounds: 7,
    setup: ["make app"],
  });
  expect(read(["rounds", "setup"], "other").settings).toMatchObject({
    rounds: 3,
    setup: ["make other"],
  });
  expect(read(["setup"], "third").settings?.setup).toBeUndefined();
});

test("repos: can't set what is only yours, and a bad entry stops only its own repository", () => {
  files(
    "repos:\n  simon/app: { limits: { reviews: 9 }, harness: codex }\n  simon/other: { max_rounds: 0 }\n",
    null,
  );
  expect(read(["reviews", "rounds", "lead"]).settings).toMatchObject({
    reviews: quarter,
    rounds: 3,
    lead: { harness: "codex" },
  });
  expect(read(["rounds"], "other").err).toContain("isn't valid");
});

test("a mistake in one role's settings stops only that role's agents", () => {
  files(
    "harness: claude\nroles: { reviewer: { harness: nope } }\nbuilder: { harness: emacs }\n",
    null,
  );
  expect(read(["lead"]).settings?.lead).toEqual({ harness: "claude" });
  expect(read(["builder"]).err).toContain("config.yaml isn't valid");
  expect(read(["reviewer"]).err).toContain("config.yaml isn't valid");
});

test("the reviewer's fallback and your reviewer's harness are read from roles: too, over the old shape", () => {
  files(
    "reviewer: { harness: claude, fallback: claude }\nroles: { reviewer: { harness: codex, fallback: codex } }\n",
    null,
  );
  expect(read(["fallback", "yourReviewer"]).settings).toMatchObject({
    fallback: "codex",
    yourReviewer: "codex",
  });
});

test("roles: naming the harness a role is on already keeps the old line's model", () => {
  files(
    "harness: claude\nbuilder: { model: sonnet }\nroles: { builder: { harness: claude } }\n",
    null,
  );
  expect(read(["builder"]).settings?.builder).toEqual({ harness: "claude", model: "sonnet" });
});
