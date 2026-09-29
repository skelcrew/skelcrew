// The built-in version-control plugin, on git worktrees. Each task's build
// gets its own worktree and branch, so agents never share a checkout.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { $ } from "bun";
import { CommitSha } from "../../core/ids";
import type { BranchFacts, Worktree } from "../../core/types";
import type {
  Done,
  MergeRequest,
  RunChecks,
  VersionControl,
  WorktreeRequest,
} from "../version-control";

// Worktrees sit inside the repository, where you can find them. The folder
// is listed in the repository's local ignore file, so they never show up
// as changes in your own checkout.
const worktreesFolder = ".skelcrew/worktrees";
// A merge is built in a worktree of its own here, never in yours.
const mergingFolder = ".skelcrew/merging";

export class Git implements VersionControl {
  // git runs inside the repository, so a relative path would be read from
  // there and end up doubled. It is made absolute once, here.
  readonly repo: string;

  constructor(
    repo: string,
    readonly main: string,
  ) {
    this.repo = resolve(repo);
  }

  // Calls run one at a time, so a call always knows what it made itself.
  // Without this, a failing second call for the same worktree could clean
  // up the worktree the first call made.
  private last: Promise<unknown> = Promise.resolve();

  createWorktree(request: WorktreeRequest): Promise<Done<Worktree>> {
    return this.oneAtATime(() =>
      guard(`create the worktree for #${request.taskId}`, () => this.create(request)),
    );
  }

  merge(request: MergeRequest, runChecks: RunChecks): Promise<Done<CommitSha>> {
    return this.oneAtATime(() =>
      guard(`merge #${request.taskId}`, () => this.squashMerge(request, runChecks)),
    );
  }

  readBranch(worktree: Worktree): Promise<Done<BranchFacts>> {
    return this.oneAtATime(() => guard(`read ${worktree.branch}`, () => this.read(worktree)));
  }

  removeWorktree(worktree: Worktree): Promise<Done<null>> {
    return this.oneAtATime(() => guard(`remove ${worktree.path}`, () => this.remove(worktree)));
  }

  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const next = this.last.then(work, work);
    this.last = next.catch(() => undefined);
    return next;
  }

  private async create(request: WorktreeRequest): Promise<Done<Worktree>> {
    if (!existsSync(this.repo))
      return { ok: false, message: `There is no repository at ${this.repo}.` };
    const branch = branchName(request);
    const path = join(this.repo, worktreesFolder, branch.slice("task/".length));

    // Asked again: the worktree is already there. A folder at that path
    // could also be some other repository, so it must be this one's.
    if (existsSync(path)) {
      const ours = await this.isWorktree(path);
      if (!ours.ok) return ours;
      if (!ours.value)
        return { ok: false, message: `${path} exists, but isn't a worktree of ${this.repo}.` };
      const current = await branchOf(path);
      if (current !== `refs/heads/${branch}`) {
        return { ok: false, message: `${path} exists, but isn't the worktree for ${branch}.` };
      }
      if (await isFinished(path)) return { ok: true, value: { path, branch } };
      // Not finished. It is only made again if there is proof this plugin
      // started it and stopped, for example when the daemon died, and that
      // nothing was done in it since. Anything else is someone's work.
      const halfMade = await this.isHalfMade(path, branch);
      if (!halfMade.ok) return halfMade;
      if (!halfMade.value) {
        return {
          ok: false,
          message: `${path} exists, but Skelcrew didn't finish making it, or there is work in it. It was left as it is.`,
        };
      }
      const undone = await this.undoCreate(path, branch, false);
      if (!undone.ok) return undone;
    }

    const main = await run(
      this.repo,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${this.main}`,
    );
    if (!main.ok) {
      return {
        ok: false,
        message: `The main branch "${this.main}" doesn't exist in ${this.repo}.`,
      };
    }
    const ignored = await this.ignoreWorktrees();
    if (!ignored.ok) return ignored;

    // The branch can exist without its worktree, if an earlier try made the
    // branch and stopped. Its name alone doesn't prove that, so it is only
    // used if it has no commits of its own: main already holds all of it.
    // It then moves up to main, where a new branch would start.
    const exists = await run(this.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    if (exists.ok) {
      // Full names throughout, so a tag called task/12-csv-export can
      // never stand in for the branch.
      const onMain = await run(
        this.repo,
        "merge-base",
        "--is-ancestor",
        `refs/heads/${branch}`,
        `refs/heads/${this.main}`,
      );
      if (!onMain.ok) {
        return {
          ok: false,
          message: `${branch} already exists, with commits that aren't on ${this.main}. Skelcrew won't build on someone else's work. Rename or delete that branch, then retry.`,
        };
      }
      const moved = await run(this.repo, "branch", "--force", branch, `refs/heads/${this.main}`);
      if (!moved.ok) return { ok: false, message: `git couldn't reset ${branch}: ${moved.err}` };
    }
    // The "creating" mark goes in first, as proof for a later try that this
    // plugin started the worktree, if it stops before finishing.
    const creating = await this.creatingMark(path);
    if (!creating.ok) return creating;
    mkdirSync(dirname(creating.value), { recursive: true });
    writeFileSync(creating.value, "");

    const added = exists.ok
      ? await run(this.repo, "worktree", "add", "--quiet", path, branch)
      : await run(
          this.repo,
          "worktree",
          "add",
          "--quiet",
          "-b",
          branch,
          path,
          `refs/heads/${this.main}`,
        );
    const finished = added.ok ? await markFinished(path) : added;
    if (!finished.ok) {
      const failed = `git couldn't create ${branch}: ${finished.err}`;
      const undone = await this.undoCreate(path, branch, !exists.ok);
      if (!undone.ok) return { ok: false, message: `${failed} ${undone.message}` };
      rmSync(creating.value, { force: true });
      return { ok: false, message: failed };
    }
    rmSync(creating.value, { force: true });
    return { ok: true, value: { path, branch } };
  }

  // Where the "creating" mark for a worktree goes: in the repository's own
  // git folder, which outlives the worktree's.
  private async creatingMark(path: string): Promise<Done<string>> {
    const common = await run(this.repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!common.ok) return { ok: false, message: `git couldn't find its folder: ${common.err}` };
    return { ok: true, value: join(common.out, "skelcrew-creating", basename(path)) };
  }

  // Proof that an unfinished worktree is safe to make again: this plugin's
  // "creating" mark, no changes of any kind in it, and no commits on its
  // branch beyond main.
  private async isHalfMade(path: string, branch: string): Promise<Done<boolean>> {
    const mark = await this.creatingMark(path);
    if (!mark.ok) return mark;
    if (!existsSync(mark.value)) return { ok: true, value: false };
    const status = await run(path, "status", "--porcelain", "--untracked-files=all");
    if (!status.ok || status.out !== "") return { ok: true, value: false };
    const files = await run(path, "ls-files", "-v");
    if (!files.ok || files.out.split("\n").some((line) => /^[a-zS]/.test(line))) {
      return { ok: true, value: false };
    }
    const onMain = await run(
      this.repo,
      "merge-base",
      "--is-ancestor",
      `refs/heads/${branch}`,
      `refs/heads/${this.main}`,
    );
    return { ok: true, value: onMain.ok };
  }

  // git can fail after it made the worktree, for example in a hook. The
  // core then records no worktree, so nothing may be left: this removes
  // the worktree, and the branch if this call made it. Forcing is safe,
  // since the worktree was checked out from main moments ago, and no agent
  // has worked in it.
  private async undoCreate(path: string, branch: string, madeBranch: boolean): Promise<Done<null>> {
    if (existsSync(path)) {
      const removed = await run(this.repo, "worktree", "remove", "--force", path);
      if (!removed.ok) {
        return {
          ok: false,
          message: `It left ${path} behind, and couldn't remove it: ${removed.err}`,
        };
      }
    }
    await run(this.repo, "worktree", "prune");
    if (madeBranch) {
      const deleted = await run(this.repo, "branch", "--delete", "--force", branch);
      if (!deleted.ok) {
        return {
          ok: false,
          message: `It left ${branch} behind, and couldn't delete it: ${deleted.err}`,
        };
      }
    }
    return { ok: true, value: null };
  }

  private async remove(worktree: Worktree): Promise<Done<null>> {
    if (!existsSync(worktree.path)) {
      // Forget a worktree git still lists, if its folder went some other way.
      await run(this.repo, "worktree", "prune");
      return { ok: true, value: null };
    }

    // Nothing is saved or removed until it is certain this is the task's
    // worktree, on the task's branch, with no changes git hides.
    const owned = await this.checkOwned(worktree);
    if (!owned.ok) return owned;

    // Untracked files are listed whatever git's settings say, so a setting
    // that hides them can't hide them from the save.
    const status = await run(worktree.path, "status", "--porcelain", "--untracked-files=all");
    if (!status.ok)
      return { ok: false, message: `git couldn't read ${worktree.path}: ${status.err}` };
    if (status.out !== "") {
      const staged = await run(worktree.path, "add", "--all");
      const committed = staged.ok
        ? await run(
            worktree.path,
            "commit",
            "--quiet",
            "--message",
            "Save uncommitted work before removing the worktree",
          )
        : staged;
      if (!committed.ok) {
        return {
          ok: false,
          message: `git couldn't save the uncommitted work in ${worktree.path}: ${committed.err}`,
        };
      }
    }

    // Something can still appear after the save, from a hook or a process
    // still writing. Then nothing is removed. Without --force, git makes the
    // same check again as it removes.
    const after = await run(worktree.path, "status", "--porcelain", "--untracked-files=all");
    if (!after.ok || after.out !== "") {
      return {
        ok: false,
        message: `${worktree.path} still has unsaved changes after saving. It was left as it is.`,
      };
    }
    const removed = await run(
      this.repo,
      "-c",
      "status.showUntrackedFiles=all",
      "worktree",
      "remove",
      worktree.path,
    );
    if (!removed.ok) {
      return { ok: false, message: `git couldn't remove ${worktree.path}: ${removed.err}` };
    }
    return { ok: true, value: null };
  }

  // Whether the folder is one of this repository's worktrees. git's list
  // alone isn't proof: it still lists a worktree whose folder was moved
  // away, and something else can sit at the old path. So the folder's own
  // git data must point back to this repository, and the folder must be
  // its own top level, not a folder inside something else.
  private async isWorktree(path: string): Promise<Done<boolean>> {
    const real = realpathSync(path);
    const listed = await run(this.repo, "worktree", "list", "--porcelain");
    if (!listed.ok) return { ok: false, message: `git couldn't list worktrees: ${listed.err}` };
    if (!listed.out.split("\n").includes(`worktree ${real}`)) return { ok: true, value: false };

    const ours = await run(this.repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const theirs = await run(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const top = await run(path, "rev-parse", "--show-toplevel");
    if (!ours.ok || !theirs.ok || !top.ok) return { ok: true, value: false };
    const same =
      realpathSync(ours.out) === realpathSync(theirs.out) && realpathSync(top.out) === real;
    return { ok: true, value: same };
  }

  // Checks the worktree is this repository's, on its task's branch, and has
  // no changes git hides. Saving on a detached HEAD would leave the work on
  // no branch at all. git doesn't show edits to files marked
  // assume-unchanged or skip-worktree, so a save would miss them. Clearing
  // the marks isn't safe either: in a sparse checkout, files left out would
  // look deleted. So nothing is touched.
  private async checkOwned(worktree: Worktree): Promise<Done<null>> {
    const ours = await this.isWorktree(worktree.path);
    if (!ours.ok) return ours;
    if (!ours.value) {
      return { ok: false, message: `${worktree.path} isn't a worktree of ${this.repo}.` };
    }
    const head = await branchOf(worktree.path);
    if (head !== `refs/heads/${worktree.branch}`) {
      const on = head ?? "no branch";
      return {
        ok: false,
        message: `${worktree.path} is on ${on}, not ${worktree.branch}. Its work was left as it is.`,
      };
    }
    const files = await run(worktree.path, "ls-files", "-v");
    if (!files.ok) {
      return { ok: false, message: `git couldn't list ${worktree.path}: ${files.err}` };
    }
    const hidden = files.out.split("\n").filter((line) => /^[a-zS]/.test(line));
    if (hidden.length > 0) {
      return {
        ok: false,
        message: `${hidden.length} file(s) in ${worktree.path} are marked so git hides their changes. The worktree was left as it is.`,
      };
    }
    return { ok: true, value: null };
  }

  private async read(worktree: Worktree): Promise<Done<BranchFacts>> {
    if (!existsSync(worktree.path)) {
      return { ok: false, message: `${worktree.path} doesn't exist.` };
    }
    const owned = await this.checkOwned(worktree);
    if (!owned.ok) return owned;
    const status = await run(worktree.path, "status", "--porcelain", "--untracked-files=all");
    if (!status.ok) {
      return { ok: false, message: `git couldn't read ${worktree.path}: ${status.err}` };
    }
    if (status.out !== "") {
      return {
        ok: false,
        message: `${worktree.path} has uncommitted changes. Commit them first: the gates and the merge only see what is committed.`,
      };
    }

    const branch = `refs/heads/${worktree.branch}`;
    const main = `refs/heads/${this.main}`;
    const head = await run(this.repo, "rev-parse", "--verify", branch);
    const commits = await run(this.repo, "rev-list", "--count", `${main}..${branch}`);
    const base = await run(this.repo, "merge-base", main, branch);
    if (!head.ok || !commits.ok || !base.ok) {
      const err = [head, commits, base].flatMap((r) => (r.ok ? [] : [r.err])).join(" ");
      return { ok: false, message: `git couldn't read ${worktree.branch}: ${err}` };
    }
    // Renames count as a removal and an addition, so both names are listed.
    // -z keeps names exactly, with no quoting of spaces or accents.
    const diff = await runRaw(
      this.repo,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      base.out,
      head.out,
    );
    if (!diff.ok) return { ok: false, message: `git couldn't list the changed files: ${diff.err}` };
    const sha = CommitSha.safeParse(head.out);
    if (!sha.success) return { ok: false, message: `git gave "${head.out}" as the head commit.` };
    return {
      ok: true,
      value: {
        head: sha.data,
        commits: Number(commits.out),
        changedFiles: diff.out
          .split("\0")
          .filter((file) => file !== "")
          .sort(),
      },
    };
  }

  // Adds the worktrees folder to .git/info/exclude, once.
  // Adds the worktrees and merging folders to .git/info/exclude, once each.
  private async ignoreWorktrees(): Promise<Done<null>> {
    const found = await run(this.repo, "rev-parse", "--git-path", "info/exclude");
    if (!found.ok) return { ok: false, message: `git couldn't find its ignore file: ${found.err}` };
    const file = isAbsolute(found.out) ? found.out : join(this.repo, found.out);
    for (const folder of [worktreesFolder, mergingFolder]) {
      const line = `/${folder}/`;
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!current.split("\n").includes(line)) {
        mkdirSync(dirname(file), { recursive: true });
        const gap = current === "" || current.endsWith("\n") ? "" : "\n";
        appendFileSync(file, `${gap}${line}\n`);
      }
    }
    return { ok: true, value: null };
  }

  // The merge, in five steps. Main only moves in the last one.
  private async squashMerge(request: MergeRequest, runChecks: RunChecks): Promise<Done<CommitSha>> {
    const main = `refs/heads/${this.main}`;
    const branch = `refs/heads/${request.worktree.branch}`;

    // 1. Already merged: the commit on main names the head it landed.
    const trailer = `Skelcrew-Head: ${request.head}`;
    const found = await run(
      this.repo,
      "log",
      main,
      "--format=%H",
      "--fixed-strings",
      `--grep=${trailer}`,
    );
    const earlier = found.ok ? found.out.split("\n")[0] : undefined;
    if (earlier !== undefined && earlier !== "") return shaOf(earlier);

    // 2. The head must be on the task's branch.
    const onBranch = await run(this.repo, "merge-base", "--is-ancestor", request.head, branch);
    if (!onBranch.ok) {
      return { ok: false, message: `${request.head} isn't on ${request.worktree.branch}.` };
    }
    const before = await run(this.repo, "rev-parse", "--verify", main);
    if (!before.ok) return { ok: false, message: `The main branch "${this.main}" doesn't exist.` };
    const ignored = await this.ignoreWorktrees();
    if (!ignored.ok) return ignored;

    // 3. Build the result in a worktree of its own, from main as it is now.
    // A leftover from a crash is only ever an earlier try of this, so it
    // goes first.
    const temp = join(this.repo, mergingFolder, String(request.taskId));
    await this.clearMerging(temp);
    const added = await run(this.repo, "worktree", "add", "--quiet", "--detach", temp, before.out);
    if (!added.ok) return { ok: false, message: `git couldn't prepare the merge: ${added.err}` };
    try {
      const squashed = await run(temp, "merge", "--squash", "--quiet", request.head);
      if (!squashed.ok) {
        const conflicts = await run(temp, "diff", "--name-only", "--diff-filter=U");
        const files =
          conflicts.ok && conflicts.out !== ""
            ? conflicts.out.split("\n").join(", ")
            : squashed.err;
        return {
          ok: false,
          message: `#${request.taskId} conflicts with ${this.main} in ${files}.`,
        };
      }
      const committed = await run(
        temp,
        "commit",
        "--quiet",
        "--message",
        `#${request.taskId} ${request.title}`,
        "--message",
        `Skelcrew-Task: ${request.taskId}\n${trailer}`,
      );
      if (!committed.ok)
        return { ok: false, message: `git couldn't commit the merge: ${committed.err}` };

      // 4. The checks run on the merged result.
      const checked = await runChecks(temp);
      if (!checked.ok) {
        return { ok: false, message: `The checks failed on the merged result: ${checked.message}` };
      }

      // 5. Move main. In your checkout of main, a fast-forward, which git
      // refuses if it would overwrite your uncommitted edits. Elsewhere,
      // only if main hasn't moved since step 2.
      const result = await run(temp, "rev-parse", "HEAD");
      if (!result.ok) return { ok: false, message: `git couldn't read the merge: ${result.err}` };
      const checkout = await this.checkoutOf(main);
      const moved =
        checkout === null
          ? await run(this.repo, "update-ref", main, result.out, before.out)
          : await run(checkout, "merge", "--ff-only", "--quiet", result.out);
      if (!moved.ok) {
        return { ok: false, message: `${this.main} couldn't be moved to the merge: ${moved.err}` };
      }
      return shaOf(result.out);
    } finally {
      await this.clearMerging(temp);
    }
  }

  private async clearMerging(temp: string): Promise<void> {
    if (existsSync(temp)) await run(this.repo, "worktree", "remove", "--force", temp);
    await run(this.repo, "worktree", "prune");
  }

  // The worktree that has this branch checked out, or null if none has.
  private async checkoutOf(ref: string): Promise<string | null> {
    const listed = await run(this.repo, "worktree", "list", "--porcelain");
    if (!listed.ok) return null;
    for (const block of listed.out.split("\n\n")) {
      const lines = block.split("\n");
      if (lines.includes(`branch ${ref}`)) {
        const path = lines.find((line) => line.startsWith("worktree "));
        if (path !== undefined) return path.slice("worktree ".length);
      }
    }
    return null;
  }
}

// "task/12-csv-export" for build 1, "task/12-csv-export-2" for build 2. The
// title keeps only lowercase letters and digits, joined by dashes, and at
// most 40 characters of it.
export function branchName(request: WorktreeRequest): string {
  const words = request.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const name = words === "" ? `task/${request.taskId}` : `task/${request.taskId}-${words}`;
  return request.build > 1 ? `${name}-${request.build}` : name;
}

// The plugin's edge: anything unexpected, such as a missing folder or a
// file that can't be written, becomes a failed result instead of a throw.
async function guard<T>(what: string, work: () => Promise<Done<T>>): Promise<Done<T>> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Couldn't ${what}: ${message}` };
  }
}

// A worktree counts as made only once this mark exists. It sits in git's
// own folder for the worktree, so it never shows up as a change, and it
// goes when the worktree does.
const finishedMark = "skelcrew-finished";

async function markFinished(path: string): Promise<Run> {
  const dir = await run(path, "rev-parse", "--path-format=absolute", "--git-dir");
  if (!dir.ok) return dir;
  try {
    writeFileSync(join(dir.out, finishedMark), "");
    return { ok: true, out: "" };
  } catch (error) {
    return { ok: false, err: error instanceof Error ? error.message : String(error) };
  }
}

async function isFinished(path: string): Promise<boolean> {
  const dir = await run(path, "rev-parse", "--path-format=absolute", "--git-dir");
  return dir.ok && existsSync(join(dir.out, finishedMark));
}

function shaOf(text: string): Done<CommitSha> {
  const sha = CommitSha.safeParse(text);
  return sha.success
    ? { ok: true, value: sha.data }
    : { ok: false, message: `git gave "${text}" as a commit.` };
}

// The full name of the branch a worktree has checked out, such as
// refs/heads/task/12-csv-export, or null on a detached HEAD. Full, because
// with a same-named tag git shortens it to heads/task/12-csv-export.
async function branchOf(path: string): Promise<string | null> {
  const head = await run(path, "symbolic-ref", "--quiet", "HEAD");
  return head.ok ? head.out : null;
}

type Run = { ok: true; out: string } | { ok: false; err: string };

// .nothrow() covers git failing, not git failing to start, for example in
// a folder that doesn't exist. That is caught here too.
async function run(dir: string, ...args: string[]): Promise<Run> {
  const result = await runRaw(dir, ...args);
  return result.ok ? { ok: true, out: result.out.trim() } : result;
}

// Like run, but keeps the output exactly, for file names that could start
// or end with a space.
async function runRaw(dir: string, ...args: string[]): Promise<Run> {
  try {
    const result = await $`git ${args}`.cwd(dir).nothrow().quiet();
    if (result.exitCode === 0) return { ok: true, out: result.stdout.toString() };
    return { ok: false, err: result.stderr.toString().trim() || `exit code ${result.exitCode}` };
  } catch (error) {
    return { ok: false, err: error instanceof Error ? error.message : String(error) };
  }
}
