// Settings, in two layers: your own in config.yaml, which the first run saves, and what a
// repository's committed skelcrew.yaml shares with everyone who works on it, which comes first.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import { z } from "zod";
import { HarnessName, harnessNamed } from "./agents/harness.ts";
import { cloneDir, configDir } from "./paths.ts";

// Unknown keys pass through, so settings this version doesn't know survive a save.
// github_declined lists the repositories, by full name, never offered the GitHub plugin again
// because you said no in one of their checkouts.
const SetupConfig = z.looseObject({
  harness: HarnessName.optional(),
  github_declined: z.array(z.string()).optional(),
});

// Returns the path of your settings file.
export const configFile = () => join(configDir(), "config.yaml");

// Reads and validates settings, returning the YAML document, the harness choice and the
// repositories you declined the GitHub plugin for, while preserving unknown settings.
export function readConfig() {
  const file = configFile();
  // Read as a document, not plain data, so a save keeps your comments and layout.
  const config = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  const [broken] = config.errors;
  if (broken) throw new Error(`${file} isn't valid YAML: ${broken.message}`);
  const read = SetupConfig.safeParse(config.toJS() ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return { config, harness: read.data.harness, declined: read.data.github_declined ?? [] };
}

// Returns the harness the lead and builders run on: the one the first run saved, or Claude
// Code when your config names none.
export const agentHarness = () => harnessNamed(readConfig().harness ?? "claude");

// A model is plain text, passed to the harness as written: Skelcrew keeps no list of names, and a
// harness that names models as provider/model knows its own providers.
const Model = z.string().min(1);
// A role's own harness and model, either of them optional.
const RoleSettings = z.looseObject({ harness: HarnessName.optional(), model: Model.optional() });

// What your config sets for the agents. Kept apart from SetupConfig on purpose: setupDone
// reads that one on every plain sc, and a bad setting here must stop an agent, not make
// setupDone throw.
const Roles = z.looseObject({
  model: Model.optional(),
  lead: RoleSettings.optional(),
  builder: RoleSettings.optional(),
  reviewer: RoleSettings.optional(),
});
// Apart from Roles, so a bad max_rounds stops a thread, not the lead.
const Rounds = z.looseObject({ max_rounds: z.number().int().positive().optional() });
// The commands that set up a thread's clone, run once in it. The reviewer reads the test
// commands from the file itself.
const Setup = z.looseObject({ setup: z.array(z.string()).optional() });

// The plugin that holds the repository's tasks. Only the name: settings for it stay yours. A bare
// `tracker:` is YAML's null, which counts as no line at all, so the forge stays the tracker.
const Tracker = z.looseObject({ tracker: z.string().nullish() });

// A repository Skelcrew works on, by its owner and name.
type Repository = { owner: string; repo: string };

// The harness a role runs on, and its model, or none for the harness's default.
type Role = { harness: HarnessName; model?: string };

// Returns the harness and model a role runs on. The harness is the role's own, else your
// top-level one. The model is the role's own, else yours if the role runs on your harness,
// else none, so the harness picks its default. A model name belongs to its harness, so
// reviewer: { harness: codex } must never run Codex on opus.
function resolveRole(
  role: { harness?: HarnessName | undefined; model?: string | undefined } | undefined,
  yours: { harness: HarnessName; model: string | undefined },
): Role {
  const harness = role?.harness ?? yours.harness;
  const model = role?.model ?? (harness === yours.harness ? yours.model : undefined);
  return model === undefined ? { harness } : { harness, model };
}

// Returns your config.yaml checked against `schema`. Throws when it isn't valid, rather than
// run an agent on settings you didn't pick.
function readYourConfig<T extends z.ZodType>(schema: T): z.infer<T> {
  const file = configFile();
  // An empty file, or none, sets nothing.
  const read = schema.safeParse(existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return read.data;
}

// Returns the repository's skelcrew.yaml checked against `schema`, or nothing when it has
// none. Throws when it isn't valid. It is read from Skelcrew's clone, which is at the default
// branch, so a change counts once it is pushed there. A link is refused, since it could point
// at any file of yours.
function readRepositoryConfig<T extends z.ZodType>(schema: T, repository: Repository): z.infer<T> {
  const file = join(cloneDir(repository.owner, repository.repo), "skelcrew.yaml");
  // lstat, so a link is seen as one and refused, not followed.
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile())
    throw new Error("the repository's skelcrew.yaml isn't a plain file, so Skelcrew won't read it");
  const read = schema.safeParse(stat ? (parse(readFileSync(file, "utf8")) ?? {}) : {});
  if (!read.success)
    throw new Error(`the repository's skelcrew.yaml isn't valid: ${z.prettifyError(read.error)}`);
  return read.data;
}

// Returns a role's harness and model, with the repository's skelcrew.yaml over your config.
// `top` is your top-level harness. Your model goes along only while the role stays on the
// harness your config gives it, as a model name belongs to its harness.
function layerRole(
  shared: z.infer<typeof Roles>["reviewer"],
  yours: z.infer<typeof Roles>["reviewer"],
  top: HarnessName,
): z.infer<typeof Roles>["reviewer"] {
  const harness = shared?.harness ?? yours?.harness;
  // A role with no harness of its own runs on `top`, on either side.
  const stays = (harness ?? top) === (yours?.harness ?? top);
  const model = shared?.model ?? (stays ? yours?.model : undefined);
  return { ...(harness ? { harness } : {}), ...(model ? { model } : {}) };
}

// Returns the harness and model of the lead, builders and reviewers. For a repository, its
// skelcrew.yaml goes over your config. Without one, only your config counts.
export function agentRoles(repository?: Repository): { lead: Role; builder: Role; reviewer: Role } {
  const yours = readYourConfig(Roles);
  // sc init asks without a repository, for the starter skelcrew.yaml it writes.
  const shared = repository ? readRepositoryConfig(Roles, repository) : {};
  const top = { harness: agentHarness().name, model: yours.model };
  return {
    lead: resolveRole(layerRole(shared.lead, yours.lead, top.harness), top),
    builder: resolveRole(layerRole(shared.builder, yours.builder, top.harness), top),
    reviewer: resolveRole(layerRole(shared.reviewer, yours.reviewer, top.harness), top),
  };
}

// Returns what a repository's threads run with: each agent's harness and model, as agentRoles
// gives them, and the round limit, from its skelcrew.yaml, else your config, else 3.
export function threadConfig(
  repository: Repository,
): ReturnType<typeof agentRoles> & { maxRounds: number } {
  const maxRounds =
    readRepositoryConfig(Rounds, repository).max_rounds ?? readYourConfig(Rounds).max_rounds ?? 3;
  return { ...agentRoles(repository), maxRounds };
}

// Returns the setup commands in the repository's skelcrew.yaml, or none when it has none.
export const repositorySetup = (repository: Repository): string[] =>
  readRepositoryConfig(Setup, repository).setup ?? [];

// Returns the plugin the repository's skelcrew.yaml names as its tracker, or nothing when it
// names none.
export const repositoryTracker = (repository: Repository): string | undefined =>
  readRepositoryConfig(Tracker, repository).tracker ?? undefined;
