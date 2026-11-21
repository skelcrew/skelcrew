// The list as lines for your terminal: the top line with Skelcrew and every repository's tab, the
// lead's row, each section's heading with the rows of those that are open, and
// the bottom line with the keys and the machine's load. It reads nothing, so what you see can be
// tested without a terminal.
import { ListStage } from "../flow/stage.ts";
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
import type { Heading, Row, Section, Tab } from "./rows.ts";

// What the list shows besides its rows: the names of the version of Skelcrew running here, longest
// first, such as v0.4.2 or 6f1c2ab (checkout), where it runs on a remote, or empty on this machine,
// the open repository's name, every repository's tab, the notice of a release waiting for a
// restart, or empty, the bottom line's text, and the load.
export type Frame = {
  versions: string[];
  where: string;
  name: string;
  tabs: Tab[];
  notice: string;
  bottom: string;
  load: string;
};

// The size of your terminal.
export type Size = { width: number; height: number };

// How wide the list is, in its own window or as the screen's sidebar: a little over a quarter of
// the terminal, so the pane or the right side has the room for the agent at work. It never gets
// narrower than a row's name, short title and word need, nor wider than a task's two lines do,
// such as `working · Editing rows.ts · #40 · CI passed · 14:31`.
export const listShare = { percent: 28, least: 40, most: 58 };

// Returns how many columns the list takes in a terminal `width` columns wide.
export const listWidth = (width: number) =>
  Math.min(
    Math.max(Math.floor((width * listShare.percent) / 100), listShare.least),
    listShare.most,
  );

// The narrowest terminal that shows the pane, and the line between the pane and the list. On a
// narrower one the list keeps the whole width, as the agent's lines would show too cut to read.
const paneFrom = 114;
export const paneEdge = " │ ";

// Returns how many columns the pane takes in a terminal `width` columns wide, or 0 when it is too
// narrow for the list and the pane side by side. The pane takes what the list leaves, past the
// terminal's last column, which is never drawn in.
export function paneWidth(width: number): number {
  if (width < paneFrom) return 0;
  return width - 1 - listWidth(width) - paneEdge.length;
}

// The name of each section, as its heading shows it, which the pane also shows of a row's stage.
export const sectionNames: Record<Section, string> = {
  "needs you": "Needs you",
  "task queue": "Task queue",
  backlog: "Backlog",
  building: "Building",
  reviewing: "Reviewing",
  checks: "Checks",
  ready: "Ready",
  done: "Done",
};

// Returns the keys the bottom line offers on a row: Enter, as attach on a row whose agent it
// attaches to, with Ctrl-\, which comes back, when that is on tmux, as showing every issue on
// Backlog's `… more` row, or as open/close on a section's heading, and not at all on the heading of
// Needs you, which never closes. Then the numbers that open and close the sections, Shift with an
// arrow only on a queued task in the task queue, which it moves in the queue, s only on a task it
// can start, m only on a task it can merge, o on a task while the details pane shows, to show its
// agent's whole screen or only the last lines, and Page Up and Page Down to scroll its details, and
// Tab and Alt-Shift with an arrow only with another repository to go to. A runtime plugin's host
// has its own key to come back, so its rows don't offer Ctrl-\. A request of the lead's offers y
// and n, which answer it, in place of Enter.
export function keysFor(row: Row | undefined, tabs: number, pane = false): string {
  const tab = tabs > 1 ? ["⇥/alt+shift+←→ repository"] : [];
  if (row?.part === "request")
    return ["↑↓ move", "y yes", "n no", "0-6 sections", ...tab, "q/esc quit"].join("  ");
  const back = row?.tmux ? " · ctrl+\\ back" : "";
  const heading = row?.part === "heading";
  const enter = row?.more
    ? "⏎ show all"
    : heading
      ? "⏎ open/close"
      : row && enterAttaches(row)
        ? `⏎ attach${back}`
        : "⏎ open";
  const open =
    pane && row?.task
      ? [`${enter} · o output · pgup/pgdn scroll`]
      : heading && row.section === "needs you"
        ? []
        : [enter];
  const merge = row?.merge && "ask" in row.merge ? ["m merge"] : [];
  const start = row?.start ? [row.start.queues ? "s queue" : "s start"] : [];
  const reorder = row?.section === "task queue" && row.place !== null ? ["shift+↑↓ reorder"] : [];
  return [
    "↑↓ move",
    ...open,
    "0-6 sections",
    ...reorder,
    ...start,
    ...merge,
    ...tab,
    "q/esc quit",
  ].join("  ");
}

// Returns whether Enter on a row attaches to its agent: the lead, or a task's builder while it is
// at work, or once it is ready but needs you. On Backlog it starts the task, in the task queue it
// says what the task waits on, as no builder runs for it yet, and on Ready or Done it opens the PR.
export function enterAttaches(row: Row): boolean {
  if (row.part === "lead") return true;
  if (row.section === "task queue") return false;
  const atWork = row.part !== "ready" && row.part !== "done";
  return (atWork || row.needsYou) && row.session !== null;
}

// The widest section name, so every heading's count starts in the same column.
const sectionNameWidth = Math.max(...Object.values(sectionNames).map((name) => name.length));

// Returns the number key that opens and closes a section, as its heading shows it: 0 for the
// task queue, then 1 to 6 for the stages in order. Needs you has none, as it never closes, since
// it is where you must look, so its key's place is blank.
const keyOf = (section: Section) =>
  section === "needs you"
    ? " "
    : section === "task queue"
      ? "0"
      : String(ListStage.options.indexOf(section) + 1);

// Returns a section's heading as a line: the number key that opens and closes it, dim, then its
// name, bright while open and dim while closed, then how many tasks it has, lined up under the
// other headings' counts, such as `2 Building  4`. Needs you's count is yellow, as it shows only
// while a task waits on you. Task queue then says dim how full the builders are, such as `Building
// 4/4 · 3 queued`, which goes first on a narrow terminal. Cut to fit, without its colours, on a
// terminal narrower still.
function headingLine(heading: Heading, countWidth: number, width: number): string {
  const key = keyOf(heading.section);
  const name = sectionNames[heading.section].padEnd(sectionNameWidth);
  const count = String(heading.count).padStart(countWidth);
  const plain = ` ${key} ${name} ${count}`;
  if (Bun.stringWidth(plain) > width) return fitted(plain, width);
  const shown = paint(heading.open ? bright : grey, name);
  const waits = heading.section === "needs you";
  const fits = heading.note && Bun.stringWidth(`${plain}  ${heading.note}`) <= width;
  const note = fits ? `  ${paint(grey, heading.note)}` : "";
  return ` ${paint(grey, key)} ${shown} ${waits ? paint(yellow, count) : count}${note}`;
}

// A repository's tab on the top line, the columns it takes, counted from 1 as your terminal
// counts a click, and the owner/name a click on it opens.
export type TabSpan = { from: number; to: number; fullName: string };

// The background of the open repository's tab, and of the others', so they look like tabs.
const openTab = "48;5;238";
const otherTab = "48;5;236";

// Returns the top line and where each repository's tab is on it. Skelcrew in bold and the longest
// name of its version that fits and where it runs, dim, then every repository's tab, in order, left
// to right. The open one is white on a lighter grey. Each other one has a yellow dot and how many
// of its threads need you, or red when one went wrong, then a green dot and how many wait for you
// to merge. They are counted apart, so a finished task is never told twice. Another repository's
// tab that doesn't fit beside the open one's is left out.
function topParts(frame: Frame, width: number): { line: string; spans: TabSpan[] } {
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
  // Words around a checkout's commit give way before the line is cut, so it keeps the whole
  // commit when it can, and where it runs gives way before each of them. They give way for the open
  // repository's tab too, so it keeps showing.
  const openSize = laid.find(({ open }) => open)?.size ?? 0;
  const where = frame.where ? ` on ${frame.where}` : "";
  const named = frame.versions.flatMap((name) => [`${name}${where}`, name]);
  const room = (name: string, more: number) => Bun.stringWidth(` Skelcrew ${name}`) + more <= width;
  const about =
    named.find((name) => room(name, openSize ? 2 + openSize : 0)) ??
    named.find((name) => room(name, 0)) ??
    named.at(-1) ??
    "";
  const plain = ` Skelcrew ${about}`;
  if (Bun.stringWidth(plain) > width) return { line: fitted(plain, width), spans: [] };
  let line = ` ${paint(bright, "Skelcrew")} ${paint(grey, about)}`;
  let used = Bun.stringWidth(plain);
  const spans: TabSpan[] = [];
  // The open repository's tab always keeps its room, so you can always tell which one shows.
  // Other tabs that don't fit beside it are left out. Each tab has a space between it and the
  // next.
  let kept = openSize;
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

// What starts the first line of the row you are on: ▸ while your typing goes to the list, or the
// outline ▹ while it goes to the agent beside the screen's sidebar. Other rows start blank.
const pointers = { lit: " ▸ ", outline: " ▹ ", none: "   " };
type Pointer = keyof typeof pointers;

// Returns the start of a row's first line: its pointer, then its mark.
const markStart = (row: Row, pointer: Pointer) =>
  `${pointers[pointer]}${tinted(pointer === "lit", markColours[row.mark.colour], row.mark.sign)}`;

// Returns a row in Backlog or Done as one line, in columns from the left: its mark, its name,
// its title, cut with … when it doesn't fit, then when it changed, dim. The title's column is as
// wide as the widest title, or what is left, so the times line up. A row whose name and time
// alone are too wide is cut to fit, without its colours, as a longer line would wrap.
function shortLine(row: Row, pointer: Pointer, columns: Columns, width: number): string {
  const here = pointer === "lit";
  const start = `${pointers[pointer]}${row.mark.sign} `;
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
  return `${markStart(row, pointer)} ${shownName}  ${shownTitle}${time && tinted(here, grey, time)}`;
}

// Returns the lead's row, or a task's in Building, Reviewing, Checks or Ready, as its two lines,
// so what it does sits under its title. The first line has its mark, its name, padded to
// `nameWidth` so the titles line up, and its title. The second has its word in its colour, then
// dim the step its builder is on, its PR, its CI and when it last changed, such as
// `working · Editing rows.ts · #40 · CI passed · 14:31`, each left out where it has none. Each
// line is cut with … to fit, and the row you are on is shaded on both its lines.
function tallLines(row: Row, pointer: Pointer, nameWidth: number, width: number): string[] {
  const here = pointer === "lit";
  const plainStart = `${pointers[pointer]}${row.mark.sign} `;
  const indent = " ".repeat(Bun.stringWidth(plainStart));
  const room = Math.max(width - indent.length, 0);
  // The first line: on a terminal too narrow for the mark, it is cut without its colours.
  const named = `${filled(row.name, Math.min(nameWidth, room))}  ${row.title}`;
  const top = fitted(named, room);
  const first =
    width < indent.length
      ? fitted(`${plainStart}${top}`, width)
      : `${markStart(row, pointer)} ${here ? tinted(here, bright, top) : top}`;
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

// Returns a request of the lead's as one line, under the lead: its yellow mark, then the request,
// such as `Start APP-12 Fix login?`, cut with … to fit. Your answer is y or n, which the bottom
// line says on its row. `pointer` says whether it is the row you are on, lit or only outlined.
function requestLine(row: Row, pointer: Pointer, width: number): string {
  const here = pointer === "lit";
  const start = `${pointers[pointer]}${row.mark.sign} `;
  const room = width - Bun.stringWidth(start);
  if (room <= 0) return fitted(start, width);
  const text = fitted(row.title, room);
  const line = `${markStart(row, pointer)} ${here ? tinted(here, bright, text) : text}`;
  return here ? shaded(line, width) : line;
}

// What a click on a line of the list reaches: a row, by its place in the rows, which is the
// lead's or a task's, a section's heading, or nothing, such as on a blank line or an edge.
// On an edge line, a click reaches the heading pinned at its column: `pinned` has each one's
// columns, counted from 1 as your terminal counts a click.
export type Pinned = { from: number; to: number; section: Section };
export type Target = { row: number } | { section: Section } | { pinned: Pinned[] } | null;

// One line of the sections' part of the list: its text, the row it belongs to, by its place in
// the rows, or null for a heading or a blank line, and what a click on it reaches.
type BodyLine = { text: string; row: number | null; target: Target };

// The short name of each section, for an edge line too narrow for the full ones.
const shortNames: Record<Section, string> = {
  "needs you": "Need",
  "task queue": "Queue",
  backlog: "Back",
  building: "Build",
  reviewing: "Rev",
  checks: "Chk",
  ready: "Ready",
  done: "Done",
};

// Returns the line at one edge of the sections when lines are hidden past it, or an empty line
// when none are. `arrow` is ↑ or ↓. It says how many rows are hidden there, and in which section
// when they are all in one, then each heading hidden there, short: its name and its count, such
// as `↓ 5 more in Building   Checks 2`, with Needs you's count in yellow while any task waits on
// you. So every count stays in sight however the list scrolls. Too wide for the terminal, it is
// said in fewer letters, as `↓ +5  Chk 2`, then with each section by its number key and Needs
// you by `!`, as `↓ +5 4:2`, so the counts still fit. Only a terminal too narrow even for that cuts
// it, without its colours. Gives the line as a line of the body, whose target has the columns of
// each pinned heading still in sight, so a click on one opens or closes its section as a click
// on the heading itself does.
function edgeLine(
  arrow: string,
  hidden: BodyLine[],
  rows: Row[],
  headings: Heading[],
  width: number,
): BodyLine {
  const none: BodyLine = { text: "", row: null, target: null };
  if (hidden.length === 0) return none;
  // A row counts as hidden when any of its lines is.
  const hiddenRows = [...new Set(hidden.flatMap((line) => (line.row === null ? [] : [line.row])))];
  const sections = new Set(hiddenRows.map((i) => rows[i]?.section));
  const [only] = [...sections];
  const where = sections.size === 1 && only && only !== "lead" ? ` in ${sectionNames[only]}` : "";
  const pinned = headings.filter((heading) =>
    hidden.some(
      (line) =>
        line.target !== null && "section" in line.target && line.target.section === heading.section,
    ),
  );
  // Returns the line in full words, short ones or number keys, and its plain text, which says
  // whether it fits.
  const said = (words: "full" | "short" | "keys") => {
    const count = hiddenRows.length;
    const brief = words !== "full";
    const more = count === 0 ? [] : [brief ? `+${count}` : `${count} more${where}`];
    const parts = pinned.map((heading) => {
      const key = heading.section === "needs you" ? "!" : keyOf(heading.section);
      const named =
        words === "keys"
          ? `${key}:${heading.count}`
          : `${(brief ? shortNames : sectionNames)[heading.section]} ${heading.count}`;
      const waits = heading.section === "needs you";
      return { section: heading.section, named, waits };
    });
    const gap = { full: "   ", short: "  ", keys: " " }[words];
    const plain = ` ${arrow} ${[...more, ...parts.map(({ named }) => named)].join(gap)}`;
    const coloured = parts.map(({ named, waits }) => paint(waits ? yellow : grey, named));
    const items = [...more.map((text) => paint(grey, text)), ...coloured];
    // Each pinned heading's columns: after the arrow, then each item and the gap after it.
    let column = Bun.stringWidth(` ${arrow} `) + 1;
    for (const text of more) column += Bun.stringWidth(text) + gap.length;
    const spans = parts.map(({ section, named }) => {
      const size = Bun.stringWidth(named);
      const span = { from: column, to: column + size - 1, section };
      column += size + gap.length;
      return span;
    });
    return { plain, line: ` ${paint(grey, arrow)} ${items.join(gap)}`, spans };
  };
  const forms = [said("full"), said("short"), said("keys")];
  const fits = forms.find((form) => Bun.stringWidth(form.plain) <= width);
  const form = fits ?? forms[2];
  if (!form) return none;
  // A line cut to fit keeps only the headings whose whole name shows before its …
  const text = fits ? form.line : paint(grey, fitted(form.plain, width));
  const spans = fits ? form.spans : form.spans.filter((span) => span.to < width);
  return { text, row: null, target: { pinned: spans } };
}

// Returns the lead's row and the sections under it as lines, exactly `height` of them, on the row
// at `here`, for the list and for the screen's sidebar alike. The lead comes first, then its
// requests that wait for your yes, then a blank line, then every section's heading, each open one
// with its rows under it. `rows` are the rows that show: the lead's, its requests' and those of the
// open sections, in the order of the sections. The lead never scrolls, and its requests scroll with
// the sections. When the sections don't all fit, they scroll together, headings and rows, from the
// line `top`, so an open section's heading is always right above its rows, and a heading with none
// under it is closed. Then the first and last lines of the sections say what is hidden above and
// below, with the headings hidden there, so no section's count goes out of sight. The rows move
// only when the row you are on would leave the view. A row that is the first of its section brings
// its heading into view with it, so opening a section shows the heading over its rows. A view too
// short for those edge lines keeps only the row you are on, or its first line when even it doesn't
// fit. A heading among `rows` is one you can stand on: on it, its line is shaded. `focused` says
// whether your typing goes to the list. The screen's sidebar passes false while it goes to the
// agent beside it, and the row you are on then shows only the outline ▹, unshaded. Gives the lines,
// each at most `width` columns, what a click on each reaches, and the scroll they were drawn at,
// which the next draw starts from.
export function drawRows(
  rows: Row[],
  headings: Heading[],
  here: number,
  top: number,
  width: number,
  height: number,
  focused = true,
): { lines: string[]; targets: Target[]; top: number } {
  // The one-line rows' columns, from those rows alone, and the names' width, from every task's
  // and the lead's row. Headings are drawn from `headings`, so they take no column, and the
  // lead's requests show no name.
  const tasks = rows.filter((row) => row.part !== "heading" && row.part !== "request");
  const short = tasks.filter((row) => !tall(row));
  const widest = (of: (row: Row) => string, among = short) =>
    Math.max(...among.map((row) => Bun.stringWidth(of(row))), 0);
  const columns = {
    name: widest((row) => row.name, tasks),
    title: widest((row) => row.title),
    when: widest((row) => row.when),
  };
  // Returns the lines of the row at `i` in `rows`.
  const linesOf = (i: number) => {
    const row = rows[i];
    if (!row) return [];
    const pointer: Pointer = i !== here ? "none" : focused ? "lit" : "outline";
    if (row.part === "request") return [requestLine(row, pointer, width)];
    if (tall(row)) return tallLines(row, pointer, columns.name, width);
    return marked([shortLine(row, pointer, columns, width)], pointer === "lit", width);
  };
  // The section whose heading you are on, if you are on one.
  const onHeading = rows[here]?.part === "heading" ? rows[here]?.section : undefined;
  const countWidth = Math.max(...headings.map((heading) => String(heading.count).length), 1);
  // The lead is above the sections, and never scrolls. Its requests come right under it, at the
  // top of the sections' part, so however many wait they scroll with the sections, and the one
  // you are on stays in view. A blank line parts them from the first heading.
  const leadAt = rows.findIndex((row) => row.part === "lead");
  const requests = rows.flatMap((row, i) =>
    row.part === "request" ? linesOf(i).map((text) => ({ text, row: i, target: { row: i } })) : [],
  );
  const blankLine = { text: "", row: null, target: null };
  const leadLines = leadAt < 0 ? [] : linesOf(leadAt);
  const lead = leadAt < 0 ? [] : [...leadLines, ...(requests.length > 0 ? [] : [""])];
  const leadTargets: Target[] = lead.map((_, at) =>
    at < leadLines.length ? { row: leadAt } : null,
  );
  const room = Math.max(height - lead.length, 1);
  // Returns the requests and the sections' lines: each heading, with an open section's rows under
  // it. With `parted`, an open section with rows has a blank line after them, which parts it from
  // the next heading. The task queue always has one, open or closed, scrolled or not, as it is no
  // stage, so the stages under it read as one block.
  const sections = (parted: boolean): BodyLine[] => [
    ...requests,
    ...(requests.length > 0 ? [blankLine] : []),
    ...headings.flatMap((heading) => {
      const ours = rows.flatMap((row, i) =>
        row.section === heading.section && row.part !== "heading"
          ? linesOf(i).map((text) => ({ text, row: i, target: { row: i } }))
          : [],
      );
      const queue = heading.section === "task queue";
      const after = queue || (parted && ours.length > 0) ? [blankLine] : [];
      const plain = headingLine(heading, countWidth, width);
      const text = onHeading === heading.section ? shaded(plain, width) : plain;
      const line = { text, row: null, target: { section: heading.section } };
      return [line, ...ours, ...after];
    }),
  ];
  let body = sections(true);
  let shown = body;
  let start = 0;
  // Too many to fit: the blank lines go but the task queue's, and the sections scroll between the two edge lines, just
  // enough to keep the row you are on in view, from where they were last drawn.
  if (body.length > room) {
    body = sections(false);
    const edges = room >= 3;
    const view = edges ? room - 2 : room;
    start = Math.min(Math.max(top, 0), Math.max(body.length - view, 0));
    // The lines of the row you are on, or of the heading you are on.
    const isOwn = (line: BodyLine) =>
      line.row === here ||
      (line.row === null &&
        onHeading !== undefined &&
        line.target !== null &&
        "section" in line.target &&
        line.target.section === onHeading);
    const own = body.flatMap((line, at) => (isOwn(line) ? [at] : []));
    const first = own[0];
    const last = own.at(-1);
    if (first !== undefined && last !== undefined) {
      // The heading comes along when the row is its section's first and both fit.
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
    // Nor does it start on a blank line, which the top edge already parts from what is above, when
    // there is more below to show in its place.
    const blankFirst = body[start]?.row === null && body[start]?.target === null;
    const below = start < body.length - view;
    if (blankFirst && below && (first === undefined || start < first)) start += 1;
    // Returns a blank line of the body, which a click reaches nothing on.
    const edge = (text: string) => ({ text, row: null, target: null });
    // The view never ends on a heading whose rows are all below it, which would look closed. When
    // it is the heading you are on, the view goes down until a row of it shows, so the heading
    // stays where you see it, past a tall row's second line too. Any other heading goes past the
    // bottom edge instead, which pins it there, and a blank line takes its place.
    const endsOnHeading = (at: number) =>
      body[at + view - 1]?.row === null && (body[at + view]?.row ?? null) !== null;
    if (onHeading !== undefined && first === start + view - 1 && endsOnHeading(start)) {
      let moved = start + 1;
      while (
        moved < first &&
        body[moved]?.row !== null &&
        body[moved - 1]?.row === body[moved]?.row
      )
        moved += 1;
      if (moved <= first) start = moved;
    }
    let end = start + view;
    const ownAtEnd = onHeading !== undefined && first === start + view - 1;
    if (endsOnHeading(start) && !ownAtEnd) end -= 1;
    const visible = [...body.slice(start, end), ...(end < start + view ? [edge("")] : [])];
    shown = edges
      ? [
          edgeLine("↑", body.slice(0, start), rows, headings, width),
          ...visible,
          edgeLine("↓", body.slice(end), rows, headings, width),
        ]
      : visible;
  }
  const blank = Array.from({ length: room - shown.length }, () => "");
  // The blank lines reach nothing.
  return {
    lines: [...lead, ...shown.map((line) => line.text), ...blank],
    targets: [
      ...leadTargets,
      ...shown.map((line) => line.target),
      ...blank.map((): Target => null),
    ],
    top: start,
  };
}

// Returns the list as lines that fill the terminal, on the row at `here`. The top line comes
// first, then a notice when there is one, then a blank line, then the lead and the sections as
// drawRows lays them out, then the bottom line. A click on the top line reaches a tab, which
// tabAt finds by its column. Gives the lines, what a click on each reaches, so a click hits what
// it was drawn over, and the scroll they were drawn at, which the next draw starts from. Nothing
// is drawn in the terminal's last column: a terminal waits there to wrap, and clearing the rest
// of the line from that state erases the last character drawn. `pane` is the details pane's
// lines, which show on the right, beside every line but the top line and the bottom two, when
// the terminal is wide enough. The rows then take the columns left of it, and the top and bottom
// lines the whole width. The pane takes the same room on every row, so the list never moves as
// you do.
export function drawList(
  rows: Row[],
  headings: Heading[],
  here: number,
  top: number,
  frame: Frame,
  size: Size,
  pane: string[] | null = null,
): { lines: string[]; targets: Target[]; top: number } {
  const whole = size.width - 1;
  const beside = pane === null ? 0 : paneWidth(size.width);
  const width = beside > 0 ? whole - beside - paneEdge.length : whole;
  const notice = frame.notice ? [paint(yellow, fitted(` ${frame.notice}`, width))] : [];
  const head = [topParts(frame, whole).line, ...notice, ""];
  const drawn = drawRows(rows, headings, here, top, width, size.height - head.length - 2);
  // A question or a reason must stay on its one line, so it is cut to fit, and the load gives
  // way first.
  const bottom = fitted(` ${frame.bottom}`, whole);
  const load = frame.load;
  const gap = whole - Bun.stringWidth(bottom) - Bun.stringWidth(Bun.stripANSI(load));
  const last = gap > 1 ? `${paint(grey, bottom)}${" ".repeat(gap)}${load}` : paint(grey, bottom);
  // The pane goes beside every line between the top line and the bottom two, each of the list's
  // lines filled out to its width so the pane's edge stays straight.
  const middle = [...head.slice(1), ...drawn.lines, ""].map((line, at) =>
    beside > 0 && pane !== null
      ? `${filled(line, width)}${paint(grey, paneEdge)}${pane[at] ?? ""}`
      : line,
  );
  const lines = [head[0] ?? "", ...middle, last];
  // The head and the bottom two reach nothing.
  const targets: Target[] = [...head.map(() => null), ...drawn.targets, null, null];
  return { lines, targets, top: drawn.top };
}
