// The list as lines for your terminal: the top line with Skelcrew and every repository's tab, the
// lead's row, each stage's heading with the rows of those that are open, and
// the bottom line with the keys and the machine's load. It reads nothing, so what you see can be
// tested without a terminal.
import type { ListStage } from "../flow/stage.ts";
import {
  bright,
  filled,
  fitted,
  grey,
  lightGrey,
  markColours,
  paint,
  shaded,
  tinted,
  white,
  yellow,
} from "../screen/look.ts";
import type { Heading, Row, Tab } from "./rows.ts";

// What the list shows besides its rows: the version of Skelcrew running here, where it runs on a
// remote, or empty on this machine, the open repository's name, every repository's tab, the
// notice of a release waiting for a restart, or empty, the bottom line's text, and the load.
export type Frame = {
  version: string;
  where: string;
  name: string;
  tabs: Tab[];
  notice: string;
  bottom: string;
  load: string;
};

// The size of your terminal.
export type Size = { width: number; height: number };

// The name of each stage, as its heading shows it.
const stageNames: Record<ListStage, string> = {
  backlog: "Backlog",
  building: "Building",
  reviewing: "Reviewing",
  checks: "Checks",
  ready: "Ready",
  done: "Done",
};

// Returns the keys the bottom line offers on a row: Enter always, with Ctrl-Q, which comes back,
// on a row whose agent Enter attaches to on tmux, or as showing every issue on Backlog's `… more`
// row, the numbers that open and close the stages, m only on a task it can merge, and Tab and
// Alt-Shift with an arrow only with another repository to go to. A runtime plugin's host has its
// own key to come back, so its rows don't offer Ctrl-Q.
export function keysFor(row: Row | undefined, tabs: number): string {
  const open = row?.more ? "⏎ show all" : row?.tmux ? "⏎ open · ctrl+q back" : "⏎ open";
  const merge = row?.merge && "ask" in row.merge ? ["m merge"] : [];
  const tab = tabs > 1 ? ["⇥/alt+shift+←→ repository"] : [];
  return ["↑↓ move", open, "1-6 stages", ...merge, ...tab, "q/esc quit"].join("  ");
}

// The widest stage name, so every heading's count starts in the same column.
const stageNameWidth = Math.max(...Object.values(stageNames).map((name) => name.length));

// Returns a stage's heading as a line: the number key that opens and closes it, dim, then its
// name, bright while open and dim while closed, then how many tasks it has, lined up under the
// other headings' counts, then how many need you, in yellow, such as `2 Building   4 · 2 need
// you`. Cut to fit, without its colours, on a narrow terminal.
function headingLine(heading: Heading, key: number, countWidth: number, width: number): string {
  const name = stageNames[heading.stage];
  const count = String(heading.count).padStart(countWidth);
  const needing = heading.needYou === 1 ? "1 needs you" : `${heading.needYou} need you`;
  const note = heading.needYou ? ` · ${needing}` : "";
  const plain = ` ${key} ${name.padEnd(stageNameWidth)} ${count}${note}`;
  if (Bun.stringWidth(plain) > width) return fitted(plain, width);
  const shown = paint(heading.open ? bright : grey, name.padEnd(stageNameWidth));
  return ` ${paint(grey, String(key))} ${shown} ${count}${note && paint(yellow, note)}`;
}

// A repository's tab on the top line, the columns it takes, counted from 1 as your terminal
// counts a click, and the owner/name a click on it opens.
export type TabSpan = { from: number; to: number; fullName: string };

// The background of the open repository's tab, and of the others', so they look like tabs.
const openTab = "48;5;238";
const otherTab = "48;5;236";

// Returns the top line and where each repository's tab is on it. Skelcrew in bold and its
// version and where it runs, dim, then every repository's tab, in order, left to right. The open
// one is white on a lighter grey. Each other one has a yellow dot and how many of its threads
// need you, or red when one went wrong, then a green dot and how many wait for you to merge. They
// are counted apart, so a finished task is never told twice. Another repository's tab that
// doesn't fit beside the open one's is left out.
function topParts(frame: Frame, width: number): { line: string; spans: TabSpan[] } {
  const place = frame.where ? ` on ${frame.where}` : "";
  const plain = ` Skelcrew v${frame.version}${place}`;
  if (Bun.stringWidth(plain) > width) return { line: fitted(plain, width), spans: [] };
  let line = ` ${paint(bright, "Skelcrew")} ${paint(grey, `v${frame.version}${place}`)}`;
  let used = Bun.stringWidth(plain);
  const spans: TabSpan[] = [];
  // Each tab's text, with a space either side inside its background.
  const laid = frame.tabs.map((tab) => {
    const open = tab.name === frame.name;
    const colour = tab.colour === "red" ? markColours.red : yellow;
    const needing = !open && tab.needYou ? [{ code: colour, badge: `•${tab.needYou}` }] : [];
    const ready = tab.ready && !open ? [{ code: markColours.green, badge: `•${tab.ready}` }] : [];
    const badges = [...needing, ...ready];
    const text = ` ${[tab.name, ...badges.map(({ badge }) => badge)].join(" ")} `;
    return { tab, open, badges, size: Bun.stringWidth(text) };
  });
  // The open repository's tab always keeps its room, so you can always tell which one shows.
  // Other tabs that don't fit beside it are left out. Each tab has a space between it and the
  // next.
  let kept = laid.find(({ open }) => open)?.size ?? 0;
  for (const { tab, open, badges, size } of laid) {
    if (open) kept = 0;
    else if (used + 2 + size + (kept ? 2 + kept : 0) > width) continue;
    if (used + 2 + size > width) break;
    const back = open ? openTab : otherTab;
    const name = open ? `\x1b[${white}m${tab.name}\x1b[22;39m` : paint(lightGrey, tab.name);
    const marks = badges.map(({ code, badge }) => ` ${paint(code, badge)}`).join("");
    line += `  \x1b[${back}m ${name}${marks} \x1b[49m`;
    spans.push({ from: used + 3, to: used + 2 + size, fullName: tab.fullName });
    used += 2 + size;
  }
  return { line, spans };
}

// Returns the owner/name of the repository whose tab is at a column of the top line, counted from
// 1, or null where there is none, so a click on a tab opens it. It lays out the top line as
// drawList does, for a terminal of `width` columns.
export function tabAt(frame: Frame, width: number, column: number): string | null {
  const { spans } = topParts(frame, width - 1);
  return spans.find((span) => span.from <= column && column <= span.to)?.fullName ?? null;
}

// The width of each column of a one-line row: the name, the title and when it changed, each as
// wide as the widest that shows, so they line up from one row to the next.
type Columns = { name: number; title: number; when: number };

// Returns whether a row takes two lines: the lead's, and a task's in Building, Reviewing, Checks
// or Ready. Backlog and Done take one.
const tall = (row: Row) => row.part !== "backlog" && row.part !== "done";

// Returns the row you are on as `lines`, shaded across the width, or as they are on another row.
const marked = (lines: string[], here: boolean, width: number) =>
  here ? lines.map((line) => shaded(line, width)) : lines;

// Returns the start of a row's first line: ▸ on the row you are on, then its mark.
const markStart = (row: Row, here: boolean) =>
  `${here ? " ▸ " : "   "}${tinted(here, markColours[row.mark.colour], row.mark.sign)}`;

// Returns a row in Backlog or Done as one line, in columns from the left: its mark, its name,
// its title, cut with … when it doesn't fit, then when it changed, dim. The title's column is as
// wide as the widest title, or what is left, so the times line up. A row whose name and time
// alone are too wide is cut to fit, without its colours, as a longer line would wrap.
function shortLine(row: Row, here: boolean, columns: Columns, width: number): string {
  const start = `${here ? " ▸ " : "   "}${row.mark.sign} `;
  const name = filled(row.name, columns.name);
  const time = columns.when > 0 ? `  ${filled(row.when, columns.when)}` : "";
  const room = width - Bun.stringWidth(start) - columns.name - 2 - Bun.stringWidth(time);
  const title = room > 0 ? filled(fitted(row.title, room), Math.min(columns.title, room)) : "";
  const plain = `${start}${name}  ${title}${time}`;
  if (room <= 0) return fitted(plain.trimEnd(), width);
  // A name is plain text, white on the row you are on, as the theme's own text can be dark on
  // the grey there.
  const shownName = here ? tinted(here, bright, name) : name;
  const shownTitle = here ? tinted(here, bright, title) : title;
  return `${markStart(row, here)} ${shownName}  ${shownTitle}${time && tinted(here, grey, time)}`;
}

// Returns the lead's row, or a task's in Building, Reviewing, Checks or Ready, as its two lines,
// so what it does sits under its title. The first line has its mark, its name, padded to
// `nameWidth` so the titles line up, and its title. The second has its word in its colour, then
// dim the step its builder is on, its PR, its CI and when it last changed, such as
// `working · Editing rows.ts · #40 · CI passed · 14:31`, each left out where it has none. Each
// line is cut with … to fit, and the row you are on is shaded on both its lines.
function tallLines(row: Row, here: boolean, nameWidth: number, width: number): string[] {
  const plainStart = `${here ? " ▸ " : "   "}${row.mark.sign} `;
  const indent = " ".repeat(Bun.stringWidth(plainStart));
  const room = Math.max(width - indent.length, 0);
  // The first line: on a terminal too narrow for the mark, it is cut without its colours.
  const named = `${filled(row.name, Math.min(nameWidth, room))}  ${row.title}`;
  const top = fitted(named, room);
  const first =
    width < indent.length
      ? fitted(`${plainStart}${top}`, width)
      : `${markStart(row, here)} ${here ? tinted(here, bright, top) : top}`;
  // The word keeps its colour and the rest is dim, so each is split back out of the cut line.
  const parts = [row.says, row.step, row.pr, row.checks, row.when];
  const doing = fitted(parts.filter(Boolean).join(" · "), room);
  const word = doing.slice(0, row.says.length);
  const rest = doing.slice(row.says.length);
  const second = `${indent}${tinted(here, markColours[row.colour], word)}${rest && tinted(here, grey, rest)}`;
  const lines = [first, second].map((line) =>
    width < indent.length ? fitted(Bun.stripANSI(line), width) : line,
  );
  return marked(lines, here, width);
}

// One line of the stages' part of the list: its text, the stage it is in, by its place among the
// headings, and the row it belongs to, by its place in the rows, or null for a heading or a
// blank line.
type BodyLine = { text: string; stage: number; row: number | null };

// Returns the line at one edge of the stages when lines are hidden past it, or an empty line when
// none are. `arrow` is ↑ or ↓. It says how many rows are hidden there, and in which stage when
// they are all in one, then each heading hidden there, short: its name, its count and how many
// need you, in yellow. So every count stays in sight however the list scrolls. Cut to fit,
// without its colours, on a narrow terminal.
function edgeLine(
  arrow: string,
  hidden: BodyLine[],
  rows: Row[],
  headings: Heading[],
  width: number,
): string {
  if (hidden.length === 0) return "";
  // A row counts as hidden when any of its lines is.
  const hiddenRows = [...new Set(hidden.flatMap((line) => (line.row === null ? [] : [line.row])))];
  const stages = new Set(hiddenRows.map((i) => rows[i]?.part));
  const [only] = [...stages];
  const where = stages.size === 1 && only && only !== "lead" ? ` in ${stageNames[only]}` : "";
  const more = hiddenRows.length > 0 ? [`${hiddenRows.length} more${where}`] : [];
  // While the stages scroll there are no blank lines, so a line of no row is a heading.
  const pinned = headings.filter((_, stage) =>
    hidden.some((line) => line.row === null && line.stage === stage),
  );
  const parts = pinned.map((heading) => {
    const needing = heading.needYou === 1 ? "1 needs you" : `${heading.needYou} need you`;
    return {
      named: `${stageNames[heading.stage]} ${heading.count}`,
      note: heading.needYou ? ` · ${needing}` : "",
    };
  });
  const plain = [...more, ...parts.map(({ named, note }) => `${named}${note}`)].join("   ");
  if (Bun.stringWidth(` ${arrow} ${plain}`) > width)
    return paint(grey, fitted(` ${arrow} ${plain}`, width));
  const coloured = parts.map(
    ({ named, note }) => `${paint(grey, named)}${note && paint(yellow, note)}`,
  );
  const items = [...more.map((text) => paint(grey, text)), ...coloured];
  return ` ${paint(grey, arrow)} ${items.join("   ")}`;
}

// Returns the list as lines that fill the terminal, on the row at `here`. The top line comes
// first, then a notice when there is one, then the lead, then every stage's heading, each open
// one with its rows under it, then the bottom line. `rows` are the rows that show: the lead's and
// those of the open stages, in the order of the stages. The lead never scrolls. When the stages
// don't all fit, they scroll together, headings and rows, from the line `top`, so an open stage's
// heading is always right above its rows, and a heading with none under it is closed. Then the
// first and last lines of the stages say what is hidden above and below, with the headings
// hidden there, so no stage's count or need of you goes out of sight. The list moves only
// when the row you are on would leave the screen. A row that is the first of its stage brings
// its heading into view with it, so opening a stage shows the heading over its rows. A terminal
// too short for those edge lines keeps only the row you are on, or its first line when even it
// doesn't fit. Gives the lines and the scroll they were drawn at, which the next draw starts
// from. Nothing is drawn in the terminal's last column: a terminal waits there to wrap, and
// clearing the rest of the line from that state erases the last character drawn.
export function drawList(
  rows: Row[],
  headings: Heading[],
  here: number,
  top: number,
  frame: Frame,
  size: Size,
): { lines: string[]; top: number } {
  const width = size.width - 1;
  // The one-line rows' columns, from those rows alone, and the names' width, from every row.
  const short = rows.filter((row) => !tall(row));
  const widest = (of: (row: Row) => string, among = short) =>
    Math.max(...among.map((row) => Bun.stringWidth(of(row))), 0);
  const columns = {
    name: widest((row) => row.name, rows),
    title: widest((row) => row.title),
    when: widest((row) => row.when),
  };
  // Returns the lines of the row at `i` in `rows`.
  const linesOf = (i: number) => {
    const row = rows[i];
    if (!row) return [];
    if (tall(row)) return tallLines(row, i === here, columns.name, width);
    return marked([shortLine(row, i === here, columns, width)], i === here, width);
  };
  const countWidth = Math.max(...headings.map((heading) => String(heading.count).length), 1);
  // The lead is above the stages, and never scrolls.
  const lead = rows.flatMap((row, i) => (row.part === "lead" ? [...linesOf(i), ""] : []));
  const notice = frame.notice ? [paint(yellow, fitted(` ${frame.notice}`, width))] : [];
  const head = [topParts(frame, width).line, ...notice, "", ...lead];
  const room = Math.max(size.height - head.length - 2, 1);
  // Returns the stages' lines: each heading, with an open stage's rows under it. With `parted`,
  // an open stage with rows has a blank line after them, which parts it from the next heading.
  const stages = (parted: boolean): BodyLine[] =>
    headings.flatMap((heading, stage) => {
      const ours = rows.flatMap((row, i) =>
        row.part === heading.stage ? linesOf(i).map((text) => ({ text, stage, row: i })) : [],
      );
      const after = parted && ours.length > 0 ? [{ text: "", stage, row: null }] : [];
      const line = { text: headingLine(heading, stage + 1, countWidth, width), stage, row: null };
      return [line, ...ours, ...after];
    });
  let body = stages(true);
  let shown = body.map((line) => line.text);
  let start = 0;
  // Too many to fit: the blank lines go, and the stages scroll between the two edge lines, just
  // enough to keep the row you are on in view, from where they were last drawn.
  if (body.length > room) {
    body = stages(false);
    const edges = room >= 3;
    const view = edges ? room - 2 : room;
    start = Math.min(Math.max(top, 0), Math.max(body.length - view, 0));
    const own = body.flatMap((line, at) => (line.row === here ? [at] : []));
    const first = own[0];
    const last = own.at(-1);
    if (first !== undefined && last !== undefined) {
      // The heading comes along when the row is its stage's first and both fit.
      const above = body[first - 1];
      const from = above && above.row === null && last - first + 2 <= view ? first - 1 : first;
      start = Math.min(start, from);
      start = Math.max(start, last - view + 1);
      // A row taller than the room left keeps its first line, with its ▸.
      start = Math.min(start, first);
    }
    // The view never starts on a row's second line, which would show without its title. Going
    // one line further down keeps the row you are on, unless it is that row.
    const cut = body[start];
    const atRowEnd = cut && cut.row !== null && body[start - 1]?.row === cut.row;
    if (atRowEnd && (first === undefined || start < first)) start += 1;
    const visible = body.slice(start, start + view).map((line) => line.text);
    shown = edges
      ? [
          edgeLine("↑", body.slice(0, start), rows, headings, width),
          ...visible,
          edgeLine("↓", body.slice(start + view), rows, headings, width),
        ]
      : visible;
  }
  const blank = Array.from({ length: room - shown.length }, () => "");
  // A question or a reason must stay on its one line, so it is cut to fit, and the load gives
  // way first.
  const bottom = fitted(` ${frame.bottom}`, width);
  const load = frame.load;
  const gap = width - Bun.stringWidth(bottom) - Bun.stringWidth(Bun.stripANSI(load));
  const last = gap > 1 ? `${paint(grey, bottom)}${" ".repeat(gap)}${load}` : paint(grey, bottom);
  return { lines: [...head, ...shown, ...blank, "", last], top: start };
}
