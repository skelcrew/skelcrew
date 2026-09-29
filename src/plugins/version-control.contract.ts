// The tests every version-control plugin must pass, run against a
// throwaway git repository. A plugin's own test file calls
// versionControlContract with a way to make one.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    test("names a title with odd characters safely", async () => {
      const r = await repo();
      const created = await make(r).createWorktree({ ...csv, title: "Fix: users' résumé (v2)!" });
      expect(created.ok && created.value.branch).toBe("task/12-fix-users-r-sum-v2");
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
