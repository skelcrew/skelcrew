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

const roundsOf = (where = "app") => inHome(`return readSettings(["rounds"], ${where}).rounds;`);

test("today's max_rounds still gives its rounds, until an approved flow file names its own", () => {
  writeFileSync(join(clone, "skelcrew.yaml"), "max_rounds: 5\n");
  commit("settings");
  expect(roundsOf()).toBe(5);
  // A flow file you haven't approved counts for nothing.
  agentsFile("flows/default.yaml", "review:\n  rounds: 2\n");
  commit("flow");
  expect(roundsOf()).toBe(5);
  inHome(approveCurrent);
  expect(roundsOf()).toBe(2);
  // A task keeps the .agents/ it started with, and one on the built-in files keeps max_rounds.
  expect(roundsOf("{ ...app, agents: null }")).toBe(5);
});

test("a default flow file replaces max_rounds though it names no rounds, and your override beats both", () => {
  writeFileSync(join(clone, "skelcrew.yaml"), "max_rounds: 5\n");
  agentsFile("flows/default.yaml", "build:\n  role: builder\n");
  commit("flow");
  inHome(approveCurrent);
  // The flow file names no rounds, so yours count, or else the built-in flow's.
  expect(roundsOf()).toBe(3);
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "rounds: 2\n");
  expect(roundsOf()).toBe(2);
  // A bad max_rounds is left unread, so it stops nothing.
  writeFileSync(join(clone, "skelcrew.yaml"), "max_rounds: 0\n");
  expect(roundsOf()).toBe(2);
  // A task on the built-in files has no flow file, so max_rounds counts and is checked.
  expect(() => roundsOf("{ ...app, agents: null }")).toThrow("skelcrew.yaml isn't valid");
  agentsFile("flows/default.yaml", "review:\n  rounds: 2\n");
  commit("flow");
  inHome(approveCurrent);
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    "max_rounds: 9\nrepos: { simon/app: { max_rounds: 7 } }\n",
  );
  expect(roundsOf()).toBe(7);
});

test("the flow file goes over your config's max_rounds, which goes over the built-in flow", () => {
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "max_rounds: 6\n");
  expect(roundsOf()).toBe(6);
  agentsFile("flows/default.yaml", "review:\n  rounds: 4\n");
  commit("flow");
  inHome(approveCurrent);
  expect(roundsOf()).toBe(4);
});

test("a flow file that isn't valid stops only what reads the flow, naming the file", () => {
  agentsFile("flows/default.yaml", "review:\n  rounds: 2\n  skip: true\n");
  commit("flow");
  inHome(approveCurrent);
  expect(() => roundsOf()).toThrow(".agents/flows/default.yaml in simon/app");
  // The flow says who builds, so the builder stops too, but the lead runs on.
  expect(() => inHome('return readSettings(["builder"], app).builder;')).toThrow(
    ".agents/flows/default.yaml in simon/app",
  );
  expect(inHome('return readSettings(["lead"], app).lead;')).toEqual({
    harness: "claude",
    model: "opus",
  });
});

test("a stage can't run the lead or the other stage's built-in role", () => {
  for (const flow of [
    "build:\n  role: reviewer\n",
    "build:\n  role: lead\n",
    "review:\n  role: builder\n  rounds: 2\n",
    "review:\n  role: lead\n  rounds: 2\n",
    "review:\n  role: ../secret\n  rounds: 2\n",
  ]) {
    agentsFile("flows/default.yaml", flow);
    commit("flow");
    inHome(approveCurrent);
    expect(() => roundsOf()).toThrow(".agents/flows/default.yaml in simon/app");
  }
  agentsFile(
    "flows/default.yaml",
    "build:\n  role: builder\nreview:\n  role: reviewer\n  rounds: 2\n",
  );
  commit("flow");
  inHome(approveCurrent);
  expect(roundsOf()).toBe(2);
});

test("only the round limit that wins is read: a bad one below it stops nothing", () => {
  // A valid flow wins over a bad max_rounds in skelcrew.yaml.
  writeFileSync(join(clone, "skelcrew.yaml"), "max_rounds: 0\n");
  agentsFile("flows/default.yaml", "review:\n  rounds: 2\n");
  commit("flow");
  inHome(approveCurrent);
  expect(roundsOf()).toBe(2);
  // Your override wins over a bad flow.
  agentsFile("flows/default.yaml", "review:\n  rounds: many\n");
  commit("flow");
  inHome(approveCurrent);
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    "repos: { simon/app: { max_rounds: 7 } }\n",
  );
  expect(roundsOf()).toBe(7);
  // The rest of the flow still counts, so a stage naming a role it can't run is still refused.
  agentsFile("flows/default.yaml", "build:\n  role: reviewer\nreview:\n  rounds: 2\n");
  commit("flow");
  inHome(approveCurrent);
  expect(() => roundsOf()).toThrow(".agents/flows/default.yaml in simon/app");
});

test("a task on another flow reads that flow's rounds, and a flow the tree lacks stops it", () => {
  agentsFile("flows/default.yaml", "review:\n  rounds: 2\n");
  agentsFile("flows/quick.yaml", "# For one-line fixes.\nreview:\n  rounds: 1\n");
  commit("flows");
  inHome(approveCurrent);
  expect(roundsOf()).toBe(2);
  expect(roundsOf('{ ...app, flow: "default" }')).toBe(2);
  expect(roundsOf('{ ...app, flow: "quick" }')).toBe(1);
  expect(() => roundsOf('{ ...app, flow: "slow" }')).toThrow(
    "simon/app has no flow slow in its .agents/flows/",
  );
  // A task on the built-in files has only the built-in default flow.
  expect(() => roundsOf('{ ...app, agents: null, flow: "quick" }')).toThrow(
    "simon/app has no flow quick",
  );
});

const flowsOf = (where = "app") =>
  inHome(
    `const { repositoryFlows } = await import(${JSON.stringify(source("flows.ts"))}); return repositoryFlows(${where});`,
  );

test("a repository's flows are default and each flow file of the .agents/ you approved", () => {
  expect(flowsOf()).toEqual(["default"]);
  agentsFile("flows/quick.yaml", "review:\n  rounds: 1\n");
  agentsFile("flows/careful.yaml", "review:\n  rounds: 5\n");
  agentsFile("flows/notes.txt", "not a flow\n");
  agentsFile("flows/deeper/inside.yaml", "review:\n  rounds: 5\n");
  commit("flows");
  // A flow file you haven't approved isn't one of its flows yet.
  expect(flowsOf()).toEqual(["default"]);
  inHome(approveCurrent);
  expect(flowsOf()).toEqual(["default", "careful", "quick"]);
  expect(flowsOf("{ ...app, agents: null }")).toEqual(["default"]);
});

test("a flow file that is a link isn't a flow", () => {
  writeFileSync(join(home, "outside.yaml"), "review:\n  rounds: 1\n");
  mkdirSync(join(clone, ".agents", "flows"), { recursive: true });
  symlinkSync(join(home, "outside.yaml"), join(clone, ".agents", "flows", "quick.yaml"));
  agentsFile("roles/builder.md", "Build it.\n");
  commit("link");
  inHome(approveCurrent);
  expect(flowsOf()).toEqual(["default"]);
});

// Runs `code` with flowRoles and repositoryRole at hand, for a stage's role as an agent gets it.
const stageOf = (code: string) =>
  inHome(`const { flowRoles } = await import(${JSON.stringify(source("flows.ts"))}); ${code}`);

test("a flow's stage runs a role of the repository's own, with its file's instructions, harness and model", () => {
  agentsFile(
    "flows/default.yaml",
    "build:\n  role: tester\nreview:\n  role: critic\n  rounds: 2\n",
  );
  agentsFile("roles/tester.md", "---\nharness: codex\n---\nTest first.\n");
  agentsFile("roles/critic.md", "Be hard on it.\n");
  commit("roles");
  inHome(approveCurrent);
  expect(stageOf("return flowRoles(app);")).toEqual({ build: "tester", review: "critic" });
  expect(stageOf("return repositoryRole(flowRoles(app).build, app).instructions;")).toBe(
    "Test first.\n",
  );
  // A role with no harness or model of its own gets the stage's, from your config.
  expect(inHome('return readSettings(["builder"], app).builder;')).toEqual({ harness: "codex" });
  expect(inHome('return readSettings(["reviewer"], app).reviewer;')).toEqual({
    harness: "claude",
    model: "opus",
  });
  expect(roundsOf()).toBe(2);
  // A task on the built-in files runs the built-in default flow's roles.
  expect(stageOf("return flowRoles({ ...app, agents: null });")).toEqual({
    build: "builder",
    review: "reviewer",
  });
});

test("a flow naming a role with no file is refused, naming the role", () => {
  agentsFile("flows/default.yaml", "review:\n  role: critic\n");
  commit("flow");
  inHome(approveCurrent);
  expect(() => stageOf("return flowRoles(app);")).toThrow(
    "it names the role critic, which has no .agents/roles/critic.md",
  );
  expect(() => inHome('return readSettings(["reviewer"], app).reviewer;')).toThrow(
    "has no .agents/roles/critic.md",
  );
  // sc start refuses it before a thread starts on it.
  expect(() =>
    stageOf(
      `const { checkFlow } = await import(${JSON.stringify(source("config.ts"))}); checkFlow(app, "app", "default");`,
    ),
  ).toThrow("it names the role critic");
});

test("the lead reads the approved flows at a ref only Skelcrew moves, as each approval changes", () => {
  const atRef = (path: string) => {
    const shown = Bun.spawnSync(
      ["git", "-C", clone, "show", `refs/skelcrew/agents/approved:${path}`],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return shown.success ? shown.stdout.toString() : null;
  };
  agentsFile("flows/quick.yaml", "review:\n  rounds: 1\n");
  commit("flows");
  expect(atRef("flows/quick.yaml")).toBeNull();
  inHome(approveCurrent);
  expect(atRef("flows/quick.yaml")).toBe("review:\n  rounds: 1\n");
  // A change you haven't approved stays out.
  agentsFile("flows/quick.yaml", "review:\n  rounds: 9\n");
  commit("unapproved");
  expect(atRef("flows/quick.yaml")).toBe("review:\n  rounds: 1\n");
  // The built-in files have no ref.
  inHome("agents.approveAgents(app, null); return null;");
  expect(atRef("flows/quick.yaml")).toBeNull();
  // An approval from before the ref gets it once the daemon marks it.
  inHome(approveCurrent);
  git("update-ref", "-d", "refs/skelcrew/agents/approved");
  inHome("agents.markApproved(app); return null;");
  expect(atRef("flows/quick.yaml")).toBe("review:\n  rounds: 9\n");
});

test("a role of the repository's own takes its own roles: lines, never the stage's built-in role's", () => {
  agentsFile("flows/default.yaml", "build:\n  role: tester\n");
  agentsFile("roles/tester.md", "Test first.\n");
  commit("roles");
  inHome(approveCurrent);
  const config = join(home, ".config", "skelcrew", "config.yaml");
  const builder = () => inHome('return readSettings(["builder"], app).builder;');
  // roles: builder: is the built-in builder's, which doesn't run here.
  writeFileSync(config, "harness: claude\nmodel: opus\nroles: { builder: { harness: codex } }\n");
  expect(builder()).toEqual({ harness: "claude", model: "opus" });
  writeFileSync(
    config,
    "harness: claude\nmodel: opus\nroles: { builder: { harness: codex }, tester: { model: sonnet } }\n",
  );
  expect(builder()).toEqual({ harness: "claude", model: "sonnet" });
  // Your override under repos: goes over your general settings for the role, as for any role.
  writeFileSync(
    config,
    "harness: claude\nmodel: opus\nroles: { tester: { model: sonnet } }\nrepos: { simon/app: { roles: { tester: { harness: codex, model: gpt-6 } } } }\n",
  );
  expect(builder()).toEqual({ harness: "codex", model: "gpt-6" });
  // The role file's harness goes over your general settings, and your override over the file.
  agentsFile("roles/tester.md", "---\nharness: codex\n---\nTest first.\n");
  commit("tester");
  inHome(approveCurrent);
  writeFileSync(config, "harness: claude\nmodel: opus\nroles: { tester: { model: sonnet } }\n");
  expect(builder()).toEqual({ harness: "codex" });
  writeFileSync(
    config,
    "harness: claude\nmodel: opus\nrepos: { simon/app: { roles: { tester: { harness: claude } } } }\n",
  );
  expect(builder()).toEqual({ harness: "claude", model: "opus" });
});

test("skelcrew.yaml's max_rounds is the default flow's, so another flow without rounds never takes it", () => {
  writeFileSync(join(clone, "skelcrew.yaml"), "max_rounds: 5\n");
  agentsFile("flows/quick.yaml", "build:\n  role: builder\n");
  commit("flows");
  inHome(approveCurrent);
  expect(roundsOf()).toBe(5);
  expect(roundsOf('{ ...app, flow: "quick" }')).toBe(3);
  // Your config's max_rounds is your default for any flow.
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "max_rounds: 6\n");
  expect(roundsOf('{ ...app, flow: "quick" }')).toBe(6);
  expect(roundsOf()).toBe(5);
});

test("a role file's harness and model are checked only where they count", () => {
  agentsFile("roles/builder.md", "---\nharness: codex\nmodel: [bad]\n---\nBuild it.\n");
  agentsFile("roles/reviewer.md", "---\nharness: emacs\n---\nReview it.\n");
  commit("roles");
  inHome(approveCurrent);
  // A bad one that counts stops its role, naming the file and where in it.
  expect(() => inHome('return readSettings(["builder"], app);')).toThrow(
    ".agents/roles/builder.md in simon/app isn't valid: model",
  );
  expect(() => inHome('return readSettings(["reviewer"], app);')).toThrow(
    ".agents/roles/reviewer.md in simon/app isn't valid: harness",
  );
  // Your override replaces the bad model, so what starting the builder reads, its instructions
  // and its settings, comes through.
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    "harness: claude\nmodel: opus\nrepos: { simon/app: { roles: { builder: { model: gpt-6 } } } }\n",
  );
  expect(builderOf()).toEqual({
    role: { harness: "codex", model: "gpt-6" },
    told: "Build it.\n",
  });
});

test("an empty harness or model in a role file is refused where it counts", () => {
  agentsFile("roles/builder.md", "---\nmodel:\n---\nBuild it.\n");
  commit("roles");
  inHome(approveCurrent);
  expect(() => inHome('return readSettings(["builder"], app);')).toThrow(
    ".agents/roles/builder.md in simon/app isn't valid: model",
  );
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    "harness: claude\nrepos: { simon/app: { roles: { builder: { model: sonnet } } } }\n",
  );
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

test("rounds: in your config goes under the flow file, and rounds: in your override over it", () => {
  agentsFile("flows/default.yaml", "review:\n  rounds: 4\n");
  commit("flow");
  inHome(approveCurrent);
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "rounds: 6\nmax_rounds: 9\n");
  expect(roundsOf()).toBe(4);
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    "repos: { simon/app: { rounds: 7, max_rounds: 8 } }\n",
  );
  expect(roundsOf()).toBe(7);
});
