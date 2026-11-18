// The builder's and lead's instructions, as each harness starts them. They never start
// bubblewrap, so they run inside Skelcrew's sandbox too.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessName, harnessNamed } from "../src/agents/harness.ts";
import instructions from "../src/defaults/roles/builder.md" with { type: "text" };
import { builderInstructions } from "../src/flow/builder.ts";
import { leadInstructions } from "../src/flow/lead.ts";
import { builtInRole } from "../src/roles.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-instructions-test-")));
  // Claude Code's builder needs Skelcrew's login token for agents to start.
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-tok\n");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// The full suite runs once per commit, in CI or the reviewer, so a builder never runs it.
for (const name of HarnessName.options)
  test(`a builder on ${name} runs only the tests related to its change, with lint and typecheck`, async () => {
    const { argv } = await harnessNamed(name).start({
      name: "app-12",
      socket: join(home, "socket"),
      thread: join(home, "app-12"),
      system: instructions,
      sessionId: crypto.randomUUID(),
      prompt: "Add export",
      env: { HOME: home, PATH: process.env.PATH ?? "" },
    });
    const told = argv.join("\n");
    expect(told).toContain("Never run the repository's whole test suite");
    expect(told).toContain("CI or the reviewer runs it once for each commit");
    expect(told).toContain(
      "Before each sc submit, run the tests related to your change: the test files you touched and the tests of the code you changed.",
    );
    expect(told).toContain("Run the repository's lint and typecheck too");
    expect(told).not.toContain("once before each sc submit");
  });

// Skelcrew keeps its clone, the builder's origin, current with the forge, but never moves the
// builder's own origin/ refs. A builder that compares with them unfetched would say it
// already has main when it doesn't.
test("a builder fetches before it compares with or merges the base branch", () => {
  const told = builderInstructions(instructions, { setup: undefined, test: undefined });
  expect(told).toContain(
    "Before you compare your branch with its base branch or merge it, such as main, run git fetch origin first.",
  );
});

// The lead settles the setup and test commands with the human once, so every builder uses the
// same ones, and a builder with none asks rather than guess.
test("a builder is told the repository's setup and test commands", () => {
  const told = builderInstructions(instructions, {
    setup: ["go mod download"],
    test: ["make check"],
  });
  expect(told.startsWith(instructions.replace(/\n$/, ""))).toBe(true);
  expect(told).toContain("Never run the repository's whole test suite");
  expect(told).toEndWith(
    "Skelcrew set up your clone with `go mod download`. The repository's whole test suite runs with `make check`. That is for CI and the reviewer, so don't run it yourself. If you ever must, run `sc check`, which runs it once one of this machine's check slots is free, never the command itself. It shows how the repository runs its tests, lint and typecheck, so run the parts near your change.\n",
  );
  expect(
    builderInstructions(instructions, { setup: undefined, test: ["go test ./..."] }),
  ).toEndWith(
    "\n\nNo setup command is configured. The repository's whole test suite runs with `go test ./...`. That is for CI and the reviewer, so don't run it yourself. If you ever must, run `sc check`, which runs it once one of this machine's check slots is free, never the command itself. It shows how the repository runs its tests, lint and typecheck, so run the parts near your change.\n",
  );
});

// Each command is told on its own, so a configured setup is never hidden by a missing test.
test("a builder is told each command that isn't configured, and asks the lead rather than make one up", () => {
  expect(builderInstructions(instructions, { setup: undefined, test: undefined })).toEndWith(
    "\n\nNo setup command is configured. No test command is configured.\n",
  );
  expect(builderInstructions(instructions, { setup: ["bun install"], test: undefined })).toEndWith(
    "\n\nSkelcrew set up your clone with `bun install`. No test command is configured.\n",
  );
  expect(builderInstructions(instructions, { setup: undefined, test: undefined })).toContain(
    "If one you need isn't configured, never make one up: ask the lead which to use with sc tell lead, and wait for its answer. That counts as blocked.",
  );
});

// The lead can't read the human's config from its sandbox, so it is told which commands are
// configured, each on its own, and proposes only the ones that are missing.
test("a lead is told its repository and each setup and test command, or that none is configured", () => {
  const told = leadInstructions(
    builtInRole("lead").instructions,
    "simon/app",
    "/clones/simon/app",
    {
      setup: ["bun install"],
      test: ["bun run check"],
    },
  );
  expect(told).toContain("Before you start the first thread in your repository");
  expect(told).toContain(
    "\nYou are the lead of simon/app. Skelcrew's clone of it is at /clones/simon/app.\nWhen this session started, the setup command was `bun install`, and the test command was `bun run check`.\n",
  );
  expect(
    leadInstructions(builtInRole("lead").instructions, "simon/app", "/c", {
      setup: undefined,
      test: ["go test ./..."],
    }),
  ).toContain(
    "\nWhen this session started, no setup command was configured, and the test command was `go test ./...`.\n",
  );
  expect(
    leadInstructions(builtInRole("lead").instructions, "simon/app", "/c", {
      setup: undefined,
      test: undefined,
    }),
  ).toContain(
    "\nWhen this session started, no setup command was configured, and no test command was configured.\n",
  );
});

// Every task runs the default flow unless the repository has other flow files. Then the lead
// triages, and tells the human whenever it picks another.
test("a lead triages a task's flow, from the folder of the flows the human approved", () => {
  const role = builtInRole("lead").instructions;
  expect(role).toContain("sc start app-13 --flow <name>");
  expect(role).toContain("Whenever you pick a flow other than default, tell the human");
  expect(role).toContain("A task keeps its flow from start to end.");
  expect(role).toContain("not the files in .agents/flows/ in the clone");
  const commands = { setup: undefined, test: undefined };
  expect(leadInstructions(role, "simon/app", "/c", commands)).toEndWith(
    "and no test command was configured.\nThe .agents/ the human approved is at refs/skelcrew/agents/approved in the clone. List its flows with git -C /c ls-tree --name-only refs/skelcrew/agents/approved flows/, and read one with git -C /c show refs/skelcrew/agents/approved:flows/<name>.yaml. Without that ref, or with no flows there, tasks run only Skelcrew's built-in default flow.\n",
  );
});

// An empty list says on purpose that the repository needs no setup or has no tests, so neither
// the lead nor a builder takes it for a command that is missing.
test("an empty list is told as configured to none, not as missing", () => {
  expect(builderInstructions(instructions, { setup: [], test: [] })).toEndWith(
    "\n\nSetup is configured as none, so Skelcrew ran no setup command. Test is configured as none, so the repository has no test suite to run.\n",
  );
  expect(
    leadInstructions(builtInRole("lead").instructions, "simon/app", "/c", { setup: [], test: [] }),
  ).toContain(
    "\nWhen this session started, setup was configured as none, and test was configured as none.\n",
  );
});
