// The repositories skel works in: adding one with its setup and test commands, listing them
// and removing one.
import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { openDb, Repository } from "./db.ts";
import { githubRepoAt } from "./github.ts";
import { configDir } from "./paths.ts";

// Kept with your settings, never in the repository, so a clone can't bring its own yes.
const trustFile = () => join(configDir(), "trusted");

function trusted(path: string): boolean {
  if (!existsSync(trustFile())) return false;
  return readFileSync(trustFile(), "utf8").split("\n").includes(path);
}

function trust(path: string): void {
  mkdirSync(configDir(), { recursive: true });
  appendFileSync(trustFile(), `${path}\n`);
}

function excludeSkelFolder(path: string): void {
  const run = Bun.spawnSync(
    ["git", "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    { cwd: path, stdout: "pipe", stderr: "pipe" },
  );
  if (!run.success) throw new Error(`git couldn't find ${path}'s exclude file`);
  const exclude = run.stdout.toString().trim();
  const lines = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (lines.split("\n").includes(".skel/")) return;
  mkdirSync(dirname(exclude), { recursive: true });
  const gap = lines === "" || lines.endsWith("\n") ? "" : "\n";
  appendFileSync(exclude, `${gap}.skel/\n`);
}

function repositories(db: Database): Repository[] {
  return db
    .query("SELECT name, path, owner, repo FROM repositories ORDER BY name")
    .all()
    .map((row) => Repository.parse(row));
}

const SkelYaml = z.looseObject({
  setup: z.array(z.string()).optional(),
  test: z.array(z.string()).optional(),
});

const PackageJson = z.looseObject({ scripts: z.record(z.string(), z.string()).optional() });

function readSkelYaml(path: string) {
  const file = join(path, "skel.yaml");
  const yaml = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  const [broken] = yaml.errors;
  if (broken) throw new Error(`${file} isn't valid YAML: ${broken.message}`);
  const read = SkelYaml.safeParse(yaml.toJS() ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return { file, yaml, setup: read.data.setup, test: read.data.test };
}

function guessCommands(path: string): { setup: string[]; test: string[] } {
  if (existsSync(join(path, "bun.lock")) || existsSync(join(path, "bun.lockb")))
    return { setup: ["bun install"], test: ["bun test"] };
  if (!existsSync(join(path, "package-lock.json"))) return { setup: [], test: [] };
  const packageFile = join(path, "package.json");
  const found = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, "utf8")) : {};
  const scripts = PackageJson.parse(found).scripts ?? {};
  return { setup: ["npm ci"], test: scripts.test ? ["npm test"] : [] };
}

// Bun's prompt answers null both for Ctrl-D and for a bare Enter, unless it has a default:
// then Enter gives the default and only Ctrl-D gives null.
function askCommands(question: string, given: string[], short: string): string[] {
  const shown = given.join(" && ");
  const answer = prompt(question, shown);
  if (answer === null) throw new Error(`${short} wasn't added`);
  const typed = answer.trim();
  if (typed === "" || typed === shown) return given;
  return typed === "-" ? [] : [typed];
}

export function initRepo(given: string, name?: string): void {
  const full = resolve(given);
  if (!existsSync(full) && /^[\w.-]+\/[\w.-]+$/.test(given))
    throw new Error(
      `cloning ${given} comes later. Clone it yourself, then run skel init in its folder`,
    );
  if (!existsSync(full)) throw new Error(`there is no folder at ${full}`);
  const path = realpathSync(full);
  if (!existsSync(join(path, ".git"))) throw new Error(`${path} isn't the top of a git repository`);
  const { owner, repo, canPush } = githubRepoAt(path);
  const short = name ?? basename(path);
  // Threads are named like app#12, so a name must survive being typed in that form.
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(short))
    throw new Error(
      `"${short}" can't be a short name: start with a letter or digit, then use letters, digits, ".", "_" or "-"`,
    );
  const db = openDb();
  for (const known of repositories(db)) {
    if (known.name === short)
      throw new Error(`${short} is already ${known.path}. Choose another with --name`);
    if (known.path === path) throw new Error(`${path} is already added, as ${known.name}`);
  }
  // You vouch for what is in a repository you can push to, so asking would only add a step.
  if (canPush) console.log(`Trusting ${short}, since you can push to ${owner}/${repo}.`);
  else if (!trusted(path)) {
    console.log(`Agents will run ${short}'s setup and test commands, and follow its AGENTS.md`);
    console.log("and settings as instructions.");
    const answer = prompt(`Do you trust ${path}? [y/N]`);
    if (answer?.trim().toLowerCase() !== "y")
      throw new Error(`${short} wasn't added, since you don't trust it`);
    trust(path);
  }
  const saved = readSkelYaml(path);
  const guess = guessCommands(path);
  const setup = askCommands("Setup command", saved.setup ?? guess.setup, short);
  const test = askCommands("Test command", saved.test ?? guess.test, short);
  if (setup.length > 0 || test.length > 0) {
    for (const [key, commands] of Object.entries({ setup, test })) {
      if (commands.length > 0) saved.yaml.set(key, saved.yaml.createNode(commands, { flow: true }));
      else saved.yaml.delete(key);
    }
    writeFileSync(saved.file, saved.yaml.toString());
    console.log(`Wrote the commands to ${saved.file}. Commit it, so every clone has them.`);
  }
  excludeSkelFolder(path);
  db.query("INSERT INTO repositories (name, path, owner, repo) VALUES (?, ?, ?, ?)").run(
    short,
    path,
    owner,
    repo,
  );
  console.log(`Added ${short}: ${owner}/${repo} at ${path}`);
}

export function listRepos(): void {
  const all = repositories(openDb());
  if (all.length === 0) {
    console.log("No repositories yet. Add one by running skel init in its folder.");
    return;
  }
  const width = Math.max(...all.map((r) => r.name.length));
  for (const r of all) console.log(`${r.name.padEnd(width)}  ${r.owner}/${r.repo}  ${r.path}`);
}

export function removeRepo(name: string): void {
  const removed = openDb().query("DELETE FROM repositories WHERE name = ?").run(name);
  if (removed.changes === 0) throw new Error(`there is no repository named ${name}`);
  console.log(`Removed ${name}`);
}
