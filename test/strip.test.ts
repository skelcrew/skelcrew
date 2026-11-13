// What the top row says: the header above the sidebar, then the tabs and the strip above the agent.
import { expect, test } from "bun:test";
import type { Link, Row, Tab } from "../src/screen/rows.ts";
import { drawTop, type Top } from "../src/screen/strip.ts";

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
  short: null,
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
const tab = (name: string, count = 0): Tab => ({ name, fullName: `simon/${name}`, count });
// The tab "  app  " and the two columns after it take nine columns before the strip.
const size = { left: 30, width: 99 };
const base: Top = {
  rows: [lead, thread()],
  shown: "app-12",
  page: null,
  tabs: [tab("app")],
  open: "simon/app",
  where: "",
  version: "0.1.0",
};
// Returns the top row as a tmux format, for the base with some of it changed.
const top = (more: Partial<Top> = {}, given = size) => drawTop({ ...base, ...more }, given);
// Returns a line as you see it, without tmux's styles. A ## is how tmux is told to show one #.
const seen = (line: string) => line.replace(/#\[[^\]]*\]/g, "").replaceAll("##", "#");
// The strip as you see it: what follows the one tab above the agent.
const read = (more: Partial<Top> = {}, given = size) =>
  seen(top(more, given))
    .slice(given.left)
    .replace(/^ {2}app {2}/, "")
    .trimStart();
// What is above the sidebar, up to its edge.
const above = (more: Partial<Top> = {}, given = size) =>
  seen(top(more, given)).slice(0, given.left - 2);
const whole = "app-12  Fix the login redirect  #34  checks passing  round 2 · codex · approved";

test("a thread's strip has its name, title, PR, checks and latest review", () => {
  expect(read()).toBe(whole);
  const changes = { round: 1, reviewer: "claude", verdict: "changes" };
  expect(read({ rows: [thread({ review: changes })] })).toEndWith(
    "#34  checks passing  round 1 · claude · changes",
  );
  const failed = { round: 3, reviewer: "codex", verdict: "failed" };
  expect(read({ rows: [thread({ review: failed })] })).toEndWith(
    "#34  checks passing  round 3 · codex · review failed",
  );
});

test("the strip ends at the right edge of the row, above the agent's last column", () => {
  const line = seen(top());
  expect(line).toEndWith(whole);
  expect(Bun.stringWidth(line)).toBe(size.left + size.width);
});

test("the strip is dim, with the name in bold", () => {
  expect(top()).toEndWith(
    "#[fg=brightblack,bold]app-12#[nobold]  Fix the login redirect  ##34  checks passing  round 2 · codex · approved#[default]",
  );
});

test("what a thread doesn't have yet is left out, with no words in its place", () => {
  const strip = (more: Partial<Row>) => read({ rows: [thread(more)] });
  expect(strip({ title: null, pr: null, checks: null, review: null })).toBe("app-12");
  expect(strip({ review: null })).toBe("app-12  Fix the login redirect  #34  checks passing");
  expect(strip({ checks: "pending", review: null })).toEndWith("#34  checks running");
  expect(strip({ checks: "failing", review: null })).toEndWith("#34  checks failing");
});

// Returns the size whose strip has `room` columns, after the tab and the two columns past it.
const roomFor = (room: number) => ({ left: 30, width: room + 9 });

test("as room runs out the title gives way first, and everything after it stays", () => {
  const line = read({}, roomFor(70));
  expect(line).toStartWith("app-12  Fix the logi…");
  expect(line).toEndWith("…  #34  checks passing  round 2 · codex · approved");
  expect(Bun.stringWidth(line)).toBe(70);
});

test("with the title gone the review gives way next, and the PR and checks stay", () => {
  const line = read({}, roomFor(40));
  expect(line).toStartWith("app-12  #34  checks passing  round 2");
  expect(line).toEndWith("…");
  expect(line).not.toContain("Fix");
  expect(Bun.stringWidth(line)).toBe(40);
  expect(read({}, roomFor(27))).toBe("app-12  #34  checks passing");
});

test("a long title gives way, and what follows it stays on screen", () => {
  const line = read({ rows: [thread({ title: "x".repeat(200) })] }, roomFor(80));
  expect(line).toEndWith("…  #34  checks passing  round 2 · codex · approved");
  expect(Bun.stringWidth(line)).toBe(80);
});

test("a wide title is measured by the columns it takes, not its characters", () => {
  const line = read({ rows: [thread({ title: "日本語".repeat(40) })] }, roomFor(70));
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(70);
});

test("too narrow for anything else, it still shows what fits and never fails", () => {
  for (let room = 0; room < 90; room++)
    expect(Bun.stringWidth(read({}, roomFor(room)))).toBeLessThanOrEqual(room);
});

test("the tabs come first: the strip gives way before any tab does", () => {
  const tabs = [tab("app"), tab("site", 1)];
  // The two tabs take eighteen columns, and leave the strip none.
  const line = seen(top({ tabs }, { left: 30, width: 20 })).slice(30);
  expect(line.trimEnd()).toBe("  app    site •1");
  expect(seen(top({ tabs }, { left: 30, width: 40 }))).toMatch(/ {2}app {4}site •1 +app-12$/);
});

// A sidebar wide enough for the version and a whole place after it.
const roomy = { left: 40, width: 99 };

test("above the sidebar, Skelcrew in white in line with the marks, then dim a dot and where it runs", () => {
  const line = top({ where: "sprite:demo" }, roomy);
  expect(above({ where: "sprite:demo" }, roomy)).toStartWith("  Skelcrew v0.1.0 · sprite:demo");
  expect(line).toContain("#[bold,fg=colour231]Skelcrew#[default]");
  expect(line).toContain("#[fg=brightblack] v0.1.0 · sprite:demo#[default]");
});

test("on this machine the header is Skelcrew and its version, with no dot and no place", () => {
  expect(above().trimEnd()).toBe("  Skelcrew v0.1.0");
  expect(top({ shown: "lead" })).not.toContain("·");
  expect(top({ shown: "lead" })).toContain("#[fg=brightblack] v0.1.0#[default]");
});

test("the version shows dim right after the name, here and on a remote", () => {
  expect(above({ version: "0.4.2" }).trimEnd()).toBe("  Skelcrew v0.4.2");
  expect(top({ version: "0.4.2" })).toContain(
    "#[bold,fg=colour231]Skelcrew#[default]#[fg=brightblack] v0.4.2#[default]",
  );
  const there = { version: "0.4.2", where: "workbox" };
  expect(above(there, roomy).trimEnd()).toBe("  Skelcrew v0.4.2 · workbox");
  expect(top(there, roomy)).toContain("#[fg=brightblack] v0.4.2 · workbox#[default]");
});

test("the place is cut before the version, which stays whole", () => {
  const where = "simon@a-very-long-server-name.example.com";
  expect(above({ where, version: "0.4.2" })).toBe("  Skelcrew v0.4.2 · simon…  ");
});

test("with no room for both, the place goes first, and then the version, never half of it", () => {
  const line = (left: number) =>
    above({ shown: "lead", where: "workbox", version: "0.4.2" }, { left, width: 40 }).trimEnd();
  expect(line(25)).toBe("  Skelcrew v0.4.2 · …");
  expect(line(24)).toBe("  Skelcrew v0.4.2");
  expect(line(21)).toBe("  Skelcrew v0.4.2");
  expect(line(20)).toBe("  Skelcrew");
});

test("the sidebar's edge runs up through the row, and the tabs start where the agent does", () => {
  for (const shown of ["lead", "app-12", "gone", null])
    for (const more of [
      {},
      { where: "simon@a-very-long-server-name.example.com", version: "0.4.2" },
    ]) {
      const line = seen(top({ shown, ...more }));
      expect(line[size.left - 2]).toBe("│");
      expect(line.indexOf("app")).toBe(size.left + 2);
    }
  expect(top()).toContain("#[fg=colour237]│#[default]");
});

test("where Skelcrew runs can't run commands, restyle the row or reach your terminal", () => {
  const line = top({ where: "#(id) 5%\x1b[2J" }, roomy);
  expect(line).toContain("##(id) 5%% [2J");
  expect(line).not.toMatch(/\p{Cc}/u);
});

test("the lead has no strip, as the sidebar already shows what needs you", () => {
  const rows = [lead, thread({ word: "approved", needsYou: true })];
  expect(read({ rows, shown: "lead" })).toBe("");
});

test("an agent that isn't listed has no strip", () => {
  expect(read({ rows: [lead], shown: "gone" })).toBe("");
  expect(read({ rows: [lead], shown: null })).toBe("");
});

test("a title can't run commands or restyle the row, as tmux reads it as a format", () => {
  const title = "#(touch /tmp/pwned) #[fg=red] #{pane_pid}";
  const line = top({ rows: [thread({ title, review: null })] });
  expect(line).toContain("##(touch /tmp/pwned) ##[fg=red] ##{pane_pid}");
});

test("a review can't run commands or restyle the row either", () => {
  const review = { round: 1, reviewer: "#(id) 5%", verdict: "#[fg=red]" };
  expect(top({ rows: [thread({ review })] })).toContain("##(id) 5%% · ##[fg=red]");
});

test("a title or review can't reach your terminal with control codes", () => {
  const review = { round: 1, reviewer: "co\x1b]2;owned\x07dex", verdict: "chan\tges" };
  const line = top({ rows: [thread({ title: "x\x1b[2Jy\r\nz", review })] });
  expect(line).not.toMatch(/\p{Cc}/u);
  expect(read({ rows: [thread({ title: "x\x1b[2Jy", review })] })).toContain("x [2Jy");
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
// The strip while a page shows, as you see it.
const aboutPage = (page: Link, room = 90) => read({ shown: page.url, page }, roomFor(room));

test("while a page shows, the strip has the row's name and title", () => {
  expect(aboutPage(issue)).toBe("app-31  Add CSV export");
  expect(top({ shown: issue.url, page: issue })).toContain("#[fg=brightblack,bold]app-31#[nobold]");
});

test("a page's long title is cut to the strip", () => {
  const long = aboutPage({ ...issue, title: "word ".repeat(40) }, 30);
  expect(Bun.stringWidth(long)).toBeLessThanOrEqual(30);
  expect(long).toEndWith("…");
});

test("what a page's title says is shown, never run or read as a format", () => {
  const page = { ...issue, title: "#(touch owned) 100%\x1b[31m" };
  const line = top({ shown: page.url, page });
  expect(line).toContain("##(touch owned) 100%%");
  expect(line).not.toContain("\x1b");
});

// The tabs as you read them: tmux's styles and click ranges left out, and the strip too.
const tabText = (tabs: Tab[], open: string, width: number) =>
  seen(top({ tabs, open, shown: "lead" }, { left: 30, width }))
    .slice(30)
    .trimEnd();

test("tabs name each repository in order, above the agent, with a badge for what needs you", () => {
  const tabs = [tab("app"), tab("site", 1)];
  expect(tabText(tabs, "simon/app", 120)).toBe("  app    site •1");
  // Tabs have greys of their own, apart from the rest of the screen: the open one is bold white
  // on a dark grey, the others dim on a lighter grey, and the badge yellow.
  const line = top({ tabs, shown: "lead" });
  expect(line).toContain("#[bg=colour234,fg=colour231,bold]  app  #[default]");
  expect(line).toContain("#[bg=colour237,fg=colour245]  site #[fg=yellow]•1  #[default]");
  expect(top({ tabs, open: "simon/site" })).toContain(
    "#[bg=colour234,fg=colour231,bold]  site #[fg=colour221]•1  #[default]",
  );
});

test("a click on a tab is told apart by its place in the row", () => {
  const line = top({ tabs: [tab("app"), tab("site")] });
  expect(line).toContain("#[range=user|0]");
  expect(line).toContain("#[range=user|1]");
});

test("the row is there with one repository too, so nothing moves when a second comes", () => {
  expect(tabText([tab("app")], "simon/app", 120)).toBe("  app");
});

test("tabs furthest from the open one give way first, and a dim count says how many", () => {
  const tabs = ["one", "two", "three", "four", "five", "six", "seven"].map((name) => tab(name));
  expect(tabText(tabs, "simon/four", 40)).toBe("  three    four    five    six    +3");
  expect(top({ tabs, open: "simon/four", shown: "lead" }, { left: 30, width: 40 })).toContain(
    "#[fg=brightblack]  +3",
  );
  expect(tabText(tabs, "simon/one", 40)).toBe("  one    two    three    four    +3");
});

test("a repository's name is shown, never read as a format", () => {
  const tabs = [tab("a#[fg=red]b")];
  expect(top({ tabs, open: "simon/a#[fg=red]b" })).toContain("  a##[fg=red]b  ");
});
