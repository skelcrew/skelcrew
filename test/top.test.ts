// What the top row says: the header above the sidebar, then the tabs above the right side.
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
const size = { left: 30, width: 99 };
const base: Top = {
  tabs: [tab("app")],
  open: "simon/app",
  where: "",
  versions: ["v0.1.0"],
  typingRight: true,
};
// Returns the top row as a tmux format, for the base with some of it changed.
const top = (more: Partial<Top> = {}, given = size) => drawTop({ ...base, ...more }, given);
// Returns a line as you see it, without tmux's styles. A ## is how tmux is told to show one #.
const seen = (line: string) => line.replace(/#\[[^\]]*\]/g, "").replaceAll("##", "#");
// What is above the sidebar, up to its edge.
const above = (more: Partial<Top> = {}, given = size) =>
  seen(top(more, given)).slice(0, given.left - 2);

// A sidebar wide enough for the version and a whole place after it.
const roomy = { left: 40, width: 99 };

test("above the sidebar, Skelcrew in white in line with the marks, then dim a dot and where it runs", () => {
  const line = top({ where: "simon@workbox" }, roomy);
  expect(above({ where: "simon@workbox" }, roomy)).toStartWith("  Skelcrew v0.1.0 · simon@workbox");
  expect(line).toContain("#[bold,fg=colour231]Skelcrew#[default]");
  expect(line).toContain("#[fg=brightblack] v0.1.0 · simon@workbox#[default]");
});

test("on this machine the header is Skelcrew and its version, with no dot and no place", () => {
  expect(above().trimEnd()).toBe("  Skelcrew v0.1.0");
  expect(top()).not.toContain("·");
  expect(top()).toContain("#[fg=brightblack] v0.1.0#[default]");
});

test("the version shows dim right after the name, here and on a remote", () => {
  expect(above({ versions: ["v0.4.2"] }).trimEnd()).toBe("  Skelcrew v0.4.2");
  expect(top({ versions: ["v0.4.2"] })).toContain(
    "#[bold,fg=colour231]Skelcrew#[default]#[fg=brightblack] v0.4.2#[default]",
  );
  const there = { versions: ["v0.4.2"], where: "workbox" };
  expect(above(there, roomy).trimEnd()).toBe("  Skelcrew v0.4.2 · workbox");
  expect(top(there, roomy)).toContain("#[fg=brightblack] v0.4.2 · workbox#[default]");
});

test("the place is cut before the version, which stays whole", () => {
  const where = "simon@a-very-long-server-name.example.com";
  expect(above({ where, versions: ["v0.4.2"] })).toBe("  Skelcrew v0.4.2 · simon…  ");
});

test("with no room for both, the place goes first, and then the version, never half of it", () => {
  const line = (left: number) =>
    above({ where: "workbox", versions: ["v0.4.2"] }, { left, width: 40 }).trimEnd();
  expect(line(25)).toBe("  Skelcrew v0.4.2 · …");
  expect(line(24)).toBe("  Skelcrew v0.4.2");
  expect(line(21)).toBe("  Skelcrew v0.4.2");
  expect(line(20)).toBe("  Skelcrew");
});

test("a narrow sidebar shows the longest name of the version that fits", () => {
  const versions = ["6f1c2ab* (checkout, * = uncommitted changes)", "checkout 6f1c2ab+changes"];
  const wide = { left: 60, width: 99 };
  expect(above({ versions }, wide).trimEnd()).toBe(
    "  Skelcrew 6f1c2ab* (checkout, * = uncommitted changes)",
  );
  // A sidebar 38 columns wide.
  const usual = { left: 39, width: 99 };
  expect(above({ versions }, usual).trimEnd()).toBe("  Skelcrew checkout 6f1c2ab+changes");
  expect(above({ versions }, { left: 38, width: 99 }).trimEnd()).toBe("  Skelcrew");
});

test("the sidebar's edge runs up through the row, leaning to where you type, and the tabs start where the right side does", () => {
  for (const more of [
    {},
    { where: "simon@a-very-long-server-name.example.com", versions: ["v0.4.2"] },
  ]) {
    const line = seen(top(more));
    expect(line[size.left - 2]).toBe("▕");
    expect(line.indexOf("app")).toBe(size.left + 2);
  }
  expect(top()).toContain("#[fg=colour250]▕#[default]");
  expect(top({ typingRight: false })).toContain("#[fg=colour250]▏#[default]");
});

test("where Skelcrew runs can't run commands, restyle the row or reach your terminal", () => {
  const line = top({ where: "#(id) 5%\x1b[2J" }, roomy);
  expect(line).toContain("##(id) 5%% [2J");
  expect(line).not.toMatch(/\p{Cc}/u);
});

// The tabs as you read them, with tmux's styles and click ranges left out.
const tabText = (tabs: Tab[], open: string, width: number) =>
  seen(top({ tabs, open }, { left: 30, width }))
    .slice(30)
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
  expect(top({ tabs, open: "simon/four" }, { left: 30, width: 40 })).toContain(
    "#[fg=brightblack]  +3",
  );
  expect(tabText(tabs, "simon/one", 40)).toBe("  one    two    three    four    +3");
});

test("a repository's name is shown, never read as a format", () => {
  const tabs = [tab("a#[fg=red]b")];
  expect(top({ tabs, open: "simon/a#[fg=red]b" })).toContain("  a##[fg=red]b  ");
});
