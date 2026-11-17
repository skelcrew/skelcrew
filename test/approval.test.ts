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

test("a conflict resolved in an earlier merge does not, though main undid its side since", () => {
  // Main changes the PR's line, and the builder resolves the conflict by keeping its side.
  expect(moveMainAndMerge({ shared: "one\ntwo, changed by main\nthree\n" })).toBe(true);
  finishMerge();
  // Main puts the line back, and the builder merges again, keeping its side. The final tree is
  // then what git alone would make of the approved commit and main.
  moveMainAndMerge({ shared: "one\ntwo\nthree\n" });
  expect(onlyMergedBase(repo, approved, finishMerge(), "main")).toBe(false);
});

test("a commit that rewrote the approved one, rather than merging into it, does not", () => {
  git(repo, "checkout", "-q", "main");
  commit({ OTHER: "other\n" }, "main moved");
  git(repo, "checkout", "-q", "pr");
  git(repo, "rebase", "-q", "main");
  expect(onlyMergedBase(repo, approved, git(repo, "rev-parse", "HEAD"), "main")).toBe(false);
});

test("a merge after main took one of the PR's changes as its own does not, as the PR's diff changed", () => {
  expect(moveMainAndMerge({ change: "the PR's change\n" })).toBe(false);
  expect(onlyMergedBase(repo, approved, finishMerge(), "main")).toBe(false);
});
