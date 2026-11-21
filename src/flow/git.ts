// git against a repository's remote: cloning, fetching and pushing with its forge's login, or,
// for a repository with no forge, with your own. The daemon runs it, never an agent, and the
// login is handed to git for each command and never saved.
import type { Database } from "bun:sqlite";
import type { Repository } from "../db.ts";
import { forgeOf } from "../plugins/ask.ts";
import { gitCredentials } from "../plugins/plugin.ts";
import { quietly } from "../run.ts";

// The settings that keep git from starting its maintenance in the background, as a fetch or a
// commit otherwise may. Maintenance holds lock files in the clone a while, and another clone or
// fetch copying the clone's files then fails on one that vanished. `maintenance.auto` stops it
// in today's git, `gc.auto` in git older than 2.29.
export const noMaintenance = ["-c", "maintenance.auto=false", "-c", "gc.auto=0"];

// Runs git with the repository's login and returns what it printed, throwing what git said
// when it fails. Nobody may be there to type a password, so git fails rather than asks. `input`
// is what git reads on stdin, such as a long commit message, which an argument can't hold.
async function git(
  db: Database,
  repository: Repository,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  input?: string,
): Promise<string> {
  // With no forge, git uses your own login, as it would in your terminal.
  const forge = forgeOf(db, repository);
  const login = forge === null ? [] : gitCredentials(db, forge);
  const { out, err, ok } = await quietly(["git", ...noMaintenance, ...login, ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    ...(input === undefined ? {} : { stdin: new Blob([input]) }),
  });
  if (!ok) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

// Clones the repository into Skelcrew's chosen folder, away from your checkout. The clone keeps
// maintenance off in its own settings, so git that anyone else runs there, such as the lead,
// never starts it in the background either.
export async function cloneRepository(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<void> {
  await git(db, repository, ["clone", "--quiet", ...noMaintenance, repository.remote, folder]);
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
// no issue, and its last claim, are refs too, made even on an empty remote, but they hold no
// commit of the repository's, so they don't count. Nor do the tasks filed in its backlog.
export async function remoteEmpty(db: Database, repository: Repository): Promise<boolean> {
  const listed = await git(db, repository, ["ls-remote", repository.remote]).catch(() => null);
  if (listed === null) return false;
  return listed
    .split("\n")
    .every((line) => line === "" || line.split("\t")[1]?.startsWith("refs/skelcrew/"));
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

// Brings one commit of the repository into Skelcrew's clone in the folder, as a ref of its own,
// by its hash rather than a branch. A PR from a fork has its branch only on the fork, but its
// head is still reachable on the repository's remote, such as through GitHub's pull refs, which
// a fetch by hash reaches. Only a full hash is asked for, as it comes from the forge.
export async function fetchCommit(
  db: Database,
  repository: Repository,
  folder: string,
  commit: string,
  ref: string,
): Promise<void> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error(`${commit} isn't a commit`);
  await git(db, repository, [
    "-C",
    folder,
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    repository.remote,
    `+${commit}:${ref}`,
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
// refs/skelcrew/names/t104. Outside refs/heads, so the forge lists no branch for it.
const claimRef = (name: string) => `refs/skelcrew/names/${name}`;

// The ref every claim moves, in the same push, so claims reach the remote in order: a machine
// that read the claims before another's claim landed finds this ref moved, and reads again. It
// sits beside the claims, so it counts as one where they do, such as for an empty remote, and
// "last" is no task's name.
const lastClaimRef = claimRef("last");

// Where a machine claims a name its tasks had from before Skelcrew claimed names, such as
// refs/skelcrew/old-names/t25. Apart from the new names' claims, so every machine can tell that
// the repository has old names, and number its new ones above all of them.
const oldClaimRef = (name: string) => `refs/skelcrew/old-names/${name}`;

// What the remote holds of Skelcrew's own tasks' names: the names any machine claimed, such as
// t104, those claimed as old names, such as t25, and the commit of the last claim, or "" before
// any claim moved it. Only the remote is shared between machines, so it is what keeps their names
// apart.
export type Claims = { names: string[]; old: string[]; last: string };

// Returns the names claimed on the remote and its last claim, as Claims says.
export async function claimedNames(db: Database, repository: Repository): Promise<Claims> {
  const listed = await git(db, repository, [
    "ls-remote",
    repository.remote,
    claimRef("t*"),
    oldClaimRef("t*"),
    lastClaimRef,
  ]);
  // Each line is a commit, a tab and the ref.
  const lines = listed.split("\n").map((line) => line.split("\t"));
  const last = lines.find(([, ref]) => ref === lastClaimRef)?.[0] ?? "";
  // Claims from when names began with a machine's code, such as wr4, don't match the pattern,
  // and a name must go on with digits alone after the t.
  const under = (prefix: string) =>
    lines
      .filter(([, ref]) => ref?.startsWith(prefix))
      .map(([, ref]) => ref?.slice(prefix.length) ?? "")
      .filter((name) => /^t\d+$/.test(name));
  return { names: under(claimRef("")), old: under(oldClaimRef("")), last };
}

// Where a task filed in Skelcrew's backlog is kept on the remote, such as
// refs/skelcrew/tasks/t104, until it starts or is removed, and where it is kept while a machine
// starts it, such as refs/skelcrew/started/t104. Outside refs/heads, so the forge lists no branch
// for either, and every machine's daemon reads both.
export const filedRef = (name: string) => `refs/skelcrew/tasks/${name}`;
export const startedRef = (name: string) => `refs/skelcrew/started/${name}`;

// Makes a commit of no files in Skelcrew's clone in the folder, with the message given, and
// returns it. It works in any clone, even one with no commit yet. Were two machines to push the
// same commit, git would send nothing for the second and call it a success, so the caller puts a
// random ID in the message.
export async function makeCommit(
  db: Database,
  repository: Repository,
  folder: string,
  message: string,
): Promise<string> {
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
  // The message comes on stdin, as a task's description can be longer than the system lets one
  // argument be.
  return git(
    db,
    repository,
    ["-C", folder, "commit-tree", empty],
    { ...process.env, ...identity },
    message,
  );
}

// Moves refs on the remote in one atomic push from Skelcrew's clone in the folder: each from the
// commit it must still be at, `was`, to `now`. An empty `was` means it must not exist yet, and an
// empty `now` deletes it. The remote checks each lease as it takes the push, so of two machines
// moving the same ref at once, only the first moves any. Throws what git said when it refuses.
export async function moveRefs(
  db: Database,
  repository: Repository,
  folder: string,
  moves: { ref: string; was: string; now: string }[],
): Promise<void> {
  await git(db, repository, [
    "-C",
    folder,
    "push",
    "--quiet",
    "--atomic",
    ...moves.map(({ ref, was }) => `--force-with-lease=${ref}:${was}`),
    repository.remote,
    ...moves.map(({ ref, now }) => `${now}:${ref}`),
  ]);
}

// Returns the commit a name's claim is at on the repository's remote, or "" when it has none.
// Throws when the remote can't be asked.
export const claimedAt = (db: Database, repository: Repository, name: string) =>
  remoteRef(db, repository, claimRef(name));

// Returns the commit a ref is at on the repository's remote, or "" when it has no such ref.
// Throws when the remote can't be asked.
export async function remoteRef(db: Database, repository: Repository, ref: string) {
  const listed = await git(db, repository, ["ls-remote", repository.remote, ref]);
  return (
    listed
      .split("\n")
      .find((line) => line.endsWith(`\t${ref}`))
      ?.split("\t")[0] ?? ""
  );
}

// Claims a name for one of Skelcrew's own tasks on the remote, from Skelcrew's clone in the
// folder, and returns whether this machine got it. `last` is the last claim as claimedNames read
// it. False means another machine claimed this name, or any name, since then: the caller reads
// the claims again and picks a number above them. So two machines never take one name, and a
// name is never below one claimed before it. The claim is never removed, so no machine gives
// the name to other work later, even once its branch is gone. `noting` hears the claim's commit
// just before the push, so a caller can keep it in case the push's outcome is never heard. `filed`
// is a task to keep in the backlog under the name, as text. It goes in a commit of its own, which only its ref holds, so
// removing the task leaves its words on no ref. The same push files it, so a task is never filed
// without its name, nor a name claimed without its task. With `old`, the name is one from before
// Skelcrew claimed names, and is claimed as such.
export async function claimName(
  db: Database,
  repository: Repository,
  folder: string,
  name: string,
  last: string,
  filed?: string,
  noting?: (commit: string) => void,
  old = false,
): Promise<boolean> {
  const ref = old ? oldClaimRef(name) : claimRef(name);
  const commit = await makeCommit(
    db,
    repository,
    folder,
    `Skelcrew claims ${name}: ${crypto.randomUUID()}`,
  );
  // The claim only where it doesn't exist yet, and the last claim only where it is still the one
  // read. Of two machines claiming at once, only the first gets either.
  const moves = [
    { ref, was: "", now: commit },
    { ref: lastClaimRef, was: last, now: commit },
  ];
  if (filed !== undefined) {
    const message = `Skelcrew files ${name}: ${crypto.randomUUID()}\n\n${filed}`;
    const task = await makeCommit(db, repository, folder, message);
    moves.push({ ref: filedRef(name), was: "", now: task });
  }
  noting?.(commit);
  try {
    await moveRefs(db, repository, folder, moves);
    return true;
  } catch (error) {
    // A push can reach the remote and fail only on its way back. A claim at this attempt's own
    // commit is this machine's, so it counts, and the task isn't filed again under another name.
    // A remote that can't say leaves the outcome unknown, which the caller must hear as the
    // failure it is: taking the claim for another machine's would file the task twice.
    const holds = await remoteRef(db, repository, ref).catch(() => null);
    if (holds === null) throw error;
    if (holds === commit) return true;
    // A refusal only means another machine claimed first when the claim is there or the last
    // claim moved. Otherwise the push failed for another reason, such as the remote being out of
    // reach, which the caller must hear.
    const now = await claimedNames(db, repository);
    if (now.last === last && !(old ? now.old : now.names).includes(name)) throw error;
    return false;
  }
}

// A task of the backlog as the remote keeps it, filed or being started: its name, such as t104,
// the commit that holds it, and its text, which follows the commit message's first line.
export type Kept = { name: string; commit: string; text: string };

// Brings the repository's backlog on the remote into Skelcrew's clone in the folder, and returns
// the tasks filed and those a machine is starting. A ref gone from the remote goes from the clone
// too.
export async function fetchBacklog(
  db: Database,
  repository: Repository,
  folder: string,
): Promise<{ filed: Kept[]; started: Kept[] }> {
  await git(db, repository, [
    "-C",
    folder,
    "fetch",
    "--quiet",
    "--prune",
    "--no-tags",
    // Each poll's update of the clone reads FETCH_HEAD for the default branch, which this fetch
    // could otherwise overwrite while one runs.
    "--no-write-fetch-head",
    repository.remote,
    `+${filedRef("*")}:${filedRef("*")}`,
    `+${startedRef("*")}:${startedRef("*")}`,
  ]);
  // Returns the tasks under one of the two. One git reads them all. Each ends with a NUL, and
  // its fields are apart by one, as the text, written by any machine, could hold any other
  // character.
  const read = async (prefix: string): Promise<Kept[]> => {
    const listed = await git(db, repository, [
      "-C",
      folder,
      "for-each-ref",
      "--format=%(refname:lstrip=3)%00%(objectname)%00%(contents)%00",
      prefix,
    ]);
    const fields = listed.split("\0");
    const kept: Kept[] = [];
    for (let at = 0; at + 2 < fields.length; at += 3) {
      const [name = "", commit = "", contents = ""] = fields.slice(at, at + 3);
      kept.push({ name: name.trim(), commit, text: contents.split("\n\n").slice(1).join("\n\n") });
    }
    return kept;
  };
  return { filed: await read(filedRef("")), started: await read(startedRef("")) };
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
