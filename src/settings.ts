// Reads every setting, from your overrides for the repository under repos: in your config.yaml,
// the repository's files in Skelcrew's clone, the rest of your config.yaml and the built-in
// defaults. Each setting comes from the first of them that sets it.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HarnessName } from "./agents/harness.ts";
import { builtInRounds, flowRoles, repositoryRounds } from "./flows.ts";
import { cloneDir, configDir } from "./paths.ts";
import { type RoleName, repositoryRole } from "./roles.ts";

// A repository Skelcrew works on, by its owner and name. `agents` is the tree of .agents/ whose
// role files count, as repositoryRole takes it: a task's own, or without it the one you approved.
// `flow` is the flow whose file gives the round limit and the roles of its stages: a task's own,
// or without it `default`.
export type Repository = { owner: string; repo: string; agents?: string | null; flow?: string };

// A model is plain text, passed to the harness as written: Skelcrew keeps no list of names, and a
// harness that names models as provider/model knows its own providers.
const Model = z.string().min(1);

// What the files may hold, but the roles, which roleOf reads on its own. Unknown keys pass, so
// settings this version doesn't know do no harm.
// A bare `tracker:` is YAML's null, which counts as no line at all, so the forge stays the
// tracker.
const File = z.looseObject({
  harness: HarnessName.optional(),
  model: Model.optional(),
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

// The keys of the files behind each setting. The roles have none here, as each is read on its
// own, layer by layer, by roleOf.
const keysOf: Record<Group, Key[]> = {
  lead: [],
  builder: [],
  reviewer: [],
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
  "max_rounds",
  "setup",
  "test",
  "limits",
  "review",
  "fallback",
  "your_reviewer",
  "github_declined",
];
const repositoryKeys: Key[] = ["max_rounds", "setup", "test", "tracker"];
// What an override under repos: may set, besides the harness and model of its roles, which
// roleOf reads: what the repository's own files may, but its tracker. What is only yours, such as limits, stays in your
// general settings, as an override is about one repository and limits are about your machine.
// The tracker is shared with everyone who works on the repository, so no one changes it alone.
const overrideKeys: Key[] = ["max_rounds", "setup", "test"];

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
  // Each layer is read from the one that wins first, and a setting a layer above decides isn't
  // read again below it, so a bad value there can't stop a setting it doesn't decide.
  const decidedBy = (layers: File[]) => (k: Key) =>
    layers.some((l) => l[k] !== undefined && l[k] !== null);
  const overrides = repository ? readOverrides(wanted, repository) : {};
  // The rounds of the task's flow, `default` unless it named another, go over max_rounds in
  // skelcrew.yaml, which they replace. The flow file is checked even when your override decides
  // the round limit, as its stages still say which roles run.
  const agentsFiles: File = {};
  if (repository && groups.some((group) => group === "rounds"))
    agentsFiles.max_rounds = repositoryRounds(repository, decidedBy([overrides])("max_rounds"));
  // sc init asks without a repository, for the starter skelcrew.yaml it writes. The old
  // max_rounds in skelcrew.yaml was the default flow's round limit, so another flow without
  // rounds of its own never takes it, and gets yours or the built-in one.
  const aboveShared = decidedBy([overrides, agentsFiles]);
  const otherFlow = (repository?.flow ?? "default") !== "default";
  const shared = repository
    ? readRepositoryFile(
        wanted.filter(
          (k) =>
            repositoryKeys.includes(k) && !aboveShared(k) && !(k === "max_rounds" && otherFlow),
        ),
        repository,
      )
    : {};
  const decided = decidedBy([overrides, agentsFiles, shared]);
  const fromYours = wanted.filter((k) => yourKeys.includes(k) && !decided(k));
  // Only the roles asked for are read, so a mistake in one role's settings stops only its own
  // agents. `builder` and `reviewer` are the roles the task's flow runs in the build and review
  // stages, which are those two unless the flow names one of the repository's own, such as
  // tester, whose settings are then read.
  const runs = { lead: "lead", builder: "builder", reviewer: "reviewer" };
  if (repository && groups.some((group) => group === "builder" || group === "reviewer")) {
    const stages = flowRoles(repository);
    runs.builder = stages.build;
    runs.reviewer = stages.review;
  }
  const roles: Partial<Record<RoleName, Role>> = {};
  for (const name of ["lead", "builder", "reviewer"] as const)
    if (groups.some((group) => group === name)) roles[name] = roleOf(name, runs[name], repository);
  return mergeSettings([overrides, agentsFiles, shared, readYourFile(fromYours)], roles);
}

// A layer's say on one role: the harness and model it names, each read only when asked for, as
// a lower layer is read only where it can still change the role. `everyRole` marks a layer's own
// harness and model for every role, rather than for this one.
type Say = {
  harness: () => HarnessName | undefined;
  model: () => string | undefined;
  everyRole?: boolean;
};

// Returns the say on a role at `path` in the YAML data `read` gives, such as ["roles",
// "builder"]. Nothing is read until asked for, and its harness and model are each checked on
// their own, as they are read, so a bad one that never counts stops nothing. A bad one that is
// read throws `problem`, saying where.
function sayIn(read: () => unknown, path: string[], problem: string): Say {
  const mapping = once(() => {
    let data = read();
    for (const [at, key] of path.entries()) {
      if (data === undefined || data === null) return {};
      if (!isMapping(data))
        throw new Error(`${problem}: ${path.slice(0, at).join(".") || "the file"} isn't a mapping`);
      data = data[key];
    }
    if (data === undefined || data === null) return {};
    if (!isMapping(data))
      throw new Error(`${problem}: ${path.join(".") || "the file"} isn't a mapping`);
    return data;
  });
  // Returns the field `key` checked with `schema`, or nothing when it isn't there.
  const field = <T>(key: "harness" | "model", schema: z.ZodType<T>) =>
    once(() => {
      const read = schema.optional().safeParse(mapping()[key]);
      if (!read.success)
        throw new Error(`${problem}: ${[...path, key].join(".")}: ${z.prettifyError(read.error)}`);
      return read.data;
    });
  return { harness: field("harness", HarnessName), model: field("model", Model) };
}

// Returns `read` remembering what it gave, so each file is read and checked at most once.
function once<T>(read: () => T): () => T {
  let done: { value: T } | undefined;
  return () => {
    done ??= { value: read() };
    return done.value;
  };
}

// Returns the harness and model one role runs on, for `repository` when there is one. Each layer
// says something of it, the one that wins first: your override under repos:, the repository's
// role file, its skelcrew.yaml's line, then your config. In each, roles: goes over the old role
// line, which goes over the layer's own harness and model for every role. Every role starts
// from your harness and model, and the layers move it. A model belongs to its harness, so a
// model goes along only while the role stays on the harness it was given with: reviewer:
// { harness: codex } in skelcrew.yaml must never run Codex on your opus. A layer's model for
// every role, given without a harness, fits only a role on your harness. With no model left,
// the harness picks its default.
// The layers are read from the top, and a value is read and checked only when it can still
// change the role, so a bad one an override replaces stops nothing. A value that counts is
// always checked, and throws, naming its file, when it isn't valid.
// `run` is the role that runs as `name`, which differs for a flow that names one of the
// repository's own, such as tester for the builder. Its roles: lines and its role file then
// count, and the old builder: and reviewer: lines, which are the built-in roles', don't.
function roleOf(name: RoleName, run: string, repository: Repository | undefined): Role {
  const says: Say[] = [];
  // The old line for the role in a file, which counts only for the built-in role it names.
  const line = (read: () => unknown, problem: string): Say[] =>
    run === name ? [sayIn(read, [name], problem)] : [];
  const yourFile = `${join(configDir(), "config.yaml")} isn't valid`;
  // In each layer, the say in roles: for the role goes over its old line, which goes over the
  // layer's harness and model for every role.
  if (repository) {
    const entry = once(() => overrideEntry(repository));
    const problem = overrideProblem(repository);
    says.push(sayIn(entry, ["roles", run], problem), ...line(entry, problem), {
      ...sayIn(entry, [], problem),
      everyRole: true,
    });
    // The role file's frontmatter, whose keys are checked as the file is read, and its harness
    // and model only where they count. It is the file of the role that runs.
    const role = `.agents/roles/${run}.md in ${repository.owner}/${repository.repo} isn't valid`;
    says.push(sayIn(() => repositoryRole(run, repository).frontmatter, [], role));
    const shared = once(() => repositoryData(repository));
    says.push(...line(shared, "the repository's skelcrew.yaml isn't valid"));
  }
  says.push(sayIn(yourConfig, ["roles", run], yourFile), ...line(yourConfig, yourFile));
  // Your own harness, or the built-in one, and your model, which every role starts from.
  const yours = sayIn(yourConfig, [], yourFile);
  const yourHarness = once(() => yours.harness() ?? builtInDefaults().harness);
  const yourModel = yours.model;
  // Whether your harness is `harness`, without stopping on one that isn't valid, as it is asked
  // only to tell whether your model goes along, and a bad one of yours is never `harness`.
  const isYourHarness = (harness: HarnessName) => {
    try {
      return yourHarness() === harness;
    } catch {
      return false;
    }
  };
  // The harness the says from `from` down name first, or nothing when none does.
  const namedFrom = (from: number) =>
    says
      .slice(from)
      .find((say) => say.harness() !== undefined)
      ?.harness();
  // Whether the role is on `harness` from the say at `from` down: the first that names a harness
  // decides, or else yours.
  const onHarness = (from: number, harness: HarnessName): boolean => {
    const named = namedFrom(from);
    return named === undefined ? isYourHarness(harness) : named === harness;
  };
  // The harness from the say at `from` down: the first one named, or else yours.
  const harnessFrom = (from: number): HarnessName => namedFrom(from) ?? yourHarness();
  // The model from the say at `from` down, as each say leaves it.
  const modelFrom = (from: number): string | undefined => {
    const say = says[from];
    if (say === undefined) return yourModel();
    const harness = say.harness();
    // A model named counts, unless it is a layer's model for every role, given without a
    // harness, and the role isn't on your harness. Then it can't count, so it isn't read.
    const forAny = say.everyRole === true && harness === undefined;
    const below = forAny ? namedFrom(from + 1) : undefined;
    const fits = !forAny || below === undefined || isYourHarness(below);
    const model = fits ? say.model() : undefined;
    if (model !== undefined) return model;
    // A say that moves the role to another harness drops the model below it, and the role gets
    // your model again only when it moves onto your harness.
    if (harness !== undefined && !onHarness(from + 1, harness))
      return isYourHarness(harness) ? yourModel() : undefined;
    return modelFrom(from + 1);
  };
  const harness = harnessFrom(0);
  const model = modelFrom(0);
  return model === undefined ? { harness } : { harness, model };
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
  const entry = overrideEntry(repository);
  if (entry === undefined || entry === null) return {};
  return check(pick(entry, wanted), overrideProblem(repository));
}

// Returns what is said of a repository's override in what it says is wrong.
const overrideProblem = (repository: Repository) =>
  `${join(configDir(), "config.yaml")} isn't valid under repos: ${repository.owner}/${repository.repo}`;

// Returns your override for the repository under repos:, as YAML data, unchecked, or nothing
// when you have none. Throws when repos: itself isn't a mapping of repositories.
function overrideEntry(repository: Repository): unknown {
  const file = join(configDir(), "config.yaml");
  const repos = z
    .object({ repos: z.record(z.string(), z.unknown()).nullish() })
    .safeParse(yourConfig() ?? {});
  if (!repos.success) throw new Error(`${file} isn't valid: ${z.prettifyError(repos.error)}`);
  const name = `${repository.owner}/${repository.repo}`.toLowerCase();
  const [, entry] =
    Object.entries(repos.data.repos ?? {}).find(([key]) => key.toLowerCase() === name) ?? [];
  return entry;
}

// Returns the repository's skelcrew.yaml, holding only `keys`, checked, or nothing when it has
// none. It is read from Skelcrew's clone, which is at the default branch, so a change counts once
// it is pushed there. A link is refused, since it could point at any file of yours.
function readRepositoryFile(keys: Key[], repository: Repository): File {
  if (keys.length === 0) return {};
  return check(
    pick(repositoryData(repository), keys),
    "the repository's skelcrew.yaml isn't valid",
  );
}

// Returns the repository's skelcrew.yaml as YAML data, unchecked, or nothing when it has none.
function repositoryData(repository: Repository): unknown {
  const file = join(cloneDir(repository.owner, repository.repo), "skelcrew.yaml");
  // lstat, so a link is seen as one and refused, not followed.
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile())
    throw new Error("the repository's skelcrew.yaml isn't a plain file, so Skelcrew won't read it");
  return parseYaml(file, "the repository's skelcrew.yaml");
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
// the first that sets it, key by key. The last layer is your config. `roles` are the roles read,
// and a role not asked for is left at the built-in harness.
function mergeSettings(layers: File[], roles: Partial<Record<RoleName, Role>>): Settings {
  const defaults = builtInDefaults();
  // The first value any layer sets for `get`.
  const first = <T>(get: (layer: File) => T | undefined | null) =>
    layers.map(get).find((value) => value !== undefined && value !== null);
  const unread = { harness: defaults.harness };
  return {
    lead: roles.lead ?? unread,
    builder: roles.builder ?? unread,
    reviewer: roles.reviewer ?? unread,
    rounds: first((l) => l.max_rounds) ?? defaults.max_rounds,
    reviews: first((l) => l.limits?.reviews) ?? defaults.reviews,
    checks: first((l) => l.limits?.checks) ?? defaults.checks,
    setup: first((l) => l.setup),
    test: first((l) => l.test),
    tracker: first((l) => l.tracker),
    fallback: first((l) => l.fallback),
    reviewMinutes: first((l) => l.review?.timeout_minutes) ?? defaults.reviewMinutes,
    yourHarness: layers.at(-1)?.harness,
    yourReviewer: first((l) => l.your_reviewer),
    declined: first((l) => l.github_declined) ?? [],
  };
}
