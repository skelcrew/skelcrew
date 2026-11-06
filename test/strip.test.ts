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
const size = { left: 30, width: 90 };
// Returns a line as you see it, without tmux's styles. A ## is how tmux is told to show one #.
const seen = (line: string) => line.replace(/#\[[^\]]*\]/g, "").replaceAll("##", "#");
// The two lines above the agent as text, without what is above the sidebar.
const read = (rows: Row[], shown: string | null, given = size) =>
  drawStrip(rows, shown, given, "local")
    .slice(0, 2)
    .map((line) => seen(line).slice(given.left));

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
  const [first] = read([long], "app-12", { left: 30, width: 50 });
  expect(first).toEndWith("…  #34  checks passing");
  expect(Bun.stringWidth(first ?? "")).toBe(50);
});

test("a wide title is measured by the columns it takes, not its characters", () => {
  const [first] = read([thread({ title: "日本語".repeat(40) })], "app-12", { left: 30, width: 50 });
  expect(Bun.stringWidth(first ?? "")).toBeLessThanOrEqual(50);
});

test("a long review line is cut to the width", () => {
  const review = { round: 1, reviewer: "codex", verdict: "changes", line: "y".repeat(300) };
  const [, second] = read([thread({ review })], "app-12", { left: 30, width: 40 });
  expect(second).toEndWith("…");
  expect(Bun.stringWidth(second ?? "")).toBe(40);
});

test("too narrow for anything else, it still shows what fits and never fails", () => {
  for (let width = 0; width < 40; width++)
    for (const line of read([thread()], "app-12", { left: 30, width }))
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
});

test("the strip starts past the sidebar, so it sits above the agent", () => {
  const [first = "", second = ""] = drawStrip([thread()], "app-12", size, "local");
  expect(seen(first).indexOf("app-12")).toBe(30);
  expect(seen(second).indexOf("round 2")).toBe(30);
});

test("above the sidebar, skel from green to blue, then dim where it runs, in line with the marks", () => {
  const [first] = drawStrip([thread()], "app-12", size, "sprite:demo");
  expect(seen(first)).toStartWith("  skel  sprite:demo");
  expect(first).toContain("#[bold,fg=colour71]s#[fg=colour36]k#[fg=colour31]e#[fg=colour32]l");
  expect(first).toContain("#[fg=brightblack]sprite:demo#[default]");
});

test("the header stays whatever you are looking at, with nothing under it", () => {
  for (const shown of ["lead", "app-12", "gone", null]) {
    const [first = "", second = ""] = drawStrip([lead, thread()], shown, size, "local");
    expect(seen(first).slice(0, 30).trimEnd()).toBe("  skel  local");
    expect(seen(first).slice(0, 30)).toHaveLength(30);
    expect(seen(second).slice(0, 30).trim()).toBe("");
  }
});

test("a long place is cut to fit above the sidebar, and the strip stays above the agent", () => {
  const where = "simon@a-very-long-server-name.example.com";
  const first = drawStrip([thread()], "app-12", size, where)[0];
  const text = seen(first);
  expect(text.slice(0, 30).trimEnd()).toEndWith("…");
  expect(Bun.stringWidth(text.slice(0, 30).trimEnd())).toBe(28);
  expect(text.indexOf("app-12")).toBe(30);
});

test("where skel runs can't run commands, restyle the strip or reach your terminal", () => {
  const first = drawStrip([thread()], "app-12", size, "#(id) 5%\x1b[2J")[0];
  expect(first).toContain("##(id) 5%% [2J");
  expect(first).not.toMatch(/\p{Cc}/u);
});

test("the third line is a thin line across the whole width, joining the sidebar's edge", () => {
  for (const given of [size, { left: 30, width: 50 }, { left: 12, width: 8 }]) {
    const line = seen(drawStrip([thread()], "app-12", given, "local")[2]);
    expect(Bun.stringWidth(line)).toBe(given.left + given.width);
    expect(line.indexOf("┬")).toBe(given.left - 2);
    expect(line.replace("┬", "")).toMatch(/^─+$/);
  }
  expect(drawStrip([], null, size, "local")[2]).toStartWith("#[fg=colour237]─");
});

test("the lead's strip is empty, as the sidebar already shows what needs you", () => {
  const rows = [lead, thread({ word: "approved", needsYou: true })];
  expect(read(rows, "lead")).toEqual(["", ""]);
});

test("an agent that isn't listed shows an empty strip of the same two lines", () => {
  expect(read([lead], "gone")).toEqual(["", ""]);
  expect(read([lead], null)).toEqual(["", ""]);
});

test("a title can't run commands or restyle the strip, as tmux reads the strip as a format", () => {
  const title = "#(touch /tmp/pwned) #[fg=red] #{pane_pid}";
  const line = drawStrip([thread({ title })], "app-12", size, "local")[0];
  expect(line).toContain("##(touch /tmp/pwned) ##[fg=red] ##{pane_pid}");
});

test("a title or review can't reach your terminal with control codes", () => {
  const review = { round: 1, reviewer: "codex", verdict: "changes", line: "a\x1b]2;owned\x07b\tc" };
  const strip = drawStrip([thread({ title: "x\x1b[2Jy\r\nz", review })], "app-12", size, "local");
  expect(strip.join("")).not.toMatch(/\p{Cc}/u);
  expect(read([thread({ title: "x\x1b[2Jy", review })], "app-12")[0]).toContain("x [2Jy");
});
