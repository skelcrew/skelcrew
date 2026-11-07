// The sidebar: the left pane of the screen, with three lists. THREADS has the lead and every
// thread that isn't done, with what each is doing. ISSUES and PRS show what is open on GitHub, as
// links. It only shows, switches, links and opens pages. Picking a thread switches the client in
// the right pane, and picking an issue or PR puts its page there. It also keeps the strip above
// that pane up to date.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { openDb } from "./db.ts";
import { Name } from "./github.ts";
import { agentClient, pageCommand, screenSocket, sidebarWidth } from "./screen.ts";
import { clean, drawStrip, fitted } from "./strip.ts";
import { github, needsYou, Thread, threadConfig, threadName } from "./thread.ts";
import {
  paneTty,
  paneWidth,
  respawnPane,
  runningSessions,
  shownSession,
  showSession,
  showStrip,
} from "./tmux.ts";

// One row of the sidebar, with what the strip says of the agent too. The lead has no status of
// its own, and a row's age is empty unless it shows a running time.
export type Row = {
  name: string;
  session: string;
  status: Thread["status"] | null;
  needsYou: boolean;
  running: boolean;
  word: string;
  harness: string;
  age: string;
  github: string | null;
  title: string | null;
  pr: number | null;
  checks: Thread["checks"];
  review: { round: number; reviewer: string; verdict: string } | null;
};
// A sign, and the colour it is drawn in.
type Mark = [string, number];
// One row of ISSUES or PRS: a link to GitHub, and a page you can land on. `word` is the word of
// the thread a PR comes from, and `needing` says whether that thread needs you. A PR has
// a mark, and an issue has none, so it starts where the headings do.
export type Link = {
  name: string;
  title: string;
  url: string;
  word: string;
  needing: boolean;
  dim: boolean;
  mark: Mark | null;
};
// The rows to show, and how many are open in all, which can be far more.
type List = { links: Link[]; total: number };
export type Lists = { issues: List; prs: List };
type Size = { width: number; height: number };
// One line of the sidebar, with the row it belongs to, if any, for a click. A line that `joins`
// the sidebar's edge runs into it, as the lines between lists do.
type Line = { text: string; row?: Row; link?: Link; joins?: boolean };
// A row you can move to, by what names it: a thread's session or a link's url. `open` says
// whether anything could show on the right.
type Stop = { place: string; open: boolean };

// Claude Code is the only harness offered for the lead and builders.
const builderHarness = "claude";
const [green, yellow, red] = [32, 33, 31];
export const grey = 90;
// Returns text in a colour or style, ending just that, as a background behind it must go on.
export const paint = (code: number | string, text: string) => `\x1b[${code}m${text}\x1b[22;39m`;
// Each thread's mark is a circle in its status's colour. Waiting and stopped look alike, and the
// word under the name tells every status apart, so nothing is told by colour alone.
const marks: Record<Thread["status"], Mark> = {
  working: ["●", green],
  waiting: ["○", grey],
  stopped: ["○", grey],
  failed: ["●", red],
  done: ["●", green],
};
// A PR with no thread has nothing to say, so it looks like a thread that is waiting.
const noThread: Mark = ["○", grey];
// The row you are looking at has a grey background, which is also what parts it from the rows
// around it. 256-colour numbers, as they reach your terminal through both tmux servers and
// sprite, and mean the same whatever your theme. So do the colours on the grey: a theme's own
// red or grey can vanish there, and its default text can be dark.
const shade = "48;5;238";
export const white = "1;38;5;231";
const onShade: Record<number, string> = {
  [green]: "38;5;120",
  [yellow]: "38;5;221",
  [red]: "38;5;210",
  [grey]: "38;5;250",
};
// The line at the sidebar's edge, a shade quieter than dim text, as it only parts two things.
const edge = "38;5;237";
// The padding on each side, in columns, which also starts every heading and mark. A terminal
// cell is about twice as tall as wide, so two columns look like the one blank row at the top.
export const pad = "  ";
// Where a name starts, past its mark.
const indent = `${pad}  `;
// The keys you need most, at the bottom of the sidebar.
const hints = [`${pad}⌥↑↓ move`, `${pad}⌥⇧↑↓ list`, `${pad}⌃Q quit`];

// Says whether a thread shows as needing you. A thread that failed can still have its needs you
// flag, and its word says failed.
const needing = (row: Row) => row.needsYou && row.status !== "failed";

// Returns the mark of a row of THREADS, which a PR from that thread shows too.
function threadMark(row: Row): Mark {
  if (row.status === null) return ["◆", grey];
  return needing(row) ? ["●", yellow] : marks[row.status];
}

// Returns the word for what the thread is doing, given the rounds of changes it may have. Its
// status and needs you stay as they are: the word only describes them, from what they and the
// latest review say. Past the limit a thread goes on needing you while its builder submits, so
// that comes before a round under way. A round that failed keeps its submit or review saved.
// A thread can need you for what the table of words has no word for, such as a builder that
// couldn't be told about an event, and that says just so rather than something untrue.
export function threadWord(thread: Thread, maxRounds: number): string {
  const { status, verdict, checks } = thread;
  if (status === "failed" || status === "stopped" || status === "done") return status;
  const underWay = thread.submitting !== null || thread.reviewing !== null;
  if (thread.asking) return "question";
  if (thread.needs_you) {
    if (thread.rounds > maxRounds) return "round limit";
    if (underWay || verdict === "failed") return "review failed";
    if (verdict === "approve" && (checks === "passing" || checks === null)) return "approved";
    return "needs you";
  }
  if (underWay) return "reviewing";
  if (thread.telling !== null) return "changes";
  return status === "working" ? "working" : "checks";
}

// Returns how long ago a thread started, in the fewest letters: <1m, then 5m, 2h, 3d. Rounded
// down, so the text changes at most once a minute.
export function threadAge(started: number, now: number): string {
  const minutes = Math.floor((now - started) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

// Returns the rows as the database and tmux have them now: the lead, then each thread that
// isn't done, newest first as in skel ps. It runs each second, so it reads only what shows.
// Only a thread whose word is working shows its running time. A time on any other row would
// write to the terminal each minute, and on a Sprite a terminal that stays quiet lets it sleep.
// Such a thread keeps the Sprite awake anyway, so its time costs nothing.
export function sidebarRows(
  db: Database,
  running: string[],
  maxRounds: number,
  now: number,
): Row[] {
  const threads = db.query("SELECT * FROM threads WHERE status != 'done' ORDER BY rowid DESC");
  const leadRuns = running.includes("lead");
  return [
    {
      name: "lead",
      session: "lead",
      status: null,
      needsYou: false,
      running: leadRuns,
      word: leadRuns ? "running" : "stopped",
      harness: builderHarness,
      age: "",
      github: null,
      title: null,
      pr: null,
      checks: null,
      review: null,
    },
    ...threads.all().map((row) => {
      const thread = Thread.parse(row);
      const { review_round: round, reviewer, reviewed_by: by, verdict } = thread;
      const word = threadWord(thread, maxRounds);
      return {
        name: threadName(db, thread),
        session: thread.folder,
        status: thread.status,
        needsYou: needsYou(thread),
        running: running.includes(thread.folder),
        word,
        // Only a review is on another harness. An older skel's review has none saved.
        harness: word === "reviewing" ? (reviewer ?? "") : builderHarness,
        age: word === "working" && thread.started !== null ? threadAge(thread.started, now) : "",
        github: github(thread),
        title: thread.title,
        pr: thread.pr,
        checks: thread.checks,
        review: round !== null && verdict !== null ? { round, reviewer: by ?? "", verdict } : null,
      };
    }),
  ];
}

const OpenRow = z.object({
  owner: Name,
  repo: Name,
  name: z.string(),
  number: z.number(),
  title: z.string(),
  threaded: z.coerce.boolean(),
});

// Returns ISSUES and PRS as the daemon's last poll saved them, up to `most` rows of each: it
// reads the database and never asks GitHub, as it runs each second. Newest first, across
// repositories, with issues that have a thread last. A thread that is done has left THREADS,
// so its issue counts as waiting again. A PR from a thread takes the word and mark of its row.
// GitHub numbers issues and PRs from one counter, so no issue can be taken for a thread's PR.
export function sidebarLists(db: Database, rows: Row[], most: number): Lists {
  // Returns one list, of the kind saved in the database, with the path GitHub shows it at.
  const read = (kind: string, path: string, column: string): List => {
    const found = db.query(`SELECT i.owner, i.repo, r.name, i.number, i.title,
        EXISTS (SELECT 1 FROM threads t WHERE i.kind = 'issue' AND t.owner = i.owner
          AND t.repo = i.repo AND t.task = i.number AND t.status != 'done') AS threaded
      FROM open_items i JOIN repositories r ON r.owner = i.owner AND r.repo = i.repo
      WHERE i.kind = ? ORDER BY threaded, i.created DESC, i.number DESC LIMIT ?`);
    const links = found.all(kind, most).map((saved) => {
      const { owner, repo, name, number, title, threaded } = OpenRow.parse(saved);
      const thread = rows.find((row) => row.github === `${owner}/${repo}` && row.pr === number);
      return {
        name: kind === "pr" ? `${name}#${number}` : `${name}-${number}`,
        title,
        url: `https://github.com/${owner}/${repo}/${path}/${number}`,
        word: thread?.word ?? "",
        needing: thread !== undefined && needing(thread),
        dim: threaded,
        mark: kind === "issue" ? null : thread ? threadMark(thread) : noThread,
      };
    });
    const sum = db.query(`SELECT COALESCE(SUM(${column}), 0) AS total FROM repositories`).get();
    return { links, total: z.object({ total: z.number() }).parse(sum).total };
  };
  return { issues: read("issue", "issues", "open_issues"), prs: read("pr", "pull", "open_prs") };
}

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
// rows as fit, then a count of the rest. Rows come with the dim ones last, so those are the first to be left out.
// A third with room for just one row keeps the row, and the count gives way. An empty list says
// so, as its third stays either way.
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
const held = (lines: Line[], height: number) => [
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

// Returns the lines above the hints, and how many there can be. The hints take the bottom three,
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
    ...held(listLines("Issues", lists.issues, shown, third, width), third),
    divider,
    ...top,
    ...held(scrolled(blocks, here, middle - top.length), middle - top.length),
    divider,
    ...listLines("PRs", lists.prs, shown, third, width),
  ];
  return { lines, room };
}

// Returns the whole sidebar as lines, given the rows, the lists, what is on the right, as a
// session or a link's url, and the sidebar's size. It reads nothing, so what you see can be tested without a terminal. Every
// line fills the pane and ends with the sidebar's edge, in the last column. tmux's own border
// beside it is blank, which leaves a gap before the agent.
export function draw(rows: Row[], lists: Lists, shown: string | null, size: Size): string {
  const { lines, room } = layout(rows, lists, shown, size);
  const width = size.width - 1;
  const keys = hints.map((hint) => ({
    text: paint(grey, hint.slice(0, Math.max(width - pad.length, 0))),
  }));
  const all: Line[] = [...held(lines, room), ...(room < size.height ? keys : [])];
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

// What the sidebar reads: Alt-Up and Alt-Down as tmux sends them, 3 without Shift and 4 with it,
// and the left button going down, with its place on screen.
const esc = "\x1b";
const input = new RegExp(`${esc}\\[1;([34])([AB])|${esc}\\[<0;\\d+;(\\d+)M`, "g");

// Runs the sidebar until its pane goes. The session given is its own, on the screen's server,
// and `where` says which remote skel runs on, if any, for the header above it.
// tmux brings it the keys that move and clicks on its input. It looks again each second, and
// writes only when something changed: over a slow link each write costs, and on a Sprite a
// terminal that stays quiet lets it sleep.
export async function runSidebar(agents: string, session: string, where: string): Promise<void> {
  const db = openDb();
  const right = `=${session}:.1`;
  let tty = paneTty(screenSocket(agents), right);
  let rows: Row[] = [];
  let lists: Lists = { issues: { links: [], total: 0 }, prs: { links: [], total: 0 } };
  // What is on the right: a session, or a link's url while `page` is that link's row.
  let shown: string | null = null;
  let page: Link | null = null;
  let last = "";
  let lastStrip = "";
  // A config that isn't valid already stops rounds, with the reason, and mustn't also take the
  // sidebar away. No thread then reads as past the limit.
  let maxRounds = Number.POSITIVE_INFINITY;
  try {
    maxRounds = threadConfig().maxRounds;
  } catch {}
  // Returns the pane's size now, as the terminal can change it at any time.
  const size = (): Size => ({
    width: process.stdout.columns || sidebarWidth,
    height: process.stdout.rows || 24,
  });
  // Returns the row of ISSUES or PRS with a link's url, if any.
  const linkAt = (url: string | null) =>
    [...lists.issues.links, ...lists.prs.links].find((link) => link.url === url) ?? null;
  // Looks at the database and tmux again, and redraws what that changed.
  const refresh = () => {
    rows = sidebarRows(db, runningSessions(agents), maxRounds, Date.now());
    // A row takes two lines, so the sidebar's height is more than any list can show.
    lists = sidebarLists(db, rows, size().height);
    // A page's row can go at a poll, and the page stays until you move, so it keeps its name.
    if (page) page = linkAt(shown) ?? page;
    else shown = shownSession(agents, tty) ?? shown;
    const width = paneWidth(screenSocket(agents), right);
    const strip = drawStrip(rows, shown, { left: size().width + 1, width }, where, page);
    if (strip.join("\n") !== lastStrip) {
      lastStrip = strip.join("\n");
      showStrip(screenSocket(agents), session, strip);
    }
    const frame = draw(rows, lists, shown, size());
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
      respawnPane(screenSocket(agents), right, agentClient(agents, next));
      tty = paneTty(screenSocket(agents), right);
    } else showSession(agents, tty, next);
    page = link;
    shown = next;
  };
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink at the end of the list. 1000 and 1006 ask for
  // clicks, in the form tmux can give a place of any size.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
  process.stdin.on("data", (bytes) => {
    for (const [, kind, arrow, y] of bytes.toString().matchAll(input)) {
      const move = kind === "4" ? jumped : stepped;
      if (arrow) show(move(rows, lists, shown, size(), arrow === "A" ? -1 : 1));
      else show(picked(rows, lists, shown, size(), Number(y) - 1));
    }
    refresh();
  });
  process.on("SIGWINCH", refresh);
  refresh();
  setInterval(refresh, 1000);
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
