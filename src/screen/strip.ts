// The lines above the agent. First a row of tabs, one per repository. Then the strip, which
// says what you are looking at: for a thread, its name, task, PR and checks, then its latest
// review, and for a page, its row's name and title. The lead has none, as the sidebar says it
// all. Above the sidebar the strip's line says Skelcrew, its release and, on a remote, where it
// runs. A thin line runs under them all.
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

// Returns the line for a thread. The name, PR and checks are what you look for, so the review
// takes what room is left and the title what the review leaves: the title is what is longest,
// and you have it from the task. A name too long for all that is shown alone.
function aboutThread(row: Row, width: number): string {
  // The name, then the PR and checks at the end. With no room left after them, the name shows
  // alone.
  const name = fitted(clean(row.name), width);
  const tail = [row.pr === null ? "" : `#${row.pr}`, row.checks ? said[row.checks] : ""]
    .filter(Boolean)
    .join("  ");
  const end = tail ? `  ${tail}` : "";
  const spare = width - Bun.stringWidth(name) - Bun.stringWidth(end);
  if (spare < 0) return `#[bold]${escaped(name)}#[default]`;
  // The review takes what room is left, then the title what the review leaves. The name is
  // bold, the review dim.
  const review = fitted(aboutReview(row), spare);
  const room = spare - Bun.stringWidth(review);
  const title = row.title ? fitted(`  ${clean(row.title)}`, room) : "";
  const dim = review ? `#[fg=brightblack]${escaped(review)}` : "";
  return `#[bold]${escaped(name)}#[default]${escaped(title)}${escaped(end)}${dim}`;
}

// Returns the line for a page: its row's name, and its title in what room is left.
function aboutPage(page: Link, width: number): string {
  const name = fitted(clean(page.name), width);
  const title = fitted(`  ${clean(page.title)}`, width - Bun.stringWidth(name));
  return `#[bold]${escaped(name)}#[default]${escaped(title)}`;
}

// Skelcrew's name above the sidebar, in the white of a selected name. A 256-colour number, so it
// looks the same whatever your theme.
const skelName = "#[bold,fg=colour231]Skelcrew#[default]";

// Returns the header above the sidebar: Skelcrew's name, in line with the sidebar's marks, then dim
// the release, if any, then, on a remote, a dot and where it runs, then spaces out to the agent's
// column. `where` is empty on this machine. It comes from outside, so it is made safe as a title
// is, and cut to stop two columns before the sidebar's edge, as all the sidebar's text does. The
// place gives way first. A release is never cut, as half a number would be a different release.
function header(where: string, left: number, release: string): string {
  // "  Skelcrew" takes ten columns. The sidebar's edge is two columns left of the agent, and text
  // stops two before it, so what follows the name has `room`.
  const named = 10;
  const room = Math.max(left - 4 - named, 0);
  const taken = release ? Bun.stringWidth(release) + 1 : 0;
  const version = release && room >= taken ? ` ${release}` : "";
  // " · " before the place takes three columns.
  const place = fitted(clean(where), Math.max(room - 3 - taken, 0));
  const about = `${version}${place && ` · ${place}`}`;
  const spare = " ".repeat(Math.max(left - named - Bun.stringWidth(about), 0));
  const dim = about && `#[fg=brightblack]${escaped(about)}#[default]`;
  return `  ${skelName}${dim}${spare}`;
}

// Returns the strip's three lines as tmux formats, given the rows, the session on the right,
// where the agent's pane is, `left` columns in and `width` wide, the remote Skelcrew runs on, if
// any, the release of the Skelcrew running here, if it is one, and the row of the page on the
// right, if that is what shows. tmux's status lines span the whole terminal. The first is the
// header above the sidebar, exactly `left` wide, so the tabs that follow it start above the
// agent. The second is what the agent on the right is working on, above the agent. The third
// meets the line at the sidebar's edge, two columns left of the agent, with a ┬. It reads
// nothing, so what you see can be tested without a terminal. Always three lines, so the agent's
// height never changes.
export function drawStrip(
  rows: Row[],
  session: string | null,
  size: Size,
  where: string,
  release = "",
  page: Link | null = null,
): [string, string, string] {
  const { left, width } = size;
  // The second line is the thin line, meeting the sidebar's edge with a ┬.
  const top = header(where, left, release);
  const line = `#[fg=colour237]${"─".repeat(Math.max(left - 2, 0))}┬${"─".repeat(width + 1)}`;
  // The second line is blank above the sidebar, so what follows starts above the agent.
  const blank = " ".repeat(left);
  // A page shows its row, a thread its own line, and the lead nothing.
  if (page) return [top, `${blank}${aboutPage(page, width)}`, line];
  const row = rows.find((candidate) => candidate.session === session);
  if (!row || row.status === null) return [top, blank, line];
  return [top, `${blank}${aboutThread(row, width)}`, line];
}

// Returns the tabs as a tmux format, given each repository's tab, the open one's owner/name, and
// the agent's width. They follow the header on the first line, above the agent. Each tab is the
// repository's name, with a yellow dot and a count when threads in it need you or failed, such
// as site •1. The open one is bold white on the grey a picked row has, and the others dim. When
// they don't fit, those furthest from the open one give way, and a dim count says how many. Each tab is a range of its own, named by its place in the list, so a click on it
// can say which it was. It reads nothing, so what you see can be tested without a terminal.
export function drawTabs(tabs: Tab[], open: string, width: number): string {
  // Starts from the open tab, or the first when none is open.
  const at = Math.max(
    tabs.findIndex((tab) => tab.fullName === open),
    0,
  );
  // Returns a tab's text: its name, with its count when threads in it need you or failed.
  const label = (tab: Tab) => ` ${tab.name}${tab.count ? ` •${tab.count}` : ""} `;
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
    const badge = tab.count ? `${dot}•${tab.count} ` : "";
    return `#[range=user|${first + offset}]${style} ${escaped(tab.name)} ${badge}#[default]#[norange]`;
  });
  const out = tabs.length - shown.length;
  return `${shown.join("")}${out > 0 ? `#[fg=brightblack]  +${out}#[default]` : ""}`;
}
