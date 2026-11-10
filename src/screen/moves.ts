// Where a key or a click in the sidebar lands: a row up or down, the first row of another
// list, or the row at a line. It reads nothing, so it can be tested without a terminal.
import { layout, type Size } from "./lists.ts";
import type { List, Lists, Row } from "./rows.ts";

// A row you can move to, by what names it: a thread's session or a link's url. `open` says
// whether anything could show on the right.
type Stop = { place: string; open: boolean };

// Returns what you can move to, list by list, top to bottom. Every thread counts, as THREADS
// scrolls to keep you in view. Of ISSUES and PRS only the rows on screen do, since they have
// no scrolling, and a row you can't see would be a page you can't place.
function stops(rows: Row[], lists: Lists, shown: string | null, size: Size): Stop[][] {
  // The layout says which rows of ISSUES and PRS are on screen now.
  const { lines } = layout(rows, lists, shown, size);
  // Returns the rows of a list that the sidebar shows.
  const seen = ({ links }: List) =>
    links
      .filter((link) => lines.some((line) => line.link === link))
      .map((link) => ({ place: link.url, open: true }));
  // Every row of THREADS is a stop, open only while its agent runs. The lists come in the order
  // the sidebar draws them: ISSUES above THREADS and PRS below, each only when it is there.
  const threads = rows.map((row) => ({ place: row.session, open: row.running }));
  return [
    ...(lists.issues ? [seen(lists.issues)] : []),
    threads,
    ...(lists.prs ? [seen(lists.prs)] : []),
  ];
}

// Returns what is one row up or down, for Alt-Up and Alt-Down, as a session or a link's url, or
// null at either end. Rows whose agent isn't running are stepped over: nothing could show on
// the right. From a row that has gone, it goes to the lead.
export function stepped(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
  by: 1 | -1,
): string | null {
  // All the stops in one run, top to bottom, and where you are in it.
  const all = stops(rows, lists, shown, size).flat();
  const here = all.findIndex((stop) => stop.place === shown);
  if (here === -1) return rows[0]?.session ?? null;
  // Walks the way asked to the first stop that can show something.
  for (let i = here + by; i >= 0 && i < all.length; i += by)
    if (all[i]?.open) return all[i]?.place ?? null;
  return null;
}

// Returns the first row of the list before or after the one you are in, for Alt-Shift-Up and
// Alt-Shift-Down, or null past the first and last. A list with nothing to land on is passed over.
export function jumped(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
  by: 1 | -1,
): string | null {
  // A list counts when it has a row to land on, or holds the row you are on, so you can leave
  // a list of stopped threads but never land in one.
  const landable = stops(rows, lists, shown, size).filter(
    (list) => list.some((stop) => stop.open) || list.some((stop) => stop.place === shown),
  );
  // Lands on the first open row of the list next to yours.
  const here = landable.findIndex((list) => list.some((stop) => stop.place === shown));
  if (here === -1) return rows[0]?.session ?? null;
  return landable[here + by]?.find((stop) => stop.open)?.place ?? null;
}

// Returns what is at a line of the sidebar, counted from 0, for a click, as a session or a
// link's url, or null when there is no row there or its agent isn't running. Any line of a row
// picks it. Your terminal opens a link on Cmd-click by itself, so a plain click is free for this.
export function picked(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
  y: number,
): string | null {
  // The line clicked, in the layout drawn now. A link's line opens its page, and a row's line its
  // agent, only while that runs.
  const line = layout(rows, lists, shown, size).lines[y];
  if (line?.link) return line.link.url;
  return line?.row?.running ? line.row.session : null;
}
