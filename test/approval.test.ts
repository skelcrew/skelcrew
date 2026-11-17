// Keeping an approval: whether a submitted commit only merges the base branch into the commit
// Skelcrew's reviewer approved, against real git repositories in a temporary folder.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onlyMergedBase } from "../src/flow/round.ts";
import { git } from "./harness.ts";

let repo = "";
// The commit the reviewer approved, on branch pr, from main's first commit.
let approved = "";

// Writes the files, commits them on the branch checked out, and returns the commit.
function commit(files: Record<string, string>, message = "commit"): string {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

// Moves main with a commit of the files, then merges it into pr without committing, keeping
// pr's side of any conflict. Returns whether the merge conflicted.
function moveMainAndMerge(files: Record<string, string>): boolean {
  git(repo, "checkout", "-q", "main");
  commit(files, "main moved");
  git(repo, "checkout", "-q", "pr");
  try {
    git(repo, "merge", "-q", "--no-ff", "--no-commit", "main");
    return false;
  } catch {
    git(repo, "checkout", "--ours", "--", ".");
    return true;
  }
}

// Finishes the merge with whatever the work tree holds, and returns its commit.
function finishMerge(): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--no-edit");
  return git(repo, "rev-parse", "HEAD");
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "skel-approval-test-")));
  git(repo, "init", "-q", "-b", "main");
  commit({ README: "app\n", shared: "one\ntwo\nthree\n" });
  git(repo, "checkout", "-q", "-b", "pr");
  approved = commit({
    change: "the PR's change\n",
    shared: "one\ntwo, changed by the PR\nthree\n",
  });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("a commit that only merges main into the approved commit keeps the approval", () => {
  expect(moveMainAndMerge({ OTHER: "other\n", shared: "zero\none\ntwo\nthree\n" })).toBe(false);
  expect(onlyMergedBase(repo, approved, finishMerge(), "main")).toBe(true);
});

test("a merge of main that also changes a line of the PR does not", () => {
  moveMainAndMerge({ OTHER: "other\n" });
  writeFileSync(join(repo, "change"), "the PR's change, edited\n");
  expect(onlyMergedBase(repo, approved, finishMerge(), "main")).toBe(false);
});

test("a commit after the merge that changes the PR does not", () => {
  moveMainAndMerge({ OTHER: "other\n" });
  finishMerge();
  expect(onlyMergedBase(repo, approved, commit({ change: "more\n" }), "main")).toBe(false);
});

test("a merge that resolved a conflict in the PR's files does not, even keeping the PR's side", () => {
  expect(moveMainAndMerge({ shared: "one\ntwo, changed by main\nthree\n" })).toBe(true);
  expect(onlyMergedBase(repo, approved, finishMerge(), "main")).toBe(false);
});

test("a commit Skelcrew can't read does not", () => {
  expect(onlyMergedBase(repo, approved, "0".repeat(40), "main")).toBe(false);
});
