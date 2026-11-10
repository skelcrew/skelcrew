// The repositories skel works on, each from a clone of its own: bringing one in, trusting
// one, keeping the clones current, listing the repositories and removing one.
import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { refuseCredentials } from "../agents/sandbox.ts";
import { stopSession } from "../agents/tmux.ts";
import { agentRoles } from "../config.ts";
import { nameRepositories, openDb, Repository } from "../db.ts";
import {
  cloneRepo,
  createLabel,
  type GitHubRepo,
  githubRepo,
  removeWebhook,
  updateClone,
} from "../github.ts";
import { onGitHub, originHere } from "../machine/origin.ts";
import { onSprite, spriteUrl } from "../machine/sprite.ts";
import { cloneDir, configDir, dataDir, leadPlaces } from "../paths.ts";
import { errorText } from "../say.ts";
import { hookRepository } from "./webhook.ts";

export const noRepositories = "skel has no repositories yet. Run skel in a checkout of one.";

// Returns the file of trusted repositories, kept with your settings so a clone can't bring
// its own yes.
const trustFile = () => join(configDir(), "trusted");

// Returns saved trust entries, or an empty list before you have trusted any repositories.
function trustLines(): string[] {
  return existsSync(trustFile()) ? readFileSync(trustFile(), "utf8").split("\n") : [];
}

// Saves your trust in a repository once, so later commands can bring it in without asking.
function trust(fullName: string): void {
  if (trustLines().includes(fullName)) return;
  mkdirSync(configDir(), { recursive: true });
  appendFileSync(trustFile(), `${fullName}\n`);
}

// Returns checked repository records in name order for commands and clone refreshes.
export function repositories(db: Database): Repository[] {
  return db
    .query("SELECT name, owner, repo FROM repositories ORDER BY name")
    .all()
    .map((row) => Repository.parse(row));
}

// Returns whether the name is the repository's full GitHub name. GitHub ignores case in
// names, so a checkout's remote or a command can spell one differently from skel. No name,
// such as a folder that isn't on GitHub, matches nothing.
export const fullNameIs = (r: Repository, name: string | null | undefined) =>
  `${r.owner}/${r.repo}`.toLowerCase() === name?.toLowerCase();

// Returns the repository a command names, by its name in skel or its full GitHub name, in
// any case. Throws when skel has no such repository, since commands only work on ones it has.
export function findRepository(db: Database, given: string): Repository {
  const found = repositories(db).find((r) => r.name === given || fullNameIs(r, given));
  if (!found) throw new Error(`there is no repository named ${given}`);
  return found;
}

// Creates or updates skel's repository clone so its lead can read its latest default
// branch. The lead reads the clone, so a clone whose config holds a credential is deleted
// rather than left there for it.
async function refreshClone(owner: string, repo: string): Promise<void> {
  const clone = cloneDir(owner, repo);
  if (existsSync(clone)) {
    await updateClone(clone);
    checkOrDelete(clone);
    return;
  }
  // Cloned outside the clone's folder, checked, and moved in once whole, so neither a clone
  // stopped halfway nor one holding a credential ever shows up where a lead or thread looks.
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

// Refreshes every registered clone so leads read current repositories, and creates the
// skelcrew label in a repository skel hasn't made it in yet, so you can start threads from
// GitHub. A second call joins the refresh running, so two git commands never fight over a
// clone. A clone or label that fails only gets a line in the log and is tried again at the
// next refresh, since an old clone still lets a lead read its repository.
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
        // land after the removal, where nothing would remove it.
        if (!repositories(db).some((r) => r.owner === owner && r.repo === repo))
          rmSync(cloneDir(owner, repo), { recursive: true, force: true });
      } catch (error) {
        console.log(errorText(error));
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

// Checks trust, asking you when needed, refreshes the repository clone, records it, and
// creates its skelcrew label so you can start threads from GitHub. Runs only in your
// own terminal, where a yes can't come from an injected instruction.
async function bringIn(db: Database, details: GitHubRepo): Promise<void> {
  const { owner, repo, canPush } = details;
  const fullName = `${owner}/${repo}`;
  const known = repositories(db).some((r) => r.owner === owner && r.repo === repo);
  if (!known && !trusted(details)) {
    console.log(`Agents will run ${fullName}'s setup and test commands, and follow its AGENTS.md`);
    console.log("and settings as instructions.");
    const answer = prompt(`Do you trust ${fullName}? [y/N]`);
    if (!["y", "yes"].includes(answer?.trim().toLowerCase() ?? "")) {
      console.log(`skel didn't clone ${fullName}, since you don't trust it.`);
      return;
    }
    trust(fullName);
  }
  if (!existsSync(cloneDir(owner, repo))) console.log(`Cloning ${fullName} for skel.`);
  await refreshClone(owner, repo);
  if (known) return;
  db.run("INSERT INTO repositories (owner, repo, name) VALUES (?, ?, ?)", [owner, repo, fullName]);
  nameRepositories(db);
  // The daemon sets it again when it next starts, so a failure here costs only the wake-ups
  // until then: polling sees every event once the Sprite is awake.
  if (onSprite())
    await hookRepository(fullName).catch((error) =>
      console.error(
        `skel: couldn't set the webhook that wakes this Sprite in ${fullName}: ${errorText(error)}`,
      ),
    );
  const labeled = "UPDATE repositories SET labeled = 1 WHERE owner = ? AND repo = ?";
  // Only people who can push or triage may add a label, so where you can't push, a label
  // would be of no use to you.
  if (!canPush) {
    db.run(labeled, [owner, repo]);
    return;
  }
  try {
    await createLabel(fullName);
    db.run(labeled, [owner, repo]);
  } catch (error) {
    // The daemon tries again when it next refreshes the clone.
    console.error(`skel: couldn't create the skelcrew label in ${fullName}: ${errorText(error)}`);
  }
}

// Brings in the repository you attached from, reporting failures without blocking the lead.
// Returns its owner/repo once skel has it, so skel opens its lead; one waiting for trust
// isn't in yet. Plain skel must stay fast, so a repository skel has costs
// no call to GitHub: the daemon keeps its clone current. A folder that isn't on GitHub,
// such as your dotfiles, gets no complaint.
export async function bringInFrom(from: string | undefined): Promise<string | undefined> {
  const db = openDb();
  let named = from === undefined ? originHere() : (onGitHub(from) ?? from);
  // Matches the attached repository despite differences in GitHub name capitalization.
  const known = (r: Repository) => fullNameIs(r, named);
  try {
    if (named && !repositories(db).some(known)) {
      const details = await githubRepo(named);
      // A checkout can still use a name the repository had before it was renamed or moved on
      // GitHub. skel keeps it under the name GitHub gives now, and opens it by that one.
      named = `${details.owner}/${details.repo}`;
      await bringIn(db, details);
    }
  } catch (error) {
    console.error(`skel: ${errorText(error)}`);
  }
  if (repositories(db).length === 0) console.log(noRepositories);
  const found = repositories(db).find(known);
  return found && `${found.owner}/${found.repo}`;
}

// Adds a repository for skel repo add: the checkout in the folder given, the repository named
// as owner/repo, or with neither, the checkout you are in, and says what it did. A folder that
// is there is taken as one, as a path such as simon/app reads like a name. Asks whether you
// trust the repository when it needs to, so it runs only in your own terminal. One skel has
// costs no call to GitHub.
export async function addRepo(given?: string): Promise<void> {
  const db = openDb();
  const folder = given === undefined || existsSync(given) ? resolve(given ?? ".") : null;
  const named = folder === null ? given : originHere(folder);
  if (folder !== null && !named)
    throw new Error(
      `${folder} isn't a checkout of a repository on GitHub. Run skel repo add in one, or name it as owner/repo.`,
    );
  // A name starting with a dash would reach gh as an option.
  if (!named || !/^[\w.][\w.-]*\/[\w.-]+$/.test(named))
    throw new Error(`${given} is neither a folder nor a repository's GitHub name, as owner/repo`);
  const had = repositories(db).find((r) => fullNameIs(r, named));
  if (had) {
    console.log(`skel has ${had.owner}/${had.repo} already, as ${had.name}.`);
    return;
  }
  const details = await githubRepo(named);
  await bringIn(db, details);
  const added = repositories(db).find((r) => r.owner === details.owner && r.repo === details.repo);
  if (added) console.log(`Added ${added.owner}/${added.repo}, as ${added.name}.`);
}

// Returns a setting's value as YAML that reads back as the same text: plain when it can be,
// quoted when YAML would read it as something else, such as a model named true or 123.
const yamlValue = (value: string) => stringify(value).trim();

// Returns the starter skelcrew.yaml: a line saying the file is shared and never holds a secret,
// your harness and model for each role as real lines, from your config, and setup and test
// as commented examples.
function starter(): string {
  const roles = agentRoles();
  const line = (name: "lead" | "builder" | "reviewer") => {
    const parts = Object.entries(roles[name]).map(([key, value]) => `${key}: ${yamlValue(value)}`);
    return `${`${name}:`.padEnd(10)}{ ${parts.join(", ")} }`;
  };
  return [
    "# Shared with everyone who works on this repository. Never put a secret here.",
    line("lead"),
    line("builder"),
    line("reviewer"),
    "# setup: [bun install]",
    "# test: [bun test]",
    "",
  ].join("\n");
}

// Sets up the checkout you are in for skel, for skel init: writes the starter skelcrew.yaml at its
// top, unless one is there, then adds the repository as skel repo add does. Stops outside a
// git repository, and in one with no remote on GitHub, as skel works from its own clone. That
// clone is at the default branch, so it says the file counts only once pushed there.
export async function initRepo(): Promise<void> {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!top.success)
    throw new Error(
      "skel init runs in a checkout of a git repository, and this folder isn't in one.",
    );
  const root = top.stdout.toString().trim();
  if (!originHere(root))
    throw new Error(
      "skel init needs the repository on GitHub, and this checkout has no remote there. Push it to GitHub first.",
    );
  const file = join(root, "skelcrew.yaml");
  // A link counts as there, so the write never goes through one.
  const there = lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  if (there) console.log("skelcrew.yaml is there already, so skel left it as it is.");
  else writeFileSync(file, starter(), { flag: "wx" });
  await addRepo(root);
  if (!there)
    console.log(
      "Wrote skelcrew.yaml. skel reads it from its own clone, so it counts once you commit it and push it to the default branch.",
    );
}

// Records your trust from outside the sandbox and brings in the repository.
export async function trustRepo(given: string): Promise<void> {
  const db = openDb();
  const known = repositories(db).find((r) => r.name === given);
  if (!known && !given.includes("/"))
    throw new Error(`there is no repository named ${given}. Name a new one as owner/repo`);
  const details = await githubRepo(known ? `${known.owner}/${known.repo}` : given);
  trust(`${details.owner}/${details.repo}`);
  await bringIn(db, details);
}

// Ends the repository's lead, on skel's tmux server `tmux`, deletes skel's clone,
// registration and saved trust, then updates names that no longer clash, and on a Sprite
// removes the webhook that wakes it. Refuses while the repository has live threads, naming
// them. Left running, the lead would go on with no repository behind it, and the daemon would
// never bring it back or end it.
export async function removeRepo(name: string, tmux: string): Promise<void> {
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
  const fullName = `${found.owner}/${found.repo}`;
  const kept = z
    .object({ kept_lead: z.coerce.boolean() })
    .parse(
      db
        .query("SELECT kept_lead FROM repositories WHERE owner = ? AND repo = ?")
        .get(found.owner, found.repo),
    ).kept_lead;
  // Ended as a thread's builder is, and waited for, as the lead reads the clone removed next.
  await stopSession(tmux, leadPlaces(found.owner, found.repo, kept).name);
  rmSync(cloneDir(found.owner, found.repo), { recursive: true, force: true });
  db.run("DELETE FROM repositories WHERE owner = ? AND repo = ?", [found.owner, found.repo]);
  nameRepositories(db);
  const trusted = trustLines().filter((line) => line !== "" && line !== fullName);
  if (existsSync(trustFile()))
    writeFileSync(trustFile(), trusted.map((line) => `${line}\n`).join(""));
  // Removed last, so a webhook GitHub couldn't remove never stops the rest. Left behind, it
  // only wakes the Sprite for a repository skel no longer polls.
  if (onSprite())
    await removeWebhook(fullName, spriteUrl()).catch((error) =>
      console.error(
        `skel: couldn't remove the webhook that wakes this Sprite from ${fullName}, so remove it on GitHub: ${errorText(error)}`,
      ),
    );
  console.log(`Removed ${name} and skel's clone of it.`);
}
