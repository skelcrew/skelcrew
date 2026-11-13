// Where a key or a click in the sidebar lands: a row up or down, the first row of another part,
// or the row at a line. It reads nothing, so it can be tested without a terminal.
import { entryPlace, layout, type Size } from "./layout.ts";
import type { EntryCount } from "./lists.ts";
import type { Row } from "./rows.ts";

// A row you can move to, by its place: a session, or an entry's place. `open` says whether
// anything could show on the right.
type Stop = { place: string; open: boolean };

// Returns what you can move to, part by part, top to bottom: the lead, the entries, then every
// thread, as THREADS scrolls to keep you in view. The entries count only while the sidebar has
// room to show them.
function stops(rows: Row[], entries: EntryCount[], shown: string | null, size: Size): Stop[][] {
  // The lead and every row of THREADS are stops, open only while their agent runs. The lead has
  // no status of its own. An entry always has its list to show.
  const { lines } = layout(rows, entries, shown, size);
  const seen = entries
    .map((entry) => entryPlace(entry.entry))
    .filter((place) => lines.some((line) => line.place === place));
  const stop = (row: Row) => ({ place: row.session, open: row.running });
  return [
    rows.filter((row) => row.status === null).map(stop),
    seen.map((place) => ({ place, open: true })),
    rows.filter((row) => row.status !== null).map(stop),
  ];
}

// Returns what is one row up or down, for Alt-Up and Alt-Down, as a place, or null at either
// end. Rows whose agent isn't running are stepped over: nothing could show on the right. From a
// row that has gone, it goes to the lead.
export function nextRow(
  rows: Row[],
  entries: EntryCount[],
  shown: string | null,
  size: Size,
  by: 1 | -1,
): string | null {
  // All the stops in one run, top to bottom, and where you are in it.
  const all = stops(rows, entries, shown, size).flat();
  const here = all.findIndex((stop) => stop.place === shown);
  if (here === -1) return rows[0]?.session ?? null;
  // Walks the way asked to the first stop that can show something.
  for (let i = here + by; i >= 0 && i < all.length; i += by)
    if (all[i]?.open) return all[i]?.place ?? null;
  return null;
}

// Returns the first row of the part before or after the one you are in, for Alt-Shift-Up and
// Alt-Shift-Down: the lead, the entries or THREADS. It returns null past the first and last. A
// part with nothing to land on is passed over.
export function nextList(
  rows: Row[],
  entries: EntryCount[],
  shown: string | null,
  size: Size,
  by: 1 | -1,
): string | null {
  // A part counts when it has a row to land on, or holds the row you are on, so you can leave
  // a part whose agents aren't running but never land in one.
  const landable = stops(rows, entries, shown, size).filter(
    (part) => part.some((stop) => stop.open) || part.some((stop) => stop.place === shown),
  );
  // Lands on the first open row of the part next to yours.
  const here = landable.findIndex((part) => part.some((stop) => stop.place === shown));
  if (here === -1) return rows[0]?.session ?? null;
  return landable[here + by]?.find((stop) => stop.open)?.place ?? null;
}

// Returns what is at a line of the sidebar, counted from 0, for a click, as a place, or null
// when there is no row there or its agent isn't running. Any line of a row picks it.
export function rowAtLine(
  rows: Row[],
  entries: EntryCount[],
  shown: string | null,
  size: Size,
  y: number,
): string | null {
  // The line clicked, in the layout drawn now. An entry's line always picks it, and a row's
  // line its agent, only while that runs.
  const place = layout(rows, entries, shown, size).lines[y]?.place;
  const row = rows.find((candidate) => candidate.session === place);
  return row ? (row.running ? row.session : null) : (place ?? null);
}
