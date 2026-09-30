// A task's spec as a Markdown file in the repository, such as
// docs/specs/12-csv-export.md. The daemon hands it to the version-control
// plugin, which commits it on the task's branch before any work. So the
// spec lands on main with the work, shows in the diff you review, and stays
// readable without Skelcrew.

import type { Spec, TaskId } from "../core/types";
import { type SpecFile, shortName } from "../plugins/version-control";

// Where specs go. The file is named like the task's branch, so
// task/12-csv-export pairs with docs/specs/12-csv-export.md. Every build
// of a task writes the same file, so a rebuilt task's diff shows how its
// spec changed.
export function specPath(taskId: TaskId, title: string): string {
  return `docs/specs/${shortName(taskId, title)}.md`;
}

// The file as you read it: the task's number and title, its scope, and its
// acceptance criteria. A spec only reaches Ready with no open questions,
// so they appear only if a spec somehow has some.
export function specFile(taskId: TaskId, title: string, spec: Spec): SpecFile {
  const lines = [
    `# #${taskId} ${oneLine(title)}`,
    "",
    `The spec task #${taskId} was built from.`,
    "",
    "## Scope",
    "",
    spec.scope.trim(),
    "",
    "## Acceptance criteria",
    "",
    ...spec.acceptance.map(item),
  ];
  if (spec.openQuestions.length > 0) {
    lines.push("", "## Open questions", "", ...spec.openQuestions.map(item));
  }
  return { path: specPath(taskId, title), text: `${lines.join("\n")}\n` };
}

// One list item. Its later lines are indented, so they stay in the item.
function item(text: string): string {
  return `- ${text.trim().replace(/\n/g, "\n  ")}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
