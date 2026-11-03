// The repositories skel works in: adding one you trust, listing them and removing one.
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

export function addRepo(given: string, name?: string): void {
  const full = resolve(given);
  if (!existsSync(full)) throw new Error(`there is no folder at ${full}`);
  const path = realpathSync(full);
  if (!existsSync(join(path, ".git"))) throw new Error(`${path} isn't the top of a git repository`);
  const short = name ?? basename(path);
  // Threads are named like app#12, so a name must survive being typed in that form.
  if (!/^[\w.-]+$/.test(short))
    throw new Error(`"${short}" can't be a short name: use letters, digits, ".", "_" or "-"`);
  const db = openDb();
  for (const known of repositories(db)) {
    if (known.name === short)
      throw new Error(`${short} is already ${known.path}. Choose another with --name`);
    if (known.path === path) throw new Error(`${path} is already added, as ${known.name}`);
  }
  const { owner, repo } = githubRepoAt(path);
  if (!trusted(path)) {
    console.log(`Agents will run ${short}'s setup and test commands, and follow its AGENTS.md`);
    console.log("and settings as instructions.");
    const answer = prompt(`Do you trust ${path}? [y/N]`);
    if (answer?.trim().toLowerCase() !== "y")
      throw new Error(`${short} wasn't added, since you don't trust it`);
    trust(path);
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
    console.log("No repositories yet. Add one with skel repo add <path>.");
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
