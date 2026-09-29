// The tests every version-control plugin must pass, run against a
// throwaway git repository. A plugin's own test file calls
// versionControlContract with a way to make one.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { TaskId } from "../core/ids";
import type { VersionControl } from "./version-control";

export type Repo = { dir: string; main: string };

// A repository with one commit on main, as a user's repo would have.
export async function makeRepo(): Promise<Repo> {
  const dir = mkdtempSync(join(tmpdir(), "skelcrew-repo-"));
  await $`git init -q -b main`.cwd(dir).quiet();
  await $`git config user.name Test`.cwd(dir).quiet();
  await $`git config user.email test@example.com`.cwd(dir).quiet();
  writeFileSync(join(dir, "README.md"), "# Test\n");
  await $`git add README.md`.cwd(dir).quiet();
  await $`git commit -q -m First`.cwd(dir).quiet();
  return { dir, main: "main" };
}

export async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git ${args}`.cwd(dir).quiet().text()).trim();
}

export function versionControlContract(name: string, make: (repo: Repo) => VersionControl): void {
  const csv = { taskId: TaskId.parse(12), title: "CSV export", build: 1 };
  let dirs: string[] = [];
  const repo = async () => {
    const made = await makeRepo();
    dirs.push(made.dir);
    return made;
  };
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  describe(`${name}: createWorktree`, () => {
    test("makes a worktree on a new branch from main, named after the task", async () => {
      const r = await repo();
      const created = await make(r).createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      expect(created.value.branch).toBe("task/12-csv-export");
      expect(existsSync(join(created.value.path, "README.md"))).toBe(true);
      expect(await git(created.value.path, "rev-parse", "HEAD")).toBe(
        await git(r.dir, "rev-parse", "main"),
      );
    });

    test("gives a later build its own branch", async () => {
      const r = await repo();
      const created = await make(r).createWorktree({ ...csv, build: 2 });
      expect(created.ok && created.value.branch).toBe("task/12-csv-export-2");
    });

    test("starts from main, whatever the repository has checked out", async () => {
      const r = await repo();
      await git(r.dir, "checkout", "-q", "-b", "elsewhere");
      writeFileSync(join(r.dir, "other.txt"), "not on main\n");
      await git(r.dir, "add", "other.txt");
      await git(r.dir, "commit", "-q", "-m", "Elsewhere");

      const created = await make(r).createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      expect(existsSync(join(created.value.path, "other.txt"))).toBe(false);
    });

    test("asked twice, gives back the same worktree and changes nothing", async () => {
      const r = await repo();
      const plugin = make(r);
      const first = await plugin.createWorktree(csv);
      const worktrees = await git(r.dir, "worktree", "list");
      const second = await plugin.createWorktree(csv);
      expect(second).toEqual(first);
      expect(await git(r.dir, "worktree", "list")).toBe(worktrees);
    });

    test("keeps the repository's own checkout clean", async () => {
      const r = await repo();
      await make(r).createWorktree(csv);
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
    });

    // Found by Codex review: a branch with the right name isn't proof that
    // an earlier try made it.
    test("refuses a branch of that name with commits that aren't on main", async () => {
      const r = await repo();
      await git(r.dir, "branch", "task/12-csv-export");
      await git(r.dir, "checkout", "-q", "task/12-csv-export");
      writeFileSync(join(r.dir, "unrelated.txt"), "someone else's work\n");
      await git(r.dir, "add", "unrelated.txt");
      await git(r.dir, "commit", "-q", "-m", "Unrelated");
      await git(r.dir, "checkout", "-q", "main");

      const created = await make(r).createWorktree(csv);
      expect(created.ok).toBe(false);
      expect(!created.ok && created.message).toContain("task/12-csv-export");
    });

    // Found by Codex review: a folder at the right path, on the right branch,
    // can still be some other repository.
    test("refuses a folder at the worktree's path that isn't this repository's worktree", async () => {
      const r = await repo();
      const path = join(r.dir, ".skelcrew", "worktrees", "12-csv-export");
      mkdirSync(path, { recursive: true });
      await $`git init -q -b task/12-csv-export`.cwd(path).quiet();
      await git(
        path,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "Other",
      );

      const created = await make(r).createWorktree(csv);
      expect(created.ok).toBe(false);
    });

    test("carries on from an earlier try that made the branch and stopped", async () => {
      const r = await repo();
      await git(r.dir, "branch", "task/12-csv-export");
      const created = await make(r).createWorktree(csv);
      expect(created.ok && created.value.branch).toBe("task/12-csv-export");
    });

    test("fails with a message, not a throw, when the repository is missing", async () => {
      const r = await repo();
      const missing = join(r.dir, "nowhere");
      const created = await make({ ...r, dir: missing }).createWorktree(csv);
      expect(created).toEqual({ ok: false, message: `There is no repository at ${missing}.` });
    });

    test("fails with a message, not a throw, when it can't update the ignore file", async () => {
      const r = await repo();
      // A folder where the ignore file should be.
      rmSync(join(r.dir, ".git", "info", "exclude"), { force: true });
      mkdirSync(join(r.dir, ".git", "info", "exclude"), { recursive: true });
      const created = await make(r).createWorktree(csv);
      expect(created.ok).toBe(false);
    });

    test("fails with a message, not a throw, when main doesn't exist", async () => {
      const r = await repo();
      const created = await make({ ...r, main: "trunk" }).createWorktree(csv);
      expect(created.ok).toBe(false);
      expect(!created.ok && created.message).toContain("trunk");
    });
  });

  describe(`${name}: removeWorktree`, () => {
    test("commits uncommitted work to the branch, then removes the worktree", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      writeFileSync(join(created.value.path, "export.ts"), "export {};\n");

      expect(await plugin.removeWorktree(created.value)).toEqual({ ok: true, value: null });
      expect(existsSync(created.value.path)).toBe(false);
      expect(await git(r.dir, "show", "task/12-csv-export:export.ts")).toBe("export {};");
    });

    test("makes no commit when nothing is uncommitted", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      await plugin.removeWorktree(created.value);
      expect(await git(r.dir, "rev-parse", "task/12-csv-export")).toBe(
        await git(r.dir, "rev-parse", "main"),
      );
    });

    // Found by Codex review: a setting that hides untracked files must not
    // hide them from the save.
    test("saves untracked files even when git is set to hide them", async () => {
      const r = await repo();
      await git(r.dir, "config", "status.showUntrackedFiles", "no");
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      writeFileSync(join(created.value.path, "export.ts"), "export {};\n");

      expect(await plugin.removeWorktree(created.value)).toEqual({ ok: true, value: null });
      expect(await git(r.dir, "show", "task/12-csv-export:export.ts")).toBe("export {};");
    });

    // Found by Codex review: work written after the save commit, here by a
    // hook, must never be deleted.
    test("refuses to remove a worktree that still has unsaved work after saving", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      const hook = join(r.dir, ".git", "hooks", "post-commit");
      writeFileSync(hook, "#!/bin/sh\necho late > late.txt\n");
      chmodSync(hook, 0o755);
      writeFileSync(join(created.value.path, "export.ts"), "export {};\n");

      const removed = await plugin.removeWorktree(created.value);
      expect(removed.ok).toBe(false);
      expect(existsSync(join(created.value.path, "late.txt"))).toBe(true);
    });

    // Found by Codex review: saving on a detached HEAD leaves the work on
    // no branch, and removing the worktree then loses it.
    test("refuses to save or remove a worktree that isn't on its task's branch", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      await git(created.value.path, "checkout", "-q", "--detach");
      writeFileSync(join(created.value.path, "export.ts"), "export {};\n");

      const removed = await plugin.removeWorktree(created.value);
      expect(removed.ok).toBe(false);
      expect(existsSync(join(created.value.path, "export.ts"))).toBe(true);
    });

    test("refuses to touch a worktree that belongs to another repository", async () => {
      const r = await repo();
      const other = await repo();
      const created = await make(other).createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      writeFileSync(join(created.value.path, "export.ts"), "export {};\n");

      const removed = await make(r).removeWorktree(created.value);
      expect(removed.ok).toBe(false);
      expect(existsSync(join(created.value.path, "export.ts"))).toBe(true);
      // Nothing was committed in the other repository either.
      expect(await git(other.dir, "rev-parse", "task/12-csv-export")).toBe(
        await git(other.dir, "rev-parse", "main"),
      );
    });

    test("does nothing for a worktree that is already gone", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      await plugin.removeWorktree(created.value);
      expect(await plugin.removeWorktree(created.value)).toEqual({ ok: true, value: null });
    });
  });
}
