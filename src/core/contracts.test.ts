import { describe, expect, test } from "bun:test";
import { specComplete } from "./contracts";
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
