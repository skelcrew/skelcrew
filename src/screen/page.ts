// The page: what the right side shows while you are on a row of ISSUES or PRS. Read-only: you
// scroll it with the wheel, click its link to GitHub, and typing goes nowhere. It is a process
// of its own, in the screen's right pane, so it ends with the screen and agents' sessions never
// see it.
import type { Page } from "../flow/page.ts";
import { errorText } from "../say.ts";
import { clean, fitted, grey, pad, paint, white } from "./look.ts";
import { drawMarkdown } from "./markdown.ts";

// Returns text from outside, safe to show, on as many lines as it takes to fit a number of
// columns. Words that are too long are broken, so a line never wraps by itself.
const wrapped = (text: string, columns: number) =>
  Bun.wrapAnsi(clean(text), Math.max(columns, 1), { hard: true }).split("\n");

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
  // first, when the link wouldn't fit whole beside it.
  const fits = Bun.stringWidth(url) + 2 + Bun.stringWidth(hint) <= room - labelWidth;
  const after = fits ? `  ${paint(grey, hint)}` : "";
  const link = `\x1b]8;;${url}\x1b\\${fitted(url, room - labelWidth)}\x1b]8;;\x1b\\${after}`;
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

// What the page reads: the wheel, as a click's report with the wheel's button, and a press of
// the left button, with its column and row counted from 1. All else you type goes nowhere.
const esc = "\x1b";
const wheel = new RegExp(`${esc}\\[<(64|65);\\d+;\\d+M`, "g");
const press = new RegExp(`${esc}\\[<0;(\\d+);(\\d+)M`, "g");
// How many lines a notch of the wheel moves, as an agent's history does.
const linesPerNotch = 5;
// The command that opens a link in your browser.
const openCommand = process.platform === "darwin" ? "open" : "xdg-open";

// Shows the page for a link, as `read` gives it, until its pane closes. A page that can't be read
// shows why. `where` names the remote Skelcrew runs on, and is empty on the machine you sit at.
// It writes only when you scroll, click or resize. It never reads the page again and has no
// clock, as on a Sprite a terminal that stays quiet lets it sleep.
export async function runPage(url: string, where: string, read: () => Page): Promise<void> {
  // A page that can't be read shows why, in place of its description.
  let page: Page;
  try {
    page = read();
  } catch (error) {
    page = { title: "Couldn't show this", facts: [], body: errorText(error) };
  }
  // Your terminal opens a link only with Shift added, such as Shift-Cmd-click in Ghostty, as the
  // screen takes the mouse for the sidebar. So a plain click on it opens it here, on the
  // machine you sit at. A Linux machine with no display, such as a server you ssh to, has no
  // browser to open.
  const canOpen =
    where === "" &&
    (process.platform === "darwin" || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY) &&
    Bun.which(openCommand) !== null;
  let hint = canOpen ? "click to open" : "click to copy";
  // The page is drawn again for each frame, at the pane's size then, as you can resize it at any
  // moment. `top` is the line it starts at, as far as you scrolled.
  const lines = (columns: number) => drawPage(page, url, columns, hint);
  let top = 0;
  const width = () => process.stdout.columns || 80;
  const height = () => process.stdout.rows || 24;
  // Returns the highest line the page can start at, so it never scrolls past its end.
  const lastTop = () => Math.max(lines(width()).length - height(), 0);
  // Draws what shows from the top line, filling the pane, so nothing of the last frame stays.
  const draw = () => {
    top = Math.min(top, lastTop());
    const shown = lines(width()).slice(top, top + height());
    process.stdout.write(`\x1b[H${shown.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
  };
  // Opens the link in your browser, or, on a remote or when opening fails, copies it to your
  // terminal's clipboard with OSC 52, which reaches you over ssh and sprite too, and says so in
  // the hint. The browser is detached, so it outlives the page.
  const openLink = async () => {
    if (canOpen) {
      const opening = Bun.spawn([openCommand, url], {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      if ((await opening.exited) === 0) return;
    }
    process.stdout.write(`\x1b]52;c;${btoa(url)}\x07`);
    hint = "copied";
    draw();
  };
  // Returns whether a press at a column and row of the pane is on the link to GitHub or its hint.
  const onLink = (column: number, row: number) => {
    const line = lines(width())[top + row - 1] ?? "";
    const at = line.indexOf(`\x1b]8;;${url}\x1b\\`);
    return (
      at >= 0 && column > Bun.stringWidth(line.slice(0, at)) && column <= Bun.stringWidth(line)
    );
  };
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink on the page. 1000 and 1006 ask for the wheel and
  // clicks, so tmux hands them here. ?7l cuts a line at the edge: a pane too narrow for a label
  // would otherwise wrap it, and rows the page doesn't count would throw its scrolling off.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?7l");
  // Each notch of the wheel scrolls up or down, kept between the top and the end. Only a
  // scroll that moved the page draws it again. A press on the link follows it.
  process.stdin.on("data", (bytes) => {
    const before = top;
    const text = bytes.toString();
    for (const [, button] of text.matchAll(wheel))
      top = Math.min(
        Math.max(top + (button === "64" ? -linesPerNotch : linesPerNotch), 0),
        lastTop(),
      );
    if (top !== before) draw();
    for (const [, column, row] of text.matchAll(press))
      if (onLink(Number(column), Number(row))) void openLink();
  });
  // Draws now and on each resize, until the pane goes and its input closes.
  process.on("SIGWINCH", draw);
  draw();
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
