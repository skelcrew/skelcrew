// Reads settings from your repository overrides, your general overrides, repository files,
// and built-in defaults. Your config.yaml is optional.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HarnessName } from "./agents/harness.ts";
import { defaultHarness } from "./agents/login.ts";
import {
  builtInRounds,
  flowRoles,
  hasFlowFile,
  repositoryFlows,
  repositoryRounds,
} from "./flows.ts";
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
  // Your round limit in the new shape, which replaces max_rounds in your config.yaml, at the top
  // and under repos:. A repository's skelcrew.yaml keeps max_rounds until its flow file gives
  // rounds.
  rounds: z.number().int().positive().optional(),
  limits: z
    .looseObject({
      reviews: z.number().int().positive().optional(),
      checks: z.number().int().positive().optional(),
    })
    .optional(),
  // The most builders at once in a repository, written as limits: { threads: 4 } and picked out
  // of the limits on reading, as a repository may set it but not the rest of its limits.
  threads: z.number().int().positive().optional(),
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
  // Whether the lead may arm a merge when you ask it to in the conversation, written as
  // lead: { can_merge: false } and picked out of the lead's lines on reading. may_arm_merges is
  // its old name, still read so no config breaks, and can_merge wins where a file has both.
  can_merge: z.boolean().optional(),
  may_arm_merges: z.boolean().optional(),
  // The repositories, by full name, never offered the GitHub plugin again because you said no
  // in one of their checkouts.
  github_declined: z.array(z.string()).optional(),
  // Your personal plugins, by the GitHub repository each comes from, such as
  // skelcrew/skelcrew-github. Your own skelcrew.lock pins each one's version.
  plugins: z.array(z.string()).optional(),
  // The host new sessions start on: tmux, built in, or a runtime plugin by its name.
  session: z.string().min(1).optional(),
  notify: z
    .looseObject({
      "needs-you": z.string().min(1).optional(),
      digest: z.string().min(1).optional(),
      digest_at: z
        .string()
        .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "must be a time such as 08:00")
        .optional(),
    })
    .optional(),
});
type File = z.infer<typeof File>;
type Key = keyof typeof File.shape;

// The harness a role runs on, and its model, or none for the harness's default.
export type Role = { harness: HarnessName; model?: string };

// Every setting, once the files and the defaults are merged. `lead`, `builder` and `reviewer` are
// each role's harness and model, read one by one, so a mistake in one role's settings stops only
// the agents of that role. `rounds` is how many rounds of
// changes a thread gets before it needs you, `reviews` how many reviews run at once on this
// machine, `checks` how many test suites run at once through sc check, `threads` how many
// builders run at once in the repository, or no limit when missing, and `setup` and `test` the commands that set up a thread's clone and run its whole
// test suite. Each is missing when no file names it, and an empty list when a file says on purpose
// that the repository needs none. `fallback` is the harness reviews run on
// while the reviewer's own waits out its usage limit, and `reviewMinutes` how long a review may
// run before it is ended. `yourHarness` and `yourReviewer` are the harnesses
// your config saved, with no default, so the first run can tell what you haven't picked yet, and
// `declined` the repositories never offered the GitHub plugin again. `plugins` are your personal
// plugins. `host` is where new sessions start: tmux, or the name of a runtime plugin that provides
// sessions. `leadCanMerge` is whether the lead may arm a merge when you ask it to, on unless
// you turn it off. `notify` is the plugin each type of message to you goes through, none for a
// type that isn't sent, and `digestAt` when the daily digest goes, 08:00 unless you say.
export type Settings = {
  lead: Role;
  builder: Role;
  reviewer: Role;
  rounds: number;
  reviews: number;
  checks: number;
  threads: number | undefined;
  setup: string[] | undefined;
  test: string[] | undefined;
  tracker: string | undefined;
  fallback: HarnessName | undefined;
  reviewMinutes: number;
  yourHarness: HarnessName | undefined;
  yourReviewer: HarnessName | undefined;
  declined: string[];
  plugins: string[];
  host: string;
  leadCanMerge: boolean;
  notify: Record<"needs-you" | "digest", string | undefined>;
  digestAt: string;
};
type Group = keyof Settings;

// The keys of the files behind each setting. The roles have none here, as each is read on its
// own, layer by layer, by roleOf.
const keysOf: Record<Group, Key[]> = {
  lead: [],
  builder: [],
  reviewer: [],
  rounds: ["rounds", "max_rounds"],
  reviews: ["limits"],
  checks: ["limits"],
  threads: ["threads"],
  setup: ["setup"],
  test: ["test"],
  tracker: ["tracker"],
  fallback: ["fallback"],
  reviewMinutes: ["review"],
  yourHarness: ["harness"],
  yourReviewer: ["your_reviewer"],
  declined: ["github_declined"],
  plugins: ["plugins"],
  host: ["session"],
  leadCanMerge: ["can_merge", "may_arm_merges"],
  notify: ["notify"],
  digestAt: ["notify"],
};

// What each file may set. Your harness, model, limits, the reviewer's fallback, a review's time,
// the repositories you declined the GitHub plugin for, your personal plugins and the session host
// fit you, your account and your machine, so a repository can't set them. So do where messages
// to you go, as their recipient is yours alone. Letting the lead merge grants an agent
// what is yours, so only you can say whether it may, never a repository. The tracker belongs to the repository, so your
// config doesn't. Setup and test can come from either: yours stand in for a repository you
// don't want to commit a skelcrew.yaml to.
const yourKeys: Key[] = [
  "harness",
  "model",
  "rounds",
  "max_rounds",
  "setup",
  "test",
  "limits",
  "review",
  "fallback",
  "your_reviewer",
  "github_declined",
  "plugins",
  "session",
  "can_merge",
  "may_arm_merges",
  "notify",
];
const repositoryKeys: Key[] = ["max_rounds", "setup", "test", "tracker", "threads"];
// What an override under repos: may set, besides the harness and model of its roles, which
// roleOf reads: anything about one repository, from its files or yours, as an override is you
// differing on purpose there. What is about your machine, such as limits and the session host,
// stays in your general settings. So does letting the lead merge, so no setting for one
// repository can grant it.
const overrideKeys: Key[] = [
  "rounds",
  "max_rounds",
  "threads",
  "setup",
  "test",
  "tracker",
  "fallback",
  "review",
];

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
    harness: defaultHarness(),
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
  // rounds and the old max_rounds are one setting, so either one decides both.
  const sameSetting = (k: Key): Key[] =>
    k === "rounds" || k === "max_rounds" ? ["rounds", "max_rounds"] : [k];
  const decidedBy = (layers: File[]) => (k: Key) =>
    layers.some((l) => sameSetting(k).some((key) => l[key] !== undefined && l[key] !== null));
  const overrides = repository ? readOverrides(wanted, repository) : {};
  const general = readYourFile(
    wanted.filter((k) => yourKeys.includes(k) && !decidedBy([overrides])(k)),
  );
  // The rounds of the task's flow, `default` unless it named another, go over max_rounds in
  // skelcrew.yaml, which they replace. The flow file is checked even when your override decides
  // the round limit, as its stages still say which roles run.
  const agentsFiles: File = {};
  if (repository && groups.some((group) => group === "rounds"))
    agentsFiles.max_rounds = repositoryRounds(
      repository,
      decidedBy([overrides, general])("max_rounds"),
    );
  // The old max_rounds in skelcrew.yaml is the default flow's rounds only until the repository has a
  // flow file, of any flow. From then on no flow takes it, though its file names no rounds: it
  // gets yours or the built-in round limit, and a bad max_rounds, left unread, doesn't stop it.
  const aboveShared = decidedBy([overrides, general, agentsFiles]);
  const flowFiles = (place: Repository) =>
    repositoryFlows(place).length > 1 || hasFlowFile({ ...place, flow: "default" });
  const shared = repository
    ? readRepositoryFile(
        wanted.filter(
          (k) =>
            repositoryKeys.includes(k) &&
            !aboveShared(k) &&
            !(k === "max_rounds" && flowFiles(repository)),
        ),
        repository,
      )
    : {};
  // Only the roles asked for are read, so a mistake in one role's settings stops only its own
  // agents. `builder` and `reviewer` are the roles the task's flow runs in the build and review
  // stages, which are those two unless the flow names one of the repository's own, such as
  // tester, whose settings are then read.
  const runs = { lead: "lead", builder: "builder", reviewer: "reviewer" };
  if (repository && groups.some((group) => group === "builder" || group === "reviewer")) {
    const stages = flowRoles(repository);
    runs.builder = stages.build;
    // A flow with no review stage runs no reviewer, so the built-in one's settings stand.
    runs.reviewer = stages.review ?? "reviewer";
  }
  const roles: Partial<Record<RoleName, Role>> = {};
  for (const name of ["lead", "builder", "reviewer"] as const)
    if (groups.some((group) => group === name)) roles[name] = roleOf(name, runs[name], repository);
  return mergeSettings([overrides, general, agentsFiles, shared], roles);
}

// One harness or model a file names for a role: its value, or nothing when the file names none,
// or, when it isn't valid, what is wrong with it. A bad one stops the role only where it counts.
type Value<T> = { value: T | undefined } | { bad: Error };

// A layer's say on one role: the harness and model it names. `everyRole` marks a layer's own
// harness and model for every role, rather than for this one.
type Say = { harness: Value<HarnessName>; model: Value<string>; everyRole?: boolean };

// Returns the say on a role at `path` in the YAML data `data`, such as ["roles", "builder"],
// with its harness and model each checked on its own. A bad one is kept, to stop the role only
// where it counts, and so is a step of the path that isn't a mapping, such as builder: bad,
// which leaves both its harness and its model bad. `problem` names the file in what is wrong.
function sayIn(data: unknown, path: string[], problem: string): Say {
  // A path that can't be followed is said as the first step that isn't a mapping.
  const broken = (step: number) => {
    const bad = new Error(
      `${problem}: ${path.slice(0, step).join(".") || "the file"} isn't a mapping`,
    );
    return { harness: { bad }, model: { bad } };
  };
  let at = data;
  for (const [step, key] of path.entries()) {
    if (at === undefined || at === null) break;
    if (!isMapping(at)) return broken(step);
    at = at[key];
  }
  if (at !== undefined && at !== null && !isMapping(at)) return broken(path.length);
  const mapping = isMapping(at) ? at : {};
  // Returns the field `key` checked with `schema`. A bare `model:` is YAML's null, which is a
  // value that isn't valid, not a missing one, so it never quietly gives the default.
  const field = <T>(key: "harness" | "model", schema: z.ZodType<T>): Value<T> => {
    const read = schema.optional().safeParse(mapping[key]);
    if (read.success) return { value: read.data };
    const where = [...path, key].join(".");
    return { bad: new Error(`${problem}: ${where}: ${z.prettifyError(read.error)}`) };
  };
  return { harness: field("harness", HarnessName), model: field("model", Model) };
}

// Returns a role's harness and model, with your repository override first, then your general
// settings, the repository's role file and skelcrew.yaml, and the built-in defaults.
function roleOf(name: RoleName, run: string, repository: Repository | undefined): Role {
  const says: Say[] = [];
  const line = (data: unknown, problem: string): Say[] =>
    run === name ? [sayIn(data, [name], problem)] : [];
  const yourFile = `${join(configDir(), "config.yaml")} isn't valid`;
  const yours = yourConfig();
  if (repository) {
    const entry = overrideEntry(repository);
    const problem = overrideProblem(repository);
    says.push(sayIn(entry, ["roles", run], problem), ...line(entry, problem), {
      ...sayIn(entry, [], problem),
      everyRole: true,
    });
    says.push(sayIn(yours, ["roles", run], yourFile), ...line(yours, yourFile), {
      ...sayIn(yours, [], yourFile),
      everyRole: true,
    });
    const role = `.agents/roles/${run}.md in ${repository.owner}/${repository.repo} isn't valid`;
    says.push(sayIn(repositoryRole(run, repository).frontmatter, [], role));
    const shared = repositoryData(repository);
    says.push(
      sayIn(shared, ["roles", run], "the repository's skelcrew.yaml isn't valid"),
      ...line(shared, "the repository's skelcrew.yaml isn't valid"),
    );
  }
  if (!repository) says.push(sayIn(yours, ["roles", run], yourFile), ...line(yours, yourFile));
  const top = sayIn(yours, [], yourFile);
  const bad = badValues(says, top);
  const all = outcomes(says, top, new Map());
  const [only] = all.values();
  if (all.size === 1 && only) return only;
  for (const v of bad) {
    const pinned = choicesFor(v, says, top, new Map()).map((c) =>
      [...outcomes(says, top, new Map([[v, c]])).keys()].sort().join("|"),
    );
    if (pinned.some((set) => set !== pinned[0]) && "bad" in v) throw v.bad;
  }
  const [first] = bad;
  throw first && "bad" in first ? first.bad : new Error("Skelcrew couldn't read this role");
}

// Returns the harnesses and models of the says and of `top` that aren't valid, from the top.
const badValues = (says: Say[], top: Say): Value<string>[] =>
  [...says.flatMap((say) => [say.harness, say.model]), top.harness, top.model].filter(
    (v) => "bad" in v,
  );

// Returns the values `v` can take: its own when it is valid or `pinned` gives one. A bad
// harness could be any harness or none, and a bad model none or one of its own, as only
// whether it is that model matters.
function choicesFor(
  v: Value<string>,
  says: Say[],
  top: Say,
  pinned: Map<object, string | undefined>,
): (string | undefined)[] {
  if (!("bad" in v)) return [v.value];
  if (pinned.has(v)) return [pinned.get(v)];
  const isHarness = v === top.harness || says.some((say) => say.harness === v);
  return isHarness
    ? [undefined, ...HarnessName.options]
    : [undefined, `\0${badValues(says, top).indexOf(v)}`];
}

// Where a role is as the says are merged from the bottom: its harness, its model should its last
// harness be yours, which lets a layer's model for every role count, its model should it not,
// and that layer's model, which a move back onto your harness brings along.
type Merging = {
  harness: HarnessName;
  mine: string | undefined;
  other: string | undefined;
  forEveryRole: string | undefined;
};

// Returns every role the says can give, by its text, with each bad value free to be any of its
// choices but those `pinned`. With no bad value, there is one. The says are merged from the
// bottom, and where the role can be so far is kept as a set, each say going over it in turn. A
// harness has few values and a model matters only by which one it is, so the set stays small,
// and the work grows with the says, never with every combination of their bad values.
// A model belongs to its harness, so a model goes along only while the role stays on the
// harness it was given with: reviewer: { harness: codex } in skelcrew.yaml must never run Codex
// on your opus. A role moved back onto your harness gets your model again. A layer's model for
// every role, given without a harness, fits only a role whose last harness is yours, and then
// goes along though its own layer moves the role. With no model left, the harness picks its
// default.
function outcomes(
  says: Say[],
  top: Say,
  pinned: Map<object, string | undefined>,
): Map<string, Role> {
  const choices = (v: Value<string>) => choicesFor(v, says, top, pinned);
  const roles = new Map<string, Role>();
  for (const yours of choices(top.harness))
    for (const yourModel of choices(top.model)) {
      const yourHarness = HarnessName.optional().parse(yours) ?? builtInDefaults().harness;
      let states: Merging[] = [
        { harness: yourHarness, mine: yourModel, other: yourModel, forEveryRole: undefined },
      ];
      // From the last say to the first, so each one goes over what is below it.
      for (const say of [...says].reverse()) {
        const next = new Map<string, Merging>();
        for (const state of states)
          for (const named of choices(say.harness))
            for (const model of choices(say.model)) {
              const after = merged(state, say, HarnessName.optional().parse(named), model, {
                harness: yourHarness,
                model: yourModel,
              });
              next.set(JSON.stringify(after), after);
            }
        states = [...next.values()];
      }
      for (const { harness, mine, other } of states) {
        const model = harness === yourHarness ? mine : other;
        const role = model === undefined ? { harness } : { harness, model };
        roles.set(JSON.stringify(role), role);
      }
    }
  return roles;
}

// Returns where a role is once a say naming `harness` and `model` goes over `state`. `yours`
// is your harness and model. A say that moves the role to another harness drops the model below
// it.
function merged(
  state: Merging,
  say: Say,
  harness: HarnessName | undefined,
  model: string | undefined,
  yours: { harness: HarnessName; model: string | undefined },
): Merging {
  let { harness: on, mine, other, forEveryRole } = state;
  if (harness !== undefined && harness !== on) {
    on = harness;
    mine = on === yours.harness ? (forEveryRole ?? yours.model) : undefined;
    other = on === yours.harness ? yours.model : undefined;
  }
  if (model === undefined) return { harness: on, mine, other, forEveryRole };
  // A layer's model for every role, given without a harness, counts only should the last
  // harness be yours.
  if (say.everyRole && harness === undefined)
    return { harness: on, mine: model, other, forEveryRole: model };
  return { harness: on, mine: model, other: model, forEveryRole };
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
  // The fallback and your reviewer's harness are written among the reviewer's lines, and
  // can_merge among the lead's, but each is read on its own. A top-level line of any of these
  // names counts for nothing.
  const nested = ["fallback", "your_reviewer", "can_merge", "may_arm_merges", "threads"];
  const picked = Object.fromEntries(
    Object.entries(data).filter(([key]) => !nested.includes(key) && keys.some((k) => k === key)),
  );
  // The limit on builders is the repository's, so it is read only where `threads` may be set:
  // the repository's skelcrew.yaml and your override for it. Your general limits are about
  // your machine.
  const limits = "limits" in data ? data.limits : undefined;
  if (keys.includes("threads") && isMapping(limits) && "threads" in limits)
    picked.threads = limits.threads;
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
  // rounds replaces the old max_rounds, so where a file names both, the old one isn't read, and
  // a bad one there stops nothing.
  if (picked.rounds !== undefined && picked.rounds !== null) {
    const { max_rounds: _replaced, ...rest } = picked;
    return rest;
  }
  const lead = "lead" in data ? data.lead : undefined;
  if (keys.includes("can_merge") && isMapping(lead)) {
    if ("can_merge" in lead) picked.can_merge = lead.can_merge;
    if ("may_arm_merges" in lead) picked.may_arm_merges = lead.may_arm_merges;
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
    // In each layer, rounds goes over the old max_rounds.
    rounds: first((l) => l.rounds ?? l.max_rounds) ?? defaults.max_rounds,
    reviews: first((l) => l.limits?.reviews) ?? defaults.reviews,
    checks: first((l) => l.limits?.checks) ?? defaults.checks,
    threads: first((l) => l.threads),
    setup: first((l) => l.setup),
    test: first((l) => l.test),
    tracker: first((l) => l.tracker),
    fallback: first((l) => l.fallback),
    reviewMinutes: first((l) => l.review?.timeout_minutes) ?? defaults.reviewMinutes,
    yourHarness: first((l) => l.harness),
    yourReviewer: first((l) => l.your_reviewer),
    declined: first((l) => l.github_declined) ?? [],
    plugins: first((l) => l.plugins) ?? [],
    host: first((l) => l.session) ?? "tmux",
    // In each layer, can_merge goes over its old name, may_arm_merges.
    leadCanMerge: first((l) => l.can_merge ?? l.may_arm_merges) ?? true,
    notify: {
      "needs-you": first((l) => l.notify?.["needs-you"]),
      digest: first((l) => l.notify?.digest),
    },
    digestAt: first((l) => l.notify?.digest_at) ?? "08:00",
  };
}
