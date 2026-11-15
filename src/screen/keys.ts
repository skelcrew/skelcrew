// The list of keys: every key the screen has, which the footer shows above itself and sc --help
// lists, from this one place so the two never disagree.
import { pad } from "./look.ts";

// Each key in words and what it does, read as "alt + b to go back". The keys for anywhere come
// first, then those for lists, then those for pages. s and m work on a list and on a page opened
// from it, so they sit between the two. There are no headings, so each says where it works.
// Ctrl-Q leaves too, but isn't listed: it is there for a Mac terminal that doesn't send Option
// as Alt.
export const keys: [string, string][] = [
  ["alt + ↑/↓", "move in the sidebar"],
  ["alt + shift + ↑/↓", "jump a part"],
  ["alt + ←/→", "switch repository"],
  ["alt + shift + ←/→", "switch too"],
  ["alt + b", "go back"],
  ["alt + q", "quit, agents run on"],
  ["↑/↓", "move in a list"],
  ["enter/→", "open a row"],
  ["?", "show or hide these keys"],
  ["s", "start a thread on an issue"],
  ["m", "merge a ready PR"],
  ["↑/↓", "scroll a page"],
  ["←", "go back from a page"],
];

// The columns between two columns of keys.
const gap = "    ";

// Returns the keys as rows for a screen `width` columns wide: in as many columns side by side as
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
