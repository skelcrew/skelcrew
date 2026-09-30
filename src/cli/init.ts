// `skelcrew init`: sets up the repository and says, in a few lines, what it
// did and what to do next. The work itself is initRepository, in
// src/init/init.ts.

import { resolve } from "node:path";
import { type InitReport, initRepository } from "../init/init";
import type { Outcome } from "./cli";

export async function init(args: string[], cwd: string): Promise<Outcome> {
  if (args.length > 0) {
    return refused("skelcrew init takes no arguments. Run it where your git repository starts.");
  }
  const repo = resolve(cwd);
  const result = initRepository(repo);
  // A failed run's reason already names what it wrote before it stopped.
  if (!result.ok) return refused(result.reason);
  return { code: 0, out: report(repo, result.report), err: [] };
}

function report(repo: string, report: InitReport): string[] {
  const changed = [...report.created, ...report.linked, ...report.updated].length > 0;
  const addTask = 'add a first task: skelcrew add "<task>"';
  return [
    changed
      ? `Set up Skelcrew in ${repo}.`
      : `Skelcrew was already set up in ${repo}. Nothing changed.`,
    ...list("The checks it runs", report.checks),
    ...list("Created", report.created),
    ...list("Linked", report.linked),
    ...list("Updated", report.updated),
    ...list("Already there, left as they were", report.unchanged),
    ...list("Do by hand", report.byHand),
    ...(report.warnings.length === 0
      ? []
      : ["Look at these:", ...report.warnings.map((warning) => `- ${warning}`)]),
    "",
    `Approving: ${report.askBeforeApproveLimit}`,
    "",
    ...(changed
      ? [
          "Next, commit these files, so everyone who clones the repository gets them.",
          `Then ${addTask}`,
        ]
      : [`Next, ${addTask}`]),
  ];
}

function list(label: string, items: string[]): string[] {
  return items.length === 0 ? [] : [`${label}: ${items.join(", ")}.`];
}

function refused(...err: string[]): Outcome {
  return { code: 1, out: [], err };
}
