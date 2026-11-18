// git against a repository's remote: cloning, fetching and pushing with its forge's login, or,
// for a repository with no forge, with your own. The daemon runs it, never an agent, and the
// login is handed to git for each command and never saved.
import type { Database } from "bun:sqlite";
import type { Repository } from "../db.ts";
import { forgeOf } from "../plugins/ask.ts";
import { gitCredentials } from "../plugins/plugin.ts";
import { quietly } from "../run.ts";

// Runs git with the repository's login and returns what it printed, throwing what git said
// when it fails. Nobody may be there to type a password, so git fails rather than asks.
async function git(
  db: Database,
  repository: Repository,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  // With no forge, git uses your own login, as it would in your terminal.
  const forge = forgeOf(db, repository);
  const login = forge === null ? [] : gitCredentials(db, forge);
  const { out, err, ok } = await quietly(["git", ...login, ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (!ok) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

// Clones the repository into Skelcrew's chosen folder, away from your checkout.
export async function cloneRepository(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<void> {
  await git(db, repository, ["clone", "--quiet", repository.remote, folder]);
}

// Fetches a ref of the remote, such as HEAD for its default branch, into the folder's
// FETCH_HEAD. Returns false, rather than throwing, when the remote has no refs at all: a
// repository with no commits yet, such as one just created on GitHub. A failed fetch alone
// doesn't prove that, as a remote can have branches while its HEAD names one that is gone, so
// only then is the remote asked what it has.
async function fetchRef(
  db: Database,
  repository: Repository,
  folder: string,
  ref: string,
): Promise<boolean> {
  try {
    await git(db, repository, ["-C", folder, "fetch", "--quiet", repository.remote, ref]);
    return true;
  } catch (error) {
    // Only a ref the remote lacks can mean it is empty. Any other failure, such as a damaged
    // clone, is the fetch's own to report.
    if (!String(error).includes("couldn't find remote ref")) throw error;
    if (await remoteEmpty(db, repository)) return false;
    throw error;
  }
}

// Returns whether the repository's remote has no refs at all, as one with no commits yet. A
// remote that can't be listed isn't taken for empty. The names Skelcrew claims for threads with
// no issue are refs too, made even on an empty remote, but they hold no commit of the
// repository's, so they don't count.
export async function remoteEmpty(db: Database, repository: Repository): Promise<boolean> {
  const listed = await git(db, repository, ["ls-remote", repository.remote]).catch(() => null);
  if (listed === null) return false;
  return listed
    .split("\n")
    .every((line) => line === "" || line.split("\t")[1]?.startsWith(claimRef("")));
}

// Returns the commit the clone in the folder is on, or nothing for a clone of a repository
// with no commits yet, whose HEAD names no commit.
export const headCommit = (db: Database, repository: Repository, folder: string) =>
  git(db, repository, ["-C", folder, "rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "");

// Resets Skelcrew's clone in the folder to the latest default branch, so the lead reads current
// code and builders, whose origin it is, fetch the default branch as the remote has it.
// Returns the commit the clone was on and the one it is on now, so a move can be logged. Both
// are empty while the repository has no commits, which leaves the clone as it is, and the
// first is empty for a clone made before its first commit. `wasEmpty` says the remote had no
// commits at the last update, which a clone that had some before keeps no sign of.
export async function updateClone(
  db: Database,
  repository: Repository,
  folder: string,
  wasEmpty = false,
): Promise<{ before: string; after: string }> {
  // Fetching HEAD follows the default branch even after it is renamed.
  if (!(await fetchRef(db, repository, folder, "HEAD"))) return { before: "", after: "" };
  // Every poll gets here, so both commits are read with one git. Only a clone with no commit
  // of its own makes it fail, and then only the fetched one is read.
  const [before = "", after = ""] = await git(db, repository, [
    "-C",
    folder,
    "rev-parse",
    "HEAD",
    "FETCH_HEAD",
  ]).then(
    (both) => both.split("\n"),
    async () => ["", await git(db, repository, ["-C", folder, "rev-parse", "FETCH_HEAD"])],
  );
  // A clone of an empty repository is on the branch it was on before, which the first push
  // can make another, and threads take the clone's branch as their PR's base. So the clone
  // first moves to the default branch the remote names now.
  if (before === "" || wasEmpty) {
    const said = await git(db, repository, ["ls-remote", "--symref", repository.remote, "HEAD"]);
    const branch = said.match(/^ref: (refs\/heads\/\S+)\tHEAD$/m)?.[1];
    if (branch) await git(db, repository, ["-C", folder, "symbolic-ref", "HEAD", branch]);
  }
  // Every poll gets here, and resetting reads the whole working tree, so it runs only when
  // the default branch moved. A clone with no commit yet takes the first one this way too.
  if (before !== after)
    await git(db, repository, ["-C", folder, "reset", "--quiet", "--hard", "FETCH_HEAD"]);
  return { before, after };
}

// Fetches a branch, or the default branch when none is given, into the folder's FETCH_HEAD,
// for a thread's clone to start from. Fetched by URL, so no remote holding it is saved in the
// folder's .git/config, which agents read. Throws, saying so plainly, for a repository with no
// commits yet, as git's own words wouldn't tell you why.
export async function fetchBranch(
  db: Database,
  repository: Repository,
  folder: string,
  branch: string | null,
): Promise<void> {
  const ref = branch ? `refs/heads/${branch}` : "HEAD";
  if (!(await fetchRef(db, repository, folder, ref))) throw new Error(noCommits(repository));
}

// What Skelcrew says when a thread is started on a repository with no commits yet.
export const noCommits = (repository: Repository) =>
  `${repository.owner}/${repository.repo} has no commits yet, so a thread has nothing to start from. Push a first commit, then start it again.`;

// Brings a branch of the repository into Skelcrew's clone in the folder, as a ref of its own.
// Without `ref`, as the branch itself, so a builder whose clone has Skelcrew's as origin can fetch
// it: never the branch Skelcrew's clone has checked out, which updateClone keeps current.
export async function fetchInto(
  db: Database,
  repository: Repository,
  folder: string,
  branch: string,
  ref = `refs/heads/${branch}`,
): Promise<void> {
  await git(db, repository, [
    "-C",
    folder,
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    repository.remote,
    `+refs/heads/${branch}:${ref}`,
  ]);
}

// Pushes a commit from Skelcrew's clone in the folder to a branch of the repository. Never
// forced, so a push can only add to what the branch already holds.
export async function pushCommit(
  db: Database,
  repository: Repository,
  folder: string,
  sha: string,
  branch: string,
): Promise<void> {
  await git(db, repository, [
    "-C",
    folder,
    "push",
    "--quiet",
    repository.remote,
    `${sha}:refs/heads/${branch}`,
  ]);
}

// Deletes a branch from the repository's remote, for sc rm of a thread with no PR to close.
// Pushed from Skelcrew's clone in the folder, as git push needs a repository to run in, and the
// daemon may have started anywhere.
export async function deleteBranch(
  db: Database,
  repository: Repository,
  folder: string,
  branch: string,
): Promise<void> {
  await git(db, repository, [
    "-C",
    folder,
    "push",
    "--quiet",
    repository.remote,
    `:refs/heads/${branch}`,
  ]);
}

// Returns whether the branch is on the repository's remote, for a thread with no forge, whose
// branch going from the remote ends it.
export async function onRemote(
  db: Database,
  repository: Repository,
  branch: string,
): Promise<boolean> {
  const listed = await git(db, repository, [
    "ls-remote",
    "--heads",
    repository.remote,
    `refs/heads/${branch}`,
  ]);
  return listed !== "";
}

// Where a name Skelcrew gave one of its own tasks is claimed on the remote, such as
// refs/skelcrew/names/wr4. Outside refs/heads, so the forge lists no branch for it.
const claimRef = (name: string) => `refs/skelcrew/names/${name}`;

// Returns the names of Skelcrew's own tasks with the machine's code that any machine claimed on
// the remote, such as wr4. Another machine can have the same code, such as workbox and
// workstation, and only the remote is shared.
export async function claimedNames(
  db: Database,
  repository: Repository,
  code: string,
): Promise<string[]> {
  const listed = await git(db, repository, ["ls-remote", repository.remote, claimRef(`${code}*`)]);
  // Each line is a commit, a tab and the ref. The pattern also matches a longer code that starts
  // with this one, such as wrx4 for wr, so the name must go on with digits alone.
  return listed
    .split("\n")
    .map((line) => line.split("\t")[1]?.slice(claimRef("").length) ?? "")
    .filter((name) => new RegExp(`^${code}\\d+$`).test(name));
}

// Claims a name for one of Skelcrew's own tasks on the remote, from Skelcrew's clone in the
// folder, and returns whether this machine got it. False means another machine claimed it first.
// The claim is never removed, so no machine gives the name to other work later, even once its
// branch is gone.
export async function claimName(
  db: Database,
  repository: Repository,
  folder: string,
  name: string,
): Promise<boolean> {
  // A commit of the claim's own, of no files, so it works in any clone, even one with no commit
  // yet. Were two machines to push the same commit, git would send nothing for the second and
  // call it a success, so the message holds a random ID.
  const who = { GIT_AUTHOR_NAME: "Skelcrew", GIT_AUTHOR_EMAIL: "skelcrew@localhost" };
  const identity = {
    ...who,
    GIT_COMMITTER_NAME: who.GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: who.GIT_AUTHOR_EMAIL,
  };
  const empty = await git(db, repository, [
    "-C",
    folder,
    "hash-object",
    "-w",
    "-t",
    "tree",
    "/dev/null",
  ]);
  const message = `Skelcrew claims ${name}: ${crypto.randomUUID()}`;
  const commit = await git(db, repository, ["-C", folder, "commit-tree", empty, "-m", message], {
    ...process.env,
    ...identity,
  });
  // A lease with nothing after the colon lets the push create the ref only where it doesn't
  // exist yet. The remote checks that as it takes the push, so of two machines claiming one
  // name at once, only one gets it.
  try {
    await git(db, repository, [
      "-C",
      folder,
      "push",
      "--quiet",
      `--force-with-lease=${claimRef(name)}:`,
      repository.remote,
      `${commit}:${claimRef(name)}`,
    ]);
    return true;
  } catch (error) {
    // A refusal only means the name is taken when the claim is there. Otherwise the push failed
    // for another reason, such as the remote being out of reach, which the caller must hear.
    const listed = await git(db, repository, ["ls-remote", repository.remote, claimRef(name)]);
    if (listed === "") throw error;
    return false;
  }
}

// Checks that Skelcrew can push to a repository with no forge on your own git login, as it will
// for a thread: a dry run of a new branch from Skelcrew's clone in the folder. The daemon pushes
// outside your terminal, with no SSH agent, so the check runs without yours. Throws what git
// said when it refuses.
export async function checkPush(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<void> {
  // A clone of a repository with no commits yet has no HEAD to push. A commit of nothing, made
  // only to name in the dry run, stands in, and is never pushed nor put on a branch.
  let head = await headCommit(db, repository, folder);
  if (head === "") {
    const tree = await git(db, repository, ["-C", folder, "mktree"]);
    const who = ["-c", "user.name=Skelcrew", "-c", "user.email=skelcrew@localhost"];
    head = await git(db, repository, [...who, "-C", folder, "commit-tree", "-m", "check", tree]);
  }
  // Leave out your SSH agent, as the daemon won't have it when it pushes for real.
  const { SSH_AUTH_SOCK: _agent, ...env } = process.env;
  await git(
    db,
    repository,
    [
      "-C",
      folder,
      "push",
      "--dry-run",
      "--quiet",
      repository.remote,
      `${head}:refs/heads/skelcrew-check`,
    ],
    env,
  );
}
