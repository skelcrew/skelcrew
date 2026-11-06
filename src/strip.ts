// The strip: one line above the agent saying what you are looking at. For a thread, its name,
// task, PR and checks, then its latest review. The lead has none, as the sidebar says it all.
// Above the sidebar the same line says skel and, on a remote, where it runs. A thin line runs under them all.
import type { Row } from "./sidebar.ts";

type Size = { left: number; width: number };

const said = { passing: "checks passing", failing: "checks failing", pending: "checks running" };
const verdicts: Record<string, string> = {
  approve: "approved",
  changes: "changes",
  failed: "review failed",
};

// Returns text from outside, such as an issue's title, safe to show: its control codes would
// otherwise reach your terminal, or break the line.
export const clean = (text: string) => text.replace(/\p{Cc}/gu, " ");

// Returns text cut to fit a number of columns, with … where it was cut. Columns, not characters,
// as a Japanese title takes two for each.
export function fitted(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text;
  let cut = "";
  for (const letter of text) {
    if (Bun.stringWidth(`${cut}${letter}…`) > width) break;
    cut += letter;
  }
  return width > 0 ? `${cut}…` : "";
}

// Returns text as tmux shows it as is. tmux reads the strip as a format, where #(...) would run
// a shell command and #[...] restyle the line. Any title on GitHub could say that. The strip goes
// through strftime too, so % is doubled for it to stay itself.
const shown = (text: string) => text.replaceAll("#", "##").replaceAll("%", "%%");

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
  const name = fitted(clean(row.name), width);
  const tail = [row.pr === null ? "" : `#${row.pr}`, row.checks ? said[row.checks] : ""]
    .filter(Boolean)
    .join("  ");
  const end = tail ? `  ${tail}` : "";
  const spare = width - Bun.stringWidth(name) - Bun.stringWidth(end);
  if (spare < 0) return `#[bold]${shown(name)}#[default]`;
  const review = fitted(aboutReview(row), spare);
  const room = spare - Bun.stringWidth(review);
  const title = row.title ? fitted(`  ${clean(row.title)}`, room) : "";
  const dim = review ? `#[fg=brightblack]${shown(review)}` : "";
  return `#[bold]${shown(name)}#[default]${shown(title)}${shown(end)}${dim}`;
}

// skel's name above the sidebar, in the white of a selected name. A 256-colour number, so it
// looks the same whatever your theme.
const skelName = "#[bold,fg=colour231]skel#[default]";

// Returns the header above the sidebar: skel's name, in line with the sidebar's marks, then, on
// a remote, a dim dot and where it runs, then spaces out to the agent's column. `where` is empty
// on this machine. It comes from outside, so it is made safe as a title is, and cut to stop two
// columns before the sidebar's edge, as all the sidebar's text does.
function header(where: string, left: number): string {
  const place = fitted(clean(where), Math.max(left - 13, 0));
  const about = place && ` · ${place}`;
  const spare = " ".repeat(Math.max(left - 6 - Bun.stringWidth(about), 0));
  const dim = about && `#[fg=brightblack]${shown(about)}#[default]`;
  return `  ${skelName}${dim}${spare}`;
}

// Returns the strip's two lines as tmux formats, given the rows, the session on the right,
// where the agent's pane is, `left` columns in and `width` wide, and the remote skel runs on, if
// any. tmux's status lines span the whole terminal, so the first starts with the header, and the second
// meets the line at the sidebar's edge, two columns left of the agent, with a ┬. It reads
// nothing, so what you see can be tested without a terminal. Always two lines, so the agent's
// height never changes.
export function drawStrip(
  rows: Row[],
  session: string | null,
  size: Size,
  where: string,
): [string, string] {
  const { left, width } = size;
  const top = header(where, left);
  const line = `#[fg=colour237]${"─".repeat(Math.max(left - 2, 0))}┬${"─".repeat(width + 1)}`;
  const row = rows.find((candidate) => candidate.session === session);
  if (!row || row.status === null) return [top, line];
  return [`${top}${aboutThread(row, width)}`, line];
}
