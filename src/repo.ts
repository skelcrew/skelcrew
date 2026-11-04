// The repositories skel works on, each from a clone of its own: bringing one in, trusting
// one, keeping the clones current, listing the repositories and removing one.
import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { nameRepositories, openDb, Repository } from "./db.ts";
import { cloneRepo, type GitHubRepo, githubRepo, updateClone } from "./github.ts";
import { cloneDir, configDir, dataDir } from "./paths.ts";
import { refuseCredentials } from "./sandbox.ts";

const noRepositories =
  "skel has no repositories yet. Run skel in a checkout of one, or ask the lead for one by its GitHub name.";

// Returns the file of trusted repositories, kept with your settings so a clone can't bring
// its own yes.
const trustFile = () => join(configDir(), "trusted");

// Returns saved trust entries, or an empty list before you have trusted any repositories.
function trustLines(): string[] {
  return existsSync(trustFile()) ? readFileSync(trustFile(), "utf8").split("\n") : [];
}

// Saves your trust in a repository once, so later commands can bring it in without asking.
function trust(full: string): void {
  if (trustLines().includes(full)) return;
  mkdirSync(configDir(), { recursive: true });
  appendFileSync(trustFile(), `${full}\n`);
}

// Returns checked repository records in name order for commands and clone refreshes.
export function repositories(db: Database): Repository[] {
  return db
    .query("SELECT name, owner, repo FROM repositories ORDER BY name")
    .all()
    .map((row) => Repository.parse(row));
}

// Returns the repository a command names, by its name in skel or its full GitHub name, in
// any case. Throws when skel has no such repository, since commands only work on ones it has.
export function findRepository(db: Database, given: string): Repository {
  // Whether the repository's full GitHub name is the one given, in any case.
  const full = (r: Repository) => `${r.owner}/${r.repo}`.toLowerCase() === given.toLowerCase();
  const found = repositories(db).find((r) => r.name === given || full(r));
  if (!found) throw new Error(`there is no repository named ${given}`);
  return found;
}

// Creates or updates skel's repository clone so the lead can read its latest default
// branch. The lead reads every clone in skel's folder, so a clone whose config holds a
// credential is deleted rather than left there for it.
async function refreshClone(owner: string, repo: string): Promise<void> {
  const clone = cloneDir(owner, repo);
  if (existsSync(clone)) {
    await updateClone(clone);
    checkOrDelete(clone);
    return;
  }
  // Cloned outside the folder the lead sees, checked, and moved in once whole, so neither a
  // clone stopped halfway nor one holding a credential ever shows up there.
  const part = join(dataDir(), "cloning", owner, repo);
  rmSync(part, { recursive: true, force: true });
  mkdirSync(dirname(part), { recursive: true });
  await cloneRepo(owner, repo, part);
  checkOrDelete(part);
  mkdirSync(dirname(clone), { recursive: true });
  renameSync(part, clone);
}

// Rejects and deletes a clone holding credentials, so the lead cannot read your login.
function checkOrDelete(clone: string): void {
  try {
    refuseCredentials(clone);
  } catch (error) {
    rmSync(clone, { recursive: true, force: true });
    throw error;
  }
}

let refreshing: Promise<void> | null = null;

// Refreshes every registered clone so the lead reads current repositories. A second call
// joins the refresh running, so two git commands never fight over a clone. A clone that
// can't be refreshed only gets a line in the log, since an old clone still lets the lead
// read the repository.
export function refreshClones(db: Database): Promise<void> {
  refreshing ??= (async () => {
    for (const { owner, repo } of repositories(db)) {
      try {
        await refreshClone(owner, repo);
        // skel repo rm can run while a clone is still being made, and the clone would then
        // land after the removal, where the lead could still read it.
        if (!repositories(db).some((r) => r.owner === owner && r.repo === repo))
          rmSync(cloneDir(owner, repo), { recursive: true, force: true });
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// Checks trust, refreshes the repository clone and records it for the lead. Asking is only
// for your own terminal. Anywhere else a repository you can't push to waits for skel trust,
// since a yes passed on by the lead could come from an injected instruction.
export async function bringIn(db: Database, github: GitHubRepo, ask: boolean): Promise<void> {
  const { owner, repo, canPush, isFork } = github;
  const full = `${owner}/${repo}`;
  const known = repositories(db).some((r) => r.owner === owner && r.repo === repo);
  // You vouch for what is in a repository you can push to, so asking would only add a step.
  // A fork you own holds someone else's code, so it is asked about. skel clones from
  // GitHub, never from your checkout, so what it clones is what your permission covers.
  if (!known && !(canPush && !isFork) && !trustLines().includes(full)) {
    if (!ask) throw new Error(`${full} waits until you run skel trust ${full} in your terminal`);
    console.log(`Agents will run ${full}'s setup and test commands, and follow its AGENTS.md`);
    console.log("and settings as instructions.");
    const answer = prompt(`Do you trust ${full}? [y/N]`);
    if (!["y", "yes"].includes(answer?.trim().toLowerCase() ?? "")) {
      console.log(`skel didn't clone ${full}, since you don't trust it.`);
      return;
    }
    trust(full);
  }
  if (!existsSync(cloneDir(owner, repo))) console.log(`Cloning ${full} for skel.`);
  await refreshClone(owner, repo);
  if (known) return;
  db.run("INSERT INTO repositories (owner, repo, name) VALUES (?, ?, ?)", [owner, repo, full]);
  nameRepositories(db);
}

// Brings in the repository you attached from, reporting failures without blocking the lead.
// Plain skel must stay fast, so a repository skel has costs no call to GitHub: the daemon
// keeps its clone current. A folder that isn't on GitHub, such as your dotfiles, gets no
// complaint.
export async function bringInFrom(from: string | undefined): Promise<void> {
  const db = openDb();
  const named = from === undefined ? originHere() : (onGitHub(from) ?? from);
  // Matches the attached repository despite differences in GitHub name capitalization.
  const known = (r: Repository) => `${r.owner}/${r.repo}`.toLowerCase() === named?.toLowerCase();
  try {
    if (named && !repositories(db).some(known)) await bringIn(db, githubRepo(named), true);
  } catch (error) {
    console.error(`skel: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (repositories(db).length === 0) console.log(noRepositories);
}

// Returns owner/repo from a GitHub remote URL, or null so other hosts are quietly skipped.
function onGitHub(url: string): string | null {
  const found = url.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i,
  );
  return found?.[1] ?? null;
}

// Returns this checkout's GitHub name, or null when its origin cannot name a GitHub
// repository. Reading origin is the only git skel runs in your checkout: the folder only
// names the repository. It is read as written, before any insteadOf in your git config
// rewrites it.
function originHere(): string | null {
  const origin = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return origin.success ? onGitHub(origin.stdout.toString().trim()) : null;
}

// Records your trust from outside the sandbox and brings in the repository for the lead.
export async function trustRepo(given: string): Promise<void> {
  if (process.env.SKEL_SANDBOX === "1")
    throw new Error("only you can trust a repository, from your own terminal");
  const db = openDb();
  const known = repositories(db).find((r) => r.name === given);
  if (!known && !given.includes("/"))
    throw new Error(`there is no repository named ${given}. Name a new one as owner/repo`);
  const github = githubRepo(known ? `${known.owner}/${known.repo}` : given);
  trust(`${github.owner}/${github.repo}`);
  await bringIn(db, github, false);
}

// Prints registered repositories and clone paths, or tells you how to bring in the first
// one.
export function listRepos(): void {
  const all = repositories(openDb());
  if (all.length === 0) {
    console.log(noRepositories);
    return;
  }
  const width = Math.max(...all.map((r) => r.name.length));
  const github = Math.max(...all.map((r) => r.owner.length + r.repo.length + 1));
  for (const r of all)
    console.log(
      `${r.name.padEnd(width)}  ${`${r.owner}/${r.repo}`.padEnd(github)}  ${cloneDir(r.owner, r.repo)}`,
    );
}

// Deletes skel's clone, registration and saved trust, then updates names that no longer
// clash.
export function removeRepo(name: string): void {
  const db = openDb();
  const found = repositories(db).find((r) => r.name === name);
  if (!found) throw new Error(`there is no repository named ${name}`);
  const full = `${found.owner}/${found.repo}`;
  rmSync(cloneDir(found.owner, found.repo), { recursive: true, force: true });
  db.run("DELETE FROM repositories WHERE owner = ? AND repo = ?", [found.owner, found.repo]);
  nameRepositories(db);
  const kept = trustLines().filter((line) => line !== "" && line !== full);
  if (existsSync(trustFile())) writeFileSync(trustFile(), kept.map((line) => `${line}\n`).join(""));
  console.log(`Removed ${name} and skel's clone of it.`);
}
