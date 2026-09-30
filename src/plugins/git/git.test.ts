import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    const name = branchName({ taskId, title: `${"a".repeat(39)} b and more`, build: 1 });
    expect(name).toBe(`task/12-${"a".repeat(39)}`);
  });

  test("uses only the number for a title with no letters or digits", () => {
    expect(branchName({ taskId, title: "!!!", build: 1 })).toBe("task/12");
  });

  // Skelcrew's first real run cut this title to "...-a-whole-pe".
  const discount = "Take a discount off the total: a whole percentage, rounded to the nearest cent";

  test("cuts a long title after its last whole word that fits", () => {
    expect(branchName({ taskId: TaskId.parse(1), title: discount, build: 1 })).toBe(
      "task/1-take-a-discount-off-the-total-a-whole",
    );
  });

  test("adds the build number after the cut title", () => {
    expect(branchName({ taskId: TaskId.parse(1), title: discount, build: 2 })).toBe(
      "task/1-take-a-discount-off-the-total-a-whole-2",
    );
  });

  test("keeps a title of exactly 40 characters whole", () => {
    const title = "Take a discount off the total a whole xy";
    expect(branchName({ taskId, title, build: 1 })).toBe(
      "task/12-take-a-discount-off-the-total-a-whole-xy",
    );
  });

  test("cuts the first word if even that is longer than 40 characters", () => {
    const name = branchName({ taskId, title: `${"a".repeat(45)} b`, build: 1 });
    expect(name).toBe(`task/12-${"a".repeat(40)}`);
  });
});

describe("the worktree folder", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  test("is named like the branch, cut at a whole word", async () => {
    const r = await makeRepo();
    dirs.push(r.dir);
    const created = await new Git(r.dir, r.main).createWorktree({
      taskId: TaskId.parse(1),
      title: "Take a discount off the total: a whole percentage, rounded to the nearest cent",
      build: 1,
    });
    if (!created.ok) throw new Error(created.message);
    expect(created.value.branch).toBe("task/1-take-a-discount-off-the-total-a-whole");
    expect(created.value.path).toBe(
      join(r.dir, ".skelcrew", "worktrees", "1-take-a-discount-off-the-total-a-whole"),
    );
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

// The merge works out the result it must have, spec included, in a
// throwaway staging file in git's folder.
describe("the merge's throwaway staging file", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  // Found in review: the file was named after the merged result, and a
  // crash could leave its lock behind. Every later merge with that result
  // then failed with "A hook changed what the merge holds".
  test("isn't blocked by a lock a crash left, and leaves nothing behind", async () => {
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
    const tree = (await git(r.dir, "merge-tree", "--write-tree", "main", head)).split("\n")[0];
    const stale = `skelcrew-expected-${tree}.lock`;
    writeFileSync(join(r.dir, ".git", stale), "");

    const merged = await plugin.merge(
      {
        taskId,
        title: "CSV export",
        worktree: created.value,
        head,
        file: { path: "docs/specs/12-csv-export.md", text: "# #12 CSV export\n" },
      },
      async () => ({ ok: true, value: null }),
    );
    if (!merged.ok) throw new Error(merged.message);
    expect(await git(r.dir, "show", "main:docs/specs/12-csv-export.md")).toBe("# #12 CSV export");
    const left = readdirSync(join(r.dir, ".git")).filter((f) => f.startsWith("skelcrew-expected"));
    expect(left).toEqual([stale]);
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

// A revert is built in .skelcrew/reverting/<task>, and leaves a receipt in
// git's folder before it moves main, like the merge.
describe("the revert's own worktree and receipt", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  // A repository with task 12 merged. Returns the merge and the task's head.
  async function merged() {
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
    const landed = await plugin.merge(
      { taskId, title: "CSV export", worktree: created.value, head },
      async () => ({ ok: true, value: null }),
    );
    if (!landed.ok) throw new Error(landed.message);
    const request = { taskId, commit: landed.value, reason: "Broke the export" };
    return { r, plugin, request, head };
  }

  test("isn't cleared if the plugin didn't make it, and its work is kept", async () => {
    const { r, plugin, request } = await merged();
    const theirs = join(r.dir, ".skelcrew", "reverting", "12");
    await git(r.dir, "worktree", "add", "-q", "--detach", theirs, "main");
    writeFileSync(join(theirs, "unsaved.txt"), "someone's work\n");
    const before = await git(r.dir, "rev-parse", "main");

    const reverted = await plugin.revert(request);
    expect(reverted.ok).toBe(false);
    expect(existsSync(join(theirs, "unsaved.txt"))).toBe(true);
    expect(await git(r.dir, "rev-parse", "main")).toBe(before);

    await git(r.dir, "worktree", "remove", "--force", theirs);
    expect((await plugin.revert(request)).ok).toBe(true);
  });

  test("is cleared if the plugin's mark says it made it, and the revert goes ahead", async () => {
    const { r, plugin, request } = await merged();
    const leftover = join(r.dir, ".skelcrew", "reverting", "12");
    mkdirSync(join(r.dir, ".git", "skelcrew-reverting"), { recursive: true });
    writeFileSync(join(r.dir, ".git", "skelcrew-reverting", "12"), "");
    await git(r.dir, "worktree", "add", "-q", "--detach", leftover, "main");

    expect((await plugin.revert(request)).ok).toBe(true);
    expect(existsSync(leftover)).toBe(false);
  });

  test("from a try that never moved main, doesn't count as reverted", async () => {
    const { r, plugin, request, head } = await merged();
    // The task's own head is not on main, since the merge squashed it.
    mkdirSync(join(r.dir, ".git", "skelcrew-reverts"), { recursive: true });
    writeFileSync(join(r.dir, ".git", "skelcrew-reverts", `12-${request.commit}`), head);

    const reverted = await plugin.revert(request);
    if (!reverted.ok) throw new Error(reverted.message);
    expect(reverted.value).not.toBe(head);
    expect(await git(r.dir, "ls-tree", "--name-only", "main")).toBe("README.md");
  });
});
