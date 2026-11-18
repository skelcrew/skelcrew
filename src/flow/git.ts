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

// Fetches the remote's default branch into the folder's FETCH_HEAD. Fetching HEAD follows the
// default branch even after it is renamed. Returns false, rather than throwing, for a
// repository with no commits yet, such as one just created on GitHub: it has no HEAD to fetch.
async function fetchDefaultBranch(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<boolean> {
  try {
    await git(db, repository, ["-C", folder, "fetch", "--quiet", repository.remote, "HEAD"]);
    return true;
  } catch (error) {
    if (String(error).includes("couldn't find remote ref HEAD")) return false;
    throw error;
  }
}

// Resets Skelcrew's clone in the folder to the latest default branch, so the lead reads current
// code and builders, whose origin it is, fetch the default branch as the remote has it.
// Returns the commit the clone was on and the one it is on now, so a move can be logged. Either
// is empty while there is no commit: the clone's before its first, the remote's while the
// repository has none, which leaves the clone as it is.
export async function updateClone(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<{ before: string; after: string }> {
  // A clone made from an empty repository has no commit for HEAD to name, so it reads as none.
  const before = await git(db, repository, [
    "-C",
    folder,
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD",
  ]).catch(() => "");
  if (!(await fetchDefaultBranch(db, repository, folder))) return { before, after: "" };
  const after = await git(db, repository, ["-C", folder, "rev-parse", "FETCH_HEAD"]);
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
  if (branch) {
    const ref = `refs/heads/${branch}`;
    await git(db, repository, ["-C", folder, "fetch", "--quiet", repository.remote, ref]);
  } else if (!(await fetchDefaultBranch(db, repository, folder)))
    throw new Error(
      `${repository.owner}/${repository.repo} has no commits yet, so a thread has nothing to start from. Push a first commit, then start it again.`,
    );
}

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

// Checks that Skelcrew can push to a repository with no forge on your own git login, as it will
// for a thread: a dry run of a new branch from Skelcrew's clone in the folder. The daemon pushes
// outside your terminal, with no SSH agent, so the check runs without yours. Throws what git
// said when it refuses.
export async function checkPush(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<void> {
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
      "HEAD:refs/heads/skelcrew-check",
    ],
    env,
  );
}
