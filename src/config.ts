// Your config.yaml as the first run edits it, and the settings the rest of Skelcrew asks for,
// each read through the one loader in settings.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { HarnessName } from "./agents/harness.ts";
import { detectCommands } from "./detect.ts";
import { cloneDir, configDir } from "./paths.ts";
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

// A repository's setup or test commands, and whether Skelcrew detected them from its files
// rather than read them in its skelcrew.yaml, so wherever they are shown can say so.
export type Commands = { commands: string[]; detected: boolean };

// Returns the repository's setup and test commands. Each comes from its skelcrew.yaml when it
// names it, even as an empty list, and is otherwise detected from the files in Skelcrew's clone.
// That clone is at the latest default branch, so detection follows it as it changes.
export function repositoryCommands(repository: Repository): { setup: Commands; test: Commands } {
  const named = readSettings(["setup", "test"], repository);
  const found = detectCommands(cloneDir(repository.owner, repository.repo));
  const pick = (given: string[] | undefined, detected: string[]): Commands =>
    given ? { commands: given, detected: false } : { commands: detected, detected: true };
  return { setup: pick(named.setup, found.setup), test: pick(named.test, found.test) };
}

// Returns the plugin the repository's skelcrew.yaml names as its tracker, or nothing when it
// names none.
export const repositoryTracker = (repository: Repository): string | undefined =>
  readSettings(["tracker"], repository).tracker;

// Returns how many reviews may run at once on this machine. Throws when your config isn't valid.
export const reviewLimit = (): number => readSettings(["reviews"]).reviews;
