// What `skelcrew init` does to a repository. It writes .skelcrew/workflow.yml
// with the checks it finds, keeps Skelcrew's runtime files out of git,
// writes the default skills, and makes Claude Code ask you before anything
// runs skelcrew approve. It never overwrites a file, so running it again
// changes nothing. It only adds to two files you may have: the missing
// runtime lines to .gitignore, and the approve rules to
// .claude/settings.json. Everything else in them is kept.
//
// Running the chosen checks on the current code is a separate step for the
// caller: `localChecks(report.checks)(dir)` from src/checks/checks.ts.

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseWorkflow, workflowFile } from "../config/workflow";
import { detectChecks } from "./detect";
import { outsideLink, outsideWarning } from "./paths";
import { type AskBeforeApprove, addAskRule, askBeforeApproveLimit, settingsPath } from "./settings";
import { defaultSkills } from "./skills";

// What init did. Each path is relative to the repository.
export type InitReport = {
  // The checks workflow.yml holds: the ones init chose, or the ones in the
  // file that was already there.
  checks: string[];
  // Files that didn't exist and now do.
  created: string[];
  // Files that existed and had something added: .gitignore, and
  // .claude/settings.json when the approve rules went in.
  updated: string[];
  // Files that existed and were left exactly as they were.
  unchanged: string[];
  // Files init didn't write because they would land outside the
  // repository, through a link such as .claude pointing at ~/.claude. Each
  // has a warning that says why and how to add it.
  byHand: string[];
  // Things you should look at, such as a workflow.yml init couldn't read.
  warnings: string[];
  // Whether Claude Code will now ask you before skelcrew approve runs: the
  // rule was added, was there already, or is for you to add by hand.
  askBeforeApprove: AskBeforeApprove;
  // What the rules can't stop, in plain words: a command typed another
  // way, such as through bash -c, runs without asking.
  askBeforeApproveLimit: string;
};

// A failed run may have written some files before it stopped. They are
// listed, so nothing is left behind without a word.
export type InitResult =
  | { ok: true; report: InitReport }
  | { ok: false; reason: string; created: string[]; updated: string[] };

const workflowPath = ".skelcrew/workflow.yml";

// The files Skelcrew keeps in .skelcrew while it runs. They stay out of
// git. SQLite keeps two more files beside the database, ending in -wal and
// -shm, and the * in the first line covers them. The daemon keeps its log,
// the lock that stops a second daemon starting, and the socket the CLI
// talks to it through.
const runtimeLines = [
  ".skelcrew/skelcrew.db*",
  ".skelcrew/daemon.log",
  ".skelcrew/daemon.lock",
  ".skelcrew/daemon.sock",
];

export function initRepository(dir: string): InitResult {
  const report: InitReport = {
    checks: [],
    created: [],
    updated: [],
    unchanged: [],
    byHand: [],
    warnings: [],
    askBeforeApprove: "add by hand",
    askBeforeApproveLimit,
  };

  // The checks come first. If there are none, nothing is written at all.
  let workflow: string | null = null;
  if (existsSync(join(dir, workflowPath))) {
    const text = readText(join(dir, workflowPath));
    const parsed = text === null ? null : parseWorkflow(text);
    if (parsed === null) {
      report.warnings.push(
        `${workflowPath} is there, but can't be opened, so it was left as it is. Check that it is a file you can read.`,
      );
    } else if (parsed.ok) report.checks = parsed.workflow.checks;
    else {
      report.warnings.push(
        `${workflowPath} was already there, but can't be read, so it was left as it is: ${parsed.reasons.join(" ")}`,
      );
    }
  } else {
    const detected = detectChecks(dir);
    if (!detected.ok) return { ok: false, reason: detected.reason, created: [], updated: [] };
    report.checks = detected.checks;
    report.warnings.push(...detected.warnings);
    workflow = workflowFile(detected.checks);
  }

  try {
    if (workflow === null) report.unchanged.push(workflowPath);
    else writeNew(dir, workflowPath, workflow, report);
    for (const skill of defaultSkills) writeNew(dir, skill.path, skill.text, report);
    const settingsLink = outsideLink(dir, settingsPath);
    if (settingsLink === null) {
      const settings = addAskRule(dir);
      report[settings.file].push(settingsPath);
      report.askBeforeApprove = settings.askBeforeApprove;
      if (settings.warning !== null) report.warnings.push(settings.warning);
    } else leaveOutside(settingsPath, settingsLink, report);
    ignoreRuntimeFiles(dir, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const written = [...report.created, ...report.updated];
    const already =
      written.length === 0
        ? "It wrote nothing."
        : `It had already written ${written.join(", ")}, which are still there.`;
    return {
      ok: false,
      reason: `Setting up the repository failed: ${message} ${already}`,
      created: report.created,
      updated: report.updated,
    };
  }
  return { ok: true, report };
}

// Writes the file only if there is none. The "wx" flag makes the write
// itself refuse an existing file, so nothing is overwritten even if a file
// appears between the check and the write. A file that would land outside
// the repository, through a link, isn't written at all.
function writeNew(dir: string, path: string, text: string, report: InitReport): void {
  const full = join(dir, path);
  const link = outsideLink(dir, path);
  if (link !== null) {
    leaveOutside(path, link, report);
    return;
  }
  if (existsSync(full)) {
    report.unchanged.push(path);
    return;
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, { flag: "wx" });
  report.created.push(path);
}

function leaveOutside(path: string, link: string, report: InitReport): void {
  report.byHand.push(path);
  report.warnings.push(outsideWarning(path, link));
}

// Lines that leave out the whole .skelcrew folder. Git would then never
// see workflow.yml, so your rules could never be committed.
const wholeFolder = [".skelcrew", ".skelcrew/", ".skelcrew/*", ".skelcrew/**"];

// A later line can add workflow.yml back, as in `.skelcrew/*` followed by
// `!.skelcrew/workflow.yml`. That works only when the line leaves out
// what is in the folder. Git never looks inside a folder that is left out
// whole, such as `.skelcrew/`, so no later line can add a file back.
const contentsOnly = [".skelcrew/*", ".skelcrew/**"];
const keepWorkflow = "!.skelcrew/workflow.yml";

// Adds the runtime files to .gitignore, after whatever is there already.
// Each line goes in once. A line already there, with or without a leading
// slash, isn't added again.
function ignoreRuntimeFiles(dir: string, report: InitReport): void {
  const path = ".gitignore";
  const full = join(dir, path);
  const comment = "# Skelcrew's runtime files. They stay out of git.";
  const listed = runtimeLines.join(", ");

  // A linked .gitignore lives somewhere else, maybe outside the repository
  // or shared with other ones. It isn't init's to change.
  if (isLink(full)) {
    report.unchanged.push(path);
    report.warnings.push(
      `${path} is a link to another file, so init left it alone. Add these lines to it yourself, to keep Skelcrew's runtime files out of git: ${listed}.`,
    );
    return;
  }
  if (!existsSync(full)) {
    writeFileSync(full, `${[comment, ...runtimeLines].join("\n")}\n`, { flag: "wx" });
    report.created.push(path);
    return;
  }

  const current = readFileSync(full, "utf8");
  const lines = current.split("\n").map((line) => line.trim());
  const folderLine = lines.findLast((line) => wholeFolder.includes(line.replace(/^\//, "")));
  const addedBack =
    folderLine !== undefined &&
    contentsOnly.includes(folderLine.replace(/^\//, "")) &&
    lines
      .slice(lines.lastIndexOf(folderLine) + 1)
      .some((line) => line.replace(/^!\//, "!") === keepWorkflow);
  if (folderLine !== undefined && !addedBack) {
    report.warnings.push(
      `${path} has the line ${folderLine}, which leaves out all of .skelcrew. Git will never see .skelcrew/workflow.yml, so your rules can't be committed. Replace that line with these: ${listed}.`,
    );
  }
  const missing = runtimeLines.filter(
    (line) => !lines.includes(line) && !lines.includes(`/${line}`),
  );
  if (missing.length === 0) {
    report.unchanged.push(path);
    return;
  }
  // A file written on Windows ends its lines with \r\n. The new lines end
  // the same way, so the file doesn't end up with a mix.
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const gap = current === "" || current.endsWith("\n") ? "" : eol;
  appendFileSync(full, `${gap}${[comment, ...missing].join(eol)}${eol}`);
  report.updated.push(path);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// The file's text, or null if it can't be read, such as a folder.
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
