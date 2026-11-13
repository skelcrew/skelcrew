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
import { stringify } from "yaml";
import { z } from "zod";
import { refuseCredentials } from "../agents/sandbox.ts";
import { stopSession } from "../agents/tmux.ts";
import { agentRoles } from "../config.ts";
import { nameRepositories, openDb, Repository } from "../db.ts";
import { originHere, parseRemote } from "../machine/origin.ts";
import { onSprite } from "../machine/sprite.ts";
import { cloneDir, configDir, dataDir, leadPlaces } from "../paths.ts";
import { askWhichForge, type Claimed } from "../plugins/ask.ts";
import { setUpPlugin } from "../plugins/install.ts";
import { SetupNeeded } from "../plugins/plugin.ts";
import { errorText } from "../say.ts";
import { checkPush, cloneRepository, updateClone } from "./git.ts";
import { wakeRepository } from "./wake.ts";

// What sc says outside any repository while Skelcrew has none yet, so you know where to run it.
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
  const path = parseRemote(url);
  const cloned = parseRemote(r.remote);
  return (
    r.remote === url ||
    (path !== null && path.host === cloned?.host && fullNameIs(r, `${path.owner}/${path.repo}`))
  );
};

// Returns the repository a command names, by its name in Skelcrew or its owner/name, in any case.
// Throws when Skelcrew has no such repository, since commands only work on ones it has.
export function findRepository(db: Database, given: string): Repository {
  const found = repositories(db).find((r) => r.name === given || fullNameIs(r, given));
  if (!found) throw new Error(`there is no repository named ${given}`);
  return found;
}

// Returns a remote URL's host and owner/name in lower case, such as github.com/simon/app, as
// Skelcrew saves a remote that uses a repository's old name. The same repository's ssh and https
// remotes give the same. Null for a bare owner/name, which no checkout's remote is.
const remoteKey = (url: string) => {
  const path = parseRemote(url);
  return path && `${path.host}/${path.owner}/${path.repo}`.toLowerCase();
};

// Returns the repository a checkout's remote URL, or its owner/name, names, or none. A remote
// whose forge said it uses an old name of a repository Skelcrew has matches that one, so plain
// sc starts with no call to the forge. It matches only when no repository has that name or
// remote itself, as a new repository can later take the old name.
export function repositoryAt(db: Database, given: string): Repository | undefined {
  const all = repositories(db);
  const found = all.find((r) => fullNameIs(r, given) || remoteIs(r, given));
  if (found) return found;
  const row = db
    .query("SELECT owner, repo FROM repositories WHERE old_remote = ?")
    .get(remoteKey(given));
  const old = z.object({ owner: z.string(), repo: z.string() }).nullable().parse(row);
  return old ? all.find((r) => r.owner === old.owner && r.repo === old.repo) : undefined;
}

// Creates or updates Skelcrew's repository clone so its lead can read its latest default
// branch. The lead reads the clone, so a clone whose config holds a credential is deleted
// rather than left there for it.
async function refreshClone(db: Database, repository: Repository): Promise<void> {
  const { owner, repo } = repository;
  // A clone Skelcrew has already is brought up to date in place, and checked again, as the
  // update could have brought a credential in.
  const clone = cloneDir(owner, repo);
  if (existsSync(clone)) {
    await updateClone(db, repository, clone);
    deleteIfCredentials(clone);
    return;
  }
  // Cloned outside the clone's folder, checked, and moved in once whole, so neither a clone
  // stopped halfway nor one holding a credential ever shows up where a lead or thread looks.
  const part = join(dataDir(), "cloning", owner, repo);
  rmSync(part, { recursive: true, force: true });
  mkdirSync(dirname(part), { recursive: true });
  await cloneRepository(db, repository, part);
  deleteIfCredentials(part);
  mkdirSync(dirname(clone), { recursive: true });
  renameSync(part, clone);
}

// Deletes the clone and throws when it holds a credential, so the lead can't read your login.
function deleteIfCredentials(clone: string): void {
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
  // Saved as claimed even when no forge claims it, so a repository with none isn't asked
  // about again at every refresh.
  if (forgeKnown(db, repository)) return repository;
  const claimed = await askWhichForge(db, repository.remote);
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
    while (true) {
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
type RepositoryDetails = { owner: string; repo: string; remote: string; claimed: Claimed | null };

// Returns the owner, name and remote of a repository given as a remote URL, or as its
// owner/name on its forge. A forge that claims it gives the answer. Otherwise a URL's own path
// does. Throws when neither names a repository.
async function identifyRepository(db: Database, given: string): Promise<RepositoryDetails> {
  // A forge's answer wins, as it knows the repository's real owner/name and the URL its login
  // can clone. Without one, only a URL says where the repository is: a bare owner/name
  // names nothing a forge doesn't know.
  const claimed = await claimsAfterSetup(db, given);
  if (claimed) {
    const [owner = "", repo = ""] = claimed.key.split("/");
    return { owner, repo, remote: claimed.clone, claimed };
  }
  const path = given.includes(":") ? parseRemote(given) : null;
  if (!path)
    throw new Error(
      `no forge installed knows ${given}: give its remote's URL, or run sc in a checkout of it`,
    );
  return { owner: path.owner, repo: path.repo, remote: given, claimed: null };
}

// Asks the forges which one claims the remote, as askWhichForge does. A forge can answer that its
// setup must run again, such as GitHub's when its app isn't on the repository yet. Then, at a
// terminal, this runs that setup for the repository and asks once more, so a new user gets
// the fix where they are. With no terminal nobody can answer the setup, so the error is
// thrown, naming the command. A setup that fails throws, having said why.
async function claimsAfterSetup(db: Database, given: string): Promise<Claimed | null> {
  try {
    return await askWhichForge(db, given);
  } catch (error) {
    if (!(error instanceof SetupNeeded) || !process.stdin.isTTY) throw error;
    setUpPlugin(error.plugin, given);
    return askWhichForge(db, given);
  }
}

// Returns whether Skelcrew may clone a repository without asking you. You vouch for what is in a
// repository your forge says you can push to, so asking would only add a step. A fork you own
// holds someone else's code, and a repository with no forge can't say, so both are asked
// about. Skelcrew clones from the remote, never from your checkout, so what it clones is what your
// permission covers.
function mayCloneWithoutAsking({ owner, repo, claimed }: RepositoryDetails): boolean {
  const vouched = claimed?.push === true && !claimed.fork;
  return vouched || trustLines().includes(`${owner}/${repo}`);
}

// Checks trust, asking you when needed, refreshes the repository clone and records it. A repository
// with no forge takes Skelcrew's pushes on your own git login, so Skelcrew checks that it can push
// first. Runs only in your own terminal, where a yes can't come from an injected instruction.
async function bringIn(db: Database, details: RepositoryDetails): Promise<void> {
  const { owner, repo, remote, claimed } = details;
  const fullName = `${owner}/${repo}`;
  const had = repositories(db).find((r) => r.owner === owner && r.repo === repo);
  const known = had !== undefined;
  // Another server can hold a repository of the same owner/name. Refreshing from it would put
  // its code in the clone of the one Skelcrew has, where leads and builders read it.
  if (had && !remoteIs(had, remote))
    throw new Error(
      `Skelcrew has ${fullName} already, from ${had.remote}. To add the one at ${remote}, remove it first with sc repo rm ${had.name}`,
    );
  // A repository new to Skelcrew that you haven't vouched for waits for your yes, as its
  // instructions will steer agents.
  if (!known && !mayCloneWithoutAsking(details)) {
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
  // Clone before saving it, so a repository Skelcrew has always has a clone. One Skelcrew had
  // already only needed its clone back, such as after sc repo trust.
  if (!existsSync(cloneDir(owner, repo))) console.log(`Cloning ${fullName} for Skelcrew.`);
  await refreshClone(db, repository);
  if (known) return;
  if (claimed === null)
    await checkPush(db, repository, cloneDir(owner, repo)).catch((error) => {
      throw new Error(
        `${fullName} has no forge, so Skelcrew pushes threads' branches on your own git login, and git refused: ${errorText(error)}. Give the daemon a login it can use without you, such as a key with no passphrase or a credential helper, then run this again.`,
      );
    });
  // Save it, then give every repository its short name again, since this one may now share a
  // name with another and both gain their owner.
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

// Brings in the repository you ran sc from, so its lead can open. `from` is a checkout's
// remote URL or a repository's owner/name on its forge. Without it, the checkout you are in is
// used. A failure is printed rather than thrown, so sc still attaches. Returns the repository's
// owner/repo once Skelcrew has it, so sc opens its lead. A repository you didn't trust isn't
// in, so nothing is returned for it. Plain sc must start fast, so a repository Skelcrew has
// already costs no call to a forge: the daemon keeps its clone current. A folder with no
// remote gets no complaint.
export async function bringInFrom(from: string | undefined): Promise<string | undefined> {
  const db = openDb();
  const named = from ?? originHere();
  let opened = named ? repositoryAt(db, named) : undefined;
  // Bring in the repository only when Skelcrew doesn't have it, and report a failure rather
  // than throw, so sc still attaches.
  try {
    if (named && !opened) {
      const details = await identifyRepository(db, named);
      await bringIn(db, details);
      opened = repositories(db).find((r) => r.owner === details.owner && r.repo === details.repo);
      // The forge can name a repository Skelcrew has otherwise than the remote does, such as
      // after a rename. Saved, so the next sc from this checkout asks the forge nothing.
      if (opened && oldRemoteOf(named, opened))
        db.run("UPDATE repositories SET old_remote = ? WHERE owner = ? AND repo = ?", [
          remoteKey(named),
          opened.owner,
          opened.repo,
        ]);
    }
  } catch (error) {
    console.error(`Skelcrew: ${errorText(error)}`);
  }
  if (repositories(db).length === 0) console.log(noRepositories);
  // Said each time, not only the first: the line flashes by before the screen opens, and a
  // remote that names another repository than the one opened should never go unnoticed.
  const update = named && opened ? oldRemoteOf(named, opened) : null;
  if (update)
    console.log(
      `${update.old} moved to ${update.current}. To update this checkout, run:\n  git remote set-url origin ${update.url}`,
    );
  return opened && `${opened.owner}/${opened.repo}`;
}

// Returns the old owner/name a remote URL uses for the repository, its current owner/name, and
// the same URL with the current name, in the same form, ssh or https. Null when the remote uses its current name,
// or is a bare owner/name.
function oldRemoteOf(
  url: string,
  repository: Repository,
): { old: string; current: string; url: string } | null {
  const path = parseRemote(url);
  const old = path && `${path.owner}/${path.repo}`;
  if (!old || fullNameIs(repository, old)) return null;
  // The last place the old name is written is its path, as a host can't hold a slash.
  const at = url.lastIndexOf(old);
  const current = `${repository.owner}/${repository.repo}`;
  return { old, current, url: url.slice(0, at) + current + url.slice(at + old.length) };
}

// Adds a repository for sc repo add: the checkout in the folder given, the repository at a
// remote URL or named by its owner/name on its forge, or with neither, the checkout you are
// in, and says what it did. A folder that is there is taken as one. Asks whether you trust the
// repository when it needs to, so it runs only in your own terminal. One Skelcrew has costs no
// call to a forge.
export async function addRepo(given?: string): Promise<void> {
  // Work out the remote URL: a folder's own remote, or what you gave when it is no folder.
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
  // One Skelcrew has already is only named, with no call to a forge.
  const had = repositoryAt(db, url);
  if (had) {
    // Adding it again opens its tab, if you had closed it by exiting its lead. The daemon opens
    // it as sc in a checkout of it would, and its lead starts again with its conversation, even
    // with no screen open. A daemon that isn't running brings the lead back when it starts.
    const closed = db
      .query("SELECT 1 FROM repositories WHERE owner = ? AND repo = ? AND tab_closed = 1")
      .get(had.owner, had.repo);
    if (closed) {
      // Imported here, as the client's replies are checked with what sc repo ls lists, which
      // imports this file, and a loop of imports leaves one of them unset as the other loads.
      const { ask } = await import("../client.ts");
      const reply = await ask({ command: "lead", from: `${had.owner}/${had.repo}` }, 60_000);
      if (reply === null)
        db.run("UPDATE repositories SET tab_closed = 0 WHERE owner = ? AND repo = ?", [
          had.owner,
          had.repo,
        ]);
      const failed = z.object({ error: z.string() }).safeParse(reply);
      if (failed.success) console.error(`Skelcrew: ${failed.data.error}`);
    }
    const tab = closed ? " Its tab is open again." : "";
    console.log(`Skelcrew has ${had.owner}/${had.repo} already, as ${had.name}.${tab}`);
    return;
  }
  const details = await identifyRepository(db, url);
  await bringIn(db, details);
  const added = repositories(db).find((r) => r.owner === details.owner && r.repo === details.repo);
  if (added) console.log(`Added ${added.owner}/${added.repo}, as ${added.name}.`);
}

// Returns a setting's value as YAML that reads back as the same text: plain when it can be,
// quoted when YAML would read it as something else, such as a model named true or 123.
const yamlValue = (value: string) => stringify(value).trim();

// Returns the starter skelcrew.yaml: a line saying the file is shared and never holds a secret,
// your harness and model for each role as real lines, from your config, and setup and test as
// commented examples. It names no tracker, so a repository on GitHub keeps its issues as tasks,
// and shows tracker: none commented out, so you can find how to turn that off.
function starterConfig(): string {
  // Each role is one line of { key: value } pairs, its name padded so the three line up.
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
    "# Keeps this repository on git alone, with no tracker.",
    "# tracker: none",
    "",
  ].join("\n");
}

// Returns the top folder of the checkout you are in, or null outside one.
function checkoutTop(): string | null {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return top.success ? top.stdout.toString().trim() : null;
}

// Sets up the checkout you are in for Skelcrew, for sc init: writes the starter skelcrew.yaml at
// its top, or leaves one that is there as it is, then adds the repository as sc repo add does.
// Stops outside a git repository, and in one with no remote, as Skelcrew works from its own
// clone. That clone is at the default branch, so it says the file counts only once pushed there.
export async function initRepo(): Promise<void> {
  // Stop before writing anything where the file couldn't count: outside a checkout, or in one
  // with no remote for Skelcrew to clone.
  const root = checkoutTop();
  if (root === null)
    throw new Error(
      "sc init runs in a checkout of a git repository, and this folder isn't in one.",
    );
  if (!originHere(root))
    throw new Error(
      "sc init needs the repository's remote, and this checkout has none. Push it somewhere first, such as to GitHub.",
    );
  // A new file is made only where none is, so the write never follows a link.
  const file = join(root, "skelcrew.yaml");
  const there = lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  if (!there) writeFileSync(file, starterConfig(), { flag: "wx" });
  else console.log("skelcrew.yaml is there already, so Skelcrew left it as it is.");
  // Bring the repository in, then say what was written and when Skelcrew will read it.
  await addRepo(root);
  if (!there) console.log("Wrote skelcrew.yaml. Commit and push it to start.");
}

// Records your trust from outside the sandbox and brings in the repository: one Skelcrew has,
// by its name, or a new one at a remote URL.
export async function trustRepo(given: string): Promise<void> {
  // A name Skelcrew knows needs no forge to find it again. Anything else must be an
  // owner/name or URL a forge or remote can answer for.
  const db = openDb();
  const known = repositories(db).find((r) => r.name === given);
  if (!known && !given.includes("/"))
    throw new Error(`there is no repository named ${given}. Name a new one as owner/repo`);
  const details = known
    ? { owner: known.owner, repo: known.repo, remote: known.remote, claimed: null }
    : await identifyRepository(db, given);
  trust(`${details.owner}/${details.repo}`);
  await bringIn(db, details);
}

// Removes a repository for sc repo rm. On a Sprite, first asks its tracker and forge to stop
// sending its wake-ups. Ends its lead on the tmux server `tmux`, then deletes Skelcrew's clone,
// its row and your trust in it, and names the other repositories again. Refuses while the
// repository has live threads, naming them. The lead is ended because, left running, it would
// go on with no repository behind it, and the daemon would never bring it back or end it.
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
  // Find the lead's session name. The lead this machine had before each repository got its
  // own keeps its old name.
  const fullName = `${found.owner}/${found.repo}`;
  const keptLead = z
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
  // Its tab closes first, so an open screen moves on at once. A screen that found the lead
  // gone while its tab was still there would take it for a crash and ask for it back.
  db.run("UPDATE repositories SET tab_closed = 1 WHERE owner = ? AND repo = ?", [
    found.owner,
    found.repo,
  ]);
  // Ended as a thread's builder is, and waited for, as the lead reads the clone removed next.
  await stopSession(tmux, leadPlaces(found.owner, found.repo, keptLead).name);
  // Remove the clone, the row and your trust in it. The other repositories are named again,
  // as one that shared a name with this one can drop its owner.
  rmSync(cloneDir(found.owner, found.repo), { recursive: true, force: true });
  db.run("DELETE FROM repositories WHERE owner = ? AND repo = ?", [found.owner, found.repo]);
  nameRepositories(db);
  const trusted = trustLines().filter((line) => line !== "" && line !== fullName);
  if (existsSync(trustFile()))
    writeFileSync(trustFile(), trusted.map((line) => `${line}\n`).join(""));
  console.log(`Removed ${name} and Skelcrew's clone of it.`);
}
