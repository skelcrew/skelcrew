// The screen fills the terminal: a blank line above and below, the header
// on the first line inside them, the keys on the last, and the list between
// them, scrolled to keep the cursor in view.

import { expect, test } from "bun:test";
import { KEYS, lines, loaded, open, task, tick } from "./testing";

const idea = task(16, "Keyboard help", "idea");
const specToApprove = task(14, "CSV export", "spec", { waitingOnYou: "spec_approval" });

// Ideas #1 to #30, more than a 14-line screen holds.
const ideas = Array.from({ length: 30 }, (_, i) => task(i + 1, `Idea ${i + 1}`, "idea"));

test("the screen is as tall as the terminal, with the keys on the last line", async () => {
  const { lastFrame } = open({ load: loaded([idea]), height: 20 });
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toHaveLength(20);
  expect(shown[0]).toBe("");
  expect(shown[1]).toBe("skelcrew ~/code/app");
  expect(shown.slice(2, 5)).toEqual(["", "Ideas", "› #16 Keyboard help Idea"]);
  expect(shown.slice(5, 17).every((line) => line === "")).toBe(true);
  expect(shown.slice(17)).toEqual(["", KEYS, ""]);
});

test("the text box sits just above the keys", async () => {
  const { lastFrame, stdin } = open({ load: loaded([idea]), height: 20 });
  await tick();
  stdin.write("a");
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toHaveLength(20);
  expect(shown.slice(15)).toEqual(["", "Add an idea:", "", KEYS, ""]);
});

test("what a command said sits just above the keys", async () => {
  const send = async () => ({ code: 0, out: ["Approved #14."], err: [] });
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), send, height: 20 });
  await tick();
  stdin.write("y");
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toHaveLength(20);
  expect(shown.slice(15)).toEqual(["", "Approved #14.", "", KEYS, ""]);
});

// 14 lines: a blank line, the header, 9 for the list, 2 for the keys, and a
// blank line. The list's first and last lines say how many tasks are hidden
// above and below.
test("a list taller than the screen shows its top, and how many tasks are below", async () => {
  const { lastFrame } = open({ load: loaded(ideas), height: 14 });
  await tick();
  expect(lines(lastFrame())).toEqual([
    "",
    "skelcrew ~/code/app",
    "",
    "",
    "Ideas",
    "› #1 Idea 1 Idea",
    "#2 Idea 2 Idea",
    "#3 Idea 3 Idea",
    "#4 Idea 4 Idea",
    "#5 Idea 5 Idea",
    "↓ 25 more",
    "",
    KEYS,
    "",
  ]);
});

test("moving past the last task shown scrolls the list by one", async () => {
  const { lastFrame, stdin } = open({ load: loaded(ideas), height: 14 });
  await tick();
  for (const _ of [1, 2, 3, 4, 5]) {
    stdin.write("j");
    await tick();
  }
  expect(lines(lastFrame()).slice(2, 11)).toEqual([
    "",
    "Ideas",
    "#1 Idea 1 Idea",
    "#2 Idea 2 Idea",
    "#3 Idea 3 Idea",
    "#4 Idea 4 Idea",
    "#5 Idea 5 Idea",
    "› #6 Idea 6 Idea",
    "↓ 24 more",
  ]);
});

test("G scrolls to the end, and g back to the top", async () => {
  const { lastFrame, stdin } = open({ load: loaded(ideas), height: 14 });
  await tick();
  stdin.write("G");
  await tick();
  expect(lines(lastFrame()).slice(2, 11)).toEqual([
    "↑ 23 more",
    "#24 Idea 24 Idea",
    "#25 Idea 25 Idea",
    "#26 Idea 26 Idea",
    "#27 Idea 27 Idea",
    "#28 Idea 28 Idea",
    "#29 Idea 29 Idea",
    "› #30 Idea 30 Idea",
    "",
  ]);
  stdin.write("g");
  await tick();
  expect(lines(lastFrame())[5]).toBe("› #1 Idea 1 Idea");
});

test("a long message is cut to the screen's width, so the keys stay on the last line", async () => {
  const send = async () => ({ code: 1, out: [], err: ["x".repeat(300)] });
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), send, height: 20 });
  await tick();
  stdin.write("y");
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toHaveLength(20);
  expect(shown.slice(18)).toEqual([KEYS, ""]);
});

test("a full screen has a blank line above and below, and two spaces on each side", async () => {
  const { lastFrame } = open({ load: loaded([idea]), height: 20 });
  await tick();
  const drawn = (lastFrame() ?? "").split("\n");
  expect(drawn).toHaveLength(20);
  expect(drawn[0]?.trim()).toBe("");
  expect(drawn[1]).toStartWith("  skelcrew  ~/code/app");
  expect(drawn[18]).toStartWith(`  ${KEYS}`);
  expect(drawn[19]?.trim()).toBe("");
  // The test screen is 100 columns wide, so nothing reaches past column 98.
  expect(drawn.every((line) => line.trimEnd().length <= 98)).toBe(true);
});
