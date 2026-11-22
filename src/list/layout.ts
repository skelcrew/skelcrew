// The list as lines for your terminal: the top line with Skelcrew and every repository's tab, the
// lead's block that heads the repository, each section's heading in its colour with the rows of
// those that are open, and the bottom line with the keys and the machine's load. It reads
// nothing, so what you see can be tested without a terminal.
import { yesNo } from "../flow/inbox.ts";
import { letters } from "../flow/requests.ts";
import {
  amber,
  blue,
  bright,
  filled,
  fitted,
  green,
  grey,
  lightGrey,
  markColours,
  paint,
  purple,
  red,
  shade,
  shaded,
  tinted,
  white,
  yellow,
} from "../screen/look.ts";
import {
  type Ask,
  type Ci,
  type Heading,
  numbered,
  type Row,
  type Section,
  type Tab,
} from "./rows.ts";

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
// such as `changes · Editing rows.ts · #40 ✓ r2 · 4m`.
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

export function keysFor(row: Row | undefined, tabs: number, pane = false): string {
  const back = row?.tmux ? " · ctrl+\\ back" : "";
  const heading = row?.part === "heading";
  const enter = row?.more
    ? "⏎ show all"
    : row?.ask
      ? "⏎ open item"
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
  const now = row?.startNow ? ["f start now"] : [];
  const reorder = row?.section === "task queue" && row.place !== null ? ["shift+↑↓ reorder"] : [];
  const tab = tabs > 1 ? ["⇥/alt+shift+←→ repository"] : [];
  return [
    "↑↓ move",
    ...open,
    "0-6 sections",
    ...reorder,
    ...start,
    ...now,
    ...merge,
    ...tab,
    "q/esc quit",
  ].join("  ");
}

// Returns whether Enter on a row attaches to its agent: the lead, on its row or on its item about
// the repository, or a task's builder while it is
// at work, or once it is ready but needs you. On Backlog it starts the task, in the task queue it
// says what the task waits on, as no builder runs for it yet, and on Ready or Done it opens the PR.
export function enterAttaches(row: Row): boolean {
  if (row.part === "lead" || row.part === "ask") return true;
  if (row.section === "task queue") return false;
  const atWork = row.part !== "ready" && row.part !== "done";
  return (atWork || row.needsYou) && row.session !== null;
}

// The colour of each section that has one, which its heading and its tasks' marks share, so the
// stages sort at a glance. Needs you is the yellow of its marks. The task queue and Backlog only
// wait, so they keep the theme's own text. Every heading and mark reads without colour too.
const sectionColours: Partial<Record<Section, string>> = {
  "needs you": yellow,
  building: blue,
  reviewing: purple,
  checks: amber,
  ready: green,
  done: grey,
};

// The spinner on the mark of an agent at work, one frame after another. The list draws its first
// frame, and the screen's sidebar turns it.
export const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const still = spinner.slice(0, 1);

// The widest section name, so every heading's count starts in the same column.
const sectionNameWidth = Math.max(...Object.values(sectionNames).map((name) => name.length));

// Returns the number key that opens and closes a section, as its heading shows it. Needs you has
// none, as it never closes, since it is where you must look, so its key's place is blank.
const keyOf = (section: Section) =>
  section === "needs you" ? " " : String(numbered.indexOf(section));

// Returns a section's heading as a line: the number key that opens and closes it, dim, then its
// name in its section's colour, bold while open, or bright while open and dim while closed for a
// section without a colour, then how many tasks it
// has, lined up under the other headings' counts, such as `2 Building  4`. Needs you's count is yellow, as it shows only
// while a task waits on you. Task queue then says dim how full the builders are, such as `Building
// 4/4 · 3 queued`, which goes first on a narrow terminal. Cut to fit, without its colours, on a
// terminal narrower still.
function headingLine(heading: Heading, countWidth: number, width: number): string {
  const key = keyOf(heading.section);
  const name = sectionNames[heading.section].padEnd(sectionNameWidth);
  const count = String(heading.count).padStart(countWidth);
  const plain = ` ${key} ${name} ${count}`;
  if (Bun.stringWidth(plain) > width) return fitted(plain, width);
  const colour = sectionColours[heading.section];
  const shown = paint(heading.open ? (colour ? `1;${colour}` : bright) : (colour ?? grey), name);
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
// or Ready, or under Needs you. Backlog and Done take one.
const tall = (row: Row) =>
  row.section === "needs you" || (row.part !== "backlog" && row.part !== "done");

// What a line of an item answers when tapped: one of its options, or a reply in your own words.
export type Pick = (typeof letters)[number] | "reply";

// Returns what a row's second line says of how its item is answered: y/n for a yes or no item,
// or how many options it has.
const answeredBy = (ask: Ask) =>
  Bun.deepEquals(ask.options, yesNo) ? "y/n" : `${ask.options.length} options`;

// Returns an item in a box `width` columns wide, drawn with box-drawing characters in the
// colour of the screen's other edges: its short title, its whole text, then each option by its
// letter, then the line for a reply on the lead's item, each wrapped to the box, never cut, with
// what tapping each line answers. The details pane and an item opened full-size both show it.
export function itemBox(ask: Ask, width: number): { text: string; pick: Pick | null }[] {
  const room = Math.max(width - 4, 1);
  const wrapped = (text: string) =>
    text.split("\n").flatMap((part) => Bun.wrapAnsi(part, room, { hard: true }).split("\n"));
  const inside = (code: string | null, line: string, pick: Pick | null = null) => ({
    text: `${paint(grey, "│")} ${filled(code === null ? line : paint(code, line), room)} ${paint(grey, "│")}`,
    pick,
  });
  const options = ask.options.flatMap((option, at) => {
    const letter = letters[at];
    if (letter === undefined) return [];
    return wrapped(`${letter}) ${option}`).map((line) => inside(null, line, letter));
  });
  const reply =
    ask.acts === null ? wrapped("r) reply").map((line) => inside(grey, line, "reply")) : [];
  const edge = (left: string, right: string) => ({
    text: paint(grey, `${left}${"─".repeat(room + 2)}${right}`),
    pick: null,
  });
  return [
    edge("┌", "┐"),
    ...wrapped(ask.title).map((line) => inside(bright, line)),
    inside(null, ""),
    ...wrapped(ask.text).map((line) => inside(null, line)),
    inside(null, ""),
    ...options,
    ...reply,
    edge("└", "┘"),
  ];
}

// What an item opened full-size says on a screen too short to show it.
export const tooShort = "make the screen taller to read this item";

// Returns the lead's item on `row`, the row at `here`, opened full-size in a place `width` columns
// wide and `height` tall, scrolled `scroll` lines down: what it is about, then its whole text, its
// options and the reply line, with what tapping each line answers. However long the item and
// however short the screen, scrolling reaches every line: by the keys or the wheel, or by a tap on
// the `↑ more` or `↓ more` line at its top or bottom edge, which scrolls a page, for a screen with
// taps alone. A screen under 3 lines tall has no room for those, so it says only to make the
// screen taller, and nothing on it answers. Gives the scroll as far as it can go, for the next
// draw.
export function drawItem(
  row: Row,
  here: number,
  width: number,
  height: number,
  scroll: number,
): { lines: string[]; targets: Target[]; scroll: number } {
  if (row.ask === null) return { lines: [], targets: [], scroll: 0 };
  const about = fitted(`${row.label}  ${row.title}`.trimEnd(), Math.max(width - 3, 1));
  const box = itemBox(row.ask, Math.max(width - 4, 5)).map((line) => ({
    ...line,
    text: `   ${line.text}`,
  }));
  const all = [
    { text: `   ${paint(bright, about)}`, pick: null },
    { text: "", pick: null },
    ...box,
  ];
  if (height < 3) {
    const lines = [`   ${fitted(tooShort, Math.max(width - 3, 1))}`, ""].slice(0, height);
    return { lines, targets: lines.map((): Target => null), scroll: 0 };
  }
  const edges = all.length > height;
  const view = edges ? height - 2 : height;
  const at = Math.min(Math.max(scroll, 0), Math.max(all.length - view, 0));
  const shown = all.slice(at, at + view);
  const edge = (more: boolean, sign: string, by: number) =>
    more
      ? { text: `   ${paint(grey, `${sign} more`)}`, target: { scroll: by } }
      : { text: "", target: null };
  const above = edges ? [edge(at > 0, "↑", -view)] : [];
  const below = edges ? [edge(at + view < all.length, "↓", view)] : [];
  const body = shown.map((line) => ({
    text: line.text,
    target: line.pick === null ? null : { row: here, pick: line.pick },
  }));
  const blank = Array.from({ length: view - shown.length }, () => ({ text: "", target: null }));
  const drawn: { text: string; target: Target }[] = [...above, ...body, ...blank, ...below];
  return {
    lines: drawn.map((line) => line.text),
    targets: drawn.map((line) => line.target),
    scroll: at,
  };
}

// Returns the row you are on as `lines`, shaded across the width, or as they are on another row.
const marked = (lines: string[], here: boolean, width: number) =>
  here ? lines.map((line) => shaded(line, width)) : lines;

// What starts the first line of a row: ▸ on the row you are on, and blank on the others.
const pointer = (here: boolean) => (here ? " ▸ " : "   ");

// Returns the colour of a task's mark: yellow, red or green as its state says, or else the
// colour of the stage it shows under.
function markColour(row: Row): string {
  const { colour } = row.mark;
  const stage = row.section === row.part && row.section !== "lead" ? row.section : null;
  const own = stage === null ? undefined : sectionColours[stage];
  return colour === "bright" || colour === "dim"
    ? (own ?? markColours[colour])
    : markColours[colour];
}

// Returns the start of a row's first line: its pointer, then its mark.
const markStart = (row: Row, here: boolean) =>
  `${pointer(here)}${tinted(here, markColour(row), row.mark.sign)}`;

// Returns a row in Backlog or Done as one line, in columns from the left: its mark, its name,
// its title, cut with … when it doesn't fit, then when it changed, dim. The title's column is as
// wide as the widest title, or what is left, so the times line up. A row whose name and time
// alone are too wide is cut to fit, without its colours, as a longer line would wrap.
function shortLine(row: Row, here: boolean, columns: Columns, width: number): string {
  const start = `${pointer(here)}${row.mark.sign} `;
  const name = filled(row.label, columns.name);
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

// The mark of what a task's CI says, each in its colour, and of a different shape, so it reads
// without colours too.
const ciMarks: Record<Ci, { sign: string; code: string }> = {
  passed: { sign: "✓", code: green },
  running: { sign: "●", code: yellow },
  failed: { sign: "✗", code: red },
};

// The word of a task that only says what the heading of its stage says already.
const stageWords: Partial<Record<Row["part"], string>> = {
  building: "working",
  reviewing: "reviewing",
  checks: "checks",
};

// Returns the lead's row, or a task's in Building, Reviewing, Checks or Ready, as its two lines,
// so what it does sits under its title. The first line has its mark, its name, padded to
// `nameWidth` so the titles line up, and its title. The second has its word in its colour,
// unless its stage already says it, then dim the step its builder is on and its PR, then its
// CI's mark and its review's round, each in the colour of where it stands, then dim when it last
// changed, such as `changes · Editing rows.ts · #40 ✓ r2 · 4m`, each left out where it has
// none. Each line is cut with … to fit, and the row you are on is shaded on both its lines.
function tallLines(row: Row, here: boolean, nameWidth: number, width: number): string[] {
  const plainStart = `${pointer(here)}${row.mark.sign} `;
  const indent = " ".repeat(Bun.stringWidth(plainStart));
  const room = Math.max(width - indent.length, 0);
  // The first line: on a terminal too narrow for the mark, it is cut without its colours.
  const named = `${filled(row.label, Math.min(nameWidth, room))}  ${row.title}`;
  const top = fitted(named, room);
  const first =
    width < indent.length
      ? fitted(`${plainStart}${top}`, width)
      : `${markStart(row, here)} ${here ? tinted(here, bright, top) : top}`;
  // The PR, CI and review go together, apart only by spaces, such as `#40 ✓ r2`.
  const ci = row.ci === null ? [] : [ciMarks[row.ci]];
  const review = row.review
    ? [{ sign: `r${row.review.round}`, code: markColours[row.review.colour] }]
    : [];
  const pr = [...(row.pr ? [{ sign: row.pr, code: grey }] : []), ...ci, ...review].flatMap(
    (piece, at) => (at === 0 ? [piece] : [{ sign: " ", code: grey }, piece]),
  );
  // A word the stage's heading already says, such as working under Building, is left out. The
  // step its builder is on then comes first, in the word's colour, as what is happening beyond
  // the stage. Under Needs you or Task queue the word is what the row is there for, so it stays.
  // A row with an item says instead the item's short title and how it is answered.
  const repeats = row.section === row.part && stageWords[row.part] === row.says;
  const said = row.ask
    ? [
        [{ sign: row.ask.title, code: markColours[row.colour] }],
        [{ sign: answeredBy(row.ask), code: grey }],
      ]
    : [
        [{ sign: repeats ? "" : row.says, code: markColours[row.colour] }],
        [{ sign: row.step, code: repeats ? markColours[row.colour] : grey }],
        pr,
        [{ sign: row.when, code: grey }],
      ];
  const groups = said.filter((group) => group.some((piece) => piece.sign));
  const pieces = groups.flatMap((group, at) =>
    at === 0 ? group : [{ sign: " · ", code: grey }, ...group],
  );
  // The line is cut as plain text, then each piece takes its part of what is left, in its
  // colour, so the … lands where the cut does. Pieces of one colour side by side go as one.
  let doing = fitted(pieces.map((piece) => piece.sign).join(""), room);
  const cut: { sign: string; code: string }[] = [];
  for (const { sign, code } of pieces) {
    const part = doing.slice(0, sign.length);
    doing = doing.slice(sign.length);
    const last = cut.at(-1);
    if (last && last.code === code) last.sign += part;
    else if (part) cut.push({ sign: part, code });
  }
  const second = `${indent}${cut.map(({ sign, code }) => tinted(here, code, sign)).join("")}`;
  const lines = [first, second].map((line) =>
    width < indent.length ? fitted(Bun.stripANSI(line), width) : line,
  );
  return marked(lines, here, width);
}

// What a click on a line of the list reaches: a row, by its place in the rows, which is the
// lead's or a task's, with `pick` on a line of its item that answers it, a section's heading, a
// number of lines to scroll an item open full-size by, or nothing, such as on a blank line or an
// edge.
// On an edge line, a click reaches the heading pinned at its column: `pinned` has each one's
// columns, counted from 1 as your terminal counts a click.
export type Pinned = { from: number; to: number; section: Section };
export type Target =
  | { row: number; pick?: Pick }
  | { section: Section }
  | { pinned: Pinned[] }
  | { scroll: number }
  | null;

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

// Where a spinner is drawn: its line and column, counted from 0, and the cell as drawn, its frame
// the spinner's first, in its colours and the row's background.
export type Spin = { line: number; column: number; cell: string };

// Returns the lead's block, which heads the list as the repository's header. Its first line is
// `◆ Lead · Claude Code`, its harness, with its mark and state on the right, such as `○ idle`.
// Its title is cut first to fit. The second says what the lead is doing while it works. Then a
// line across, a line of how many tasks are where, such as `9 running · 2 ready · 1 needs you`,
// with only those that have any. Running are those whose builder is at work this moment, and a
// task waiting only for you to merge it counts as ready, though it shows under Needs you. Then a
// blank line. Gives the lines, and where its mark is. On a place too short for all of them, its
// last lines give way, so the row you are on still shows.
function leadBlock(
  row: Row,
  here: boolean,
  headings: Heading[],
  width: number,
): { lines: string[]; mark: Spin | null } {
  const start = pointer(here);
  const colour = markColours[row.mark.colour];
  const state = `${row.mark.sign} ${row.says}`;
  const room = width - Bun.stringWidth(start) - Bun.stringWidth(state) - 2;
  const title = fitted(row.title ? ` · ${row.title}` : "", room - "◆ Lead".length);
  let first = fitted(`${start}◆ Lead  ${state}`, width);
  let mark: Spin | null = null;
  if (room >= "◆ Lead".length) {
    const gap = " ".repeat(room + 2 - "◆ Lead".length - Bun.stringWidth(title));
    const sign = tinted(here, colour, row.mark.sign);
    const column = width - Bun.stringWidth(state);
    mark = { line: 0, column, cell: here ? `\x1b[${shade}m${sign}\x1b[49m` : sign };
    first = `${start}${tinted(here, bright, "◆ Lead")}${tinted(here, grey, title)}${gap}${sign} ${tinted(here, colour, row.says)}`;
  }
  const indent = " ".repeat(Bun.stringWidth(start) + 2);
  const step = fitted(row.step, width - indent.length);
  const second = step ? `${indent}${tinted(here, colour, step)}` : "";
  const count = (section: Section) =>
    headings.find((heading) => heading.section === section)?.count ?? 0;
  const merges = headings.find((heading) => heading.section === "needs you")?.merges ?? 0;
  const running = headings.reduce((sum, heading) => sum + heading.working, 0);
  const parts = [
    { count: running, word: "running", code: "" },
    { count: count("ready") + merges, word: "ready", code: green },
    { count: count("needs you") - merges, word: "needs you", code: yellow },
  ].filter((part) => part.count > 0);
  const said = parts.map((part) => `${part.count} ${part.word}`);
  const plain = `   ${said.join(" · ") || "nothing under way"}`;
  const summary =
    Bun.stringWidth(plain) > width || parts.length === 0
      ? paint(grey, fitted(plain, width))
      : `   ${parts
          .map(({ code }, at) => (code ? paint(code, said[at] ?? "") : (said[at] ?? "")))
          .join(paint(grey, " · "))}`;
  return {
    lines: [...marked([first, second], here, width), paint(grey, "─".repeat(width)), summary, ""],
    mark: row.working ? mark : null,
  };
}

// Returns the lead and the rows as lines for a place `width` columns wide and `height` tall,
// scrolled from `top`, on the row at `here`. With `spin`, the mark of an agent at work is the
// spinner's first frame, and `spins` says where each is, so the screen's sidebar can turn them
// alone. A blank line parts Needs you from the stages, which follow one another with none.
export function drawRows(
  shownRows: Row[],
  headings: Heading[],
  here: number,
  top: number,
  width: number,
  height: number,
  spin = false,
): { lines: string[]; targets: Target[]; top: number; spins: Spin[] } {
  const rows = spin
    ? shownRows.map((row) => (row.working ? { ...row, mark: { ...row.mark, sign: still } } : row))
    : shownRows;
  const tasks = rows.filter((row) => row.part !== "heading" && row.part !== "lead");
  const short = tasks.filter((row) => !tall(row));
  const widest = (of: (row: Row) => string, among = short) =>
    Math.max(...among.map((row) => Bun.stringWidth(of(row))), 0);
  const columns = {
    name: widest((row) => row.label, tasks),
    title: widest((row) => row.title),
    when: widest((row) => row.when),
  };
  const linesOf = (i: number): { text: string; pick: Pick | null }[] => {
    const row = rows[i];
    if (!row) return [];
    const on = i === here;
    const plain = (lines: string[]) => lines.map((text) => ({ text, pick: null }));
    if (tall(row)) return plain(tallLines(row, on, columns.name, width));
    return plain(marked([shortLine(row, on, columns, width)], on, width));
  };
  const onHeading = rows[here]?.part === "heading" ? rows[here]?.section : undefined;
  const countWidth = Math.max(...headings.map((heading) => String(heading.count).length), 1);
  const leadAt = rows.findIndex((row) => row.part === "lead");
  const blankLine = { text: "", row: null, target: null };
  const leadRow = rows[leadAt];
  const block = leadRow ? leadBlock(leadRow, leadAt === here, headings, width) : null;
  const lead = (block?.lines ?? []).slice(0, Math.max(height - 1, 0));
  const leadTargets: Target[] = lead.map((_, at) => (at < 2 ? { row: leadAt } : null));
  const room = Math.max(height - lead.length, 1);
  const sections = (parted: boolean): BodyLine[] =>
    headings.flatMap((heading) => {
      const ours = rows.flatMap((row, i) =>
        row.section === heading.section && row.part !== "heading"
          ? linesOf(i).map(({ text, pick }) => ({
              text,
              row: i,
              target: pick === null ? { row: i } : { row: i, pick },
            }))
          : [],
      );
      const inbox = parted && heading.section === "needs you" && ours.length > 0;
      const after = inbox ? [blankLine] : [];
      const plain = headingLine(heading, countWidth, width);
      const text = onHeading === heading.section ? shaded(plain, width) : plain;
      const line = { text, row: null, target: { section: heading.section } };
      return [line, ...ours, ...after];
    });
  let body = sections(true);
  let shown = body;
  let start = 0;
  if (body.length > room) {
    body = sections(false);
    const edges = room >= 3;
    const view = edges ? room - 2 : room;
    start = Math.min(Math.max(top, 0), Math.max(body.length - view, 0));
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
      const above = body[first - 1];
      const from = above && above.row === null && last - first + 2 <= view ? first - 1 : first;
      start = Math.min(start, from);
      start = Math.max(start, last - view + 1);
      start = Math.min(start, first);
    }
    const cut = body[start];
    const atRowEnd = cut && cut.row !== null && body[start - 1]?.row === cut.row;
    if (atRowEnd && (first === undefined || start < first)) start += 1;
    const blankFirst = body[start]?.row === null && body[start]?.target === null;
    const below = start < body.length - view;
    if (blankFirst && below && (first === undefined || start < first)) start += 1;
    const edge = (text: string) => ({ text, row: null, target: null });
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
  const spins = shown.flatMap((line, at): Spin[] => {
    const row = line.row === null ? undefined : rows[line.row];
    if (!spin || !row?.working || [...Bun.stripANSI(line.text)][3] !== still) return [];
    const sign = tinted(line.row === here, markColour(row), still);
    const cell = line.row === here ? `\x1b[${shade}m${sign}\x1b[49m` : sign;
    return [{ line: lead.length + at, column: 3, cell }];
  });
  return {
    spins: [...(spin && block?.mark && lead.length > 0 ? [block.mark] : []), ...spins],
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
// you do. With `item`, the scroll of the lead's item you opened on the row at `here`, that item
// shows full-size in place of the lead and the sections, as drawItem lays it out, and `item` comes
// back as far as it could scroll.
export function drawList(
  rows: Row[],
  headings: Heading[],
  here: number,
  top: number,
  frame: Frame,
  size: Size,
  pane: string[] | null = null,
  item: number | null = null,
): { lines: string[]; targets: Target[]; top: number; item: number | null } {
  const whole = size.width - 1;
  const beside = pane === null ? 0 : paneWidth(size.width);
  const width = beside > 0 ? whole - beside - paneEdge.length : whole;
  const notice = frame.notice ? [paint(yellow, fitted(` ${frame.notice}`, width))] : [];
  const head = [topParts(frame, whole).line, ...notice, ""];
  const room = size.height - head.length - 2;
  const opened = rows[here];
  const read = item !== null && opened?.ask ? drawItem(opened, here, width, room, item) : null;
  const drawn = read
    ? { lines: read.lines, targets: read.targets, top }
    : drawRows(rows, headings, here, top, width, room);
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
  return { lines, targets, top: drawn.top, item: read?.scroll ?? null };
}
