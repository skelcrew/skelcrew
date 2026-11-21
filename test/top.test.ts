// What the top row says: the header above the sidebar, then the tabs above the right side, set in
// the top of each side's box.
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
// Returns the top row as a tmux format, for the base with some of it changed.
const top = (more: Partial<Top> = {}, given = size) => drawTop({ ...base, ...more }, given);
// Returns a line as you see it, without tmux's styles. A ## is how tmux is told to show one #.
const seen = (line: string) => line.replace(/#\[[^\]]*\]/g, "").replaceAll("##", "#");
// What is above the sidebar's pane, without the line of its box around it.
const above = (more: Partial<Top> = {}, given = size) =>
  seen(top(more, given))
    .slice(2, 2 + given.sidebar)
    .replace(/^─ /, "")
    .replace(/ ─*$/, "");

// A sidebar wide enough for the version and a whole place after it.
const roomy = { sidebar: 37, right: 99 };

test("above the sidebar, Skelcrew in white in line with the marks, then dim a dot and where it runs", () => {
  const line = top({ where: "simon@workbox" }, roomy);
  expect(above({ where: "simon@workbox" }, roomy)).toBe("Skelcrew v0.1.0 · simon@workbox");
  expect(line).toContain("#[bold,fg=colour231]Skelcrew#[default]");
  expect(line).toContain("#[fg=brightblack] v0.1.0 · simon@workbox#[default]");
});

test("on this machine the header is Skelcrew and its version, with no dot and no place", () => {
  expect(above()).toBe("Skelcrew v0.1.0");
  expect(top()).not.toContain("·");
  expect(top()).toContain("#[fg=brightblack] v0.1.0#[default]");
});

test("the version shows dim right after the name, here and on a remote", () => {
  expect(above({ versions: ["v0.4.2"] })).toBe("Skelcrew v0.4.2");
  expect(top({ versions: ["v0.4.2"] })).toContain(
    "#[bold,fg=colour231]Skelcrew#[default]#[fg=brightblack] v0.4.2#[default]",
  );
  const there = { versions: ["v0.4.2"], where: "workbox" };
  expect(above(there, roomy)).toBe("Skelcrew v0.4.2 · workbox");
  expect(top(there, roomy)).toContain("#[fg=brightblack] v0.4.2 · workbox#[default]");
});

test("the place is cut before the version, which stays whole", () => {
  const where = "simon@a-very-long-server-name.example.com";
  expect(above({ where, versions: ["v0.4.2"] })).toBe("Skelcrew v0.4.2 · simon…");
});

test("with no room for both, the place goes first, and then the version, never half of it", () => {
  const line = (sidebar: number) =>
    above({ where: "workbox", versions: ["v0.4.2"] }, { sidebar, right: 40 });
  expect(line(22)).toBe("Skelcrew v0.4.2 · …");
  expect(line(21)).toBe("Skelcrew v0.4.2");
  expect(line(18)).toBe("Skelcrew v0.4.2");
  expect(line(17)).toBe("Skelcrew");
  // Too narrow for the name, the sidebar's top is only its line.
  expect(seen(top({}, { sidebar: 10, right: 40 }))).toStartWith(`─┬${"─".repeat(10)}┬`);
});

test("a narrow sidebar shows the longest name of the version that fits", () => {
  const versions = ["6f1c2ab* (checkout, * = uncommitted changes)", "checkout 6f1c2ab+changes"];
  const wide = { sidebar: 58, right: 99 };
  expect(above({ versions }, wide)).toBe("Skelcrew 6f1c2ab* (checkout, * = uncommitted changes)");
  // A sidebar's pane 36 columns wide.
  const usual = { sidebar: 36, right: 99 };
  expect(above({ versions }, usual)).toBe("Skelcrew checkout 6f1c2ab+changes");
  expect(above({ versions }, { sidebar: 35, right: 99 })).toBe("Skelcrew");
});

test("the row is the top of both boxes, with a corner over each of tmux's lines, and the tabs start where the right side does", () => {
  for (const more of [
    {},
    { where: "simon@a-very-long-server-name.example.com", versions: ["v0.4.2"] },
  ]) {
    const line = seen(top(more));
    // Two columns at the left, the sidebar, the line the sides share, the right side, and two
    // columns at the right.
    expect(line).toHaveLength(2 + size.sidebar + 1 + size.right + 2);
    expect(line).toStartWith("─┬─ Skelcrew");
    expect(line[size.sidebar + 2]).toBe("┬");
    expect(line).toEndWith("─┬─");
    expect(line.indexOf("app")).toBe(size.sidebar + 3 + 2);
  }
});

test("the box your typing goes to is lit, the line the sides share always, and the rest dim", () => {
  const [lit, dim] = ["#[fg=colour33]", "#[fg=brightblack]"];
  const toRight = top();
  expect(toRight).toStartWith(`${dim}─#[default]${dim}┬#[default]${dim}─ #[default]`);
  expect(toRight).toContain(`${lit}┬#[default]`);
  expect(toRight).toMatch(/#\[fg=colour33\]─+┬#\[default\]#\[fg=brightblack\]─#\[default\]$/);
  const toSidebar = top({ typingRight: false });
  expect(toSidebar).toStartWith(`${dim}─#[default]${lit}┬#[default]${lit}─ #[default]`);
  expect(toSidebar).toContain(`${lit}┬#[default]`);
  expect(toSidebar).toMatch(/#\[fg=brightblack\]─+┬#\[default\]#\[fg=brightblack\]─#\[default\]$/);
});

test("while the right side fills the terminal, the whole row is lit, with no corners", () => {
  const line = top({ fullScreen: true });
  expect(line).not.toContain("brightblack]─");
  expect(line).not.toContain("┬");
  expect(seen(line)).toHaveLength(2 + size.sidebar + 1 + size.right + 2);
  expect(seen(line)).toStartWith("─── Skelcrew");
});

test("where Skelcrew runs can't run commands, restyle the row or reach your terminal", () => {
  const line = top({ where: "#(id) 5%\x1b[2J" }, roomy);
  expect(line).toContain("##(id) 5%% [2J");
  expect(line).not.toMatch(/\p{Cc}/u);
});

// The tabs as you read them, with tmux's styles, click ranges and the box's line left out.
const tabText = (tabs: Tab[], open: string, width: number) =>
  seen(top({ tabs, open }, { sidebar: 28, right: width }))
    .slice(28 + 3)
    .replace(/─*┬─$/, "")
    .trimEnd();

test("tabs name each repository in order, above the right side, with a badge for what needs you", () => {
  const tabs = [tab("app"), tab("site", 1)];
  expect(tabText(tabs, "simon/app", 120)).toBe("  app    site •1");
  // Tabs have greys of their own, apart from the rest of the screen: the open one is bold white
  // on a dark grey, the others dim on a lighter grey, and the badge yellow.
  const line = top({ tabs });
  expect(line).toContain("#[bg=colour234,fg=colour231,bold]  app  #[default]");
  expect(line).toContain("#[bg=colour237,fg=colour245]  site #[fg=colour221]•1  #[default]");
  expect(top({ tabs, open: "simon/site" })).toContain(
    "#[bg=colour234,fg=colour231,bold]  site #[fg=colour221]•1  #[default]",
  );
});

test("a tab's badge counts what needs you and what is ready apart, each in its colour", () => {
  const red = top({ tabs: [tab("app"), tab("site", 2, 0, "red")] });
  expect(red).toContain("  site #[fg=colour210]•2  ");
  const ready = top({ tabs: [tab("app"), tab("site", 0, 1)] });
  expect(ready).toContain("  site #[fg=colour120]•1  ");
  const both = [tab("app"), tab("site", 2, 1)];
  expect(top({ tabs: both })).toContain("  site #[fg=colour221]•2 #[fg=colour120]•1  ");
  expect(tabText(both, "simon/app", 120)).toBe("  app    site •2 •1");
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
  expect(top({ tabs, open: "simon/four" }, { sidebar: 28, right: 40 })).toContain(
    "#[fg=brightblack]  +3",
  );
  expect(tabText(tabs, "simon/one", 40)).toBe("  one    two    three    four    +3");
});

test("an open tab too wide for the right side loses the count, then its spaces, then is cut with …", () => {
  const long = tab("a-repository-with-a-very-long-name", 2, 1);
  const open = "simon/a-repository-with-a-very-long-name";
  const narrow = { sidebar: 27, right: 20 };
  expect(seen(top({ tabs: [long], open }, narrow))).toContain("┬a-repository-with-…─┬─");
  expect(seen(top({ tabs: [long, tab("site")], open }, narrow))).toContain(
    "┬a-repository-with-…─┬─",
  );
  // One that fits only without the count shows whole, and the count goes.
  const fits = [tab("sixteen-letters!"), tab("site")];
  expect(
    seen(top({ tabs: fits, open: "simon/sixteen-letters!" }, { sidebar: 27, right: 21 })),
  ).toContain("┬  sixteen-letters!  ─┬─");
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

test("at every width the row is exactly as wide as the terminal, so the box's corner always shows", () => {
  for (const [tabs, open] of tabSets)
    for (let right = 1; right <= 80; right++)
      for (const sidebar of [1, 12, 27]) {
        for (const fullScreen of [false, true]) {
          const line = seen(top({ tabs, open, fullScreen }, { sidebar, right }));
          expect(line).toHaveLength(2 + sidebar + 1 + right + 2);
          expect(line.slice(-2)).toBe(fullScreen ? "──" : "┬─");
        }
      }
});

test("a repository's name is shown, never read as a format", () => {
  const tabs = [tab("a#[fg=red]b")];
  expect(top({ tabs, open: "simon/a#[fg=red]b" })).toContain("  a##[fg=red]b  ");
});
