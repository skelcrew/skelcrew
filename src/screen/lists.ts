// The sidebar's lists as lines for its pane: the lead and threads, ISSUES and PRS, and the keys
// at the bottom. It reads nothing, so what you see can be tested without a terminal.
import { clean, edge, fitted, grey, onShade, pad, paint, shade, white, yellow } from "./look.ts";
import { type Link, type List, type Lists, needing, type Row, threadMark } from "./rows.ts";

export type Size = { width: number; height: number };
// One line of the sidebar, with the row it belongs to, if any, for a click. A line that `joins`
// the sidebar's edge runs into it, as the lines between lists do.
type Line = { text: string; row?: Row; link?: Link; joins?: boolean };

// Where a name starts, past its mark.
const indent = `${pad}  `;
// The keys you need most, at the bottom of the sidebar.
const hints = [`${pad}⌥↑↓ move`, `${pad}⌥⇧↑↓ list`, `${pad}⌥←→ repo`, `${pad}⌃Q quit`];

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
  const room = Math.max(width - indent.length - pad.length, 1);
  const [first = "", ...rest] = row.name.match(new RegExp(`.{1,${room}}`, "g")) ?? [];
  const [sign, colour] = threadMark(row);
  const word = row.word.slice(0, room);
  const after = [row.harness, row.age].flatMap((part) => (part ? [` · ${part}`] : [])).join("");
  const more = after.slice(0, room - word.length);
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
  const start = link.mark ? indent : pad;
  const room = Math.max(width - start.length - pad.length, 0);
  const title = fitted(clean(link.title), room);
  const name = fitted(link.name, room);
  const word = link.word && fitted(link.word, room - Bun.stringWidth(name) - 3);
  const about =
    word && `${tinted(here, grey, " · ")}${tinted(here, link.needing ? yellow : grey, word)}`;
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
// way. An empty list says so, as its third stays either way.
function listLines(
  heading: string,
  list: List,
  shown: string | null,
  height: number,
  width: number,
): Line[] {
  const top = headed(heading);
  if (list.links.length === 0) return [...top, { text: paint(grey, `${pad}none`) }];
  const fit = Math.floor((height - top.length) / 2);
  const few = list.total > fit ? Math.max(Math.floor((height - top.length - 1) / 2), 1) : fit;
  const links = list.links.slice(0, few);
  const rest = list.total - links.length;
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
  let used = blocks.slice(0, here + 1).flat().length;
  let first = 0;
  while (first < here && used > room) {
    used -= blocks[first]?.length ?? 0;
    first++;
  }
  return blocks.slice(first).flat().slice(0, room);
}

// Returns the lines above the hints, and how many there can be. The hints take the bottom four,
// until the sidebar can't hold them and the whole row you are looking at: then they give way, as
// the rows are what you pick from and the keys are also in Skelcrew's help.
// The lists the repository has, of ISSUES, THREADS and PRS, share those lines evenly, however
// full, so each list stays in the same place on screen, and what doesn't divide goes to THREADS.
// On a terminal too short for a heading and a row in each share, or for the row you are looking
// at in THREADS, ISSUES and PRS go, and THREADS has the whole sidebar, as it is the list you
// move through. With neither of them, THREADS has it too, with no heading.
export function layout(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
): { lines: Line[]; room: number } {
  const width = size.width - 1;
  const blocks = rows.map((row) =>
    rowLines(row, row.session === shown, width).map((text) => ({ text, row })),
  );
  const here = rows.findIndex((row) => row.session === shown);
  const tallest = blocks[here]?.length ?? 2;
  const room = size.height >= tallest + hints.length ? size.height - hints.length : size.height;
  const others = [
    ...(lists.issues ? [["Issues", lists.issues] as const] : []),
    ...(lists.prs ? [["PRs", lists.prs] as const] : []),
  ];
  // One line parts each list from the next.
  const share = Math.floor((room - others.length) / (others.length + 1));
  const middle = room - others.length - others.length * share;
  const top = headed("Threads");
  if (others.length === 0 || share < top.length + 2 || middle < top.length + tallest)
    return { lines: scrolled(blocks, here, room), room };
  const divider = { text: paint(edge, "─".repeat(Math.max(width, 0))), joins: true };
  const threads = [
    ...top,
    ...padded(scrolled(blocks, here, middle - top.length), middle - top.length),
  ];
  const listed = ([heading, list]: (typeof others)[number]) =>
    padded(listLines(heading, list, shown, share, width), share);
  const [first, second] = others;
  const lines = lists.issues
    ? [
        ...(first ? listed(first) : []),
        divider,
        ...threads,
        ...(second ? [divider, ...listed(second)] : []),
      ]
    : [...threads, divider, ...(first ? listed(first) : [])];
  return { lines, room };
}

// Returns the whole sidebar as lines, given the rows, the lists, what is on the right, as a
// session or a link's url, and the sidebar's size. It reads nothing, so what you see can be
// tested without a terminal. Every line fills the pane and ends with the sidebar's edge, in the
// last column. tmux's own border beside it is blank, which leaves a gap before the agent.
export function draw(rows: Row[], lists: Lists, shown: string | null, size: Size): string {
  const { lines, room } = layout(rows, lists, shown, size);
  const width = size.width - 1;
  const keys = hints.map((hint) => ({
    text: paint(grey, hint.slice(0, Math.max(width - pad.length, 0))),
  }));
  const all: Line[] = [...padded(lines, room), ...(room < size.height ? keys : [])];
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
  const lines = [""];
  for (const word of notice.split(" ")) {
    const last = lines.length - 1;
    const longer = lines[last] ? `${lines[last]} ${word}` : word;
    if (Bun.stringWidth(longer) <= room || !lines[last]) lines[last] = longer;
    else lines.push(word);
  }
  return [...lines.map((line) => `${pad}${line}`), ""].map(
    (line) => `${filled(line, width - 1)}${paint(edge, "│")}`,
  );
}
