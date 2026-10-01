// Which part of a body taller than the screen shows.

import type { TaskId } from "../core/ids";
import type { Line } from "./list";

// How a body scrolls:
// - the list keeps the task under the cursor in view, moving as little
//   as it can from where it was, `previous`;
// - a task's screen shows from the line `top` that j and k move;
// - the list of keys and the projects screen show their top.
export type Scrolling =
  | { kind: "cursor"; selected: TaskId | undefined; previous: number }
  | { kind: "lines"; top: number }
  | { kind: "top" };

// What shows of a body in `room` lines. A body that fits shows whole, with
// no lines above or below it. One taller keeps its first and last lines to
// say what is hidden: tasks on the list, such as "↓ 25 more", and lines
// elsewhere, such as "↑ 3 more lines". A line with nothing to say is "".
// `first` is the first line shown, and `lastTop` how far `top` can go.
export function scrollWindow(
  body: Line[],
  room: number,
  scrolling: Scrolling,
): { shown: Line[]; above: string | null; under: string | null; first: number; lastTop: number } {
  if (body.length <= room) {
    return { shown: body, above: null, under: null, first: 0, lastTop: 0 };
  }
  const fits = Math.max(1, room - 2);
  let first = 0;
  let lastTop = 0;
  let hiddenAbove = "";
  let hiddenBelow = "";
  if (scrolling.kind === "top") {
    hiddenBelow = more(body.length - fits, "line");
  } else if (scrolling.kind === "cursor") {
    const cursorLine = Math.max(
      0,
      body.findIndex((line) => line.kind === "row" && line.row.task.task === scrolling.selected),
    );
    // A group's first task shows with the blank line and heading above it.
    const top = body[cursorLine - 1]?.kind === "heading" ? cursorLine - 2 : cursorLine;
    first = firstShown(scrolling.previous, top, cursorLine, fits, body.length);
    const rows = (lines: Line[]) => lines.filter((line) => line.kind === "row").length;
    hiddenAbove = more(rows(body.slice(0, first)), "");
    hiddenBelow = more(rows(body.slice(first + fits)), "");
  } else {
    lastTop = body.length - fits;
    first = Math.min(scrolling.top, lastTop);
    hiddenAbove = more(first, "line");
    hiddenBelow = more(body.length - fits - first, "line");
  }
  return {
    shown: body.slice(first, first + fits),
    above: hiddenAbove === "" ? "" : `↑ ${hiddenAbove}`,
    under: hiddenBelow === "" ? "" : `↓ ${hiddenBelow}`,
    first,
    lastTop,
  };
}

// The first line to show, so that lines `from` to `to` are in view, such
// as the cursor's line and its group's heading above it. It moves as
// little as it can from where the list was, so the list doesn't jump.
// `shown` is how many lines fit, and `total` how many there are.
//
// For example, with 7 lines shown from line 0, moving the cursor to line 7
// shows from line 1.
export function firstShown(
  previous: number,
  from: number,
  to: number,
  shown: number,
  total: number,
): number {
  const inView = Math.min(Math.max(previous, to - shown + 1), from);
  return Math.min(Math.max(inView, 0), Math.max(total - shown, 0));
}

// "25 more", or "3 more lines" when `unit` is "line". "" when none.
function more(count: number, unit: "" | "line"): string {
  if (count === 0) return "";
  if (unit === "") return `${count} more`;
  return `${count} more ${count === 1 ? "line" : "lines"}`;
}
