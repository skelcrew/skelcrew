// The sidebar as lines for its pane: the lead's row on top, then the entries Issues, Threads and
// PRs, then ACTIVE. It reads nothing, so what you see can be tested
// without a terminal.
import { markOf } from "../flow/marks.ts";
import type { Entry, EntryCount } from "./lists.ts";
import {
  edge,
  filled,
  fitted,
  grey,
  lightGrey,
  lightGreyOnShade,
  markColours,
  pad,
  paint,
  removeControlCodes,
  shaded,
  tinted,
  white,
} from "./look.ts";
import type { Row } from "./rows.ts";

export type Size = { width: number; height: number };
// One line of the sidebar, with where a click on it goes, if anywhere: a row's session or an
// entry's place. A line that `joins` the sidebar's edge runs into it, as the lines between the
// parts do.
type Line = { text: string; place?: string; joins?: boolean };

// Where a name starts, past its mark.
const indent = `${pad}  `;
// Returns whether a row is a thread whose word is working, which shows what its builder costs.
const working = (row: Row) => row.status !== null && row.word === "working";
// Returns how many lines a row of the lead or ACTIVE takes, or a row's at least for none. A
// thread with a step to show has a line more than others: its builder is working, perhaps while
// a review runs.
const rowHeight = (row: Row | undefined) => (row?.step ? 3 : 2);

// Returns a row's mark and the colour it is drawn in: the lead's diamond, dim, or a thread's
// mark as every list of threads shows it.
function rowMark(row: Row): [string, string] {
  if (row.status === null) return ["◆", grey];
  const { sign, colour } = markOf(row.state, row.word);
  return [sign, markColours[colour]];
}

// Returns how many columns a row's first line has for text in a sidebar `width` columns wide:
// what is left once the line at its edge, the mark and the padding on each side are taken. A
// thread's name and title share it. sc ps cuts a title to the same room, so it reads much as the
// sidebar shows it.
export const titleRoom = (width: number) => Math.max(width - 1 - indent.length - pad.length, 0);
// Returns the place that names an entry where the sidebar names a row by its session. tmux
// changes a : in a session's name, so no session can be named so.
export const entryPlace = (entry: Entry) => `:${entry}`;

// Returns one row as its lines, each cut with … to stop at the padding. A thread's first line is
// a mark, its name without its repository's, such as wr5, and its short title, or its title when
// the lead gave it none. A working thread has two more lines, in two greys so they read apart:
// what its builder has done, as workLine says, in a light grey, then the step it is on, dim, as
// it matters least, or in its place how many messages wait for the builder, which tells why one
// hasn't reached it. Any other thread has one more: its word, how many messages wait, its harness
// and its round, dim but the word, which takes its mark's colour so a green approved or a red
// error reads at a glance. The word comes first, so it is the last to be cut. A thread under
// review whose builder works meanwhile adds its builder's step below that, dim. The lead's row
// has its name on top and its word below. An agent that isn't running is dim, as it can't be
// picked. The one you are looking at is shaded across the whole width, on all its lines.
// `width` leaves out the line at the sidebar's edge.
function rowLines(row: Row, here: boolean, width: number): string[] {
  // The short title, title and step come from an agent and from outside, so they are made safe.
  // A thread from before Skelcrew kept titles has only its name to show.
  const room = titleRoom(width + 1);
  const lead = row.status === null;
  const title = lead ? row.name : removeControlCodes(row.short ?? row.title ?? row.name);
  const top = fitted(lead ? title : `${row.task} ${title}`, room);
  const styled = here ? paint(white, top) : row.running ? top : paint(grey, top);
  const [sign, colour] = rowMark(row);
  const first = `${pad}${tinted(here, colour, sign)} ${styled}`;
  // A working thread: what it costs in a light grey, then what it does, dim. Under review, its
  // word line says how many messages wait, so its step line has only the step.
  const light = here ? lightGreyOnShade : lightGrey;
  const stepLine = (text: string) => `${indent}${tinted(here, grey, fitted(text, room))}`;
  const step = removeControlCodes(row.step);
  const lines = working(row)
    ? [
        first,
        `${indent}${paint(light, fitted(workLine(row, room), room))}`,
        stepLine(row.waiting || step),
      ]
    : [first, wordLine(row, here, room), ...(step ? [stepLine(step)] : [])];
  return here ? lines.map((line) => shaded(line, width)) : lines;
}

// Returns the round of a thread's latest review, such as "round 2", or nothing before its first.
const roundText = (row: Row) => (row.review ? `round ${row.review.round}` : "");

// Returns a working thread's second line, without its colour, in `room` columns: its harness,
// its round once it has had a review, how long its builder has worked, its tokens, and how far
// through its plan it is, such as `claude · round 2 · 12m · 48k tok · ▰▰▰▱▱▱▱ 3/7`. Each is left
// out when the row has none. When the line is too long, the plan's bar goes first, then the
// harness, which the row's other lines don't need, then the plan's count. What is still too long
// is cut with … where it is drawn.
function workLine(row: Row, room: number): string {
  const line = (parts: string[]) => parts.filter((part) => part).join(" · ");
  const known = [roundText(row), row.age, row.tokens];
  const count = row.plan ? `${row.plan.done}/${row.plan.total}` : "";
  const bar = row.plan ? `${planBar(row.plan)} ${count}` : "";
  const tries = [
    line([row.harness, ...known, bar]),
    line([row.harness, ...known, count]),
    line([...known, count]),
    line(known),
  ];
  return tries.find((text) => Bun.stringWidth(text) <= room) ?? line(known);
}

// Returns a plan's progress as a bar, a filled cell for each step done and an empty one for each
// still to do, such as ▰▰▰▱▱▱▱ for 3 of 7. A plan of more than 10 steps is shown in 10 cells.
function planBar(plan: { done: number; total: number }): string {
  const cells = Math.min(plan.total, 10);
  const filled = plan.total === 0 ? 0 : Math.floor((plan.done / plan.total) * cells);
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

// Returns a row's line with its word, in its mark's colour, then how many messages wait, its
// harness and round, dim, cut as a whole to `room`. It is split back into the word and the rest
// after the cut, so each keeps its colour. These are all plain letters, so a split by letters is
// a split by columns.
function wordLine(row: Row, here: boolean, room: number): string {
  const [, colour] = rowMark(row);
  const parts = [row.word, row.waiting, row.harness, roundText(row)].filter((part) => part);
  const below = fitted(parts.join(" · "), room);
  const word = below.slice(0, row.word.length);
  const rest = below.slice(row.word.length);
  return `${indent}${tinted(here, colour, word)}${rest ? tinted(here, grey, rest) : ""}`;
}

// Returns an entry as one line: its name where a thread's title starts, and at the end, dim,
// how many its list has, after its notes, such as 2 ready · 5, each note in its own colour. The
// entry you are on is shaded across the whole width.
function entryLine(entry: EntryCount, here: boolean, width: number): string {
  // The count stops at the padding before the edge. When the notes leave too little room for
  // the whole name, the total gives way first, as the notes are what you act on: on Threads with
  // no forge, ready and need you both, such as 1 ready · 2 need you. Then the name gives way.
  const notes = entry.notes.map(([text]) => text).join(" · ");
  const room = width - indent.length - pad.length - 1;
  const whole = `${notes && " · "}${entry.total}`;
  const fits = Bun.stringWidth(`${entry.name}${notes}${whole}`) <= room;
  const count = notes && !fits ? "" : whole;
  const end = `${notes}${count}`;
  const name = fitted(entry.name, Math.max(width - indent.length - pad.length - end.length - 1, 0));
  const gap = " ".repeat(
    Math.max(width - indent.length - name.length - end.length - pad.length, 1),
  );
  // Each note is in its colour, with a dim dot between them.
  const note = entry.notes
    .map(([text, colour]) => tinted(here, colour, text))
    .join(tinted(here, grey, " · "));
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

// Returns the sidebar's lines, as many as its height holds at most.
// The lead's row comes first, then the entries, then ACTIVE, which has the rest of the height
// and scrolls in it. A terminal may be too short for the lead, the entries, ACTIVE's heading and
// the row you are on. Then the entries and the heading go, and the lead and the threads fill the
// sidebar with no heading, as they are what you move through.
export function layout(
  rows: Row[],
  entries: EntryCount[],
  shown: string | null,
  size: Size,
): Line[] {
  // A blank line comes first, so the lead's row, grey when you look at it, doesn't touch the
  // header above the sidebar and read as part of it. Clicks find rows in these same lines. It
  // gives way on a sidebar too short for it and the whole row you are looking at.
  if (size.height <= rowHeight(rows.find((row) => row.session === shown)))
    return layoutBelowBlank(rows, entries, shown, size);
  return [
    { text: "" },
    ...layoutBelowBlank(rows, entries, shown, { ...size, height: size.height - 1 }),
  ];
}

// Lays out the lines below the blank line at the sidebar's top, as layout describes.
function layoutBelowBlank(
  rows: Row[],
  entries: EntryCount[],
  shown: string | null,
  size: Size,
): Line[] {
  // Every row's lines.
  const width = size.width - 1;
  const linesOf = (row: Row) =>
    rowLines(row, row.session === shown, width).map((text) => ({ text, place: row.session }));
  const blocks = rows.map(linesOf);
  const here = rows.findIndex((row) => row.session === shown);
  // The lead is the row with no status of its own, and ACTIVE has the rest. Its heading says
  // Active, as Threads would repeat the entry above it.
  const lead = rows.filter((row) => row.status === null).flatMap(linesOf);
  const threads = rows.filter((row) => row.status !== null);
  const shownThread = threads.findIndex((row) => row.session === shown);
  const divider = { text: paint(edge, "─".repeat(Math.max(width, 0))), joins: true };
  const heading = threads.length > 0 ? [{ text: paint(grey, `${pad}Active`) }, { text: "" }] : [];
  const top: Line[] = [
    ...lead,
    ...(lead.length > 0 && entries.length > 0 ? [divider] : []),
    // A blank line parts each entry from the next, so each stands apart. It has no place, so
    // a click on it picks nothing.
    ...entries.flatMap((entry, i) => {
      const place = entryPlace(entry.entry);
      const line = { text: entryLine(entry, place === shown, width), place };
      return i === 0 ? [line] : [{ text: "" }, line];
    }),
    ...(heading.length > 0 ? [divider, ...heading] : []),
  ];
  // Too short for all of that and the row you are on, or a row when you are on none of them:
  // the lead and the threads alone.
  const left = size.height - top.length;
  const needed = threads.length > 0 ? rowHeight(threads[Math.max(shownThread, 0)]) : 0;
  if (left < needed) return scrolled(blocks, here, size.height);
  return [...top, ...scrolled(threads.map(linesOf), Math.max(shownThread, 0), left)];
}

// Returns the whole sidebar as lines, given the rows, the entries, what is on the right, as a
// row's session or an entry's place, and the sidebar's size. It reads nothing, so what you see
// can be tested without a terminal. Every line fills the pane and ends with the sidebar's edge,
// in the last column. tmux's own border beside it is blank, which leaves a gap before the agent.
export function draw(rows: Row[], entries: EntryCount[], shown: string | null, size: Size): string {
  const width = size.width - 1;
  // Each line is filled out to the edge, which a divider meets with a ┤.
  return padded(layout(rows, entries, shown, size), size.height)
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
