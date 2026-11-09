// Your settings in config.yaml: what the first run saves and reads, and what your config sets
// for threads.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import { z } from "zod";
import { HarnessName, harnessNamed } from "./agents/harness.ts";
import { configDir } from "./paths.ts";

// Unknown keys pass through, so settings this version doesn't know survive a save.
const SetupConfig = z.looseObject({ harness: z.enum(["claude"]).optional() });

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
function readAgainst<T extends z.ZodType>(schema: T): z.infer<T> {
  const file = configFile();
  const read = schema.safeParse(existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return read.data;
}

// Returns the harness and model of the lead, builders and reviews, each by roleOn's rule. A
// second view on another model is yours to choose, such as with reviewer: { harness: codex }.
export function agentRoles(): { lead: Role; builder: Role; reviewer: Role } {
  const { model, lead, builder, reviewer } = readAgainst(Roles);
  const yours = { harness: agentHarness().name, model };
  return {
    lead: roleOn(lead, yours),
    builder: roleOn(builder, yours),
    reviewer: roleOn(reviewer, yours),
  };
}

// Returns what your config sets for threads: each agent's harness and model, as agentRoles
// gives them, and the round limit (3 when it names none).
export function threadConfig(): ReturnType<typeof agentRoles> & { maxRounds: number } {
  return { ...agentRoles(), maxRounds: readAgainst(Rounds).max_rounds ?? 3 };
}
