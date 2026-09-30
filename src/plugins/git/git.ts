// The built-in version-control plugin, on git worktrees. Each task's build
// gets its own worktree and branch, so agents never share a checkout.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
  CheckRequest,
  Done,
  MergeRequest,
  RevertRequest,
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
// And a revert here.
const revertingFolder = ".skelcrew/reverting";
// The gate checks a fresh copy of the reported commit here.
const checkingFolder = ".skelcrew/checking";

// How failure messages name what is being put on main. The merge and the
// revert share their steps, so they share the messages too.
type Wording = {
  thing: string; // "the merge"
  exactly: string; // what it must hold, for when a hook changed it
  during: string; // when main moved underneath it
  nothing: string; // what didn't happen
  changes: string; // what a failed move may have left in your checkout
  stopped: string; // if building it threw
};

const merging: Wording = {
  thing: "the merge",
  exactly: "what the task made",
  during: "while the merge was being checked",
  nothing: "Nothing was merged.",
  changes: "the task's changes",
  stopped: "The merge stopped partway.",
};

const reverting: Wording = {
  thing: "the revert",
  exactly: "exactly main with the commit undone",
  during: "while the revert was being made",
  nothing: "Nothing was reverted.",
  changes: "the revert's changes",
  stopped: "The revert stopped partway.",
};

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

  // Making and removing the copy wait their turn with the plugin's other
  // calls. The checks themselves don't, since they can run for a long time
  // and other tasks' worktrees mustn't wait on them.
  async checkCommit(request: CheckRequest, runChecks: RunChecks): Promise<Done<null>> {
    const copy = await this.oneAtATime(() =>
      guard(`copy ${request.head} to check it`, () => this.copyToCheck(request)),
    );
    if (!copy.ok) return copy;
    const { temp, mark } = copy.value;
    let result: Done<null>;
    try {
      result = await runChecks(temp);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { ok: false, message: `The checks couldn't run: ${message}` };
    }
    const cleared = await this.oneAtATime(() =>
      guard(`remove ${temp}`, () => this.clearOwnWorktree(temp, mark)),
    );
    // A copy left behind is cleared by the next check of this task.
    if (!cleared.ok && !result.ok) {
      return { ok: false, message: `${result.message} ${cleared.message}` };
    }
    return result;
  }

  merge(request: MergeRequest, runChecks: RunChecks): Promise<Done<CommitSha>> {
    return this.oneAtATime(() =>
      guard(`merge #${request.taskId}`, () => this.squashMerge(request, runChecks)),
    );
  }

  revert(request: RevertRequest): Promise<Done<CommitSha>> {
    return this.oneAtATime(() => guard(`revert #${request.taskId}`, () => this.undo(request)));
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

    const main = await this.mainExists();
    if (!main.ok) return main;
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
    const hidden = await hiddenFiles(worktree.path);
    if (!hidden.ok) return hidden;
    if (hidden.value > 0) {
      return {
        ok: false,
        message: `${hidden.value} file(s) in ${worktree.path} are marked so git hides their changes. The worktree was left as it is.`,
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

  // Adds the plugin's worktree folders to .git/info/exclude, once each.
  private async ignoreWorktrees(): Promise<Done<null>> {
    const found = await run(this.repo, "rev-parse", "--git-path", "info/exclude");
    if (!found.ok) return { ok: false, message: `git couldn't find its ignore file: ${found.err}` };
    const file = isAbsolute(found.out) ? found.out : join(this.repo, found.out);
    for (const folder of [worktreesFolder, mergingFolder, revertingFolder]) {
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

  // A detached copy of exactly the reported commit, for the gate's checks,
  // marked as Skelcrew's own so a leftover one can be cleared.
  private async copyToCheck(request: CheckRequest): Promise<Done<{ temp: string; mark: string }>> {
    const common = await this.gitFolder();
    if (!common.ok) return common;
    const ignored = await this.ignoreWorktrees();
    if (!ignored.ok) return ignored;
    const temp = join(this.repo, checkingFolder, String(request.taskId));
    const mark = join(common.value, "skelcrew-checking", String(request.taskId));
    const cleared = await this.clearOwnWorktree(temp, mark);
    if (!cleared.ok) return cleared;
    mkdirSync(dirname(mark), { recursive: true });
    writeFileSync(mark, "");
    const added = await run(
      this.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      temp,
      request.head,
    );
    if (!added.ok) {
      await this.clearOwnWorktree(temp, mark);
      return {
        ok: false,
        message: `git couldn't make a copy of ${request.head} to check: ${added.err}`,
      };
    }
    return { ok: true, value: { temp, mark } };
  }

  // The merge. Main only moves at the very end, and only to the exact
  // commit the checks tested.
  private async squashMerge(request: MergeRequest, runChecks: RunChecks): Promise<Done<CommitSha>> {
    const common = await this.gitFolder();
    if (!common.ok) return common;

    // Already merged? The receipt holds the commit this plugin was about to
    // put on main. Only if that exact commit is on main did the merge land.
    // A commit's hash can't be faked by text in some other commit.
    const receipt = join(common.value, "skelcrew-merges", `${request.taskId}-${request.head}`);
    const landed = await this.landedBefore(receipt);
    if (landed !== null) return landed;

    const onBranch = await run(
      this.repo,
      "merge-base",
      "--is-ancestor",
      request.head,
      `refs/heads/${request.worktree.branch}`,
    );
    if (!onBranch.ok) {
      return { ok: false, message: `${request.head} isn't on ${request.worktree.branch}.` };
    }
    const before = await this.mainNow();
    if (!before.ok) return before;
    const ignored = await this.ignoreWorktrees();
    if (!ignored.ok) return ignored;

    // The merge is built in a worktree of its own.
    return this.inOwnWorktree(
      join(this.repo, mergingFolder, String(request.taskId)),
      join(common.value, "skelcrew-merging", String(request.taskId)),
      merging,
      (temp) => this.buildAndLand(request, runChecks, temp, receipt, before.value),
    );
  }

  private async buildAndLand(
    request: MergeRequest,
    runChecks: RunChecks,
    temp: string,
    receipt: string,
    before: string,
  ): Promise<Done<CommitSha>> {
    const added = await run(this.repo, "worktree", "add", "--quiet", "--detach", temp, before);
    if (!added.ok) return { ok: false, message: `git couldn't prepare the merge: ${added.err}` };

    // Exactly the reported commit, squashed onto main as it is now.
    const squashed = await run(temp, "merge", "--squash", "--quiet", request.head);
    if (!squashed.ok) {
      const files = await conflicted(temp, squashed.err);
      return { ok: false, message: `#${request.taskId} conflicts with ${this.main} in ${files}.` };
    }
    const committed = await run(
      temp,
      "commit",
      "--quiet",
      "--message",
      `#${request.taskId} ${request.title}`,
      "--message",
      `Skelcrew-Task: ${request.taskId}\nSkelcrew-Head: ${request.head}`,
    );
    if (!committed.ok)
      return { ok: false, message: `git couldn't commit the merge: ${committed.err}` };
    const candidate = await run(temp, "rev-parse", "HEAD");
    if (!candidate.ok)
      return { ok: false, message: `git couldn't read the merge: ${candidate.err}` };
    // Hooks run while the merge is made, and one could stage a file or add
    // a commit no one approved. So the result is checked against what it
    // must be, worked out separately: exactly one commit on the old main,
    // holding exactly main merged with the task's commit.
    const exact = await this.isExact(candidate.out, before, [before, request.head], merging);
    if (!exact.ok) return exact;
    const hiddenBefore = await hiddenFiles(temp);
    if (!hiddenBefore.ok || hiddenBefore.value > 0) {
      return { ok: false, message: "Files in the merge are marked so git hides their changes." };
    }

    // The checks run on the merged result. They may leave build output,
    // but must not commit or change tracked files: then they tested
    // something other than what would land.
    const checked = await runChecks(temp);
    if (!checked.ok) {
      return { ok: false, message: `The checks failed on the merged result: ${checked.message}` };
    }
    const after = await run(temp, "rev-parse", "HEAD");
    const changed = await run(temp, "status", "--porcelain", "--untracked-files=no");
    if (!after.ok || after.out !== candidate.out) {
      return {
        ok: false,
        message: "The checks made a commit, so they didn't test what would land.",
      };
    }
    if (!changed.ok || changed.out !== "") {
      return {
        ok: false,
        message: "The checks changed tracked files, so they didn't test what would land.",
      };
    }
    // git status doesn't show changes to files marked assume-unchanged or
    // skip-worktree, so the checks mustn't leave any such marks.
    const hiddenAfter = await hiddenFiles(temp);
    if (!hiddenAfter.ok || hiddenAfter.value > 0) {
      return {
        ok: false,
        message: "The checks hid changes from git, so they didn't test what would land.",
      };
    }

    return this.land(receipt, before, candidate.out, merging);
  }

  // The revert. Like the merge, it is built in a worktree of its own, and
  // main only moves at the very end, to a result checked independently.
  private async undo(request: RevertRequest): Promise<Done<CommitSha>> {
    const common = await this.gitFolder();
    if (!common.ok) return common;

    // Already reverted? As with the merge, only a receipt whose commit is
    // on main counts.
    const receipt = join(common.value, "skelcrew-reverts", `${request.taskId}-${request.commit}`);
    const landed = await this.landedBefore(receipt);
    if (landed !== null) return landed;

    const before = await this.mainNow();
    if (!before.ok) return before;
    const onMain = await run(
      this.repo,
      "merge-base",
      "--is-ancestor",
      request.commit,
      before.value,
    );
    if (!onMain.ok) {
      return {
        ok: false,
        message: `${request.commit} isn't on ${this.main}, so there is nothing to revert.`,
      };
    }
    // A task lands as one commit with one parent. Undoing a commit that
    // joins two branches would need a choice of which side to keep.
    const parents = await run(this.repo, "rev-list", "--parents", "--max-count=1", request.commit);
    if (!parents.ok) {
      return { ok: false, message: `git couldn't read ${request.commit}: ${parents.err}` };
    }
    const count = parents.out.split(" ").length - 1;
    if (count > 1) {
      return {
        ok: false,
        message: `${request.commit} has more than one parent, so it isn't one task's commit. It wasn't reverted.`,
      };
    }
    if (count === 0) {
      return {
        ok: false,
        message: `${request.commit} is the first commit, with nothing before it to go back to.`,
      };
    }
    const ignored = await this.ignoreWorktrees();
    if (!ignored.ok) return ignored;

    return this.inOwnWorktree(
      join(this.repo, revertingFolder, String(request.taskId)),
      join(common.value, "skelcrew-reverting", String(request.taskId)),
      reverting,
      (temp) => this.buildRevert(request, temp, receipt, before.value),
    );
  }

  private async buildRevert(
    request: RevertRequest,
    temp: string,
    receipt: string,
    before: string,
  ): Promise<Done<CommitSha>> {
    const added = await run(this.repo, "worktree", "add", "--quiet", "--detach", temp, before);
    if (!added.ok) return { ok: false, message: `git couldn't prepare the revert: ${added.err}` };

    const undone = await run(temp, "revert", "--no-commit", request.commit);
    if (!undone.ok) {
      const files = await conflicted(temp, undone.err);
      return {
        ok: false,
        message: `Reverting #${request.taskId} conflicts with ${this.main} in ${files}. Nothing was reverted.`,
      };
    }
    // Undoing the commit may change nothing. Someone may have undone it by
    // hand, or a merge rule in .gitattributes may keep main's version. The
    // message doesn't guess which.
    const changes = await run(temp, "diff", "--cached", "--quiet", "HEAD");
    if (changes.ok) {
      return {
        ok: false,
        message: `Reverting ${request.commit} would change nothing on ${this.main}.`,
      };
    }
    const committed = await run(
      temp,
      "commit",
      "--quiet",
      "--message",
      `Revert #${request.taskId}: ${request.reason}`,
      "--message",
      `This reverts commit ${request.commit}.`,
      "--message",
      `Skelcrew-Task: ${request.taskId}`,
    );
    if (!committed.ok) {
      return { ok: false, message: `git couldn't commit the revert: ${committed.err}` };
    }
    const candidate = await run(temp, "rev-parse", "HEAD");
    if (!candidate.ok) {
      return { ok: false, message: `git couldn't read the revert: ${candidate.err}` };
    }
    // Hooks run while the revert is made, so the result is checked against
    // what it must be: one commit on the old main, holding what git gets by
    // undoing the commit's changes on main. That is a merge of main and the
    // commit's parent, from the commit itself.
    const exact = await this.isExact(
      candidate.out,
      before,
      [`--merge-base=${request.commit}`, before, `${request.commit}^`],
      reverting,
    );
    if (!exact.ok) return exact;
    return this.land(receipt, before, candidate.out, reverting);
  }

  // git's own folder, shared by every worktree of the repository.
  private async gitFolder(): Promise<Done<string>> {
    const common = await run(this.repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!common.ok) return { ok: false, message: `git couldn't find its folder: ${common.err}` };
    return { ok: true, value: common.out };
  }

  // The commit an earlier call already put on main, if its receipt names
  // one that is there. A receipt whose commit never reached main is from a
  // try that stopped before moving main, so it is cleared. Null if there
  // is nothing to give back.
  private async landedBefore(receipt: string): Promise<Done<CommitSha> | null> {
    if (!existsSync(receipt)) return null;
    const candidate = readFileSync(receipt, "utf8").trim();
    const main = `refs/heads/${this.main}`;
    const landed = await run(this.repo, "merge-base", "--is-ancestor", candidate, main);
    if (landed.ok) return shaOf(candidate);
    rmSync(receipt, { force: true });
    return null;
  }

  // The commit main is at now, once the branch is known to have exactly
  // the configured name.
  private async mainNow(): Promise<Done<string>> {
    const exists = await this.mainExists();
    if (!exists.ok) return exists;
    const now = await run(this.repo, "rev-parse", "--verify", `refs/heads/${this.main}`);
    if (!now.ok) return { ok: false, message: `The main branch "${this.main}" doesn't exist.` };
    return { ok: true, value: now.out };
  }

  // Runs `build` with the path for a worktree of the plugin's own, never
  // yours. The plugin's mark goes in first, so a later try knows a leftover
  // is the plugin's to clear. The worktree is cleared afterwards, whatever
  // happened.
  private async inOwnWorktree(
    temp: string,
    mark: string,
    wording: Wording,
    build: (temp: string) => Promise<Done<CommitSha>>,
  ): Promise<Done<CommitSha>> {
    const cleared = await this.clearOwnWorktree(temp, mark);
    if (!cleared.ok) return cleared;
    mkdirSync(dirname(mark), { recursive: true });
    writeFileSync(mark, "");

    // Stays a failure if building throws. The guard at the edge reports it.
    let result: Done<CommitSha> = { ok: false, message: wording.stopped };
    try {
      result = await build(temp);
    } finally {
      const cleanup = await this.clearOwnWorktree(temp, mark);
      // After a success, main has moved, so the answer must stay a
      // success. Its mark stays too, so the next call clears the leftover.
      // After a failure, the message says what was left behind.
      if (!cleanup.ok && !result.ok) {
        result = { ok: false, message: `${result.message} ${cleanup.message}` };
      }
    }
    return result;
  }

  // The last step. The receipt goes in before main moves, so a crash in
  // between still shows, on the next try, whether main moved.
  private async land(
    receipt: string,
    before: string,
    candidate: string,
    wording: Wording,
  ): Promise<Done<CommitSha>> {
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(receipt, candidate);
    const moved = await this.moveMain(before, candidate, wording);
    if (!moved.ok) {
      rmSync(receipt, { force: true });
      return moved;
    }
    return shaOf(candidate);
  }

  // Clears the plugin's own worktree, but only if the plugin's mark says it
  // put it there. Anything else at that path is someone's work.
  private async clearOwnWorktree(temp: string, mark: string): Promise<Done<null>> {
    if (existsSync(temp)) {
      if (!existsSync(mark)) {
        return {
          ok: false,
          message: `${temp} exists, but Skelcrew didn't put it there. It was left as it is.`,
        };
      }
      // git can stop halfway, such as on a read-only folder the checks
      // left: it forgets the worktree but leaves the folder. The mark says
      // the folder is Skelcrew's own, so it is made writable and deleted.
      const removed = await run(this.repo, "worktree", "remove", "--force", temp);
      if (existsSync(temp)) {
        try {
          writableAll(temp);
          rmSync(temp, { recursive: true, force: true });
        } catch (error) {
          const reason = removed.ok ? describeError(error) : removed.err;
          return {
            ok: false,
            message: `Skelcrew's own worktree ${temp} couldn't be removed: ${reason}`,
          };
        }
      }
    }
    await run(this.repo, "worktree", "prune");
    rmSync(mark, { force: true });
    return { ok: true, value: null };
  }

  // Checks a branch has exactly the configured name. On macOS, git also
  // finds "main" when asked for "Main", while every check that compares
  // names would miss it.
  private async mainExists(): Promise<Done<null>> {
    const listed = await run(this.repo, "for-each-ref", "--format=%(refname)", "refs/heads/");
    if (listed.ok && listed.out.split("\n").includes(`refs/heads/${this.main}`)) {
      return { ok: true, value: null };
    }
    return { ok: false, message: `The main branch "${this.main}" doesn't exist in ${this.repo}.` };
  }

  // Whether the commit is exactly what it must be: its one parent is the
  // old main, and its contents are what `git merge-tree` makes of
  // `mergeArgs`. The merge-tree is worked out separately, so no hook can
  // touch it.
  private async isExact(
    commit: string,
    before: string,
    mergeArgs: string[],
    wording: Wording,
  ): Promise<Done<null>> {
    const parents = await run(this.repo, "rev-list", "--parents", "--max-count=1", commit);
    if (!parents.ok || parents.out !== `${commit} ${before}`) {
      return {
        ok: false,
        message: `A hook added a commit to ${wording.thing}, so it isn't ${wording.exactly}.`,
      };
    }
    // With main's .gitattributes, which git itself used, not those of
    // whatever your checkout has open.
    const expected = await run(
      this.repo,
      "-c",
      `attr.tree=${before}`,
      "merge-tree",
      "--write-tree",
      ...mergeArgs,
    );
    const tree = await run(this.repo, "rev-parse", `${commit}^{tree}`);
    const wanted = expected.ok ? expected.out.split("\n")[0] : undefined;
    if (!tree.ok || wanted === undefined || tree.out !== wanted) {
      return {
        ok: false,
        message: `A hook changed what ${wording.thing} holds, so it isn't ${wording.exactly}.`,
      };
    }
    return { ok: true, value: null };
  }

  // Moves main from `before` to `after`, or fails and leaves main, and
  // your checkout of it, as they were.
  private async moveMain(before: string, after: string, wording: Wording): Promise<Done<null>> {
    const main = `refs/heads/${this.main}`;
    const where = await this.mainCheckout(wording);
    if (!where.ok) return where;

    // Main must still be where the work began. If someone moved it, for
    // example to take a bad commit off, moving it now would undo that. The
    // one exception is main already at exactly the checked result, for
    // example because a hook moved it there: then the move is done.
    const now = await run(this.repo, "rev-parse", "--verify", main);
    if (now.ok && now.out === after) return { ok: true, value: null };
    if (!now.ok || now.out !== before) {
      return {
        ok: false,
        message: `${this.main} moved ${wording.during}. ${wording.nothing} Try again.`,
      };
    }

    // No checkout has main open: move it, but only if it is still where the
    // work began.
    if (where.value === null) {
      const updated = await run(this.repo, "update-ref", main, after, before);
      if (updated.ok) return { ok: true, value: null };
      return {
        ok: false,
        message: `${this.main} couldn't be moved to ${wording.thing}: ${updated.err}`,
      };
    }

    // Your staging area as it is now, so a failed move can be undone exactly.
    const snapshot = await run(where.value, "write-tree");
    // In your checkout of main, a fast-forward. git refuses it rather than
    // overwrite your uncommitted edits, or, with --no-overwrite-ignore, your
    // ignored files. --no-autostash stops git from stashing your edits
    // instead of refusing.
    const moved = await run(
      where.value,
      "merge",
      "--ff-only",
      "--no-overwrite-ignore",
      "--no-autostash",
      "--quiet",
      after,
    );
    if (moved.ok) return { ok: true, value: null };
    const failed = `${this.main} couldn't be moved to ${wording.thing}: ${moved.err}`;
    const putBack = snapshot.ok
      ? await putCheckoutBack(where.value, before, after, snapshot.out, wording)
      : unsureOf(wording);
    return { ok: false, message: `${failed} ${putBack}` };
  }

  // Your checkout of main, if one has it open, or null. Refused if main is
  // open in more than one place, since only one could be updated, or if any
  // checkout is rebasing or bisecting main. git lists a rebasing checkout
  // as detached, so each checkout's own git folder is read.
  private async mainCheckout(wording: Wording): Promise<Done<string | null>> {
    const main = `refs/heads/${this.main}`;
    const listed = await run(this.repo, "worktree", "list", "--porcelain");
    if (!listed.ok) return { ok: false, message: `git couldn't list worktrees: ${listed.err}` };
    const open: string[] = [];
    const all: string[] = [];
    for (const block of listed.out.split("\n\n")) {
      const lines = block.split("\n");
      const line = lines.find((l) => l.startsWith("worktree "));
      if (line === undefined) continue;
      const path = line.slice("worktree ".length);
      all.push(path);
      if (lines.includes(`branch ${main}`)) open.push(path);
    }
    if (open.length > 1) {
      return {
        ok: false,
        message: `${this.main} is checked out in ${open.length} places: ${open.join(", ")}. Only one could be updated. ${wording.nothing}`,
      };
    }
    for (const path of all) {
      const busy = await busyWith(path, this.main);
      if (busy !== null) {
        return {
          ok: false,
          message: `${path} is ${busy} ${this.main}. ${wording.nothing} Finish or abort that first.`,
        };
      }
    }
    return { ok: true, value: open[0] ?? null };
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

// How many files are marked assume-unchanged or skip-worktree. git hides
// changes to them from status, so a save or a check would miss them.
async function hiddenFiles(dir: string): Promise<Done<number>> {
  const files = await run(dir, "ls-files", "-v");
  if (!files.ok) return { ok: false, message: `git couldn't list ${dir}: ${files.err}` };
  return { ok: true, value: files.out.split("\n").filter((line) => /^[a-zS]/.test(line)).length };
}

// "rebasing" or "bisecting" if the checkout at `path` is doing that to the
// branch, or null.
async function busyWith(path: string, branch: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  for (const [file, what] of [
    ["rebase-merge/head-name", "rebasing"],
    ["rebase-apply/head-name", "rebasing"],
    ["BISECT_START", "bisecting"],
  ] as const) {
    const found = await run(path, "rev-parse", "--path-format=absolute", "--git-path", file);
    if (!found.ok || !existsSync(found.out)) continue;
    const name = readFileSync(found.out, "utf8").trim();
    if (name === branch || name === `refs/heads/${branch}`) return what;
  }
  return null;
}

// What a failure message adds when it can't tell whether your checkout of
// main is as it was.
function unsureOf(wording: Wording): string {
  return `Check \`git status\` there: it may hold ${wording.changes}, staged.`;
}

// The files git left in conflict in a folder, joined by commas, or `err`
// if it lists none.
async function conflicted(dir: string, err: string): Promise<string> {
  const conflicts = await run(dir, "diff", "--name-only", "--diff-filter=U");
  return conflicts.ok && conflicts.out !== "" ? conflicts.out.split("\n").join(", ") : err;
}

// After a failed fast-forward, git may have updated your files and staging
// area without moving main. Only the files the merge touched are looked at,
// by exact name. A file counts as git's doing only if it now holds exactly
// what the merge made, differs from the snapshot of your staging area taken
// before, and its working copy matches. Those are set back to the snapshot.
// Everything else is yours and stays. Returns what the message should add.
async function putCheckoutBack(
  checkout: string,
  before: string,
  merge: string,
  snapshot: string,
  wording: Wording,
): Promise<string> {
  const unsure = unsureOf(wording);
  const head = await run(checkout, "rev-parse", "HEAD");
  if (!head.ok || head.out !== before) return unsure;
  const touched = await runRaw(
    checkout,
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    before,
    merge,
  );
  if (!touched.ok) return unsure;

  const byGit: { path: string; back: string }[] = [];
  for (const path of touched.out.split("\0").filter((p) => p !== "")) {
    const now = await indexEntry(checkout, path);
    const mine = await treeEntry(checkout, snapshot, path);
    const merged = await treeEntry(checkout, merge, path);
    if (now === null || mine === null || merged === null) return unsure;
    if (now === mine) continue;
    const clean = await run(checkout, "--literal-pathspecs", "diff", "--quiet", "--", path);
    if (now !== merged || !clean.ok) return unsure;
    byGit.push({ path, back: mine });
  }
  if (byGit.length === 0) return "Your checkout of main is as it was.";

  // Files the merge added go first, so a folder it made can give way to
  // the file that was there before.
  const order = [...byGit].sort((a, b) => Number(a.back !== "") - Number(b.back !== ""));
  for (const { path, back } of order) {
    if (!(await setBack(checkout, path, back))) return unsure;
  }
  return "Your checkout of main was put back as it was, with your own edits kept.";
}

// A file's entry in the staging area, as "mode object", "" if it isn't
// there, or null if git couldn't say. Exact names only: git would read the
// name as a pattern, and a folder's name matches the files inside it.
async function indexEntry(checkout: string, path: string): Promise<string | null> {
  const listed = await runRaw(
    checkout,
    "--literal-pathspecs",
    "ls-files",
    "--stage",
    "-z",
    "--",
    path,
  );
  if (!listed.ok) return null;
  for (const line of listed.out.split("\0")) {
    const [meta, name] = line.split("\t");
    if (name !== path || meta === undefined) continue;
    const [mode, object] = meta.split(" ");
    return `${mode} ${object}`;
  }
  return "";
}

// The same, in a commit or tree. A folder at that name counts as no file.
async function treeEntry(checkout: string, tree: string, path: string): Promise<string | null> {
  const listed = await runRaw(checkout, "--literal-pathspecs", "ls-tree", "-z", tree, "--", path);
  if (!listed.ok) return null;
  for (const line of listed.out.split("\0")) {
    const [meta, name] = line.split("\t");
    if (name !== path || meta === undefined) continue;
    const [mode, type, object] = meta.split(" ");
    return type === "tree" ? "" : `${mode} ${object}`;
  }
  return "";
}

// Sets a file back to an entry, in the staging area and on disk, or
// removes it if the entry is "".
async function setBack(checkout: string, path: string, entry: string): Promise<boolean> {
  if (entry === "") {
    return (await run(checkout, "--literal-pathspecs", "rm", "--quiet", "--force", "--", path)).ok;
  }
  const [mode, object] = entry.split(" ");
  const staged = await run(
    checkout,
    "update-index",
    "--add",
    "--cacheinfo",
    `${mode},${object},${path}`,
  );
  if (!staged.ok) return false;
  return (await run(checkout, "--literal-pathspecs", "checkout-index", "--force", "--", path)).ok;
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

// Gives the owner write permission on a folder and every folder in it, so
// it can be deleted. Links aren't followed.
function writableAll(path: string): void {
  const found = lstatSync(path);
  if (!found.isDirectory()) return;
  chmodSync(path, found.mode | 0o700);
  for (const entry of readdirSync(path)) writableAll(join(path, entry));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
