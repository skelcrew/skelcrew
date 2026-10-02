// The logo, a small copy of skelcrew.dev's, sits at the top of the list
// when the window has room for it.

import { expect, test } from "bun:test";
import { KEYS, lines, loaded, open, task, tick } from "./testing";

const LOGO = [
  "▄▄▄▄ █  ▄ ▄▄▄▄ █ ▄▄▄▄ ▄▄▄▄ ▄▄▄▄ ▄    ▄",
  "█▄▄▄ █▄▀  █▄▄█ █ █    █  ▀ █▄▄█ █ ▄▄ █",
  "▄▄▄█ █ ▀▄ █▄▄▄ █ █▄▄▄ █    █▄▄▄ █▄██▄█",
];

const idea = task(16, "Keyboard help", "idea");
const ideas = Array.from({ length: 30 }, (_, i) => task(i + 1, `Idea ${i + 1}`, "idea"));

// The screen's lines as drawn, so the logo's spaces stay where they are.
function drawn(frame: string | undefined): string[] {
  return (frame ?? "").split("\n").map((line) => line.trimEnd());
}

test("a window 24 lines tall shows the logo above the list, and the header names only the repository", async () => {
  const { lastFrame } = open({ load: loaded([idea]), height: 24 });
  await tick();
  expect(drawn(lastFrame()).slice(0, 3)).toEqual(LOGO);
  const shown = lines(lastFrame());
  expect(shown).toHaveLength(24);
  expect(shown.slice(3, 7)).toEqual(["~/code/app", "", "Ideas", "› #16 Keyboard help Idea"]);
  expect(shown.slice(22)).toEqual(["", KEYS]);
});

test("a window 23 lines tall keeps the one-line header", async () => {
  const { lastFrame } = open({ load: loaded([idea]), height: 23 });
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toHaveLength(23);
  expect(shown.slice(0, 4)).toEqual([
    "skelcrew ~/code/app",
    "",
    "Ideas",
    "› #16 Keyboard help Idea",
  ]);
});

test("a screen with no height set shows no logo", async () => {
  const { lastFrame } = open({ load: loaded([idea]) });
  await tick();
  expect(lines(lastFrame())[0]).toBe("skelcrew ~/code/app");
});

test("the logo takes room from the list, so the keys stay on the last line", async () => {
  const { lastFrame } = open({ load: loaded(ideas), height: 24 });
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toHaveLength(24);
  // 24 lines: the logo, the header, 18 for the list, and 2 for the keys.
  expect(shown.slice(4, 8)).toEqual(["", "", "Ideas", "› #1 Idea 1 Idea"]);
  expect(shown[20]).toBe("#14 Idea 14 Idea");
  expect(shown[21]).toBe("↓ 16 more");
  expect(shown.slice(22)).toEqual(["", KEYS]);
});

test("a task's own screen, the keys and the projects screen show no logo", async () => {
  const { lastFrame, stdin } = open({ load: loaded([idea]), height: 24 });
  await tick();
  for (const { key, back } of [
    { key: "\r", back: "\u001b" },
    { key: "?", back: "?" },
    { key: "P", back: "\u001b" },
  ]) {
    stdin.write(key);
    await tick();
    expect(lastFrame()).not.toContain("▄▄▄▄ █  ▄");
    stdin.write(back);
    await tick();
    expect(drawn(lastFrame()).slice(0, 3)).toEqual(LOGO);
  }
});
