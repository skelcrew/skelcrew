// Your config.yaml as the first run edits it, and the settings the rest of Skelcrew asks for,
// each read through the one loader in settings.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { HarnessName } from "./agents/harness.ts";
import { configDir } from "./paths.ts";
import { type Repository, readSettings, type Settings } from "./settings.ts";

// Returns the path of your settings file.
export const configFile = () => join(configDir(), "config.yaml");

// Returns your config.yaml as a YAML document, for the first run to change and save. Read as a
// document, not plain data, so a save keeps your comments, your layout and settings this version
// doesn't know. What it says is read through the loader, never from here.
export function yourConfigDocument() {
  const file = configFile();
  const config = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  const [broken] = config.errors;
  if (broken) throw new Error(`${file} isn't valid YAML: ${broken.message}`);
  return config;
}

// Returns the harness and model of the lead, builders and reviewers. For a repository, its
// skelcrew.yaml goes over your config. Without one, only your config counts.
export const agentRoles = (repository?: Repository): Settings["roles"] =>
  readSettings(["roles"], repository).roles;

// Returns what a repository's threads run with: each agent's harness and model, as agentRoles
// gives them, the round limit, the harness reviews fall back to during a usage limit, or null
// with none, and how many minutes a review may run. A fallback that is the reviewer's own harness
// is none.
export function threadConfig(repository: Repository): Settings["roles"] & {
  maxRounds: number;
  fallback: HarnessName | null;
  reviewMinutes: number;
} {
  const { rounds, roles, fallback, reviewMinutes } = readSettings(
    ["rounds", "roles", "fallback", "reviewMinutes"],
    repository,
  );
  return {
    ...roles,
    maxRounds: rounds,
    fallback: fallback === undefined || fallback === roles.reviewer.harness ? null : fallback,
    reviewMinutes,
  };
}

// Returns the repository's setup and test commands: each from its skelcrew.yaml, else your
// config, or none. Skelcrew never guesses them: the lead settles them with you once, and every
// builder and reviewer then uses the same ones.
export function repositoryCommands(repository: Repository): Pick<Settings, "setup" | "test"> {
  const { setup, test } = readSettings(["setup", "test"], repository);
  return { setup, test };
}

// Returns the plugin the repository's skelcrew.yaml names as its tracker, or nothing when it
// names none.
export const repositoryTracker = (repository: Repository): string | undefined =>
  readSettings(["tracker"], repository).tracker;

// Returns how many reviews may run at once on this machine. Throws when your config isn't valid.
export const reviewLimit = (): number => readSettings(["reviews"]).reviews;
