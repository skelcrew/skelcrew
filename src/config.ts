// Your config.yaml as the first run edits it, and the settings the rest of Skelcrew asks for,
// each read through the one loader in settings.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { HarnessName } from "./agents/harness.ts";
import { configDir } from "./paths.ts";
import { type Repository, readSettings, type Settings } from "./settings.ts";

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

// Returns the harness and model of the lead, builders and reviewers. For a repository, its
// skelcrew.yaml goes over your config. Without one, only your config counts.
export const agentRoles = (repository?: Repository): Settings["roles"] =>
  readSettings(["roles"], repository).roles;

// Returns what a repository's threads run with: each agent's harness and model, as agentRoles
// gives them, and the round limit.
export function threadConfig(repository: Repository): Settings["roles"] & { maxRounds: number } {
  const { rounds, roles } = readSettings(["rounds", "roles"], repository);
  return { ...roles, maxRounds: rounds };
}

// Returns the setup commands in the repository's skelcrew.yaml, or none when it has none.
export const repositorySetup = (repository: Repository): string[] =>
  readSettings(["setup"], repository).setup;

// Returns the plugin the repository's skelcrew.yaml names as its tracker, or nothing when it
// names none.
export const repositoryTracker = (repository: Repository): string | undefined =>
  readSettings(["tracker"], repository).tracker;

// Returns how many reviews may run at once on this machine. Throws when your config isn't valid.
export const reviewLimit = (): number => readSettings(["reviews"]).reviews;
