// The repositories Skelcrew works on, each from a clone of its own: bringing one in, trusting
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
import { type Document, parseDocument, stringify } from "yaml";
import { z } from "zod";
import { refuseCredentials } from "../agents/sandbox.ts";
import { stopSession } from "../agents/tmux.ts";
import { agentRoles } from "../config.ts";
import { nameRepositories, openDb, Repository } from "../db.ts";
import { originHere, pathOf } from "../machine/origin.ts";
import { onSprite } from "../machine/sprite.ts";
import { cloneDir, configDir, dataDir, leadPlaces } from "../paths.ts";
import { type Claimed, claims, pluginsFor } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { checkPush, cloneRepository, updateClone } from "./git.ts";
import { wakeRepository } from "./wake.ts";

export const noRepositories = "Skelcrew has no repositories yet. Run sc in a checkout of one.";

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
    .query("SELECT name, owner, repo, forge, remote FROM repositories ORDER BY name")
    .all()
    .map((row) => Repository.parse(row));
}

// Returns whether the name is the repository's owner/name: on its forge, or without one, its
// remote's path. Forges such as GitHub ignore case in names, so a checkout's remote or a
// command can spell one differently from Skelcrew. No name matches nothing.
export const fullNameIs = (r: Repository, name: string | null | undefined) =>
  `${r.owner}/${r.repo}`.toLowerCase() === name?.toLowerCase();

// Returns whether a remote URL names the repository: the URL Skelcrew clones it from, or one on
// the same host whose path ends with its owner/name, as a checkout's ssh remote does for an
// https clone.
const remoteIs = (r: Repository, url: string) => {
  const path = pathOf(url);
  const ours = pathOf(r.remote);
  return (
    r.remote === url ||
    (path !== null && path.host === ours?.host && fullNameIs(r, `${path.owner}/${path.repo}`))
  );
};

// Returns the repository a command names, by its name in Skelcrew or its owner/name, in any case.
// Throws when Skelcrew has no such repository, since commands only work on ones it has.
export function findRepository(db: Database, given: string): Repository {
  const found = repositories(db).find((r) => r.name === given || fullNameIs(r, given));
  if (!found) throw new Error(`there is no repository named ${given}`);
  return found;
}

// Returns the repository a checkout's remote URL, or its owner/name, names, or none.
export const repositoryAt = (db: Database, given: string) =>
  repositories(db).find((r) => fullNameIs(r, given) || remoteIs(r, given));

// Creates or updates Skelcrew's repository clone so its lead can read its latest default
// branch. The lead reads the clone, so a clone whose config holds a credential is deleted
// rather than left there for it.
async function refreshClone(db: Database, repository: Repository): Promise<void> {
  const { owner, repo } = repository;
  const clone = cloneDir(owner, repo);
  if (existsSync(clone)) {
    await updateClone(db, repository, clone);
    checkOrDelete(clone);
    return;
  }
  // Cloned outside the clone's folder, checked, and moved in once whole, so neither a clone
  // stopped halfway nor one holding a credential ever shows up where a lead or thread looks.
  const part = join(dataDir(), "cloning", owner, repo);
  rmSync(part, { recursive: true, force: true });
  mkdirSync(dirname(part), { recursive: true });
  await cloneRepository(db, repository, part);
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

// Returns whether Skelcrew has asked which forge claims the repository yet. Until then it isn't
// polled, as one with a forge would be taken for one with none.
export function forgeKnown(db: Database, repository: Repository): boolean {
  const row = db
    .query("SELECT claimed FROM repositories WHERE owner = ? AND repo = ?")
    .get(repository.owner, repository.repo);
  return z.object({ claimed: z.coerce.boolean() }).nullable().parse(row)?.claimed ?? false;
}

// Returns who commits in a forge's name, as git writes an author, or null for none.
const authorOf = (claimed: Claimed | null) =>
  claimed?.author ? `${claimed.author.name} <${claimed.author.email}>` : null;

// Returns who commits in the repository's forge's name, as git writes an author, such as its
// app's bot, or null when its forge names none or it has no forge.
export function forgeAuthor(db: Database, repository: { owner: string; repo: string }) {
  const row = db
    .query("SELECT author FROM repositories WHERE owner = ? AND repo = ?")
    .get(repository.owner, repository.repo);
  return z.object({ author: z.string().nullable() }).nullable().parse(row)?.author ?? null;
}

// Asks the forges installed which one claims the repository's remote, once, and saves it: a
// repository added before its forge was installed, or by a Skelcrew from before plugins, gains it
// here. One whose forge fails to answer is asked again at the next refresh.
async function findForge(db: Database, repository: Repository): Promise<Repository> {
  const where = "WHERE owner = ? AND repo = ?";
  if (forgeKnown(db, repository)) return repository;
  const claimed = await claims(db, repository.remote);
  const forge = claimed?.forge ?? null;
  // The forge's clone URL, as its login works for that one, such as https where your checkout
  // had ssh.
  const remote = claimed?.clone ?? repository.remote;
  db.run(`UPDATE repositories SET forge = ?, author = ?, remote = ?, claimed = 1 ${where}`, [
    forge,
    authorOf(claimed),
    remote,
    repository.owner,
    repository.repo,
  ]);
  return { ...repository, forge, remote };
}

let refreshing: Promise<void> | null = null;

// Refreshes every registered clone so leads read current repositories, finding a repository's
// forge first when Skelcrew hasn't yet. A second call joins the refresh running, so two git
// commands never fight over a clone. A clone that fails only gets a line in the log and is
// tried again at the next refresh, since an old clone still lets a lead read its repository.
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
        await refreshClone(db, await findForge(db, next));
        // sc repo rm can run while a clone is still being made, and the clone would then
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

// What Skelcrew knows of a repository it is bringing in: from the forge that claims its remote,
// or, with none, its remote alone.
type Found = { owner: string; repo: string; remote: string; claimed: Claimed | null };

// Returns what Skelcrew knows of the repository at a remote URL, or named by its owner/name on its
// forge: the forge's answer, when one claims it, or else, for a URL, its path. Throws when
// neither names a repository.
async function found(db: Database, given: string): Promise<Found> {
  const claimed = await claims(db, given);
  if (claimed) {
    const [owner = "", repo = ""] = claimed.key.split("/");
    return { owner, repo, remote: claimed.clone, claimed };
  }
  const path = given.includes(":") ? pathOf(given) : null;
  if (!path)
    throw new Error(
      `no forge installed knows ${given}: give its remote's URL, or run sc in a checkout of it`,
    );
  return { owner: path.owner, repo: path.repo, remote: given, claimed: null };
}

// Whether Skelcrew may clone a repository without asking you. You vouch for what is in a
// repository your forge says you can push to, so asking would only add a step. A fork you own
// holds someone else's code, and a repository with no forge can't say, so both are asked
// about. Skelcrew clones from the remote, never from your checkout, so what it clones is what your
// permission covers.
function trusted({ owner, repo, claimed }: Found): boolean {
  const vouched = claimed?.push === true && !claimed.fork;
  return vouched || trustLines().includes(`${owner}/${repo}`);
}

// Checks trust, asking you when needed, refreshes the repository clone and records it. A repository
// with no forge takes Skelcrew's pushes on your own git login, so Skelcrew checks that it can push
// first. Runs only in your own terminal, where a yes can't come from an injected instruction.
async function bringIn(db: Database, details: Found): Promise<void> {
  const { owner, repo, remote, claimed } = details;
  const fullName = `${owner}/${repo}`;
  const known = repositories(db).some((r) => r.owner === owner && r.repo === repo);
  if (!known && !trusted(details)) {
    console.log(`Agents will run ${fullName}'s setup and test commands, and follow its AGENTS.md`);
    console.log("and settings as instructions.");
    const answer = prompt(`Do you trust ${fullName}? [y/N]`);
    if (!["y", "yes"].includes(answer?.trim().toLowerCase() ?? "")) {
      console.log(`Skelcrew didn't clone ${fullName}, since you don't trust it.`);
      return;
    }
    trust(fullName);
  }
  const repository: Repository = {
    name: fullName,
    owner,
    repo,
    forge: claimed?.forge ?? null,
    remote,
  };
  if (!existsSync(cloneDir(owner, repo))) console.log(`Cloning ${fullName} for Skelcrew.`);
  await refreshClone(db, repository);
  if (known) return;
  if (claimed === null)
    await checkPush(db, repository, cloneDir(owner, repo)).catch((error) => {
      throw new Error(
        `${fullName} has no forge, so Skelcrew pushes threads' branches on your own git login, and git refused: ${errorText(error)}. Give the daemon a login it can use without you, such as a key with no passphrase or a credential helper, then run this again.`,
      );
    });
  db.run(
    "INSERT INTO repositories (owner, repo, name, forge, remote, author, claimed) VALUES (?, ?, ?, ?, ?, ?, 1)",
    [owner, repo, fullName, repository.forge, remote, authorOf(claimed)],
  );
  nameRepositories(db);
  // The daemon asks again when it next starts, so a failure here costs only the wake-ups
  // until then: polling sees every event once the Sprite is awake.
  if (onSprite())
    await wakeRepository(db, repository).catch((error) =>
      console.error(`Skelcrew: couldn't ask for wake-ups for ${fullName}: ${errorText(error)}`),
    );
}

// Brings in the repository you attached from, reporting failures without blocking the lead. `from`
// is a checkout's remote URL, or a repository's owner/name on its forge, and without it, the
// checkout you are in. Returns its owner/repo once Skelcrew has it, so Skelcrew opens its lead; one
// waiting for trust isn't in yet. Plain Skelcrew must stay fast, so a repository Skelcrew has costs
// no call to a forge: the daemon keeps its clone current. A folder with no remote gets no
// complaint.
export async function bringInFrom(from: string | undefined): Promise<string | undefined> {
  const db = openDb();
  const named = from ?? originHere();
  try {
    if (named && !repositoryAt(db, named)) await bringIn(db, await found(db, named));
  } catch (error) {
    console.error(`Skelcrew: ${errorText(error)}`);
  }
  if (repositories(db).length === 0) console.log(noRepositories);
  const at = named ? repositoryAt(db, named) : undefined;
  // A forge can name a repository otherwise than its remote's path, such as after a rename.
  const opened = at ?? (named ? await claimedNow(db, named) : undefined);
  return opened && `${opened.owner}/${opened.repo}`;
}

// Returns the repository Skelcrew has under the name a forge now gives the remote, or none.
async function claimedNow(db: Database, url: string): Promise<Repository | undefined> {
  const claimed = await claims(db, url).catch(() => null);
  return claimed ? repositories(db).find((r) => fullNameIs(r, claimed.key)) : undefined;
}

// Adds a repository for sc repo add: the checkout in the folder given, the repository at a
// remote URL or named by its owner/name on its forge, or with neither, the checkout you are
// in, and says what it did. A folder that is
// there is taken as one. Asks whether you trust the repository when it needs to, so it runs
// only in your own terminal. One Skelcrew has costs no call to a forge.
export async function addRepo(given?: string): Promise<void> {
  const db = openDb();
  const folder = given === undefined || existsSync(given) ? resolve(given ?? ".") : null;
  const url = folder === null ? given : originHere(folder);
  if (folder !== null && !url)
    throw new Error(
      `${folder} isn't a checkout with a remote. Run sc repo add in one, or give the repository's URL.`,
    );
  // A URL starting with a dash would reach git as an option.
  if (!url || url.startsWith("-"))
    throw new Error(`${given} is neither a folder nor a repository's URL`);
  const had = repositoryAt(db, url);
  if (had) {
    console.log(`Skelcrew has ${had.owner}/${had.repo} already, as ${had.name}.`);
    return;
  }
  const details = await found(db, url);
  await bringIn(db, details);
  const added = repositories(db).find((r) => r.owner === details.owner && r.repo === details.repo);
  if (added) console.log(`Added ${added.owner}/${added.repo}, as ${added.name}.`);
}

// Returns a setting's value as YAML that reads back as the same text: plain when it can be,
// quoted when YAML would read it as something else, such as a model named true or 123.
const yamlValue = (value: string) => stringify(value).trim();

// Returns the starter skelcrew.yaml: a line saying the file is shared and never holds a secret,
// the tracker you picked, if any, your harness and model for each role as real lines, from
// your config, and setup and test as commented examples.
function starter(tracker: string | null): string {
  const roles = agentRoles();
  const line = (name: "lead" | "builder" | "reviewer") => {
    const parts = Object.entries(roles[name]).map(([key, value]) => `${key}: ${yamlValue(value)}`);
    return `${`${name}:`.padEnd(10)}{ ${parts.join(", ")} }`;
  };
  return [
    "# Shared with everyone who works on this repository. Never put a secret here.",
    ...(tracker ? [`tracker: ${yamlValue(tracker)}`] : []),
    line("lead"),
    line("builder"),
    line("reviewer"),
    "# setup: [bun install]",
    "# test: [bun test]",
    "",
  ].join("\n");
}

// Returns the top folder of the checkout you are in, or null outside one.
export function checkoutTop(): string | null {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return top.success ? top.stdout.toString().trim() : null;
}

// Reads the skelcrew.yaml at the top of a checkout, for sc init. `there` says whether there is
// one at all, and `settings` is what it holds, or null when it isn't a plain file, as a link
// could point Skelcrew at any file of yours. Throws when it isn't valid YAML.
export function checkoutSettings(root: string): { there: boolean; settings: Document | null } {
  const file = join(root, "skelcrew.yaml");
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { there: stat !== undefined, settings: null };
  const settings = parseDocument(readFileSync(file, "utf8"));
  const [broken] = settings.errors;
  if (broken) throw new Error(`${file} isn't valid YAML: ${broken.message}`);
  return { there: true, settings };
}

// Asks which of your installed trackers holds the repository's tasks, or none, and returns it,
// or null for none. With no tracker installed there is nothing to ask. Enter picks the first.
function pickTracker(): string | null {
  const trackers = pluginsFor(openDb(), "tracker");
  if (trackers.length === 0) return null;
  console.log("Which tracker holds this repository's tasks?");
  for (const [at, name] of [...trackers, "none"].entries()) console.log(`  ${at + 1}) ${name}`);
  // Bun's prompt answers null both for Ctrl-D and for a bare Enter, unless it has a default:
  // then Enter gives the default and only Ctrl-D gives null.
  const answer = prompt("Pick one by its number:", "1");
  if (answer === null) throw new Error("no tracker was picked, so sc init wrote nothing");
  const at = Number(answer.trim()) - 1;
  if (!Number.isInteger(at) || at < 0 || at > trackers.length)
    throw new Error(`${answer.trim()} isn't one of the numbers, so sc init wrote nothing`);
  return trackers[at] ?? null;
}

// Returns the text of a skelcrew.yaml that names no tracker, with a line naming one added at the
// end. Added as text, since writing the file out again from YAML would change how the rest of
// it is laid out. Throws when the line wouldn't read back as the tracker, such as in a file
// written as one { … } map.
function withTracker(file: string, tracker: string): string {
  const text = readFileSync(file, "utf8");
  const added = `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}tracker: ${yamlValue(tracker)}\n`;
  const read = parseDocument(added);
  if (read.errors.length > 0 || read.get("tracker") !== tracker)
    throw new Error(`sc init can't add a line to ${file}: add tracker: ${tracker} yourself`);
  return added;
}

// Sets up the checkout you are in for Skelcrew, for sc init: writes the starter skelcrew.yaml at
// its top, with the tracker you pick, or `tracker` when given, as the first run gives GitHub. In a
// checkout with a skelcrew.yaml already, it only adds the tracker, and leaves one that names a
// tracker alone. Then it adds the repository as sc repo add does. Stops outside a git repository,
// and in one with no remote, as Skelcrew works from its own clone. That clone is at the default
// branch, so it says the file counts only once pushed there.
export async function initRepo(tracker?: string): Promise<void> {
  const root = checkoutTop();
  if (root === null)
    throw new Error(
      "sc init runs in a checkout of a git repository, and this folder isn't in one.",
    );
  if (!originHere(root))
    throw new Error(
      "sc init needs the repository's remote, and this checkout has none. Push it somewhere first, such as to GitHub.",
    );
  const file = join(root, "skelcrew.yaml");
  const { there, settings } = checkoutSettings(root);
  const named = settings?.has("tracker") ?? false;
  const picked = there && (settings === null || named) ? null : (tracker ?? pickTracker());
  // The writes never follow a link: a new file is made only where none is, and one that is
  // there is written only when it is a plain file.
  if (!there) writeFileSync(file, starter(picked), { flag: "wx" });
  else if (settings && picked) writeFileSync(file, withTracker(file, picked));
  else console.log("skelcrew.yaml is there already, so Skelcrew left it as it is.");
  await addRepo(root);
  const counts =
    "Skelcrew reads it from its own clone, so it counts once you commit it and push it to the default branch.";
  if (!there) console.log(`Wrote skelcrew.yaml. ${counts}`);
  else if (picked) console.log(`Added tracker: ${picked} to skelcrew.yaml. ${counts}`);
}

// Records your trust from outside the sandbox and brings in the repository: one Skelcrew has,
// by its name, or a new one at a remote URL.
export async function trustRepo(given: string): Promise<void> {
  const db = openDb();
  const known = repositories(db).find((r) => r.name === given);
  if (!known && !given.includes("/"))
    throw new Error(`there is no repository named ${given}. Name a new one as owner/repo`);
  const details = known
    ? { owner: known.owner, repo: known.repo, remote: known.remote, claimed: null }
    : await found(db, given);
  trust(`${details.owner}/${details.repo}`);
  await bringIn(db, details);
}

// Ends the repository's lead, on Skelcrew's tmux server `tmux`, deletes Skelcrew's clone,
// registration and saved trust, then updates names that no longer clash, and on a Sprite asks its
// tracker and forge to stop passing on its wake-ups. Refuses while the repository has live threads,
// naming them. Left running, the lead would go on with no repository behind it, and the daemon
// would never bring it back or end it.
export async function removeRepo(name: string, tmux: string): Promise<void> {
  const db = openDb();
  const found = repositories(db).find((r) => r.name === name);
  if (!found) throw new Error(`there is no repository named ${name}`);
  // Builders of live threads would keep running with no repository behind them, which
  // breaks polling, sc ps and cleanup after merge.
  const live = db
    .query(
      "SELECT task FROM threads WHERE owner = ? AND repo = ? AND status IN ('working', 'waiting') ORDER BY task",
    )
    .all(found.owner, found.repo)
    .map((row) => `${name}-${z.object({ task: z.coerce.string() }).parse(row).task}`);
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
  // Asked first, while Skelcrew still knows its tracker and forge. Left on, wake-ups would only
  // wake the Sprite for a repository Skelcrew no longer polls.
  if (onSprite())
    await wakeRepository(db, found, true).catch((error) =>
      console.error(`Skelcrew: couldn't stop the wake-ups for ${fullName}: ${errorText(error)}`),
    );
  // Ended as a thread's builder is, and waited for, as the lead reads the clone removed next.
  await stopSession(tmux, leadPlaces(found.owner, found.repo, kept).name);
  rmSync(cloneDir(found.owner, found.repo), { recursive: true, force: true });
  db.run("DELETE FROM repositories WHERE owner = ? AND repo = ?", [found.owner, found.repo]);
  nameRepositories(db);
  const trusted = trustLines().filter((line) => line !== "" && line !== fullName);
  if (existsSync(trustFile()))
    writeFileSync(trustFile(), trusted.map((line) => `${line}\n`).join(""));
  console.log(`Removed ${name} and Skelcrew's clone of it.`);
}
