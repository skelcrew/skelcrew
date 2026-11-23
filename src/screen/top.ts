// The two top rows of the screen. The header, across the whole width, says Skelcrew, its version
// and, on a remote, where it runs, then has a tab for each repository. Under it is the top of the
// box round each side. For a while after a file dropped was on another machine, they also say how
// to drop it, on more rows when the screen is too narrow for one.
import type { Tab } from "../list/rows.ts";
import { fitted, removeControlCodes } from "./look.ts";
import { dim, lit } from "./screen.ts";

// How wide the sidebar's pane and the right side's are, as tmux has them.
type Size = { sidebar: number; right: number };

// The sidebar's fixed colours of a tab's badge, as tmux names them.
const tmuxColours = { green: "colour120", yellow: "colour221", red: "colour210" };

// Returns a tab's badge as its dots, each with its colour: how many threads need you, in red when
// any went wrong and yellow otherwise, then how many are ready to merge, in green, such as •2 •1.
// Each is left out at none.
function dots(tab: Tab): [keyof typeof tmuxColours, string][] {
  const shown: [keyof typeof tmuxColours, string][] = [];
  if (tab.needYou) shown.push([tab.colour, `•${tab.needYou}`]);
  if (tab.ready) shown.push(["green", `•${tab.ready}`]);
  return shown;
}

// Returns text as tmux shows it as is. tmux reads the top rows as a format, where #(...) would run
// a shell command and #[...] restyle the line. A repository's name or where Skelcrew runs could
// say that. The row goes through strftime too, so % is doubled for it to stay itself.
const escaped = (text: string) => text.replaceAll("#", "##").replaceAll("%", "%%");

// Skelcrew's name, in the white of a selected name. A 256-colour number, so it looks the same
// whatever your theme.
const skelName = "#[bold,fg=colour231]Skelcrew#[default]";

// Returns text in a colour, as a tmux format, for the lines of the boxes.
const inColour = (colour: string, text: string) => `#[fg=${colour}]${text}#[default]`;

export const sidebarRange = "sidebar";

// Returns the header's left part, `width` columns wide, before the tabs: Skelcrew's name in line
// with the sidebar's marks, then on a screen that shows one side at a time, a way back to the
// sidebar to tap from an agent and the name of the side that shows, then dim the longest name of
// its version that fits, such as v0.4.2 or 6f1c2ab (checkout), then, on a remote, a dot and where
// it runs, then spaces out to the end. `where` is empty on this machine. It comes from outside, so
// it is made safe as a title is. What follows the name stops a column before the end, so a space
// always parts it from the tabs. The place gives way first, then the version, then the side's name,
// which is cut, and the way back last. A version is never cut, as half a number would be a
// different one.
function header(where: string, width: number, versions: string[], side: Side): string {
  const nameWidth = 12;
  if (width < nameWidth + 1) return " ".repeat(Math.max(width, 0));
  const free = width - 1 - nameWidth;
  const back = side.back && free >= backWidth;
  const between = back ? " · " : " ";
  const sideRoom = free - (back ? backWidth : 0) - between.length;
  const sideName =
    side.text && sideRoom >= 2 ? fitted(removeControlCodes(side.text), sideRoom) : "";
  const sideWidth =
    (back ? backWidth : 0) + (sideName ? between.length + Bun.stringWidth(sideName) : 0);
  const drawnSide = `${back ? backLink : ""}${sideName && `${between}#[fg=colour231]${escaped(sideName)}#[default]`}`;
  const room = Math.max(free - sideWidth, 0);
  const fits = (name: string) => Bun.stringWidth(name) + 1 <= room;
  const shown = versions.find(fits) ?? versions.at(-1) ?? "";
  const taken = Bun.stringWidth(shown) + 1;
  const number = room >= taken ? ` ${shown}` : "";
  const place = fitted(removeControlCodes(where), Math.max(room - 3 - taken, 0));
  const about = `${number}${place && ` · ${place}`}`;
  const rest = Math.max(width - nameWidth - sideWidth - Bun.stringWidth(about), 0);
  const dimmed = about && `#[fg=brightblack]${escaped(about)}#[default]`;
  return `    ${skelName}${drawnSide}${dimmed}${" ".repeat(rest)}`;
}

type Side = { text: string; back: boolean };
const backText = "‹ sidebar";
const backWidth = 1 + Bun.stringWidth(backText);
const backLink = ` #[range=user|${sidebarRange}]#[fg=${lit}]${backText}#[default]#[norange]`;
const sideText = (side: Side) => (side.back ? `${backText} · ${side.text}` : side.text);

// Returns the tabs as a tmux format, given each repository's tab, the open one's owner/name, and
// the room they have, with how many columns they take, which is never more than the room. Each
// tab is the repository's name, with its badge when threads in it need you or are ready, such as
// site •2 •1, and two spaces on each side, so the open one's grey reads as a tab. The open one is
// bold white on the grey a picked row has, and the others dim. When they don't fit, those
// furthest from the open one give way, and a dim count says how many. Each tab is a range of its
// own, named by its place in the list, so a click on it can say which it was.
function drawTabs(tabs: Tab[], open: string, width: number): { text: string; width: number } {
  // Starts from the open tab, or the first when none is open.
  const at = Math.max(
    tabs.findIndex((tab) => tab.fullName === open),
    0,
  );
  // Returns a tab's name and badge as you read them, such as site •2 •1.
  const plain = (tab: Tab) =>
    `${tab.name}${dots(tab)
      .map(([, text]) => ` ${text}`)
      .join("")}`;
  // Returns how many columns the tab at a place in the list takes, or none past either end.
  const tabWidth = (index: number) => {
    const tab = tabs[index];
    return tab ? 4 + Bun.stringWidth(plain(tab)) : 0;
  };
  const all = tabs.reduce((sum, _, index) => sum + tabWidth(index), 0);
  // The count of those left out goes at the end, and needs its room kept.
  const room = all <= width ? width : width - `  +${tabs.length}`.length;
  // Takes in tabs out from the open one, one on each side at a time, until neither side fits
  // another. The open tab always shows.
  let [first, last, used] = [at, at, tabWidth(at)];
  let [left, right] = [true, true];
  while (left || right) {
    if (right && last + 1 < tabs.length && used + tabWidth(last + 1) <= room)
      used += tabWidth(++last);
    else right = false;
    if (left && first > 0 && used + tabWidth(first - 1) <= room) used += tabWidth(--first);
    else left = false;
  }
  const out = tabs.length - (last - first + 1);
  const count = out > 0 ? `  +${out}` : "";
  // Tabs have greys of their own, so they stand apart from the sidebar and the agent: the open
  // one bold white on a dark grey, the others dim on a lighter one. A tab's dots are in the
  // sidebar's fixed colours, as a theme's own can look like another colour. A dim count of
  // those left out ends the row.
  const openStyle = "#[bg=colour234,fg=colour231,bold]";
  const shown = tabs.slice(first, last + 1).map((tab, offset) => {
    const style = first + offset === at ? openStyle : "#[bg=colour237,fg=colour245]";
    const badge = dots(tab)
      .map(([colour, text]) => ` #[fg=${tmuxColours[colour]}]${text}`)
      .join("");
    return `#[range=user|${first + offset}]${style}  ${escaped(tab.name)}${badge}  #[default]#[norange]`;
  });
  if (used + count.length <= width)
    return {
      text: `${shown.join("")}${count && `#[fg=brightblack]${count}#[default]`}`,
      width: used + count.length,
    };
  // Too little room for the open tab with its spaces and the count: its spaces go, and then its
  // name and badge are cut with …, so the count still says others are hidden and the row never
  // runs past the terminal. Only a row too narrow for any of the name beside the count loses the
  // count. Cut, the badge loses its colours.
  const tab = tabs[at];
  if (!tab) return { text: "", width: 0 };
  const tail = width > count.length ? count : "";
  const cut = fitted(plain(tab), Math.max(width - tail.length, 0));
  const named = cut && `#[range=user|${at}]${openStyle}${escaped(cut)}#[default]#[norange]`;
  const text = `${named}${tail && `#[fg=brightblack]${tail}#[default]`}`;
  return { text, width: Bun.stringWidth(cut) + tail.length };
}

// What the top rows show: the tabs and the open one's owner/name, the remote Skelcrew runs on, if
// any, the names of the version of the Skelcrew running here, longest first, such as v0.4.2, and
// whether your typing goes to the right side, whose box is then the lit one, whether the right
// side fills the whole terminal, and on a screen that shows one side at a time the name of the
// side that shows, sidebar or the agent's, or empty, and while a dropped file was on another
// machine, this one as sc --remote takes it, such as simon@workbox, empty when unknown, or null.
export type Top = {
  tabs: Tab[];
  open: string;
  where: string;
  versions: string[];
  typingRight: boolean;
  fullScreen: boolean;
  side: string;
  elsewhere: string | null;
};

// Returns the screen's two top rows as tmux formats, given what they show and how wide the
// sidebar's pane and the right side's are. tmux's status lines span the whole terminal.
// The header is a row of its own: Skelcrew, its version and where it runs, then the tabs, which
// start where the right side does, so they sit above it. When one of the two doesn't fit its
// part, it takes what the other leaves, so nothing is left out while the row has room for it.
// Under it, the boxes' row draws the top of the box round each side, which tmux's lines between
// the panes can't: ┬ above each of those lines, and a stub of dim line above each pad at the
// outer edges, as tmux's line under the panes has. The box your typing goes to is lit, the line
// the sides share always, and the rest is dim, as tmux draws the lines below. While the right
// side fills the terminal, tmux hides the panes that draw the boxes' lines, so the whole boxes'
// row is lit, as the one mark left that your typing goes to the agent, with no corner over lines
// that aren't there. For a while after a file dropped was on another machine, the boxes' row also
// says how to drop it, or rows below it do when the command doesn't fit there. It reads nothing,
// so what you see can be tested without a terminal.
export function drawTop(top: Top, size: Size): { header: string; boxes: string; below: string[] } {
  // The header's own part covers the pad, the sidebar and the lines beside it, and the tabs' the
  // right side and its pad. What each needs to show whole: the header's name, its longest version
  // and the place, with a space after, and every tab.
  const width = size.sidebar + 3 + size.right + 2;
  const place = removeControlCodes(top.where);
  const side = { text: top.side, back: top.side !== "" && top.typingRight };
  const version = top.versions[0] ?? "";
  const headerNeeds =
    13 +
    (side.text ? 1 + Bun.stringWidth(sideText(side)) : 0) +
    (version ? 1 + Bun.stringWidth(version) : 0) +
    (place ? 3 + Bun.stringWidth(place) : 0);
  const tabsNeed = drawTabs(top.tabs, top.open, Number.POSITIVE_INFINITY).width;
  // A header too wide for its part grows into what the tabs leave, and tabs too wide for theirs
  // into what the header leaves. With both too wide, each keeps its part.
  let split = size.sidebar + 3;
  if (headerNeeds > split) split = Math.max(split, Math.min(headerNeeds, width - tabsNeed));
  else if (tabsNeed > width - split) split = Math.max(headerNeeds, width - tabsNeed);
  if (side.back) split = Math.max(split, Math.min(13 + backWidth, width));
  const tabs = drawTabs(top.tabs, top.open, Math.max(width - split, 0));
  const after = " ".repeat(Math.max(width - split - tabs.width, 0));
  const [left, right] = top.fullScreen ? [lit, lit] : top.typingRight ? [dim, lit] : [lit, dim];
  const [outer, corner] = top.fullScreen ? [lit, "─"] : [dim, "┬"];
  const command =
    top.elsewhere === null
      ? ""
      : `sc --remote ${removeControlCodes(top.elsewhere) || "<user@host>"}`;
  const inLine =
    command !== "" && Bun.stringWidth(command) <= (top.fullScreen ? width : size.right) - 4;
  const rightEdge =
    inLine && !top.fullScreen
      ? `${elsewhereLine(command, size.right, right)}${inColour(right, corner)}`
      : inColour(right, `${"─".repeat(Math.max(size.right, 0))}${corner}`);
  const boxes = [
    inColour(outer, "─"),
    inColour(left, `${corner}${"─".repeat(Math.max(size.sidebar, 0))}`),
    inColour(lit, corner),
    rightEdge,
    inColour(outer, "─"),
  ].join("");
  return {
    header: `${header(top.where, split, top.versions, side)}${tabs.text}${after}`,
    boxes: top.fullScreen && inLine ? elsewhereLine(command, width, lit) : boxes,
    below: command !== "" && !inLine ? elsewhereRows(command, width) : [],
  };
}

// Returns a line `width` columns wide in `colour`, with the longest way of saying how to drop a file
// from another machine that fits in it, which `command`, sc --remote and this machine, always does.
// It goes along the right side's box, or along the whole row while one side fills the terminal,
// so the box your typing goes to still shows.
function elsewhereLine(command: string, width: number, colour: string): string {
  const said = [
    `That file is on another machine. To drop files, run ${command} from that machine.`,
    `That file is on another machine. To drop files, run ${command} there.`,
    `File on another machine? Run ${command} there.`,
    `To drop files: ${command}`,
    command,
  ];
  const room = width - 4;
  const text = said.find((one) => Bun.stringWidth(one) <= room) ?? command;
  const line = (length: number) => inColour(colour, "─".repeat(length));
  return `${line(2)} #[fg=colour231]${escaped(text)}#[default] ${line(room - Bun.stringWidth(text))}`;
}

// The most rows a notice adds under the boxes' row, as tmux shows at most five status lines.
const mostRowsBelow = 3;

// Returns the rows, each `width` columns wide, that say how to drop a file from another machine
// when `command` doesn't fit along the boxes' row, such as on a phone. Words wrap, and a word
// longer than a row, such as a long hostname, goes on over the next, so the command shows whole.
// When that takes too many rows, the command alone fills them.
function elsewhereRows(command: string, width: number): string[] {
  const room = Math.max(width - 1, 1);
  const wrapped = (words: string[]) => {
    const rows = [""];
    for (const word of words) {
      const last = rows.length - 1;
      const longer = rows[last] ? `${rows[last]} ${word}` : word;
      if (Bun.stringWidth(longer) <= room) rows[last] = longer;
      else for (let at = 0; at < word.length; at += room) rows.push(word.slice(at, at + room));
    }
    return rows.filter((row) => row !== "");
  };
  const told = wrapped(`To drop files, run ${command}`.split(" "));
  const rows = told.length <= mostRowsBelow ? told : wrapped([command]);
  return rows.map((row) => {
    const rest = " ".repeat(Math.max(width - 1 - Bun.stringWidth(row), 0));
    return ` #[fg=colour231]${escaped(row)}#[default]${rest}`;
  });
}
