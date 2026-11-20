// The details pane beside the list, as lines for your terminal: the row you are on, with its
// task's details at the top and its agent at work, live, below them. It reads nothing, so what
// it shows can be tested without a terminal.
import type { TaskView } from "../flow/list.ts";
import { bright, fitted, green, grey, markColours, paint, red, yellow } from "../screen/look.ts";
import type { Details } from "./details.ts";
import { stageNames } from "./layout.ts";
import type { Row } from "./rows.ts";

// The live view's part of the pane: the agent's screen as its session host gave it, colours
// included, or a short line saying why there is none, such as `Builder not running`.
export type Live = { screen: string } | { note: string };

// How many lines the description shows before it is folded, how many findings show, and how many
// lines the title and the events take at most, so the details stay a compact block on top.
const descriptionLines = 3;
const findingsShown = 3;
const titleLines = 2;
const eventLines = 2;

// The fewest lines the live view keeps under the details, which give way to it.
const liveLeast = 5;

// Returns text wrapped at word breaks to `width` columns, at most `most` lines, the last one
// ending in … when there was more.
function folded(text: string, width: number, most: number): string[] {
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

// What each state of a review says on the pane's round line.
const reviewWords: Record<NonNullable<TaskView["review"]>["state"], string> = {
  none: "",
  reviewing: "reviewing",
  approved: "approved",
  changes: "changes asked",
  failed: "review failed",
};

// Returns the details of a task as lines `width` columns wide at most, from the top: its full
// title, its issue's and PR's links, its stage and word, its CI with each check, its armed merge,
// its review round with the verdict and the findings in short, its description folded after a
// few lines, and its recent events. Each part is left out where the task has none.
function detailLines(row: Row, details: Details, width: number): string[] {
  const { view, findings, events } = details;
  const cut = (text: string) => fitted(text, width);
  const title = folded(view.title, width, titleLines).map((line) => paint(bright, line));
  // The links, each after a dim label, lined up.
  const issue = view.issue ? [["issue", view.issue.id, view.issue.link ?? ""]] : [];
  const pr = view.pr === null ? [] : [["PR", `#${view.pr}`, view.prPage?.link ?? ""]];
  const links = [...issue, ...pr].map(([label = "", id = "", link = ""]) => {
    const plain = cut(`${label.padEnd(6)}${id}  ${link}`.trimEnd());
    return `${paint(grey, plain.slice(0, 6))}${plain.slice(6)}`;
  });
  // The stage and the row's word, in its colour, such as `Building · question`, or cut without
  // its colours when too wide.
  const stage = row.part === "lead" ? "" : stageNames[row.part];
  const word = row.says ? ` · ${row.says}` : "";
  const staged =
    Bun.stringWidth(`${stage}${word}`) <= width
      ? `${paint(bright, stage)}${paint(markColours[row.colour], word)}`
      : cut(`${stage}${word}`);
  // CI as a whole, then each check with its mark, or in words, without colours, when the marks
  // don't fit.
  const page = view.prPage;
  const ci: string[] = [];
  if (page) {
    const summary = `CI ${page.ci}${page.checks.length ? ":" : ""}`;
    const marked = page.checks.map((check) => `${check.name} ${checkMarks[check.state]}`);
    const line = [summary, ...marked].join("  ");
    const worded = [summary, ...page.checks.map((check) => `${check.name} ${check.state}`)];
    ci.push(Bun.stringWidth(line) <= width ? line : cut(worded.join("  ")));
  }
  const merge = view.merge === null ? [] : [cut(view.merge)];
  // The review's round and verdict, then what it found, each finding on one line.
  const review = view.review;
  const said = review && review.state !== "none" ? reviewWords[review.state] : "";
  const round = typeof review?.round === "number" ? `Round ${review.round} · ` : "";
  const rounds = said ? [cut(`${round}${said}`)] : [];
  const more = findings.length - findingsShown;
  const found = [
    ...findings.slice(0, findingsShown).map((finding) => cut(`  - ${finding}`)),
    ...(more > 0 ? [paint(grey, cut(`  … ${more} more`))] : []),
  ];
  // The description, as one paragraph, so its blank lines don't take the pane's few lines.
  const body = view.body.replace(/\s+/g, " ").trim();
  const described = body ? folded(body, width, descriptionLines) : [];
  const happened = events.length
    ? folded(events.join(" · "), width, eventLines).map((line) => paint(grey, line))
    : [];
  // Returns the parts that have something, with a blank line between each.
  const parts = [
    [...title, ...links],
    [staged, ...ci, ...merge, ...rounds, ...found],
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
// line, and it ends by resetting colours, so none reaches the line after it.
function screenLines(screen: string, width: number, count: number): string[] {
  const lines = screen.replace(/\n$/, "").split("\n").map(keepColours);
  while (lines.length > 0 && Bun.stripANSI(lines.at(-1) ?? "").trim() === "") lines.pop();
  return lines.slice(-count).map((line) => `${Bun.sliceAnsi(line, 0, width)}\x1b[0m`);
}

// Returns the pane for the row you are on as exactly `height` lines, each `width` columns wide at
// most. On a row that isn't a task, such as the lead's, it is empty. Otherwise the task's details
// come first, then a dim line, then its agent's live screen filling the rest, or the line that
// says why there is none. The details give way to the live view when the pane is short.
export function drawPane(
  row: Row | undefined,
  details: Details | null,
  live: Live | null,
  width: number,
  height: number,
): string[] {
  const blank = (count: number) => Array.from({ length: Math.max(count, 0) }, () => "");
  if (!row || details === null) return blank(height);
  const top = detailLines(row, details, width).slice(0, Math.max(height - liveLeast - 2, 0));
  if (live === null) return [...top, ...blank(height - top.length)].slice(0, height);
  const rule = paint(grey, "─".repeat(width));
  const room = height - top.length - 2;
  const below =
    "note" in live
      ? [paint(grey, fitted(live.note, width))]
      : screenLines(live.screen, width, room);
  return [...top, "", rule, ...below, ...blank(room - below.length)].slice(0, height);
}
