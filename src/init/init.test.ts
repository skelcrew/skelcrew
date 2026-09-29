import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseWorkflow } from "../config/workflow";
import { initRepository } from "./init";
import { defaultSkills } from "./skills";

let dirs: string[] = [];
// A throwaway repository folder holding the files it is given.
function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "skelcrew-init-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// Every file in the folder with its text, to see that nothing changed.
function everything(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(dir, path)] = readFileSync(path, "utf8");
  }
  return files;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

const bunApp = {
  "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "biome ci ." } }),
  "bun.lock": "",
};
const workflow = ".skelcrew/workflow.yml";
const specSkill = ".claude/skills/spec/SKILL.md";
const developSkill = ".claude/skills/develop/SKILL.md";
const dbLine = ".skelcrew/skelcrew.db*";

describe("initRepository", () => {
  test("sets up a fresh repository, and says what it created", () => {
    const dir = repo(bunApp);
    const result = initRepository(dir);
    expect(result).toEqual({
      ok: true,
      report: {
        checks: ["bun run test", "bun run lint"],
        created: [workflow, specSkill, developSkill, ".gitignore"],
        updated: [],
        unchanged: [],
        warnings: [],
      },
    });
  });

  test("writes a workflow.yml that reads back with the checks it found", () => {
    const dir = repo(bunApp);
    initRepository(dir);
    const parsed = parseWorkflow(read(dir, workflow));
    if (!parsed.ok) throw new Error(parsed.reasons.join(" "));
    expect(parsed.workflow.checks).toEqual(["bun run test", "bun run lint"]);
  });

  test("writes the default skills where Claude Code looks for them", () => {
    const dir = repo(bunApp);
    initRepository(dir);
    for (const skill of defaultSkills) expect(read(dir, skill.path)).toBe(skill.text);
  });

  // The database, and the files SQLite keeps beside it, are runtime state.
  test("keeps the database out of git", () => {
    const dir = repo(bunApp);
    initRepository(dir);
    expect(read(dir, ".gitignore").split("\n")).toContain(dbLine);
  });

  test("keeps an existing workflow.yml as it is, and uses its checks", () => {
    const mine = "# my own rules\nchecks:\n  - make ci\n";
    const dir = repo({ ...bunApp, [workflow]: mine });
    const result = initRepository(dir);
    expect(read(dir, workflow)).toBe(mine);
    expect(result.ok && result.report.checks).toEqual(["make ci"]);
    expect(result.ok && result.report.unchanged).toContain(workflow);
    expect(result.ok && result.report.created).not.toContain(workflow);
  });

  test("keeps an existing workflow.yml even when no checks can be found", () => {
    const dir = repo({ [workflow]: "checks:\n  - ./run-tests\n" });
    const result = initRepository(dir);
    expect(result.ok && result.report.checks).toEqual(["./run-tests"]);
  });

  test("keeps a workflow.yml it can't read, and warns about it", () => {
    const broken = "checks: [\n";
    const dir = repo({ ...bunApp, [workflow]: broken });
    const result = initRepository(dir);
    expect(read(dir, workflow)).toBe(broken);
    expect(result.ok && result.report.checks).toEqual([]);
    const warnings = result.ok ? result.report.warnings : [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("workflow.yml");
  });

  test("keeps an existing skill as it is, and still writes the other one", () => {
    const mine = "---\nname: spec\ndescription: My own way to spec.\n---\n";
    const dir = repo({ ...bunApp, [specSkill]: mine });
    const result = initRepository(dir);
    expect(read(dir, specSkill)).toBe(mine);
    expect(result.ok && result.report.unchanged).toEqual([specSkill]);
    expect(result.ok && result.report.created).toContain(developSkill);
  });

  test("adds the database to an existing .gitignore, keeping what it had", () => {
    const mine = "node_modules/\n# build output\ndist";
    const dir = repo({ ...bunApp, ".gitignore": mine });
    const result = initRepository(dir);
    const text = read(dir, ".gitignore");
    expect(text.startsWith(`${mine}\n`)).toBe(true);
    expect(text.split("\n").filter((line) => line === dbLine)).toHaveLength(1);
    expect(result.ok && result.report.updated).toEqual([".gitignore"]);
  });

  test("leaves a .gitignore that already ignores the database alone", () => {
    const mine = `node_modules/\n${dbLine}\n`;
    const dir = repo({ ...bunApp, ".gitignore": mine });
    const result = initRepository(dir);
    expect(read(dir, ".gitignore")).toBe(mine);
    expect(result.ok && result.report.unchanged).toContain(".gitignore");
  });

  test("changes nothing when run a second time", () => {
    const dir = repo({ ...bunApp, ".gitignore": "node_modules/\n" });
    initRepository(dir);
    const before = everything(dir);
    const second = initRepository(dir);
    expect(everything(dir)).toEqual(before);
    expect(second).toEqual({
      ok: true,
      report: {
        checks: ["bun run test", "bun run lint"],
        created: [],
        updated: [],
        unchanged: [workflow, specSkill, developSkill, ".gitignore"],
        warnings: [],
      },
    });
  });

  test("writes nothing when it finds no checks, and says why", () => {
    const dir = repo({ "README.md": "# app\n" });
    const result = initRepository(dir);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("Found no checks to run");
    expect(everything(dir)).toEqual({ "README.md": "# app\n" });
    expect(existsSync(join(dir, ".skelcrew"))).toBe(false);
  });
});
