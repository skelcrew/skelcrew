import { describe, expect, test } from "bun:test";
import { TaskId } from "../../core/ids";
import { versionControlContract } from "../version-control.contract";
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
