// Your settings in config.yaml: what the first run saves and reads, and what your config sets
// for threads.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import { z } from "zod";
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

// Kept apart from SetupConfig on purpose: setupDone reads that one on every plain skel, and a
// bad max_rounds must stop a thread, not make setupDone throw.
const ThreadConfig = z.looseObject({
  builder: z.looseObject({ model: z.string().min(1).optional() }).optional(),
  reviewer: z.looseObject({ harness: z.enum(["codex", "claude"]).optional() }).optional(),
  max_rounds: z.number().int().positive().optional(),
});

// Returns what your config sets for threads: the builder's model (opus when it names none),
// the reviewer's harness (none when it names none, so the reviewer picks), and the round
// limit (3 when it names none). Throws when the config isn't valid, rather than run a thread
// on settings you didn't pick.
export function threadConfig(): {
  model: string;
  reviewer: "codex" | "claude" | undefined;
  maxRounds: number;
} {
  const file = join(configDir(), "config.yaml");
  const read = ThreadConfig.safeParse(
    existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {},
  );
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  const { builder, reviewer, max_rounds } = read.data;
  return {
    model: builder?.model ?? "opus",
    reviewer: reviewer?.harness,
    maxRounds: max_rounds ?? 3,
  };
}
