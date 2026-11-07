// What the strip above the agent says, given the rows it was handed.
import { expect, test } from "bun:test";
import type { Link, Row } from "../src/screen/rows.ts";
import { drawStrip } from "../src/screen/strip.ts";

const lead: Row = {
  name: "lead",
  session: "lead",
  status: null,
  needsYou: false,
  running: true,
  word: "running",
  harness: "claude",
  age: "",
  fullName: null,
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
  review: { round: 2, reviewer: "codex", verdict: "approve" },
  ...more,
});
const size = { left: 30, width: 90 };
// Returns a line as you see it, without tmux's styles. A ## is how tmux is told to show one #.
const seen = (line: string) => line.replace(/#\[[^\]]*\]/g, "").replaceAll("##", "#");
// The strip above the agent as text, without what is above the sidebar.
const read = (rows: Row[], shown: string | null, given = size) =>
  seen(drawStrip(rows, shown, given, "")[0]).slice(given.left);
const whole = "app-12  Fix the login redirect  #34  checks passing  round 2 · codex · approved";

test("a thread's line has its name, title, PR, checks and latest review", () => {
  expect(read([lead, thread()], "app-12")).toBe(whole);
  const changes = { round: 1, reviewer: "claude", verdict: "changes" };
  expect(read([thread({ review: changes })], "app-12")).toEndWith(
    "#34  checks passing  round 1 · claude · changes",
  );
  const failed = { round: 3, reviewer: "codex", verdict: "failed" };
  expect(read([thread({ review: failed })], "app-12")).toEndWith(
    "#34  checks passing  round 3 · codex · review failed",
  );
});

test("the review is dim, and the rest isn't", () => {
  const [first] = drawStrip([thread()], "app-12", size, "");
  expect(first).toEndWith("checks passing#[fg=brightblack]  round 2 · codex · approved");
});

test("what a thread doesn't have yet is left out, with no words in its place", () => {
  const early = thread({ title: null, pr: null, checks: null, review: null });
  expect(read([early], "app-12")).toBe("app-12");
  const unreviewed = thread({ review: null });
  expect(read([unreviewed], "app-12")).toBe("app-12  Fix the login redirect  #34  checks passing");
  const pending = thread({ checks: "pending", review: null });
  expect(read([pending], "app-12")).toEndWith("#34  checks running");
  const failing = thread({ checks: "failing", review: null });
  expect(read([failing], "app-12")).toEndWith("#34  checks failing");
});

test("as room runs out the title gives way first, and everything after it stays", () => {
  const line = read([thread()], "app-12", { left: 30, width: 70 });
  expect(line).toStartWith("app-12  Fix the logi…");
  expect(line).toEndWith("…  #34  checks passing  round 2 · codex · approved");
  expect(Bun.stringWidth(line)).toBe(70);
});

test("with the title gone the review gives way next, and the PR and checks stay", () => {
  const line = read([thread()], "app-12", { left: 30, width: 40 });
  expect(line).toStartWith("app-12  #34  checks passing  round 2");
  expect(line).toEndWith("…");
  expect(line).not.toContain("Fix");
  expect(Bun.stringWidth(line)).toBe(40);
  expect(read([thread()], "app-12", { left: 30, width: 27 })).toBe("app-12  #34  checks passing");
});

test("a long title gives way, and what follows it stays on screen", () => {
  const line = read([thread({ title: "x".repeat(200) })], "app-12", { left: 30, width: 80 });
  expect(line).toEndWith("…  #34  checks passing  round 2 · codex · approved");
  expect(Bun.stringWidth(line)).toBe(80);
});

test("a wide title is measured by the columns it takes, not its characters", () => {
  const line = read([thread({ title: "日本語".repeat(40) })], "app-12", { left: 30, width: 70 });
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(70);
});

test("too narrow for anything else, it still shows what fits and never fails", () => {
  for (let width = 0; width < 90; width++)
    expect(Bun.stringWidth(read([thread()], "app-12", { left: 30, width }))).toBeLessThanOrEqual(
      width,
    );
});

test("the strip starts past the sidebar, so it sits above the agent", () => {
  const [first = ""] = drawStrip([thread()], "app-12", size, "");
  expect(seen(first).indexOf("app-12")).toBe(30);
});

test("above the sidebar, skel in white in line with the marks, then dim a dot and where it runs", () => {
  const [first] = drawStrip([thread()], "app-12", size, "sprite:demo");
  expect(seen(first)).toStartWith("  skel · sprite:demo");
  expect(first).toContain("#[bold,fg=colour231]skel#[default]");
  expect(first).toContain("#[fg=brightblack] · sprite:demo#[default]");
});

test("on this machine the header is just skel, with no dot and no place", () => {
  const [first = ""] = drawStrip([thread()], "lead", size, "");
  expect(seen(first).trimEnd()).toBe("  skel");
  expect(first).not.toContain("·");
});

test("a release shows dim right after the name, here and on a remote", () => {
  const [here = ""] = drawStrip([thread()], "lead", size, "", "0.4.2");
  expect(seen(here).trimEnd()).toBe("  skel 0.4.2");
  expect(here).toContain("#[bold,fg=colour231]skel#[default]#[fg=brightblack] 0.4.2#[default]");
  const [there = ""] = drawStrip([thread()], "lead", size, "sprite:skel", "0.4.2");
  expect(seen(there).trimEnd()).toBe("  skel 0.4.2 · sprite:skel");
  expect(there).toContain("#[fg=brightblack] 0.4.2 · sprite:skel#[default]");
});

test("a release leaves the strip above the agent where it was", () => {
  const [first = ""] = drawStrip([thread()], "app-12", size, "sprite:skel", "0.4.2");
  expect(seen(first).indexOf("app-12")).toBe(30);
});

test("the place is cut before the release, which stays whole", () => {
  const where = "simon@a-very-long-server-name.example.com";
  const [first = ""] = drawStrip([thread()], "app-12", size, where, "0.4.2");
  expect(seen(first).slice(0, 30)).toBe("  skel 0.4.2 · simon@a-ve…    ");
  expect(seen(first).indexOf("app-12")).toBe(30);
});

test("with no room for both, the place goes first, and then the release, never half of it", () => {
  const line = (left: number) =>
    seen(drawStrip([lead], "lead", { left, width: 40 }, "sprite:skel", "0.4.2")[0]);
  expect(line(20).trimEnd()).toBe("  skel 0.4.2 · …");
  expect(line(19).trimEnd()).toBe("  skel 0.4.2");
  expect(line(16).trimEnd()).toBe("  skel 0.4.2");
  expect(line(15).trimEnd()).toBe("  skel");
});

test("the header stays whatever you are looking at", () => {
  for (const shown of ["lead", "app-12", "gone", null]) {
    const [first = ""] = drawStrip([lead, thread()], shown, size, "");
    expect(seen(first).slice(0, 30).trimEnd()).toBe("  skel");
    expect(seen(first).slice(0, 30)).toHaveLength(30);
  }
});

test("it is always two lines, so the agent's height never changes as you switch", () => {
  for (const shown of ["lead", "app-12", "gone", null])
    expect(drawStrip([lead, thread()], shown, size, "")).toHaveLength(2);
});

test("a long place is cut to fit above the sidebar, and the strip stays above the agent", () => {
  const where = "simon@a-very-long-server-name.example.com";
  const first = drawStrip([thread()], "app-12", size, where)[0];
  const text = seen(first);
  expect(text.slice(0, 30).trimEnd()).toEndWith("…");
  // Two columns short of the sidebar's edge, which is in column 28.
  expect(Bun.stringWidth(text.slice(0, 30).trimEnd())).toBe(26);
  expect(text.indexOf("app-12")).toBe(30);
});

test("where skel runs can't run commands, restyle the strip or reach your terminal", () => {
  const first = drawStrip([thread()], "app-12", size, "#(id) 5%\x1b[2J")[0];
  expect(first).toContain("##(id) 5%% [2J");
  expect(first).not.toMatch(/\p{Cc}/u);
});

test("the second line is a thin line across the whole width, joining the sidebar's edge", () => {
  for (const given of [size, { left: 30, width: 50 }, { left: 12, width: 8 }]) {
    const line = seen(drawStrip([thread()], "app-12", given, "")[1]);
    expect(Bun.stringWidth(line)).toBe(given.left + given.width);
    expect(line.indexOf("┬")).toBe(given.left - 2);
    expect(line.replace("┬", "")).toMatch(/^─+$/);
  }
  expect(drawStrip([], null, size, "")[1]).toStartWith("#[fg=colour237]─");
});

test("the lead's strip is empty, as the sidebar already shows what needs you", () => {
  const rows = [lead, thread({ word: "approved", needsYou: true })];
  expect(read(rows, "lead")).toBe("");
});

test("an agent that isn't listed shows an empty strip", () => {
  expect(read([lead], "gone")).toBe("");
  expect(read([lead], null)).toBe("");
});

test("a title can't run commands or restyle the strip, as tmux reads the strip as a format", () => {
  const title = "#(touch /tmp/pwned) #[fg=red] #{pane_pid}";
  const line = drawStrip([thread({ title, review: null })], "app-12", size, "")[0];
  expect(line).toContain("##(touch /tmp/pwned) ##[fg=red] ##{pane_pid}");
});

test("a review can't run commands or restyle the strip either", () => {
  const review = { round: 1, reviewer: "#(id) 5%", verdict: "#[fg=red]" };
  const line = drawStrip([thread({ review })], "app-12", size, "")[0];
  expect(line).toContain("##(id) 5%% · ##[fg=red]");
});

test("a title or review can't reach your terminal with control codes", () => {
  const review = { round: 1, reviewer: "co\x1b]2;owned\x07dex", verdict: "chan\tges" };
  const strip = drawStrip([thread({ title: "x\x1b[2Jy\r\nz", review })], "app-12", size, "");
  expect(strip.join("")).not.toMatch(/\p{Cc}/u);
  expect(read([thread({ title: "x\x1b[2Jy", review })], "app-12")).toContain("x [2Jy");
});

const issue: Link = {
  name: "app-31",
  title: "Add CSV export",
  url: "https://github.com/simon/app/issues/31",
  word: "",
  needing: false,
  dim: false,
  mark: null,
};
// The strip's first line above the agent, as tmux would show it, without its styles.
const aboutPage = (link: Link, width = size.width) =>
  seen(drawStrip([lead], link.url, { ...size, width }, "", "", link)[0]).slice(size.left);

test("while a page shows, the strip has the row's name and title", () => {
  expect(aboutPage(issue)).toBe("app-31  Add CSV export");
  expect(drawStrip([lead], issue.url, size, "", "", issue)[0]).toContain("#[bold]app-31#[default]");
});

test("a page's long title is cut to the strip", () => {
  const long = aboutPage({ ...issue, title: "word ".repeat(40) }, 30);
  expect(Bun.stringWidth(long)).toBeLessThanOrEqual(30);
  expect(long).toEndWith("…");
});

test("what a page's title says is shown, never run or read as a format", () => {
  const [line] = drawStrip([lead], issue.url, size, "", "", {
    ...issue,
    title: "#(touch owned) 100%\x1b[31m",
  });
  expect(line).toContain("##(touch owned) 100%%");
  expect(line).not.toContain("\x1b");
});
