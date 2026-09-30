// The spec file a merge lands, as a reader of docs/specs/ sees it. The
// daemon tests cover a plain spec. These cover the rest of the layout.

import { describe, expect, test } from "bun:test";
import { TaskId } from "../core/ids";
import { specFile } from "./spec-file";

describe("specFile", () => {
  const taskId = TaskId.parse(12);
  const plain = {
    scope: "Add a CSV export button.",
    acceptance: ["Clicking Export downloads a CSV."],
    openQuestions: [],
  };

  test("puts a title with line breaks or runs of spaces on one line", () => {
    const file = specFile(taskId, "  CSV\n  export \t now ", plain);
    expect(file.text.split("\n")[0]).toBe("# #12 CSV export now");
  });

  test("indents the later lines of a list item, so they stay in the item", () => {
    const file = specFile(taskId, "CSV export", {
      ...plain,
      acceptance: ["Clicking Export downloads a CSV.\nIt has a header row.", "Empty is fine."],
    });
    expect(file.text).toContain(
      "- Clicking Export downloads a CSV.\n  It has a header row.\n- Empty is fine.\n",
    );
  });

  test("leaves out the open questions when there are none", () => {
    expect(specFile(taskId, "CSV export", plain).text).not.toContain("Open questions");
  });

  test("lists open questions last, if a spec somehow has some", () => {
    const file = specFile(taskId, "CSV export", {
      ...plain,
      openQuestions: ["Which delimiter?", "Quote every field?\nOr only when needed?"],
    });
    expect(file.text).toEndWith(
      [
        "- Clicking Export downloads a CSV.",
        "",
        "## Open questions",
        "",
        "- Which delimiter?",
        "- Quote every field?",
        "  Or only when needed?",
        "",
      ].join("\n"),
    );
  });
});
