// The repositories Skelcrew works on, each from a clone of its own: bringing one in, trusting
// one, keeping the clones current, listing the repositories and removing one.
import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { HarnessName } from "../agents/harness.ts";
import { refuseCredentials } from "../agents/sandbox.ts";
import { endSession, exitedCleanly } from "../agents/sessions.ts";
import {
  agentsAnswered,
  agentsOnDefaultBranch,
  approvedAgents,
  askAboutAgents,
  builtInAgentFiles,
  checkoutAgents,
  forgetAgents,
  holdsBuiltInAgents,
} from "../approved-agents.ts";
import { nameRepositories, openDb, Repository } from "../db.ts";
import { errorText, toRun } from "../format.ts";
import { originHere, parseRemote } from "../machine/origin.ts";
import { cloneDir, configDir, dataDir } from "../paths.ts";
import { askWhichForge, type Claimed } from "../plugins/ask.ts";
import { setUpPlugin } from "../plugins/install.ts";
import { SetupNeeded } from "../plugins/plugin.ts";
import {
  githubPlugin,
  installedReadOnly,
  lockStart,
  namePlugin,
  pinRepositoryPlugin,
  pluginsToInstall,
  repositoryPlugins,
} from "../plugins/repository.ts";
import { hostNamed } from "../plugins/runtime.ts";
import type { RoleName } from "../roles.ts";
import { dropsFolder } from "../screen/drops.ts";
import { refreshBacklog } from "./backlog.ts";
import {
  checkPush,
  cloneRepository,
  fetchBranch,
  headCommit,
  noCommits,
  remoteEmpty,
  updateClone,
} from "./git.ts";
import { closeTabAndEndLead, leadOf } from "./lead.ts";
import { taskName } from "./thread.ts";

// What sc says outside any repository while Skelcrew has none yet, so you know where to run it.
export const noRepositories = "Skelcrew has no repositories yet. Run sc inside a git repository.";

export const noSkelcrewYaml = `This repository has no skelcrew.yaml. Create one with:\n${toRun(["sc init"])}\nThen commit and push it.`;

const lacksPlugins = "This repository's skelcrew.yaml names plugins this machine doesn't have: ";

// Returns whether an error is one of the stops that tell you what to run before sc can open the
// repository, which plain sc shows as steps rather than as a failure.
export function stopsWithSteps(error: unknown): boolean {
  const text = errorText(error);
  return text === noSkelcrewYaml || text.startsWith(lacksPlugins);
}

const hasSkelcrewYaml = ({ owner, repo }: { owner: string; repo: string }) =>
  lstatSync(join(cloneDir(owner, repo), "skelcrew.yaml"), { throwIfNoEntry: false }) !== undefined;

async function requireSkelcrewYaml(db: Database, repository: Repository): Promise<void> {
  const clone = cloneDir(repository.owner, repository.repo);
  if (!existsSync(clone)) await refreshClone(db, repository).catch(() => {});
  const onDefaultBranch = await fetchBranch(db, repository, clone, null).then(
    () => Bun.spawnSync(["git", "-C", clone, "cat-file", "-e", "FETCH_HEAD:skelcrew.yaml"]).success,
    (error) => errorText(error) !== noCommits(repository) && hasSkelcrewYaml(repository),
  );
  if (!onDefaultBranch) throw new Error(noSkelcrewYaml);
  if (!hasSkelcrewYaml(repository)) await refreshClone(db, repository);
}

// Throws, naming them and sc install, when the repository's files in `folder` name plugins this
// machine lacks, so a repository never comes in without its forge.
function requirePlugins(folder: string): void {
  let lacked: { name: string }[];
  try {
    lacked = pluginsToInstall(folder);
  } catch {
    throw new Error(
      "This repository's skelcrew.yaml or skelcrew.lock can't be read. Run sc install to see why, then sc again.",
    );
  }
  if (lacked.length > 0)
    throw new Error(
      `${lacksPlugins}${lacked.map((plugin) => plugin.name).join(", ")}. Install them with:\n${toRun(["sc install"])}\nThen run sc again.`,
    );
}

// Checks the repository plain sc runs for before anything else, so sc says what to run before it
// sets anything up. One Skelcrew has needs a skelcrew.yaml on its default branch. A new one is
// cloned to a temporary folder, with its forge's login when an installed forge claims it, as
// bringing it in would, and also needs the plugins its files name. Returns what Skelcrew found of
// a new one, for bringInFrom, so its forge is asked once. Throws, stopping sc, when it can't tell
// which repository that is, such as when a forge fails or needs a setup no one is there to run.
export async function checkRepository(from: string | undefined): Promise<RepositoryDetails | null> {
  const named = from ?? originHere();
  if (!named) return null;
  const db = openDb();
  const known = repositoryAt(db, named);
  if (known) {
    await requireSkelcrewYaml(db, known);
    return null;
  }
  const details = await identifyRepository(db, named);
  const { owner, repo, remote, claimed } = details;
  const repository = {
    name: `${owner}/${repo}`,
    owner,
    repo,
    forge: claimed?.forge ?? null,
    remote,
  };
  const temporary = mkdtempSync(join(tmpdir(), "skelcrew-check-"));
  try {
    const folder = join(temporary, "repository");
    await cloneRepository(db, repository, folder).catch((error) => {
      throw new Error(
        `Skelcrew couldn't read this repository's default branch, to see its skelcrew.yaml: ${errorText(error)}`,
      );
    });
    if (!lstatSync(join(folder, "skelcrew.yaml"), { throwIfNoEntry: false }))
      throw new Error(noSkelcrewYaml);
    requirePlugins(folder);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return details;
}

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
// when its default branch moves, and brings its backlog up to date from the remote. The lead
// reads the clone, so a clone whose config holds a credential is deleted rather than left there
// for it.
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
    await refreshBacklog(db, repository, clone);
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
  await refreshBacklog(db, repository, clone);
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
export type RepositoryDetails = {
  owner: string;
  repo: string;
  remote: string;
  claimed: Claimed | null;
};

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
  if (had && !remoteIs(had, remote))
    throw new Error(
      `Skelcrew has ${fullName} already, from ${had.remote}. To add the one at ${remote}, remove it first with sc repo rm ${had.name}`,
    );
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
  if (!existsSync(cloneDir(owner, repo)))
    console.log(known ? `Cloning ${fullName} for Skelcrew.` : `Adding ${fullName} to Skelcrew...`);
  await refreshClone(db, repository, true);
  if (!hasSkelcrewYaml(repository)) {
    if (!known) rmSync(cloneDir(owner, repo), { recursive: true, force: true });
    throw new Error(noSkelcrewYaml);
  }
  if (known) return;
  try {
    requirePlugins(cloneDir(owner, repo));
  } catch (error) {
    rmSync(cloneDir(owner, repo), { recursive: true, force: true });
    throw error;
  }
  if (claimed === null)
    await checkPush(db, repository, cloneDir(owner, repo)).catch((error) => {
      rmSync(cloneDir(owner, repo), { recursive: true, force: true });
      throw new Error(
        `${fullName} has no forge, so Skelcrew pushes threads' branches on your own git login, and git refused: ${errorText(error)}. Give the daemon a login it can use without you, such as a key with no passphrase or a credential helper, then run this again.`,
      );
    });
  db.run(
    "INSERT INTO repositories (owner, repo, name, forge, remote, author, claimed) VALUES (?, ?, ?, ?, ?, ?, 1)",
    [owner, repo, fullName, repository.forge, remote, authorOf(claimed)],
  );
  nameRepositories(db);
  await renameBuilders();
  const added = repositories(db).find((r) => r.owner === owner && r.repo === repo);
  askAboutAgents(repository, added?.name ?? fullName);
}

// Brings in the repository you ran sc from, so its lead can open. `from` is a checkout's
// remote URL or a repository's owner/name on its forge. Without it, the checkout you are in is
// used. `details` are what checkRepository found of a new one. A failure is printed rather than
// thrown, so sc still attaches. Returns the repository's owner/repo once Skelcrew has it, so sc opens its lead. A repository you didn't trust isn't
// in, so nothing is returned for it. A repository Skelcrew has already costs no call to a
// forge. A folder with no remote gets no complaint. Throws the lines that stop sc, which start
// with "This repository": one with no skelcrew.yaml on its default branch, or whose files name
// plugins this machine lacks. checkRepository has checked both, so these come only when the
// default branch changed in between.
export async function bringInFrom(
  from: string | undefined,
  details: RepositoryDetails | null,
): Promise<string | undefined> {
  const db = openDb();
  const named = from ?? originHere();
  let opened = named ? repositoryAt(db, named) : undefined;
  try {
    if (opened && !agentsAnswered(opened)) askAboutAgents(opened, opened.name);
    if (named && !opened && details) {
      await bringIn(db, details);
      opened = repositories(db).find((r) => r.owner === details.owner && r.repo === details.repo);
      if (opened && oldRemoteOf(named, opened))
        db.run("UPDATE repositories SET old_remote = ? WHERE owner = ? AND repo = ?", [
          remoteKey(named),
          opened.owner,
          opened.repo,
        ]);
    }
  } catch (error) {
    if (errorText(error).startsWith("This repository")) throw error;
    console.error(`Skelcrew: ${errorText(error)}`);
  }
  if (repositories(db).length === 0) console.log(noRepositories);
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

// Asks the daemon to rename each running builder on a plugin's host by its title as it is now, as
// adding or removing a repository can give another's name its owner or take it away. The daemon
// does it, so a host that fails says so in the daemon's log, not here among sc repo's output. The
// daemon answers before renaming, so a slow host never holds sc repo up. With no daemon running,
// nothing is renamed now, and the daemon renames them all as it starts.
async function renameBuilders(): Promise<void> {
  // Imported here, as the client's replies are checked with what sc repo ls lists, which
  // imports this file, and a loop of imports leaves one of them unset as the other loads.
  const { ask } = await import("../client.ts");
  await ask({ command: "rename builders" }, 5_000);
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
// in. A folder that is there is taken as one. Asks whether you trust the repository when it needs
// to, so it runs only in your own terminal. One Skelcrew has costs no call to a forge, and is
// opened again. `sessions` names where its lead runs. Returns the repository when this call added
// it, so sc repo add can say under which name.
export async function addRepo(
  given: string | undefined,
  sessions: string,
): Promise<Repository | undefined> {
  const db = openDb();
  const folder = given === undefined || existsSync(given) ? resolve(given ?? ".") : null;
  const url = folder === null ? given : originHere(folder);
  if (folder !== null && !url)
    throw new Error(
      `${folder} isn't a checkout with a remote. Run sc repo add in one, or give the repository's URL.`,
    );
  if (!url || url.startsWith("-"))
    throw new Error(`${given} is neither a folder nor a repository's URL`);
  const had = repositoryAt(db, url);
  if (had) {
    await requireSkelcrewYaml(db, had);
    await openAgain(db, sessions, had);
    return undefined;
  }
  const details = await identifyRepository(db, url);
  await bringIn(db, details);
  return repositories(db).find((r) => r.owner === details.owner && r.repo === details.repo);
}

// The lines sc init writes for setup and test, which it leaves to the lead, as the lead reads the
// repository and proposes them. A bare line is not decided yet, distinct from [] for none.
const unsetCommands = [
  "# Not decided yet: the lead reads the repository and proposes them. [] means none.",
  "setup:",
  "test:",
];

// The line sc init writes for the thread limit, with what it limits and that it is yours to change.
const threadsLine = [
  "# At most this many builders at once in this repository. Change it to suit your machine and CI.",
  "limits: {threads: 3}",
];

async function newSkelcrewYaml(): Promise<string> {
  const { chooseCrew } = await import("../machine/crew.ts");
  const roles = chooseCrew(["lead", "builder", "reviewer"]);
  return [
    "# Shared with everyone who works on this repository. Never put a secret here.",
    ...unsetCommands,
    ...threadsLine,
    "# Keeps this repository on git alone, with no tracker.",
    "# tracker: none",
    "# A role can take a model: line, such as model: <name>. Without one, your config's model or the harness's default runs.",
    stringify({ roles }),
  ].join("\n");
}

async function completeSkelcrewYaml(root: string): Promise<string[]> {
  const isMapping = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const read: unknown = parse(readFileSync(join(root, "skelcrew.yaml"), "utf8"));
  const data = isMapping(read) ? read : {};
  const roles = isMapping(data.roles) ? data.roles : {};
  const limits = isMapping(data.limits) ? data.limits : {};
  const harnessOf = (name: RoleName) => {
    const [line, old] = [roles[name], data[name]];
    const found =
      isMapping(line) && line.harness ? line.harness : isMapping(old) ? old.harness : undefined;
    return HarnessName.safeParse(found).data;
  };
  const missingRoles = (["lead", "builder", "reviewer"] as const).filter(
    (name) => !harnessOf(name),
  );
  const missingCommands = (["setup", "test"] as const).filter((key) => !(key in data));
  const missingThreads = limits.threads === undefined || limits.threads === null;
  const lacked = [
    ...missingCommands.map((key) => `${key}:`),
    ...(missingThreads ? ["limits: { threads }"] : []),
    ...missingRoles.map((name) => `the ${name}'s harness`),
  ];
  if (lacked.length === 0) return [];
  console.log(`skelcrew.yaml has no ${lacked.join(", ")}, which every repository needs.`);
  const { chooseCrew } = await import("../machine/crew.ts");
  const asked = missingRoles.length > 0 ? chooseCrew([...missingRoles]) : {};
  const { setSkelcrewLine } = await import("../plugins/repository.ts");
  const set = (key: string, value: unknown) => {
    try {
      setSkelcrewLine(root, key, value);
    } catch (error) {
      console.log(`Skelcrew couldn't add ${key}: ${errorText(error)}.`);
    }
  };
  for (const key of missingCommands) set(key, null);
  if (missingThreads) set("limits", { ...limits, threads: 3 });
  if (missingRoles.length > 0) {
    const merged = Object.fromEntries(
      Object.entries({ ...roles, ...asked }).map(([name, role]) => [
        name,
        isMapping(roles[name]) ? { ...roles[name], ...(isMapping(role) ? role : {}) } : role,
      ]),
    );
    set("roles", merged);
  }
  return lacked;
}

function gitHubToAdd(root: string, remote: string): { owner: string; repo: string } | null {
  const found = parseRemote(remote);
  if (found?.host !== "github.com") return null;
  try {
    return repositoryPlugins(root).plugins.length === 0 ? found : null;
  } catch {
    return null;
  }
}

function addForgePlugin(root: string, remote: string): "named" | "pinned" | null {
  if (parseRemote(remote)?.host !== "github.com") return null;
  try {
    const { plugins, lock } = repositoryPlugins(root);
    if (plugins.length > 0) return null;
    if (lock[githubPlugin]) {
      namePlugin(root, githubPlugin);
      return "named";
    }
    pinRepositoryPlugin(root, githubPlugin);
    return "pinned";
  } catch (error) {
    console.log(`Skelcrew couldn't add ${githubPlugin}: ${errorText(error)}.`);
    return null;
  }
}

// Writes the built-in .agents/ into the checkout at `root`, which has none: the three roles and
// the default flow, as Skelcrew ships them. They name no harness or model, so each machine's own
// settings choose, and they are the same files on every machine. Each file is new, so no write
// follows a link.
function writeAgents(root: string): void {
  for (const [path, text] of builtInAgentFiles()) {
    const file = join(root, ".agents", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { flag: "wx" });
  }
}

// Returns the top folder of the checkout you are in, or null outside one.
export function checkoutTop(): string | null {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return top.success ? top.stdout.toString().trim() : null;
}

export async function initRepo(): Promise<void> {
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
  const file = join(root, "skelcrew.yaml");
  const hasConfig = lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  const github = gitHubToAdd(root, remote);
  if (github)
    console.log(`Found GitHub at ${github.owner}/${github.repo} (origin)\nAdding GitHub plugin...`);
  if (!hasConfig) writeFileSync(file, await newSkelcrewYaml(), { flag: "wx" });
  const completed = hasConfig ? await completeSkelcrewYaml(root) : [];
  const forge = addForgePlugin(root, remote);
  const lock = join(root, "skelcrew.lock");
  const newLock = lstatSync(lock, { throwIfNoEntry: false }) === undefined;
  if (newLock) writeFileSync(lock, lockStart, { flag: "wx" });
  if (hasConfig && completed.length === 0)
    console.log(
      forge === null
        ? "skelcrew.yaml is there already, so Skelcrew left it as it is."
        : `skelcrew.yaml is there already, so Skelcrew only added ${githubPlugin} to its plugins.`,
    );
  const hasAgents = lstatSync(join(root, ".agents"), { throwIfNoEntry: false }) !== undefined;
  if (!hasAgents) writeAgents(root);
  else console.log(".agents/ is there already, so Skelcrew left it as it is.");
  const wrote = [
    hasConfig && forge === null && completed.length === 0 ? null : "skelcrew.yaml",
    forge === "pinned" || newLock ? "skelcrew.lock" : null,
    hasAgents ? null : ".agents/",
  ].filter((name) => name !== null);
  if (wrote.length > 0) {
    const { offerCommit } = await import("../machine/init-commit.ts");
    await offerCommit(root, remote, wrote);
  }
  console.log(
    allInstalled(root)
      ? "\nRun sc and tell your lead what to build."
      : "\nNext, install the plugins it names:\n\n  sc install\n\nThen run sc and tell your lead what to build.",
  );
}

function allInstalled(root: string): boolean {
  try {
    return pluginsToInstall(root, installedReadOnly()).length === 0;
  } catch {
    return false;
  }
}

export function approveCheckout(): void {
  const root = checkoutTop();
  if (
    root === null ||
    lstatSync(join(root, "skelcrew.yaml"), { throwIfNoEntry: false }) === undefined
  )
    return;
  const remote = originHere(root);
  if (!remote) {
    console.log(
      "This checkout has no remote, so Skelcrew didn't add it. Push it somewhere, such as to GitHub, then run sc again.",
    );
    return;
  }
  const added = repositoryAt(openDb(), remote);
  if (!added || !lstatSync(join(root, ".agents"), { throwIfNoEntry: false })?.isDirectory()) return;
  if (!Bun.spawnSync(["git", "-C", root, "diff", "--quiet", "--", ".agents"]).success) {
    console.log(
      ".agents/ has changes you haven't staged, so Skelcrew can't tell which version you'll commit. Stage or drop them, then run sc again.",
    );
    return;
  }
  const current = checkoutAgents(added, root);
  if (current === null || current === approvedAgents(added)) return;
  if (agentsAnswered(added) && current === agentsOnDefaultBranch(added)) return;
  if (agentsAnswered(added) && holdsBuiltInAgents(added, current))
    console.log(
      `Skelcrew kept the .agents/ you approved for ${added.owner}/${added.repo}. Once you push the new one, run sc repo trust ${added.name} to approve it.`,
    );
  else askAboutAgents(added, added.name, current);
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

// Closes a repository's tab, for the screen's close key: its lead ends, and stays ended until
// you open the repository again, which resumes its conversation. Its threads, clone and record
// stay. The tab is marked closed before the lead ends, whatever host it runs on, so a host that
// brings back a lead that exited, as herdr does, never brings this one back. `fullName` is its
// owner/name, which never changes, unlike its name in Skelcrew. Returns what to say.
export async function closeRepo(fullName: string, sessions: string): Promise<string> {
  const db = openDb();
  const found = repositories(db).find((r) => fullNameIs(r, fullName));
  if (!found) throw new Error(`Skelcrew no longer has ${fullName}`);
  await closeThroughDaemon(db, sessions, found, "close");
  return `Closed ${found.name}'s tab. Its tasks keep running.`;
}

export async function removeRepo(given: string, sessions: string): Promise<string> {
  const db = openDb();
  const found =
    repositories(db).find((r) => fullNameIs(r, given)) ??
    repositories(db).find((r) => r.name === given);
  if (!found) throw new Error(`there is no repository named ${given}`);
  const { name } = found;
  const live = db
    .query(
      "SELECT task FROM threads WHERE owner = ? AND repo = ? AND status IN ('queued', 'working', 'waiting') ORDER BY length(task), task",
    )
    .all(found.owner, found.repo)
    .map((row) => taskName(name, z.object({ task: z.coerce.string() }).parse(row).task));
  if (live.length > 0)
    throw new Error(`${name} has live threads: ${live.join(", ")}. Stop them first.`);
  const fullName = `${found.owner}/${found.repo}`;
  const { folder } = leadOf(db, found.owner, found.repo);
  await closeThroughDaemon(db, sessions, found, "remove");
  const aside = `.removing-${Date.now()}`;
  const moved: string[] = [];
  db.run("BEGIN IMMEDIATE");
  try {
    const removed = db.run(
      "DELETE FROM repositories WHERE owner = ? AND repo = ? AND tab_closed = 1",
      [found.owner, found.repo],
    );
    if (removed.changes === 0)
      throw new Error(`${name} was opened again meanwhile, so it isn't removed`);
    for (const place of [cloneDir(found.owner, found.repo), join(folder, dropsFolder)]) {
      if (!existsSync(place)) continue;
      renameSync(place, `${place}${aside}`);
      moved.push(place);
    }
    db.run("COMMIT");
  } catch (error) {
    try {
      for (const place of moved) renameSync(`${place}${aside}`, place);
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
    throw error;
  }
  forgetAgents(found);
  nameRepositories(db);
  await renameBuilders();
  const trusted = trustLines().filter((line) => line !== "" && line !== fullName);
  if (existsSync(trustFile()))
    writeFileSync(trustFile(), trusted.map((line) => `${line}\n`).join(""));
  const left = moved.filter((place) => {
    try {
      rmSync(`${place}${aside}`, { recursive: true, force: true });
      return false;
    } catch {
      return true;
    }
  });
  if (left.length > 0)
    return `Removed ${name}, but Skelcrew couldn't delete ${left.map((place) => `${place}${aside}`).join(" and ")}. Delete it yourself.`;
  return `Removed ${name} and Skelcrew's clone of it.`;
}

// How long to wait for the daemon to end a lead, in milliseconds. Tests set
// SKELCREW_END_LEAD_WAIT_MS shorter, so they don't each wait a minute.
const endLeadWait = z.coerce
  .number()
  .min(0)
  .catch(60_000)
  .parse(process.env.SKELCREW_END_LEAD_WAIT_MS ?? 60_000);

// Has the daemon close a repository's tab and end its lead, and waits for it, for closing and
// removing a repository, which `verb` names for what it says when it fails. The daemon ends the
// lead in the lead's own turn, so a start asked for meanwhile comes after it, and puts the tab back
// when the lead can't be ended, rather than hiding a repository whose lead still runs. With no
// daemon, nothing else starts the lead, so this does all that itself. A daemon that took the
// request but gave no reply may still be at it, so this changes nothing and throws, as acting here
// too could end a lead opened again meanwhile. A repository you open again before its lead ends
// keeps its lead, and this throws too. A lead on a plugin no longer installed may still run there,
// so the repository waits until that host is back.
async function closeThroughDaemon(
  db: Database,
  sessions: string,
  found: Repository,
  verb: "close" | "remove",
): Promise<void> {
  const { name } = found;
  const { host } = leadOf(db, found.owner, found.repo);
  if (hostNamed(db, sessions, host) === null)
    throw new Error(
      `${name}'s lead runs on ${host}, which isn't installed now, so it can't be ended. Install ${host} again, then ${verb} ${name}.`,
    );
  const { askInTime } = await import("../client.ts");
  const fullName = `${found.owner}/${found.repo}`;
  const reply = await askInTime({ command: "end lead", repo: fullName, verb }, endLeadWait);
  if (reply === "unanswered")
    throw new Error(
      verb === "close"
        ? `the daemon didn't answer, so ${name}'s lead may still run. If its tab is still open, close it again.`
        : `the daemon didn't answer, so ${name} isn't removed. Remove it again in a moment.`,
    );
  const Reply = z.union([z.object({ ended: z.boolean() }), z.object({ error: z.string() })]);
  const read = reply === "absent" ? null : Reply.safeParse(reply.reply);
  if (read !== null && !read.success)
    throw new Error("the daemon answered in a way this Skelcrew doesn't understand");
  const answer = read === null ? null : read.data;
  if (answer !== null && "error" in answer) throw new Error(answer.error);
  const ended = answer?.ended ?? (await closeTabAndEndLead(db, sessions, found, verb));
  if (!ended) throw new Error(`${name} was opened again meanwhile, so it isn't ${verb}d`);
}
