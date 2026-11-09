// The page: what the right side shows while you are on a row of ISSUES or PRS. Read-only: you
// scroll it with the wheel, and typing goes nowhere. It is a process of its own, in the
// screen's right pane, so it ends with the screen and agents' sessions never see it.
import type { Page } from "../flow/page.ts";
import { errorText } from "../say.ts";
import { clean, fitted, grey, pad, paint, white } from "./look.ts";
import { drawMarkdown } from "./markdown.ts";

// Returns text from outside, safe to show, on as many lines as it takes to fit a number of
// columns. Words that are too long are broken, so a line never wraps by itself.
const wrapped = (text: string, columns: number) =>
  Bun.wrapAnsi(clean(text), Math.max(columns, 1), { hard: true }).split("\n");

// Returns a page as lines for a pane of a given width, from the top: the title, then the facts
// with the link to GitHub, then the description, drawn from its markdown. It reads nothing, so
// what you see can be tested without a terminal. The link is skel's own, from the sidebar, so it is never text from GitHub. It sits
// with the facts, not under a description that could push it far out of view.
export function drawPage(page: Page, url: string, width: number): string[] {
  const room = width - 2 * pad.length;
  const labels = [...page.facts.map(([label]) => label), "GitHub"];
  const gap = Math.max(...labels.map((label) => label.length)) + 2;
  // Returns a label and what it says, with any more lines lined up under the first.
  const fact = (label: string, lines: string[]) =>
    lines.map((line, i) => `${pad}${paint(grey, (i === 0 ? label : "").padEnd(gap))}${line}`);
  const link = `\x1b]8;;${url}\x1b\\${fitted(url, room - gap)}\x1b]8;;\x1b\\`;
  // Already safe to show, so wrapped without cleaning, which would take its styles too.
  const body = page.body.trim()
    ? drawMarkdown(page.body.trim()).flatMap((line) =>
        Bun.wrapAnsi(line, Math.max(room, 1), { hard: true }).split("\n"),
      )
    : [paint(grey, "No description.")];
  return [
    "",
    ...wrapped(page.title, room).map((line) => `${pad}${paint(white, line)}`),
    "",
    ...page.facts.flatMap(([label, says]) => fact(label, wrapped(says, room - gap))),
    ...fact("GitHub", [link]),
    "",
    ...body.map((line) => `${pad}${line}`),
  ];
}

// What the page reads: the wheel, as a click's report with the wheel's button. All else you
// type goes nowhere.
const esc = "\x1b";
const wheel = new RegExp(`${esc}\\[<(64|65);\\d+;\\d+M`, "g");
// How many lines a notch of the wheel moves, as an agent's history does.
const notch = 5;

// Shows the page at a link until its pane goes, drawing what `reading` brings once it comes, or
// why it couldn't. It writes only when you scroll or resize: it never asks again and has no
// clock, as on a Sprite a terminal that stays quiet lets it sleep.
export async function runPage(url: string, reading: Promise<Page>): Promise<void> {
  // Returns what to show at a width, until the page has come.
  let lines = (_width: number) => ["", `${pad}${paint(grey, "Loading…")}`];
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
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink on the page. 1000 and 1006 ask for the wheel, so
  // tmux hands it here. ?7l cuts a line at the edge: a pane too narrow for a label would
  // otherwise wrap it, and rows the page doesn't count would throw its scrolling off.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?7l");
  process.stdin.on("data", (bytes) => {
    const before = top;
    for (const [, button] of bytes.toString().matchAll(wheel))
      top = Math.min(Math.max(top + (button === "64" ? -notch : notch), 0), lastTop());
    if (top !== before) draw();
  });
  process.on("SIGWINCH", draw);
  draw();
  reading.then(
    (page) => {
      lines = (columns) => drawPage(page, url, columns);
      draw();
    },
    (error) => {
      const why = errorText(error);
      const about = { title: "Couldn't read this from GitHub", facts: [], body: why };
      lines = (columns) => drawPage(about, url, columns);
      draw();
    },
  );
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
