// The top row of the screen. Above the sidebar, the header says Skelcrew, its version and, on a
// remote, where it runs. Above the right side, a tab for each repository.
import type { Tab } from "../list/rows.ts";
import { fitted, removeControlCodes } from "./look.ts";

type Size = { left: number; width: number };

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

// Returns text as tmux shows it as is. tmux reads the top row as a format, where #(...) would run
// a shell command and #[...] restyle the line. A repository's name or where Skelcrew runs could
// say that. The row goes through strftime too, so % is doubled for it to stay itself.
const escaped = (text: string) => text.replaceAll("#", "##").replaceAll("%", "%%");

// Skelcrew's name above the sidebar, in the white of a selected name. A 256-colour number, so it
// looks the same whatever your theme.
const skelName = "#[bold,fg=colour231]Skelcrew#[default]";

// Returns the header above the sidebar: Skelcrew's name, in line with the sidebar's marks, then dim
// the longest name of its version that fits, such as v0.4.2 or 6f1c2ab (checkout), then, on a
// remote, a dot and where it runs, then spaces out to the sidebar's edge. `where` is empty on this
// machine. It comes from outside, so it is made safe as a
// title is, and cut to stop two columns before the sidebar's edge, as all the sidebar's text does.
// The place gives way first. A version is never cut, as half a number would be a different one.
function header(where: string, left: number, versions: string[]): string {
  // "  Skelcrew" takes ten columns. The sidebar's edge is two columns left of the agent, and text
  // stops two before it, so what follows the name has `room`.
  const nameWidth = 10;
  const room = Math.max(left - 4 - nameWidth, 0);
  // With no name that fits, the shortest stands in, so the place doesn't take the room either.
  const fits = (name: string) => Bun.stringWidth(name) + 1 <= room;
  const shown = versions.find(fits) ?? versions.at(-1) ?? "";
  const taken = Bun.stringWidth(shown) + 1;
  const number = room >= taken ? ` ${shown}` : "";
  // " · " before the place takes three columns.
  const place = fitted(removeControlCodes(where), Math.max(room - 3 - taken, 0));
  const about = `${number}${place && ` · ${place}`}`;
  const spare = " ".repeat(Math.max(left - 2 - nameWidth - Bun.stringWidth(about), 0));
  const dim = about && `#[fg=brightblack]${escaped(about)}#[default]`;
  return `  ${skelName}${dim}${spare}`;
}

// Returns the tabs as a tmux format, given each repository's tab, the open one's owner/name, and
// the right side's width. Each tab is the repository's name, with its badge when threads in it
// need you or are ready, such as site •2 •1, and two spaces on each side, so the open one's grey
// reads as a tab. The open one is bold white on the grey a picked row
// has, and the others dim. When they don't fit, those furthest from the open one give way, and a
// dim count says how many. Each tab is a range of its own, named by its place in the list, so a
// click on it can say which it was.
function drawTabs(tabs: Tab[], open: string, width: number): string {
  // Starts from the open tab, or the first when none is open.
  const at = Math.max(
    tabs.findIndex((tab) => tab.fullName === open),
    0,
  );
  // Returns a tab's text: its name, with its badge.
  const label = (tab: Tab) =>
    `  ${tab.name}${dots(tab)
      .map(([, text]) => ` ${text}`)
      .join("")}  `;
  // Returns how many columns the tab at a place in the list takes, or none past either end.
  const tabWidth = (index: number) => {
    const tab = tabs[index];
    return tab ? Bun.stringWidth(label(tab)) : 0;
  };
  const all = tabs.reduce((sum, tab) => sum + Bun.stringWidth(label(tab)), 0);
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
  // Tabs have greys of their own, so they stand apart from the sidebar and the agent: the open
  // one bold white on a dark grey, the others dim on a lighter one. A tab's dots are in the
  // sidebar's fixed colours, as a theme's own can look like another colour. A dim count of
  // those left out ends the row.
  const shown = tabs.slice(first, last + 1).map((tab, offset) => {
    const here = first + offset === at;
    const style = here ? "#[bg=colour234,fg=colour231,bold]" : "#[bg=colour237,fg=colour245]";
    const badge = dots(tab)
      .map(([colour, text]) => ` #[fg=${tmuxColours[colour]}]${text}`)
      .join("");
    return `#[range=user|${first + offset}]${style}  ${escaped(tab.name)}${badge}  #[default]#[norange]`;
  });
  const out = tabs.length - shown.length;
  const count = out > 0 ? `  +${out}` : "";
  return `${shown.join("")}${count && `#[fg=brightblack]${count}#[default]`}`;
}

// What the top row shows: the tabs and the open one's owner/name, the remote Skelcrew runs on, if
// any, the names of the version of the Skelcrew running here, longest first, such as v0.4.2, and
// whether your typing goes to the right side, which the sidebar's edge leans to.
export type Top = {
  tabs: Tab[];
  open: string;
  where: string;
  versions: string[];
  typingRight: boolean;
};

// Returns the top row of the screen as a tmux format, given what it shows and where the right
// side's pane is, `left` columns in and `width` wide. tmux's one status line spans the whole
// terminal. Above the sidebar is the header, with the sidebar's edge carried up through the row,
// so the edge runs from top to bottom, leaning to the side your typing goes to, as the sidebar
// draws it. Above the right side are the tabs. It reads nothing, so what you see can be tested
// without a terminal.
export function drawTop(top: Top, size: Size): string {
  const { left, width } = size;
  const edge = `#[fg=colour250]${top.typingRight ? "▕" : "▏"}#[default] `;
  return `${header(top.where, left, top.versions)}${edge}${drawTabs(top.tabs, top.open, width)}`;
}
