import { describe, expect, test } from "bun:test";
import { CommitSha, ProjectId, SessionId, TaskId } from "./ids";

describe("TaskId", () => {
  test("accepts a positive whole number", () => {
    expect(TaskId.safeParse(12).success).toBe(true);
  });

  test("rejects zero, negatives, fractions and strings", () => {
    for (const bad of [0, -1, 1.5, "12"]) {
      expect(TaskId.safeParse(bad).success).toBe(false);
    }
  });
});

describe("ProjectId", () => {
  test("accepts a short lowercase slug", () => {
    for (const good of ["inbox", "github-plugin", "v2"]) {
      expect(ProjectId.safeParse(good).success).toBe(true);
    }
  });

  test("rejects anything a command line would trip over", () => {
    for (const bad of ["", "Inbox", "github plugin", "-inbox", "inbox-", "a--b"]) {
      expect(ProjectId.safeParse(bad).success).toBe(false);
    }
  });
});

describe("SessionId", () => {
  test("rejects an empty string", () => {
    expect(SessionId.safeParse("").success).toBe(false);
  });
});

describe("CommitSha", () => {
  test("accepts a full 40-character hex sha", () => {
    expect(CommitSha.safeParse("a".repeat(40)).success).toBe(true);
  });

  test("rejects short, uppercase or non-hex shas", () => {
    for (const bad of ["a1b2c3", "A".repeat(40), "g".repeat(40)]) {
      expect(CommitSha.safeParse(bad).success).toBe(false);
    }
  });
});
