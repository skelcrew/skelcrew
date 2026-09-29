// The built-in version-control plugin, on git worktrees. Each task's build
// gets its own worktree and branch, so agents never share a checkout.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { $ } from "bun";
import type { Worktree } from "../../core/types";
import type { Done, VersionControl, WorktreeRequest } from "../version-control";

// Worktrees sit inside the repository, where you can find them. The folder
// is listed in the repository's local ignore file, so they never show up
// as changes in your own checkout.
const worktreesFolder = ".skelcrew/worktrees";

export class Git implements VersionControl {
  constructor(
    readonly repo: string,
    readonly main: string,
  ) {}

  async createWorktree(request: WorktreeRequest): Promise<Done<Worktree>> {
    const branch = branchName(request);
    const path = join(this.repo, worktreesFolder, branch.slice("task/".length));

    // Asked again: the worktree is already there.
    if (existsSync(path)) {
      const current = await run(path, "rev-parse", "--abbrev-ref", "HEAD");
      if (current.ok && current.out === branch) return { ok: true, value: { path, branch } };
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
    // branch and stopped. It is used as it is, never moved.
    const exists = await run(this.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    const added = exists.ok
      ? await run(this.repo, "worktree", "add", "--quiet", path, branch)
      : await run(this.repo, "worktree", "add", "--quiet", "-b", branch, path, this.main);
    if (!added.ok) return { ok: false, message: `git couldn't create ${branch}: ${added.err}` };
    return { ok: true, value: { path, branch } };
  }

  async removeWorktree(worktree: Worktree): Promise<Done<null>> {
    if (!existsSync(worktree.path)) {
      // Forget a worktree git still lists, if its folder went some other way.
      await run(this.repo, "worktree", "prune");
      return { ok: true, value: null };
    }

    const status = await run(worktree.path, "status", "--porcelain");
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

    // Everything worth keeping is committed. --force only drops files git
    // ignores, such as build output.
    const removed = await run(this.repo, "worktree", "remove", "--force", worktree.path);
    if (!removed.ok) {
      return { ok: false, message: `git couldn't remove ${worktree.path}: ${removed.err}` };
    }
    return { ok: true, value: null };
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

type Run = { ok: true; out: string } | { ok: false; err: string };

async function run(dir: string, ...args: string[]): Promise<Run> {
  const result = await $`git ${args}`.cwd(dir).nothrow().quiet();
  if (result.exitCode === 0) return { ok: true, out: result.stdout.toString().trim() };
  return { ok: false, err: result.stderr.toString().trim() || `exit code ${result.exitCode}` };
}
