// The sidebar: the left pane of the screen, with three lists, all of the open repository's.
// THREADS has its lead and every thread that isn't done, with what each is doing. ISSUES and
// PRS show what is open on GitHub, as links. It only shows, switches, links and opens pages.
// Picking a thread switches the client in the right pane, and picking an issue or PR puts its
// page there. It also keeps the tabs and the strip above that pane up to date, and switches to
// another repository's tab.
import {
  paneTty,
  paneWidth,
  respawnPane,
  runningSessions,
  screenSocket,
  shownSession,
  showSession,
  showStrip,
} from "../agents/tmux.ts";
import { openRepository } from "../client.ts";
import { threadConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { leadOf } from "../flow/lead.ts";
import type { Thread } from "../flow/thread.ts";
import { updateNotice } from "../machine/update.ts";
import { leadPlaces } from "../paths.ts";
import { release } from "../version.ts";
import { clean, edge, fitted, grey, onShade, pad, paint, shade, white, yellow } from "./look.ts";
import {
  type Link,
  type List,
  type Lists,
  needing,
  type Open,
  type Row,
  repositoryTabs,
  sidebarLists,
  sidebarRows,
  threadMark,
} from "./rows.ts";
import { agentClient, pageCommand, sidebarWidth } from "./screen.ts";
import { drawStrip, drawTabs } from "./strip.ts";

type Size = { width: number; height: number };
// One line of the sidebar, with the row it belongs to, if any, for a click. A line that `joins`
// the sidebar's edge runs into it, as the lines between lists do.
type Line = { text: string; row?: Row; link?: Link; joins?: boolean };
// A row you can move to, by what names it: a thread's session or a link's url. `open` says
// whether anything could show on the right.
type Stop = { place: string; open: boolean };

// Where a name starts, past its mark.
const indent = `${pad}  `;
// The keys you need most, at the bottom of the sidebar.
const hints = [`${pad}⌥↑↓ move`, `${pad}⌥⇧↑↓ list`, `${pad}⌥←→ repo`, `${pad}⌃Q quit`];

// Returns a line with spaces added out to a width.
const filled = (line: string, width: number) =>
  `${line}${" ".repeat(Math.max(width - Bun.stringWidth(line), 0))}`;

// Returns text in a colour, or, on the row you are looking at, the one that stands in for it on
// the grey.
const tinted = (here: boolean, code: number, text: string) =>
  paint(here ? (onShade[code] ?? code) : code, text);

// Returns a line with the grey behind it, out to the end of the row.
const band = (line: string, width: number) => `\x1b[${shade}m${filled(line, width)}\x1b[49m`;

// Returns one row as lines: a mark and the whole name, which goes on to more lines when it is
// too long, then the word and harness. A cut name could hide what tells two threads apart. An
// agent that isn't running is dim, as it can't be picked. The one you are looking at is shaded
// across the whole width, on all its lines.
function rowLines(row: Row, here: boolean, width: number): string[] {
  // Returns part of the name as this row shows it.
  const styled = (name: string) => {
    if (here) return paint(white, name);
    return row.running ? name : paint(grey, name);
  };
  const room = Math.max(width - indent.length - pad.length, 1);
  const [first = "", ...rest] = row.name.match(new RegExp(`.{1,${room}}`, "g")) ?? [];
  const [sign, colour] = threadMark(row);
  const word = row.word.slice(0, room);
  const after = [row.harness, row.age].flatMap((part) => (part ? [` · ${part}`] : [])).join("");
  const more = after.slice(0, room - word.length);
  const lines = [
    `${pad}${tinted(here, colour, sign)} ${styled(first)}`,
    ...rest.map((part) => `${indent}${styled(part)}`),
    `${indent}${tinted(here, needing(row) ? yellow : grey, word)}${more && tinted(here, grey, more)}`,
  ];
  return here ? lines.map((line) => band(line, width)) : lines;
}

// Returns a row of ISSUES or PRS as two lines, each a terminal link and cut to stop at the
// padding: its title, then, dim, its name and a PR's word, in the colours a thread gives that
// word. A PR's mark comes before its title, outside the link. An issue has none, so its lines
// start at the padding. skel may run on another machine than your browser, so your terminal
// opens the link. The title comes from outside, so it is made safe. The one you are looking at
// is shaded as a thread's row is.
function linkLines(link: Link, here: boolean, width: number): string[] {
  const start = link.mark ? indent : pad;
  const room = Math.max(width - start.length - pad.length, 0);
  const title = fitted(clean(link.title), room);
  const name = fitted(link.name, room);
  const word = link.word && fitted(link.word, room - Bun.stringWidth(name) - 3);
  const about =
    word && `${tinted(here, grey, " · ")}${tinted(here, link.needing ? yellow : grey, word)}`;
  const heading = here ? paint(white, title) : link.dim ? paint(grey, title) : title;
  const [top, bottom] = [heading, `${tinted(here, grey, name)}${about}`].map(
    (text) => `\x1b]8;;${link.url}\x1b\\${text}\x1b]8;;\x1b\\`,
  );
  const mark = link.mark && `${pad}${tinted(here, link.mark[1], link.mark[0])} `;
  const lines = [`${mark ?? pad}${top}`, `${start}${bottom}`];
  return here ? lines.map((line) => band(line, width)) : lines;
}

// Returns what starts a list: its heading, dim, and the blank line that parts it from the rows.
const headed = (heading: string): Line[] => [
  { text: paint(grey, `${pad}${heading}`) },
  { text: "" },
];

// Returns a list's lines for a third of `height` lines: its heading and a blank line, as many
// rows as fit, then a count of the rest. Rows come with the dim ones last, so those are the
// first to be left out. A third with room for just one row keeps the row, and the count gives
// way. An empty list says so, as its third stays either way.
function listLines(
  heading: string,
  list: List,
  shown: string | null,
  height: number,
  width: number,
): Line[] {
  const top = headed(heading);
  if (list.links.length === 0) return [...top, { text: paint(grey, `${pad}none`) }];
  const fit = Math.floor((height - top.length) / 2);
  const few = list.total > fit ? Math.max(Math.floor((height - top.length - 1) / 2), 1) : fit;
  const links = list.links.slice(0, few);
  const rest = list.total - links.length;
  return [
    ...top,
    ...links.flatMap((link) =>
      linkLines(link, link.url === shown, width).map((text) => ({ text, link })),
    ),
    ...(rest > 0 ? [{ text: paint(grey, `${pad}+ ${rest} more`) }] : []),
  ].slice(0, height);
}

// Returns lines with blank ones added, out to a height.
const padded = (lines: Line[], height: number) => [
  ...lines,
  ...Array<Line>(height - lines.length).fill({ text: "" }),
];

// Returns what fits of the threads in a number of lines, by whole rows from the top, just far
// enough down to keep the row you are looking at in view, so Alt-Down never moves off the bottom.
function scrolled(blocks: Line[][], here: number, room: number): Line[] {
  let used = blocks.slice(0, here + 1).flat().length;
  let first = 0;
  while (first < here && used > room) {
    used -= blocks[first]?.length ?? 0;
    first++;
  }
  return blocks.slice(first).flat().slice(0, room);
}

// Returns the lines above the hints, and how many there can be. The hints take the bottom four,
// until the sidebar can't hold them and the whole row you are looking at: then they give way, as
// the rows are what you pick from and the keys are also in skel's help.
// ISSUES, THREADS and PRS each have a third of those lines, however full, so each list stays in
// the same place on screen, and what doesn't divide goes to THREADS. On a terminal too short for
// a heading and a row in each third, or for the row you are looking at in THREADS, ISSUES and PRS
// go, and THREADS has the whole sidebar, as it is the list you move through.
function layout(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
): { lines: Line[]; room: number } {
  const width = size.width - 1;
  const blocks = rows.map((row) =>
    rowLines(row, row.session === shown, width).map((text) => ({ text, row })),
  );
  const here = rows.findIndex((row) => row.session === shown);
  const tallest = blocks[here]?.length ?? 2;
  const room = size.height >= tallest + hints.length ? size.height - hints.length : size.height;
  const third = Math.floor((room - 2) / 3);
  const middle = room - 2 - 2 * third;
  const top = headed("Threads");
  if (third < top.length + 2 || middle < top.length + tallest)
    return { lines: scrolled(blocks, here, room), room };
  const divider = { text: paint(edge, "─".repeat(Math.max(width, 0))), joins: true };
  const lines = [
    ...padded(listLines("Issues", lists.issues, shown, third, width), third),
    divider,
    ...top,
    ...padded(scrolled(blocks, here, middle - top.length), middle - top.length),
    divider,
    ...listLines("PRs", lists.prs, shown, third, width),
  ];
  return { lines, room };
}

// Returns the whole sidebar as lines, given the rows, the lists, what is on the right, as a
// session or a link's url, and the sidebar's size. It reads nothing, so what you see can be
// tested without a terminal. Every line fills the pane and ends with the sidebar's edge, in the
// last column. tmux's own border beside it is blank, which leaves a gap before the agent.
export function draw(rows: Row[], lists: Lists, shown: string | null, size: Size): string {
  const { lines, room } = layout(rows, lists, shown, size);
  const width = size.width - 1;
  const keys = hints.map((hint) => ({
    text: paint(grey, hint.slice(0, Math.max(width - pad.length, 0))),
  }));
  const all: Line[] = [...padded(lines, room), ...(room < size.height ? keys : [])];
  return all
    .map(({ text, joins }) => `${filled(text, width)}${paint(edge, joins ? "┤" : "│")}`)
    .join("\n");
}

// Returns what you can move to, list by list, top to bottom. Every thread counts, as THREADS
// scrolls to keep you in view. Of ISSUES and PRS only the rows on screen do, since they have
// no scrolling, and a row you can't see would be a page you can't place.
function stops(rows: Row[], lists: Lists, shown: string | null, size: Size): Stop[][] {
  const { lines } = layout(rows, lists, shown, size);
  // Returns the rows of a list that the sidebar shows.
  const seen = ({ links }: List) =>
    links
      .filter((link) => lines.some((line) => line.link === link))
      .map((link) => ({ place: link.url, open: true }));
  const threads = rows.map((row) => ({ place: row.session, open: row.running }));
  return [seen(lists.issues), threads, seen(lists.prs)];
}

// Returns the lines that go above the lists for a notice, such as a release installed in the
// background, or none without one. Cut at words to fit a sidebar `width` columns wide, and
// parted from the lists by a blank line. Each fills the pane and ends with the sidebar's edge.
export function noticeLines(notice: string, width: number): string[] {
  if (!notice) return [];
  const room = Math.max(width - 1 - 2 * pad.length, 1);
  const lines = [""];
  for (const word of notice.split(" ")) {
    const last = lines.length - 1;
    const longer = lines[last] ? `${lines[last]} ${word}` : word;
    if (Bun.stringWidth(longer) <= room || !lines[last]) lines[last] = longer;
    else lines.push(word);
  }
  return [...lines.map((line) => `${pad}${line}`), ""].map(
    (line) => `${filled(line, width - 1)}${paint(edge, "│")}`,
  );
}

// Returns what is one row up or down, for Alt-Up and Alt-Down, as a session or a link's url, or
// null at either end. Rows whose agent isn't running are stepped over: nothing could show on
// the right. From a row that has gone, it goes to the lead.
export function stepped(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
  by: 1 | -1,
): string | null {
  const all = stops(rows, lists, shown, size).flat();
  const here = all.findIndex((stop) => stop.place === shown);
  if (here === -1) return rows[0]?.session ?? null;
  for (let i = here + by; i >= 0 && i < all.length; i += by)
    if (all[i]?.open) return all[i]?.place ?? null;
  return null;
}

// Returns the first row of the list before or after the one you are in, for Alt-Shift-Up and
// Alt-Shift-Down, or null past the first and last. A list with nothing to land on is passed over.
export function jumped(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
  by: 1 | -1,
): string | null {
  const landable = stops(rows, lists, shown, size).filter(
    (list) => list.some((stop) => stop.open) || list.some((stop) => stop.place === shown),
  );
  const here = landable.findIndex((list) => list.some((stop) => stop.place === shown));
  if (here === -1) return rows[0]?.session ?? null;
  return landable[here + by]?.find((stop) => stop.open)?.place ?? null;
}

// Returns what is at a line of the sidebar, counted from 0, for a click, as a session or a
// link's url, or null when there is no row there or its agent isn't running. Any line of a row
// picks it. Your terminal opens a link on Cmd-click by itself, so a plain click is free for this.
export function picked(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
  y: number,
): string | null {
  const line = layout(rows, lists, shown, size).lines[y];
  if (line?.link) return line.link.url;
  return line?.row?.running ? line.row.session : null;
}

// What the sidebar reads: Alt with an arrow as tmux sends it, 3 without Shift and 4 with it,
// the left button going down, with its place on screen, and a click on a tab, which the
// screen's tmux sends as an OSC with the tab's place in the row.
const esc = "\x1b";
const input = new RegExp(
  `${esc}\\[1;([34])([ABCD])|${esc}\\[<0;\\d+;(\\d+)M|${esc}\\]skel-tab;(\\d+)\x07`,
  "g",
);

// Returns the repository open in the sidebar, given its GitHub name, with its lead's session.
// One skel no longer has, such as one removed this moment, has the name a new lead would.
function opening(db: ReturnType<typeof openDb>, fullName: string): Open {
  const [owner = "", repo = ""] = fullName.split("/");
  try {
    return { owner, repo, lead: leadOf(db, owner, repo).name };
  } catch {
    return { owner, repo, lead: leadPlaces(owner, repo).name };
  }
}

// Runs the sidebar until its pane goes. The session given is its own, on the screen's server,
// `where` says which remote skel runs on, if any, for the header above it, and `repository`
// is the GitHub name of the repository it opens on.
// tmux brings it the keys that move and clicks on its input. It looks again each second, and
// writes only when something changed: over a slow link each write costs, and on a Sprite a
// terminal that stays quiet lets it sleep.
export async function runSidebar(
  agents: string,
  session: string,
  where: string,
  repository: string,
): Promise<void> {
  const db = openDb();
  let open = opening(db, repository);
  let tabs = repositoryTabs(db);
  const right = `=${session}:.1`;
  let tty = paneTty(screenSocket(agents), right);
  let rows: Row[] = [];
  let lists: Lists = { issues: { links: [], total: 0 }, prs: { links: [], total: 0 } };
  // What is on the right: a session, or a link's url while `page` is that link's row.
  let shown: string | null = null;
  let page: Link | null = null;
  let last = "";
  let lastStrip = "";
  // The notice's lines, above the lists, which have the height that is left.
  let notice: string[] = [];
  // Returns a thread's round limit, from its repository's skel.yaml or your config. Settings
  // that aren't valid already stop rounds, with the reason, and mustn't also take the sidebar
  // away. Such a thread then reads as never past the limit.
  const maxRounds = (thread: Thread) => {
    try {
      return threadConfig(thread).maxRounds;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  // Returns the size the lists have now, as the terminal can change it at any time.
  const size = (): Size => ({
    width: process.stdout.columns || sidebarWidth,
    height: (process.stdout.rows || 24) - notice.length,
  });
  // Returns the row of ISSUES or PRS with a link's url, if any.
  const linkAt = (url: string | null) =>
    [...lists.issues.links, ...lists.prs.links].find((link) => link.url === url) ?? null;
  // Looks at the database and tmux again, and redraws what that changed.
  const refresh = () => {
    tabs = repositoryTabs(db);
    // A repository you removed has no tab left, and the sidebar moves to the first one.
    const first = tabs[0];
    if (first && !tabs.some((tab) => tab.fullName === `${open.owner}/${open.repo}`))
      switchTo(first.fullName);
    notice = noticeLines(updateNotice(), size().width);
    rows = sidebarRows(db, runningSessions(agents), maxRounds, Date.now(), open);
    // A row takes two lines, so the sidebar's height is more than any list can show.
    lists = sidebarLists(db, rows, size().height, open);
    // A page's row can go at a poll, and the page stays until you move, so it keeps its name.
    if (page) page = linkAt(shown) ?? page;
    else shown = shownSession(agents, tty) ?? shown;
    const width = paneWidth(screenSocket(agents), right);
    const left = size().width + 1;
    const strip = drawStrip(rows, shown, { left, width }, where, release, page);
    const lines = [drawTabs(tabs, `${open.owner}/${open.repo}`, left + width), ...strip];
    if (lines.join("\n") !== lastStrip) {
      lastStrip = lines.join("\n");
      showStrip(screenSocket(agents), session, lines);
    }
    const frame = [...notice, draw(rows, lists, shown, size())].join("\n");
    if (frame === last) return;
    last = frame;
    // Every line fills the pane, so nothing of the last frame is left to clear.
    process.stdout.write(`\x1b[H${frame.replaceAll("\n", "\r\n")}`);
  };
  // Puts what was picked on the right, if anything was. A client can switch between agents, but
  // a page needs the pane to run something else, and so does a client still attaching, which
  // can't switch yet: keys pressed together when leaving a page would be lost. Landing where you
  // are does nothing, so a page isn't asked for again.
  const show = (next: string | null) => {
    if (next === null || next === shown) return;
    const link = linkAt(next);
    if (link) respawnPane(screenSocket(agents), right, pageCommand(next));
    else if (page || shownSession(agents, tty) === null) {
      respawnPane(screenSocket(agents), right, agentClient(agents, next, open.lead));
      tty = paneTty(screenSocket(agents), right);
    } else showSession(agents, tty, next);
    page = link;
    shown = next;
  };
  // Opens another repository: its lists on the left at once, and its lead on the right, which
  // the daemon starts then if it never has. The client on the right tries again each second
  // until the lead's session is there.
  function switchTo(fullName: string) {
    if (fullName === `${open.owner}/${open.repo}`) return;
    open = opening(db, fullName);
    // Not waited on, so the sidebar draws at once.
    openRepository(fullName);
    respawnPane(screenSocket(agents), right, agentClient(agents, open.lead, open.lead));
    tty = paneTty(screenSocket(agents), right);
    page = null;
    shown = open.lead;
  }
  // Returns the GitHub name of the tab before or after the open one, or null at either end.
  const besideOpen = (by: 1 | -1) => {
    const here = tabs.findIndex((tab) => tab.fullName === `${open.owner}/${open.repo}`);
    return tabs[here + by]?.fullName ?? null;
  };
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink at the end of the list. 1000 and 1006 ask for
  // clicks, in the form tmux can give a place of any size.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
  process.stdin.on("data", (bytes) => {
    for (const [, kind, arrow, y, clicked] of bytes.toString().matchAll(input)) {
      const move = kind === "4" ? jumped : stepped;
      const tab = clicked === undefined ? null : (tabs[Number(clicked)]?.fullName ?? null);
      const beside = kind === "3" && arrow === "C" ? besideOpen(1) : null;
      const before = kind === "3" && arrow === "D" ? besideOpen(-1) : null;
      const other = tab ?? beside ?? before;
      if (other) {
        switchTo(other);
        // Keys that came with the switch, such as Alt-Down, move in the new repository's rows.
        refresh();
      } else if (arrow === "C" || arrow === "D") {
        // Past the first or last tab there is nowhere to go.
      } else if (arrow) show(move(rows, lists, shown, size(), arrow === "A" ? -1 : 1));
      else if (y) show(picked(rows, lists, shown, size(), Number(y) - 1 - notice.length));
    }
    refresh();
  });
  process.on("SIGWINCH", refresh);
  refresh();
  setInterval(refresh, 1000);
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
