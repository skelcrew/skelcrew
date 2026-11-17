// The builder's instructions, as each harness starts a builder with them. They never start
// bubblewrap, so they run inside Skelcrew's sandbox too.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessName, harnessNamed } from "../src/agents/harness.ts";
import instructions from "../src/defaults/roles/builder.md" with { type: "text" };
import { builderInstructions } from "../src/flow/builder.ts";

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

// The lead settles the setup and test commands with the human once, so every builder uses the
// same ones, and a builder with none asks rather than guess.
test("a builder is told the repository's setup and test commands", () => {
  const told = builderInstructions({ setup: ["go mod download"], test: ["make check"] });
  expect(told.startsWith(instructions.replace(/\n$/, ""))).toBe(true);
  expect(told).toContain("Never run the repository's whole test suite");
  expect(told).toEndWith(
    "Skelcrew set up your clone with `go mod download`. The repository's whole test suite runs with `make check`. That is for CI and the reviewer, so don't run it yourself. It shows how the repository runs its tests, lint and typecheck, so run the parts near your change.\n",
  );
  expect(builderInstructions({ setup: [], test: ["go test ./..."] })).toEndWith(
    "\n\nNo setup command is configured. The repository's whole test suite runs with `go test ./...`. That is for CI and the reviewer, so don't run it yourself. It shows how the repository runs its tests, lint and typecheck, so run the parts near your change.\n",
  );
});

// Each command is told on its own, so a configured setup is never hidden by a missing test.
test("a builder is told each command that isn't configured, and asks the lead rather than make one up", () => {
  expect(builderInstructions({ setup: [], test: [] })).toEndWith(
    "\n\nNo setup command is configured. No test command is configured.\n",
  );
  expect(builderInstructions({ setup: ["bun install"], test: [] })).toEndWith(
    "\n\nSkelcrew set up your clone with `bun install`. No test command is configured.\n",
  );
  expect(builderInstructions({ setup: [], test: [] })).toContain(
    "If one you need isn't configured, never make one up: ask the lead which to use with sc tell lead, and wait for its answer. That counts as blocked.",
  );
});
