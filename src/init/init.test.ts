import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
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

// Every link in the folder with where it points, to see that nothing
// changed. Links are not followed.
function links(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const path = join(entry.parentPath, entry.name);
    found[relative(dir, path)] = readlinkSync(path);
  }
  return found;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

// Whether anything is at the path, even a link to nowhere.
function isThere(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const bunApp = {
  "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "biome ci ." } }),
  "bun.lock": "",
};
const workflow = ".skelcrew/workflow.yml";
const specSkill = ".agents/skills/spec/SKILL.md";
const developSkill = ".agents/skills/develop/SKILL.md";
// Claude Code looks for skills in .claude/skills, so init links each one
// there.
const specLink = ".claude/skills/spec";
// Every default skill, in the order init writes them: the agents' spec and
// develop, then the developer's own verbs.
const skillNames = ["spec", "develop", "idea", "crew", "show", "approve"];
const skillFiles = skillNames.map((name) => `.agents/skills/${name}/SKILL.md`);
const skillLinks = skillNames.map((name) => `.claude/skills/${name}`);
// Where each link in .claude/skills leads.
const linkTargets = Object.fromEntries(
  skillNames.map((name) => [`.claude/skills/${name}`, `../../.agents/skills/${name}`]),
);
const dbLine = ".skelcrew/skelcrew.db*";
// The files the daemon keeps while it runs: its log, the file naming its
// process, and the socket the CLI talks to it through.
const runtimeLines = [
  dbLine,
  ".skelcrew/daemon.log",
  ".skelcrew/daemon.pid",
  ".skelcrew/daemon.sock",
];
const settings = ".claude/settings.json";

// Root ignores file permissions, so the tests that make a file or folder
// unreadable or read-only would test nothing. They are skipped as root.
const asRoot = process.getuid?.() === 0;
// The Claude Code permission rules that make it ask you before an agent
// runs skelcrew approve or skelcrew reject. Each catches one usual way of
// typing it: plain, through bunx, bun x or npx, or by a path to the
// program, such as ./node_modules/.bin/skelcrew. The docs say a rule
// matches only the way it is written, and a leading * stands in for any
// text.
const askRules = [
  "Bash(skelcrew approve *)",
  "Bash(bunx skelcrew approve *)",
  "Bash(bun x skelcrew approve *)",
  "Bash(npx skelcrew approve *)",
  "Bash(*/skelcrew approve *)",
  "Bash(skelcrew reject *)",
  "Bash(bunx skelcrew reject *)",
  "Bash(bun x skelcrew reject *)",
  "Bash(npx skelcrew reject *)",
  "Bash(*/skelcrew reject *)",
];
// The report must say plainly that the rules can be got round.
const saysItCanBeBypassed = expect.stringContaining("bash -c");

describe("initRepository", () => {
  test("sets up a fresh repository, and says what it created", () => {
    const dir = repo(bunApp);
    const result = initRepository(dir);
    expect(result).toEqual({
      ok: true,
      report: {
        checks: ["bun run test", "bun run lint"],
        setup: ["bun install --frozen-lockfile"],
        created: [workflow, ...skillFiles, settings, ".gitignore"],
        linked: skillLinks,
        updated: [],
        unchanged: [],
        byHand: [],
        warnings: [],
        askBeforeApprove: "added",
        askBeforeApproveLimit: saysItCanBeBypassed,
      },
    });
  });

  test("passes on a warning about the checks it found", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "./run-tests.sh" } }) });
    const result = initRepository(dir);
    const warnings = result.ok ? result.report.warnings : [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("./run-tests.sh");
  });

  test("writes a workflow.yml that reads back with the checks it found", () => {
    const dir = repo(bunApp);
    initRepository(dir);
    const parsed = parseWorkflow(read(dir, workflow));
    if (!parsed.ok) throw new Error(parsed.reasons.join(" "));
    expect(parsed.workflow.checks).toEqual(["bun run test", "bun run lint"]);
    expect(parsed.workflow.setup).toEqual(["bun install --frozen-lockfile"]);
  });

  test("keeps an existing workflow.yml's setup, and reports it", () => {
    const mine = "setup:\n  - make deps\nchecks:\n  - make ci\n";
    const dir = repo({ ...bunApp, [workflow]: mine });
    const result = initRepository(dir);
    expect(result.ok && result.report.setup).toEqual(["make deps"]);
  });

  test("writes the default skills in .agents/skills", () => {
    const dir = repo(bunApp);
    initRepository(dir);
    for (const skill of defaultSkills) expect(read(dir, skill.path)).toBe(skill.text);
    expect(defaultSkills.map((skill) => skill.path)).toEqual(skillFiles);
  });

  // The database, the files SQLite keeps beside it, and the daemon's own
  // files are runtime state.
  test("keeps the database and the daemon's files out of git", () => {
    const dir = repo(bunApp);
    initRepository(dir);
    const lines = read(dir, ".gitignore").split("\n");
    for (const line of runtimeLines) expect(lines).toContain(line);
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

  // A folder where a file should be, or a file you may not read, must end
  // in a report, not a crash.
  test.skipIf(asRoot)("warns about a workflow.yml it can't open, and goes on", () => {
    const folder = repo(bunApp);
    mkdirSync(join(folder, workflow), { recursive: true });
    const locked = repo({ ...bunApp, [workflow]: "checks:\n  - make ci\n" });
    chmodSync(join(locked, workflow), 0o000);
    for (const dir of [folder, locked]) {
      const result = initRepository(dir);
      expect(result.ok).toBe(true);
      const warnings = result.ok ? result.report.warnings : [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("workflow.yml");
      expect(result.ok && result.report.unchanged).toContain(workflow);
      expect(result.ok && result.report.created).toContain(developSkill);
    }
    chmodSync(join(locked, workflow), 0o644);
  });

  // A file where the develop skill's folder should be makes that write
  // fail, after workflow.yml and the spec skill are written.
  test("says which files it wrote when a later step fails", () => {
    const dir = repo({ ...bunApp, ".agents/skills/develop": "not a folder" });
    const result = initRepository(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.created).toEqual([workflow, specSkill]);
    expect(result.linked).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.reason).toContain(workflow);
    expect(result.reason).toContain(specSkill);
  });

  // Some people link a repository's .claude folder to their own ~/.claude.
  // Writing through that link would change their own settings and skills.
  // The home folder here is a throwaway folder, never the real one.
  describe("a folder that links outside the repository", () => {
    function fakeHome(): string {
      const home = repo({ ".claude/settings.json": '{\n  "model": "opus"\n}\n' });
      mkdirSync(join(home, ".claude/skills"));
      return home;
    }

    test("writes nothing through a linked .claude folder, and says what to add by hand", () => {
      const home = fakeHome();
      const before = everything(home);
      const dir = repo(bunApp);
      symlinkSync(join(home, ".claude"), join(dir, ".claude"));
      const result = initRepository(dir);
      expect(everything(home)).toEqual(before);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.byHand).toEqual([...skillLinks, settings]);
      expect(result.report.created).toEqual([workflow, ...skillFiles, ".gitignore"]);
      expect(result.report.linked).toEqual([]);
      expect(result.report.askBeforeApprove).toBe("add by hand");
      expect(result.report.warnings).toHaveLength(skillLinks.length + 1);
      for (const warning of result.report.warnings) {
        expect(warning).toContain(".claude");
        expect(warning).toContain("outside the repository");
      }
    });

    // Other tools read .agents from your home folder too, so a repository
    // may link its own .agents there.
    test("writes nothing through a linked .agents folder, and says what to add by hand", () => {
      const home = repo({ ".agents/skills/mine/SKILL.md": "my own skill\n" });
      const before = everything(home);
      const dir = repo(bunApp);
      symlinkSync(join(home, ".agents"), join(dir, ".agents"));
      const result = initRepository(dir);
      expect(everything(home)).toEqual(before);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.byHand).toEqual([...skillFiles, ...skillLinks]);
      expect(result.report.created).toEqual([workflow, settings, ".gitignore"]);
      expect(result.report.linked).toEqual([]);
      expect(links(dir)).toEqual({ ".agents": join(home, ".agents") });
      expect(result.report.warnings).toHaveLength(skillFiles.length + skillLinks.length);
      for (const warning of result.report.warnings) {
        expect(warning).toContain(".agents");
        expect(warning).toContain("outside the repository");
        expect(warning).toContain("~/.agents");
        expect(warning).not.toContain("~/.claude");
      }
    });

    test("writes nothing through a linked .agents/skills folder", () => {
      const home = repo({ ".agents/skills/mine/SKILL.md": "my own skill\n" });
      const before = everything(home);
      const dir = repo(bunApp);
      mkdirSync(join(dir, ".agents"));
      symlinkSync(join(home, ".agents/skills"), join(dir, ".agents/skills"));
      const result = initRepository(dir);
      expect(everything(home)).toEqual(before);
      expect(result.ok && result.report.byHand).toEqual([...skillFiles, ...skillLinks]);
      expect(result.ok && result.report.created).toContain(settings);
      expect(existsSync(join(dir, specLink))).toBe(false);
    });

    test("links nothing through a .claude/skills folder that links outside", () => {
      const home = repo({ ".claude/skills/mine/SKILL.md": "my own skill\n" });
      const before = everything(home);
      const dir = repo(bunApp);
      mkdirSync(join(dir, ".claude"));
      symlinkSync(join(home, ".claude/skills"), join(dir, ".claude/skills"));
      const result = initRepository(dir);
      expect(everything(home)).toEqual(before);
      expect(links(home)).toEqual({});
      expect(result.ok && result.report.byHand).toEqual(skillLinks);
      expect(result.ok && result.report.created).toContain(specSkill);
    });

    test("writes nothing through a linked .skelcrew folder", () => {
      const elsewhere = repo();
      const dir = repo(bunApp);
      symlinkSync(elsewhere, join(dir, ".skelcrew"));
      const result = initRepository(dir);
      expect(everything(elsewhere)).toEqual({});
      expect(result.ok && result.report.byHand).toEqual([workflow]);
    });

    // A link that stays inside the repository is fine.
    test("writes through a link that stays inside the repository", () => {
      const dir = repo(bunApp);
      mkdirSync(join(dir, "config/claude"), { recursive: true });
      symlinkSync(join(dir, "config/claude"), join(dir, ".claude"));
      mkdirSync(join(dir, "config/agents"), { recursive: true });
      symlinkSync(join(dir, "config/agents"), join(dir, ".agents"));
      const result = initRepository(dir);
      expect(result.ok && result.report.byHand).toEqual([]);
      expect(existsSync(join(dir, "config/claude/settings.json"))).toBe(true);
      expect(existsSync(join(dir, "config/agents/skills/spec/SKILL.md"))).toBe(true);
      expect(result.ok && result.report.linked).toEqual(skillLinks);
      expect(read(dir, `${specLink}/SKILL.md`)).toBe(read(dir, specSkill));
    });
  });

  test("says why it stopped when a Makefile can't be read", () => {
    const dir = repo();
    mkdirSync(join(dir, "Makefile"));
    const result = initRepository(dir);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("Makefile");
  });

  test("keeps an existing skill as it is, and still writes the other one", () => {
    const mine = "---\nname: spec\ndescription: My own way to spec.\n---\n";
    const dir = repo({ ...bunApp, [specSkill]: mine });
    const result = initRepository(dir);
    expect(read(dir, specSkill)).toBe(mine);
    expect(result.ok && result.report.unchanged).toEqual([specSkill]);
    expect(result.ok && result.report.created).toContain(developSkill);
  });

  test("adds the runtime files to an existing .gitignore, keeping what it had", () => {
    const mine = "node_modules/\n# build output\ndist";
    const dir = repo({ ...bunApp, ".gitignore": mine });
    const result = initRepository(dir);
    const text = read(dir, ".gitignore");
    expect(text.startsWith(`${mine}\n`)).toBe(true);
    for (const runtime of runtimeLines) {
      expect(text.split("\n").filter((line) => line === runtime)).toHaveLength(1);
    }
    expect(result.ok && result.report.updated).toEqual([".gitignore"]);
  });

  test("adds only the lines a .gitignore is missing", () => {
    const mine = `node_modules/\n${dbLine}\n/.skelcrew/daemon.log\n`;
    const dir = repo({ ...bunApp, ".gitignore": mine });
    const result = initRepository(dir);
    const text = read(dir, ".gitignore");
    expect(text.startsWith(mine)).toBe(true);
    const added = text.slice(mine.length).split("\n");
    expect(added).toContain(".skelcrew/daemon.pid");
    expect(added).toContain(".skelcrew/daemon.sock");
    expect(added).not.toContain(dbLine);
    expect(added).not.toContain(".skelcrew/daemon.log");
    expect(result.ok && result.report.updated).toEqual([".gitignore"]);
  });

  test("leaves a .gitignore that already ignores the runtime files alone", () => {
    const mine = `node_modules/\n${runtimeLines.join("\n")}\n`;
    const dir = repo({ ...bunApp, ".gitignore": mine });
    const result = initRepository(dir);
    expect(read(dir, ".gitignore")).toBe(mine);
    expect(result.ok && result.report.unchanged).toContain(".gitignore");
  });

  // A linked .gitignore lives outside the repository, or is shared with
  // other ones. Init doesn't change it.
  test("leaves a linked .gitignore alone, and says what to add", () => {
    const dir = repo({ ...bunApp, "shared-ignore": "node_modules/\n" });
    symlinkSync(join(dir, "shared-ignore"), join(dir, ".gitignore"));
    const result = initRepository(dir);
    expect(read(dir, "shared-ignore")).toBe("node_modules/\n");
    expect(result.ok && result.report.unchanged).toContain(".gitignore");
    const warnings = result.ok ? result.report.warnings : [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(".gitignore");
    for (const line of runtimeLines) expect(warnings[0]).toContain(line);
  });

  test("keeps the line endings of a .gitignore written on Windows", () => {
    const dir = repo({ ...bunApp, ".gitignore": "node_modules/\r\ndist\r\n" });
    initRepository(dir);
    const text = read(dir, ".gitignore");
    expect(text.startsWith("node_modules/\r\ndist\r\n")).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    for (const line of runtimeLines) expect(text.split("\r\n")).toContain(line);
  });

  // Git would then never see workflow.yml, so it could never be committed.
  test("warns when .gitignore leaves out all of .skelcrew", () => {
    for (const line of [".skelcrew/", "/.skelcrew", ".skelcrew", ".skelcrew/*", ".skelcrew/**"]) {
      const dir = repo({ ...bunApp, ".gitignore": `${line}\n` });
      const result = initRepository(dir);
      const warnings = result.ok ? result.report.warnings : [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(line);
      expect(warnings[0]).toContain("workflow.yml");
    }
  });

  // Git lets a later line add a file back, but only when the folder itself
  // isn't left out. Checked with git check-ignore.
  test("doesn't warn when a later .gitignore line adds workflow.yml back", () => {
    for (const lines of [
      ".skelcrew/*\n!.skelcrew/workflow.yml",
      "/.skelcrew/**\n!/.skelcrew/workflow.yml",
    ]) {
      const dir = repo({ ...bunApp, ".gitignore": `${lines}\n` });
      const result = initRepository(dir);
      expect(result.ok && result.report.warnings).toEqual([]);
    }
  });

  test("still warns when git can't add workflow.yml back", () => {
    for (const lines of [
      // Git never looks inside a folder that is left out whole.
      ".skelcrew/\n!.skelcrew/workflow.yml",
      ".skelcrew\n!.skelcrew/workflow.yml",
      // The last line that matches wins.
      ".skelcrew/*\n!.skelcrew/workflow.yml\n.skelcrew/*",
    ]) {
      const dir = repo({ ...bunApp, ".gitignore": `${lines}\n` });
      const result = initRepository(dir);
      const warnings = result.ok ? result.report.warnings : [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("workflow.yml");
    }
  });

  // The skill links, the skills and the approve rules are meant to be
  // committed, so teammates who clone the repository get them. Each case
  // below was checked with git check-ignore.
  describe("a .gitignore that leaves out what init sets up for Claude Code", () => {
    function warningsFor(gitignore: string): string[] {
      const dir = repo({ ...bunApp, ".gitignore": gitignore });
      const result = initRepository(dir);
      return result.ok ? result.report.warnings : [];
    }

    test("warns when it leaves out .claude", () => {
      for (const line of [".claude/", "/.claude", ".claude/*", ".claude/**", "**/.claude"]) {
        const warnings = warningsFor(`${line}\n`);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(line);
        for (const link of skillLinks) expect(warnings[0]).toContain(link);
        expect(warnings[0]).toContain(settings);
        expect(warnings[0]).toContain("clone");
      }
    });

    test("warns when it leaves out .claude/skills or .claude/settings.json alone", () => {
      const skills = warningsFor(".claude/skills/\n");
      expect(skills).toHaveLength(1);
      expect(skills[0]).toContain(specLink);
      expect(skills[0]).not.toContain(settings);
      for (const line of [".claude/settings.json", "*.json"]) {
        const warnings = warningsFor(`${line}\n`);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(settings);
        expect(warnings[0]).not.toContain(specLink);
      }
    });

    test("warns when it leaves out .agents or the skills in it", () => {
      for (const line of [".agents/", ".agents/*", "skills/"]) {
        const warnings = warningsFor(`${line}\n`);
        expect(warnings).toHaveLength(1);
        for (const file of skillFiles) expect(warnings[0]).toContain(file);
      }
    });

    // Git never looks inside a folder that is left out whole, so a later
    // line can't add a file back.
    test("still warns when a later line can't add a file back", () => {
      const warnings = warningsFor(".claude/\n!.claude/settings.json\n");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(settings);
      expect(warnings[0]).toContain(specLink);
    });

    test("doesn't warn when nothing init sets up is left out", () => {
      for (const lines of [
        ".claude/settings.local.json",
        ".claude/*\n!.claude/settings.json\n!.claude/skills/",
        ".claude/**\n!.claude/settings.json\n!.claude/skills/**\n!.claude/skills",
        // Git sees a link as a file, so a line for a folder doesn't match it.
        ".claude/skills/spec/",
      ]) {
        expect(warningsFor(`${lines}\n`)).toEqual([]);
      }
    });
  });

  test("changes nothing when run a second time", () => {
    const dir = repo({ ...bunApp, ".gitignore": "node_modules/\n" });
    initRepository(dir);
    const before = everything(dir);
    const linksBefore = links(dir);
    const second = initRepository(dir);
    expect(everything(dir)).toEqual(before);
    expect(links(dir)).toEqual(linksBefore);
    expect(Object.keys(linksBefore).sort()).toEqual([...skillLinks].sort());
    expect(second).toEqual({
      ok: true,
      report: {
        checks: ["bun run test", "bun run lint"],
        setup: ["bun install --frozen-lockfile"],
        created: [],
        linked: [],
        updated: [],
        unchanged: [workflow, ...skillFiles, ...skillLinks, settings, ".gitignore"],
        byHand: [],
        warnings: [],
        askBeforeApprove: "already there",
        askBeforeApproveLimit: saysItCanBeBypassed,
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

  describe("the links that show Claude Code the skills", () => {
    test("links each skill into .claude/skills, with a relative link", () => {
      const dir = repo(bunApp);
      initRepository(dir);
      for (const [link, target] of Object.entries(linkTargets)) {
        expect(readlinkSync(join(dir, link))).toBe(target);
      }
      for (const skill of defaultSkills) {
        const name = skill.path.split("/")[2] ?? "";
        expect(read(dir, `.claude/skills/${name}/SKILL.md`)).toBe(skill.text);
      }
    });

    // A relative link still works when the repository moves or is cloned.
    test("the links still work after the repository moves", () => {
      const dir = repo(bunApp);
      initRepository(dir);
      const moved = `${dir}-moved`;
      dirs.push(moved);
      renameSync(dir, moved);
      expect(read(moved, `${specLink}/SKILL.md`)).toBe(read(moved, specSkill));
    });

    test("leaves the other skills in .claude/skills as they are", () => {
      const dir = repo({ ...bunApp, ".claude/skills/mine/SKILL.md": "my own skill\n" });
      symlinkSync("../../elsewhere/theirs", join(dir, ".claude/skills/theirs"));
      initRepository(dir);
      expect(read(dir, ".claude/skills/mine/SKILL.md")).toBe("my own skill\n");
      expect(links(dir)).toEqual({
        ".claude/skills/theirs": "../../elsewhere/theirs",
        ...linkTargets,
      });
    });

    // Whatever is there already stays: a folder, say from an earlier init
    // that wrote the skills there, a file, a link to somewhere else, or a
    // link to nothing. Claude Code uses that one, so init says so.
    test("leaves anything already at a link's place alone, and says so", () => {
      const folder = repo({ ...bunApp, [`${specLink}/SKILL.md`]: "an older spec skill\n" });
      const file = repo({ ...bunApp, [specLink]: "a file\n" });
      const elsewhere = repo({ ...bunApp, "mine/spec/SKILL.md": "my own spec skill\n" });
      mkdirSync(join(elsewhere, ".claude/skills"), { recursive: true });
      symlinkSync("../../mine/spec", join(elsewhere, specLink));
      const broken = repo(bunApp);
      mkdirSync(join(broken, ".claude/skills"), { recursive: true });
      symlinkSync("../../nowhere", join(broken, specLink));
      for (const dir of [folder, file, elsewhere, broken]) {
        const before = everything(dir);
        const linksBefore = links(dir);
        const result = initRepository(dir);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.report.unchanged).toContain(specLink);
        expect(result.report.linked).toEqual(skillLinks.slice(1));
        expect(result.report.warnings).toHaveLength(1);
        expect(result.report.warnings[0]).toContain(specLink);
        expect(result.report.warnings[0]).toContain(".agents/skills/spec");
        for (const [path, text] of Object.entries(before)) expect(read(dir, path)).toBe(text);
        expect(links(dir)).toEqual({
          ...linksBefore,
          ...Object.fromEntries(Object.entries(linkTargets).filter(([link]) => link !== specLink)),
        });
      }
    });

    // A file where the skills folder should be means no link can be made.
    // That ends in a report, not a crash, and the rest of init still runs.
    test("says so when it can't make a link, and goes on", () => {
      const dir = repo({ ...bunApp, ".claude/skills": "not a folder\n" });
      const result = initRepository(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(read(dir, ".claude/skills")).toBe("not a folder\n");
      expect(result.report.linked).toEqual([]);
      expect(result.report.byHand).toEqual(skillLinks);
      expect(result.report.created).toContain(settings);
      expect(result.report.warnings).toHaveLength(skillLinks.length);
      for (const [i, link] of skillLinks.entries()) {
        expect(result.report.warnings[i]).toContain(link);
      }
    });

    // With .claude a link to config/claude, the real skills folder is
    // config/claude/skills, three folders below the repository. So the
    // link must be ../../../.agents/skills/spec, not ../../.agents/...
    // The command in the warning must make the link init would have made.
    test.skipIf(asRoot)(
      "gives a command that makes a working link when .claude is linked inside the repository",
      () => {
        const dir = repo(bunApp);
        mkdirSync(join(dir, "config/claude/skills"), { recursive: true });
        symlinkSync("config/claude", join(dir, ".claude"));
        const skills = join(dir, "config/claude/skills");
        chmodSync(skills, 0o555);
        let result: ReturnType<typeof initRepository>;
        try {
          result = initRepository(dir);
        } finally {
          chmodSync(skills, 0o755);
        }
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.report.byHand).toEqual(skillLinks);
        expect(result.report.warnings).toHaveLength(skillLinks.length);
        expect(result.report.warnings[0]).toContain(
          "`ln -s ../../../.agents/skills/spec .claude/skills/spec`",
        );
        // Running each command, as the warning says, gives a working link.
        for (const warning of result.report.warnings) {
          const command = /`ln -s (\S+) (\S+)`/.exec(warning);
          const target = command?.[1] ?? "";
          const path = command?.[2] ?? "";
          symlinkSync(target, join(dir, path));
        }
        for (const [i, link] of skillLinks.entries()) {
          expect(read(dir, `${link}/SKILL.md`)).toBe(read(dir, skillFiles[i] ?? ""));
        }
      },
    );

    // A folder where .gitignore should be makes the last step fail.
    test("lists the links it made when a later step fails", () => {
      const dir = repo(bunApp);
      mkdirSync(join(dir, ".gitignore"));
      const result = initRepository(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.linked).toEqual(skillLinks);
      for (const link of skillLinks) expect(result.reason).toContain(link);
    });
  });

  // Project instructions live in AGENTS.md, which any harness reads. Claude
  // Code reads CLAUDE.md, so init makes that a link to AGENTS.md. It never
  // moves or rewrites either file.
  describe("the link from CLAUDE.md to AGENTS.md", () => {
    const agents = "# Rules\n\nRun the tests.\n";

    test("links CLAUDE.md to AGENTS.md when there is no CLAUDE.md", () => {
      const dir = repo({ ...bunApp, "AGENTS.md": agents });
      const result = initRepository(dir);
      expect(readlinkSync(join(dir, "CLAUDE.md"))).toBe("AGENTS.md");
      expect(read(dir, "CLAUDE.md")).toBe(agents);
      expect(read(dir, "AGENTS.md")).toBe(agents);
      expect(result.ok && result.report.linked).toEqual([...skillLinks, "CLAUDE.md"]);
      expect(result.ok && result.report.warnings).toEqual([]);
    });

    test("leaves both alone when both are there, in any form", () => {
      const files = repo({ ...bunApp, "AGENTS.md": agents, "CLAUDE.md": "# Mine\n" });
      const linked = repo({ ...bunApp, "AGENTS.md": agents, "notes.md": "# Notes\n" });
      symlinkSync("notes.md", join(linked, "CLAUDE.md"));
      const broken = repo({ ...bunApp, "AGENTS.md": agents });
      symlinkSync("nowhere.md", join(broken, "CLAUDE.md"));
      for (const dir of [files, linked, broken]) {
        const before = everything(dir);
        const linksBefore = links(dir);
        const result = initRepository(dir);
        for (const [path, text] of Object.entries(before)) expect(read(dir, path)).toBe(text);
        expect(links(dir)).toEqual({
          ...linksBefore,
          ...linkTargets,
        });
        expect(result.ok && result.report.unchanged).toContain("CLAUDE.md");
        expect(result.ok && result.report.linked).toEqual(skillLinks);
        expect(result.ok && result.report.warnings).toEqual([]);
      }
    });

    test("leaves a CLAUDE.md alone when there is no AGENTS.md, and says how to switch", () => {
      const mine = "# My rules\n";
      const dir = repo({ ...bunApp, "CLAUDE.md": mine });
      const result = initRepository(dir);
      expect(read(dir, "CLAUDE.md")).toBe(mine);
      expect(links(dir)).not.toHaveProperty("CLAUDE.md");
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.unchanged).toContain("CLAUDE.md");
      expect(result.report.linked).toEqual(skillLinks);
      expect(result.report.warnings).toHaveLength(1);
      expect(result.report.warnings[0]).toContain("move it to AGENTS.md");
      expect(result.report.warnings[0]).toContain("make CLAUDE.md a link to it");
    });

    // CLAUDE.md is committed and read by Claude Code. A link to an
    // AGENTS.md that leads outside the repository, such as to a private
    // file, would show that file's text to Claude Code and commit a link to
    // it. A folder or a link to nowhere gives Claude Code nothing to read.
    test("makes no link when AGENTS.md isn't a readable file in the repository, and says why", () => {
      const home = repo({ "private.md": "# My private notes\n" });
      const outside = repo(bunApp);
      symlinkSync(join(home, "private.md"), join(outside, "AGENTS.md"));
      const folder = repo(bunApp);
      mkdirSync(join(folder, "AGENTS.md"));
      const broken = repo(bunApp);
      symlinkSync("nowhere.md", join(broken, "AGENTS.md"));
      const cases = [
        { dir: outside, why: "outside the repository" },
        { dir: folder, why: "isn't a file" },
        { dir: broken, why: "leads nowhere" },
      ];
      for (const { dir, why } of cases) {
        const result = initRepository(dir);
        expect(isThere(join(dir, "CLAUDE.md"))).toBe(false);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.report.linked).toEqual(skillLinks);
        expect(result.report.warnings).toHaveLength(1);
        expect(result.report.warnings[0]).toContain("CLAUDE.md");
        expect(result.report.warnings[0]).toContain(why);
      }
    });

    test.skipIf(asRoot)("makes no link to an AGENTS.md it can't read, and says why", () => {
      const dir = repo({ ...bunApp, "AGENTS.md": agents });
      chmodSync(join(dir, "AGENTS.md"), 0o000);
      try {
        const result = initRepository(dir);
        expect(isThere(join(dir, "CLAUDE.md"))).toBe(false);
        expect(result.ok && result.report.warnings).toEqual([
          expect.stringContaining("can't be read"),
        ]);
      } finally {
        chmodSync(join(dir, "AGENTS.md"), 0o644);
      }
    });

    test("links to an AGENTS.md that is a link to a file inside the repository", () => {
      const dir = repo({ ...bunApp, "docs/agents.md": agents });
      symlinkSync("docs/agents.md", join(dir, "AGENTS.md"));
      const result = initRepository(dir);
      expect(readlinkSync(join(dir, "CLAUDE.md"))).toBe("AGENTS.md");
      expect(read(dir, "CLAUDE.md")).toBe(agents);
      expect(result.ok && result.report.warnings).toEqual([]);
    });

    test("does nothing when there is neither", () => {
      const dir = repo(bunApp);
      const result = initRepository(dir);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
      expect(result.ok && result.report.linked).toEqual(skillLinks);
      expect(result.ok && result.report.unchanged).toEqual([]);
    });

    test("changes nothing when run a second time", () => {
      const dir = repo({ ...bunApp, "AGENTS.md": agents });
      initRepository(dir);
      const linksBefore = links(dir);
      const second = initRepository(dir);
      expect(links(dir)).toEqual(linksBefore);
      expect(linksBefore["CLAUDE.md"]).toBe("AGENTS.md");
      expect(second.ok && second.report.linked).toEqual([]);
      expect(second.ok && second.report.unchanged).toContain("CLAUDE.md");
      expect(second.ok && second.report.warnings).toEqual([]);
    });
  });

  describe("the rules that make Claude Code ask before skelcrew approve or reject", () => {
    const settingsJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

    test("writes a settings file with the rules when there is none", () => {
      const dir = repo(bunApp);
      initRepository(dir);
      expect(JSON.parse(read(dir, settings))).toEqual({ permissions: { ask: askRules } });
    });

    // Each rule stops one way of typing the command. Claude Code matches a
    // rule against the command as written, so these forms need their own.
    test("asks before the usual ways of typing skelcrew approve", () => {
      const dir = repo(bunApp);
      initRepository(dir);
      const rules = JSON.parse(read(dir, settings)).permissions.ask;
      for (const rule of [
        "Bash(skelcrew approve *)",
        "Bash(bunx skelcrew approve *)",
        "Bash(bun x skelcrew approve *)",
        "Bash(npx skelcrew approve *)",
        "Bash(*/skelcrew approve *)",
      ]) {
        expect(rules).toContain(rule);
      }
    });

    // An agent that sent a task back unasked would put words in the
    // developer's mouth: the next claim prints its note as "The developer's
    // note". So reject gets the same rules as approve.
    test("asks before the usual ways of typing skelcrew reject", () => {
      const dir = repo(bunApp);
      initRepository(dir);
      const rules = JSON.parse(read(dir, settings)).permissions.ask;
      for (const rule of [
        "Bash(skelcrew reject *)",
        "Bash(bunx skelcrew reject *)",
        "Bash(bun x skelcrew reject *)",
        "Bash(npx skelcrew reject *)",
        "Bash(*/skelcrew reject *)",
      ]) {
        expect(rules).toContain(rule);
      }
    });

    // Written another way, such as bash -c 'skelcrew approve 12', the
    // command still runs without a question. The report says so.
    test("says plainly that the rules can be got round", () => {
      const result = initRepository(repo(bunApp));
      const limit = result.ok ? result.report.askBeforeApproveLimit : "";
      expect(limit).toContain("bash -c");
      expect(limit).toContain("TUI");
    });

    // The rules in .claude/settings.json, and the skill setting that stops
    // an agent starting a skill itself, work only in Claude Code.
    test("says the guards work only in Claude Code, and what to do elsewhere", () => {
      const result = initRepository(repo(bunApp));
      const limit = result.ok ? result.report.askBeforeApproveLimit : "";
      expect(limit).toContain("only in Claude Code");
      expect(limit).toContain("In another harness, set up its own guard");
      expect(limit).toContain("typing skelcrew approve yourself");
      expect(limit).toContain("start the spec, develop and approve skills");
    });

    // When init couldn't add the rules, Claude Code doesn't ask yet. The
    // report must not say it does, and must say what to add.
    test("says the guard isn't in place yet when it couldn't add the rules", () => {
      const broken = repo({ ...bunApp, [settings]: "{ not json" });
      const home = repo({ ".claude/settings.json": "{}\n" });
      const linked = repo(bunApp);
      symlinkSync(join(home, ".claude"), join(linked, ".claude"));
      for (const dir of [broken, linked]) {
        const result = initRepository(dir);
        expect(result.ok && result.report.askBeforeApprove).toBe("add by hand");
        const limit = result.ok ? result.report.askBeforeApproveLimit : "";
        expect(limit).not.toContain("Claude Code asks before");
        expect(limit).toContain("not in place yet");
        for (const rule of askRules) expect(limit).toContain(rule);
        expect(limit).toContain("bash -c");
      }
    });

    test("says Claude Code asks before approve when the rules are there", () => {
      const added = initRepository(repo(bunApp));
      const dir = repo(bunApp);
      initRepository(dir);
      const already = initRepository(dir);
      for (const result of [added, already]) {
        const limit = result.ok ? result.report.askBeforeApproveLimit : "";
        expect(limit).toContain("Claude Code asks before");
        expect(limit).toContain("skelcrew approve or skelcrew reject");
        expect(limit).not.toContain("not in place yet");
      }
    });

    test("adds only the rules your settings don't have yet", () => {
      const have = ["Bash(git push *)", "Bash(skelcrew approve *)", "Bash(npx skelcrew approve:*)"];
      const dir = repo({ ...bunApp, [settings]: settingsJson({ permissions: { ask: have } }) });
      const result = initRepository(dir);
      expect(JSON.parse(read(dir, settings)).permissions.ask).toEqual([
        ...have,
        "Bash(bunx skelcrew approve *)",
        "Bash(bun x skelcrew approve *)",
        "Bash(*/skelcrew approve *)",
        "Bash(skelcrew reject *)",
        "Bash(bunx skelcrew reject *)",
        "Bash(bun x skelcrew reject *)",
        "Bash(npx skelcrew reject *)",
        "Bash(*/skelcrew reject *)",
      ]);
      expect(result.ok && result.report.updated).toContain(settings);
      expect(result.ok && result.report.askBeforeApprove).toBe("added");
    });

    test("never writes your personal settings file", () => {
      const dir = repo(bunApp);
      initRepository(dir);
      expect(existsSync(join(dir, ".claude/settings.local.json"))).toBe(false);
    });

    test("adds the rules to your settings, keeping everything else as it was", () => {
      const mine = {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        permissions: { allow: ["Bash(bun test *)"], ask: ["Bash(git push *)"] },
        env: { DEBUG: "1" },
      };
      const dir = repo({ ...bunApp, [settings]: settingsJson(mine) });
      const result = initRepository(dir);
      const expected = {
        ...mine,
        permissions: { allow: ["Bash(bun test *)"], ask: ["Bash(git push *)", ...askRules] },
      };
      expect(read(dir, settings)).toBe(settingsJson(expected));
      expect(result.ok && result.report.updated).toContain(settings);
      expect(result.ok && result.report.askBeforeApprove).toBe("added");
    });

    test("adds the list the rules go in when your settings have none", () => {
      const dir = repo({ ...bunApp, [settings]: settingsJson({ model: "opus" }) });
      initRepository(dir);
      expect(JSON.parse(read(dir, settings))).toEqual({
        model: "opus",
        permissions: { ask: askRules },
      });
    });

    test("keeps settings indented with tabs the same way", () => {
      const mine = `${JSON.stringify({ permissions: { ask: [] } }, null, "\t")}\n`;
      const dir = repo({ ...bunApp, [settings]: mine });
      initRepository(dir);
      const expected = JSON.stringify({ permissions: { ask: askRules } }, null, "\t");
      expect(read(dir, settings)).toBe(`${expected}\n`);
    });

    // The docs give two ways to write the same rule: "x *" and "x:*".
    test("leaves your settings alone when the rules are there already", () => {
      const older = askRules.map((rule) => rule.replace(/ \*\)$/, ":*)"));
      for (const rules of [askRules, older]) {
        const mine = settingsJson({ permissions: { ask: rules } });
        const dir = repo({ ...bunApp, [settings]: mine });
        const result = initRepository(dir);
        expect(read(dir, settings)).toBe(mine);
        expect(result.ok && result.report.unchanged).toContain(settings);
        expect(result.ok && result.report.askBeforeApprove).toBe("already there");
      }
    });

    // Each of these would need a guess, so init changes nothing and says
    // what to add by hand.
    test("leaves settings it can't safely change alone, and says what to add", () => {
      const unclear = [
        "{ not json",
        "[]",
        settingsJson({ permissions: "ask me" }),
        settingsJson({ permissions: { ask: "Bash(rm *)" } }),
        settingsJson({ permissions: { ask: [1] } }),
        // Written back, this would lose its layout.
        '{ "permissions": { "allow": ["Bash(ls *)"] } }\n',
        // JSON allows this key, but copying it in JavaScript would drop it.
        '{\n  "__proto__": {\n    "x": 1\n  }\n}\n',
      ];
      for (const mine of unclear) {
        const dir = repo({ ...bunApp, [settings]: mine });
        const result = initRepository(dir);
        expect(read(dir, settings)).toBe(mine);
        expect(result.ok && result.report.unchanged).toContain(settings);
        expect(result.ok && result.report.askBeforeApprove).toBe("add by hand");
        const warnings = result.ok ? result.report.warnings : [];
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(settings);
        for (const rule of askRules) expect(warnings[0]).toContain(rule);
      }
    });

    // A file or folder you may not write must end in a report, not a
    // crash. The rest of init still runs.
    test.skipIf(asRoot)("says what to add by hand when it can't write the settings file", () => {
      const mine = settingsJson({ model: "opus" });
      const lockedFile = repo({ ...bunApp, [settings]: mine });
      chmodSync(join(lockedFile, settings), 0o444);
      // With the skills folder there already, init needs to write only
      // settings.json in the locked folder. The links go in .claude/skills,
      // which stays open.
      const lockedFolder = repo(bunApp);
      mkdirSync(join(lockedFolder, ".claude/skills"), { recursive: true });
      chmodSync(join(lockedFolder, ".claude"), 0o555);
      try {
        for (const dir of [lockedFile, lockedFolder]) {
          const result = initRepository(dir);
          expect(result.ok).toBe(true);
          if (!result.ok) continue;
          expect(result.report.askBeforeApprove).toBe("add by hand");
          expect(result.report.unchanged).toContain(settings);
          expect(result.report.created).toContain(".gitignore");
          expect(result.report.warnings).toHaveLength(1);
          expect(result.report.warnings[0]).toContain(settings);
          for (const rule of askRules) expect(result.report.warnings[0]).toContain(rule);
        }
        expect(read(lockedFile, settings)).toBe(mine);
      } finally {
        // Put the rights back, so the folders can be removed.
        chmodSync(join(lockedFile, settings), 0o644);
        chmodSync(join(lockedFolder, ".claude"), 0o755);
      }
    });

    test("leaves a settings file that is a link or a folder alone", () => {
      const linked = repo({ ...bunApp, "elsewhere.json": "{}\n" });
      mkdirSync(join(linked, ".claude"));
      symlinkSync(join(linked, "elsewhere.json"), join(linked, settings));
      const folder = repo(bunApp);
      mkdirSync(join(folder, settings), { recursive: true });
      for (const dir of [linked, folder]) {
        const result = initRepository(dir);
        expect(result.ok && result.report.askBeforeApprove).toBe("add by hand");
      }
      expect(read(linked, "elsewhere.json")).toBe("{}\n");
    });
  });
});
