// The live view shows only the agent's output: each harness's input area and status lines are cut
// off the bottom of its screen, found by their shape on screens captured from each harness.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { agentOutput } from "../src/list/live.ts";
import { drawPane } from "../src/list/pane.ts";
import type { Row } from "../src/list/rows.ts";

// Returns a captured screen, colours included, as the session host gives it.
const screen = (name: string) => Bun.file(join(import.meta.dir, "screens", name)).text();

// Returns the last lines of a screen with something on them, without colours.
const bottom = (text: string, count: number) =>
  Bun.stripANSI(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-count);

test("Claude Code's prompt, rules and status line are cut, idle or at work", async () => {
  const idle = agentOutput("claude", await screen("claude-idle.txt"));
  expect(bottom(idle, 1)).toEqual([expect.stringContaining("◐ medium · /effort")]);
  expect(idle).not.toContain("❯");
  expect(idle).not.toContain("bypass permissions");
  const busy = agentOutput("claude", await screen("claude-busy.txt"));
  expect(bottom(busy, 2)).toEqual([
    "  ⎿  Added 12 lines",
    "✻ Kneading… (42s · ↓ 1.2k tokens · esc to interrupt)",
  ]);
  // The message quoted in the output starts with ❯ too, and stays.
  expect(busy).toContain("❯ Rate limit the API per user");
  expect(busy).not.toContain("─");
});

test("a long message typed into Claude Code is cut with its prompt, over all its lines", async () => {
  const long = agentOutput("claude", await screen("claude-long.txt"));
  expect(long).not.toContain("every file in src");
  expect(long).not.toContain("Please write");
  expect(bottom(long, 1)).toEqual([expect.stringContaining("tmux focus-events off")]);
});

test("Codex's input box and footer are cut, idle, at work or with a long message typed", async () => {
  const idle = agentOutput("codex", await screen("codex-idle.txt"));
  expect(bottom(idle, 1)).toEqual(["• Edited src/api/limit.ts (+12 -0)"]);
  const busy = agentOutput("codex", await screen("codex-busy.txt"));
  expect(bottom(busy, 1)).toEqual(["• Working (42s • esc to interrupt)"]);
  expect(busy).toContain("› Rate limit the API per user");
  expect(busy).not.toContain("context left");
  const long = agentOutput("codex", await screen("codex-long.txt"));
  expect(bottom(long, 1)).toEqual(["• Working (42s • esc to interrupt)"]);
  expect(long).not.toContain("every file in src");
});

test("a screen whose input area isn't found shows whole", async () => {
  const unknown = await screen("unknown.txt");
  expect(agentOutput("claude", unknown)).toBe(unknown);
  expect(agentOutput("codex", unknown)).toBe(unknown);
  // A harness drawn another way, such as Codex's screen read as Claude Code's, keeps its input.
  const codex = await screen("codex-busy.txt");
  expect(agentOutput("claude", codex)).toBe(codex);
  expect(agentOutput(null, codex)).toBe(codex);
});

test("what is left fills the live view from the bottom up", async () => {
  const row: Row = {
    part: "building",
    section: "building",
    name: "app-12",
    task: "12",
    title: "Rate limit",
    mark: { sign: "●", colour: "green" },
    says: "",
    colour: "green",
    step: "",
    pr: "",
    checks: "",
    when: "14:02",
    needsYou: false,
    session: "app-12",
    running: true,
    tmux: true,
    start: null,
    merge: null,
    link: null,
    branch: "skelcrew/12",
    more: 0,
  };
  const details = {
    view: {
      task: "app-12",
      stage: "working" as const,
      title: "Rate limit the API",
      issue: null,
      threads: [],
      body: "",
      pr: null,
      review: null,
      prPage: null,
      merge: null,
      filed: null,
    },
    findings: [],
    events: [],
  };
  const live = { screen: agentOutput("claude", await screen("claude-busy.txt")) };
  const lines = drawPane(row, details, live, 60, 12).map((line) => Bun.stripANSI(line).trimEnd());
  expect(lines.at(-1)).toBe("✻ Kneading… (42s · ↓ 1.2k tokens · esc to interrupt)");
  expect(lines.join("\n")).not.toContain("bypass permissions");
});
