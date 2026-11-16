// The builder's instructions, as each harness starts a builder with them. They never start
// bubblewrap, so they run inside Skelcrew's sandbox too.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessName, harnessNamed } from "../src/agents/harness.ts";
import instructions from "../src/agents/prompts/builder.md" with { type: "text" };

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
