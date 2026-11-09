// Settings, in two layers: your own in config.yaml, which the first run saves, and what a
// repository's committed skel.yaml shares with everyone who works on it, which comes first.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import { z } from "zod";
import { HarnessName, harnessNamed } from "./agents/harness.ts";
import { cloneDir, configDir } from "./paths.ts";

// Unknown keys pass through, so settings this version doesn't know survive a save.
const SetupConfig = z.looseObject({ harness: HarnessName.optional() });

// Returns the settings file path used to remember your harness choice between runs.
export const configFile = () => join(configDir(), "config.yaml");

// Reads and validates settings, returning the YAML document and harness choice while
// preserving unknown settings.
export function readConfig() {
  const file = configFile();
  const config = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  const [broken] = config.errors;
  if (broken) throw new Error(`${file} isn't valid YAML: ${broken.message}`);
  const read = SetupConfig.safeParse(config.toJS() ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return { config, harness: read.data.harness };
}

// Returns the harness the lead and builders run on: the one the first run saved, or Claude
// Code when your config names none.
export const agentHarness = () => harnessNamed(readConfig().harness ?? "claude");

// A model is plain text, passed to the harness as written: skel keeps no list of names, and a
// harness that names models as provider/model knows its own providers.
const Model = z.string().min(1);
// A role's own harness and model, either of them optional.
const RoleSettings = z.looseObject({ harness: HarnessName.optional(), model: Model.optional() });

// What your config sets for the agents. Kept apart from SetupConfig on purpose: setupDone
// reads that one on every plain skel, and a bad setting here must stop an agent, not make
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

// A repository skel works on, by its GitHub owner and name.
type Repository = { owner: string; repo: string };

type Role = { harness: HarnessName; model?: string };

// Returns the harness and model a role runs on, given what your config sets for it and your
// top-level harness and model. The role's own harness, else yours. Its own model, else yours
// only when it runs on your harness, else none, so the harness picks its default: a model name
// belongs to its harness, and reviewer: { harness: codex } must never run Codex on opus.
function roleOn(
  role: { harness?: HarnessName | undefined; model?: string | undefined } | undefined,
  yours: { harness: HarnessName; model: string | undefined },
): Role {
  const harness = role?.harness ?? yours.harness;
  const model = role?.model ?? (harness === yours.harness ? yours.model : undefined);
  return model === undefined ? { harness } : { harness, model };
}

// Returns your config read against `schema`, or throws when it isn't valid, rather than run an
// agent on settings you didn't pick.
function yoursAgainst<T extends z.ZodType>(schema: T): z.infer<T> {
  const file = configFile();
  const read = schema.safeParse(existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return read.data;
}

// Returns the repository's skel.yaml, read from skel's own clone against `schema`, as nothing
// when it has none, or throws when it isn't valid. skel's clone is at the default branch, so a
// change counts once it is pushed there. The file comes from the repository and skel reads it
// with your rights, so a link, which could show it any file of yours, is refused.
function sharedAgainst<T extends z.ZodType>(schema: T, repository: Repository): z.infer<T> {
  const file = join(cloneDir(repository.owner, repository.repo), "skel.yaml");
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile())
    throw new Error("the repository's skel.yaml isn't a plain file, so skel won't read it");
  const read = schema.safeParse(stat ? (parse(readFileSync(file, "utf8")) ?? {}) : {});
  if (!read.success)
    throw new Error(`the repository's skel.yaml isn't valid: ${z.prettifyError(read.error)}`);
  return read.data;
}

// Returns a role's harness and model, as the repository's skel.yaml sets them over yours, with
// `top` your top-level harness. Your model goes along only while the role stays on the harness
// your config gives it, as a model name belongs to its harness.
function layered(
  shared: z.infer<typeof Roles>["reviewer"],
  yours: z.infer<typeof Roles>["reviewer"],
  top: HarnessName,
): z.infer<typeof Roles>["reviewer"] {
  const harness = shared?.harness ?? yours?.harness;
  const stays = (harness ?? top) === (yours?.harness ?? top);
  const model = shared?.model ?? (stays ? yours?.model : undefined);
  return { ...(harness ? { harness } : {}), ...(model ? { model } : {}) };
}

// Returns the harness and model of the lead, builders and reviews, each by roleOn's rule: for a
// repository, with its skel.yaml over your config, and with none, from your config alone. A
// second view on another model is yours to choose, such as with reviewer: { harness: codex }.
export function agentRoles(repository?: Repository): { lead: Role; builder: Role; reviewer: Role } {
  const yours = yoursAgainst(Roles);
  const shared = repository ? sharedAgainst(Roles, repository) : {};
  const top = { harness: agentHarness().name, model: yours.model };
  return {
    lead: roleOn(layered(shared.lead, yours.lead, top.harness), top),
    builder: roleOn(layered(shared.builder, yours.builder, top.harness), top),
    reviewer: roleOn(layered(shared.reviewer, yours.reviewer, top.harness), top),
  };
}

// Returns what a repository's threads run with: each agent's harness and model, as agentRoles
// gives them, and the round limit, from its skel.yaml, else your config, else 3.
export function threadConfig(
  repository: Repository,
): ReturnType<typeof agentRoles> & { maxRounds: number } {
  const maxRounds =
    sharedAgainst(Rounds, repository).max_rounds ?? yoursAgainst(Rounds).max_rounds ?? 3;
  return { ...agentRoles(repository), maxRounds };
}

// Returns the setup commands in the repository's skel.yaml, or none when it has none.
export const repositorySetup = (repository: Repository): string[] =>
  sharedAgainst(Setup, repository).setup ?? [];
