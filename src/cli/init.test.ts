// `skelcrew init`, run through the CLI's `run` in throwaway git
// repositories. Init itself is tested in src/init/init.test.ts. These tests
// check what the developer sees: the report, and where init runs.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanUp } from "../daemon/testing";
import { askBeforeApproveLimit } from "../init/settings";
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

const approving = `Approving: ${askBeforeApproveLimit("added")}`;

describe("skelcrew init", () => {
  test("sets up a fresh repository and says what it did", async () => {
    const repo = gitRepo(bunApp);
    expect(await init(repo)).toEqual({
      code: 0,
      out: [
        `Set up Skelcrew in ${repo}.`,
        "The checks it runs: bun run test, bun run lint.",
        "Created: .skelcrew/workflow.yml, .agents/skills/spec/SKILL.md, .agents/skills/develop/SKILL.md, .claude/settings.json, .gitignore.",
        "Linked: .claude/skills/spec, .claude/skills/develop.",
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
        "Already there, left as they were: .skelcrew/workflow.yml, .agents/skills/spec/SKILL.md, .agents/skills/develop/SKILL.md, .claude/skills/spec, .claude/skills/develop, .claude/settings.json, .gitignore.",
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
    expect(outcome.out).toContain("Do by hand: .claude/skills/spec, .claude/skills/develop.");
    const warnings = outcome.out.slice(outcome.out.indexOf("Look at these:") + 1);
    expect(warnings[0]).toStartWith("- Init couldn't link .claude/skills/spec");
    expect(warnings[1]).toStartWith("- Init couldn't link .claude/skills/develop");
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
      err: ["skelcrew init takes no arguments. Run it where your git repository starts."],
    });
  });

  test("--help says what it does", async () => {
    const repo = gitRepo(bunApp);
    const help = (await init(repo, ["--help"])).out.join("\n");
    expect(help).toContain("Usage: skelcrew init");
  });
});
