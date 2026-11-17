// Reads every setting, from the repository's skelcrew.yaml in Skelcrew's clone, your
// config.yaml and the built-in defaults. Each setting comes from the first of them that sets it.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HarnessName } from "./agents/harness.ts";
import { cloneDir, configDir } from "./paths.ts";

// A repository Skelcrew works on, by its owner and name.
export type Repository = { owner: string; repo: string };

// A model is plain text, passed to the harness as written: Skelcrew keeps no list of names, and a
// harness that names models as provider/model knows its own providers.
const Model = z.string().min(1);
// A role's own harness and model, either of them optional.
const RoleSettings = z.looseObject({ harness: HarnessName.optional(), model: Model.optional() });

// What the files may hold. Unknown keys pass, so settings this version doesn't know do no harm.
// A bare `tracker:` is YAML's null, which counts as no line at all, so the forge stays the
// tracker.
const File = z.looseObject({
  harness: HarnessName.optional(),
  model: Model.optional(),
  lead: RoleSettings.optional(),
  builder: RoleSettings.optional(),
  reviewer: RoleSettings.optional(),
  max_rounds: z.number().int().positive().optional(),
  limits: z.looseObject({ reviews: z.number().int().positive().optional() }).optional(),
  setup: z.array(z.string()).optional(),
  tracker: z.string().nullish(),
});
type File = z.infer<typeof File>;
type Key = keyof typeof File.shape;

// The harness a role runs on, and its model, or none for the harness's default.
export type Role = { harness: HarnessName; model?: string };

// Every setting, once the files and the defaults are merged. `rounds` is how many rounds of
// changes a thread gets before it needs you, `reviews` how many reviews run at once on this
// machine, and `setup` the commands that set up a thread's clone.
export type Settings = {
  roles: { lead: Role; builder: Role; reviewer: Role };
  rounds: number;
  reviews: number;
  setup: string[];
  tracker: string | undefined;
};
type Group = keyof Settings;

// The keys of the files behind each setting. A role's model belongs to its harness, so the
// roles are read together with your harness and model.
const keysOf: Record<Group, Key[]> = {
  roles: ["harness", "model", "lead", "builder", "reviewer"],
  rounds: ["max_rounds"],
  reviews: ["limits"],
  setup: ["setup"],
  tracker: ["tracker"],
};

// What each file may set. Your harness, model and limits fit you and your machine, so a
// repository can't set them. Setup and the tracker belong to the repository, so your config
// doesn't.
const yourKeys: Key[] = ["harness", "model", "lead", "builder", "reviewer", "max_rounds", "limits"];
const repositoryKeys: Key[] = ["lead", "builder", "reviewer", "max_rounds", "setup", "tracker"];

// Returns the built-in defaults: Claude Code for every role, three rounds, no setup and no
// tracker of the repository's own. Reviews default to a quarter of this machine's cores, at least
// one, as each runs the repository's whole test suite and many at once fight over the CPU.
function builtInDefaults(): {
  harness: HarnessName;
  max_rounds: number;
  reviews: number;
  setup: string[];
} {
  return {
    harness: "claude",
    max_rounds: 3,
    reviews: Math.max(1, Math.floor(availableParallelism() / 4)),
    setup: [],
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
  // sc init asks without a repository, for the starter skelcrew.yaml it writes.
  const shared = repository
    ? readRepositoryFile(
        wanted.filter((k) => repositoryKeys.includes(k)),
        repository,
      )
    : {};
  return mergeSettings([shared, readYourFile(wanted.filter((k) => yourKeys.includes(k)))]);
}

// Returns your config.yaml, holding only `keys`, checked. A file with none of them isn't read,
// so a broken one stops only what it could change.
function readYourFile(keys: Key[]): File {
  const file = join(configDir(), "config.yaml");
  if (keys.length === 0 || !existsSync(file)) return {};
  return check(pick(parse(readFileSync(file, "utf8")), keys), `${file} isn't valid`);
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
  const read = pick(parse(readFileSync(file, "utf8")), keys);
  return check(read, "the repository's skelcrew.yaml isn't valid");
}

// Returns the `keys` of what a file held. An empty file, or one that isn't a mapping, gives
// nothing to keep, and File's check says so for the second.
function pick(data: unknown, keys: Key[]): unknown {
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) return data;
  return Object.fromEntries(Object.entries(data).filter(([key]) => keys.some((k) => k === key)));
}

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
      layers.map((l) => l[name]),
      top,
    );
  return {
    roles: { lead: role("lead"), builder: role("builder"), reviewer: role("reviewer") },
    rounds: first((l) => l.max_rounds) ?? defaults.max_rounds,
    reviews: first((l) => l.limits?.reviews) ?? defaults.reviews,
    setup: first((l) => l.setup) ?? defaults.setup,
    tracker: first((l) => l.tracker),
  };
}

// Returns a role's harness and model from what each layer says of it, the one that wins first, and `top`,
// the harness and model every role gets unless it names its own. A model name belongs to its
// harness, so a model goes along only while the role stays on the harness it was given with:
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
