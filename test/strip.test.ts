// What the strip above the agent says, given the rows it was handed.
import { expect, test } from "bun:test";
import type { Row } from "../src/sidebar.ts";
import { drawStrip } from "../src/strip.ts";

const lead: Row = {
  name: "lead",
  session: "lead",
  status: null,
  needsYou: false,
  running: true,
  word: "running",
  harness: "claude",
  title: null,
  pr: null,
  checks: null,
  review: null,
};
const thread = (more: Partial<Row> = {}): Row => ({
  ...lead,
  name: "app-12",
  session: "app-12",
  status: "waiting",
  word: "checks",
  title: "Fix the login redirect",
  pr: 34,
  checks: "passing",
  review: { round: 2, reviewer: "codex", verdict: "approve", line: "Looks right to me." },
  ...more,
});
const size = { left: 29, width: 91 };
// Removes tmux's styles and the room left for the sidebar, to read the strip as text. A ## is
// how tmux is told to show one #.
const read = (rows: Row[], shown: string | null, given = size) =>
  drawStrip(rows, shown, given).map((line) =>
    line
      .replace(/#\[[^\]]*\]/g, "")
      .replaceAll("##", "#")
      .slice(given.left),
  );

test("a thread's first line has its name, title, PR and checks", () => {
  expect(read([lead, thread()], "app-12")[0]).toBe(
    "app-12  Fix the login redirect  #34  checks passing",
  );
});

test("a thread's second line has its latest review", () => {
  expect(read([lead, thread()], "app-12")[1]).toBe(
    "round 2 · codex · approved · Looks right to me.",
  );
  const changes = { round: 1, reviewer: "claude", verdict: "changes", line: "A test is missing." };
  expect(read([thread({ review: changes })], "app-12")[1]).toBe(
    "round 1 · claude · changes · A test is missing.",
  );
  const failed = { round: 3, reviewer: "codex", verdict: "failed", line: "codex exited with 1" };
  expect(read([thread({ review: failed })], "app-12")[1]).toBe(
    "round 3 · codex · review failed · codex exited with 1",
  );
});

test("what a thread doesn't have yet is left out", () => {
  const early = thread({ title: null, pr: null, checks: null, review: null });
  expect(read([early], "app-12")).toEqual(["app-12", "no review yet"]);
  expect(read([thread({ checks: "pending" })], "app-12")[0]).toEndWith("#34  checks running");
  expect(read([thread({ checks: "failing" })], "app-12")[0]).toEndWith("#34  checks failing");
});

test("a long title gives way, and the PR and checks stay on screen", () => {
  const long = thread({ title: "x".repeat(200) });
  const [first] = read([long], "app-12", { left: 29, width: 50 });
  expect(first).toEndWith("…  #34  checks passing");
  expect(Bun.stringWidth(first ?? "")).toBe(50);
});

test("a wide title is measured by the columns it takes, not its characters", () => {
  const [first] = read([thread({ title: "日本語".repeat(40) })], "app-12", { left: 0, width: 50 });
  expect(Bun.stringWidth(first ?? "")).toBeLessThanOrEqual(50);
});

test("a long review line is cut to the width", () => {
  const review = { round: 1, reviewer: "codex", verdict: "changes", line: "y".repeat(300) };
  const [, second] = read([thread({ review })], "app-12", { left: 0, width: 40 });
  expect(second).toEndWith("…");
  expect(Bun.stringWidth(second ?? "")).toBe(40);
});

test("too narrow for anything else, it still shows what fits and never fails", () => {
  for (let width = 0; width < 40; width++)
    for (const line of read([thread()], "app-12", { left: 0, width }))
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
});

test("the strip starts past the sidebar, so it sits above the agent", () => {
  expect(drawStrip([thread()], "app-12", size)[0]).toStartWith(" ".repeat(29));
});

test("the lead's strip counts the threads by their words, those that need you first", () => {
  const rows = [
    lead,
    thread({ name: "a", word: "working", needsYou: false }),
    thread({ name: "b", word: "approved", needsYou: true }),
    thread({ name: "c", word: "approved", needsYou: true }),
  ];
  expect(read(rows, "lead")).toEqual(["2 approved · 1 working", ""]);
});

test("the lead's strip says so when there are no threads", () => {
  expect(read([lead], "lead")).toEqual(["no threads", ""]);
});

test("an agent that isn't listed shows an empty strip of the same two lines", () => {
  expect(read([lead], "gone")).toEqual(["", ""]);
  expect(read([lead], null)).toEqual(["", ""]);
});

test("a title can't run commands or restyle the strip, as tmux reads the strip as a format", () => {
  const title = "#(touch /tmp/pwned) #[fg=red] #{pane_pid}";
  const line = drawStrip([thread({ title })], "app-12", size)[0];
  expect(line).toContain("##(touch /tmp/pwned) ##[fg=red] ##{pane_pid}");
});

test("a title or review can't reach your terminal with control codes", () => {
  const review = { round: 1, reviewer: "codex", verdict: "changes", line: "a\x1b]2;owned\x07b\tc" };
  const strip = drawStrip([thread({ title: "x\x1b[2Jy\r\nz", review })], "app-12", size);
  expect(strip.join("")).not.toMatch(/\p{Cc}/u);
  expect(read([thread({ title: "x\x1b[2Jy", review })], "app-12")[0]).toContain("x [2Jy");
});
