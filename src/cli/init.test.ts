// `skelcrew init`, run through the CLI's `run` in throwaway git
// repositories. Init itself is tested in src/init/init.test.ts. These tests
// check what the developer sees: the report, and where init runs.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanUp } from "../daemon/testing";
import { run } from "./cli";

const dirs: string[] = [];
afterEach(() => cleanUp(dirs));

// A folder holding the files it is given, by its real path. On macOS the
// temporary folder is a link, and the report names the real one.
function folder(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sk-init-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

// A git repository with one commit on main, holding the files it is given.
function gitRepo(files: Record<string, string> = {}): string {
  const dir = folder(files);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["commit", "-q", "--allow-empty", "-m", "First"],
  ]) {
    const ran = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=t@t", ...args], {
      cwd: dir,
    });
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  }
  return dir;
}

const bunApp = {
  "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "biome ci ." } }),
  "bun.lock": "",
};

function init(cwd: string, args: string[] = []) {
  return run(["init", ...args], {
    cwd,
    session: undefined,
    readStdin: async () => "",
    start: () => ({ ok: false, message: "The test starts no daemon." }),
  });
}

const approving =
  "Approving: Claude Code will ask you before skelcrew approve or skelcrew reject runs.";

describe("skelcrew init", () => {
  test("sets up a fresh repository and says what it did", async () => {
    const repo = gitRepo(bunApp);
    expect(await init(repo)).toEqual({
      code: 0,
      out: [
        `Set up Skelcrew in ${repo}.`,
        "The checks it runs: bun run test, bun run lint.",
        "Before them, it runs: bun install --frozen-lockfile.",
        "Created: .skelcrew/workflow.yml, .agents/skills/spec/SKILL.md, .agents/skills/develop/SKILL.md, .agents/skills/idea/SKILL.md, .agents/skills/crew/SKILL.md, .agents/skills/show/SKILL.md, .agents/skills/approve/SKILL.md, .agents/skills/reject/SKILL.md, .claude/settings.json, .gitignore.",
        "Linked: .claude/skills/spec, .claude/skills/develop, .claude/skills/idea, .claude/skills/crew, .claude/skills/show, .claude/skills/approve, .claude/skills/reject.",
        "",
        approving,
        "",
        "Next, commit these files, so everyone who clones the repository gets them.",
        'Then add a first task: skelcrew add "<task>"',
      ],
      err: [],
    });
  });

  test("run again, it changes nothing and says everything was already there", async () => {
    const repo = gitRepo(bunApp);
    await init(repo);
    expect(await init(repo)).toEqual({
      code: 0,
      out: [
        `Skelcrew was already set up in ${repo}. Nothing changed.`,
        "The checks it runs: bun run test, bun run lint.",
        "Before them, it runs: bun install --frozen-lockfile.",
        "Already there, left as they were: .skelcrew/workflow.yml, .agents/skills/spec/SKILL.md, .agents/skills/develop/SKILL.md, .agents/skills/idea/SKILL.md, .agents/skills/crew/SKILL.md, .agents/skills/show/SKILL.md, .agents/skills/approve/SKILL.md, .agents/skills/reject/SKILL.md, .claude/skills/spec, .claude/skills/develop, .claude/skills/idea, .claude/skills/crew, .claude/skills/show, .claude/skills/approve, .claude/skills/reject, .claude/settings.json, .gitignore.",
        "",
        approving,
        "",
        'Next, add a first task: skelcrew add "<task>"',
      ],
      err: [],
    });
  });

  test("lists what to do by hand, and the warnings", async () => {
    // .claude/skills is a file, so init can't link the skills into it.
    const repo = gitRepo({ ...bunApp, ".claude/skills": "" });
    const outcome = await init(repo);
    expect(outcome.code).toBe(0);
    expect(outcome.out).toContain(
      "Do by hand: .claude/skills/spec, .claude/skills/develop, .claude/skills/idea, .claude/skills/crew, .claude/skills/show, .claude/skills/approve, .claude/skills/reject.",
    );
    const warnings = outcome.out.slice(outcome.out.indexOf("Look at these:") + 1);
    expect(warnings[0]).toStartWith("- Init couldn't link .claude/skills/spec");
    expect(warnings[1]).toStartWith("- Init couldn't link .claude/skills/develop");
  });

  test("when it can't add the approve rules, says Claude Code won't ask, and where to look", async () => {
    // A settings file that isn't valid JSON is left as it is.
    const repo = gitRepo({ ...bunApp, ".claude/settings.json": "{" });
    const outcome = await init(repo);
    expect(outcome.code).toBe(0);
    const warnings = outcome.out.slice(outcome.out.indexOf("Look at these:") + 1);
    expect(warnings[0]).toContain(
      "Init couldn't add the rules for that, because .claude/settings.json isn't valid JSON",
    );
    expect(outcome.out).toContain(
      "Approving: Claude Code won't ask you before skelcrew approve or skelcrew reject runs, because init couldn't add the rules.",
    );
    expect(outcome.out).toContain(
      'To add them, see the note about .claude/settings.json under "Look at these".',
    );
  });

  test("refuses when it finds no checks, and writes nothing", async () => {
    const repo = gitRepo();
    expect(await init(repo)).toEqual({
      code: 1,
      out: [],
      err: [
        "Found no checks to run in this repository. Skelcrew needs at least one command that checks the code, such as the one that runs the tests. Add a test script, or write .skelcrew/workflow.yml by hand with your commands under checks.",
      ],
    });
  });

  test("takes no arguments", async () => {
    const repo = gitRepo(bunApp);
    expect(await init(repo, ["here"])).toEqual({
      code: 1,
      out: [],
      err: ["skelcrew init takes no arguments."],
    });
  });

  test("from a folder inside the repository, sets up the repository's top", async () => {
    const repo = gitRepo(bunApp);
    const inside = join(repo, "src", "reports");
    mkdirSync(inside, { recursive: true });
    const outcome = await init(inside);
    expect(outcome.out[0]).toBe(`Set up Skelcrew in ${repo}.`);
    expect(existsSync(join(repo, ".skelcrew", "workflow.yml"))).toBe(true);
    expect(existsSync(join(repo, "src", ".skelcrew"))).toBe(false);
    expect(existsSync(join(inside, ".skelcrew"))).toBe(false);
  });

  test("refuses a folder inside the repository that has a .skelcrew of its own", async () => {
    // One project in a repository that holds several. Skelcrew's worktrees
    // and merges would cover the whole repository, so it isn't supported.
    const repo = gitRepo({ ...bunApp, "apps/web/.skelcrew/workflow.yml": 'checks:\n  - "true"\n' });
    const web = join(repo, "apps", "web");
    for (const from of [web, join(web, "src")]) {
      mkdirSync(from, { recursive: true });
      expect(await init(from)).toEqual({
        code: 1,
        out: [],
        err: [
          `${web} is inside the git repository at ${repo}. Run Skelcrew there, where the repository starts.`,
        ],
      });
    }
    expect(existsSync(join(repo, ".skelcrew"))).toBe(false);
  });

  test("refuses a folder that isn't a git repository, and writes nothing", async () => {
    const dir = folder(bunApp);
    expect(await init(dir)).toEqual({
      code: 1,
      out: [],
      err: [`${dir} isn't a git repository. Skelcrew needs one.`],
    });
    expect(existsSync(join(dir, ".skelcrew"))).toBe(false);
  });

  test("--help says what it does", async () => {
    const repo = gitRepo(bunApp);
    const help = (await init(repo, ["--help"])).out.join("\n");
    expect(help).toContain("Usage: skelcrew init");
  });
});
