// The repositories skel works on, each from a clone of its own: keeping the clones current,
// listing the repositories and removing one.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { nameRepositories, openDb, Repository } from "./db.ts";
import { cloneRepo, updateClone } from "./github.ts";
import { cloneDir, dataDir } from "./paths.ts";

export function repositories(db: Database): Repository[] {
  return db
    .query("SELECT name, owner, repo FROM repositories ORDER BY name")
    .all()
    .map((row) => Repository.parse(row));
}

// Clones it the first time, and after that moves the clone to the latest default branch.
export function refreshClone(owner: string, repo: string): string {
  const clone = cloneDir(owner, repo);
  if (existsSync(clone)) {
    updateClone(clone);
    return clone;
  }
  // Cloned outside the folder the lead sees and moved in once whole, so a clone stopped
  // halfway never looks like one.
  const part = join(dataDir(), "cloning", owner, repo);
  rmSync(part, { recursive: true, force: true });
  mkdirSync(dirname(part), { recursive: true });
  cloneRepo(owner, repo, part);
  mkdirSync(dirname(clone), { recursive: true });
  renameSync(part, clone);
  return clone;
}

export function listRepos(): void {
  const all = repositories(openDb());
  if (all.length === 0) {
    console.log("No repositories yet.");
    return;
  }
  const width = Math.max(...all.map((r) => r.name.length));
  const github = Math.max(...all.map((r) => r.owner.length + r.repo.length + 1));
  for (const r of all)
    console.log(
      `${r.name.padEnd(width)}  ${`${r.owner}/${r.repo}`.padEnd(github)}  ${cloneDir(r.owner, r.repo)}`,
    );
}

export function removeRepo(name: string): void {
  const db = openDb();
  const found = repositories(db).find((r) => r.name === name);
  if (!found) throw new Error(`there is no repository named ${name}`);
  rmSync(cloneDir(found.owner, found.repo), { recursive: true, force: true });
  db.run("DELETE FROM repositories WHERE owner = ? AND repo = ?", [found.owner, found.repo]);
  nameRepositories(db);
  console.log(`Removed ${name} and skel's clone of it.`);
}
