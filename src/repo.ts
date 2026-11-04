// The repositories skel works on: listing them and removing one.
import type { Database } from "bun:sqlite";
import { openDb, Repository } from "./db.ts";

function repositories(db: Database): Repository[] {
  return db
    .query("SELECT name, path, owner, repo FROM repositories ORDER BY name")
    .all()
    .map((row) => Repository.parse(row));
}

export function listRepos(): void {
  const all = repositories(openDb());
  if (all.length === 0) {
    console.log("No repositories yet.");
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
