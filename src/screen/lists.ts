// The sidebar as lines for its pane: the lead's row on top, then ISSUES, THREADS and PRS, and the
// keys at the bottom. It reads nothing, so what you see can be tested without a terminal.
import { clean, edge, fitted, grey, onShade, pad, paint, shade, white, yellow } from "./look.ts";
import { type Link, type List, type Lists, needing, type Row, threadMark } from "./rows.ts";

export type Size = { width: number; height: number };
// One line of the sidebar, with the row it belongs to, if any, for a click. A line that `joins`
// the sidebar's edge runs into it, as the lines between lists do.
type Line = { text: string; row?: Row; link?: Link; joins?: boolean };

// Where a name starts, past its mark.
const indent = `${pad}  `;
// The keys you need most, at the bottom of the sidebar. The others are in Skelcrew's help.
const hints = [`${pad}⌥↑↓ move`, `${pad}⌃Q quit`];

// Returns a line with spaces added out to a width.
const filled = (line: string, width: number) =>
  `${line}${" ".repeat(Math.max(width - Bun.stringWidth(line), 0))}`;

// Returns text in a colour, or, on the row you are looking at, the one that stands in for it on
// the grey.
const tinted = (here: boolean, code: number, text: string) =>
  paint(here ? (onShade[code] ?? code) : code, text);

// Returns a line with the grey behind it, out to the end of the row.
const band = (line: string, width: number) => `\x1b[${shade}m${filled(line, width)}\x1b[49m`;

// Returns one row as lines: a mark and the whole name, which goes on to more lines when it is
// too long, then the word and harness. A cut name could hide what tells two threads apart. An
// agent that isn't running is dim, as it can't be picked. The one you are looking at is shaded
// across the whole width, on all its lines.
function rowLines(row: Row, here: boolean, width: number): string[] {
  // Returns part of the name as this row shows it.
  const styled = (name: string) => {
    if (here) return paint(white, name);
    return row.running ? name : paint(grey, name);
  };
  // The name is cut into pieces that fit between the indent and the padding, so a long one
  // goes on to more lines instead of being cut short.
  const room = Math.max(width - indent.length - pad.length, 1);
  const [first = "", ...rest] = row.name.match(new RegExp(`.{1,${room}}`, "g")) ?? [];
  // The last line has the word, then the harness and age in what room the word leaves.
  const [sign, colour] = threadMark(row);
  const word = row.word.slice(0, room);
  const after = [row.harness, row.age].flatMap((part) => (part ? [` · ${part}`] : [])).join("");
  const more = after.slice(0, room - word.length);
  // The mark starts the first line, and the rest line up under the name. The word is yellow
  // when the thread needs you.
  const lines = [
    `${pad}${tinted(here, colour, sign)} ${styled(first)}`,
    ...rest.map((part) => `${indent}${styled(part)}`),
    `${indent}${tinted(here, needing(row) ? yellow : grey, word)}${more && tinted(here, grey, more)}`,
  ];
  return here ? lines.map((line) => band(line, width)) : lines;
}

// Returns a row of ISSUES or PRS as two lines, each a terminal link and cut to stop at the
// padding: its title, then, dim, its name and a PR's word, in the colours a thread gives that
// word. A PR's mark comes before its title, outside the link. An issue has none, so its lines
// start at the padding. Skelcrew may run on another machine than your browser, so your terminal
// opens the link. The title comes from outside, so it is made safe. The one you are looking at
// is shaded as a thread's row is.
function linkLines(link: Link, here: boolean, width: number): string[] {
  // Each part is cut to fit between where its line starts and the padding. The word shares
  // the name's line, after a dot of three columns, and is yellow when its thread needs you.
  const start = link.mark ? indent : pad;
  const room = Math.max(width - start.length - pad.length, 0);
  const title = fitted(clean(link.title), room);
  const name = fitted(link.name, room);
  const word = link.word && fitted(link.word, room - Bun.stringWidth(name) - 3);
  const about =
    word && `${tinted(here, grey, " · ")}${tinted(here, link.needing ? yellow : grey, word)}`;
  // The title is white on the row you are looking at, and dim for an issue that already has a
  // thread. Both lines are the link, so either one opens it.
  const heading = here ? paint(white, title) : link.dim ? paint(grey, title) : title;
  const [top, bottom] = [heading, `${tinted(here, grey, name)}${about}`].map(
    (text) => `\x1b]8;;${link.url}\x1b\\${text}\x1b]8;;\x1b\\`,
  );
  const mark = link.mark && `${pad}${tinted(here, link.mark[1], link.mark[0])} `;
  const lines = [`${mark ?? pad}${top}`, `${start}${bottom}`];
  return here ? lines.map((line) => band(line, width)) : lines;
}

// Returns what starts a list: its heading, dim, and the blank line that parts it from the rows.
const headed = (heading: string): Line[] => [
  { text: paint(grey, `${pad}${heading}`) },
  { text: "" },
];

// Returns a list's lines for a third of `height` lines: its heading and a blank line, as many
// rows as fit, then a count of the rest. Rows come with the dim ones last, so those are the
// first to be left out. A third with room for just one row keeps the row, and the count gives
// way.
function listLines(
  heading: string,
  list: List,
  shown: string | null,
  height: number,
  width: number,
): Line[] {
  const top = headed(heading);
  // Each row takes two lines. When not all of them fit, a line is kept for the count of the
  // rest, unless that would leave no row at all.
  const fit = Math.floor((height - top.length) / 2);
  const few = list.total > fit ? Math.max(Math.floor((height - top.length - 1) / 2), 1) : fit;
  const links = list.links.slice(0, few);
  const rest = list.total - links.length;
  // Cutting to the third is what drops the count when only one row fits.
  return [
    ...top,
    ...links.flatMap((link) =>
      linkLines(link, link.url === shown, width).map((text) => ({ text, link })),
    ),
    ...(rest > 0 ? [{ text: paint(grey, `${pad}+ ${rest} more`) }] : []),
  ].slice(0, height);
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

// Returns the lines above the hints, and how many there can be. The hints take the bottom lines,
// until the sidebar can't hold them and the whole row you are looking at: then they give way, as
// the rows are what you pick from and the keys are also in Skelcrew's help.
// The lead's row comes first, on its own, with a line under it. Below it, the lists that show, of
// ISSUES, THREADS and PRS, share the lines left evenly, however full, so each list stays in the
// same place on screen, and what doesn't divide goes to THREADS. A list shows only with something
// in it, as an empty list says nothing. On a terminal too short for a heading and a row in each
// share, or for the row you are looking at in THREADS, the lists go, and the lead and the threads
// have the whole sidebar together, with no heading, as they are what you move through.
export function layout(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
): { lines: Line[]; room: number } {
  // Every row's lines, and how tall the row you are looking at is. The hints keep the bottom
  // lines only while that row still fits above them.
  const width = size.width - 1;
  const linesOf = (row: Row) =>
    rowLines(row, row.session === shown, width).map((text) => ({ text, row }));
  const blocks = rows.map(linesOf);
  const here = rows.findIndex((row) => row.session === shown);
  const tallest = blocks[here]?.length ?? 2;
  const room = size.height >= tallest + hints.length ? size.height - hints.length : size.height;
  // The lead is the row with no status of its own.
  const lead = rows.filter((row) => row.status === null).flatMap(linesOf);
  const threads = rows.filter((row) => row.status !== null).map(linesOf);
  const yours = rows.filter((row) => row.status !== null).findIndex((row) => row.session === shown);
  const issues = lists.issues?.links.length ? lists.issues : null;
  const prs = lists.prs?.links.length ? lists.prs : null;
  // Each list that shows, as what draws it in a number of lines. THREADS scrolls to keep yours
  // in view.
  const parts = [
    ...(issues ? [(height: number) => listLines("Issues", issues, shown, height, width)] : []),
    ...(threads.length > 0
      ? [(height: number) => [...headed("Threads"), ...scrolled(threads, yours, height - 2)]]
      : []),
    ...(prs ? [(height: number) => listLines("PRs", prs, shown, height, width)] : []),
  ];
  // One line goes under the lead, and one between each list and the next. What doesn't divide
  // goes to THREADS, or to the first list without it.
  const below = room - lead.length - (lead.length > 0 ? parts.length : parts.length - 1);
  const share = Math.floor(below / parts.length);
  const wide = threads.length > 0 && issues ? 1 : 0;
  const heights = parts.map((_, index) =>
    index === wide ? below - (parts.length - 1) * share : share,
  );
  // Too short for a heading and a row in each list, or for your row in THREADS: no lists.
  const tallestThread = threads[yours]?.length ?? 2;
  const threadsFit = threads.length === 0 || (heights[wide] ?? 0) >= 2 + tallestThread;
  if (parts.length === 0 || share < 4 || !threadsFit)
    return { lines: scrolled(blocks, here, room), room };
  // Each list is filled out to its share, so the list after it always starts in the same place.
  const divider = { text: paint(edge, "─".repeat(Math.max(width, 0))), joins: true };
  const sections = [
    ...(lead.length > 0 ? [lead] : []),
    ...parts.map((part, index) => padded(part(heights[index] ?? share), heights[index] ?? share)),
  ];
  const lines = sections.flatMap((section, index) => (index > 0 ? [divider, ...section] : section));
  return { lines, room };
}

// Returns the whole sidebar as lines, given the rows, the lists, what is on the right, as a
// session or a link's url, and the sidebar's size. It reads nothing, so what you see can be
// tested without a terminal. Every line fills the pane and ends with the sidebar's edge, in the
// last column. tmux's own border beside it is blank, which leaves a gap before the agent.
export function draw(rows: Row[], lists: Lists, shown: string | null, size: Size): string {
  // The hints are cut to the sidebar's width, and come below the lists only when the layout left
  // room for them.
  const { lines, room } = layout(rows, lists, shown, size);
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

// Returns the lines that go above the lists for a notice, such as a release installed in the
// background, or none without one. Cut at words to fit a sidebar `width` columns wide, and
// parted from the lists by a blank line. Each fills the pane and ends with the sidebar's edge.
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
