import { describe, expect, test } from "bun:test";
import { attemptsLeft, mergeAllowed, specComplete, withinSafetyCap } from "./contracts";
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

// `attempts` counts failed rounds since the last retry, including the one
// that just failed. decide calls this after every failed gate or merge.
describe("attemptsLeft", () => {
  test("sends the task back to the agent while attempts remain", () => {
    expect(attemptsLeft(1, 3)).toEqual({ ok: true });
    expect(attemptsLeft(2, 3)).toEqual({ ok: true });
  });

  test("fails when the last attempt has failed", () => {
    expect(attemptsLeft(3, 3)).toEqual({ ok: false, reasons: ["All 3 attempts failed."] });
  });

  test("fails on the first failure when only one attempt is allowed", () => {
    expect(attemptsLeft(1, 1)).toEqual({ ok: false, reasons: ["The only attempt failed."] });
  });

  test("still fails if the count has somehow gone past the limit", () => {
    expect(attemptsLeft(4, 3)).toEqual({ ok: false, reasons: ["All 3 attempts failed."] });
  });
});

// The cap counts from the last retry: usage minus usageAtRetry.
describe("withinSafetyCap", () => {
  const cap = { tokens: 200_000, ms: 60 * 60_000 };
  const zero = { tokens: 0, ms: 0 };

  test("passes while the task is under both limits", () => {
    expect(withinSafetyCap({ tokens: 199_999, ms: 59 * 60_000 }, zero, cap)).toEqual({ ok: true });
  });

  test("fails once the task reaches the token limit", () => {
    expect(withinSafetyCap({ tokens: 200_000, ms: 0 }, zero, cap)).toEqual({
      ok: false,
      reasons: ["Used 200,000 tokens since the last retry. The cap is 200,000."],
    });
  });

  test("fails once the task reaches the time limit, shown in minutes", () => {
    expect(withinSafetyCap({ tokens: 0, ms: 61.5 * 60_000 }, zero, cap)).toEqual({
      ok: false,
      reasons: ["Ran for 61 minutes since the last retry. The cap is 60 minutes."],
    });
  });

  test("lists both reasons when both limits are reached", () => {
    const check = withinSafetyCap({ tokens: 250_000, ms: 90 * 60_000 }, zero, cap);
    expect(check.ok).toBe(false);
    expect(check.ok ? [] : check.reasons).toHaveLength(2);
  });

  test("counts only what was used since the last retry", () => {
    const usage = { tokens: 500_000, ms: 150 * 60_000 };
    const atRetry = { tokens: 400_000, ms: 120 * 60_000 };
    expect(withinSafetyCap(usage, atRetry, cap)).toEqual({ ok: true });
  });
});
