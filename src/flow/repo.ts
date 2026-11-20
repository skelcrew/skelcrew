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
import { parse, stringify } from "yaml";
import { z } from "zod";
import { refuseCredentials } from "../agents/sandbox.ts";
import { endSession, exitedCleanly, stopSession } from "../agents/sessions.ts";
import {
  agentsAnswered,
  agentsOnDefaultBranch,
  approveAgents,
  askAboutAgents,
  checkoutAgents,
  forgetAgents,
} from "../approved-agents.ts";
import { agentRole, repositoryCommands } from "../config.ts";
import { nameRepositories, openDb, Repository } from "../db.ts";
import { builtInFlowText } from "../flows.ts";
import { originHere, parseRemote } from "../machine/origin.ts";
import { cloneDir, configDir, dataDir } from "../paths.ts";
import { askWhichForge, type Claimed } from "../plugins/ask.ts";
import { setUpPlugin } from "../plugins/install.ts";
import { SetupNeeded } from "../plugins/plugin.ts";
import {
  addRepositoryPlugin,
  githubPlugin,
  installRepositoryPlugins,
  namePlugin,
  repositoryNeeds,
  repositoryPlugins,
} from "../plugins/repository.ts";
import { hostNamed } from "../plugins/runtime.ts";
import { builtInRole } from "../roles.ts";
import { errorText } from "../say.ts";
import { readSettings, type Settings } from "../settings.ts";
import { checkPush, cloneRepository, headCommit, remoteEmpty, updateClone } from "./git.ts";
import { leadOf, leadSession } from "./lead.ts";

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

// Returns the repository a word names, by its name in Skelcrew or its owner/name, each in any
// case, or its remote URL, or none. So a task's name typed in any case, such as APP-12, finds
// its repository. Skelcrew gives repositories names that differ by more than case, but a
// database from before can hold two, such as App and app. A word that names both is refused,
// saying how to name one, so a command never acts on the other's task. sc start asks it first,
// as a repository's name can end like a task's, such as api-v2.
export function repositoryNamed(db: Database, given: string): Repository | undefined {
  const all = repositories(db);
  const named = all.filter((r) => r.name.toLowerCase() === given.toLowerCase());
  if (named.length > 1)
    throw new Error(
      `${given} names more than one repository: ${named.map((r) => `${r.owner}/${r.repo}`).join(", ")}. Name one by its owner/name.`,
    );
  return named[0] ?? all.find((r) => fullNameIs(r, given) || remoteIs(r, given));
}

// Returns the repository a command names, as repositoryNamed reads it. Throws when Skelcrew has
// no such repository, since commands only work on ones it has.
export function findRepository(db: Database, given: string): Repository {
  const found = repositoryNamed(db, given);
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

// The refresh of each repository's clone under way or waiting, by owner/name, so two git
// commands never fight over a clone.
const cloneWork = new Map<string, Promise<void>>();

// Creates or updates Skelcrew's clone of the repository, so its lead reads its latest default
// branch and builders, whose origin it is, fetch it as the remote has it. The poll calls it
// each time, so a merge or a push to the default branch reaches builders within a poll. A
// call while one runs waits for it, then refreshes again, so it always sees what the remote
// had when it was asked. `adding` is for a repository being brought in, which is cloned before
// it is saved. Throws what git said when it fails.
export function refreshClone(db: Database, repository: Repository, adding = false): Promise<void> {
  const { owner, repo } = repository;
  const fullName = `${owner}/${repo}`;
  // sc repo rm can run at any wait before this refresh's git starts, or while it runs, and a
  // clone made after the removal would stay where nothing removes it. So a repository not
  // being brought in is refreshed only while Skelcrew has it, checked when its turn comes and
  // again once git is done.
  const removed = () =>
    !adding && !repositories(db).some((r) => r.owner === owner && r.repo === repo);
  const run = (cloneWork.get(fullName) ?? Promise.resolve()).then(async () => {
    if (removed()) return;
    await createOrUpdate(db, repository);
    if (removed()) rmSync(cloneDir(owner, repo), { recursive: true, force: true });
  });
  // The next call waits for this one whether it fails or not, and the last one leaves no
  // entry behind.
  const settled = run.catch(() => {});
  cloneWork.set(fullName, settled);
  settled.then(() => {
    if (cloneWork.get(fullName) === settled) cloneWork.delete(fullName);
  });
  return run;
}

// The repositories, by owner/name, whose remote had no commits at their last refresh, so the
// log says so once rather than at every poll, and no thread starts on them. A remote emptied
// after Skelcrew cloned it leaves the clone with its old commits, so only this tells.
const empty = new Set<string>();

// Returns whether the repository has no commits yet, so no thread can start from it: as its
// last refresh found it, or for a clone with no commit, as its remote says now. A clone made
// from a remote whose HEAD names a missing branch has no commit either, but isn't empty.
export async function hasNoCommits(db: Database, repository: Repository): Promise<boolean> {
  const { owner, repo } = repository;
  if (empty.has(`${owner}/${repo}`)) return true;
  if ((await headCommit(db, repository, cloneDir(owner, repo))) !== "") return false;
  return remoteEmpty(db, repository);
}

// Creates Skelcrew's clone of the repository, or brings the one it has up to date, logging
// when its default branch moves. The lead reads the clone, so a clone whose config holds a
// credential is deleted rather than left there for it.
async function createOrUpdate(db: Database, repository: Repository): Promise<void> {
  const { owner, repo } = repository;
  // A clone Skelcrew has already is brought up to date in place, and checked again, as the
  // update could have brought a credential in.
  const clone = cloneDir(owner, repo);
  if (existsSync(clone)) {
    const fullName = `${owner}/${repo}`;
    const wasEmpty = empty.has(fullName);
    const { before, after } = await updateClone(db, repository, clone, wasEmpty);
    deleteIfCredentials(clone);
    // An empty repository is logged once, rather than at every poll, until its first commit.
    if (after === "") {
      if (!wasEmpty) console.log(`${fullName} has no commits yet`);
      empty.add(fullName);
      return;
    }
    empty.delete(fullName);
    if (before === "" || wasEmpty)
      console.log(`Skelcrew's clone of ${fullName} has its first commit, ${after.slice(0, 7)}`);
    else if (before !== after)
      console.log(
        `Skelcrew's clone of ${fullName} moved its default branch from ${before.slice(0, 7)} to ${after.slice(0, 7)}`,
      );
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
  // An empty repository is logged now, as its first commit could come before the next refresh.
  // A clone with no commit can also come from a remote whose HEAD names a missing branch, so
  // the remote is asked too.
  if ((await headCommit(db, repository, clone)) === "" && (await remoteEmpty(db, repository))) {
    console.log(`${owner}/${repo} has no commits yet`);
    empty.add(`${owner}/${repo}`);
  }
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
// first. A new repository whose default branch has an .agents/ shows it and asks, even one you can
// push to, as being able to push isn't having read what others wrote there. Runs only in your own
// terminal, where a yes can't come from an injected instruction.
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
  await refreshClone(db, repository, true);
  if (known) return;
  // A repository git can't push to isn't added, and its clone goes: every lead reads the folder
  // of clones, which must hold only the repositories Skelcrew has.
  if (claimed === null)
    await checkPush(db, repository, cloneDir(owner, repo)).catch((error) => {
      rmSync(cloneDir(owner, repo), { recursive: true, force: true });
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
  const added = repositories(db).find((r) => r.owner === owner && r.repo === repo);
  askAboutAgents(repository, added?.name ?? fullName);
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
    // A repository Skelcrew had before it read .agents/, or whose .agents/ you left unanswered,
    // asks about it here, once.
    if (opened && !agentsAnswered(opened)) askAboutAgents(opened, opened.name);
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

// Opens again a repository Skelcrew has, for sc repo add, and says so. A repository whose tab
// you closed by exiting its lead gets its tab back, and its lead starts with its conversation,
// even with no screen open. One you have opened before is opened through the daemon too, whatever
// its tab reads: a lead you exited a moment ago isn't marked yet, and the daemon's next look
// would close the tab after this. The daemon notices the exit first. With no daemon running, a
// lead that exited is ended here, so the daemon's start brings it back instead of closing its
// tab. One never opened stays as it is, as only sc or its tab starts a lead the first time.
async function openAgain(db: Database, sessions: string, had: Repository): Promise<void> {
  const row = db
    .query("SELECT tab_closed, opened FROM repositories WHERE owner = ? AND repo = ?")
    .get(had.owner, had.repo);
  const { tab_closed: closed, opened } = z
    .object({ tab_closed: z.coerce.boolean(), opened: z.number().nullable() })
    .parse(row);
  if (closed || opened !== null) {
    // Imported here, as the client's replies are checked with what sc repo ls lists, which
    // imports this file, and a loop of imports leaves one of them unset as the other loads.
    const { ask } = await import("../client.ts");
    const reply = await ask({ command: "lead", from: `${had.owner}/${had.repo}` }, 60_000);
    if (reply === null) {
      // Only a lead on tmux keeps its session after you exit it.
      const { name, host, hostId } = leadOf(db, had.owner, had.repo);
      const id = hostId ?? name;
      if (host === "tmux" && exitedCleanly(sessions, id)) await endSession(sessions, id);
      db.run("UPDATE repositories SET tab_closed = 0 WHERE owner = ? AND repo = ?", [
        had.owner,
        had.repo,
      ]);
    }
    const failed = z.object({ error: z.string() }).safeParse(reply);
    if (failed.success) console.error(`Skelcrew: ${failed.data.error}`);
  }
  const tab = closed ? " Its tab is open again." : "";
  console.log(`Skelcrew has ${had.owner}/${had.repo} already, as ${had.name}.${tab}`);
}

// Adds a repository for sc repo add: the checkout in the folder given, the repository at a
// remote URL or named by its owner/name on its forge, or with neither, the checkout you are
// in, and says what it did. A folder that is there is taken as one. Asks whether you trust the
// repository when it needs to, so it runs only in your own terminal. One Skelcrew has costs no
// call to a forge, and is opened again. `sessions` names where its lead runs.
export async function addRepo(given: string | undefined, sessions: string): Promise<void> {
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
    await openAgain(db, sessions, had);
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

// The starter skelcrew.yaml: a line saying the file is shared and never holds a secret, and
// setup and test as commented examples, as Skelcrew never guesses them: the lead proposes them. It
// names no tracker, so a repository on GitHub keeps its issues as tasks, and shows tracker: none
// commented out, so you can find how to turn that off. The limit on builders is commented out
// too, as most repositories need none. sc init adds the forge's plugin below.
const starterConfig = [
  "# Shared with everyone who works on this repository. Never put a secret here.",
  "# setup: [bun install]",
  "# test: [bun test]",
  "# Keeps this repository on git alone, with no tracker.",
  "# tracker: none",
  "# At most this many builders at once in this repository.",
  "# limits: { threads: 4 }",
  "",
].join("\n");

// Names the forge's plugin under plugins: in the checkout's skelcrew.yaml and pins it in its
// skelcrew.lock, as sc add does, so every repository has the same standard setup. The forge is
// found from the remote alone: GitHub's plugin for github.com, and none for a host Skelcrew has
// no plugin for. A skelcrew.yaml that names any plugin already chose them, so it is left alone.
// A skelcrew.lock that pins the plugin already keeps its pin, which sc add would move to the
// version installed here: only skelcrew.yaml gains its name, and the plugin is installed at that
// pin as sc install does, after asking, so the repository comes in with its forge. A plugin that
// can't be added, or that you say no to, is only reported, as the rest of sc init still counts. Returns what it
// changed: "named" for skelcrew.yaml alone, "pinned" for both files, or null for neither.
function addForgePlugin(root: string, remote: string): "named" | "pinned" | null {
  if (parseRemote(remote)?.host !== "github.com") return null;
  try {
    const { plugins, lock } = repositoryPlugins(root);
    if (plugins.length > 0) return null;
    if (lock[githubPlugin]) {
      namePlugin(root, githubPlugin);
      installPinned();
      return "named";
    }
    if (addRepositoryPlugin(githubPlugin)) return "pinned";
  } catch (error) {
    // The error says what to do, such as which line to add by hand.
    console.log(`Skelcrew couldn't add ${githubPlugin}: ${errorText(error)}.`);
    return null;
  }
  console.log(`skelcrew.yaml names no forge plugin yet. sc add ${githubPlugin} adds it.`);
  return null;
}

// Installs the forge's plugin at the version the checkout's skelcrew.lock pins, as sc install
// does: a plugin new here, or at another version, is shown and asked about, and one at its pin
// asks nothing. One left out is only reported, naming sc install, as skelcrew.yaml names it now.
function installPinned(): void {
  try {
    installRepositoryPlugins(repositoryNeeds().filter(({ source }) => source === githubPlugin));
  } catch (error) {
    console.log(
      `Skelcrew couldn't install ${githubPlugin}: ${errorText(error)}. sc install installs it.`,
    );
  }
}

// Returns which of setup: and test: nothing sets yet, so the lead will propose them: neither the
// checkout's skelcrew.yaml, which may not be pushed yet, nor what the lead is told, which also
// counts your override for the repository and your own config. A file that can't be read sets
// nothing here, as the lead is told the same.
function missingCommands(root: string, repository: Repository | undefined): string[] {
  let told: Pick<Settings, "setup" | "test"> = { setup: undefined, test: undefined };
  try {
    told = repository ? repositoryCommands(repository) : readSettings(["setup", "test"]);
  } catch {}
  let here: unknown = null;
  try {
    here = parse(readFileSync(join(root, "skelcrew.yaml"), "utf8"));
  } catch {}
  const Commands = z.object({ setup: z.array(z.string()), test: z.array(z.string()) }).partial();
  const checkout = Commands.catch({}).parse(here ?? {});
  return (["setup", "test"] as const)
    .filter((key) => told[key] === undefined && checkout[key] === undefined)
    .map((key) => `${key}:`);
}

// Writes the built-in .agents/ into the checkout at `root`, which has none: the three roles,
// each with your harness and model as its frontmatter, so the repository works the same for a
// teammate, and the default flow. Each file is new, so no write follows a link.
function writeAgents(root: string): void {
  const write = (path: string, text: string) => {
    const file = join(root, ".agents", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { flag: "wx" });
  };
  for (const name of ["lead", "builder", "reviewer"] as const) {
    const lines = Object.entries(agentRole(name)).map(
      ([key, value]) => `${key}: ${yamlValue(value)}`,
    );
    write(`roles/${name}.md`, `---\n${lines.join("\n")}\n---\n${builtInRole(name).instructions}`);
  }
  write("flows/default.yaml", builtInFlowText);
}

// Returns the top folder of the checkout you are in, or null outside one.
export function checkoutTop(): string | null {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return top.success ? top.stdout.toString().trim() : null;
}

// Sets up the checkout you are in for Skelcrew, for sc init, with the standard setup every
// repository shares: writes the starter skelcrew.yaml and the built-in .agents/ at its top,
// leaving either as it is when there, names the forge's plugin and pins it in skelcrew.lock, then
// adds the repository as sc repo add does. Setup and test stay commented examples, which the lead
// proposes before anything else. The .agents/ it writes holds only the built-in defaults, so it is approved
// as written, unless you already answered for the repository's .agents/: that answer stands, so
// sc init on an old branch never swaps the roles new tasks start on. One that was there is shown
// and asked about, as it may differ from the default branch. Stops
// outside a git repository, and in one with no remote, as Skelcrew works from its own clone. That
// clone is at the default branch, so it says the files count only once pushed there. `sessions`
// names where the repository's lead runs.
export async function initRepo(sessions: string): Promise<void> {
  // Stop before writing anything where the files couldn't count: outside a checkout, or in one
  // with no remote for Skelcrew to clone.
  const root = checkoutTop();
  if (root === null)
    throw new Error(
      "sc init runs in a checkout of a git repository, and this folder isn't in one.",
    );
  const remote = originHere(root);
  if (!remote)
    throw new Error(
      "sc init needs the repository's remote, and this checkout has none. Push it somewhere first, such as to GitHub.",
    );
  // A new file is made only where none is, so the write never follows a link.
  const file = join(root, "skelcrew.yaml");
  const hasConfig = lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  if (!hasConfig) writeFileSync(file, starterConfig, { flag: "wx" });
  // The forge's plugin is installed before the repository comes in, so it can claim the remote.
  const forge = addForgePlugin(root, remote);
  if (hasConfig)
    console.log(
      forge === null
        ? "skelcrew.yaml is there already, so Skelcrew left it as it is."
        : `skelcrew.yaml is there already, so Skelcrew only added ${githubPlugin} to its plugins.`,
    );
  const hasAgents = lstatSync(join(root, ".agents"), { throwIfNoEntry: false }) !== undefined;
  if (!hasAgents) writeAgents(root);
  else console.log(".agents/ is there already, so Skelcrew left it as it is.");
  // Bring the repository in. A repository you didn't trust isn't in, and gets no approval.
  const isNew = repositoryAt(openDb(), remote) === undefined;
  await addRepo(root, sessions);
  const added = repositoryAt(openDb(), remote);
  // Skelcrew reads only a folder of .agents/ with files in it. A link or a file at .agents counts
  // as none, so there is nothing to approve.
  // A tracked file whose edits aren't staged has two versions, and git commit takes one while
  // git commit -a takes the other, so Skelcrew can't tell which to show you. It asks you to
  // settle that first rather than approve the wrong one. A file staged and then deleted is such
  // an edit too, so with none, a checkout without .agents/ tracks nothing there, and what sc init
  // wrote is all a commit would hold.
  const unstaged = !Bun.spawnSync(["git", "-C", root, "diff", "--quiet", "--", ".agents"]).success;
  if (added && unstaged)
    console.log(
      ".agents/ has changes you haven't staged, so Skelcrew can't tell which version you'll commit. Stage or drop them, then run sc init again.",
    );
  const current =
    added && !unstaged && lstatSync(join(root, ".agents")).isDirectory()
      ? checkoutAgents(added, root)
      : null;
  if (added && current !== null) {
    if (!hasAgents && !agentsAnswered(added)) approveAgents(added, current);
    else if (!hasAgents)
      console.log(
        `Skelcrew kept the .agents/ you approved for ${added.owner}/${added.repo}. Once you push the new one, run sc repo trust ${added.name} to approve it.`,
      );
    // A repository new to Skelcrew was asked about its default branch's .agents/ as it came in,
    // so the checkout's is asked about only when it differs.
    else if (!isNew || current !== agentsOnDefaultBranch(added))
      askAboutAgents(added, added.name, current);
  }
  // Say what was written or changed and when Skelcrew will read it.
  const wrote = [
    hasConfig && forge === null ? null : "skelcrew.yaml",
    forge === "pinned" ? "skelcrew.lock" : null,
    hasAgents ? null : ".agents/",
  ].filter((name) => name !== null);
  const many = wrote.length > 1;
  if (wrote.length > 0)
    console.log(
      `Wrote ${wrote.slice(0, -1).join(", ")}${many ? " and " : ""}${wrote.at(-1)}. ${many ? "They count" : "It counts"} once you commit and push ${many ? "them" : "it"} to the default branch.`,
    );
  // The lead finishes the standard setup, as only it reads the repository with you.
  const missing = missingCommands(root, added);
  if (missing.length > 0)
    console.log(
      `${missing.join(" and ")} ${missing.length > 1 ? "aren't" : "isn't"} filled in yet. Before anything else, the lead will propose a thread that fills ${missing.length > 1 ? "them" : "it"} in from what the repository's CI runs.`,
    );
}

// Records your trust from outside the sandbox and brings in the repository: one Skelcrew has,
// by its name, or a new one at a remote URL. For one Skelcrew has, it also approves its .agents/,
// once it showed you what changed and you said yes.
export async function trustRepo(given: string): Promise<void> {
  // A name Skelcrew knows needs no forge to find it again. Anything else must be an
  // owner/name or URL a forge or remote can answer for.
  const db = openDb();
  const known = repositories(db).find((r) => r.name === given || fullNameIs(r, given));
  if (!known && !given.includes("/"))
    throw new Error(`there is no repository named ${given}. Name a new one as owner/repo`);
  const details = known
    ? { owner: known.owner, repo: known.repo, remote: known.remote, claimed: null }
    : await identifyRepository(db, given);
  trust(`${details.owner}/${details.repo}`);
  await bringIn(db, details);
  // A repository new to Skelcrew was asked about as it came in. One it had shows what its
  // default branch changed in .agents/ since you approved it, and asks.
  if (known) askAboutAgents(known, known.name);
}

// Removes a repository for sc repo rm. Ends its lead, which runs in `sessions`, then deletes
// Skelcrew's clone, its row, your trust in it and the .agents/ you approved, and names the other repositories again.
// Refuses while the repository has live threads, or tasks in its queue, naming them. The lead is ended because, left running, it would
// go on with no repository behind it, and the daemon would never bring it back or end it.
export async function removeRepo(name: string, sessions: string): Promise<void> {
  const db = openDb();
  const found = repositories(db).find((r) => r.name === name);
  if (!found) throw new Error(`there is no repository named ${name}`);
  // Builders of live threads would keep running with no repository behind them, which
  // breaks polling, sc ps and cleanup after merge. A queued task would start one later.
  const live = db
    .query(
      "SELECT task FROM threads WHERE owner = ? AND repo = ? AND status IN ('queued', 'working', 'waiting') ORDER BY task",
    )
    .all(found.owner, found.repo)
    .map((row) => `${name}-${z.object({ task: z.coerce.string() }).parse(row).task}`);
  if (live.length > 0)
    throw new Error(`${name} has live threads: ${live.join(", ")}. Stop them first.`);
  // A lead on a plugin no longer installed may still run there, using the clone, and removing
  // the repository would forget how to reach it. So it waits until that host is back.
  const fullName = `${found.owner}/${found.repo}`;
  const { host } = leadOf(db, found.owner, found.repo);
  if (hostNamed(db, sessions, host) === null)
    throw new Error(
      `${name}'s lead runs on ${host}, which isn't installed now, so it can't be ended. Install ${host} again, then remove ${name}.`,
    );
  // Its tab closes first, so an open screen moves on at once. A screen that found the lead
  // gone while its tab was still there would take it for a crash and ask for it back. A lead the
  // daemon is starting meanwhile sees the tab closed once its session is there, and ends it.
  const where = "WHERE owner = ? AND repo = ?";
  const tab = z
    .object({ tab_closed: z.number() })
    .parse(db.query(`SELECT tab_closed FROM repositories ${where}`).get(found.owner, found.repo));
  db.run(`UPDATE repositories SET tab_closed = 1 ${where}`, [found.owner, found.repo]);
  try {
    // Then find the lead's session: its host, and its ID there, found by its labels when the
    // daemon stopped before saving it. Looked up only now, so a lead whose start began before
    // the tab closed is found here, on the host it started on, if its start doesn't end it.
    const lead = await leadSession(db, sessions, found.owner, found.repo);
    if (lead === null) throw new Error(`${name}'s lead's host went away while it was removed`);
    // Ended as a thread's builder is, and waited for, as the lead reads the clone removed next.
    await stopSession(lead.host, lead.id);
  } catch (error) {
    // A host that can't be reached leaves the lead and the repository as they were, so its tab
    // goes back as it was too, rather than hiding a repository Skelcrew still has.
    db.run(`UPDATE repositories SET tab_closed = ? ${where}`, [
      tab.tab_closed,
      found.owner,
      found.repo,
    ]);
    throw error;
  }
  // Remove the clone, the row and your trust in it. The other repositories are named again,
  // as one that shared a name with this one can drop its owner.
  rmSync(cloneDir(found.owner, found.repo), { recursive: true, force: true });
  db.run("DELETE FROM repositories WHERE owner = ? AND repo = ?", [found.owner, found.repo]);
  forgetAgents(found);
  nameRepositories(db);
  const trusted = trustLines().filter((line) => line !== "" && line !== fullName);
  if (existsSync(trustFile()))
    writeFileSync(trustFile(), trusted.map((line) => `${line}\n`).join(""));
  console.log(`Removed ${name} and Skelcrew's clone of it.`);
}
