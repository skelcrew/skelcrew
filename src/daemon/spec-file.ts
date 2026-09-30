// A task's approved spec as a Markdown file, such as
// docs/specs/12-csv-export.md. The daemon hands it to the version-control
// plugin with the merge, which writes it into the one commit that lands on
// main. So the spec sits next to the code it describes, readable without
// Skelcrew. The task's branch never holds it, so the agent can't change it.

import type { Spec, TaskId } from "../core/types";
import { type FileToAdd, shortName } from "../plugins/version-control";

// Where specs go. The file is named like the task's branch, so
// task/12-csv-export pairs with docs/specs/12-csv-export.md. Every build
// of a task writes the same file, so a rebuilt task's commit shows how its
// spec changed.
function specPath(taskId: TaskId, title: string): string {
  return `docs/specs/${shortName(taskId, title)}.md`;
}

// The file as you read it: the task's number and title, its scope, and its
// acceptance criteria. A spec only reaches Ready with no open questions,
// so they appear only if a spec somehow has some.
export function specFile(taskId: TaskId, title: string, spec: Spec): FileToAdd {
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
