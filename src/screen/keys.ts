// The list of keys: every key the screen has, in the groups both the box over the screen and
// sc --help show, so the two never disagree, and the program that runs in that box.
import { grey, pad, paint } from "./look.ts";

// Each group's heading and its lines of a key, written as the sidebar writes keys, and what it
// does.
export const keyGroups: [string, [string, string][]][] = [
  [
    "Anywhere",
    [
      ["⌥↑↓", "Move a row in the sidebar"],
      ["⌥⇧↑↓", "Jump to the lead, the lists or the threads"],
      ["⌥←→", "Switch to the repository before or after"],
      ["⌥⇧←→", "The same, where ⌥←→ jumps words"],
      ["⌥B", "Go back"],
      ["⌥/", "Show the list of keys"],
      ["⌥Q", "Leave the screen, with your agents still running"],
    ],
  ],
  [
    "Lists",
    [
      ["↑↓", "Move a row"],
      ["⏎", "Open the row"],
      ["?", "Show the list of keys"],
    ],
  ],
  [
    "Pages",
    [
      ["↑↓", "Scroll"],
      ["←", "Go back to the list"],
      ["?", "Show the list of keys"],
    ],
  ],
];

// Returns the list of keys as the lines of its box: each group's heading, dim, over its keys,
// with a blank line around each group. Every key takes as many columns as the widest, so what
// they do lines up, and every line has the padding on its right too.
export function keyLines(): string[] {
  const keys = keyGroups.flatMap(([, list]) => list.map(([key]) => key));
  const width = Math.max(...keys.map((key) => Bun.stringWidth(key))) + 2;
  const lines = [""];
  for (const [heading, list] of keyGroups) {
    lines.push(paint(grey, `${pad}${heading}`));
    for (const [key, what] of list)
      lines.push(`${pad}${key}${" ".repeat(width - Bun.stringWidth(key))}${what}${pad}`);
    lines.push("");
  }
  return lines;
}

// What the box reads: a mouse report, with its button and whether it is a press, Up or Down,
// q, and Esc on its own, which tmux sends a moment after the key, to tell it from the start of
// another.
const esc = "\x1b";
const input = new RegExp(
  `${esc}\\[<(\\d+);\\d+;\\d+([Mm])|${esc}[[O]([AB])|(q)|(${esc})(?![[O])`,
  "g",
);

// Shows the list of keys in the box tmux opened over the screen, until Esc, q or a click
// closes it. The box takes every key while it is open, so none reaches the agent. A box cut
// short by a short terminal scrolls with Up and Down. Ending closes the box, as tmux opened it
// to close when this ends.
export async function runKeys(): Promise<void> {
  const lines = keyLines();
  let top = 0;
  // Draws the lines from `top` down, as many as fit, with the scroll kept inside the list.
  const draw = () => {
    const height = process.stdout.rows || lines.length;
    top = Math.min(Math.max(top, 0), Math.max(lines.length - height, 0));
    const shown = lines.slice(top, top + height);
    process.stdout.write(`\x1b[H${shown.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
  };
  process.stdin.setRawMode(true);
  // The cursor is hidden, clicks are asked for, and a line too long for a narrow box is cut, not
  // wrapped, as wrapped lines would throw the scrolling off.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?7l");
  process.stdin.on("data", (bytes) => {
    for (const [, button, press, arrow, quit, alone] of bytes.toString().matchAll(input)) {
      // A press of any button closes the box, but not the wheel, whose buttons are 64 and up.
      const click = press === "M" && Number(button) < 64;
      if (quit || alone || click) process.exit(0);
      if (arrow) {
        top += arrow === "A" ? -1 : 1;
        draw();
      }
    }
  });
  process.on("SIGWINCH", draw);
  draw();
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
