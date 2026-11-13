// The page of an issue or PR, opened from its list on the right: drawn as lines from what
// Skelcrew's copy says of it. Read-only: you scroll it and click its link to GitHub.
import type { Page } from "../flow/page.ts";
import { fitted, grey, pad, paint, removeControlCodes, white } from "./look.ts";
import { drawMarkdown } from "./markdown.ts";

// Returns text from outside, safe to show, on as many lines as it takes to fit a number of
// columns. Words that are too long are broken, so a line never wraps by itself.
const wrapped = (text: string, columns: number) =>
  Bun.wrapAnsi(removeControlCodes(text), Math.max(columns, 1), { hard: true }).split("\n");

// The widest a page's text runs, in columns, however wide its pane.
const maxTextWidth = 80;

// Returns a page as lines for a pane of a given width, from the top: the title, then the facts
// with the link to GitHub and a dim hint saying what a click on it does, then the description,
// drawn from its markdown. It reads nothing, so what you see can be tested without a terminal.
// The link comes from Skelcrew's copy, which takes only a web address of printable characters,
// so it can't end the terminal link early or hold a control code. It sits with the facts, not
// under a description that could push it far out of view.
export function drawPage(page: Page, url: string, width: number, hint: string): string[] {
  // Text stops at the padding on each side, and every fact's text starts in one column, past
  // the longest label. On a wide pane it stops at 80 columns, as longer lines are hard to read.
  const room = Math.min(width - 2 * pad.length, maxTextWidth);
  const labels = [...page.facts.map(([label]) => label), "GitHub"];
  const labelWidth = Math.max(...labels.map((label) => label.length)) + 2;
  // Returns a label and what it says, with any more lines lined up under the first.
  const fact = (label: string, lines: string[]) =>
    lines.map(
      (line, i) => `${pad}${paint(grey, (i === 0 ? label : "").padEnd(labelWidth))}${line}`,
    );
  // The link to GitHub is a terminal link, cut to fit beside its label. The hint gives way
  // first, when the link wouldn't fit whole beside it. The link is blue and underlined, as
  // Claude Code draws links, since the screen takes the mouse and the terminal marks a link only
  // with Shift held. The theme's own blue fits its colours. 39 and 24 end just these two styles,
  // and they sit inside the terminal link, which a click finds by its start.
  const fits = Bun.stringWidth(url) + 2 + Bun.stringWidth(hint) <= room - labelWidth;
  const after = fits ? `  ${paint(grey, hint)}` : "";
  const link = `\x1b]8;;${url}\x1b\\\x1b[34;4m${fitted(url, room - labelWidth)}\x1b[39;24m\x1b]8;;\x1b\\${after}`;
  // The description wraps as its markdown says, so a list item's lines start under its text.
  const body = page.body.trim()
    ? drawMarkdown(page.body.trim(), Math.max(room, 1))
    : [paint(grey, "No description.")];
  // A blank line parts the title, in white, from the facts, and the facts from the description.
  return [
    "",
    ...wrapped(page.title, room).map((line) => `${pad}${paint(white, line)}`),
    "",
    ...page.facts.flatMap(([label, says]) => fact(label, wrapped(says, room - labelWidth))),
    ...fact("GitHub", [link]),
    "",
    ...body.map((line) => `${pad}${line}`),
  ];
}
