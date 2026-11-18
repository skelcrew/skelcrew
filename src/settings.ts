// Reads every setting, from your overrides for the repository under repos: in your config.yaml,
// the repository's files in Skelcrew's clone, the rest of your config.yaml and the built-in
// defaults. Each setting comes from the first of them that sets it.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HarnessName } from "./agents/harness.ts";
import { builtInRounds, repositoryRounds } from "./flows.ts";
import { cloneDir, configDir } from "./paths.ts";
import { type RoleName, repositoryRole } from "./roles.ts";

// A repository Skelcrew works on, by its owner and name. `agents` is the tree of .agents/ whose
// role files count, as repositoryRole takes it: a task's own, or without it the one you approved.
export type Repository = { owner: string; repo: string; agents?: string | null };

// A model is plain text, passed to the harness as written: Skelcrew keeps no list of names, and a
// harness that names models as provider/model knows its own providers.
const Model = z.string().min(1);
// A role's own harness and model, either of them optional.
const RoleSettings = z.looseObject({ harness: HarnessName.optional(), model: Model.optional() });
type RoleSettings = z.infer<typeof RoleSettings>;

// What the files may hold. Unknown keys pass, so settings this version doesn't know do no harm.
// A bare `tracker:` is YAML's null, which counts as no line at all, so the forge stays the
// tracker.
const File = z.looseObject({
  harness: HarnessName.optional(),
  model: Model.optional(),
  lead: RoleSettings.optional(),
  builder: RoleSettings.optional(),
  reviewer: RoleSettings.optional(),
  // Each role's harness and model in the new shape, as roles: { builder: { model: sonnet } }.
  // Read as lead:, builder: and reviewer: are, which it goes over key by key.
  roles: z.record(z.string(), RoleSettings).optional(),
  max_rounds: z.number().int().positive().optional(),
  limits: z
    .looseObject({
      reviews: z.number().int().positive().optional(),
      checks: z.number().int().positive().optional(),
    })
    .optional(),
  setup: z.array(z.string()).optional(),
  test: z.array(z.string()).optional(),
  tracker: z.string().nullish(),
  review: z.looseObject({ timeout_minutes: z.number().positive().optional() }).optional(),
  // Written as reviewer: { fallback: codex }, and picked out of the reviewer's lines on reading,
  // so a bad one stops only a thread, not the lead.
  fallback: HarnessName.optional(),
  // The reviewer's harness as your config saved it, picked out of the reviewer's lines the same
  // way. One that isn't valid counts as none, so the first run asks for it again.
  your_reviewer: HarnessName.optional().catch(undefined),
  // The repositories, by full name, never offered the GitHub plugin again because you said no
  // in one of their checkouts.
  github_declined: z.array(z.string()).optional(),
});
type File = z.infer<typeof File>;
type Key = keyof typeof File.shape;

// The harness a role runs on, and its model, or none for the harness's default.
export type Role = { harness: HarnessName; model?: string };

// Every setting, once the files and the defaults are merged. `lead`, `builder` and `reviewer` are
// each role's harness and model, read one by one, so a mistake in one role's settings stops only
// the agents of that role. `rounds` is how many rounds of
// changes a thread gets before it needs you, `reviews` how many reviews run at once on this
// machine, `checks` how many test suites run at once through sc check, and `setup` and `test` the commands that set up a thread's clone and run its whole
// test suite. Each is missing when no file names it, and an empty list when a file says on purpose
// that the repository needs none. `fallback` is the harness reviews run on
// while the reviewer's own waits out its usage limit, and `reviewMinutes` how long a review may
// run before it is ended. `yourHarness` and `yourReviewer` are the harnesses
// your config saved, with no default, so the first run can tell what you haven't picked yet, and
// `declined` the repositories never offered the GitHub plugin again.
export type Settings = {
  lead: Role;
  builder: Role;
  reviewer: Role;
  rounds: number;
  reviews: number;
  checks: number;
  setup: string[] | undefined;
  test: string[] | undefined;
  tracker: string | undefined;
  fallback: HarnessName | undefined;
  reviewMinutes: number;
  yourHarness: HarnessName | undefined;
  yourReviewer: HarnessName | undefined;
  declined: string[];
};
type Group = keyof Settings;

// The keys of the files behind each setting. A role's model belongs to its harness, so a role is
// read together with your harness and model.
const keysOf: Record<Group, Key[]> = {
  lead: ["harness", "model", "lead", "roles"],
  builder: ["harness", "model", "builder", "roles"],
  reviewer: ["harness", "model", "reviewer", "roles"],
  rounds: ["max_rounds"],
  reviews: ["limits"],
  checks: ["limits"],
  setup: ["setup"],
  test: ["test"],
  tracker: ["tracker"],
  fallback: ["fallback"],
  reviewMinutes: ["review"],
  yourHarness: ["harness"],
  yourReviewer: ["your_reviewer"],
  declined: ["github_declined"],
};

// What each file may set. Your harness, model, limits, the reviewer's fallback, a review's time
// and the repositories you declined the GitHub plugin for fit you, your account and your
// machine, so a repository can't set them. The tracker belongs to the repository, so your
// config doesn't. Setup and test can come from either: yours stand in for a repository you
// don't want to commit a skelcrew.yaml to.
const yourKeys: Key[] = [
  "harness",
  "model",
  "lead",
  "builder",
  "reviewer",
  "roles",
  "max_rounds",
  "setup",
  "test",
  "limits",
  "review",
  "fallback",
  "your_reviewer",
  "github_declined",
];
const repositoryKeys: Key[] = [
  "lead",
  "builder",
  "reviewer",
  "max_rounds",
  "setup",
  "test",
  "tracker",
];
// What an override under repos: may set: what the repository's own files may, but its tracker,
// and the harness and model of its roles. What is only yours, such as limits, stays in your
// general settings, as an override is about one repository and limits are about your machine.
// The tracker is shared with everyone who works on the repository, so no one changes it alone.
const overrideKeys: Key[] = [
  "harness",
  "model",
  "lead",
  "builder",
  "reviewer",
  "roles",
  "max_rounds",
  "setup",
  "test",
];
const roleKeys: Key[] = ["lead", "builder", "reviewer", "roles"];

// Returns the built-in defaults: Claude Code for every role, the built-in flow's rounds and 30
// minutes for a review. Setup, test and the tracker have none. Reviews default to a quarter of this machine's
// cores, at least one, as a review of a commit CI doesn't run on runs the repository's whole test
// suite, and many at once fight over the CPU. Checks default to half the cores divided by four,
// at least one: a test suite usually runs about four processes of its own, so half the cores
// stay free for the agents and the screen.
function builtInDefaults(): {
  harness: HarnessName;
  max_rounds: number;
  reviews: number;
  checks: number;
  reviewMinutes: number;
} {
  return {
    harness: "claude",
    max_rounds: builtInRounds(),
    reviews: Math.max(1, Math.floor(availableParallelism() / 4)),
    checks: Math.max(1, Math.floor(availableParallelism() / 2 / 4)),
    reviewMinutes: 30,
  };
}

// Returns the settings in `groups`, for `repository` when there is one. Only the groups asked
// for are read and checked, so a bad round limit stops a thread, not the lead. A file only
// counts for the keys it may set. Throws, naming the file, when one isn't valid, rather than run
// an agent on settings you didn't pick. The return type has only the groups asked for.
export function readSettings<G extends Group>(
  groups: G[],
  repository?: Repository,
): Pick<Settings, G> {
  const wanted = groups.flatMap((group) => keysOf[group]);
  const overrides = repository ? readOverrides(wanted, repository) : {};
  // sc init asks without a repository, for the starter skelcrew.yaml it writes.
  const shared = repository
    ? readRepositoryFile(
        wanted.filter((k) => repositoryKeys.includes(k)),
        repository,
      )
    : {};
  // The repository's .agents/, a layer of its own just over skelcrew.yaml, as its files replace
  // that file's old keys: the role files' harness and model go over lead:, builder: and
  // reviewer:, as a model must follow the harness each layer leaves, and the default flow's
  // rounds go over max_rounds. Only the files of the settings asked for are read, so a broken
  // reviewer file never stops the lead.
  const agentsFiles: File = {};
  for (const name of ["lead", "builder", "reviewer"] as const)
    if (repository && groups.some((group) => group === name))
      agentsFiles[name] = roleFileSettings(name, repository);
  if (repository && groups.some((group) => group === "rounds"))
    agentsFiles.max_rounds = repositoryRounds(repository);
  // A setting your override or the repository sets is not read from the rest of your config, so
  // a bad value there can't stop a repository that decides it. A role is the exception: yours
  // merges with the repository's, as a model goes along only while the role stays on your
  // harness.
  const decided = (k: Key) =>
    [overrides, agentsFiles, shared].some((l) => l[k] !== undefined && l[k] !== null) &&
    !roleKeys.includes(k);
  const fromYours = wanted.filter((k) => yourKeys.includes(k) && !decided(k));
  return mergeSettings([overrides, agentsFiles, shared, readYourFile(fromYours)]);
}

// Returns the harness and model a repository's role file names, or nothing when it names neither
// or the repository has no file for the role.
function roleFileSettings(name: RoleName, repository: Repository): RoleSettings | undefined {
  const { harness, model } = repositoryRole(name, repository);
  if (harness === undefined && model === undefined) return undefined;
  return { ...(harness && { harness }), ...(model && { model }) };
}

// Returns your config.yaml as YAML data, or nothing when you have none.
function yourConfig(): unknown {
  const file = join(configDir(), "config.yaml");
  return existsSync(file) ? parseYaml(file, file) : undefined;
}

// Returns your config.yaml, holding only `keys`, checked. A file with none of them isn't read,
// so a broken one stops only what it could change.
function readYourFile(keys: Key[]): File {
  if (keys.length === 0) return {};
  const file = join(configDir(), "config.yaml");
  return check(pick(yourConfig(), keys), `${file} isn't valid`);
}

// Returns your overrides for the repository, from repos: in your config.yaml, holding only the
// `keys` an override may set, checked. A repository is named by its owner/name, in any case, as
// forges ignore case in names. Only its own entry is checked, so a mistake in another
// repository's stops only that one.
function readOverrides(keys: Key[], repository: Repository): File {
  const wanted = keys.filter((k) => overrideKeys.includes(k));
  if (wanted.length === 0) return {};
  const file = join(configDir(), "config.yaml");
  const repos = z
    .object({ repos: z.record(z.string(), z.unknown()).nullish() })
    .safeParse(yourConfig() ?? {});
  if (!repos.success) throw new Error(`${file} isn't valid: ${z.prettifyError(repos.error)}`);
  const name = `${repository.owner}/${repository.repo}`.toLowerCase();
  const [, entry] =
    Object.entries(repos.data.repos ?? {}).find(([key]) => key.toLowerCase() === name) ?? [];
  if (entry === undefined || entry === null) return {};
  const problem = `${file} isn't valid under repos: ${repository.owner}/${repository.repo}`;
  return check(pick(entry, wanted), problem);
}

// Returns the repository's skelcrew.yaml, holding only `keys`, checked, or nothing when it has
// none. It is read from Skelcrew's clone, which is at the default branch, so a change counts once
// it is pushed there. A link is refused, since it could point at any file of yours.
function readRepositoryFile(keys: Key[], repository: Repository): File {
  if (keys.length === 0) return {};
  const file = join(cloneDir(repository.owner, repository.repo), "skelcrew.yaml");
  // lstat, so a link is seen as one and refused, not followed.
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return {};
  if (!stat.isFile())
    throw new Error("the repository's skelcrew.yaml isn't a plain file, so Skelcrew won't read it");
  const read = pick(parseYaml(file, "the repository's skelcrew.yaml"), keys);
  return check(read, "the repository's skelcrew.yaml isn't valid");
}

// Returns what the YAML file at `path` holds, or throws naming it as `name` when it isn't YAML.
function parseYaml(path: string, name: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return parse(text);
  } catch (error) {
    throw new Error(`${name} isn't valid YAML: ${error instanceof Error ? error.message : error}`);
  }
}

// Returns the `keys` of what a file held. An empty file, or one that isn't a mapping, gives
// nothing to keep, and File's check says so for the second.
function pick(data: unknown, keys: Key[]): unknown {
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) return data;
  // The fallback and your reviewer's harness are written among the reviewer's lines, but read
  // on their own. A top-level line of either name counts for nothing, as it never did.
  const nested = ["fallback", "your_reviewer"];
  const picked = Object.fromEntries(
    Object.entries(data).filter(([key]) => !nested.includes(key) && keys.some((k) => k === key)),
  );
  // Of roles:, only the roles asked for are kept, so a mistake in another role stops only its
  // own agents. One that isn't a mapping is kept whole, for the check to refuse.
  if (isMapping(picked.roles))
    picked.roles = Object.fromEntries(
      Object.entries(picked.roles).filter(([name]) => keys.some((k) => k === name)),
    );
  // The new shape's reviewer comes last, so it wins where both shapes say something.
  const roles = "roles" in data ? data.roles : undefined;
  const reviewers = [
    "reviewer" in data ? data.reviewer : undefined,
    typeof roles === "object" && roles !== null && "reviewer" in roles ? roles.reviewer : undefined,
  ];
  for (const reviewer of reviewers)
    if (typeof reviewer === "object" && reviewer !== null) {
      if (keys.includes("fallback") && "fallback" in reviewer) picked.fallback = reviewer.fallback;
      if (keys.includes("your_reviewer") && "harness" in reviewer)
        picked.your_reviewer = reviewer.harness;
    }
  return picked;
}

// Returns whether YAML data is a mapping, such as { model: opus }.
const isMapping = (data: unknown): data is Record<string, unknown> =>
  typeof data === "object" && data !== null && !Array.isArray(data);

// Returns `data` checked as a settings file, or throws `problem` with what is wrong.
function check(data: unknown, problem: string): File {
  const read = File.safeParse(data);
  if (!read.success) throw new Error(`${problem}: ${z.prettifyError(read.error)}`);
  return read.data;
}

// Merges the files, the one that wins first, over the built-in defaults: each setting comes from
// the first that sets it, key by key.
function mergeSettings(layers: File[]): Settings {
  const defaults = builtInDefaults();
  // The first value any layer sets for `get`.
  const first = <T>(get: (layer: File) => T | undefined | null) =>
    layers.map(get).find((value) => value !== undefined && value !== null);
  const top = {
    harness: first((l) => l.harness) ?? defaults.harness,
    model: first((l) => l.model),
  };
  // Each layer's say on one role, merged.
  const role = (name: "lead" | "builder" | "reviewer") =>
    mergeRole(
      // In each layer, roles: goes over the old lead:, builder: and reviewer: lines.
      layers.flatMap((l) => [l.roles?.[name], l[name]]),
      top,
    );
  return {
    lead: role("lead"),
    builder: role("builder"),
    reviewer: role("reviewer"),
    rounds: first((l) => l.max_rounds) ?? defaults.max_rounds,
    reviews: first((l) => l.limits?.reviews) ?? defaults.reviews,
    checks: first((l) => l.limits?.checks) ?? defaults.checks,
    setup: first((l) => l.setup),
    test: first((l) => l.test),
    tracker: first((l) => l.tracker),
    fallback: first((l) => l.fallback),
    reviewMinutes: first((l) => l.review?.timeout_minutes) ?? defaults.reviewMinutes,
    yourHarness: first((l) => l.harness),
    yourReviewer: first((l) => l.your_reviewer),
    declined: first((l) => l.github_declined) ?? [],
  };
}

// Returns a role's harness and model from what each layer says of it, the one that wins first,
// and `top`, the harness and model every role gets unless it names its own. A model name belongs
// to its harness, so a model goes along only while the role stays on the harness it was given with:
// reviewer: { harness: codex } in skelcrew.yaml must never run Codex on your opus. With no
// model left, the harness picks its default.
function mergeRole(
  layers: (z.infer<typeof RoleSettings> | undefined)[],
  top: { harness: HarnessName; model: string | undefined },
): Role {
  let harness = top.harness;
  let model = top.model;
  // From the last layer to the first, so each one goes over what is below it. A layer that
  // moves the role to another harness drops the model below it, and the role gets your model
  // again only when it moves back onto your harness.
  for (const role of [...layers].reverse()) {
    if (role?.harness !== undefined && role.harness !== harness) {
      harness = role.harness;
      model = harness === top.harness ? top.model : undefined;
    }
    model = role?.model ?? model;
  }
  return model === undefined ? { harness } : { harness, model };
}
