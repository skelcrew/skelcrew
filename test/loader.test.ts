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
  "plugins",
  "host",
  "leadArms",
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
    plugins: [],
    host: "tmux",
    leadArms: false,
  });
});

test("your config goes over the built-in defaults", () => {
  files(
    "harness: codex\nmodel: gpt-6\nmax_rounds: 5\nlimits: { reviews: 2 }\nplugins: [simon/herdr]\nsession: herdr\n",
    null,
  );
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
    plugins: ["simon/herdr"],
    host: "herdr",
    leadArms: false,
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
    plugins: [],
    host: "tmux",
    leadArms: false,
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
  // Your harness, model, limits and personal plugins fit you, so a repository's lines for them
  // count for nothing. The tracker belongs to the repository, so yours counts for nothing. Only
  // you can let the lead arm merges, so the repository's line for that counts for nothing too.
  files(
    "tracker: linear\n",
    "harness: codex\nmodel: gpt-6\nlimits: { reviews: 9 }\nplugins: [simon/sneaky]\nsession: rex\nlead: { may_arm_merges: true }\n",
  );
  expect(read(all).settings).toEqual({
    lead: { harness: "claude" },
    builder: { harness: "claude" },
    reviewer: { harness: "claude" },
    rounds: 3,
    reviews: quarter,
    checks: eighth,
    reviewMinutes: 30,
    declined: [],
    plugins: [],
    host: "tmux",
    leadArms: false,
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
  // A role is merged with yours, so yours is still read and checked where it can count: a
  // model of yours goes along if your line puts the role on the repository's harness.
  files(
    "harness: claude\nreviewer: { harness: nope, model: x }\n",
    "reviewer: { harness: codex }\n",
  );
  expect(read(roleGroups).err).toContain("config.yaml isn't valid");
  // With no model in your line, its harness can't count, so it stops nothing.
  files("harness: claude\nreviewer: { harness: nope }\n", "reviewer: { harness: codex }\n");
  expect(read(["reviewer"]).settings?.reviewer).toEqual({ harness: "codex" });
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

// An override is you differing from the repository's files, or from your general settings, for
// one repository. So the tracker, the reviewer's fallback and a review's time come from it first.
test("repos: overrides set the tracker, the reviewer's fallback and a review's time first", () => {
  files(
    "reviewer: { fallback: claude }\nreview: { timeout_minutes: 10 }\nrepos:\n  simon/app:\n    tracker: none\n    roles: { reviewer: { fallback: codex } }\n    review: { timeout_minutes: 45 }\n",
    "tracker: linear\n",
  );
  expect(read(["tracker", "fallback", "reviewMinutes"]).settings).toMatchObject({
    tracker: "none",
    fallback: "codex",
    reviewMinutes: 45,
  });
  // Another repository keeps its own tracker and your general settings.
  expect(read(["tracker", "fallback", "reviewMinutes"], "other").settings).toMatchObject({
    fallback: "claude",
    reviewMinutes: 10,
  });
  // A bad one stops only what reads it, naming the override.
  files("repos: { simon/app: { reviewer: { fallback: nope } } }\n", null);
  expect(read(["fallback"]).err).toContain("isn't valid under repos: simon/app");
  expect(read(["tracker", "reviewMinutes"]).err).toBe("");
});

test("repos: can't set what is about your machine, and a bad entry stops only its own repository", () => {
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

test("a harness your repos: override names goes over the repository's role lines", () => {
  files(
    "harness: claude\nmodel: opus\nrepos: { simon/app: { harness: codex } }\n",
    "builder: { harness: claude, model: opus }\n",
  );
  const moved = read(roleGroups).settings;
  expect([moved?.lead, moved?.builder, moved?.reviewer]).toEqual([
    { harness: "codex" },
    { harness: "codex" },
    { harness: "codex" },
  ]);
  // A model alone in the override fits only a role still on your harness.
  files(
    "harness: claude\nrepos: { simon/app: { model: sonnet } }\n",
    "reviewer: { harness: codex }\n",
  );
  const alone = read(roleGroups).settings;
  expect([alone?.lead, alone?.builder, alone?.reviewer]).toEqual([
    { harness: "claude", model: "sonnet" },
    { harness: "claude", model: "sonnet" },
    { harness: "codex" },
  ]);
  // A role the override names itself goes over its own harness for every role.
  files(
    "harness: claude\nrepos: { simon/app: { harness: codex, roles: { builder: { harness: claude, model: haiku } } } }\n",
    null,
  );
  const named = read(["builder", "lead"]).settings;
  expect([named?.builder, named?.lead]).toEqual([
    { harness: "claude", model: "haiku" },
    { harness: "codex" },
  ]);
});

test("a harness your repos: override names counts though yours below it isn't valid", () => {
  files(
    "harness: invalid\nrepos: { simon/app: { harness: codex } }\n",
    "builder: { harness: claude }\n",
  );
  const read1 = read(roleGroups);
  expect(read1.err).toBe("");
  expect([read1.settings?.lead, read1.settings?.builder]).toEqual([
    { harness: "codex" },
    { harness: "codex" },
  ]);
  // Your model belongs to your harness, so a bad one isn't read either.
  files("harness: claude\nmodel: [1]\nrepos: { simon/app: { harness: codex } }\n", null);
  expect(read(["lead"]).settings?.lead).toEqual({ harness: "codex" });
  // With a model of yours, your harness decides whether it goes along on Codex, so a bad one
  // counts, and is refused.
  files("harness: invalid\nmodel: opus\nrepos: { simon/app: { harness: codex } }\n", null);
  expect(read(["lead"]).err).toContain("config.yaml isn't valid: harness");
  // Without the override, yours is read and refused.
  files("harness: invalid\n", null);
  expect(read(["lead"]).err).toContain("config.yaml isn't valid");
});

test("your model goes along when your repos: override names your own harness", () => {
  files("harness: claude\nmodel: sonnet\nrepos: { simon/app: { harness: claude } }\n", null);
  expect(read(["builder"]).settings?.builder).toEqual({ harness: "claude", model: "sonnet" });
  // With no harness of yours, the built-in one counts as yours.
  files("model: sonnet\nrepos: { simon/app: { harness: claude } }\n", null);
  expect(read(["builder"]).settings?.builder).toEqual({ harness: "claude", model: "sonnet" });
  // Onto another harness, it doesn't.
  files("harness: claude\nmodel: sonnet\nrepos: { simon/app: { harness: codex } }\n", null);
  expect(read(["builder"]).settings?.builder).toEqual({ harness: "codex" });
});

test("a role your repos: override puts back on your harness gets your model again", () => {
  files(
    "harness: claude\nmodel: opus\nrepos: { simon/app: { harness: codex, roles: { builder: { harness: claude } } } }\n",
    null,
  );
  const settings = read(["builder", "lead"]).settings;
  expect([settings?.builder, settings?.lead]).toEqual([
    { harness: "claude", model: "opus" },
    { harness: "codex" },
  ]);
  // Your model counts there, so one that isn't valid is refused, while the lead, on Codex, never
  // reads it.
  files(
    "harness: claude\nmodel: [1]\nrepos: { simon/app: { harness: codex, roles: { builder: { harness: claude } } } }\n",
    null,
  );
  expect(read(["builder"]).err).toContain("config.yaml isn't valid");
  expect(read(["lead"]).settings?.lead).toEqual({ harness: "codex" });
});

test("a role your repos: override decides whole isn't read below it, so a bad one there stops nothing", () => {
  files(
    "harness: claude\nbuilder: { harness: invalid }\nrepos: { simon/app: { harness: codex, model: gpt } }\n",
    "builder: { harness: invalid }\nreviewer: { model: [1] }\n",
  );
  const settings = read(roleGroups);
  expect(settings.err).toBe("");
  expect([settings.settings?.builder, settings.settings?.reviewer]).toEqual([
    { harness: "codex", model: "gpt" },
    { harness: "codex", model: "gpt" },
  ]);
  // An override naming only a harness replaces the repository's harness. With no model in the
  // repository's line, nothing below can count, so its bad harness stops nothing.
  files(
    "harness: claude\nrepos: { simon/app: { harness: codex } }\n",
    "builder: { harness: invalid }\n",
  );
  const bare = read(["builder"]);
  expect(bare.err).toBe("");
  expect(bare.settings?.builder).toEqual({ harness: "codex" });
  // A model there counts if the line is on that harness, so its harness is still read.
  files(
    "harness: claude\nrepos: { simon/app: { harness: codex } }\n",
    "builder: { harness: invalid, model: gpt }\n",
  );
  expect(read(["builder"]).err).toContain("skelcrew.yaml isn't valid: builder.harness");
  files(
    "harness: claude\nrepos: { simon/app: { harness: codex } }\n",
    "builder: { harness: codex, model: gpt }\n",
  );
  expect(read(["builder"]).settings?.builder).toEqual({ harness: "codex", model: "gpt" });
});

test("an override that decides a role from several of its own lines reads nothing below it", () => {
  files(
    "harness: claude\nrepos: { simon/app: { harness: codex, roles: { builder: { model: gpt } } } }\n",
    "builder: { harness: invalid }\n",
  );
  const settings = read(["builder"]);
  expect(settings.err).toBe("");
  expect(settings.settings?.builder).toEqual({ harness: "codex", model: "gpt" });
});

test("your model that would be used is checked, though your override names the harness", () => {
  files("harness: claude\nmodel: [1]\nrepos: { simon/app: { harness: claude } }\n", null);
  expect(read(["builder"]).err).toContain("config.yaml isn't valid");
  // On another harness, your model isn't used, so it isn't read.
  files("harness: claude\nmodel: [1]\nrepos: { simon/app: { harness: codex } }\n", null);
  expect(read(["builder"]).settings?.builder).toEqual({ harness: "codex" });
});

test("a lower role's model your override replaces isn't checked, while the harness it gives is", () => {
  files(
    "harness: claude\nrepos: { simon/app: { roles: { builder: { model: gpt } } } }\n",
    "builder: { harness: codex, model: [bad] }\n",
  );
  const settings = read(["builder"]);
  expect(settings.err).toBe("");
  expect(settings.settings?.builder).toEqual({ harness: "codex", model: "gpt" });
  // Without the override, the bad model counts, and is refused, saying where.
  files("harness: claude\n", "builder: { harness: codex, model: [bad] }\n");
  expect(read(["builder"]).err).toContain("skelcrew.yaml isn't valid: builder.model");
});

test("a model alone in your repos: override isn't read for a role it can't fit", () => {
  files(
    "harness: claude\nrepos: { simon/app: { model: [bad] } }\n",
    "builder: { harness: codex }\n",
  );
  const settings = read(["builder"]);
  expect(settings.err).toBe("");
  expect(settings.settings?.builder).toEqual({ harness: "codex" });
  // For a role on your harness it counts, and is refused.
  expect(read(["lead"]).err).toContain("isn't valid under repos: simon/app: model");
});

test("your override's model for every role fits the role's last harness, wherever that is set", () => {
  // The override puts the builder back on your harness, so its model goes along.
  files(
    "harness: claude\nrepos: { simon/app: { model: sonnet, roles: { builder: { harness: claude } } } }\n",
    "builder: { harness: codex }\n",
  );
  expect(read(["builder"]).settings?.builder).toEqual({ harness: "claude", model: "sonnet" });
  // The override decides both, so a bad harness the repository gives the builder stops nothing.
  files(
    "harness: claude\nrepos: { simon/app: { model: sonnet, roles: { builder: { harness: claude } } } }\n",
    "builder: { harness: invalid }\n",
  );
  const decided = read(["builder"]);
  expect(decided.err).toBe("");
  expect(decided.settings?.builder).toEqual({ harness: "claude", model: "sonnet" });
  // The override puts the builder on Codex, so its model can't fit, and a bad one stops nothing.
  files(
    "harness: claude\nrepos: { simon/app: { model: [bad], roles: { builder: { harness: codex } } } }\n",
    "builder: { harness: claude }\n",
  );
  const moved = read(["builder"]);
  expect(moved.err).toBe("");
  expect(moved.settings?.builder).toEqual({ harness: "codex" });
});

test("a role line that isn't a mapping stops its role only where it could count", () => {
  files(
    "harness: claude\nrepos: { simon/app: { roles: { builder: { harness: codex, model: gpt } } } }\n",
    "builder: bad\n",
  );
  const replaced = read(["builder"]);
  expect(replaced.err).toBe("");
  expect(replaced.settings?.builder).toEqual({ harness: "codex", model: "gpt" });
  // Without the override, it decides the builder, so it is refused.
  files("harness: claude\n", "builder: bad\n");
  expect(read(["builder"]).err).toContain("skelcrew.yaml isn't valid: builder isn't a mapping");
});

test("a harness or model left empty isn't valid, and is refused where it counts", () => {
  files("harness: claude\nbuilder: { harness: null }\n", null);
  expect(read(["builder"]).err).toContain("builder.harness");
  files("harness: claude\nbuilder: { model: null }\n", "builder: { model: }\n");
  expect(read(["builder"]).err).toContain("skelcrew.yaml isn't valid: builder.model");
  files("harness: null\n", null);
  expect(read(["lead"]).err).toContain("config.yaml isn't valid: harness");
  // An empty one in your override counts over everything below it, so it is refused.
  files("harness: claude\nrepos: { simon/app: { roles: { builder: { model: null } } } }\n", null);
  expect(read(["builder"]).err).toContain("under repos: simon/app: roles.builder.model");
  // Your override replaces both, so empty ones below it stop nothing.
  files(
    "harness: claude\nmodel: null\nrepos: { simon/app: { roles: { builder: { harness: codex, model: gpt } } } }\n",
    "builder: { harness: null, model: null }\n",
  );
  const replaced = read(["builder"]);
  expect(replaced.err).toBe("");
  expect(replaced.settings?.builder).toEqual({ harness: "codex", model: "gpt" });
});

test("a harness or model under repos: goes over the repository's role lines, as an override", () => {
  files(
    "harness: claude\nmodel: opus\nrepos:\n  simon/app: { harness: codex }\n",
    "builder: { harness: claude, model: sonnet }\n",
  );
  expect(read(["builder", "lead"]).settings).toMatchObject({
    builder: { harness: "codex" },
    lead: { harness: "codex" },
  });
  // A model alone belongs to your harness, so it reaches only the roles left on it.
  files(
    "harness: claude\nmodel: opus\nrepos:\n  simon/app: { model: sonnet }\n",
    "reviewer: { harness: codex }\n",
  );
  expect(read(["builder", "reviewer"]).settings).toMatchObject({
    builder: { harness: "claude", model: "sonnet" },
    reviewer: { harness: "codex" },
  });
  // The override's own role lines still go over its harness.
  files(
    "harness: claude\nrepos:\n  simon/app: { harness: codex, roles: { lead: { harness: claude } } }\n",
    null,
  );
  expect(read(["lead", "builder"]).settings).toMatchObject({
    lead: { harness: "claude" },
    builder: { harness: "codex" },
  });
});

test("a model alone under repos: goes over the repository's role models on your harness", () => {
  files(
    "harness: claude\nrepos:\n  simon/app: { model: sonnet }\n",
    "builder: { model: opus }\nreviewer: { harness: codex, model: gpt-6 }\n",
  );
  expect(read(["builder", "reviewer"]).settings).toMatchObject({
    builder: { harness: "claude", model: "sonnet" },
    reviewer: { harness: "codex", model: "gpt-6" },
  });
});

test("rounds: in your config replaces max_rounds:, which still works, and under repos: too", () => {
  files("max_rounds: 5\n", null);
  expect(read(["rounds"]).settings?.rounds).toBe(5);
  files("max_rounds: 5\nrounds: 4\n", null);
  expect(read(["rounds"]).settings?.rounds).toBe(4);
  files("rounds: 4\nrepos:\n  simon/app: { rounds: 6, max_rounds: 9 }\n", "max_rounds: 2\n");
  expect(read(["rounds"]).settings?.rounds).toBe(6);
  expect(read(["rounds"], "other").settings?.rounds).toBe(4);
  files("rounds: 0\n", null);
  expect(read(["rounds"]).err).toContain("config.yaml isn't valid");
});

test("where a file names rounds: and the old max_rounds:, only rounds: is read", () => {
  files("rounds: 4\nmax_rounds: 0\n", null);
  expect(read(["rounds"]).settings?.rounds).toBe(4);
  files("repos: { simon/app: { rounds: 5, max_rounds: many } }\n", null);
  expect(read(["rounds"]).settings?.rounds).toBe(5);
  // The new key is the one that counts, so a bad one is refused though the old one is fine.
  files("rounds: 0\nmax_rounds: 4\n", null);
  expect(read(["rounds"]).err).toContain("config.yaml isn't valid");
});

test("many bad role values below an override that decides the role stop nothing, and quickly", () => {
  // Bad harnesses and models in every lower layer. Trying every combination of them would take
  // millions of merges.
  files(
    "harness: invalid\nmodel: [1]\nroles: { builder: { harness: nope, model: [2] } }\nbuilder: { harness: no, model: [3] }\nrepos: { simon/app: { roles: { builder: { harness: codex, model: gpt } } } }\n",
    "builder: { harness: bad, model: [4] }\n",
  );
  const started = Date.now();
  const settings = read(["builder"]);
  expect(settings.err).toBe("");
  expect(settings.settings?.builder).toEqual({ harness: "codex", model: "gpt" });
  expect(Date.now() - started).toBeLessThan(10_000);
  // Without the override, they decide the builder, and the first that counts is refused.
  files(
    "harness: invalid\nmodel: [1]\nroles: { builder: { harness: nope, model: [2] } }\nbuilder: { harness: no, model: [3] }\n",
    "builder: { harness: bad, model: [4] }\n",
  );
  expect(read(["builder"]).err).toContain("skelcrew.yaml isn't valid: builder.harness");
  // Every harness and model bad, in every layer: trying each combination of them took seconds.
  files(
    "harness: a\nmodel: [1]\nroles: { builder: { harness: b, model: [2] } }\nbuilder: { harness: c, model: [3] }\nrepos: { simon/app: { harness: d, model: [4], roles: { builder: { harness: e, model: [5] } }, builder: { harness: f, model: [6] } } }\n",
    "builder: { harness: g, model: [7] }\n",
  );
  const worst = Date.now();
  expect(read(["builder"]).err).toContain(
    "isn't valid under repos: simon/app: roles.builder.harness",
  );
  expect(Date.now() - worst).toBeLessThan(3_000);
});
