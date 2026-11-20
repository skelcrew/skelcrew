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
  yellow,
} from "../screen/look.ts";
import type { Details } from "./details.ts";
import { sectionNames } from "./layout.ts";
import type { Row } from "./rows.ts";

// The live view's part of the pane: the agent's screen as its session host gave it, colours
// included, or a short line saying why there is none, such as `Builder not running`.
export type Live = { screen: string } | { note: string };

// How many lines the description shows before it is folded, how many findings show, and how many
// lines the events take at most, so the details stay a compact block on top.
const descriptionLines = 3;
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
// text alone in one that doesn't. A link broken over lines is a link on each of them.
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

// Returns a heading and as many items as fit after it on one line `width` columns wide, with
// two spaces between them, and a dim count of those left out, such as `… 59 more`, so the line
// says how many there are in all. One too narrow even for the count alone is cut.
function oneLine(
  heading: { plain: string; shown: string },
  items: { plain: string; shown: string }[],
  width: number,
): string {
  for (let kept = items.length; kept >= 0; kept--) {
    const shown = items.slice(0, kept);
    const left = items.length - kept;
    const more = left > 0 ? [`… ${left} more`] : [];
    const plain = [heading.plain, ...shown.map((item) => item.plain), ...more].join("  ");
    if (Bun.stringWidth(plain) <= width)
      return [
        heading.shown,
        ...shown.map((item) => item.shown),
        ...more.map((m) => paint(grey, m)),
      ].join("  ");
  }
  return fitted([heading.plain, `… ${items.length} more`].join("  "), width);
}

// The steps the details take to fit a short pane, each on top of those before it. The parts that
// matter least to see at a glance give way first, and every part keeps at least one line, so
// none goes out of sight.
const tightenings = [
  "description",
  "findings",
  "gaps",
  "title",
  "events",
  "links",
  "checks",
] as const;

// Returns the details of a task as lines `width` columns wide at most, from the top: its full
// title, its issue's and PR's links, its stage and word, its CI with each check, its armed merge,
// its review round with the verdict and the findings in short, its description folded after a
// few lines, and its recent events. Each part is left out where the task has none. `tight` is how
// many of the tightenings apply, such as 2 for a description and findings of one line each.
function detailLines(row: Row, details: Details, width: number, tight = 0): string[] {
  const { view, findings, events } = details;
  const tightened = (step: (typeof tightenings)[number]) => tightenings.indexOf(step) < tight;
  const cut = (text: string) => fitted(text, width);
  const title = folded(view.title, width, tightened("title") ? 1 : undefined).map((line) =>
    paint(bright, line),
  );
  // The links, each after a dim label and its number, lined up, and each one a terminal link. A
  // link too long for that line goes on the lines after, broken where it reaches the edge, so it
  // can always be read whole.
  const issue = view.issue ? [["issue", view.issue.id, view.issue.link ?? ""]] : [];
  // A PR that left the forge's copy, such as a merged one, still has the link saved on its row.
  const prLink = view.prPage?.link ?? row.link ?? "";
  const pr = view.pr === null ? [] : [["PR", `#${view.pr}`, prLink]];
  const links = [...issue, ...pr].flatMap(([label = "", id = "", link = ""]) => {
    const named = cut(`${label.padEnd(6)}${id}`);
    const start = `${paint(grey, named.slice(0, 6))}${named.slice(6)}`;
    if (!link) return [start];
    if (Bun.stringWidth(`${named}  ${link}`) <= width) return [`${start}  ${linked(link, link)}`];
    if (tightened("links")) {
      const after = cut(`${named}  ${link}`).slice(named.length);
      return [`${start}  ${linked(link, after.slice(2))}`];
    }
    return [start, ...folded(link, width).map((piece) => linked(link, piece))];
  });
  // The stage and the row's word, in its colour, such as `Building · question`, or cut without
  // its colours when too wide.
  const stage = row.part === "lead" ? "" : sectionNames[row.part];
  const word = row.says ? ` · ${row.says}` : "";
  const staged =
    Bun.stringWidth(`${stage}${word}`) <= width
      ? `${paint(bright, stage)}${paint(markColours[row.colour], word)}`
      : cut(`${stage}${word}`);
  // CI as a whole, its verdict in colour after a dim label, then each check with its mark, going on
  // over as many lines as they need. When
  // tightened to one line, failed checks come first, so they stay in sight, and the line ends
  // with how many checks it left out.
  const page = view.prPage;
  const colon = page?.checks.length ? ":" : "";
  const summary = {
    plain: page ? `CI ${page.ci}${colon}` : "",
    shown: page ? `${paint(grey, "CI")} ${paint(ciColours[page.ci], page.ci)}${colon}` : "",
  };
  const order = { failed: 0, running: 1, cancelled: 2, passed: 3 };
  const checks = tightened("checks")
    ? [...(page?.checks ?? [])].sort((a, b) => order[a.state] - order[b.state])
    : (page?.checks ?? []);
  const items = page
    ? checks.map((check) => ({
        plain: `${check.name} ${Bun.stripANSI(checkMarks[check.state])}`,
        shown: `${check.name} ${checkMarks[check.state]}`,
      }))
    : [];
  const ci = !page
    ? []
    : tightened("checks")
      ? [oneLine(summary, items, width)]
      : packed([summary, ...items], width);
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
  const shownFindings = tightened("findings") ? 1 : findingsShown;
  const more = findings.length - shownFindings;
  const found = [
    ...findings.slice(0, shownFindings).map((finding) => cut(`  - ${finding}`)),
    ...(more > 0 ? [paint(grey, cut(`  … ${more} more`))] : []),
  ];
  // The description, dimmer than the rest, as one paragraph, so its blank lines don't take the
  // pane's few lines.
  const body = view.body.replace(/\s+/g, " ").trim();
  const described = body
    ? folded(body, width, tightened("description") ? 1 : descriptionLines).map((line) =>
        paint(lightGrey, line),
      )
    : [];
  const happened = events.length
    ? folded(events.join(" · "), width, tightened("events") ? 1 : eventLines).map((line) =>
        paint(grey, line),
      )
    : [];
  // Returns the parts that have something, with a blank line between each.
  const parts = [
    [...title, ...links],
    [staged, ...ci, ...merge, ...rounds, ...found],
    described,
    happened,
  ].filter((part) => part.length > 0);
  const gap = tightened("gaps") ? [] : [""];
  return parts.flatMap((part, i) => (i === 0 ? part : [...gap, ...part]));
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

// Returns the pane for the row you are on as exactly `height` lines, each `width` columns wide at
// most. On a row that isn't a task, such as the lead's, it is empty. Otherwise the task's details
// come first, then a dim line, then its agent's live screen, or the line that says why there is
// none. The live screen is a strip of the agent's last few lines, without blank ones, or, when
// `full`, as much of its screen as fills the rest. The details take what they need, but always
// leave the live view a few lines: in a short pane they tighten, step by step, until they fit.
// Only a pane too short even for that cuts them, ending in a dim …. The blank line over the live
// view goes first.
export function drawPane(
  row: Row | undefined,
  details: Details | null,
  live: Live | null,
  width: number,
  height: number,
  full = false,
): string[] {
  const blank = (count: number) => Array.from({ length: Math.max(count, 0) }, () => "");
  if (!row || details === null) return blank(height);
  const least = full ? liveLeast : stripLines + 1;
  const most = live === null ? height : Math.max(height - least, 0);
  let all = detailLines(row, details, width);
  for (let tight = 1; all.length > most && tight <= tightenings.length; tight++)
    all = detailLines(row, details, width, tight);
  const top = all.length <= most ? all : [...all.slice(0, Math.max(most - 1, 0)), paint(grey, "…")];
  if (live === null) return [...top, ...blank(height - top.length)].slice(0, height);
  const gap = height - top.length > least ? [""] : [];
  const rule = paint(grey, "─".repeat(width));
  const left = height - top.length - gap.length - 1;
  const room = full ? left : Math.min(left, stripLines);
  const below =
    "note" in live
      ? [paint(grey, fitted(live.note, width))]
      : screenLines(live.screen, width, room, !full);
  return [...top, ...gap, rule, ...below, ...blank(height)].slice(0, height);
}
