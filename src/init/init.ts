// What `skelcrew init` does to a repository. It writes .skelcrew/workflow.yml
// with the checks it finds and the setup they need, such as installing the
// dependencies. It keeps Skelcrew's runtime files out of git,
// writes the default skills to .agents/skills, links each one into
// .claude/skills for Claude Code, links CLAUDE.md to AGENTS.md when only
// AGENTS.md is there, and makes Claude Code ask you before anything runs
// skelcrew approve. It never overwrites a file or replaces
// anything with a link, so running it again changes nothing. It only adds to two files you may have: the missing
// runtime lines to .gitignore, and the approve rules to
// .claude/settings.json. Everything else in them is kept.
//
// Running the chosen checks on the current code is a separate step for the
// caller: `localChecks(report.checks)(dir)` from src/checks/checks.ts.

import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseWorkflow, workflowFile } from "../config/workflow";
import { detectChecks, detectSetup } from "./detect";
import { leftOutBy } from "./gitignore";
import { outsideLink, outsideWarning } from "./paths";
import { type AskBeforeApprove, addAskRule, askBeforeApproveLimit, settingsPath } from "./settings";
import { defaultSkills } from "./skills";

// What init did. Each path is relative to the repository.
export type InitReport = {
  // The checks workflow.yml holds: the ones init chose, or the ones in the
  // file that was already there.
  checks: string[];
  // The commands that prepare a fresh copy of the code before the checks,
  // such as bun install --frozen-lockfile. Chosen the same way, or taken
  // from the workflow.yml that was already there.
  setup: string[];
  // Files that didn't exist and now do.
  created: string[];
  // Links that didn't exist and now do, such as .claude/skills/spec, which
  // shows Claude Code the skill in .agents/skills/spec.
  linked: string[];
  // Files that existed and had something added: .gitignore, and
  // .claude/settings.json when the approve rules went in.
  updated: string[];
  // Files and links that existed and were left exactly as they were.
  unchanged: string[];
  // Files and links init didn't make. Most would land outside the
  // repository, through a link such as .claude pointing at ~/.claude.
  // Some links can't be made at all. Each has a warning that says why and
  // how to add it.
  byHand: string[];
  // Things you should look at, such as a workflow.yml init couldn't read.
  warnings: string[];
  // Whether Claude Code will now ask you before skelcrew approve runs: the
  // rule was added, was there already, or is for you to add by hand.
  askBeforeApprove: AskBeforeApprove;
  // The guard in plain words: whether it is in place, what to add when
  // it isn't, and what it can't stop. A command typed another way, such as
  // through bash -c, runs without asking.
  askBeforeApproveLimit: string;
};

// A failed run may have written some files and made some links before it
// stopped. They are listed, so nothing is left behind without a word.
export type InitResult =
  | { ok: true; report: InitReport }
  | { ok: false; reason: string; created: string[]; updated: string[]; linked: string[] };

const workflowPath = ".skelcrew/workflow.yml";

// The files Skelcrew keeps in .skelcrew while it runs. They stay out of
// git. SQLite keeps two more files beside the database, ending in -wal and
// -shm, and the * in the first line covers them. The daemon keeps its log,
// a file naming its process, and the socket the CLI talks to it through.
const runtimeLines = [
  ".skelcrew/skelcrew.db*",
  ".skelcrew/daemon.log",
  ".skelcrew/daemon.pid",
  ".skelcrew/daemon.sock",
];

export function initRepository(dir: string): InitResult {
  const report: InitReport = {
    checks: [],
    setup: [],
    created: [],
    linked: [],
    updated: [],
    unchanged: [],
    byHand: [],
    warnings: [],
    askBeforeApprove: "add by hand",
    askBeforeApproveLimit: "",
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
    } else if (parsed.ok) {
      report.checks = parsed.workflow.checks;
      report.setup = parsed.workflow.setup;
    } else {
      report.warnings.push(
        `${workflowPath} was already there, but can't be read, so it was left as it is: ${parsed.reasons.join(" ")}`,
      );
    }
  } else {
    const detected = detectChecks(dir);
    if (!detected.ok) {
      return { ok: false, reason: detected.reason, created: [], updated: [], linked: [] };
    }
    report.checks = detected.checks;
    report.setup = detectSetup(dir);
    report.warnings.push(...detected.warnings);
    workflow = workflowFile(detected.checks, report.setup);
  }

  try {
    if (workflow === null) report.unchanged.push(workflowPath);
    else writeNew(dir, workflowPath, workflow, report);
    for (const skill of defaultSkills) writeNew(dir, skill.path, skill.text, report);
    for (const skill of defaultSkills) linkSkill(dir, dirname(skill.path), report);
    linkInstructions(dir, report);
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
    const done = [
      ...(written.length === 0 ? [] : [`written ${written.join(", ")}`]),
      ...(report.linked.length === 0 ? [] : [`linked ${report.linked.join(", ")}`]),
    ];
    const already =
      done.length === 0
        ? "It wrote nothing."
        : `It had already ${done.join(", and ")}, which are still there.`;
    return {
      ok: false,
      reason: `Setting up the repository failed: ${message} ${already}`,
      created: report.created,
      updated: report.updated,
      linked: report.linked,
    };
  }
  report.askBeforeApproveLimit = askBeforeApproveLimit(report.askBeforeApprove);
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

// Claude Code looks for skills in .claude/skills, not .agents/skills.
const claudeSkills = ".claude/skills";

// Links the skill's folder, such as .agents/skills/spec, into
// .claude/skills, so Claude Code finds it. The link is relative, so it
// still works when the repository is moved or cloned. Anything already at
// the link's place stays, whatever it is. Nothing is linked through a
// folder that leads outside the repository.
function linkSkill(dir: string, folder: string, report: InitReport): void {
  const name = basename(folder);
  const path = `${claudeSkills}/${name}`;
  const full = join(dir, path);
  // A link to a skill folder outside the repository would show Claude Code
  // a skill init didn't write.
  const outside = outsideLink(dir, folder) ?? outsideLink(dir, claudeSkills);
  if (outside !== null) {
    leaveOutside(path, outside, report);
    return;
  }
  // lstat, not exists, so that a link to nowhere counts as something there.
  if (isThere(full)) {
    report.unchanged.push(path);
    if (realPath(full) !== realPath(join(dir, folder))) {
      report.warnings.push(
        [
          `${path} is already there, so init left it alone.`,
          `Claude Code will use that one, not the ${name} skill in ${folder}.`,
          `To use the one in ${folder}, move ${path} out of the way and run init again.`,
        ].join(" "),
      );
    }
    return;
  }
  // Worked out from where the folders really are, in case .claude is a
  // link to another folder in the repository. With .claude a link to
  // config/claude, the link is ../../../.agents/skills/spec. The warning
  // below gives this same link, so its command makes one that works.
  const target = relative(realOrPlanned(join(dir, claudeSkills)), realOrPlanned(join(dir, folder)));
  try {
    mkdirSync(join(dir, claudeSkills), { recursive: true });
    symlinkSync(target, full);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.byHand.push(path);
    report.warnings.push(
      [
        `Init couldn't link ${path} to ${folder}: ${message}.`,
        `Claude Code won't find the ${name} skill until the link is there.`,
        `To add it, run \`ln -s ${target} ${path}\` in the repository.`,
      ].join(" "),
    );
    return;
  }
  report.linked.push(path);
}

// Project instructions live in AGENTS.md, which most harnesses read. Claude
// Code reads CLAUDE.md, so when there is an AGENTS.md and no CLAUDE.md,
// init makes CLAUDE.md a link to it. It never moves or rewrites either
// file. With both there, in any form, it leaves both alone. It makes the
// link only when AGENTS.md is a file in the repository it can read.
function linkInstructions(dir: string, report: InitReport): void {
  const path = "CLAUDE.md";
  const full = join(dir, path);
  const hasAgents = isThere(join(dir, "AGENTS.md"));
  if (isThere(full)) {
    report.unchanged.push(path);
    if (!hasAgents && !isLink(full)) {
      report.warnings.push(
        [
          "CLAUDE.md holds your project instructions, but only Claude Code reads it. Other harnesses read AGENTS.md.",
          "Init left it as it is.",
          "To share one file with every harness, move it to AGENTS.md, then make CLAUDE.md a link to it:",
          "`mv CLAUDE.md AGENTS.md && ln -s AGENTS.md CLAUDE.md`.",
        ].join(" "),
      );
    }
    return;
  }
  if (!hasAgents) return;
  const why = cantLinkAgents(dir);
  if (why !== null) {
    report.warnings.push(
      [
        `Init didn't make CLAUDE.md a link to AGENTS.md, because AGENTS.md ${why}.`,
        "Claude Code won't read your project instructions until CLAUDE.md is there.",
        "To add it, make AGENTS.md a file in the repository that you can read, and run init again.",
      ].join(" "),
    );
    return;
  }
  try {
    symlinkSync("AGENTS.md", full);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.byHand.push(path);
    report.warnings.push(
      [
        `Init couldn't link CLAUDE.md to AGENTS.md: ${message}.`,
        "Claude Code won't read your instructions until the link is there.",
        "To add it, run `ln -s AGENTS.md CLAUDE.md` in the repository.",
      ].join(" "),
    );
    return;
  }
  report.linked.push(path);
}

// Why CLAUDE.md shouldn't be a link to AGENTS.md, or null when it can be.
// CLAUDE.md is committed and Claude Code reads it. So AGENTS.md must be a
// file inside the repository that can be read. A link to a private file
// outside it would show that file to Claude Code.
function cantLinkAgents(dir: string): string | null {
  const full = join(dir, "AGENTS.md");
  if (isLink(full) && !existsSync(full)) return "is a link that leads nowhere";
  if (outsideLink(dir, "AGENTS.md") !== null) {
    return "is a link to a place outside the repository";
  }
  try {
    if (!statSync(full).isFile()) return "isn't a file";
    accessSync(full, constants.R_OK);
  } catch {
    return "can't be read";
  }
  return null;
}

function isThere(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Where the path really is, following every link on the way. A part that
// isn't there yet is added as it is, after the real path of the part above
// it. So .claude/skills, with .claude a link to config/claude and no
// skills folder yet, gives the repository's config/claude/skills.
function realOrPlanned(path: string): string {
  const real = realPath(path);
  if (real !== null) return real;
  const parent = dirname(path);
  if (parent === path) return path;
  return join(realOrPlanned(parent), basename(path));
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
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
  report.warnings.push(...sharedFilesLeftOut(lines));
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

// What init sets up for Claude Code and means to be committed: the skill
// links, the approve rules, and the skills the links lead to.
const shared = [
  ...defaultSkills.map((skill) => `${claudeSkills}/${basename(dirname(skill.path))}`),
  settingsPath,
  ...defaultSkills.map((skill) => skill.path),
];

// A warning for each .gitignore line that leaves out some of them. Git
// wouldn't see those files, so teammates who clone wouldn't get them.
function sharedFilesLeftOut(lines: string[]): string[] {
  const byLine = new Map<string, string[]>();
  for (const path of shared) {
    const line = leftOutBy(lines, path);
    if (line !== null) byLine.set(line, [...(byLine.get(line) ?? []), path]);
  }
  return [...byLine].map(([line, paths]) =>
    [
      `.gitignore has the line ${line}, which leaves out ${paths.join(", ")}.`,
      "Git won't see them, so teammates who clone the repository won't get them.",
      "To share them, remove that line, or change it so it no longer covers them.",
    ].join(" "),
  );
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
