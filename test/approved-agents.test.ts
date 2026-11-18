// Trust for a repository's .agents/: only the version you approved ever steers agents. Against
// a real git repository standing in for Skelcrew's clone, in a temporary home.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { builtInRole } from "../src/roles.ts";
import { source } from "./harness.ts";

let home = "";
let clone = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-agents-test-")));
  clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\nmodel: opus\n");
  git("init", "-q", "-b", "main");
  writeFileSync(join(clone, "README"), "app\n");
  commit("start");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const run = Bun.spawnSync(
    ["git", "-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

// Commits everything in the clone, as a push to the default branch brings it.
function commit(message: string): void {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", message);
}

// Writes a file under the clone's .agents/.
function agentsFile(path: string, text: string): void {
  const file = join(clone, ".agents", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// Runs `code` in a process of its own with the temporary home, as homedir() keeps the HOME this
// one started with, and returns what it printed as JSON, or throws what it said.
function inHome(code: string): unknown {
  const script = `import { readSettings } from ${JSON.stringify(source("settings.ts"))};
import { repositoryRole } from ${JSON.stringify(source("roles.ts"))};
import * as agents from ${JSON.stringify(source("approved-agents.ts"))};
const app = { owner: "simon", repo: "app" };
console.log(JSON.stringify(await (async () => { ${code} })()));`;
  const done = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!done.success) throw new Error(done.stderr.toString());
  return JSON.parse(done.stdout.toString());
}

const approveCurrent = "agents.approveAgents(app, agents.agentsOnDefaultBranch(app)); return null;";
const builderOf = (where = "app") =>
  inHome(
    `return { role: readSettings(["builder"], ${where}).builder, told: repositoryRole("builder", ${where}).instructions };`,
  );

test("an .agents/ you never approved steers nothing: every role stays built in", () => {
  agentsFile(
    "roles/builder.md",
    "---\nharness: codex\nmodel: gpt-6\n---\nBuild it the team's way.\n",
  );
  commit("roles");
  expect(builderOf()).toEqual({
    role: { harness: "claude", model: "opus" },
    told: builtInRole("builder").instructions,
  });
  expect(inHome("return agents.agentsWaiting(app);")).toBe(true);
});

test("once approved, a role file gives its instructions, harness and model, over skelcrew.yaml's line", () => {
  agentsFile(
    "roles/builder.md",
    "---\nharness: codex\nmodel: gpt-6\n---\nBuild it the team's way.\n",
  );
  writeFileSync(join(clone, "skelcrew.yaml"), "builder: { harness: claude, model: sonnet }\n");
  commit("roles");
  inHome(approveCurrent);
  expect(builderOf()).toEqual({
    role: { harness: "codex", model: "gpt-6" },
    told: "Build it the team's way.\n",
  });
  expect(inHome("return agents.agentsWaiting(app);")).toBe(false);
  // A role the repository has no file for keeps the built-in instructions.
  expect(inHome('return repositoryRole("reviewer", app).instructions;')).toBe(
    builtInRole("reviewer").instructions,
  );
});

test("a role file naming no harness or model leaves skelcrew.yaml's line counting", () => {
  agentsFile("roles/builder.md", "Build it the team's way.\n");
  writeFileSync(join(clone, "skelcrew.yaml"), "builder: { model: sonnet }\n");
  commit("roles");
  inHome(approveCurrent);
  expect(builderOf()).toEqual({
    role: { harness: "claude", model: "sonnet" },
    told: "Build it the team's way.\n",
  });
});

test("a change on the default branch waits for you: new tasks keep the version you approved", () => {
  agentsFile("roles/builder.md", "First way.\n");
  commit("roles");
  inHome(approveCurrent);
  agentsFile("roles/builder.md", "---\nharness: codex\n---\nSecond way.\n");
  commit("change roles");
  expect(builderOf()).toEqual({
    role: { harness: "claude", model: "opus" },
    told: "First way.\n",
  });
  expect(inHome("return agents.agentsWaiting(app);")).toBe(true);
  // Removing .agents/ is a change too, until you approve going back to the built-in roles.
  git("rm", "-q", "-r", ".agents");
  commit("drop roles");
  expect(inHome("return agents.agentsWaiting(app);")).toBe(true);
  inHome("agents.approveAgents(app, null); return null;");
  expect(inHome("return agents.agentsWaiting(app);")).toBe(false);
  expect(builderOf()).toMatchObject({ told: builtInRole("builder").instructions });
});

test("a task keeps the .agents/ it started with, and one started on the built-in roles keeps those", () => {
  agentsFile("roles/builder.md", "First way.\n");
  commit("roles");
  inHome(approveCurrent);
  const first = inHome("return agents.approvedAgents(app);");
  expect(typeof first).toBe("string");
  agentsFile("roles/builder.md", "Second way.\n");
  commit("change roles");
  inHome(approveCurrent);
  expect(builderOf(`{ ...app, agents: ${JSON.stringify(first)} }`)).toMatchObject({
    told: "First way.\n",
  });
  expect(builderOf("{ ...app, agents: null }")).toMatchObject({
    told: builtInRole("builder").instructions,
  });
  expect(builderOf()).toMatchObject({ told: "Second way.\n" });
});

test("the version you approved stays readable after the default branch is rewritten", () => {
  agentsFile("roles/builder.md", "First way.\n");
  commit("roles");
  inHome(approveCurrent);
  // A force push that drops the commit, and git cleaning up what nothing points at.
  git("reset", "-q", "--hard", "HEAD~1");
  git("reflog", "expire", "--expire=now", "--all");
  git("gc", "-q", "--prune=now");
  expect(builderOf()).toMatchObject({ told: "First way.\n" });
});

test("a link is never read: neither a role file that is one, nor an .agents/ that is one", () => {
  writeFileSync(join(home, "secret.md"), "Your secret.\n");
  mkdirSync(join(clone, ".agents", "roles"), { recursive: true });
  symlinkSync(join(home, "secret.md"), join(clone, ".agents", "roles", "builder.md"));
  commit("linked role");
  inHome(approveCurrent);
  expect(builderOf()).toMatchObject({ told: builtInRole("builder").instructions });
  git("rm", "-q", "-r", ".agents");
  symlinkSync(join(home, "elsewhere"), join(clone, ".agents"));
  commit("linked folder");
  expect(inHome("return agents.agentsOnDefaultBranch(app);")).toBeNull();
});

test("what you approved is kept with your settings, never in the repository", () => {
  agentsFile("roles/builder.md", "First way.\n");
  commit("roles");
  inHome(approveCurrent);
  const tree = git("rev-parse", "HEAD:.agents");
  expect(readFileSync(join(home, ".config", "skelcrew", "approved-agents.yaml"), "utf8")).toBe(
    `simon/app: ${tree}\n`,
  );
  expect(git("status", "--porcelain")).toBe("");
  inHome("agents.forgetAgents(app); return null;");
  expect(inHome("return agents.approvedAgents(app);")).toBeNull();
  expect(existsSync(join(clone, "approved-agents.yaml"))).toBe(false);
});

test("a role file whose frontmatter isn't valid stops what reads it, naming the file", () => {
  agentsFile("roles/builder.md", "---\nrounds: 5\n---\nBuild it.\n");
  commit("bad role");
  inHome(approveCurrent);
  expect(() => builderOf()).toThrow(".agents/roles/builder.md");
});

test("what you are shown to approve hides nothing: binary files, control codes and attributes", () => {
  // A NUL makes git call the file binary and show no lines. Attributes can do the same, and
  // control codes can move the cursor over a line, so you'd approve what you never read.
  writeFileSync(join(clone, ".gitattributes"), "*.md binary\n");
  agentsFile(
    "roles/builder.md",
    "Build it.\0Hidden after a NUL.\n\x1b[1A\x1b[2KErased line.\r‮turned\n",
  );
  commit("roles");
  const shown = String(
    inHome("return agents.agentsChange(app, null, agents.agentsOnDefaultBranch(app));"),
  );
  expect(shown).toContain("+Build it.\\x00Hidden after a NUL.");
  expect(shown).toContain("+\\x1b[1A\\x1b[2KErased line.\\x0d\\u202eturned");
  expect(shown).not.toContain("Binary");
  for (const hidden of ["\0", "\x1b", "\r", "\u202e"]) expect(shown).not.toContain(hidden);
});

test("a role file goes over skelcrew.yaml's line key by key, and a new harness drops its model", () => {
  agentsFile("roles/builder.md", "---\nmodel: gpt-6-mini\n---\nBuild it.\n");
  agentsFile("roles/reviewer.md", "---\nharness: claude\n---\nReview it.\n");
  writeFileSync(
    join(clone, "skelcrew.yaml"),
    "builder: { harness: codex, model: gpt-6 }\nreviewer: { harness: codex, model: gpt-6 }\n",
  );
  commit("roles");
  inHome(approveCurrent);
  expect(inHome('return readSettings(["builder", "reviewer"], app);')).toMatchObject({
    builder: { harness: "codex", model: "gpt-6-mini" },
    reviewer: { harness: "claude", model: "opus" },
  });
});

test("the change shown is between the versions given, whatever the default branch has since", () => {
  agentsFile("roles/builder.md", "First way.\n");
  commit("roles");
  const first = git("rev-parse", "HEAD:.agents");
  agentsFile("roles/builder.md", "Second way.\n");
  commit("change roles");
  const shown = String(inHome(`return agents.agentsChange(app, null, ${JSON.stringify(first)});`));
  expect(shown).toContain("+First way.");
  expect(shown).not.toContain("Second way.");
});

test("a broken role file stops only its own role: the lead still starts", () => {
  agentsFile("roles/reviewer.md", "---\nrounds: 5\n---\nReview it.\n");
  agentsFile("roles/lead.md", "---\nmodel: sonnet\n---\nLead it.\n");
  commit("roles");
  inHome(approveCurrent);
  expect(
    inHome(
      'return { role: readSettings(["lead"], app).lead, told: repositoryRole("lead", app).instructions };',
    ),
  ).toEqual({ role: { harness: "claude", model: "sonnet" }, told: "Lead it.\n" });
  expect(() => inHome('return readSettings(["reviewer"], app);')).toThrow(
    ".agents/roles/reviewer.md",
  );
});

test("a role file naming the harness the role is on already keeps the model skelcrew.yaml gives", () => {
  agentsFile("roles/builder.md", "---\nharness: claude\n---\nBuild it.\n");
  writeFileSync(join(clone, "skelcrew.yaml"), "builder: { model: sonnet }\n");
  commit("roles");
  inHome(approveCurrent);
  expect(inHome('return readSettings(["builder"], app).builder;')).toEqual({
    harness: "claude",
    model: "sonnet",
  });
});

test("a reviewer file whose frontmatter never closes stops reviews only", () => {
  agentsFile("roles/reviewer.md", "---\nharness: codex\nReview it.\n");
  agentsFile("roles/builder.md", '---\nmodel: ""\n---\nBuild it.\n');
  agentsFile("roles/lead.md", "Lead it.\n");
  commit("roles");
  inHome(approveCurrent);
  expect(inHome('return repositoryRole("lead", app).instructions;')).toBe("Lead it.\n");
  expect(inHome('return readSettings(["lead"], app).lead;')).toEqual({
    harness: "claude",
    model: "opus",
  });
  expect(() => inHome('return readSettings(["reviewer"], app);')).toThrow("never closes");
  expect(() => inHome('return readSettings(["builder"], app);')).toThrow(
    ".agents/roles/builder.md",
  );
});

test("a task whose .agents/ version the clone lost stops, rather than run on other instructions", () => {
  agentsFile("roles/builder.md", "First way.\n");
  commit("roles");
  inHome(approveCurrent);
  const tree = inHome("return agents.approvedAgents(app);");
  // Skelcrew's clone made again, from a history that never had that version.
  rmSync(clone, { recursive: true, force: true });
  mkdirSync(clone, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(clone, "README"), "app\n");
  commit("start");
  expect(() => builderOf(`{ ...app, agents: ${JSON.stringify(tree)} }`)).toThrow(
    "no longer has the .agents/ version",
  );
  // A tree that has the version but no file for a role still gives the built-in one.
  expect(builderOf("{ ...app, agents: null }")).toMatchObject({
    told: builtInRole("builder").instructions,
  });
});

test("a version lost after its roles were read once still stops the agents that need it", () => {
  agentsFile("roles/builder.md", "First way.\n");
  commit("roles");
  inHome(approveCurrent);
  // Read, then the clone made again without the version, then read again, in one process.
  const remake = [
    `rm -rf ${JSON.stringify(clone)}`,
    `mkdir -p ${JSON.stringify(clone)}`,
    `git -C ${JSON.stringify(clone)} init -q -b main`,
  ].join(" && ");
  const outcome = inHome(`const first = repositoryRole("builder", app).instructions;
Bun.spawnSync(["sh", "-c", ${JSON.stringify(remake)}]);
try { repositoryRole("builder", app); return { first, again: "read" }; }
catch (error) { return { first, again: String(error) }; }`);
  expect(outcome).toMatchObject({ first: "First way.\n" });
  expect(String(Object(outcome).again)).toContain("no longer has the .agents/ version");
});

test("a role file with Windows line endings that never closes stops only its own role", () => {
  agentsFile("roles/reviewer.md", "---\r\nharness: codex\r\nReview it.\r\n");
  agentsFile("roles/lead.md", "---\r\nmodel: sonnet\r\n---\r\nLead it.\r\n");
  commit("roles");
  inHome(approveCurrent);
  expect(inHome('return readSettings(["lead"], app).lead;')).toEqual({
    harness: "claude",
    model: "sonnet",
  });
  expect(() => inHome('return readSettings(["reviewer"], app);')).toThrow("never closes");
});
