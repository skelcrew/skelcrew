// `skelcrew init`: sets up the repository and says, in a few lines, what it
// did and what to do next. The work itself is initRepository, in
// src/init/init.ts.
//
// It sets up the whole git repository, from its top, like git itself. Run
// from src/reports, it sets up the repository that holds src/reports. It
// refuses a folder inside the repository that has a .skelcrew of its own,
// such as one project in a repository that holds several. Skelcrew's
// worktrees and merges would cover the whole repository, so that isn't
// supported. The daemon refuses such a folder too.

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type InitReport, initRepository } from "../init/init";
import { insideRepository, repositoryTop } from "../plugins/git/top";
import type { Outcome } from "./cli";

export async function init(args: string[], cwd: string): Promise<Outcome> {
  if (args.length > 0) return refused("skelcrew init takes no arguments.");
  const here = realpathSync(resolve(cwd));
  const found = repositoryTop(here);
  if (!found.ok) return refused(found.message);
  const repo = found.top;
  const own = ownSkelcrew(here, repo);
  if (own !== null) return refused(insideRepository(own, repo));
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

// The nearest folder, from here up to the repository's top, that has a
// .skelcrew folder of its own. The top itself doesn't count.
function ownSkelcrew(here: string, top: string): string | null {
  let dir = here;
  while (dir !== top) {
    const folder = join(dir, ".skelcrew");
    if (existsSync(folder) && statSync(folder).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function list(label: string, items: string[]): string[] {
  return items.length === 0 ? [] : [`${label}: ${items.join(", ")}.`];
}

function refused(...err: string[]): Outcome {
  return { code: 1, out: [], err };
}
