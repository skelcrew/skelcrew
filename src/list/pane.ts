// The details pane beside the list, as lines for your terminal: the row you are on, with its
// task's details at the top and its agent at work, live, below them. It reads nothing, so what
// it shows can be tested without a terminal.
import type { TaskView } from "../flow/list.ts";
import {
  bright,
  fitted,
  green,
  grey,
  lightGrey,
  markColours,
  paint,
  red,
  removeControlCodes,
  yellow,
} from "../screen/look.ts";
import type { Details } from "./details.ts";
import { sectionNames } from "./layout.ts";
import type { Row } from "./rows.ts";

// The live view's part of the pane: the agent's screen as its session host gave it, colours
// included, or a short line saying why there is none, such as `Builder not running`.
export type Live = { screen: string } | { note: string };

// How many findings show, and how many lines the events take at most, as both are in short.
const findingsShown = 3;
const eventLines = 2;

// Returns text wrapped at word breaks to `width` columns, at most `most` lines, the last one
// ending in … when there was more. A word wider than the pane, such as a link, is broken.
function folded(text: string, width: number, most = Number.POSITIVE_INFINITY): string[] {
  if (width <= 0) return [];
  const lines = Bun.wrapAnsi(text, width, { hard: true }).split("\n");
  if (lines.length <= most) return lines;
  const kept = lines.slice(0, most);
  kept[most - 1] = fitted(`${kept[most - 1] ?? ""}…`, width);
  return kept;
}

// The mark each state of a CI check takes, in its colour.
const checkMarks: Record<NonNullable<TaskView["prPage"]>["checks"][number]["state"], string> = {
  passed: paint(green, "✓"),
  failed: paint(red, "✗"),
  running: paint(yellow, "●"),
  cancelled: paint(grey, "–"),
};

// The colour CI's verdict as a whole takes, as the list shows it.
const ciColours: Record<NonNullable<TaskView["prPage"]>["ci"], string> = {
  passed: green,
  running: yellow,
  failed: red,
  none: grey,
};

// The colour each state of a review takes on the pane's round line, as the list shows it.
const reviewColours: Record<NonNullable<TaskView["review"]>["state"], string> = {
  none: grey,
  reviewing: yellow,
  approved: green,
  changes: yellow,
  failed: red,
  "not reviewed": grey,
};

// Returns text that opens `url` when clicked in a terminal that supports links, and shows as the
// text alone in one that doesn't. A link broken over lines is a link on each of them. The link
// comes from the forge or the tracker, so its control codes were taken out before it got here.
const linked = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

// What each state of a review says on the pane's round line.
const reviewWords: Record<NonNullable<TaskView["review"]>["state"], string> = {
  none: "",
  reviewing: "reviewing",
  approved: "approved",
  changes: "changes asked",
  failed: "review failed",
  "not reviewed": "not reviewed",
};

// Returns items as lines `width` columns wide at most, as many on each line as fit, with two
// spaces between them, so none is left out. Each item is its plain text and how it shows, in
// colour. An item wider than a line alone is cut, without its colours.
function packed(items: { plain: string; shown: string }[], width: number): string[] {
  const lines: { plain: string; shown: string }[] = [];
  for (const item of items) {
    const last = lines.at(-1);
    if (last && Bun.stringWidth(`${last.plain}  ${item.plain}`) <= width) {
      last.plain += `  ${item.plain}`;
      last.shown += `  ${item.shown}`;
    } else if (Bun.stringWidth(item.plain) <= width) lines.push({ ...item });
    else lines.push({ plain: fitted(item.plain, width), shown: fitted(item.plain, width) });
  }
  return lines.map((line) => line.shown);
}

// Returns a task's description as lines `width` columns wide at most, as it was written: its own
// line breaks kept, and each run of blank lines made one. A long line wraps at word breaks, and
// a list item's lines after its first start under its text, past its indent and its marker, such
// as `- ` or `2. `, so a list in the description still reads as one.
function describedLines(body: string, width: number): string[] {
  if (body.trim() === "") return [];
  const lines = body
    .trim()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, i, all) => line !== "" || all[i - 1] !== "");
  return lines.flatMap((line) => {
    if (line === "") return [""];
    // An indent wider than half the pane would leave the item too little room, so it wraps
    // from the pane's edge instead.
    const found = /^ *(?:(?:[-*+]|\d+[.)]) +)?/.exec(line)?.[0] ?? "";
    const indent = found.length * 2 <= width ? found : "";
    const pieces = folded(line.slice(indent.length), width - indent.length);
    return pieces.map((piece, i) => `${i === 0 ? indent : " ".repeat(indent.length)}${piece}`);
  });
}

// Returns the details of a task as lines `width` columns wide at most, from the top: its full
// title, its issue's and PR's links, its stage and word, what it waits on when it is up next,
// its CI with each check, its armed merge, its review round with the verdict and the findings in
// short, its whole description, and its recent events. Each part is left out where the task has
// none.
function detailLines(row: Row, details: Details, width: number): string[] {
  const { view, findings, events } = details;
  const cut = (text: string) => fitted(text, width);
  const title = folded(view.title, width).map((line) => paint(bright, line));
  // The links, each after a dim label and its number, lined up, and each one a terminal link. A
  // link too long for that line goes on the lines after, broken where it reaches the edge, so it
  // can always be read whole.
  const issue = view.issue ? [["issue", view.issue.id, view.issue.link ?? ""]] : [];
  // A PR that left the forge's copy, such as a merged one, still has the link saved on its row.
  const prLink = view.prPage?.link ?? row.link ?? "";
  const pr = view.pr === null ? [] : [["PR", `#${view.pr}`, prLink]];
  const links = [...issue, ...pr].flatMap(([label = "", id = "", given = ""]) => {
    // A link holding control codes could end the terminal link early and send your terminal
    // codes of its own, so they go, as spaces.
    const link = removeControlCodes(given);
    const named = cut(`${label.padEnd(6)}${id}`);
    const start = `${paint(grey, named.slice(0, 6))}${named.slice(6)}`;
    if (!link) return [start];
    if (Bun.stringWidth(`${named}  ${link}`) <= width) return [`${start}  ${linked(link, link)}`];
    return [start, ...folded(link, width).map((piece) => linked(link, piece))];
  });
  // The stage and the row's word, in its colour, such as `Building · question`, or cut without
  // its colours when too wide. A task up next says so, as its section says more than its stage.
  // Then what it waits on, such as `3rd in line: 4 of 4 builders busy`, wrapped whole, as the
  // reason the queue is held, or the command that brings a paused task back, comes last.
  const stage =
    row.part === "lead" || row.part === "request"
      ? ""
      : sectionNames[row.section === "up next" ? "up next" : row.part];
  const word = row.says ? ` · ${row.says}` : "";
  const staged =
    Bun.stringWidth(`${stage}${word}`) <= width
      ? `${paint(bright, stage)}${paint(markColours[row.colour], word)}`
      : cut(`${stage}${word}`);
  // CI as a whole, its verdict in colour after a dim label, then each check with its mark, going on
  // over as many lines as they need.
  const page = view.prPage;
  const colon = page?.checks.length ? ":" : "";
  const summary = {
    plain: page ? `CI ${page.ci}${colon}` : "",
    shown: page ? `${paint(grey, "CI")} ${paint(ciColours[page.ci], page.ci)}${colon}` : "",
  };
  const items = (page?.checks ?? []).map((check) => ({
    plain: `${check.name} ${Bun.stripANSI(checkMarks[check.state])}`,
    shown: `${check.name} ${checkMarks[check.state]}`,
  }));
  const ci = page ? packed([summary, ...items], width) : [];
  const merge = view.merge === null ? [] : [cut(view.merge)];
  // The review's round, dim, and its verdict in colour, then what it found, each finding on one
  // line.
  const review = view.review;
  const said = review && review.state !== "none" ? reviewWords[review.state] : "";
  const round = typeof review?.round === "number" ? `Round ${review.round} · ` : "";
  const roundShown =
    review && Bun.stringWidth(`${round}${said}`) <= width
      ? `${round ? paint(grey, round) : ""}${paint(reviewColours[review.state], said)}`
      : cut(`${round}${said}`);
  const rounds = said ? [roundShown] : [];
  const more = findings.length - findingsShown;
  const found = [
    ...findings.slice(0, findingsShown).map((finding) => cut(`  - ${finding}`)),
    ...(more > 0 ? [paint(grey, cut(`  … ${more} more`))] : []),
  ];
  // The description, whole and dimmer than the rest.
  const described = describedLines(view.body, width).map((line) => paint(lightGrey, line));
  const happened = events.length
    ? folded(events.join(" · "), width, eventLines).map((line) => paint(grey, line))
    : [];
  // Returns the parts that have something, with a blank line between each.
  const parts = [
    [...title, ...links],
    [staged, ...(row.waits ? folded(row.waits, width) : []), ...ci, ...merge, ...rounds, ...found],
    described,
    happened,
  ].filter((part) => part.length > 0);
  return parts.flatMap((part, i) => (i === 0 ? part : ["", ...part]));
}

// Returns text from an agent's screen safe to show, its colours kept: every escape sequence but
// those that set colours and styles is dropped, and so is every other control code, so nothing
// on the agent's screen can move the cursor or change your terminal.
function keepColours(line: string): string {
  const esc = "\x1b";
  // A terminal's string, such as a link, ended by ST or BEL, then a CSI sequence, then Esc with
  // one character, then any other control code.
  const sequences = new RegExp(
    `${esc}[P\\]X^_][\\s\\S]*?(?:${esc}\\\\|\\x07)|${esc}\\[[0-?]*[ -/]*[@-~]|${esc}[\\s\\S]?|\\p{Cc}`,
    "gu",
  );
  const colours = new RegExp(`^${esc}\\[[0-9;:]*m$`);
  return line.replace(sequences, (found) => (colours.test(found) ? found : ""));
}

// Returns the bottom of an agent's screen as `count` lines, `width` columns wide at most. Blank
// lines at the very bottom are left out first, as a screen not yet full has them below its
// prompt. Each line is cut on the right rather than wrapped, so a line of the agent's stays one
// line, and it ends by resetting colours, so none reaches the pane's edge or the list. A colour
// set on one line goes on over the lines after it until reset, as a host can send a screen that
// way, so each line starts with the colours still set from the lines above it, shown or not.
// `packed` leaves out the blank lines between the agent's, so a few lines show as much as they
// can.
function screenLines(screen: string, width: number, count: number, packed = false): string[] {
  if (count <= 0) return [];
  const lines = screen.replace(/\n$/, "").split("\n").map(keepColours);
  while (lines.length > 0 && Bun.stripANSI(lines.at(-1) ?? "").trim() === "") lines.pop();
  // The colour codes set since the last reset, carried from line to line. A code whose first
  // number is 0 or missing resets first, such as ESC[m, ESC[0m or ESC[0;31m, and then sets what
  // follows it, if anything.
  const esc = "\x1b";
  const codes = new RegExp(`${esc}\\[([0-9;:]*)m`, "g");
  let carried = "";
  const coloured = lines.map((line) => {
    const shown = carried + line;
    for (const [code, numbers = ""] of line.matchAll(codes)) {
      const [first = "", ...rest] = numbers.split(";");
      if (!/^0*$/.test(first)) carried += code;
      else carried = rest.length > 0 ? code : "";
    }
    return shown;
  });
  const kept = packed ? coloured.filter((line) => Bun.stripANSI(line).trim() !== "") : coloured;
  return kept.slice(-count).map((line) => `${Bun.sliceAnsi(line, 0, width)}\x1b[0m`);
}

// The lines the live view always keeps under the details: the dim line over it and two of the
// agent's screen, or the one that says why there is none.
const liveLeast = 3;

// How many of the agent's last lines the live view shows while it is a strip, as it is unless you
// ask for the whole of it, so the details have the rest of the pane.
const stripLines = 3;

// What the pane drew: its lines, how far its details are scrolled, which is never past their end,
// and how many lines of them it has room for, so a key can scroll a page.
export type Pane = { lines: string[]; scroll: number; room: number };

// Returns the pane for the row you are on as exactly `height` lines, each `width` columns wide at
// most. On a row that isn't a task, such as the lead's, it is empty. Otherwise the task's details
// come first, then a dim line, then its agent's live screen, or the line that says why there is
// none. The live screen is a strip of the agent's last few lines, without blank ones, or, when
// `full`, as much of its screen as fills the rest. The details take what they need, but always
// leave the live view its lines, and while it shows the whole screen they take half the pane at
// most. Details taller than their room scroll, `scroll` lines down from their top, and a dim
// `↓ more` on their last line says there is more below, unless they have only that line. The
// strip always sits at the bottom of the pane, whatever the details' length, so it never moves
// as they change or scroll.
export function drawPane(
  row: Row | undefined,
  details: Details | null,
  live: Live | null,
  width: number,
  height: number,
  full = false,
  scroll = 0,
): Pane {
  const blank = (count: number) => Array.from({ length: Math.max(count, 0) }, () => "");
  // A request of the lead's has no details: the lead's screen fills the pane.
  if (row?.part === "request" && live !== null) {
    const shown =
      "note" in live
        ? [paint(grey, fitted(live.note, width))]
        : screenLines(live.screen, width, height, false);
    return { lines: [...shown, ...blank(height)].slice(0, height), scroll: 0, room: 0 };
  }
  if (!row || details === null) return { lines: blank(height), scroll: 0, room: 0 };
  const least = full ? liveLeast : stripLines + 1;
  const room = Math.max(
    live === null
      ? height
      : full
        ? Math.min(Math.ceil(height / 2), height - least)
        : height - least,
    0,
  );
  // The details from `scroll` down, as many as fit, the last line saying when more are below.
  const all = detailLines(row, details, width);
  const farthest = Math.max(all.length - room, 0);
  const at = Math.min(Math.max(scroll, 0), farthest);
  // With a single line of room, it shows the details rather than say there are more.
  const more = room > 1 && at < farthest ? [paint(grey, fitted("↓ more", width))] : [];
  const top = [...all.slice(at, at + room - more.length), ...more];
  const drawn = (lines: string[]) => ({ lines: lines.slice(0, height), scroll: at, room });
  if (live === null) return drawn([...top, ...blank(height - top.length)]);
  // Blank lines push the strip down to the bottom. The whole screen fills the rest anyway, so
  // over it one blank line parts it from the details, when there is room.
  const gap = full ? (height - top.length > least ? [""] : []) : blank(room - top.length);
  const rule = paint(grey, "─".repeat(width));
  const left = height - top.length - gap.length - 1;
  const shown = full ? left : Math.min(left, stripLines);
  const below =
    "note" in live
      ? [paint(grey, fitted(live.note, width))]
      : screenLines(live.screen, width, shown, !full);
  return drawn([...top, ...gap, rule, ...below, ...blank(height)]);
}
