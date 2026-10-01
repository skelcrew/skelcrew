// The tests every version-control plugin must pass, run against a
// throwaway git repository. A plugin's own test file calls
// versionControlContract with a way to make one.
//
// For now, Skelcrew assumes a git repository, to keep things simple (see
// the spec's Plugins notes). A plugin changes how git is used, not whether.
// So these tests set up their cases, and check the results, through git.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { $ } from "bun";
import { CommitSha, TaskId } from "../core/ids";
import type { RunChecks, VersionControl } from "./version-control";

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

// Makes git refuse to move main, the way a lock held by another git process
// would, after it has already updated your checkout. Returns how to undo it.
function blockMain(r: Repo): () => void {
  const hook = join(r.dir, ".git", "hooks", "reference-transaction");
  writeFileSync(
    hook,
    '#!/bin/sh\nwhile read old new ref; do\n  if [ "$1" = prepared ] && [ "$ref" = refs/heads/main ]; then exit 1; fi\ndone\nexit 0\n',
  );
  chmodSync(hook, 0o755);
  return () => rmSync(hook);
}

// Moves a worktree's folder aside, which git doesn't notice, and puts a
// separate repository at its old path, on the same branch name.
async function strangerAt(path: string): Promise<void> {
  renameSync(path, `${path}-moved`);
  mkdirSync(path);
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
    "Theirs",
  );
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

    // Found by Codex review: a tag of the same name must not stand in for
    // the branch in the safety check.
    test("refuses a branch with commits not on main, even with a same-named tag on main", async () => {
      const r = await repo();
      await git(r.dir, "tag", "task/12-csv-export");
      await git(r.dir, "checkout", "-q", "-b", "task/12-csv-export");
      writeFileSync(join(r.dir, "unrelated.txt"), "someone else's work\n");
      await git(r.dir, "add", "unrelated.txt");
      await git(r.dir, "commit", "-q", "-m", "Unrelated");
      await git(r.dir, "checkout", "-q", "main");
      const before = await git(r.dir, "rev-parse", "refs/heads/task/12-csv-export");

      const created = await make(r).createWorktree(csv);
      expect(created.ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "refs/heads/task/12-csv-export")).toBe(before);
    });

    // Found by Codex review: git can still list a worktree whose folder was
    // moved away, while another repository sits at its old path.
    test("refuses another repository at the path of a worktree that was moved away", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      await strangerAt(created.value.path);

      expect((await plugin.createWorktree(csv)).ok).toBe(false);
    });

    // Found by Codex review: with a same-named tag, git spells the branch
    // "heads/task/12-csv-export", which must still count as the branch.
    test("works the same with a tag of the branch's name in the repository", async () => {
      const r = await repo();
      await git(r.dir, "tag", "task/12-csv-export");
      const plugin = make(r);
      const first = await plugin.createWorktree(csv);
      if (!first.ok) throw new Error(first.message);
      expect(await plugin.createWorktree(csv)).toEqual(first);
      expect(await plugin.removeWorktree(first.value)).toEqual({ ok: true, value: null });
    });

    // Found by Codex review: git runs inside the repository, so a relative
    // path given to the plugin must not end up doubled.
    test("gives back a worktree path that exists, even for a relative repository path", async () => {
      const r = await repo();
      const created = await make({ ...r, dir: relative(process.cwd(), r.dir) }).createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      expect(isAbsolute(created.value.path)).toBe(true);
      expect(existsSync(join(created.value.path, "README.md"))).toBe(true);
    });

    // Found by Codex review: git can fail after it made the worktree, here
    // in a hook. The core then records no worktree, so none may be left.
    test("leaves nothing behind when creation fails partway, and fails again if asked again", async () => {
      const r = await repo();
      const hook = join(r.dir, ".git", "hooks", "post-checkout");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);
      const plugin = make(r);

      expect((await plugin.createWorktree(csv)).ok).toBe(false);
      expect(existsSync(join(r.dir, ".skelcrew", "worktrees", "12-csv-export"))).toBe(false);
      expect(await git(r.dir, "worktree", "list", "--porcelain")).not.toContain("12-csv-export");
      expect(await git(r.dir, "branch", "--list", "task/12-csv-export")).toBe("");
      expect((await plugin.createWorktree(csv)).ok).toBe(false);
    });

    // Found by Codex review: a second call for the same worktree must not
    // take away the first call's worktree when it fails.
    test("gives two calls at once for the same worktree the same answer", async () => {
      const r = await repo();
      const plugin = make(r);
      const [first, second] = await Promise.all([
        plugin.createWorktree(csv),
        plugin.createWorktree(csv),
      ]);
      if (!first.ok) throw new Error(first.message);
      expect(second).toEqual(first);
      expect(existsSync(join(first.value.path, "README.md"))).toBe(true);
    });

    // Found by Codex review: a worktree at the right path and branch, made
    // by someone else, is theirs. Its work must never be removed.
    test("refuses a worktree it didn't make at its path, and keeps the work in it", async () => {
      const r = await repo();
      const path = join(r.dir, ".skelcrew", "worktrees", "12-csv-export");
      await git(r.dir, "worktree", "add", "-q", "-b", "task/12-csv-export", path, "main");
      writeFileSync(join(path, "mine.txt"), "someone's work\n");

      expect((await make(r).createWorktree(csv)).ok).toBe(false);
      expect(readFileSync(join(path, "mine.txt"), "utf8")).toBe("someone's work\n");
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

  describe(`${name}: createSpecWorktree`, () => {
    const spec = { taskId: TaskId.parse(12), title: "CSV export" };

    test("makes a copy of main to write the spec in, on no branch", async () => {
      const r = await repo();
      const branches = await git(r.dir, "branch", "--list");
      const created = await make(r).createSpecWorktree(spec);
      if (!created.ok) throw new Error(created.message);
      expect(existsSync(join(created.value.path, "README.md"))).toBe(true);
      expect(await git(created.value.path, "rev-parse", "HEAD")).toBe(
        await git(r.dir, "rev-parse", "main"),
      );
      expect(await git(created.value.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      expect(await git(r.dir, "branch", "--list")).toBe(branches);
    });

    test("starts from main, whatever the repository has checked out", async () => {
      const r = await repo();
      await git(r.dir, "checkout", "-q", "-b", "elsewhere");
      writeFileSync(join(r.dir, "other.txt"), "not on main\n");
      await git(r.dir, "add", "other.txt");
      await git(r.dir, "commit", "-q", "-m", "Elsewhere");

      const created = await make(r).createSpecWorktree(spec);
      if (!created.ok) throw new Error(created.message);
      expect(existsSync(join(created.value.path, "other.txt"))).toBe(false);
    });

    // A spec agent may already be reading it when the request comes again,
    // such as after a restart.
    test("asked twice, gives back the same copy and changes nothing in it", async () => {
      const r = await repo();
      const plugin = make(r);
      const first = await plugin.createSpecWorktree(spec);
      if (!first.ok) throw new Error(first.message);
      writeFileSync(join(first.value.path, "notes.txt"), "the agent's notes\n");
      expect(await plugin.createSpecWorktree(spec)).toEqual(first);
      expect(readFileSync(join(first.value.path, "notes.txt"), "utf8")).toBe("the agent's notes\n");
    });

    test("gives two calls at once the same answer", async () => {
      const r = await repo();
      const plugin = make(r);
      const [first, second] = await Promise.all([
        plugin.createSpecWorktree(spec),
        plugin.createSpecWorktree(spec),
      ]);
      if (!first.ok) throw new Error(first.message);
      expect(second).toEqual(first);
    });

    test("sits beside the build's worktree for the same task", async () => {
      const r = await repo();
      const plugin = make(r);
      const specced = await plugin.createSpecWorktree(spec);
      const built = await plugin.createWorktree(csv);
      if (!specced.ok) throw new Error(specced.message);
      if (!built.ok) throw new Error(built.message);
      expect(specced.value.path).not.toBe(built.value.path);
      expect(existsSync(join(specced.value.path, "README.md"))).toBe(true);
    });

    test("keeps the repository's own checkout clean", async () => {
      const r = await repo();
      const created = await make(r).createSpecWorktree(spec);
      if (!created.ok) throw new Error(created.message);
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
    });

    test("refuses a folder at its path that it didn't make, and keeps the work in it", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createSpecWorktree(spec);
      if (!created.ok) throw new Error(created.message);
      const { path } = created.value;
      expect(await plugin.removeSpecWorktree(created.value)).toEqual({ ok: true, value: null });
      await git(r.dir, "worktree", "add", "-q", "--detach", path, "main");
      writeFileSync(join(path, "mine.txt"), "someone's work\n");

      expect((await plugin.createSpecWorktree(spec)).ok).toBe(false);
      expect(readFileSync(join(path, "mine.txt"), "utf8")).toBe("someone's work\n");
    });

    test("fails with a message, not a throw, when main doesn't exist", async () => {
      const r = await repo();
      const created = await make({ ...r, main: "trunk" }).createSpecWorktree(spec);
      expect(created.ok).toBe(false);
      expect(!created.ok && created.message).toContain("trunk");
    });
  });

  describe(`${name}: removeSpecWorktree`, () => {
    const spec = { taskId: TaskId.parse(12), title: "CSV export" };

    // Nothing written while speccing is kept: the spec itself goes to
    // Skelcrew, not into a file.
    test("removes the copy and anything changed in it, and saves nothing", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createSpecWorktree(spec);
      if (!created.ok) throw new Error(created.message);
      writeFileSync(join(created.value.path, "README.md"), "# Edited\n");
      writeFileSync(join(created.value.path, "notes.txt"), "notes\n");
      const main = await git(r.dir, "rev-parse", "main");
      const branches = await git(r.dir, "branch", "--list");

      expect(await plugin.removeSpecWorktree(created.value)).toEqual({ ok: true, value: null });
      expect(existsSync(created.value.path)).toBe(false);
      expect(await git(r.dir, "worktree", "list", "--porcelain")).not.toContain(created.value.path);
      expect(await git(r.dir, "rev-parse", "main")).toBe(main);
      expect(await git(r.dir, "branch", "--list")).toBe(branches);
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
    });

    test("removing one that is already gone does nothing", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createSpecWorktree(spec);
      if (!created.ok) throw new Error(created.message);
      await plugin.removeSpecWorktree(created.value);
      expect(await plugin.removeSpecWorktree(created.value)).toEqual({ ok: true, value: null });
    });

    test("leaves a folder at its path that it didn't make, and the work in it", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createSpecWorktree(spec);
      if (!created.ok) throw new Error(created.message);
      const { path } = created.value;
      await plugin.removeSpecWorktree(created.value);
      await git(r.dir, "worktree", "add", "-q", "--detach", path, "main");
      writeFileSync(join(path, "mine.txt"), "someone's work\n");

      expect((await plugin.removeSpecWorktree(created.value)).ok).toBe(false);
      expect(readFileSync(join(path, "mine.txt"), "utf8")).toBe("someone's work\n");
    });
  });

  describe(`${name}: readBranch`, () => {
    // A worktree with the given files committed, one commit each.
    async function worked(r: Repo, files: Record<string, string>) {
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(created.value.path, file)), { recursive: true });
        writeFileSync(join(created.value.path, file), text);
        await git(created.value.path, "add", file);
        await git(created.value.path, "commit", "-q", "-m", `Add ${file}`);
      }
      return { plugin, worktree: created.value };
    }

    test("reads the head commit, the branch's own commits, and the files it changed", async () => {
      const r = await repo();
      const { plugin, worktree } = await worked(r, {
        "src/export.ts": "export {};\n",
        "src/auth/login.ts": "login\n",
      });
      expect(await plugin.readBranch(worktree)).toEqual({
        ok: true,
        value: {
          head: CommitSha.parse(await git(worktree.path, "rev-parse", "HEAD")),
          commits: 2,
          changedFiles: ["src/auth/login.ts", "src/export.ts"],
        },
      });
    });

    test("counts only the branch's own work after main moves on", async () => {
      const r = await repo();
      const { plugin, worktree } = await worked(r, { "src/export.ts": "export {};\n" });
      writeFileSync(join(r.dir, "later.txt"), "on main\n");
      await git(r.dir, "add", "later.txt");
      await git(r.dir, "commit", "-q", "-m", "Later on main");

      const read = await plugin.readBranch(worktree);
      expect(read.ok && read.value.commits).toBe(1);
      expect(read.ok && read.value.changedFiles).toEqual(["src/export.ts"]);
    });

    test("lists a renamed file under both names, so moving it out of a folder still counts", async () => {
      const r = await repo();
      const { plugin, worktree } = await worked(r, {});
      await git(worktree.path, "mv", "README.md", "docs.md");
      await git(worktree.path, "commit", "-q", "-m", "Rename");

      const read = await plugin.readBranch(worktree);
      expect(read.ok && read.value.changedFiles).toEqual(["README.md", "docs.md"]);
    });

    test("keeps file names exactly, spaces and accents included", async () => {
      const r = await repo();
      const { plugin, worktree } = await worked(r, { "notes/résumé plan.md": "x\n" });
      const read = await plugin.readBranch(worktree);
      expect(read.ok && read.value.changedFiles).toEqual(["notes/résumé plan.md"]);
    });

    test("reads no commits and no files for a branch nobody has worked on", async () => {
      const r = await repo();
      const { plugin, worktree } = await worked(r, {});
      expect(await plugin.readBranch(worktree)).toEqual({
        ok: true,
        value: {
          head: CommitSha.parse(await git(r.dir, "rev-parse", "main")),
          commits: 0,
          changedFiles: [],
        },
      });
    });

    test("refuses while there is uncommitted work, which the gates would never see", async () => {
      const r = await repo();
      const { plugin, worktree } = await worked(r, { "src/export.ts": "export {};\n" });
      writeFileSync(join(worktree.path, "src/export.ts"), "export const x = 1;\n");
      const read = await plugin.readBranch(worktree);
      expect(read.ok).toBe(false);
      expect(!read.ok && read.message).toContain("commit");
    });

    test("refuses a worktree that isn't on its task's branch", async () => {
      const r = await repo();
      const { plugin, worktree } = await worked(r, { "src/export.ts": "export {};\n" });
      await git(worktree.path, "checkout", "-q", "--detach");
      expect((await plugin.readBranch(worktree)).ok).toBe(false);
    });

    test("fails with a message, not a throw, for a worktree that is gone", async () => {
      const r = await repo();
      const { plugin, worktree } = await worked(r, {});
      await plugin.removeWorktree(worktree);
      expect((await plugin.readBranch(worktree)).ok).toBe(false);
    });
  });

  describe(`${name}: checkCommit`, () => {
    // A worktree with export.csv committed, and its head commit.
    async function committed(r: Repo) {
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      const worktree = created.value;
      writeFileSync(join(worktree.path, "export.csv"), "committed\n");
      await git(worktree.path, "add", "export.csv");
      await git(worktree.path, "commit", "-q", "-m", "Export");
      const head = CommitSha.parse(await git(worktree.path, "rev-parse", "HEAD"));
      return { plugin, worktree, head };
    }

    // Found while dogfooding: while checks ran, their copy showed up in
    // `git status`, and `git add -A` picked it up as an embedded repository.
    test("keeps its copy out of git in the repository while the checks run", async () => {
      const r = await repo();
      const { plugin, head } = await committed(r);
      let status = "not read";
      let staged = "not read";
      await plugin.checkCommit({ taskId: csv.taskId, head }, async () => {
        status = await git(r.dir, "status", "--porcelain");
        staged = await git(r.dir, "add", "--all", "--dry-run");
        return { ok: true, value: null };
      });
      expect(status).toBe("");
      expect(staged).toBe("");
    });

    test("lists its copy's folder in git's ignore list once, however often it checks", async () => {
      const r = await repo();
      const { plugin, head } = await committed(r);
      const passes: RunChecks = async () => ({ ok: true, value: null });
      await plugin.checkCommit({ taskId: csv.taskId, head }, passes);
      await plugin.checkCommit({ taskId: csv.taskId, head }, passes);
      const exclude = join(r.dir, await git(r.dir, "rev-parse", "--git-path", "info/exclude"));
      const lines = readFileSync(exclude, "utf8").split("\n");
      expect(lines.filter((line) => line === "/.skelcrew/checking/")).toHaveLength(1);
    });

    test("runs the checks on exactly the commit, not on uncommitted edits", async () => {
      const r = await repo();
      const { plugin, worktree, head } = await committed(r);
      writeFileSync(join(worktree.path, "export.csv"), "edited, not committed\n");
      let seen = "";
      const checked = await plugin.checkCommit({ taskId: csv.taskId, head }, async (dir) => {
        seen = readFileSync(join(dir, "export.csv"), "utf8");
        return { ok: true, value: null };
      });
      expect(checked).toEqual({ ok: true, value: null });
      expect(seen).toBe("committed\n");
    });

    test("passes on the checks' failure", async () => {
      const r = await repo();
      const { plugin, head } = await committed(r);
      expect(
        await plugin.checkCommit({ taskId: csv.taskId, head }, async () => ({
          ok: false,
          message: "bun test failed.",
        })),
      ).toEqual({ ok: false, message: "bun test failed." });
    });

    test("leaves the task's worktree alone, and removes its copy, even when the checks write files", async () => {
      const r = await repo();
      const { plugin, worktree, head } = await committed(r);
      let copy = "";
      await plugin.checkCommit({ taskId: csv.taskId, head }, async (dir) => {
        copy = dir;
        writeFileSync(join(dir, "coverage.txt"), "95%\n");
        return { ok: false, message: "failed" };
      });
      expect(copy).not.toBe(worktree.path);
      expect(existsSync(copy)).toBe(false);
      expect(existsSync(join(worktree.path, "coverage.txt"))).toBe(false);
      expect(await git(worktree.path, "status", "--porcelain")).toBe("");
    });

    // Found by review: a check that left a read-only folder in the copy
    // made its removal fail halfway, and every later check of the task
    // failed until someone deleted the folder by hand.
    test("removes its copy even when the checks leave a read-only folder", async () => {
      const r = await repo();
      const { plugin, head } = await committed(r);
      let copy = "";
      const locked: RunChecks = async (dir) => {
        copy = dir;
        mkdirSync(join(dir, "cache", "module"), { recursive: true });
        writeFileSync(join(dir, "cache", "module", "file.go"), "package m\n");
        chmodSync(join(dir, "cache", "module"), 0o555);
        chmodSync(join(dir, "cache"), 0o555);
        return { ok: true, value: null };
      };
      expect(await plugin.checkCommit({ taskId: csv.taskId, head }, locked)).toEqual({
        ok: true,
        value: null,
      });
      expect(existsSync(copy)).toBe(false);
      expect(await plugin.checkCommit({ taskId: csv.taskId, head }, locked)).toEqual({
        ok: true,
        value: null,
      });
    });

    test("says so when the commit doesn't exist", async () => {
      const r = await repo();
      const plugin = make(r);
      const missing = CommitSha.parse("0".repeat(40));
      const checked = await plugin.checkCommit({ taskId: csv.taskId, head: missing }, async () => ({
        ok: true,
        value: null,
      }));
      expect(checked.ok).toBe(false);
    });
  });

  // Before a merge is approved: your own edits in a checkout of main would
  // stop main from moving, through no fault of the task's work.
  describe(`${name}: uncommittedOnMain`, () => {
    test("lists the files you changed but didn't commit in your checkout of main", async () => {
      const r = await repo();
      writeFileSync(join(r.dir, "README.md"), "# Edited\n");
      expect(await make(r).uncommittedOnMain()).toEqual({ ok: true, value: ["README.md"] });
    });

    test("lists nothing when your checkout of main is clean", async () => {
      const r = await repo();
      expect(await make(r).uncommittedOnMain()).toEqual({ ok: true, value: [] });
    });

    test("leaves out files git doesn't track", async () => {
      const r = await repo();
      writeFileSync(join(r.dir, "notes.txt"), "mine\n");
      expect(await make(r).uncommittedOnMain()).toEqual({ ok: true, value: [] });
    });

    test("lists nothing when main isn't checked out anywhere", async () => {
      const r = await repo();
      await git(r.dir, "checkout", "-q", "--detach");
      writeFileSync(join(r.dir, "README.md"), "# Edited\n");
      expect(await make(r).uncommittedOnMain()).toEqual({ ok: true, value: [] });
    });
  });

  describe(`${name}: merge`, () => {
    const pass: RunChecks = async () => ({ ok: true, value: null });

    // A worktree with the given files committed, one commit each. Returns
    // the head after each commit.
    async function built(r: Repo, files: Record<string, string>) {
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      const heads: CommitSha[] = [];
      for (const [file, text] of Object.entries(files)) {
        writeFileSync(join(created.value.path, file), text);
        await git(created.value.path, "--literal-pathspecs", "add", file);
        await git(created.value.path, "commit", "-q", "-m", `Add ${file}`);
        heads.push(CommitSha.parse(await git(created.value.path, "rev-parse", "HEAD")));
      }
      const request = (head: CommitSha) => ({ ...csv, worktree: created.value, head });
      return { plugin, heads, request };
    }

    async function commitOnMain(r: Repo, file: string, text: string) {
      writeFileSync(join(r.dir, file), text);
      await git(r.dir, "add", file);
      await git(r.dir, "commit", "-q", "-m", `Add ${file} on main`);
    }

    test("lands the work on main as one new commit, named after the task", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n", "b.ts": "b\n" });
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[1];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), pass);
      if (!merged.ok) throw new Error(merged.message);
      expect(await git(r.dir, "rev-parse", "main")).toBe(merged.value);
      expect(await git(r.dir, "rev-parse", "main^")).toBe(before);
      expect(await git(r.dir, "log", "-1", "--format=%s", "main")).toBe("#12 CSV export");
      expect(await git(r.dir, "show", "main:b.ts")).toBe("b");
    });

    test("lands exactly the reported commit, never one made after it", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n", "late.ts": "late\n" });
      const reported = heads[0];
      if (reported === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(reported), pass);
      if (!merged.ok) throw new Error(merged.message);
      expect(await git(r.dir, "show", "main:a.ts")).toBe("a");
      expect(await git(r.dir, "ls-tree", "--name-only", "main")).not.toContain("late.ts");
    });

    test("brings the work up to date with main, and runs the checks on the result", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      await commitOnMain(r, "newer.ts", "newer\n");
      const seen: boolean[] = [];
      const checks: RunChecks = async (dir) => {
        seen.push(existsSync(join(dir, "newer.ts")) && existsSync(join(dir, "a.ts")));
        return { ok: true, value: null };
      };
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), checks);
      expect(merged.ok).toBe(true);
      expect(seen).toEqual([true]);
      expect(await git(r.dir, "ls-tree", "--name-only", "main")).toContain("newer.ts");
    });

    test("leaves main as it was when the checks fail, and says why", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const before = await git(r.dir, "rev-parse", "main");
      const failing: RunChecks = async () => ({ ok: false, message: "2 tests failed" });
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), failing);
      expect(merged.ok).toBe(false);
      expect(!merged.ok && merged.message).toContain("2 tests failed");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("leaves main as it was on a conflict, and names the file", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "branch\n" });
      await commitOnMain(r, "a.ts", "main\n");
      const before = await git(r.dir, "rev-parse", "main");
      const worktrees = await git(r.dir, "worktree", "list");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), pass);
      expect(merged.ok).toBe(false);
      expect(!merged.ok && merged.message).toContain("a.ts");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
      expect(await git(r.dir, "worktree", "list")).toBe(worktrees);
    });

    test("asked again after it succeeded, gives back the same commit and merges nothing twice", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const head = heads[0];
      if (head === undefined) throw new Error("no head");
      const first = await plugin.merge(request(head), pass);
      let ranAgain = false;
      const second = await plugin.merge(request(head), async () => {
        ranAgain = true;
        return { ok: true, value: null };
      });
      expect(second).toEqual(first);
      expect(ranAgain).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(first.ok ? first.value : "");
    });

    test("updates your checkout of main, which stays clean", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(true);
      expect(readFileSync(join(r.dir, "a.ts"), "utf8")).toBe("a\n");
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
    });

    // Found by Codex review: a check that changes the code tests something
    // other than what would land.
    test("refuses when the checks change the code they are checking", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "broken\n" });
      const before = await git(r.dir, "rev-parse", "main");
      const fixing: RunChecks = async (dir) => {
        writeFileSync(join(dir, "a.ts"), "fixed\n");
        return { ok: true, value: null };
      };
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), fixing);
      expect(merged.ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("refuses when the checks commit something of their own", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const before = await git(r.dir, "rev-parse", "main");
      const committing: RunChecks = async (dir) => {
        writeFileSync(join(dir, "extra.ts"), "extra\n");
        await git(dir, "add", "extra.ts");
        await git(dir, "commit", "-q", "-m", "Extra");
        return { ok: true, value: null };
      };
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), committing)).ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("lets the checks leave build output behind", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const building: RunChecks = async (dir) => {
        writeFileSync(join(dir, "coverage.txt"), "100%\n");
        return { ok: true, value: null };
      };
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), building)).ok).toBe(true);
    });

    // Found by Codex review: text in a commit message is no proof that the
    // task merged.
    test("isn't fooled by a commit message that names the task's commit", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const head = heads[0];
      if (head === undefined) throw new Error("no head");
      await git(
        r.dir,
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "Note",
        "-m",
        `Skelcrew-Head: ${head}`,
      );

      const merged = await plugin.merge(request(head), pass);
      expect(merged.ok).toBe(true);
      expect(await git(r.dir, "show", "main:a.ts")).toBe("a");
    });

    // Found by Codex review: git can fail after it made the merge's own
    // worktree, for example in a hook.
    test("leaves nothing behind when preparing the merge fails partway", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const worktrees = await git(r.dir, "worktree", "list");
      const hook = join(r.dir, ".git", "hooks", "post-checkout");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      expect(await git(r.dir, "worktree", "list")).toBe(worktrees);
    });

    // Found by Codex review: git overwrites an ignored file by default when
    // the incoming commit tracks the same path.
    test("never overwrites an ignored file in your checkout of main", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "secret.env": "from the task\n" });
      writeFileSync(join(r.dir, ".git", "info", "exclude"), "secret.env\n", { flag: "a" });
      writeFileSync(join(r.dir, "secret.env"), "my unsaved secret\n");
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      expect(readFileSync(join(r.dir, "secret.env"), "utf8")).toBe("my unsaved secret\n");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found by Codex review: a commit hook can add something the task never
    // had, and nobody approved.
    test("refuses when a commit hook changes what gets committed", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const hook = join(r.dir, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\necho extra > extra.txt\ngit add extra.txt\n");
      chmodSync(hook, 0o755);
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found by Codex review: git hides changes to files marked
    // assume-unchanged, so a check could change one unseen.
    test("refuses when the checks hide a change from git", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "broken\n" });
      const before = await git(r.dir, "rev-parse", "main");
      const hiding: RunChecks = async (dir) => {
        await git(dir, "update-index", "--assume-unchanged", "a.ts");
        writeFileSync(join(dir, "a.ts"), "fixed\n");
        return { ok: true, value: null };
      };
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), hiding)).ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found by review: during a rebase git lists your checkout as detached,
    // and aborting the rebase would take the merge off main again.
    test("refuses while you are rebasing main", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      await git(r.dir, "checkout", "-q", "-b", "other");
      await commitOnMain(r, "README.md", "# Other\n");
      await git(r.dir, "checkout", "-q", "main");
      await commitOnMain(r, "README.md", "# Mine\n");
      await $`git rebase other`.cwd(r.dir).nothrow().quiet();
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found by review: main moved back during the checks, and the merge put
    // the removed commit back.
    test("refuses when main moved while the checks ran", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      await commitOnMain(r, "bad.txt", "bad\n");
      const resetting: RunChecks = async () => {
        await git(r.dir, "reset", "-q", "--hard", "HEAD~1");
        return { ok: true, value: null };
      };
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), resetting)).ok).toBe(false);
      expect(await git(r.dir, "ls-tree", "--name-only", "main")).not.toContain("bad.txt");
    });

    // Found by review: a hook moved main to the merge itself, and the merge
    // then said main had moved and nothing was merged.
    test("succeeds when a hook already moved main to exactly the merge", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const hook = join(r.dir, ".git", "hooks", "post-commit");
      writeFileSync(hook, "#!/bin/sh\ngit update-ref refs/heads/main HEAD\n");
      chmodSync(hook, 0o755);
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), pass);
      rmSync(hook);
      if (!merged.ok) throw new Error(merged.message);
      expect(await git(r.dir, "rev-parse", "main")).toBe(merged.value);
      expect(await git(r.dir, "rev-parse", "main^")).toBe(before);
      expect(await git(r.dir, "show", "main:a.ts")).toBe("a");
    });

    // Found by review: with merge.autoStash, git stashes your edits instead
    // of refusing, and can put them back with conflict markers.
    test("never stashes your edits, even when git is set to", async () => {
      const r = await repo();
      await git(r.dir, "config", "merge.autoStash", "true");
      const { plugin, heads, request } = await built(r, { "README.md": "# From the task\n" });
      writeFileSync(join(r.dir, "README.md"), "# My edit\n");
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      expect(readFileSync(join(r.dir, "README.md"), "utf8")).toBe("# My edit\n");
      expect(await git(r.dir, "stash", "list")).toBe("");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found by review: git can update your files, then fail to move main.
    test("puts your checkout back when main can't be moved", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const hook = join(r.dir, ".git", "hooks", "reference-transaction");
      writeFileSync(
        hook,
        '#!/bin/sh\nwhile read old new ref; do\n  if [ "$1" = prepared ] && [ "$ref" = refs/heads/main ]; then exit 1; fi\ndone\nexit 0\n',
      );
      chmodSync(hook, 0o755);
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      rmSync(hook);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
      expect(existsSync(join(r.dir, "a.ts"))).toBe(false);
    });

    // Found by review: only one checkout of main would be updated, and the
    // other would show the merge undone.
    test("refuses when main is checked out in more than one place", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const second = join(r.dir, ".skelcrew", "second-main");
      await git(r.dir, "worktree", "add", "-q", "-f", second, "main");
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found by review: with an edit of yours staged, a failed move left the
    // task's files staged next to it.
    test("puts your checkout back when main can't be moved, keeping your staged edit", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      writeFileSync(join(r.dir, "notes.txt"), "mine\n");
      await git(r.dir, "add", "notes.txt");
      const hook = join(r.dir, ".git", "hooks", "reference-transaction");
      writeFileSync(
        hook,
        '#!/bin/sh\nwhile read old new ref; do\n  if [ "$1" = prepared ] && [ "$ref" = refs/heads/main ]; then exit 1; fi\ndone\nexit 0\n',
      );
      chmodSync(hook, 0o755);
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), pass);
      rmSync(hook);
      expect(merged.ok).toBe(false);
      expect(!merged.ok && merged.message).toContain("put back");
      expect(await git(r.dir, "status", "--porcelain")).toBe("A  notes.txt");
      expect(existsSync(join(r.dir, "a.ts"))).toBe(false);
    });

    test("says your checkout is as it was when git refused before touching it", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "README.md": "# From the task\n" });
      writeFileSync(join(r.dir, "notes.txt"), "mine\n");
      await git(r.dir, "add", "notes.txt");
      writeFileSync(join(r.dir, "README.md"), "# My edit\n");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), pass);
      expect(merged.ok).toBe(false);
      expect(!merged.ok && merged.message).toContain("as it was");
      expect(!merged.ok && merged.message).not.toContain("git status");
    });

    // Found by review: a post-checkout hook staged a file while the merge's
    // own worktree was made, and it landed.
    test("refuses when a hook adds something while the merge is prepared", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const hook = join(r.dir, ".git", "hooks", "post-checkout");
      writeFileSync(hook, "#!/bin/sh\necho x > injected.txt\ngit add injected.txt\n");
      chmodSync(hook, 0o755);
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found by review: a post-commit hook added a second commit, and both
    // landed on main.
    test("refuses when a hook adds a commit of its own", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      const hook = join(r.dir, ".git", "hooks", "post-commit");
      // It commits once: the variable stops its own commit running it again.
      writeFileSync(
        hook,
        '#!/bin/sh\n[ -n "$IN_HOOK" ] && exit 0\nIN_HOOK=1 git commit -q --allow-empty -m "extra from hook"\n',
      );
      chmodSync(hook, 0o755);
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found by review: on macOS, "Main" finds the branch "main", but the
    // guards compared names exactly and found no checkout of it.
    test("refuses a main branch name that matches only when case is ignored", async () => {
      const r = await repo();
      const { heads, request } = await built(r, { "a.ts": "a\n" });
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const wrongCase = make({ ...r, main: "Main" });
      expect((await wrongCase.merge(request(head), pass)).ok).toBe(false);
      expect((await wrongCase.createWorktree({ ...csv, build: 2 })).ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found by review: git reads a file name as a pattern, and a leading
    // ":" is special, so the put-back looked for the wrong file.
    test("puts back a file whose name starts with a colon", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { ":colon.txt": "task\n" });
      const unblock = blockMain(r);
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      unblock();
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
      expect(existsSync(join(r.dir, ":colon.txt"))).toBe(false);
    });

    // Found by review: "pages/[id].tsx" also matches "pages/i.tsx" as a
    // pattern, and your staged edit to the second was reset.
    test("keeps your staged edit to a file a pattern in the task's file name would match", async () => {
      const r = await repo();
      mkdirSync(join(r.dir, "pages"));
      await commitOnMain(r, "pages/[id].tsx", "id\n");
      await commitOnMain(r, "pages/i.tsx", "i\n");
      const { plugin, heads, request } = await built(r, { "pages/[id].tsx": "task\n" });
      writeFileSync(join(r.dir, "pages", "i.tsx"), "my edit\n");
      await git(r.dir, "add", "pages/i.tsx");
      const unblock = blockMain(r);
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      unblock();
      expect(await git(r.dir, "status", "--porcelain")).toBe("M  pages/i.tsx");
      expect(readFileSync(join(r.dir, "pages", "[id].tsx"), "utf8")).toBe("id\n");
    });

    // Found by review: a change you had staged yourself, the same as the
    // task's, was taken for git's and wiped.
    test("keeps your own staged change even when it matches the task's", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "README.md": "# Same\n" });
      writeFileSync(join(r.dir, "README.md"), "# Same\n");
      await git(r.dir, "add", "README.md");
      const unblock = blockMain(r);
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      unblock();
      expect(await git(r.dir, "status", "--porcelain")).toBe("M  README.md");
      expect(readFileSync(join(r.dir, "README.md"), "utf8")).toBe("# Same\n");
    });

    // Found by review: a task that turned a file into a folder wasn't put
    // back.
    test("puts back a task that turned a file into a folder", async () => {
      const r = await repo();
      await commitOnMain(r, "config", "file\n");
      const { plugin, request } = await built(r, {});
      const worktree = request(CommitSha.parse("0".repeat(40))).worktree;
      await git(worktree.path, "rm", "-q", "config");
      mkdirSync(join(worktree.path, "config"));
      writeFileSync(join(worktree.path, "config", "app.json"), "{}\n");
      await git(worktree.path, "add", "config/app.json");
      await git(worktree.path, "commit", "-q", "-m", "Folder");
      const head = CommitSha.parse(await git(worktree.path, "rev-parse", "HEAD"));
      const unblock = blockMain(r);

      expect((await plugin.merge(request(head), pass)).ok).toBe(false);
      unblock();
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
      expect(readFileSync(join(r.dir, "config"), "utf8")).toBe("file\n");
    });

    // Found by review: the expected merge was worked out with the
    // .gitattributes of your checkout, not main's, which the merge uses.
    test("lands a valid merge whatever your checkout's .gitattributes say", async () => {
      const r = await repo();
      await commitOnMain(r, ".gitattributes", "CHANGELOG.md merge=union\n");
      await commitOnMain(r, "CHANGELOG.md", "one\n");
      const { plugin, request } = await built(r, {});
      const worktree = request(CommitSha.parse("0".repeat(40))).worktree;
      writeFileSync(join(worktree.path, "CHANGELOG.md"), "one\nfrom the task\n");
      await git(worktree.path, "commit", "-q", "-am", "Task line");
      const head = CommitSha.parse(await git(worktree.path, "rev-parse", "HEAD"));
      writeFileSync(join(r.dir, "CHANGELOG.md"), "one\nfrom main\n");
      await git(r.dir, "commit", "-q", "-am", "Main line");
      await git(r.dir, "checkout", "-q", "-b", "old", "main~3");

      const merged = await plugin.merge(request(head), pass);
      if (!merged.ok) throw new Error(merged.message);
      const changelog = await git(r.dir, "show", "main:CHANGELOG.md");
      expect(changelog).toContain("from the task");
      expect(changelog).toContain("from main");
    });

    test("moves main when no checkout has it open", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "a.ts": "a\n" });
      await git(r.dir, "checkout", "-q", "--detach");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), pass);
      if (!merged.ok) throw new Error(merged.message);
      expect(await git(r.dir, "rev-parse", "main")).toBe(merged.value);
    });

    test("never overwrites your uncommitted edits in your checkout of main", async () => {
      const r = await repo();
      const { plugin, heads, request } = await built(r, { "README.md": "# From the task\n" });
      writeFileSync(join(r.dir, "README.md"), "# My edit\n");
      const before = await git(r.dir, "rev-parse", "main");
      const head = heads[0];
      if (head === undefined) throw new Error("no head");

      const merged = await plugin.merge(request(head), pass);
      expect(merged.ok).toBe(false);
      expect(readFileSync(join(r.dir, "README.md"), "utf8")).toBe("# My edit\n");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("refuses a commit from another branch, and leaves main as it was", async () => {
      const r = await repo();
      const { plugin, request } = await built(r, { "a.ts": "a\n" });
      await git(r.dir, "checkout", "-q", "-b", "elsewhere");
      await commitOnMain(r, "theirs.ts", "theirs\n");
      const theirs = CommitSha.parse(await git(r.dir, "rev-parse", "HEAD"));
      await git(r.dir, "checkout", "-q", "main");
      const before = await git(r.dir, "rev-parse", "main");

      const merged = await plugin.merge(request(theirs), pass);
      expect(merged.ok).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("fails with a message, not a throw, for a commit that doesn't exist", async () => {
      const r = await repo();
      const { plugin, request } = await built(r, { "a.ts": "a\n" });
      const merged = await plugin.merge(request(CommitSha.parse("1".repeat(40))), pass);
      expect(merged.ok).toBe(false);
    });
  });

  // The merge can add one file of its own, the task's approved spec. It is
  // written at merge time only, so the task's branch never holds it.
  describe(`${name}: merge with the task's spec`, () => {
    const pass: RunChecks = async () => ({ ok: true, value: null });
    const path = "docs/specs/12-csv-export.md";
    const spec = { path, text: "# #12 CSV export\n\nThe approved spec.\n" };

    // A worktree for this build, with the given files committed in one
    // commit. Returns the plugin, the worktree and the merge request.
    async function built(r: Repo, files: Record<string, string>, build = 1) {
      const plugin = make(r);
      const created = await plugin.createWorktree({ ...csv, build });
      if (!created.ok) throw new Error(created.message);
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(created.value.path, file)), { recursive: true });
        writeFileSync(join(created.value.path, file), text);
        await git(created.value.path, "add", "--force", file);
      }
      await git(created.value.path, "commit", "-q", "-m", "Task work");
      const head = CommitSha.parse(await git(created.value.path, "rev-parse", "HEAD"));
      const request = { ...csv, worktree: created.value, head, file: spec };
      return { plugin, worktree: created.value, head, request };
    }

    function hook(r: Repo, name: string, script: string): void {
      const file = join(r.dir, ".git", "hooks", name);
      writeFileSync(file, script);
      chmodSync(file, 0o755);
    }

    async function commitOnMain(r: Repo, file: string, text: string) {
      mkdirSync(dirname(join(r.dir, file)), { recursive: true });
      writeFileSync(join(r.dir, file), text);
      await git(r.dir, "add", "--force", file);
      await git(r.dir, "commit", "-q", "-m", `Add ${file} on main`);
    }

    test("lands the spec with the work, in the one commit on main", async () => {
      const r = await repo();
      const { plugin, request } = await built(r, { "a.ts": "a\n" });
      const before = await git(r.dir, "rev-parse", "main");

      const merged = await plugin.merge(request, pass);
      if (!merged.ok) throw new Error(merged.message);
      expect(await git(r.dir, "rev-parse", "main^")).toBe(before);
      expect(await git(r.dir, "show", `main:${path}`)).toBe(spec.text.trim());
      expect(await git(r.dir, "show", "main:a.ts")).toBe("a");
    });

    test("runs the checks with the spec in place", async () => {
      const r = await repo();
      const { plugin, request } = await built(r, { "a.ts": "a\n" });
      const seen: string[] = [];
      const checks: RunChecks = async (dir) => {
        seen.push(readFileSync(join(dir, path), "utf8"));
        return { ok: true, value: null };
      };

      expect((await plugin.merge(request, checks)).ok).toBe(true);
      expect(seen).toEqual([spec.text]);
    });

    test("never puts the spec on the task's branch", async () => {
      const r = await repo();
      const { plugin, worktree, head, request } = await built(r, { "a.ts": "a\n" });

      expect((await plugin.merge(request, pass)).ok).toBe(true);
      expect(await git(r.dir, "rev-parse", worktree.branch)).toBe(head);
      expect(await git(r.dir, "ls-tree", "-r", "--name-only", worktree.branch)).not.toContain(path);
      expect(existsSync(join(worktree.path, path))).toBe(false);
    });

    test("lands the spec even when the repository ignores docs/", async () => {
      const r = await repo();
      await commitOnMain(r, ".gitignore", "docs/\n");
      const { plugin, request } = await built(r, { "a.ts": "a\n" });

      const merged = await plugin.merge(request, pass);
      if (!merged.ok) throw new Error(merged.message);
      expect(await git(r.dir, "show", `main:${path}`)).toBe(spec.text.trim());
    });

    test("lands the approved text, not a version the agent wrote on its branch", async () => {
      const r = await repo();
      const { plugin, request } = await built(r, { "a.ts": "a\n", [path]: "# Rewritten\n" });

      expect((await plugin.merge(request, pass)).ok).toBe(true);
      expect(await git(r.dir, "show", `main:${path}`)).toBe(spec.text.trim());
    });

    test("never writes the spec through a docs folder the task made a link", async () => {
      const r = await repo();
      const outside = mkdtempSync(join(tmpdir(), "skelcrew-outside-"));
      dirs.push(outside);
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      await $`ln -s ${outside} docs`.cwd(created.value.path).quiet();
      await git(created.value.path, "add", "docs");
      await git(created.value.path, "commit", "-q", "-m", "Link docs");
      const head = CommitSha.parse(await git(created.value.path, "rev-parse", "HEAD"));
      const before = await git(r.dir, "rev-parse", "main");

      const merged = await plugin.merge(
        { ...csv, worktree: created.value, head, file: spec },
        pass,
      );
      expect(merged.ok).toBe(false);
      expect(existsSync(join(outside, "specs"))).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    // Found in review: on macOS these made the merge fail with a message
    // about the checks changing files, which said nothing about the cause.
    for (const other of ["docs/specs/12-CSV-export.md", "Docs/specs/12-csv-export.md"]) {
      test(`refuses a branch with ${other}, naming it, since it differs only in letter case`, async () => {
        const r = await repo();
        const { plugin, request } = await built(r, { "a.ts": "a\n", [other]: "# Mine\n" });
        const before = await git(r.dir, "rev-parse", "main");

        const merged = await plugin.merge(request, pass);
        expect(merged.ok).toBe(false);
        expect(!merged.ok && merged.message).toBe(
          `The task's branch has ${other}, which differs from ${path} only in letter case. Rename or remove it.`,
        );
        expect(await git(r.dir, "rev-parse", "main")).toBe(before);
      });
    }

    test("refuses when a hook changes the spec in the merge", async () => {
      const r = await repo();
      const { plugin, request } = await built(r, { "a.ts": "a\n" });
      hook(r, "pre-commit", `#!/bin/sh\necho changed >> ${path}\ngit add --force ${path}\n`);
      const before = await git(r.dir, "rev-parse", "main");

      const merged = await plugin.merge(request, pass);
      expect(merged.ok).toBe(false);
      expect(!merged.ok && merged.message).toContain("A hook changed");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("refuses when a hook removes the spec from the merge", async () => {
      const r = await repo();
      const { plugin, request } = await built(r, { "a.ts": "a\n" });
      hook(r, "pre-commit", `#!/bin/sh\ngit rm -q --cached ${path}\n`);
      const before = await git(r.dir, "rev-parse", "main");

      const merged = await plugin.merge(request, pass);
      expect(merged.ok).toBe(false);
      expect(!merged.ok && merged.message).toContain("A hook changed");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("asked again after it succeeded, gives back the same commit and merges nothing twice", async () => {
      const r = await repo();
      const { plugin, request } = await built(r, { "a.ts": "a\n" });
      const first = await plugin.merge(request, pass);
      let ranAgain = false;
      const second = await plugin.merge(request, async () => {
        ranAgain = true;
        return { ok: true, value: null };
      });
      expect(second).toEqual(first);
      expect(ranAgain).toBe(false);
      expect(await git(r.dir, "rev-parse", "main")).toBe(first.ok ? first.value : "");
    });

    test("replaces a different spec already on main at that path", async () => {
      const r = await repo();
      await commitOnMain(r, path, "# An older spec\n");
      const { plugin, request } = await built(r, { "a.ts": "a\n" });

      expect((await plugin.merge(request, pass)).ok).toBe(true);
      expect(await git(r.dir, "show", `main:${path}`)).toBe(spec.text.trim());
    });

    test("leaves the same spec already on main as it is, and still lands the work", async () => {
      const r = await repo();
      await commitOnMain(r, path, spec.text);
      const { plugin, request } = await built(r, { "a.ts": "a\n" });

      const merged = await plugin.merge(request, pass);
      if (!merged.ok) throw new Error(merged.message);
      expect(await git(r.dir, "diff", "--name-only", "main^", "main")).toBe("a.ts");
    });

    test("lands the revised spec when a task is built again after a revert", async () => {
      const r = await repo();
      const first = await built(r, { "a.ts": "a\n" });
      const merged = await first.plugin.merge(first.request, pass);
      if (!merged.ok) throw new Error(merged.message);
      const reverted = await first.plugin.revert({
        taskId: csv.taskId,
        commit: merged.value,
        reason: "Wrong format",
      });
      if (!reverted.ok) throw new Error(reverted.message);
      expect(await git(r.dir, "ls-tree", "-r", "--name-only", "main")).not.toContain(path);

      const revised = { path, text: "# #12 CSV export\n\nThe revised spec.\n" };
      const second = await built(r, { "a.ts": "a, revised\n" }, 2);
      const again = await second.plugin.merge({ ...second.request, file: revised }, pass);
      if (!again.ok) throw new Error(again.message);
      expect(await git(r.dir, "show", `main:${path}`)).toBe(revised.text.trim());
      expect(await git(r.dir, "show", "main:a.ts")).toBe("a, revised");
    });
  });

  describe(`${name}: revert`, () => {
    const pass: RunChecks = async () => ({ ok: true, value: null });
    const reason = "Broke the export";

    // Merges a task that writes the given files, or removes those given as
    // null. Returns the request to revert that merge.
    async function landed(r: Repo, files: Record<string, string | null>) {
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      for (const [file, text] of Object.entries(files)) {
        if (text === null) await git(created.value.path, "rm", "-q", file);
        else {
          writeFileSync(join(created.value.path, file), text);
          await git(created.value.path, "add", file);
        }
      }
      await git(created.value.path, "commit", "-q", "-m", "Task work");
      const head = CommitSha.parse(await git(created.value.path, "rev-parse", "HEAD"));
      const merged = await plugin.merge({ ...csv, worktree: created.value, head }, pass);
      if (!merged.ok) throw new Error(merged.message);
      return { plugin, request: { taskId: csv.taskId, commit: merged.value, reason } };
    }

    async function commitOnMain(r: Repo, file: string, text: string) {
      writeFileSync(join(r.dir, file), text);
      await git(r.dir, "add", file);
      await git(r.dir, "commit", "-q", "-m", `Add ${file} on main`);
    }

    async function filesOnMain(r: Repo): Promise<string[]> {
      return (await git(r.dir, "ls-tree", "--name-only", "main")).split("\n");
    }

    function hook(r: Repo, name: string, script: string): () => void {
      const path = join(r.dir, ".git", "hooks", name);
      writeFileSync(path, script);
      chmodSync(path, 0o755);
      return () => rmSync(path);
    }

    test("undoes the commit with one new commit on the old main, keeping later work", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      await commitOnMain(r, "later.ts", "later\n");
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert(request);
      if (!reverted.ok) throw new Error(reverted.message);
      expect(await git(r.dir, "rev-parse", "main")).toBe(reverted.value);
      // Its only parent is the old main.
      expect(await git(r.dir, "rev-list", "--parents", "--max-count=1", "main")).toBe(
        `${reverted.value} ${before}`,
      );
      expect(await filesOnMain(r)).toEqual(["README.md", "later.ts"]);
      expect(existsSync(join(r.dir, "a.ts"))).toBe(false);
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
    });

    test("puts back a file the task changed", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "README.md": "# Changed by the task\n" });

      expect((await plugin.revert(request)).ok).toBe(true);
      expect(await git(r.dir, "show", "main:README.md")).toBe("# Test");
    });

    test("says in the commit message what was reverted and why", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });

      expect((await plugin.revert(request)).ok).toBe(true);
      expect(await git(r.dir, "log", "-1", "--format=%s", "main")).toBe(
        "Revert #12: Broke the export",
      );
      expect(await git(r.dir, "log", "-1", "--format=%b", "main")).toContain(request.commit);
    });

    test("leaves main as it was on a conflict, and names the file", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      await commitOnMain(r, "a.ts", "changed on main\n");
      const before = await git(r.dir, "rev-parse", "main");
      const worktrees = await git(r.dir, "worktree", "list");

      const reverted = await plugin.revert(request);
      expect(reverted.ok).toBe(false);
      expect(!reverted.ok && reverted.message).toContain("a.ts");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
      expect(await git(r.dir, "worktree", "list")).toBe(worktrees);
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
    });

    test("refuses a commit that isn't on main, and leaves main as it was", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      await git(r.dir, "checkout", "-q", "-b", "elsewhere");
      await commitOnMain(r, "theirs.ts", "theirs\n");
      const theirs = CommitSha.parse(await git(r.dir, "rev-parse", "HEAD"));
      await git(r.dir, "checkout", "-q", "main");
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert({ ...request, commit: theirs });
      expect(reverted.ok).toBe(false);
      expect(!reverted.ok && reverted.message).toContain("isn't on main");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("fails with a message, not a throw, for a commit that doesn't exist", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert({ ...request, commit: CommitSha.parse("1".repeat(40)) });
      expect(reverted.ok).toBe(false);
      expect(!reverted.ok && reverted.message).toContain("isn't on main");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("refuses a commit with more than one parent", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      await git(r.dir, "checkout", "-q", "-b", "side");
      await commitOnMain(r, "side.ts", "side\n");
      await git(r.dir, "checkout", "-q", "main");
      await git(r.dir, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
      const joined = CommitSha.parse(await git(r.dir, "rev-parse", "main"));

      const reverted = await plugin.revert({ ...request, commit: joined });
      expect(reverted.ok).toBe(false);
      expect(!reverted.ok && reverted.message).toContain("more than one parent");
      expect(await git(r.dir, "rev-parse", "main")).toBe(joined);
    });

    test("asked again after it succeeded, gives back the same commit and reverts nothing twice", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      const first = await plugin.revert(request);
      if (!first.ok) throw new Error(first.message);
      const commits = await git(r.dir, "rev-list", "--count", "main");

      expect(await plugin.revert(request)).toEqual(first);
      expect(await git(r.dir, "rev-list", "--count", "main")).toBe(commits);
      expect(await git(r.dir, "rev-parse", "main")).toBe(first.value);
    });

    test("gives two calls at once the same answer, and reverts once", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      const commits = Number(await git(r.dir, "rev-list", "--count", "main"));

      const [first, second] = await Promise.all([plugin.revert(request), plugin.revert(request)]);
      if (!first.ok) throw new Error(first.message);
      expect(second).toEqual(first);
      expect(Number(await git(r.dir, "rev-list", "--count", "main"))).toBe(commits + 1);
    });

    // The same hooks the merge's tests use: one stages a file while the
    // commit is made, one stages a file while the worktree is made, and
    // one adds a commit of its own.
    const hooks: [string, string][] = [
      ["pre-commit", "#!/bin/sh\necho extra > extra.txt\ngit add extra.txt\n"],
      ["post-checkout", "#!/bin/sh\necho extra > extra.txt\ngit add extra.txt\n"],
      [
        "post-commit",
        '#!/bin/sh\n[ -n "$IN_HOOK" ] && exit 0\nIN_HOOK=1 git commit -q --allow-empty -m "extra from hook"\n',
      ],
    ];
    for (const [name, script] of hooks) {
      test(`refuses when a ${name} hook adds something, and reverts once it is gone`, async () => {
        const r = await repo();
        const { plugin, request } = await landed(r, { "a.ts": "a\n" });
        const unhook = hook(r, name, script);
        const before = await git(r.dir, "rev-parse", "main");

        const reverted = await plugin.revert(request);
        expect(reverted.ok).toBe(false);
        expect(!reverted.ok && reverted.message).toContain("hook");
        expect(await git(r.dir, "rev-parse", "main")).toBe(before);

        unhook();
        const again = await plugin.revert(request);
        if (!again.ok) throw new Error(again.message);
        expect(await git(r.dir, "rev-list", "--parents", "--max-count=1", "main")).toBe(
          `${again.value} ${before}`,
        );
        expect(await filesOnMain(r)).toEqual(["README.md"]);
      });
    }

    // Someone takes a bad commit off main while the revert is being made.
    // Moving main to the revert, which was built on top of it, would put
    // the bad commit back.
    test("refuses when main moved during the revert, and reverts on a retry", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      await commitOnMain(r, "bad.txt", "bad\n");
      const unhook = hook(
        r,
        "pre-commit",
        `#!/bin/sh\nunset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE\ncd "${r.dir}" && git reset -q --hard HEAD~1\n`,
      );

      const reverted = await plugin.revert(request);
      unhook();
      expect(reverted.ok).toBe(false);
      expect(!reverted.ok && reverted.message).toContain("moved while the revert");
      expect(await filesOnMain(r)).toEqual(["README.md", "a.ts"]);

      expect((await plugin.revert(request)).ok).toBe(true);
      expect(await filesOnMain(r)).toEqual(["README.md"]);
    });

    // Found by review: a hook moved main to the revert itself, and the
    // revert then said main had moved and nothing was reverted.
    test("succeeds when a hook already moved main to exactly the revert", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      const unhook = hook(r, "post-commit", "#!/bin/sh\ngit update-ref refs/heads/main HEAD\n");
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert(request);
      unhook();
      if (!reverted.ok) throw new Error(reverted.message);
      expect(await git(r.dir, "rev-parse", "main")).toBe(reverted.value);
      expect(await git(r.dir, "rev-list", "--parents", "--max-count=1", "main")).toBe(
        `${reverted.value} ${before}`,
      );
      expect(await filesOnMain(r)).toEqual(["README.md"]);
    });

    // Found by review: a merge rule in .gitattributes can keep main's
    // version of a file, so undoing the commit changes nothing. Main still
    // holds what the commit added, so the message mustn't say otherwise.
    test("says only that the revert would change nothing when a merge rule keeps main's version", async () => {
      const r = await repo();
      await git(r.dir, "config", "merge.keepmain.driver", "true");
      await commitOnMain(r, ".gitattributes", "notes.txt merge=keepmain\n");
      await commitOnMain(r, "notes.txt", "one\n");
      const { plugin, request } = await landed(r, { "notes.txt": "one\ntwo\n" });
      await commitOnMain(r, "notes.txt", "one\ntwo\nthree\n");
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert(request);
      expect(reverted.ok).toBe(false);
      expect(!reverted.ok && reverted.message).toBe(
        `Reverting ${request.commit} would change nothing on main.`,
      );
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
      expect(await git(r.dir, "show", "main:notes.txt")).toBe("one\ntwo\nthree");
    });

    // With merge.autoStash, git stashes your edits instead of refusing, and
    // can put them back with conflict markers.
    test("never overwrites your uncommitted edit in your checkout of main", async () => {
      const r = await repo();
      await git(r.dir, "config", "merge.autoStash", "true");
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      writeFileSync(join(r.dir, "a.ts"), "my edit\n");
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert(request);
      expect(reverted.ok).toBe(false);
      expect(readFileSync(join(r.dir, "a.ts"), "utf8")).toBe("my edit\n");
      expect(await git(r.dir, "stash", "list")).toBe("");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);

      await git(r.dir, "checkout", "--", "a.ts");
      expect((await plugin.revert(request)).ok).toBe(true);
    });

    test("never overwrites an ignored file in your checkout of main", async () => {
      const r = await repo();
      await commitOnMain(r, "secret.env", "committed\n");
      const { plugin, request } = await landed(r, { "secret.env": null });
      writeFileSync(join(r.dir, ".git", "info", "exclude"), "secret.env\n", { flag: "a" });
      writeFileSync(join(r.dir, "secret.env"), "my unsaved secret\n");
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert(request);
      expect(reverted.ok).toBe(false);
      expect(readFileSync(join(r.dir, "secret.env"), "utf8")).toBe("my unsaved secret\n");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);

      rmSync(join(r.dir, "secret.env"));
      expect((await plugin.revert(request)).ok).toBe(true);
    });

    test("puts your checkout back when main can't be moved", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      const unblock = blockMain(r);
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert(request);
      unblock();
      expect(reverted.ok).toBe(false);
      expect(!reverted.ok && reverted.message).toContain("put back");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
      expect(await git(r.dir, "status", "--porcelain")).toBe("");
      expect(readFileSync(join(r.dir, "a.ts"), "utf8")).toBe("a\n");

      expect((await plugin.revert(request)).ok).toBe(true);
    });

    test("refuses when main is checked out in more than one place", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      const second = join(r.dir, ".skelcrew", "second-main");
      await git(r.dir, "worktree", "add", "-q", "-f", second, "main");
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert(request);
      expect(reverted.ok).toBe(false);
      expect(!reverted.ok && reverted.message).toContain("2 places");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("refuses while you are rebasing main", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      await git(r.dir, "checkout", "-q", "-b", "other");
      await commitOnMain(r, "README.md", "# Other\n");
      await git(r.dir, "checkout", "-q", "main");
      await commitOnMain(r, "README.md", "# Mine\n");
      await $`git rebase other`.cwd(r.dir).nothrow().quiet();
      const before = await git(r.dir, "rev-parse", "main");

      const reverted = await plugin.revert(request);
      expect(reverted.ok).toBe(false);
      expect(!reverted.ok && reverted.message).toContain("rebasing");
      expect(await git(r.dir, "rev-parse", "main")).toBe(before);
    });

    test("moves main when no checkout has it open", async () => {
      const r = await repo();
      const { plugin, request } = await landed(r, { "a.ts": "a\n" });
      await git(r.dir, "checkout", "-q", "--detach");

      const reverted = await plugin.revert(request);
      if (!reverted.ok) throw new Error(reverted.message);
      expect(await git(r.dir, "rev-parse", "main")).toBe(reverted.value);
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

    // Found by Codex review: git hides edits to files marked
    // assume-unchanged or skip-worktree, so a save would miss them.
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      test(`refuses to remove a worktree with an edit git hides (${flag})`, async () => {
        const r = await repo();
        const plugin = make(r);
        const created = await plugin.createWorktree(csv);
        if (!created.ok) throw new Error(created.message);
        await git(created.value.path, "update-index", flag, "README.md");
        writeFileSync(join(created.value.path, "README.md"), "# Edited\n");

        const removed = await plugin.removeWorktree(created.value);
        expect(removed.ok).toBe(false);
        expect(readFileSync(join(created.value.path, "README.md"), "utf8")).toBe("# Edited\n");
      });
    }

    test("refuses to touch another repository at the path of a worktree that was moved away", async () => {
      const r = await repo();
      const plugin = make(r);
      const created = await plugin.createWorktree(csv);
      if (!created.ok) throw new Error(created.message);
      await strangerAt(created.value.path);
      writeFileSync(join(created.value.path, "theirs.txt"), "their work\n");
      const theirs = await git(created.value.path, "rev-parse", "HEAD");

      expect((await plugin.removeWorktree(created.value)).ok).toBe(false);
      expect(await git(created.value.path, "rev-parse", "HEAD")).toBe(theirs);
      expect(existsSync(join(created.value.path, "theirs.txt"))).toBe(true);
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
