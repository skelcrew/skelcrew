// The details pane beside the list, as lines for your terminal: the row you are on, with its
// task's details at the top and its agent at work, live, below them. It reads nothing, so what
// it shows can be tested without a terminal.
import type { TaskView } from "../flow/list.ts";
import {
  bright,
  fitted,
  green,
  grey,
  markColours,
  paint,
  red,
  removeControlCodes,
  yellow,
} from "../screen/look.ts";
import type { Details } from "./details.ts";
import { sectionNames } from "./layout.ts";
import { markdownLines } from "./markdown.ts";
import type { Row } from "./rows.ts";

// The live view's part of the pane: the agent's screen as its session host gave it, colours
// included, or a short line saying why there is none, such as `Builder not running`.
export type Live = { screen: string } | { note: string };

// How many of the latest review's findings show, as the card has them in short.
const findingsShown = 3;

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

// The mark CI as a whole takes when it has no checks to list, as a row shows it.
const ciSigns: Record<Exclude<NonNullable<TaskView["prPage"]>["ci"], "none">, string> = {
  passed: "✓",
  running: "●",
  failed: "✗",
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

// Returns CI's checks as lines `width` columns wide at most, as many on each line as fit, with two
// spaces between them, so none is left out. Each is its mark, in its colour, then its name. A
// check too wide for a line alone has its name cut, never its mark, so a long failed check
// still shows red.
function checkLines(checks: NonNullable<TaskView["prPage"]>["checks"], width: number): string[] {
  const lines: { plain: string; shown: string }[] = [];
  for (const check of checks) {
    const mark = checkMarks[check.state];
    const plain = `${Bun.stripANSI(mark)} ${check.name}`;
    const last = lines.at(-1);
    if (last && Bun.stringWidth(`${last.plain}  ${plain}`) <= width) {
      last.plain += `  ${plain}`;
      last.shown += `  ${mark} ${check.name}`;
    } else {
      const name = fitted(check.name, width - Bun.stringWidth(Bun.stripANSI(mark)) - 1);
      lines.push({ plain: `${Bun.stripANSI(mark)} ${name}`, shown: `${mark} ${name}` });
    }
  }
  return lines.map((line) => line.shown);
}

// How wide the task's description, the lead's updates and the review's findings are at most, as
// lines much longer than this are hard to read. The card and the timeline take the pane's width.
const textWidth = 80;

// How wide the card's dim labels are, such as `Started`, with the gap before their values.
const labelWidth = 9;

// Returns a line of the card: its label, dim, then its value's first line, with the value's other
// lines under it, past the label. A value with no lines leaves the card's line out.
const cardLines = (label: string, values: string[]) =>
  values.map(
    (value, i) =>
      `${i === 0 ? paint(grey, label.padEnd(labelWidth)) : " ".repeat(labelWidth)}${value}`,
  );

// Returns a section's lines under its name, dim, such as `Task`, or none when it has no lines.
const section = (name: string, lines: string[]) =>
  lines.length > 0 ? [paint(grey, name), ...lines] : [];

// Returns entries each after how long ago it happened, dim, such as `2m ago`, lined up so their
// texts start in one column. Each text is its lines, from `lines` given the room left for them.
function dated(
  entries: { ago: string; text: string }[],
  width: number,
  lines: (text: string, room: number) => string[],
): string[] {
  const agoWidth = Math.max(...entries.map((entry) => Bun.stringWidth(entry.ago))) + 2;
  return entries.flatMap((entry) =>
    lines(entry.text, width - agoWidth).map(
      (line, i) =>
        `${i === 0 ? paint(grey, entry.ago.padEnd(agoWidth)) : " ".repeat(agoWidth)}${line}`,
    ),
  );
}

// Returns a link's lines in the card, after its number, such as `#43`: on the number's line when
// it fits there, or else on the lines after, broken where it reaches the edge, so it can always
// be read whole. Each piece is a terminal link. A link holding control codes could end the
// terminal link early and send your terminal codes of its own, so they go, as spaces.
function linkLines(id: string, given: string, width: number): string[] {
  const link = removeControlCodes(given);
  if (!link) return [fitted(id, width)];
  if (Bun.stringWidth(`${id}  ${link}`) <= width) return [`${id}  ${linked(link, link)}`];
  return [fitted(id, width), ...folded(link, width).map((piece) => linked(link, piece))];
}

// Returns the details of a task as lines `width` columns wide at most, from the top. First its
// name and title, bold, with its stage on the right in the colour of its mark, and a spinner
// while its builder works, then a line. Then what it needs of you, in yellow, when it does. Then
// a card of the facts you check, each after a dim label: what it does now, its issue and PR, its
// CI's checks, its review with the latest findings, its armed merge and when it started. Then its
// description, the lead's updates to it and what happened to it, each under its name. A line or
// a part the task has nothing for is left out.
function detailLines(row: Row, details: Details, width: number): string[] {
  const { view, findings, events, updates } = details;
  const text = Math.min(width, textWidth);
  const value = Math.max(width - labelWidth, 1);
  // The stage, such as `Building`, on the right of the title's first line. A task in the task queue says
  // so, as its section says more than its stage.
  const stageName =
    row.part === "lead" || row.part === "request" || row.part === "heading"
      ? ""
      : sectionNames[row.section === "task queue" ? "task queue" : row.part];
  // A pane too narrow for the stage beside a few letters of the title leaves the stage out.
  const spun = `${details.spinner ? `${details.spinner} ` : ""}${stageName}`;
  const stage = Bun.stringWidth(spun) + 12 <= width ? spun : "";
  const stageWidth = Bun.stringWidth(stage);
  // The title's first line leaves room for the stage, and the lines after it take the width.
  const named = `${view.task}  ${view.title}`;
  const first = folded(named, Math.max(width - stageWidth - 2, 1))[0] ?? "";
  const after = named.slice(first.length).trim();
  const titled = [first, ...(after ? folded(after, width) : [])];
  const title = titled.map((line, i) => {
    const shown = paint(bright, line);
    if (i > 0 || !stage) return shown;
    const gap = " ".repeat(Math.max(width - Bun.stringWidth(line) - stageWidth, 1));
    return `${shown}${gap}${paint(markColours[row.mark.colour], stage)}`;
  });
  const top = [...title, paint(grey, "─".repeat(width))];
  // What it needs of you, as sc task says it, such as `question` or `ready to merge`.
  // A task approved and green waits on you to merge it, and shows under Needs you with its word
  // saying so, though its thread may not count as needing you for anything else.
  const needed =
    view.threads.find((thread) => thread.needsYouFor !== null)?.needsYouFor ??
    (row.section === "needs you" ? row.says : null);
  const callout = needed
    ? folded(`Needs you: ${needed}`, width).map((line) => paint(`${bright};${yellow}`, line))
    : [];
  // Now: its word in its colour, such as `working`, or what a queued or paused task waits on,
  // then its builder's step and how long ago its thread last changed.
  const word = row.waits || row.says;
  const rest = [row.step, details.changed].filter(Boolean).join(" · ");
  const nowPlain = [word, rest].filter(Boolean).join(" · ");
  const now =
    nowPlain === ""
      ? []
      : Bun.stringWidth(nowPlain) <= value
        ? [
            `${paint(markColours[row.colour], word)}${word && rest ? paint(grey, " · ") : ""}${rest}`,
          ]
        : folded(nowPlain, value);
  const issue = view.issue ? linkLines(view.issue.id, view.issue.link ?? "", value) : [];
  // A PR that left the forge's copy, such as a merged one, still has the link saved on its row.
  const prLink = view.prPage?.link ?? row.link ?? "";
  const pr = view.pr === null ? [] : linkLines(`#${view.pr}`, prLink, value);
  // CI: each check after its mark, going on over as many lines as they need, or with no checks
  // its verdict as a whole, after the mark a row shows for it, both in its colour.
  const page = view.prPage;
  const ci = !page
    ? []
    : page.checks.length > 0
      ? checkLines(page.checks, value)
      : page.ci === "none"
        ? []
        : [paint(ciColours[page.ci], `${ciSigns[page.ci]} ${page.ci}`)];
  // The review: its round as a row shows it, such as r2, and its verdict, both in the verdict's
  // colour, then what it found, numbered, each finding on one line cut short.
  const review = view.review;
  const said = review && review.state !== "none" ? reviewWords[review.state] : "";
  const round = typeof review?.round === "number" ? `r${review.round} · ` : "";
  const verdict =
    review && Bun.stringWidth(`${round}${said}`) <= value
      ? paint(reviewColours[review.state], `${round}${said}`)
      : fitted(`${round}${said}`, value);
  const findingWidth = Math.max(text - labelWidth, 1);
  const more = findings.length - findingsShown;
  const reviewed = said
    ? [
        verdict,
        ...findings
          .slice(0, findingsShown)
          .map((finding, i) => fitted(`${i + 1}. ${finding}`, findingWidth)),
        ...(more > 0 ? [paint(grey, fitted(`… ${more} more`, findingWidth))] : []),
      ]
    : [];
  const merge = view.merge === null ? [] : folded(view.merge, value);
  const started = details.started
    ? folded(
        [details.started, details.flow && `${details.flow} flow`].filter(Boolean).join(" · "),
        value,
      )
    : [];
  const card = [
    ...cardLines("Now", now),
    ...cardLines("Issue", issue),
    ...cardLines("PR", pr),
    ...cardLines("CI", ci),
    ...cardLines("Review", reviewed),
    ...cardLines("Merge", merge),
    ...cardLines("Started", started),
  ];
  // The description and the lead's updates, drawn as markdown and no wider than `textWidth`.
  const task = section("Task", markdownLines(view.body, text));
  const told =
    updates.length === 0
      ? []
      : section(`Updates from the lead (${updates.length})`, dated(updates, text, markdownLines));
  const activity = events.length === 0 ? [] : section("Activity", dated(events, width, folded));
  // The parts that have something, with a blank line between each, under the title.
  const parts = [callout, card, task, told, activity].filter((part) => part.length > 0);
  return [...top, ...parts.flatMap((part, i) => (i === 0 ? part : ["", ...part]))];
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
