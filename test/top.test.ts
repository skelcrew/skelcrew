// What the top rows say: the header across the whole width, with Skelcrew, its version and the
// tabs, then the top of each side's box under it.
import { expect, test } from "bun:test";
import type { Tab } from "../src/list/rows.ts";
import { drawTop, type Top } from "../src/screen/top.ts";

// A tab with how many threads need you, how many are ready, and the colour of the first.
const tab = (name: string, needYou = 0, ready = 0, colour: Tab["colour"] = "yellow"): Tab => ({
  name,
  fullName: `simon/${name}`,
  needYou,
  colour,
  ready,
});
const size = { sidebar: 27, right: 99 };
const base: Top = {
  tabs: [tab("app")],
  open: "simon/app",
  where: "",
  versions: ["v0.1.0"],
  typingRight: true,
  fullScreen: false,
};
// Returns the header and the boxes' row as tmux formats, for the base with some of it changed.
const top = (more: Partial<Top> = {}, given = size) => drawTop({ ...base, ...more }, given);
// Returns the header row as a tmux format.
const headerRow = (more: Partial<Top> = {}, given = size) => top(more, given).header;
// Returns the boxes' row as a tmux format.
const boxRow = (more: Partial<Top> = {}, given = size) => top(more, given).boxes;
// Returns a line as you see it, without tmux's styles. A ## is how tmux is told to show one #.
const seen = (line: string) => line.replace(/#\[[^\]]*\]/g, "").replaceAll("##", "#");
// What the header says before the tabs, over the sidebar and the lines beside it.
const above = (more: Partial<Top> = {}, given = size) =>
  seen(headerRow(more, given))
    .slice(0, given.sidebar + 3)
    .trim();
// How wide the terminal is, for the panes' widths: the two pads, the sidebar, the line the sides
// share, the right side, and the two lines at the outer edges.
const terminal = (given: { sidebar: number; right: number }) =>
  2 + given.sidebar + 1 + given.right + 2;

// A sidebar wide enough for the version and a whole place after it.
const roomy = { sidebar: 37, right: 99 };

test("the header says Skelcrew in white in line with the marks, then dim a dot and where it runs", () => {
  const line = headerRow({ where: "simon@workbox" }, roomy);
  expect(above({ where: "simon@workbox" }, roomy)).toBe("Skelcrew v0.1.0 · simon@workbox");
  expect(seen(line)).toStartWith("    Skelcrew");
  expect(line).toContain("#[bold,fg=colour231]Skelcrew#[default]");
  expect(line).toContain("#[fg=brightblack] v0.1.0 · simon@workbox#[default]");
});

test("on this machine the header is Skelcrew and its version, with no dot and no place", () => {
  expect(above()).toBe("Skelcrew v0.1.0");
  expect(headerRow()).not.toContain("·");
  expect(headerRow()).toContain("#[fg=brightblack] v0.1.0#[default]");
});

test("the version shows dim right after the name, here and on a remote", () => {
  expect(above({ versions: ["v0.4.2"] })).toBe("Skelcrew v0.4.2");
  expect(headerRow({ versions: ["v0.4.2"] })).toContain(
    "#[bold,fg=colour231]Skelcrew#[default]#[fg=brightblack] v0.4.2#[default]",
  );
  const there = { versions: ["v0.4.2"], where: "workbox" };
  expect(above(there, roomy)).toBe("Skelcrew v0.4.2 · workbox");
  expect(headerRow(there, roomy)).toContain("#[fg=brightblack] v0.4.2 · workbox#[default]");
});

test("the place is cut before the version, which stays whole", () => {
  const where = "simon@a-very-long-server-name.example.com";
  expect(above({ where, versions: ["v0.4.2"] })).toBe("Skelcrew v0.4.2 · simon@…");
});

test("with no room for both, the place goes first, and then the version, never half of it", () => {
  const line = (sidebar: number) =>
    above({ where: "workbox", versions: ["v0.4.2"] }, { sidebar, right: 40 });
  expect(line(21)).toBe("Skelcrew v0.4.2 · …");
  expect(line(20)).toBe("Skelcrew v0.4.2");
  expect(line(17)).toBe("Skelcrew v0.4.2");
  expect(line(16)).toBe("Skelcrew");
  // Too narrow for the name, the header has only the tabs.
  expect(seen(headerRow({}, { sidebar: 9, right: 40 }))).toStartWith(`${" ".repeat(12)}  app  `);
});

test("a narrow sidebar shows the longest name of the version that fits", () => {
  const versions = ["6f1c2ab* (checkout, * = uncommitted changes)", "checkout 6f1c2ab+changes"];
  const wide = { sidebar: 58, right: 99 };
  expect(above({ versions }, wide)).toBe("Skelcrew 6f1c2ab* (checkout, * = uncommitted changes)");
  const usual = { sidebar: 35, right: 99 };
  expect(above({ versions }, usual)).toBe("Skelcrew checkout 6f1c2ab+changes");
  expect(above({ versions }, { sidebar: 34, right: 99 })).toBe("Skelcrew");
});

test("the header has no lines of the boxes, and its tabs start where the right side does", () => {
  for (const more of [
    {},
    { where: "simon@a-very-long-server-name.example.com", versions: ["v0.4.2"] },
  ]) {
    const line = seen(headerRow(more));
    expect(line).toHaveLength(terminal(size));
    expect(line).not.toMatch(/[─┬│]/);
    expect(line.indexOf("app")).toBe(size.sidebar + 3 + 2);
  }
});

test("under the header, the boxes' row is whole, with a corner over each of tmux's lines", () => {
  const line = seen(boxRow({ where: "simon@workbox", tabs: [tab("app"), tab("site", 2)] }));
  // A stub at each outer edge, a corner over each line, and only line between.
  expect(line).toBe(`─┬${"─".repeat(size.sidebar)}┬${"─".repeat(size.right)}┬─`);
});

test("the box your typing goes to is lit, the line the sides share always, and the rest dim", () => {
  const [lit, dim] = ["#[fg=colour33]", "#[fg=brightblack]"];
  const toRight = boxRow();
  expect(toRight).toStartWith(`${dim}─#[default]${dim}┬─`);
  expect(toRight).toContain(`${lit}┬#[default]`);
  expect(toRight).toMatch(/#\[fg=colour33\]─+┬#\[default\]#\[fg=brightblack\]─#\[default\]$/);
  const toSidebar = boxRow({ typingRight: false });
  expect(toSidebar).toStartWith(`${dim}─#[default]${lit}┬─`);
  expect(toSidebar).toContain(`${lit}┬#[default]`);
  expect(toSidebar).toMatch(/#\[fg=brightblack\]─+┬#\[default\]#\[fg=brightblack\]─#\[default\]$/);
});

test("while the right side fills the terminal, the whole boxes' row is lit, with no corners", () => {
  const line = boxRow({ fullScreen: true });
  expect(line).not.toContain("brightblack");
  expect(seen(line)).toBe("─".repeat(terminal(size)));
  expect(above({ fullScreen: true })).toBe("Skelcrew v0.1.0");
});

test("where Skelcrew runs can't run commands, restyle the row or reach your terminal", () => {
  const line = headerRow({ where: "#(id) 5%\x1b[2J" }, roomy);
  expect(line).toContain("##(id) 5%% [2J");
  expect(line).not.toMatch(/\p{Cc}/u);
});

// The tabs as you read them, with tmux's styles and click ranges left out.
const tabText = (tabs: Tab[], open: string, width: number) =>
  seen(headerRow({ tabs, open }, { sidebar: 28, right: width }))
    .slice(28 + 3)
    .trimEnd();

test("tabs name each repository in order, after the header, with a badge for what needs you", () => {
  const tabs = [tab("app"), tab("site", 1)];
  expect(tabText(tabs, "simon/app", 120)).toBe("  app    site •1");
  // Tabs have greys of their own, apart from the rest of the screen: the open one is bold white
  // on a dark grey, the others dim on a lighter grey, and the badge yellow.
  const line = headerRow({ tabs });
  expect(line).toContain("#[bg=colour234,fg=colour231,bold]  app  #[default]");
  expect(line).toContain("#[bg=colour237,fg=colour245]  site #[fg=colour221]•1  #[default]");
  expect(headerRow({ tabs, open: "simon/site" })).toContain(
    "#[bg=colour234,fg=colour231,bold]  site #[fg=colour221]•1  #[default]",
  );
  // The tabs are on the header's row alone.
  expect(boxRow({ tabs })).not.toContain("site");
});

test("a tab's badge counts what needs you and what is ready apart, each in its colour", () => {
  const red = headerRow({ tabs: [tab("app"), tab("site", 2, 0, "red")] });
  expect(red).toContain("  site #[fg=colour210]•2  ");
  const ready = headerRow({ tabs: [tab("app"), tab("site", 0, 1)] });
  expect(ready).toContain("  site #[fg=colour120]•1  ");
  const both = [tab("app"), tab("site", 2, 1)];
  expect(headerRow({ tabs: both })).toContain("  site #[fg=colour221]•2 #[fg=colour120]•1  ");
  expect(tabText(both, "simon/app", 120)).toBe("  app    site •2 •1");
});

test("a click on a tab is told apart by its place in the row", () => {
  const line = headerRow({ tabs: [tab("app"), tab("site")] });
  expect(line).toContain("#[range=user|0]");
  expect(line).toContain("#[range=user|1]");
});

test("the row is there with one repository too, so nothing moves when a second comes", () => {
  expect(tabText([tab("app")], "simon/app", 120)).toBe("  app");
});

test("tabs furthest from the open one give way first, and a dim count says how many", () => {
  const tabs = ["one", "two", "three", "four", "five", "six", "seven"].map((name) => tab(name));
  expect(tabText(tabs, "simon/four", 37)).toBe("  three    four    five    six    +3");
  expect(headerRow({ tabs, open: "simon/four" }, { sidebar: 28, right: 37 })).toContain(
    "#[fg=brightblack]  +3",
  );
  expect(tabText(tabs, "simon/one", 37)).toBe("  one    two    three    four    +3");
});

test("an open tab too wide for the right side loses the count, then its spaces, then is cut with …", () => {
  const long = tab("a-repository-with-a-very-long-name", 2, 1);
  const open = "simon/a-repository-with-a-very-long-name";
  expect(tabText([long], open, 17)).toBe("a-repository-with-…");
  expect(tabText([long, tab("site")], open, 17)).toBe("a-repository-with-…");
  // One that fits only without the count shows whole, and the count goes.
  expect(tabText([tab("sixteen-letters!"), tab("site")], "simon/sixteen-letters!", 18)).toBe(
    "  sixteen-letters!",
  );
});

// The tab sets the widths test draws: one short tab, a long one with a badge, several with the
// open one in the middle, and many that need a count.
const tabSets: [Tab[], string][] = [
  [[tab("app")], "simon/app"],
  [
    [tab("a-repository-with-a-very-long-name", 12, 3, "red"), tab("site")],
    "simon/a-repository-with-a-very-long-name",
  ],
  [["one", "two", "three", "four", "five"].map((name) => tab(name, 1)), "simon/three"],
  [Array.from({ length: 12 }, (_, i) => tab(`repo-${i}`)), "simon/repo-0"],
];

test("at every width both rows are exactly as wide as the terminal, so the box's corner always shows", () => {
  for (const [tabs, open] of tabSets)
    for (let right = 1; right <= 80; right++)
      for (const sidebar of [1, 12, 27]) {
        for (const fullScreen of [false, true]) {
          const given = { sidebar, right };
          const { header, boxes } = top({ tabs, open, fullScreen }, given);
          expect(seen(header)).toHaveLength(terminal(given));
          expect(seen(boxes)).toHaveLength(terminal(given));
          expect(seen(boxes).slice(-2)).toBe(fullScreen ? "──" : "┬─");
        }
      }
});

test("a repository's name is shown, never read as a format", () => {
  const tabs = [tab("a#[fg=red]b")];
  expect(headerRow({ tabs, open: "simon/a#[fg=red]b" })).toContain("  a##[fg=red]b  ");
});
