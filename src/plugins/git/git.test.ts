import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommitSha, TaskId } from "../../core/ids";
import { git, makeRepo, type Repo, versionControlContract } from "../version-control.contract";
import { branchName, Git } from "./git";

versionControlContract("git", (repo) => new Git(repo.dir, repo.main));

// How git names branches. Another version-control tool may name them its
// own way, so this isn't part of the contract.
describe("branchName", () => {
  const taskId = TaskId.parse(12);

  test("keeps lowercase letters and digits from the title, joined by dashes", () => {
    expect(branchName({ taskId, title: "Fix: users' résumé (v2)!", build: 1 })).toBe(
      "task/12-fix-users-r-sum-v2",
    );
  });

  test("adds the build number from build 2 on", () => {
    expect(branchName({ taskId, title: "CSV export", build: 2 })).toBe("task/12-csv-export-2");
  });

  test("keeps at most 40 characters of the title, never ending on a dash", () => {
    const name = branchName({ taskId, title: "a".repeat(39) + " b and more", build: 1 });
    expect(name).toBe(`task/12-${"a".repeat(39)}`);
  });

  test("uses only the number for a title with no letters or digits", () => {
    expect(branchName({ taskId, title: "!!!", build: 1 })).toBe("task/12");
  });
});

// If the daemon dies while a worktree is being made, the folder and branch
// can exist without creation having finished. These tests fake that state
// the way the git plugin leaves it: its "creating" mark, and no "finished"
// mark.
describe("a worktree left half made by a crash", () => {
  const csv = { taskId: TaskId.parse(12), title: "CSV export", build: 1 };
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  async function halfMade(): Promise<{ r: Repo; path: string }> {
    const r = await makeRepo();
    dirs.push(r.dir);
    const path = join(r.dir, ".skelcrew", "worktrees", "12-csv-export");
    mkdirSync(join(r.dir, ".git", "skelcrew-creating"), { recursive: true });
    writeFileSync(join(r.dir, ".git", "skelcrew-creating", "12-csv-export"), "");
    await git(r.dir, "worktree", "add", "-q", "-b", "task/12-csv-export", path, "main");
    return { r, path };
  }

  test("is made again from the start, and then counts as made", async () => {
    const { r } = await halfMade();
    const plugin = new Git(r.dir, r.main);
    const created = await plugin.createWorktree(csv);
    if (!created.ok) throw new Error(created.message);
    expect(await plugin.createWorktree(csv)).toEqual(created);
  });

  test("isn't trusted: a step that fails now fails, and leaves nothing behind", async () => {
    const { r, path } = await halfMade();
    const hook = join(r.dir, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    expect((await new Git(r.dir, r.main).createWorktree(csv)).ok).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("is left as it is if anything was written in it", async () => {
    const { r, path } = await halfMade();
    writeFileSync(join(path, "mine.txt"), "someone's work\n");

    expect((await new Git(r.dir, r.main).createWorktree(csv)).ok).toBe(false);
    expect(existsSync(join(path, "mine.txt"))).toBe(true);
  });
});

// The merge leaves a receipt in git's folder before it moves main, naming
// the commit it is about to land. A receipt whose commit never reached
// main, from a try that stopped before moving it, proves nothing.
describe("the merge's receipt", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  test("from a try that never moved main, doesn't count as merged", async () => {
    const r = await makeRepo();
    dirs.push(r.dir);
    const plugin = new Git(r.dir, r.main);
    const taskId = TaskId.parse(12);
    const created = await plugin.createWorktree({ taskId, title: "CSV export", build: 1 });
    if (!created.ok) throw new Error(created.message);
    writeFileSync(join(created.value.path, "a.ts"), "a\n");
    await git(created.value.path, "add", "a.ts");
    await git(created.value.path, "commit", "-q", "-m", "A");
    const head = CommitSha.parse(await git(created.value.path, "rev-parse", "HEAD"));
    mkdirSync(join(r.dir, ".git", "skelcrew-merges"), { recursive: true });
    writeFileSync(join(r.dir, ".git", "skelcrew-merges", `12-${head}`), head);

    const merged = await plugin.merge(
      { taskId, title: "CSV export", worktree: created.value, head },
      async () => ({ ok: true, value: null }),
    );
    if (!merged.ok) throw new Error(merged.message);
    expect(merged.value).not.toBe(head);
    expect(await git(r.dir, "show", "main:a.ts")).toBe("a");
  });
});

// The merge is built in .skelcrew/merging/<task>. Something already at
// that path is only cleared if the plugin's own mark says it put it there.
describe("the merge's own worktree", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  // Found by Codex review: a worktree someone else put there, with work in
  // it, was force-removed.
  test("isn't cleared if the plugin didn't make it, and its work is kept", async () => {
    const r = await makeRepo();
    dirs.push(r.dir);
    const plugin = new Git(r.dir, r.main);
    const created = await plugin.createWorktree({
      taskId: TaskId.parse(12),
      title: "CSV export",
      build: 1,
    });
    if (!created.ok) throw new Error(created.message);
    writeFileSync(join(created.value.path, "a.ts"), "a\n");
    await git(created.value.path, "add", "a.ts");
    await git(created.value.path, "commit", "-q", "-m", "A");
    const head = CommitSha.parse(await git(created.value.path, "rev-parse", "HEAD"));
    const theirs = join(r.dir, ".skelcrew", "merging", "12");
    await git(r.dir, "worktree", "add", "-q", "--detach", theirs, "main");
    writeFileSync(join(theirs, "unsaved.txt"), "someone's work\n");

    const merged = await plugin.merge(
      { taskId: TaskId.parse(12), title: "CSV export", worktree: created.value, head },
      async () => ({ ok: true, value: null }),
    );
    expect(merged.ok).toBe(false);
    expect(existsSync(join(theirs, "unsaved.txt"))).toBe(true);
  });
});
