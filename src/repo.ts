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
import { z } from "zod";
import { nameRepositories, openDb, Repository } from "./db.ts";
import { cloneRepo, createLabel, type GitHubRepo, githubRepo, updateClone } from "./github.ts";
import { onGitHub, originHere } from "./origin.ts";
import { cloneDir, configDir, dataDir } from "./paths.ts";
import { refuseCredentials } from "./sandbox.ts";

export const noRepositories =
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

// Refreshes every registered clone so the lead reads current repositories, and creates the
// skel label in a repository skel hasn't made it in yet, so you can start threads from
// GitHub. A second call joins the refresh running, so two git commands never fight over a
// clone. A clone or label that fails only gets a line in the log and is tried again at the
// next refresh, since an old clone still lets the lead read the repository.
export function refreshClones(db: Database): Promise<void> {
  refreshing ??= (async () => {
    const done = new Set<string>();
    // Read again after each repository, so one brought in during the refresh is cloned in it
    // too: a thread started on it waits on this refresh for its clone.
    for (;;) {
      const next = repositories(db).find((r) => !done.has(`${r.owner}/${r.repo}`));
      if (!next) break;
      const { owner, repo } = next;
      done.add(`${owner}/${repo}`);
      try {
        await refreshClone(owner, repo);
        // Once per repository, so a label you deleted stays deleted.
        const where = "WHERE owner = ? AND repo = ? AND labeled = 0";
        if (db.query(`SELECT 1 FROM repositories ${where}`).get(owner, repo)) {
          await createLabel(`${owner}/${repo}`);
          db.run(`UPDATE repositories SET labeled = 1 ${where}`, [owner, repo]);
        }
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

// Whether skel may clone a repository without asking you. You vouch for what is in a
// repository you can push to, so asking would only add a step. A fork you own holds someone
// else's code, so it is asked about. skel clones from GitHub, never from your checkout, so
// what it clones is what your permission covers.
function trusted({ owner, repo, canPush, isFork }: GitHubRepo): boolean {
  return (canPush && !isFork) || trustLines().includes(`${owner}/${repo}`);
}

// Checks trust, asking you when needed, refreshes the repository clone, records it for the
// lead, and creates its skel label so you can start threads from GitHub. Runs only in your
// own terminal, where a yes can't come from an injected instruction.
export async function bringIn(db: Database, github: GitHubRepo): Promise<void> {
  const { owner, repo, canPush } = github;
  const full = `${owner}/${repo}`;
  const known = repositories(db).some((r) => r.owner === owner && r.repo === repo);
  if (!known && !trusted(github)) {
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
  const labeled = "UPDATE repositories SET labeled = 1 WHERE owner = ? AND repo = ?";
  // Only people who can push or triage may add a label, so where you can't push, a label
  // would be of no use to you.
  if (!canPush) {
    db.run(labeled, [owner, repo]);
    return;
  }
  try {
    await createLabel(full);
    db.run(labeled, [owner, repo]);
  } catch (error) {
    // The daemon tries again when it next refreshes the clone.
    console.error(
      `skel: couldn't create the skel label in ${full}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Brings in the repository you attached from, reporting failures without blocking the lead.
// Returns its owner/repo once skel has it, so the lead takes it as the default; one waiting
// for trust isn't a default yet. Plain skel must stay fast, so a repository skel has costs
// no call to GitHub: the daemon keeps its clone current. A folder that isn't on GitHub,
// such as your dotfiles, gets no complaint.
export async function bringInFrom(from: string | undefined): Promise<string | undefined> {
  const db = openDb();
  let named = from === undefined ? originHere() : (onGitHub(from) ?? from);
  // Matches the attached repository despite differences in GitHub name capitalization.
  const known = (r: Repository) => `${r.owner}/${r.repo}`.toLowerCase() === named?.toLowerCase();
  try {
    if (named && !repositories(db).some(known)) {
      const github = await githubRepo(named);
      // A checkout can still use a name the repository had before it was renamed or moved on
      // GitHub. skel keeps it under the name GitHub gives now, and the lead must hear that one.
      named = `${github.owner}/${github.repo}`;
      await bringIn(db, github);
    }
  } catch (error) {
    console.error(`skel: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (repositories(db).length === 0) console.log(noRepositories);
  const found = repositories(db).find(known);
  return found && `${found.owner}/${found.repo}`;
}

// Brings in a repository a command names by its full GitHub name, such as skel task ls
// skelcrew/skel-github, when skel doesn't have it, and returns it. Returns nothing when skel
// has it, or the name isn't owner/repo, so the command answers as for any name. The daemon
// runs this for the lead and agents, so it never asks: a repository that isn't trusted waits
// for skel repo trust, since a yes passed on by the lead could come from an injected
// instruction. Recorded at once, so its short name works, and cloned in the background,
// since an agent's command can't wait minutes for a clone. A thread started on it waits for
// the clone.
export async function bringInNamed(db: Database, given: string): Promise<Repository | undefined> {
  // A name starting with a dash would reach gh as an option.
  if (!/^[\w.][\w.-]*\/[\w.-]+$/.test(given)) return undefined;
  const full = (r: Repository) => `${r.owner}/${r.repo}`.toLowerCase();
  if (repositories(db).some((r) => full(r) === given.toLowerCase())) return undefined;
  const github = await githubRepo(given);
  const { owner, repo, canPush } = github;
  const named = `${owner}/${repo}`;
  if (!trusted(github))
    throw new Error(`${named} waits until you run skel repo trust ${named} in your terminal`);
  // GitHub can answer for a renamed repository under the name skel already has it by, and two
  // commands can bring in the same repository at once.
  const fresh = !repositories(db).some((r) => full(r) === named.toLowerCase());
  if (fresh) {
    // Only people who can push or triage may add a label, so where you can't push, a label
    // would be of no use to you. A repository you can push to gets it with its clone.
    db.run("INSERT OR IGNORE INTO repositories (owner, repo, name, labeled) VALUES (?, ?, ?, ?)", [
      owner,
      repo,
      named,
      canPush ? 0 : 1,
    ]);
    nameRepositories(db);
    refreshClones(db).catch((error) => console.log(String(error)));
  }
  return findRepository(db, named);
}

// Records your trust from outside the sandbox and brings in the repository for the lead.
export async function trustRepo(given: string): Promise<void> {
  const db = openDb();
  const known = repositories(db).find((r) => r.name === given);
  if (!known && !given.includes("/"))
    throw new Error(`there is no repository named ${given}. Name a new one as owner/repo`);
  const github = await githubRepo(known ? `${known.owner}/${known.repo}` : given);
  trust(`${github.owner}/${github.repo}`);
  await bringIn(db, github);
}

// Deletes skel's clone, registration and saved trust, then updates names that no longer
// clash. Refuses while the repository has live threads, naming them.
export function removeRepo(name: string): void {
  const db = openDb();
  const found = repositories(db).find((r) => r.name === name);
  if (!found) throw new Error(`there is no repository named ${name}`);
  // Builders of live threads would keep running with no repository behind them, which
  // breaks polling, skel ps and cleanup after merge.
  const live = db
    .query(
      "SELECT task FROM threads WHERE owner = ? AND repo = ? AND status IN ('working', 'waiting') ORDER BY task",
    )
    .all(found.owner, found.repo)
    .map((row) => `${name}-${z.object({ task: z.number() }).parse(row).task}`);
  if (live.length > 0)
    throw new Error(`${name} has live threads: ${live.join(", ")}. Stop them first.`);
  const full = `${found.owner}/${found.repo}`;
  rmSync(cloneDir(found.owner, found.repo), { recursive: true, force: true });
  db.run("DELETE FROM repositories WHERE owner = ? AND repo = ?", [found.owner, found.repo]);
  nameRepositories(db);
  const kept = trustLines().filter((line) => line !== "" && line !== full);
  if (existsSync(trustFile())) writeFileSync(trustFile(), kept.map((line) => `${line}\n`).join(""));
  console.log(`Removed ${name} and skel's clone of it.`);
}
