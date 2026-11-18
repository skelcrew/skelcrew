// Your config.yaml as the first run edits it, and the settings the rest of Skelcrew asks for,
// each read through the one loader in settings.ts.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import type { HarnessName } from "./agents/harness.ts";
import { flowRoles, repositoryFlows } from "./flows.ts";
import { cloneDir, configDir, dataDir } from "./paths.ts";
import type { RoleName } from "./roles.ts";
import { type Repository, type Role, readSettings, type Settings } from "./settings.ts";

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

// Returns the harness and model of one role: the lead, builders or reviewers. For a repository,
// its files go over your config. Without one, only your config counts. Only that role is read, so
// a mistake in another role's settings or file stops only that role's agents.
export const agentRole = (name: RoleName, repository?: Repository): Role =>
  readSettings([name], repository)[name];

// Returns how many rounds of changes a repository's thread gets before it needs you.
export const roundLimit = (repository: Repository): number =>
  readSettings(["rounds"], repository).rounds;

// Throws unless the repository's tasks can run `flow`, for every start of a task and a switch of
// its flow, so a task never starts on a flow that would fail it once work began. It refuses a
// flow the repository doesn't have, saying which it has, one naming a role with no file, and one
// whose round limit, wherever it comes from, isn't valid. `name` is the repository's name in
// Skelcrew, and the .agents/ tree counts as for repositoryFlows.
export function checkFlow(
  place: { owner: string; repo: string; agents?: string | null },
  name: string,
  flow: string,
): void {
  const flows = repositoryFlows(place);
  if (!flows.includes(flow))
    throw new Error(`${name} has no flow ${flow}. Its flows are ${flows.join(", ")}.`);
  flowRoles({ ...place, flow });
  roundLimit({ ...place, flow });
}

// Returns what a repository's reviews run with: the reviewer's harness and model, as agentRole
// gives them, the harness reviews fall back to during a usage limit, or null with none, how many
// minutes a review may run, and the round limit. A fallback that is the reviewer's own harness
// is none.
export function reviewConfig(repository: Repository): {
  reviewer: Role;
  fallback: HarnessName | null;
  reviewMinutes: number;
  maxRounds: number;
} {
  const { rounds, reviewer, fallback, reviewMinutes } = readSettings(
    ["rounds", "reviewer", "fallback", "reviewMinutes"],
    repository,
  );
  return {
    reviewer,
    fallback: fallback === undefined || fallback === reviewer.harness ? null : fallback,
    reviewMinutes,
    maxRounds: rounds,
  };
}

// Returns the repository's setup and test commands: each from its skelcrew.yaml, else your
// config, or missing when neither names it. An empty list named on purpose stays empty. Skelcrew never guesses them: the lead settles them with you once, and every
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
// Returns how many test suites may run at once through sc check on this machine. Throws when
// your config isn't valid.
export const checkLimit = (): number => readSettings(["checks"]).checks;

// Says once, for each old key still in use, which new one replaces it: lead:, builder: and
// reviewer: in your config.yaml, replaced by roles:, its max_rounds, now your default for the
// flow's rounds, and, for the repository named by its
// owner/repo, lead:, builder:, reviewer: and max_rounds in its skelcrew.yaml, replaced by its
// .agents/. The old keys still work, so nothing breaks, but you should know of the new shape.
// Skelcrew changes no file itself. What was said is kept in Skelcrew's data folder, so it is
// said once per key. A file that can't be read says nothing here, as reading the settings says
// what is wrong with it.
export function tellOldKeys(repository: string | undefined): void {
  const told = join(dataDir(), "told-old-keys");
  const before = existsSync(told) ? readFileSync(told, "utf8").split("\n") : [];
  // Says `text` unless the key was said before, and remembers it.
  const tell = (key: string, text: string) => {
    if (before.includes(key)) return;
    console.log(`${text} It keeps working, and Skelcrew changes no file itself.`);
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(told, `${key}\n`);
  };
  const roles = ["lead", "builder", "reviewer"];
  const yours = readYaml(configFile());
  for (const name of roles.filter((name) => name in yours))
    tell(
      `config.yaml ${name}`,
      `Your config.yaml's ${name}: is read as roles: { ${name}: … }, which replaces it.`,
    );
  if ("max_rounds" in yours)
    tell(
      "config.yaml max_rounds",
      "Your config.yaml's max_rounds: is read as your default for rounds:, which a repository now sets in .agents/flows/default.yaml.",
    );
  if (repository === undefined) return;
  // Read from Skelcrew's clone, as the settings are, and never through a link.
  const [owner = "", repo = ""] = repository.split("/");
  const file = join(cloneDir(owner, repo), "skelcrew.yaml");
  const shared = lstatSync(file, { throwIfNoEntry: false })?.isFile() ? readYaml(file) : {};
  const named = `${repository}'s skelcrew.yaml has`;
  for (const name of roles.filter((name) => name in shared))
    tell(
      `${repository} skelcrew.yaml ${name}`,
      `${named} ${name}:, read as the harness and model in .agents/roles/${name}.md, which replaces it.`,
    );
  if ("max_rounds" in shared)
    tell(
      `${repository} skelcrew.yaml max_rounds`,
      `${named} max_rounds:, read as rounds: in .agents/flows/default.yaml, which replaces it.`,
    );
}

// Returns the mapping a YAML file holds, or an empty one when it can't be read or isn't one.
function readYaml(file: string): object {
  try {
    const data: unknown = parse(readFileSync(file, "utf8"));
    return typeof data === "object" && data !== null ? data : {};
  } catch {
    return {};
  }
}
