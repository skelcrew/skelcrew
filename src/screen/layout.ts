// The sidebar as lines for its pane: the lead's row on top, then the entries Issues, Threads and
// PRs, then THREADS, and the keys at the bottom. It reads nothing, so what you see can be tested
// without a terminal.
import type { Entry, EntryCount } from "./lists.ts";
import {
  edge,
  filled,
  fitted,
  grey,
  pad,
  paint,
  removeControlCodes,
  shaded,
  tinted,
  white,
  yellow,
} from "./look.ts";
import { needing, type Row, threadMark } from "./rows.ts";

export type Size = { width: number; height: number };
// One line of the sidebar, with where a click on it goes, if anywhere: a row's session or an
// entry's place. A line that `joins` the sidebar's edge runs into it, as the lines between the
// parts do.
type Line = { text: string; place?: string; joins?: boolean };

// Where a name starts, past its mark.
const indent = `${pad}  `;
// How many lines a row of the lead or THREADS takes.
const rowHeight = 2;

// Returns how many columns a thread's title has in a sidebar `width` columns wide: what is left
// once the line at its edge, the mark and the padding on each side are taken. sc ps cuts a title
// to the same room, so it reads as the sidebar shows it.
export const titleRoom = (width: number) => Math.max(width - 1 - indent.length - pad.length, 0);
// The keys you need most, at the bottom of the sidebar. The others are in Skelcrew's help.
const hints = [`${pad}⌥↑↓ move`, `${pad}⌃Q quit`];

// Returns the place that names an entry where the sidebar names a row by its session. tmux
// changes a : in a session's name, so no session can be named so.
export const entryPlace = (entry: Entry) => `:${entry}`;

// Returns one row as two lines, each cut with … to stop at the padding. A thread's first line
// is a mark and its short title, or its title when the lead gave it none, and its second, dim,
// is its name, word, harness and running time. The name and word come first, so they are the
// last to be cut. The lead's row has its name on top and no name below. An agent that isn't
// running is dim, as it can't be picked. The one you are looking at is shaded across the whole
// width, on both lines. `width` leaves out the line at the sidebar's edge.
function rowLines(row: Row, here: boolean, width: number): string[] {
  // The short title and title come from an agent and from outside, so they are made safe. A
  // thread from before Skelcrew kept titles has only its name to show.
  const room = titleRoom(width + 1);
  const lead = row.status === null;
  const heading = lead ? row.name : removeControlCodes(row.short ?? row.title ?? row.name);
  const top = fitted(heading, room);
  const styled = here ? paint(white, top) : row.running ? top : paint(grey, top);
  // The second line is cut as a whole, then split back into the name, the word and the rest,
  // so each keeps its colour. The word is yellow when the thread needs you. Names, words and
  // harnesses are plain letters, so a split by letters is a split by columns.
  const name = lead ? "" : `${row.name} · `;
  const after = [row.harness, row.age].flatMap((part) => (part ? [` · ${part}`] : [])).join("");
  const below = fitted(`${name}${row.word}${after}`, room);
  const parts: [string, string][] = [
    [grey, below.slice(0, name.length)],
    [needing(row) ? yellow : grey, below.slice(name.length, name.length + row.word.length)],
    [grey, below.slice(name.length + row.word.length)],
  ];
  const [sign, colour] = threadMark(row);
  const lines = [
    `${pad}${tinted(here, colour, sign)} ${styled}`,
    `${indent}${parts.map(([code, text]) => (text ? tinted(here, code, text) : "")).join("")}`,
  ];
  return here ? lines.map((line) => shaded(line, width)) : lines;
}

// Returns an entry as one line: its name where a thread's title starts, and at the end, dim,
// how many its list has, after its note, such as 4 new · 12. A note on what needs you is
// yellow. The entry you are on is shaded across the whole width.
function entryLine(entry: EntryCount, here: boolean, width: number): string {
  // The count stops at the padding before the edge, and the name gives way to it.
  const count = `${entry.note && " · "}${entry.total}`;
  const end = `${entry.note}${count}`;
  const name = fitted(entry.name, Math.max(width - indent.length - pad.length - end.length - 1, 0));
  const gap = " ".repeat(
    Math.max(width - indent.length - name.length - end.length - pad.length, 1),
  );
  const note = entry.note ? tinted(here, entry.warn ? yellow : grey, entry.note) : "";
  const line = `${indent}${here ? paint(white, name) : name}${gap}${note}${tinted(here, grey, count)}`;
  return here ? shaded(line, width) : line;
}

// Returns lines with blank ones added, out to a height.
const padded = (lines: Line[], height: number) => [
  ...lines,
  ...Array<Line>(height - lines.length).fill({ text: "" }),
];

// Returns what fits of the threads in a number of lines, by whole rows from the top, just far
// enough down to keep the row you are looking at in view, so Alt-Down never moves off the bottom.
function scrolled(blocks: Line[][], here: number, room: number): Line[] {
  // Starts with every row down to yours, then drops rows from the top until that fits.
  let used = blocks.slice(0, here + 1).flat().length;
  let first = 0;
  while (first < here && used > room) {
    used -= blocks[first]?.length ?? 0;
    first++;
  }
  return blocks.slice(first).flat().slice(0, room);
}

// Returns the lines above the hints, and how many there can be. The hints take the bottom lines
// unless that leaves no room for the whole row you are looking at. Then they give way, as the
// rows are what you pick from and the keys are also in Skelcrew's help.
// The lead's row comes first, then the entries, then THREADS, which has the rest of the height
// and scrolls in it. A terminal may be too short for the lead, the entries, THREADS' heading and
// the row you are on. Then the entries and the heading go, and the lead and the threads fill the
// sidebar with no heading, as they are what you move through.
export function layout(
  rows: Row[],
  entries: EntryCount[],
  shown: string | null,
  size: Size,
): { lines: Line[]; room: number } {
  // A blank line comes first, so the lead's row, grey when you look at it, doesn't touch the
  // header above the sidebar and read as part of it. Clicks find rows in these same lines. Like
  // the hints, it gives way on a sidebar too short for it and the whole row you are looking at,
  // which is two lines.
  if (size.height <= rowHeight) return layoutBelowBlank(rows, entries, shown, size);
  const below = layoutBelowBlank(rows, entries, shown, { ...size, height: size.height - 1 });
  return { lines: [{ text: "" }, ...below.lines], room: below.room + 1 };
}

// Lays out the lines below the blank line at the sidebar's top, as layout describes.
function layoutBelowBlank(
  rows: Row[],
  entries: EntryCount[],
  shown: string | null,
  size: Size,
): { lines: Line[]; room: number } {
  // Every row's lines. The hints keep the bottom lines only while the row you are looking at
  // still fits above them.
  const width = size.width - 1;
  const linesOf = (row: Row) =>
    rowLines(row, row.session === shown, width).map((text) => ({ text, place: row.session }));
  const blocks = rows.map(linesOf);
  const here = rows.findIndex((row) => row.session === shown);
  const room = size.height >= rowHeight + hints.length ? size.height - hints.length : size.height;
  // The lead is the row with no status of its own, and THREADS has the rest.
  const lead = rows.filter((row) => row.status === null).flatMap(linesOf);
  const threads = rows.filter((row) => row.status !== null);
  const shownThread = threads.findIndex((row) => row.session === shown);
  const divider = { text: paint(edge, "─".repeat(Math.max(width, 0))), joins: true };
  const heading = threads.length > 0 ? [{ text: paint(grey, `${pad}Threads`) }, { text: "" }] : [];
  const top: Line[] = [
    ...lead,
    ...(lead.length > 0 && entries.length > 0 ? [divider] : []),
    ...entries.map((entry) => {
      const place = entryPlace(entry.entry);
      return { text: entryLine(entry, place === shown, width), place };
    }),
    ...(heading.length > 0 ? [divider, ...heading] : []),
  ];
  // Too short for all of that and the row you are on, or a row when you are on none of them:
  // the lead and the threads alone.
  const left = room - top.length;
  if (left < (threads.length > 0 ? rowHeight : 0))
    return { lines: scrolled(blocks, here, room), room };
  const below = scrolled(threads.map(linesOf), Math.max(shownThread, 0), left);
  return { lines: [...top, ...below], room };
}

// Returns the whole sidebar as lines, given the rows, the entries, what is on the right, as a
// row's session or an entry's place, and the sidebar's size. It reads nothing, so what you see
// can be tested without a terminal. Every line fills the pane and ends with the sidebar's edge,
// in the last column. tmux's own border beside it is blank, which leaves a gap before the agent.
export function draw(rows: Row[], entries: EntryCount[], shown: string | null, size: Size): string {
  // The hints are cut to the sidebar's width, and come below the rest only when the layout left
  // room for them.
  const { lines, room } = layout(rows, entries, shown, size);
  const width = size.width - 1;
  const keys = hints.map((hint) => ({
    text: paint(grey, hint.slice(0, Math.max(width - pad.length, 0))),
  }));
  const all: Line[] = [...padded(lines, room), ...(room < size.height ? keys : [])];
  // Each line is filled out to the edge, which a divider meets with a ┤.
  return all
    .map(({ text, joins }) => `${filled(text, width)}${paint(edge, joins ? "┤" : "│")}`)
    .join("\n");
}

// Returns the lines that go above the rest of the sidebar for a notice, such as a release installed in the
// background, or none without one. Cut at words to fit a sidebar `width` columns wide, and
// parted from what follows by a blank line. Each fills the pane and ends with the sidebar's edge.
export function noticeLines(notice: string, width: number): string[] {
  if (!notice) return [];
  const room = Math.max(width - 1 - 2 * pad.length, 1);
  // A word goes on the last line while it fits, and starts a new one when it doesn't. A word
  // longer than a whole line has one to itself.
  const lines = [""];
  for (const word of notice.split(" ")) {
    const last = lines.length - 1;
    const longer = lines[last] ? `${lines[last]} ${word}` : word;
    if (Bun.stringWidth(longer) <= room || !lines[last]) lines[last] = longer;
    else lines.push(word);
  }
  // Each line is padded, a blank one follows, and all of them end at the sidebar's edge.
  return [...lines.map((line) => `${pad}${line}`), ""].map(
    (line) => `${filled(line, width - 1)}${paint(edge, "│")}`,
  );
}
