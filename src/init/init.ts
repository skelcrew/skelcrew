// What `skelcrew init` does to a repository. It writes .skelcrew/workflow.yml
// with the checks it finds, keeps the runtime database out of git, and
// writes the default skills. It never overwrites a file, so running it
// again changes nothing, and a file you wrote yourself is kept as it is.
//
// Running the chosen checks on the current code is a separate step for the
// caller: `localChecks(report.checks)(dir)` from src/checks/checks.ts.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseWorkflow, workflowFile } from "../config/workflow";
import { detectChecks } from "./detect";
import { defaultSkills } from "./skills";

// What init did. Each path is relative to the repository.
export type InitReport = {
  // The checks workflow.yml holds: the ones init chose, or the ones in the
  // file that was already there.
  checks: string[];
  // Files that didn't exist and now do.
  created: string[];
  // Files that existed and had something added: only .gitignore.
  updated: string[];
  // Files that existed and were left exactly as they were.
  unchanged: string[];
  // Things you should look at, such as a workflow.yml init couldn't read.
  warnings: string[];
};

export type InitResult = { ok: true; report: InitReport } | { ok: false; reason: string };

const workflowPath = ".skelcrew/workflow.yml";

// SQLite keeps two more files beside the database while it runs, ending in
// -wal and -shm. The * covers them as well.
const databaseLine = ".skelcrew/skelcrew.db*";

export function initRepository(dir: string): InitResult {
  const report: InitReport = { checks: [], created: [], updated: [], unchanged: [], warnings: [] };

  // The checks come first. If there are none, nothing is written at all.
  let workflow: string | null = null;
  if (existsSync(join(dir, workflowPath))) {
    const parsed = parseWorkflow(readFileSync(join(dir, workflowPath), "utf8"));
    if (parsed.ok) report.checks = parsed.workflow.checks;
    else {
      report.warnings.push(
        `${workflowPath} was already there, but can't be read, so it was left as it is: ${parsed.reasons.join(" ")}`,
      );
    }
  } else {
    const detected = detectChecks(dir);
    if (!detected.ok) return { ok: false, reason: detected.reason };
    report.checks = detected.checks;
    workflow = workflowFile(detected.checks);
  }

  try {
    if (workflow === null) report.unchanged.push(workflowPath);
    else writeNew(dir, workflowPath, workflow, report);
    for (const skill of defaultSkills) writeNew(dir, skill.path, skill.text, report);
    ignoreDatabase(dir, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Setting up the repository failed: ${message}` };
  }
  return { ok: true, report };
}

// Writes the file only if there is none. The "wx" flag makes the write
// itself refuse an existing file, so nothing is overwritten even if a file
// appears between the check and the write.
function writeNew(dir: string, path: string, text: string, report: InitReport): void {
  const full = join(dir, path);
  if (existsSync(full)) {
    report.unchanged.push(path);
    return;
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, { flag: "wx" });
  report.created.push(path);
}

// Adds the database to .gitignore, after whatever is there already.
function ignoreDatabase(dir: string, report: InitReport): void {
  const path = ".gitignore";
  const full = join(dir, path);
  const entry = `# Skelcrew's runtime database. It stays out of git.\n${databaseLine}\n`;
  if (!existsSync(full)) {
    writeFileSync(full, entry, { flag: "wx" });
    report.created.push(path);
    return;
  }
  const current = readFileSync(full, "utf8");
  const lines = current.split("\n").map((line) => line.trim());
  if (lines.includes(databaseLine) || lines.includes(`/${databaseLine}`)) {
    report.unchanged.push(path);
    return;
  }
  const gap = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(full, `${gap}${entry}`);
  report.updated.push(path);
}
