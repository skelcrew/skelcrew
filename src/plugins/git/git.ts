// The built-in version-control plugin, on git worktrees. Each task's build
// gets its own worktree and branch, so agents never share a checkout.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { $ } from "bun";
import type { Worktree } from "../../core/types";
import type { Done, VersionControl, WorktreeRequest } from "../version-control";

// Worktrees sit inside the repository, where you can find them. The folder
// is listed in the repository's local ignore file, so they never show up
// as changes in your own checkout.
const worktreesFolder = ".skelcrew/worktrees";

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

  createWorktree(request: WorktreeRequest): Promise<Done<Worktree>> {
    return guard(`create the worktree for #${request.taskId}`, () => this.create(request));
  }

  removeWorktree(worktree: Worktree): Promise<Done<null>> {
    return guard(`remove ${worktree.path}`, () => this.remove(worktree));
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
      if (current === `refs/heads/${branch}`) return { ok: true, value: { path, branch } };
      return { ok: false, message: `${path} exists, but isn't the worktree for ${branch}.` };
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
    if (!added.ok) return { ok: false, message: `git couldn't create ${branch}: ${added.err}` };
    return { ok: true, value: { path, branch } };
  }

  private async remove(worktree: Worktree): Promise<Done<null>> {
    if (!existsSync(worktree.path)) {
      // Forget a worktree git still lists, if its folder went some other way.
      await run(this.repo, "worktree", "prune");
      return { ok: true, value: null };
    }

    // Nothing is saved or removed until it is certain this is the task's
    // worktree, in this repository, on the task's branch. Saving on a
    // detached HEAD would leave the work on no branch at all.
    const ours = await this.isWorktree(worktree.path);
    if (!ours.ok) return ours;
    if (!ours.value)
      return { ok: false, message: `${worktree.path} isn't a worktree of ${this.repo}.` };
    const head = await branchOf(worktree.path);
    if (head !== `refs/heads/${worktree.branch}`) {
      const on = head ?? "no branch";
      return {
        ok: false,
        message: `${worktree.path} is on ${on}, not ${worktree.branch}. Its work was left as it is.`,
      };
    }

    // git doesn't show edits to files marked assume-unchanged or
    // skip-worktree, so the save would miss them. Clearing the marks isn't
    // safe either: in a sparse checkout, files left out would look deleted,
    // and the save would commit that. So nothing is touched.
    const files = await run(worktree.path, "ls-files", "-v");
    if (!files.ok)
      return { ok: false, message: `git couldn't list ${worktree.path}: ${files.err}` };
    const hidden = files.out.split("\n").filter((line) => /^[a-zS]/.test(line));
    if (hidden.length > 0) {
      return {
        ok: false,
        message: `${hidden.length} file(s) in ${worktree.path} are marked so git hides their changes. The worktree was left as it is.`,
      };
    }

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

  // Adds the worktrees folder to .git/info/exclude, once.
  private async ignoreWorktrees(): Promise<Done<null>> {
    const found = await run(this.repo, "rev-parse", "--git-path", "info/exclude");
    if (!found.ok) return { ok: false, message: `git couldn't find its ignore file: ${found.err}` };
    const file = isAbsolute(found.out) ? found.out : join(this.repo, found.out);
    const line = `/${worktreesFolder}/`;
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.split("\n").includes(line)) {
      mkdirSync(dirname(file), { recursive: true });
      const gap = current === "" || current.endsWith("\n") ? "" : "\n";
      appendFileSync(file, `${gap}${line}\n`);
    }
    return { ok: true, value: null };
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
  try {
    const result = await $`git ${args}`.cwd(dir).nothrow().quiet();
    if (result.exitCode === 0) return { ok: true, out: result.stdout.toString().trim() };
    return { ok: false, err: result.stderr.toString().trim() || `exit code ${result.exitCode}` };
  } catch (error) {
    return { ok: false, err: error instanceof Error ? error.message : String(error) };
  }
}
