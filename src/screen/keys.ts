// The list of keys: every key the screen has, which shows along the bottom of the right side and
// in sc --help, from this one place so the two never disagree, and the program that shows it.
import { grey, pad, paint } from "./look.ts";

// Each key in words and what it does, read as "alt + b to go back". The keys for anywhere come
// first, then those for lists, then those for pages. s and m work on a list and on a page opened
// from it, so they sit between the two. There are no headings, so each says where it works. Ctrl-Q leaves too, but isn't listed: it is there for a Mac terminal that doesn't
// send Option as Alt.
export const keys: [string, string][] = [
  ["alt + ↑/↓", "move in the sidebar"],
  ["alt + shift + ↑/↓", "jump a part"],
  ["alt + ←/→", "switch repository"],
  ["alt + shift + ←/→", "switch too"],
  ["alt + b", "go back"],
  ["alt + /", "show these keys"],
  ["alt + q", "quit, agents run on"],
  ["↑/↓", "move in a list"],
  ["enter/→", "open a row"],
  ["?", "show these keys on a list"],
  ["s", "start a thread on an issue"],
  ["m", "merge a ready PR"],
  ["↑/↓", "scroll a page"],
  ["←", "go back from a page"],
];

// The columns between two columns of keys.
const gap = "    ";

// Returns the keys as rows for a pane `width` columns wide: in as many columns side by side as
// the width holds, filled top to bottom, each as wide as its longest key. A pane too narrow for
// even one column gets one anyway, cut at its edge.
export function keyLines(width: number): string[] {
  const items = keys.map(([key, what]) => `${key} to ${what}`);
  // Tries the most columns first, and takes the first that fits between the padding.
  for (let count = items.length; count >= 1; count--) {
    const height = Math.ceil(items.length / count);
    const columns = Array.from({ length: Math.ceil(items.length / height) }, (_, at) =>
      items.slice(at * height, (at + 1) * height),
    );
    const widths = columns.map((column) =>
      Math.max(...column.map((item) => Bun.stringWidth(item))),
    );
    const total = widths.reduce((sum, wide) => sum + wide, 0) + gap.length * (widths.length - 1);
    if (count > 1 && total > width - 2 * pad.length) continue;
    // Each row takes its key from every column, padded out to the column's width.
    return Array.from({ length: height }, (_, row) =>
      columns
        .map((column, at) => {
          const item = column[row] ?? "";
          return `${item}${" ".repeat((widths[at] ?? 0) - Bun.stringWidth(item))}`;
        })
        .join(gap)
        .trimEnd(),
    ).map((line) => `${pad}${line}`);
  }
  return [];
}

// What the keys read: a mouse report, with its button and whether it is a press, Up or Down,
// q, ? or Alt-/, and Esc on its own, which tmux sends a moment after the key, to tell it from the
// start of another.
const esc = "\x1b";
const input = new RegExp(
  `${esc}\\[<(\\d+);\\d+;\\d+([Mm])|${esc}[[O]([AB])|(q|\\?|${esc}/)|(${esc})(?![[O/])`,
  "g",
);

// Shows the keys in the popup tmux opened along the bottom of the right side, under a thin line
// across it, until Esc, q, ?, Alt-/ or a click closes them. The popup takes every key while it
// is open, so none reaches the agent. Keys that don't fit its rows scroll with Up and Down.
// Ending closes the popup, as tmux opened it to close when this ends.
export async function runKeys(): Promise<void> {
  const lines = keyLines(process.stdout.columns || 80);
  let top = 0;
  // Draws the line, then the keys from `top` down, as many as fit, with the scroll kept inside
  // the list.
  const draw = () => {
    const width = process.stdout.columns || 80;
    const height = Math.max((process.stdout.rows || lines.length + 1) - 1, 1);
    top = Math.min(Math.max(top, 0), Math.max(lines.length - height, 0));
    const shown = [paint(grey, "─".repeat(width)), ...lines.slice(top, top + height)];
    const frame = shown.map((line, at) => `${at ? paint(grey, line) : line}\x1b[K`);
    process.stdout.write(`\x1b[H${frame.join("\r\n")}\x1b[J`);
  };
  process.stdin.setRawMode(true);
  // The cursor is hidden, clicks are asked for, and a line too long for a narrow pane is cut, not
  // wrapped, as wrapped lines would throw the scrolling off.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?7l");
  process.stdin.on("data", (bytes) => {
    for (const [, button, press, arrow, quit, alone] of bytes.toString().matchAll(input)) {
      // A press of any button closes the keys, but not the wheel, whose buttons are 64 and up.
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
