import { describe, expect, test } from "bun:test";
import { mergeAllowed, specComplete } from "./contracts";
import type { Spec } from "./types";

const complete: Spec = {
  scope: "Add a CSV export button to the reports page.",
  acceptance: ["Clicking Export downloads a CSV of the visible rows."],
  openQuestions: [],
};

describe("specComplete", () => {
  test("passes a spec with scope, acceptance criteria and no open questions", () => {
    expect(specComplete(complete)).toEqual({ ok: true });
  });

  test("fails a spec with no scope", () => {
    expect(specComplete({ ...complete, scope: "" })).toEqual({
      ok: false,
      reasons: ["The spec has no scope."],
    });
  });

  test("treats a scope of only spaces as no scope", () => {
    expect(specComplete({ ...complete, scope: "  \n" })).toEqual({
      ok: false,
      reasons: ["The spec has no scope."],
    });
  });

  test("fails a spec with no acceptance criteria", () => {
    expect(specComplete({ ...complete, acceptance: [] })).toEqual({
      ok: false,
      reasons: ["The spec has no acceptance criteria."],
    });
  });

  test("treats blank acceptance criteria as missing", () => {
    expect(specComplete({ ...complete, acceptance: ["", " "] })).toEqual({
      ok: false,
      reasons: ["The spec has no acceptance criteria."],
    });
  });

  test("fails a spec with open questions and names them", () => {
    const spec = { ...complete, openQuestions: ["Include deleted rows?", "Which date format?"] };
    expect(specComplete(spec)).toEqual({
      ok: false,
      reasons: ["The spec has 2 open questions: Include deleted rows? Which date format?"],
    });
  });

  test("lists every problem at once, not just the first", () => {
    const spec: Spec = { scope: "", acceptance: [], openQuestions: ["Include deleted rows?"] };
    expect(specComplete(spec)).toEqual({
      ok: false,
      reasons: [
        "The spec has no scope.",
        "The spec has no acceptance criteria.",
        "The spec has 1 open question: Include deleted rows?",
      ],
    });
  });
});

describe("mergeAllowed", () => {
  const branch = (...changedFiles: string[]) => ({ commits: 1, changedFiles });

  test("allows a merge when no critical paths are set", () => {
    expect(mergeAllowed(branch("src/auth/login.ts"), [])).toEqual({ ok: true });
  });

  test("allows a merge that touches no critical path", () => {
    expect(mergeAllowed(branch("src/reports/export.ts"), ["src/auth/**"])).toEqual({ ok: true });
  });

  test("needs approval when a file matches a critical path, and names the file and pattern", () => {
    expect(
      mergeAllowed(branch("src/reports/export.ts", "src/auth/login.ts"), ["src/auth/**"]),
    ).toEqual({
      ok: false,
      reasons: ["src/auth/login.ts matches the critical path src/auth/**"],
    });
  });

  test("matches files nested deep under a critical folder", () => {
    expect(mergeAllowed(branch("migrations/2026/09/add_users.sql"), ["migrations/**"]).ok).toBe(
      false,
    );
  });

  test("matches hidden files and folders, so they can't slip past", () => {
    expect(mergeAllowed(branch(".github/workflows/ci.yml"), [".github/**"]).ok).toBe(false);
    expect(mergeAllowed(branch("src/auth/.env"), ["src/auth/**"]).ok).toBe(false);
  });

  test("names each file once, with the first pattern it matches", () => {
    expect(mergeAllowed(branch("src/auth/login.ts"), ["src/auth/**", "src/**/*.ts"])).toEqual({
      ok: false,
      reasons: ["src/auth/login.ts matches the critical path src/auth/**"],
    });
  });
});
