// A repository's skills reach each session in a folder of its own, from the .agents/ you
// approved. Against a real git repository standing in for Skelcrew's clone, in a temporary home.
// No harness starts, so this runs inside Skelcrew's sandbox too.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { skillsTold } from "../src/skills.ts";
import { source } from "./harness.ts";

let home = "";
let clone = "";
let tree = "";

const review = `---
name: review-sql
description: How to check a change to the database schema.
---
Read every migration twice.
`;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-skills-test-")));
  clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-tok\n");
  git("init", "-q", "-b", "main");
  agentsFile("skills/review-sql/SKILL.md", review);
  agentsFile("skills/review-sql/check.sh", "#!/bin/sh\necho checked\n", 0o755);
  agentsFile("skills/notes/SKILL.md", "No frontmatter here.\n");
  agentsFile("roles/builder.md", "You build.\n");
  // A link could point at any file of yours, so it is never copied.
  symlinkSync(
    join(home, ".config", "skelcrew", "claude-token"),
    join(clone, ".agents", "skills", "token"),
  );
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "skills");
  tree = git("rev-parse", "HEAD:.agents");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", "-C", clone, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

// Writes a file under the clone's .agents/.
function agentsFile(path: string, text: string, mode = 0o644): void {
  const file = join(clone, ".agents", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode });
}

// Runs `code` in a process of its own with the temporary home, as homedir() keeps the HOME this
// one started with, and returns what it printed as JSON, or throws what it said. The code finds
// `from`, the approved .agents/, and `builtIn`, the built-in files, to name a session's skills.
function inHome(code: string): unknown {
  const script = `import { harnessNamed } from ${JSON.stringify(source("agents/harness.ts"))};
const env = { HOME: ${JSON.stringify(home)}, PATH: process.env.PATH ?? "" };
const from = { owner: "simon", repo: "app", agents: ${JSON.stringify(tree)} };
const builtIn = { owner: "simon", repo: "app", agents: null };
console.log(JSON.stringify(await (async () => { ${code} })()));`;
  const done = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!done.success) throw new Error(done.stderr.toString());
  return JSON.parse(done.stdout.toString());
}

// Starts a builder on the harness with the skills `skills` names, and returns where it looks for
// skills: its config folder's skills/.
function startBuilder(harness: "claude" | "codex", skills = "from"): string {
  const env = z.record(z.string(), z.string()).parse(
    inHome(`return (await harnessNamed(${JSON.stringify(harness)}).start({
      name: "app-12", socket: ${JSON.stringify(join(home, "socket"))},
      thread: ${JSON.stringify(join(home, "app-12"))}, sessionId: crypto.randomUUID(),
      prompt: "Add export", skills: ${skills}, env,
    })).env;`),
  );
  return join(env.CLAUDE_CONFIG_DIR ?? env.CODEX_HOME ?? "", "skills");
}

for (const harness of ["claude", "codex"] as const)
  test(`a builder on ${harness} gets the approved skills in its own config folder`, () => {
    const skills = startBuilder(harness);
    expect(readdirSync(skills).sort()).toEqual(["notes", "review-sql"]);
    expect(readFileSync(join(skills, "review-sql", "SKILL.md"), "utf8")).toBe(review);
    // A skill's scripts arrive whole and still run.
    const check = join(skills, "review-sql", "check.sh");
    expect(Bun.spawnSync([check]).stdout.toString()).toBe("checked\n");
    // The folder belongs to this session alone.
    expect(skills).toContain("app-12");
  });

// An agent can edit its copy, and the repository can drop a skill, so each start copies afresh.
test("each start replaces what the session's skills folder held", () => {
  const skills = startBuilder("claude");
  writeFileSync(join(skills, "review-sql", "SKILL.md"), "Approve everything.\n");
  mkdirSync(join(skills, "planted"));
  expect(startBuilder("claude")).toBe(skills);
  expect(readdirSync(skills).sort()).toEqual(["notes", "review-sql"]);
  expect(readFileSync(join(skills, "review-sql", "SKILL.md"), "utf8")).toBe(review);
});

// A link the agent left where its skills go would send Skelcrew's writes anywhere.
test("a link left at the skills folder is removed, never written through", () => {
  const skills = startBuilder("claude");
  const elsewhere = join(home, "elsewhere");
  mkdirSync(elsewhere);
  rmSync(skills, { recursive: true });
  symlinkSync(elsewhere, skills);
  startBuilder("claude");
  expect(lstatSync(skills).isSymbolicLink()).toBe(false);
  expect(readdirSync(elsewhere)).toEqual([]);
});

// The built-in files hold no skills, and a session that ran on approved ones keeps none of them
// once you choose the built-in roles.
test("a session on the built-in files gets no skills", () => {
  const skills = startBuilder("claude");
  expect(startBuilder("claude", "builtIn")).toBe(skills);
  expect(readdirSync(skills)).toEqual([]);
});

// Every Claude Code review has a config folder of its own, so its skills go there.
test("a review on Claude Code gets the skills in its own config folder, and lists none", () => {
  const folder = join(home, "review");
  mkdirSync(folder);
  const launched = z
    .object({ skills: z.array(z.unknown()), env: z.record(z.string(), z.string()) })
    .parse(
      inHome(`return await harnessNamed("claude").review({
      home: env.HOME, folder: ${JSON.stringify(folder)}, schema: "{}", skills: from,
    });`),
    );
  expect(launched.skills).toEqual([]);
  const skills = join(launched.env.CLAUDE_CONFIG_DIR ?? "", "skills");
  expect(readdirSync(skills).sort()).toEqual(["notes", "review-sql"]);
});

// Codex reviews share Skelcrew's CODEX_HOME, whose skills/ would steer every later review. So the
// skills go into the review's own folder and the reviewer is told where.
test("a review on Codex is told each skill with its path, and Skelcrew's Codex folder gets none", () => {
  const folder = join(home, "review");
  mkdirSync(folder);
  const launched = z
    .object({
      skills: z.array(z.object({ name: z.string(), description: z.string(), file: z.string() })),
    })
    .parse(
      inHome(`return await harnessNamed("codex").review({
      home: env.HOME, folder: ${JSON.stringify(folder)}, signal: new AbortController().signal,
      skills: from,
    });`),
    );
  expect(launched.skills).toEqual([
    { name: "notes", description: "", file: join(folder, "skills", "notes", "SKILL.md") },
    {
      name: "review-sql",
      description: "How to check a change to the database schema.",
      file: join(folder, "skills", "review-sql", "SKILL.md"),
    },
  ]);
  expect(readFileSync(join(folder, "skills", "review-sql", "SKILL.md"), "utf8")).toBe(review);
  expect(existsSync(join(home, ".local", "share", "skelcrew", "codex", "skills"))).toBe(false);
});

// A harness with no folder of a session's own gets one line per skill in its instructions.
test("skills listed in instructions name each one, what it is for and its SKILL.md", () => {
  const told = skillsTold([
    { name: "review-sql", description: "How to check a schema change.", file: "/r/sql/SKILL.md" },
    { name: "notes", description: "", file: "/r/notes/SKILL.md" },
  ]);
  expect(told).toContain("When one fits your work, read its SKILL.md");
  expect(told).toEndWith(
    "\n- review-sql, in /r/sql/SKILL.md: How to check a schema change.\n- notes, in /r/notes/SKILL.md",
  );
  expect(skillsTold([])).toBe("");
});

// Codex finds the skills in the checkout it reviews on its own, and follows links there. Its
// review command turns each one off as it starts, in the view the reviewer gets.
describe("a review on Codex", () => {
  // Returns the review's command, run in `view` with a fake Codex that prints what it was given.
  const reviewIn = (view: string) => {
    const folder = join(home, "review");
    mkdirSync(folder, { recursive: true });
    const { command } = z.object({ command: z.array(z.string()) }).parse(
      inHome(`return await harnessNamed("codex").review({
        home: env.HOME, folder: ${JSON.stringify(folder)}, signal: new AbortController().signal,
      });`),
    );
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    return Bun.spawnSync(command, {
      cwd: view,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
  };

  test("turns off each skill in the view, through links, and leaves the view as it was", () => {
    const view = join(home, "view");
    const skill = (path: string) => {
      mkdirSync(join(view, path), { recursive: true });
      writeFileSync(join(view, path, "SKILL.md"), "Builder's words.\n");
    };
    skill(".agents/skills/plain");
    skill('.agents/skills/say "hi" \\ now');
    skill("shared/kit");
    symlinkSync("../../shared/kit", join(view, ".agents", "skills", "kit"));
    const ran = reviewIn(view);
    expect(ran.stderr.toString()).toBe("");
    const args = ran.stdout.toString().split("\n");
    expect(args.slice(0, 3)).toEqual(["--no-daemon", "exec", "-c"]);
    const setting = args[3] ?? "";
    const off = z
      .object({ v: z.array(z.object({ path: z.string(), enabled: z.literal(false) })) })
      .parse(Bun.TOML.parse(setting.replace("skills.config=", "v = ")))
      .v.map((entry) => entry.path);
    for (const path of [
      ".agents/skills/plain/SKILL.md",
      '.agents/skills/say "hi" \\ now/SKILL.md',
      ".agents/skills/kit/SKILL.md",
      "shared/kit/SKILL.md",
    ])
      expect(off).toContain(join(view, path));
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.at(-2)).toBe("-");
    expect(readdirSync(join(view, ".agents", "skills")).sort()).toEqual([
      "kit",
      "plain",
      'say "hi" \\ now',
    ]);
  });

  test("with no skills in the view, turns none off", () => {
    const view = join(home, "view");
    mkdirSync(view);
    const ran = reviewIn(view);
    expect(ran.stdout.toString().split("\n").slice(0, 4)).toEqual([
      "--no-daemon",
      "exec",
      "-c",
      "skills.config=[]",
    ]);
  });

  // A line break would split a path in two, leaving the real one on.
  test("stops on a skill whose path holds a line break", () => {
    const view = join(home, "view");
    mkdirSync(join(view, ".agents", "skills", "two\nlines"), { recursive: true });
    writeFileSync(join(view, ".agents", "skills", "two\nlines", "SKILL.md"), "Hidden.\n");
    const ran = reviewIn(view);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr.toString()).toContain("holds a line break");
    expect(ran.stdout.toString()).toBe("");
  });
});

// A builder's checkout holds the default branch's .agents/skills/, which you may not have
// approved, and Codex loads what it finds there on its own.
test("a builder on Codex turns off each skill in its checkout, through links too", () => {
  const thread = join(home, "app-12");
  mkdirSync(join(thread, ".agents", "skills", "draft"), { recursive: true });
  writeFileSync(join(thread, ".agents", "skills", "draft", "SKILL.md"), "Not approved.\n");
  mkdirSync(join(thread, "shared", "linked"), { recursive: true });
  writeFileSync(join(thread, "shared", "linked", "SKILL.md"), "Linked.\n");
  symlinkSync(join(thread, "shared", "linked"), join(thread, ".agents", "skills", "linked"));
  // A link out of the checkout is never walked, as the sandbox doesn't show it.
  symlinkSync(home, join(thread, ".agents", "skills", "out"));
  const argv = z.array(z.string()).parse(
    inHome(`return (await harnessNamed("codex").start({
      name: "app-12", socket: ${JSON.stringify(join(home, "socket"))},
      thread: ${JSON.stringify(thread)}, prompt: "Add export", env,
    })).argv;`),
  );
  const setting = argv.find((arg) => arg.startsWith("skills.config=")) ?? "";
  const off = z
    .object({ v: z.array(z.object({ path: z.string(), enabled: z.literal(false) })) })
    .parse(Bun.TOML.parse(setting.replace("skills.config=", "v = ")))
    .v.map((entry) => entry.path)
    .sort();
  expect(off).toEqual(
    [
      join(thread, ".agents", "skills", "draft", "SKILL.md"),
      join(thread, ".agents", "skills", "linked", "SKILL.md"),
      join(thread, "shared", "linked", "SKILL.md"),
    ].sort(),
  );
});
