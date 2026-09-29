import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

const bunApp = {
  "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "biome ci ." } }),
  "bun.lock": "",
};
const workflow = ".skelcrew/workflow.yml";
const specSkill = ".claude/skills/spec/SKILL.md";
const developSkill = ".claude/skills/develop/SKILL.md";
const dbLine = ".skelcrew/skelcrew.db*";
const settings = ".claude/settings.json";
// The Claude Code permission rules that make it ask you before an agent
// runs skelcrew approve. Each catches one usual way of typing it: plain,
// through bunx, bun x or npx, or by a path to the program, such as
// ./node_modules/.bin/skelcrew. The docs say a rule matches only the way
// it is written, and a leading * stands in for any text.
const askRules = [
  "Bash(skelcrew approve *)",
  "Bash(bunx skelcrew approve *)",
  "Bash(bun x skelcrew approve *)",
  "Bash(npx skelcrew approve *)",
  "Bash(*/skelcrew approve *)",
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
        created: [workflow, specSkill, developSkill, settings, ".gitignore"],
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

  // A folder where a file should be, or a file you may not read, must end
  // in a report, not a crash.
  test("warns about a workflow.yml it can't open, and goes on", () => {
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
    const dir = repo({ ...bunApp, ".claude/skills/develop": "not a folder" });
    const result = initRepository(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.created).toEqual([workflow, specSkill]);
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
      expect(result.report.byHand).toEqual([specSkill, developSkill, settings]);
      expect(result.report.created).toEqual([workflow, ".gitignore"]);
      expect(result.report.askBeforeApprove).toBe("add by hand");
      expect(result.report.warnings).toHaveLength(3);
      for (const warning of result.report.warnings) {
        expect(warning).toContain(".claude");
        expect(warning).toContain("outside the repository");
      }
    });

    test("writes nothing through a linked skills folder", () => {
      const home = fakeHome();
      const before = everything(home);
      const dir = repo(bunApp);
      mkdirSync(join(dir, ".claude"));
      symlinkSync(join(home, ".claude/skills"), join(dir, ".claude/skills"));
      const result = initRepository(dir);
      expect(everything(home)).toEqual(before);
      expect(result.ok && result.report.byHand).toEqual([specSkill, developSkill]);
      expect(result.ok && result.report.created).toContain(settings);
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
      const result = initRepository(dir);
      expect(result.ok && result.report.byHand).toEqual([]);
      expect(existsSync(join(dir, "config/claude/skills/spec/SKILL.md"))).toBe(true);
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
    expect(warnings[0]).toContain(dbLine);
  });

  test("keeps the line endings of a .gitignore written on Windows", () => {
    const dir = repo({ ...bunApp, ".gitignore": "node_modules/\r\ndist\r\n" });
    initRepository(dir);
    const text = read(dir, ".gitignore");
    expect(text.startsWith("node_modules/\r\ndist\r\n")).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    expect(text.split("\r\n")).toContain(dbLine);
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
        unchanged: [workflow, specSkill, developSkill, settings, ".gitignore"],
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

  describe("the rules that make Claude Code ask before skelcrew approve", () => {
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

    // Written another way, such as bash -c 'skelcrew approve 12', the
    // command still runs without a question. The report says so.
    test("says plainly that the rules can be got round", () => {
      const result = initRepository(repo(bunApp));
      const limit = result.ok ? result.report.askBeforeApproveLimit : "";
      expect(limit).toContain("bash -c");
      expect(limit).toContain("TUI");
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
    test("says what to add by hand when it can't write the settings file", () => {
      const mine = settingsJson({ model: "opus" });
      const lockedFile = repo({ ...bunApp, [settings]: mine });
      chmodSync(join(lockedFile, settings), 0o444);
      // With the skills there already, init needs to write only settings.json
      // in the locked folder.
      const lockedFolder = repo({ ...bunApp, [specSkill]: "mine", [developSkill]: "mine" });
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
