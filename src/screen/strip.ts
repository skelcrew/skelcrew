// The top row of the screen. Above the sidebar, the header says Skelcrew, its version and, on a
// remote, where it runs. Above the agent, a tab for each repository, then the strip, which says
// what you are looking at: for a thread, its name, task, PR and checks, then its latest review,
// and for a page, its row's name and title. The lead has none, as the sidebar says it all.
import { clean, fitted } from "./look.ts";
import type { Link, Row, Tab } from "./rows.ts";

type Size = { left: number; width: number };

const said = { passing: "checks passing", failing: "checks failing", pending: "checks running" };
const verdicts: Record<string, string> = {
  approve: "approved",
  changes: "changes",
  failed: "review failed",
};

// Returns text as tmux shows it as is. tmux reads the strip as a format, where #(...) would run
// a shell command and #[...] restyle the line. Any title on GitHub could say that. The strip goes
// through strftime too, so % is doubled for it to stay itself.
const escaped = (text: string) => text.replaceAll("#", "##").replaceAll("%", "%%");

// Returns what a review says, short enough to share the line, or nothing before the first one.
function aboutReview(row: Row): string {
  if (row.review === null) return "";
  const { round, reviewer, verdict } = row.review;
  const parts = [`round ${round}`, reviewer, verdicts[verdict] ?? verdict];
  return `  ${clean(parts.filter(Boolean).join(" · "))}`;
}

// Returns the strip for a thread, in `width` columns at most: its name in bold, then the rest.
// The name, PR and checks are what you look for, so the review takes what room is left and the
// title what the review leaves: the title is what is longest, and you have it from the task. A
// name too long for all that is shown alone.
function aboutThread(row: Row, width: number): [string, string] {
  // The name, then the PR and checks at the end. With no room left after them, the name shows
  // alone.
  const name = fitted(clean(row.name), width);
  const tail = [row.pr === null ? "" : `#${row.pr}`, row.checks ? said[row.checks] : ""]
    .filter(Boolean)
    .join("  ");
  const end = tail ? `  ${tail}` : "";
  const spare = width - Bun.stringWidth(name) - Bun.stringWidth(end);
  if (spare < 0) return [name, ""];
  // The review takes what room is left, then the title what the review leaves.
  const review = fitted(aboutReview(row), spare);
  const room = spare - Bun.stringWidth(review);
  const title = row.title ? fitted(`  ${clean(row.title)}`, room) : "";
  return [name, `${title}${end}${review}`];
}

// Returns the strip for a page: its row's name, and its title in what room is left.
function aboutPage(page: Link, width: number): [string, string] {
  const name = fitted(clean(page.name), width);
  return [name, fitted(`  ${clean(page.title)}`, width - Bun.stringWidth(name))];
}

// Skelcrew's name above the sidebar, in the white of a selected name. A 256-colour number, so it
// looks the same whatever your theme.
const skelName = "#[bold,fg=colour231]Skelcrew#[default]";

// Returns the header above the sidebar: Skelcrew's name, in line with the sidebar's marks, then dim
// its version, such as v0.4.2, then, on a remote, a dot and where it runs, then spaces out to the
// sidebar's edge. `where` is empty on this machine. It comes from outside, so it is made safe as a
// title is, and cut to stop two columns before the sidebar's edge, as all the sidebar's text does.
// The place gives way first. A version is never cut, as half a number would be a different one.
function header(where: string, left: number, version: string): string {
  // "  Skelcrew" takes ten columns. The sidebar's edge is two columns left of the agent, and text
  // stops two before it, so what follows the name has `room`.
  const named = 10;
  const room = Math.max(left - 4 - named, 0);
  const shown = `v${version}`;
  const taken = Bun.stringWidth(shown) + 1;
  const number = room >= taken ? ` ${shown}` : "";
  // " · " before the place takes three columns.
  const place = fitted(clean(where), Math.max(room - 3 - taken, 0));
  const about = `${number}${place && ` · ${place}`}`;
  const spare = " ".repeat(Math.max(left - 2 - named - Bun.stringWidth(about), 0));
  const dim = about && `#[fg=brightblack]${escaped(about)}#[default]`;
  return `  ${skelName}${dim}${spare}`;
}

// Returns the tabs as a tmux format, and the columns they take, given each repository's tab, the
// open one's owner/name, and the agent's width. Each tab is the repository's name, with a yellow
// dot and a count when threads in it need you or failed, such as site •1, and two spaces on each
// side, so the open one's grey reads as a tab. The open one is bold white on the grey a picked row
// has, and the others dim. When they don't fit, those furthest from the open one give way, and a
// dim count says how many. Each tab is a range of its own, named by its place in the list, so a
// click on it can say which it was.
function drawTabs(tabs: Tab[], open: string, width: number): [string, number] {
  // Starts from the open tab, or the first when none is open.
  const at = Math.max(
    tabs.findIndex((tab) => tab.fullName === open),
    0,
  );
  // Returns a tab's text: its name, with its count when threads in it need you or failed.
  const label = (tab: Tab) => `  ${tab.name}${tab.count ? ` •${tab.count}` : ""}  `;
  // Returns how many columns the tab at a place in the list takes, or none past either end.
  const wide = (index: number) => {
    const tab = tabs[index];
    return tab ? Bun.stringWidth(label(tab)) : 0;
  };
  const all = tabs.reduce((sum, tab) => sum + Bun.stringWidth(label(tab)), 0);
  // The count of those left out goes at the end, and needs its room kept.
  const room = all <= width ? width : width - `  +${tabs.length}`.length;
  // Takes in tabs out from the open one, one on each side at a time, until neither side fits
  // another. The open tab always shows.
  let [first, last, used] = [at, at, wide(at)];
  let [left, right] = [true, true];
  while (left || right) {
    if (right && last + 1 < tabs.length && used + wide(last + 1) <= room) used += wide(++last);
    else right = false;
    if (left && first > 0 && used + wide(first - 1) <= room) used += wide(--first);
    else left = false;
  }
  // The open tab's dot is the yellow that shows on its grey. A dim count of those left out ends
  // the row.
  const shown = tabs.slice(first, last + 1).map((tab, offset) => {
    const here = first + offset === at;
    const style = here ? "#[bg=colour238,fg=colour231,bold]" : "#[fg=brightblack]";
    const dot = here ? "#[fg=colour221]" : "#[fg=yellow]";
    const badge = tab.count ? ` ${dot}•${tab.count}` : "";
    return `#[range=user|${first + offset}]${style}  ${escaped(tab.name)}${badge}  #[default]#[norange]`;
  });
  const out = tabs.length - shown.length;
  const count = out > 0 ? `  +${out}` : "";
  return [
    `${shown.join("")}${count && `#[fg=brightblack]${count}#[default]`}`,
    used + count.length,
  ];
}

// What the top row shows: the rows, the session on the right, the row of the page there, if that
// is what shows, the tabs and the open one's owner/name, the remote Skelcrew runs on, if any, and
// the version of the Skelcrew running here.
export type Top = {
  rows: Row[];
  shown: string | null;
  page: Link | null;
  tabs: Tab[];
  open: string;
  where: string;
  version: string;
};

// Returns the top row of the screen as a tmux format, given what it shows and where the agent's
// pane is, `left` columns in and `width` wide. tmux's one status line spans the whole terminal.
// Above the sidebar is the header, with the sidebar's edge carried up through the row, so the
// edge runs from top to bottom. Above the agent are the tabs, then, dim and at the right end,
// the strip: what you are looking at. The tabs come first, so the strip gives way before any
// tab. A page shows its row, a thread its own strip, and the lead none. It reads nothing, so
// what you see can be tested without a terminal.
export function drawTop(top: Top, size: Size): string {
  const { left, width } = size;
  const [tabs, taken] = drawTabs(top.tabs, top.open, width);
  // Two columns part the strip from the tabs.
  const room = Math.max(width - taken - 2, 0);
  const row = top.rows.find((candidate) => candidate.session === top.shown);
  const [name, rest] = top.page
    ? aboutPage(top.page, room)
    : row && row.status !== null
      ? aboutThread(row, room)
      : ["", ""];
  const spare = " ".repeat(Math.max(width - taken - Bun.stringWidth(`${name}${rest}`), 0));
  const strip = name && `#[fg=brightblack,bold]${escaped(name)}#[nobold]${escaped(rest)}#[default]`;
  const edge = "#[fg=colour237]│#[default] ";
  return `${header(top.where, left, top.version)}${edge}${tabs}${spare}${strip}`;
}
