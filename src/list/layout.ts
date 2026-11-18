// The list as lines for your terminal: the top line with Skelcrew, the repository and the other
// repositories, the lead's row, the rows under Issues, Working and Ready for review, and the
// bottom line with the keys and the machine's load. It reads nothing, so what you see can be
// tested without a terminal.
import type { Colour } from "../flow/marks.ts";
import {
  bright,
  filled,
  fitted,
  grey,
  markColours,
  paint,
  shaded,
  tinted,
  yellow,
} from "../screen/look.ts";
import type { Row, Tab } from "./rows.ts";

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

// The headings of the parts of the list, by the part their rows are in. The lead has none.
const headings = { issue: "Issues", working: "Working", ready: "Ready for review" } as const;

// Returns the keys the bottom line offers on a row: Enter always, m only on a task it can merge,
// and Tab only with another repository to go to.
export function keysFor(row: Row | undefined, tabs: number): string {
  const merge = row?.merge && "ask" in row.merge ? ["m merge"] : [];
  const tab = tabs > 1 ? ["⇥ repository"] : [];
  return ["↑↓ move", "⏎ open", ...merge, ...tab, "q quit"].join("  ");
}

// Returns the top line: Skelcrew in bold, its version and where it runs, dim, and the open
// repository's name, then the other repositories at the right end, each with a yellow dot and
// how many of its threads need you, or red when one went wrong, then a green dot and how many
// wait for you to merge. They are counted apart, so a finished task is never told twice. The other repositories give way
// first when the line is short, then the end of the line is cut, without its colours.
function topLine(frame: Frame, width: number): string {
  const place = frame.where ? ` on ${frame.where}` : "";
  const plain = ` Skelcrew v${frame.version}${place} · ${frame.name}`;
  if (Bun.stringWidth(plain) > width) return fitted(plain, width);
  const left = ` ${paint(bright, "Skelcrew")} ${paint(grey, `v${frame.version}${place}`)} · ${frame.name}`;
  const others = frame.tabs
    .filter((tab) => tab.name !== frame.name)
    .map((tab) => {
      const colour = tab.colour === "red" ? markColours.red : yellow;
      const needing = tab.needYou ? [paint(colour, `•${tab.needYou}`)] : [];
      const ready = tab.ready ? [paint(markColours.green, `•${tab.ready}`)] : [];
      return [tab.name, ...needing, ...ready].join(" ");
    })
    .join("  ");
  const room = width - Bun.stringWidth(Bun.stripANSI(left)) - 2;
  if (!others || Bun.stringWidth(Bun.stripANSI(others)) > room) return left;
  return `${filled(left, width - Bun.stringWidth(Bun.stripANSI(others)) - 1)}${others} `;
}

// Returns one row as a line. The row you are on has ▸ before its mark and the grey behind it.
// The name takes `nameWidth` columns, and the title what is left beside the end of the row, which
// sits at the right edge. On a narrow terminal the title gives way first, then the end of the
// row and the name are cut, so the line never wraps, which would push the rest down. On a
// terminal narrower than the mark and the gaps, 9 columns, the whole row is cut.
function rowLine(row: Row, here: boolean, nameWidth: number, width: number): string {
  const colour = (c: Colour) => markColours[c];
  const lead = `${here ? " ▸ " : "   "}${tinted(here, colour(row.mark.colour), row.mark.sign)} `;
  // A name is plain text, white on the row you are on, as the theme's own text can be dark on
  // the grey there. The lead's is bold.
  const nameRoom = Math.max(Math.min(nameWidth, width - 9), 0);
  const padded = filled(fitted(row.name, nameRoom), nameRoom);
  const name = row.part === "lead" || here ? tinted(here, bright, padded) : padded;
  const says = fitted(row.says, Math.max(width - 9 - nameRoom, 0));
  const room = Math.max(width - 9 - nameRoom - Bun.stringWidth(says), 0);
  const title = filled(fitted(row.title, room), room);
  const line = `${lead}${name}  ${title}  ${tinted(here, colour(row.colour), says)}`;
  // A terminal narrower than the mark and the gaps gets the row's text cut to fit, without its
  // colours, as any wider line would wrap.
  if (Bun.stringWidth(Bun.stripANSI(line)) > width) return fitted(Bun.stripANSI(line), width);
  return here ? shaded(line, width) : line;
}

// Returns the list as lines that fill the terminal, on the row at `here`. The top line comes
// first, then a notice when there is one, then the rows, scrolled from `top` so the row you are
// on shows, then the bottom line. Each part's heading shows only when it has rows. Gives the
// lines and the scroll they were drawn at, which the next draw starts from, so the list moves
// only when the row you are on would leave the screen.
export function drawList(
  rows: Row[],
  here: number,
  top: number,
  frame: Frame,
  size: Size,
): { lines: string[]; top: number } {
  const nameWidth = Math.max(...rows.map((row) => Bun.stringWidth(row.name)), 4);
  // The body: each row's line, with which row it is, under its part's heading.
  const body: { text: string; row: number | null }[] = [];
  let part = "";
  rows.forEach((row, i) => {
    if (row.part !== part) {
      if (body.length > 0) body.push({ text: "", row: null });
      if (row.part !== "lead")
        body.push({ text: fitted(` ${headings[row.part]}`, size.width), row: null });
      part = row.part;
    }
    body.push({ text: rowLine(row, i === here, nameWidth, size.width), row: i });
  });
  const notice = frame.notice ? [paint(yellow, fitted(` ${frame.notice}`, size.width))] : [];
  const head = [topLine(frame, size.width), ...notice, ""];
  const room = Math.max(size.height - head.length - 2, 1);
  // Scrolls just enough to keep the row you are on in view.
  const at = body.findIndex((line) => line.row === here);
  let from = Math.min(Math.max(top, at - room + 1, 0), Math.max(at, 0));
  from = Math.min(from, Math.max(body.length - room, 0));
  const shown = body.slice(from, from + room).map((line) => line.text);
  const blank = Array.from({ length: room - shown.length }, () => "");
  // A question or a reason must stay on its one line, so it is cut to fit, and the load gives
  // way first.
  const bottom = fitted(` ${frame.bottom}`, size.width);
  const load = frame.load ? `${frame.load} ` : "";
  const gap = size.width - Bun.stringWidth(bottom) - Bun.stringWidth(Bun.stripANSI(load));
  const last = gap > 1 ? `${paint(grey, bottom)}${" ".repeat(gap)}${load}` : paint(grey, bottom);
  return { lines: [...head, ...shown, ...blank, "", last], top: from };
}
