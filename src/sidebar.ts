// The sidebar: the left pane of the screen, with three lists. THREADS has the lead and every
// thread that isn't done, with what each is doing. ISSUES and PRS show what is open on GitHub, as
// links. It only shows, switches and links. Picking a thread switches the client in the right
// pane. It also keeps the strip above that pane up to date.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { openDb } from "./db.ts";
import { Name } from "./github.ts";
import { screenSocket, sidebarWidth } from "./screen.ts";
import { clean, drawStrip, fitted } from "./strip.ts";
import { github, needsYou, Thread, threadConfig, threadName } from "./thread.ts";
import {
  paneTty,
  paneWidth,
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
// One row of ISSUES or PRS. It has no agent to pick, so it is a link to GitHub. `word` is the
// word of the thread a PR comes from, and `needing` says whether that thread needs you.
export type Link = {
  name: string;
  title: string;
  url: string;
  word: string;
  needing: boolean;
  dim: boolean;
};
// The rows to show, and how many are open in all, which can be far more.
type List = { links: Link[]; total: number };
export type Lists = { issues: List; prs: List };
type Size = { width: number; height: number };
// One line of the sidebar, with the thread it belongs to, if any, for a click. A line that
// `joins` the sidebar's edge runs into it, as the lines between lists do.
type Line = { text: string; row?: Row; joins?: boolean };

// Claude Code is the only harness offered for the lead and builders.
const builderHarness = "claude";
const [green, yellow, red, grey] = [32, 33, 31, 90];
// Returns text in a colour or style, ending just that, as a background behind it must go on.
const paint = (code: number | string, text: string) => `\x1b[${code}m${text}\x1b[22;39m`;
// Each thread's mark is a circle in its status's colour. Waiting and stopped look alike, and the
// word under the name tells every status apart, so nothing is told by colour alone.
const marks: Record<Thread["status"], [string, number]> = {
  working: ["●", green],
  waiting: ["○", grey],
  stopped: ["○", grey],
  failed: ["●", red],
  done: ["●", green],
};
// The row you are looking at has a grey background, which is also what parts it from the rows
// around it. 256-colour numbers, as they reach your terminal through both tmux servers and
// sprite, and mean the same whatever your theme. So do the colours on the grey: a theme's own
// red or grey can vanish there, and its default text can be dark.
const shade = "48;5;238";
const white = "1;38;5;231";
const onShade: Record<number, string> = {
  [green]: "38;5;120",
  [yellow]: "38;5;221",
  [red]: "38;5;210",
  [grey]: "38;5;250",
};
// The line at the sidebar's edge, a shade quieter than dim text, as it only parts two things.
const edge = "38;5;237";
// The most rows ISSUES and PRS each show. Few, as THREADS is the list you work in.
const most = 5;
// The keys you need most, at the bottom of the sidebar.
const hints = ["   ⌥↑↓ switch", "   ⌃Q  quit"];

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

// Returns ISSUES and PRS as the daemon's last poll saved them: it reads the database and never
// asks GitHub, as it runs each second and only what shows is read. Newest first, across
// repositories, with issues that have a thread last. A thread that is done has left THREADS,
// so its issue counts as waiting again. A PR from a thread takes the word of its row. GitHub
// numbers issues and PRs from one counter, so no issue can be taken for a thread's PR.
export function sidebarLists(db: Database, rows: Row[]): Lists {
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
        needing: thread?.needsYou === true && thread.status !== "failed",
        dim: threaded,
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
  // Returns text in a colour, or the one that stands in for it on the grey.
  const tinted = (code: number, text: string) => paint(here ? (onShade[code] ?? code) : code, text);
  // Returns a line with the grey behind it, out to the end of the row.
  const band = (line: string) => `\x1b[${shade}m${filled(line, width)}\x1b[49m`;
  const room = Math.max(width - 5, 1);
  const [first = "", ...rest] = row.name.match(new RegExp(`.{1,${room}}`, "g")) ?? [];
  // A thread that failed can still have its needs you flag, and its word says failed.
  const needing = row.needsYou && row.status !== "failed";
  let mark = tinted(grey, "◆");
  if (row.status !== null) {
    const [sign, colour] = needing ? ["●", yellow] : marks[row.status];
    mark = tinted(colour, sign);
  }
  const word = row.word.slice(0, room);
  const after = [row.harness, row.age].flatMap((part) => (part ? [` · ${part}`] : [])).join("");
  const more = after.slice(0, room - word.length);
  const lines = [
    `   ${mark} ${styled(first)}`,
    ...rest.map((part) => `     ${styled(part)}`),
    `     ${tinted(needing ? yellow : grey, word)}${more && tinted(grey, more)}`,
  ];
  return here ? lines.map(band) : lines;
}

// Returns a row of ISSUES or PRS as two lines, each a terminal link and cut to the sidebar's
// width: its title, then, dim, its name and a PR's word, in the colours a thread gives that word.
// skel may run on another machine than your browser, so your terminal opens the link. The title
// comes from outside, so it is made safe.
function linkLines(link: Link, width: number): string[] {
  const room = Math.max(width - 5, 0);
  const title = fitted(clean(link.title), room);
  const name = fitted(link.name, room);
  const word = link.word && fitted(link.word, room - Bun.stringWidth(name) - 3);
  const about = word && `${paint(grey, " · ")}${paint(link.needing ? yellow : grey, word)}`;
  return [link.dim ? paint(grey, title) : title, `${paint(grey, name)}${about}`].map(
    (text) => `     \x1b]8;;${link.url}\x1b\\${text}\x1b]8;;\x1b\\`,
  );
}

// Returns a list's lines, or none for an empty one: its heading, up to `few` rows, then a count
// of the rest. Rows come with the dim ones last, so those are the first to be left out.
function listLines(heading: string, list: List, few: number, width: number): Line[] {
  if (list.links.length === 0) return [];
  const links = list.links.slice(0, few);
  const rest = list.total - links.length;
  return [
    { text: paint(grey, `   ${heading}`) },
    ...links.flatMap((link) => linkLines(link, width).map((text) => ({ text }))),
    ...(rest > 0 ? [{ text: paint(grey, `     + ${rest} more`) }] : []),
  ];
}

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

// Returns the lines above the hints, and how many there can be. The hints take the bottom two,
// until the sidebar can't hold them and the whole row you are looking at: then they give way, as
// the rows are what you pick from and the keys are also in skel's help.
// THREADS comes first in a short terminal, as it is the list you move through. ISSUES and PRS
// shrink until every thread fits, down to one row each. Past that THREADS scrolls between them,
// and once that would leave it too little to move in, they go, and THREADS has the whole sidebar.
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
  const divider = { text: paint(edge, "─".repeat(Math.max(width, 0))), joins: true };
  // Returns ISSUES and PRS at a number of rows, with what parts each from THREADS.
  const others = (few: number) => {
    const issues = listLines("ISSUES", lists.issues, few, width);
    const prs = listLines("PRS", lists.prs, few, width);
    return {
      above: issues.length > 0 ? [...issues, divider] : [],
      below: prs.length > 0 ? [divider, ...prs] : [],
    };
  };
  // Returns the lines left for threads beside those, after THREADS' own heading.
  const left = ({ above, below }: ReturnType<typeof others>) =>
    room - above.length - below.length - 1;
  let few = most;
  while (few > 1 && left(others(few)) < blocks.flat().length) few--;
  const sides = others(few);
  const { above, below } = sides;
  if ((above.length === 0 && below.length === 0) || left(sides) < tallest + 2)
    return { lines: scrolled(blocks, here, room), room };
  const heading = { text: paint(grey, "   THREADS") };
  return { lines: [...above, heading, ...scrolled(blocks, here, left(sides)), ...below], room };
}

// Returns the whole sidebar as lines, given the rows, the lists, the session on the right, and
// the sidebar's size. It reads nothing, so what you see can be tested without a terminal. Every
// line fills the pane and ends with the sidebar's edge, in the last column. tmux's own border
// beside it is blank, which leaves a gap before the agent.
export function draw(rows: Row[], lists: Lists, shown: string | null, size: Size): string {
  const { lines, room } = layout(rows, lists, shown, size);
  const gap = Array<Line>(room - lines.length).fill({ text: "" });
  const width = size.width - 1;
  const keys = hints.map((hint) => ({ text: paint(grey, hint.slice(0, Math.max(width, 0))) }));
  const all: Line[] = [...lines, ...gap, ...(room < size.height ? keys : [])];
  return all
    .map(({ text, joins }) => `${filled(text, width)}${paint(edge, joins ? "┤" : "│")}`)
    .join("\n");
}

// Returns the session one row up or down, for Alt-Up and Alt-Down, or null at either end.
// Rows whose agent isn't running are stepped over: nothing could show on the right.
export function stepped(rows: Row[], shown: string | null, by: 1 | -1): string | null {
  const here = rows.findIndex((row) => row.session === shown);
  if (here === -1) return rows[0]?.session ?? null;
  for (let i = here + by; i >= 0 && i < rows.length; i += by)
    if (rows[i]?.running) return rows[i]?.session ?? null;
  return null;
}

// Returns the session of the row at a line of the sidebar, counted from 0, for a click, or
// null when there is no thread there or its agent isn't running. Any line of a row picks it. A
// link picks nothing: your terminal opens it, and the agent on the right stays as it is.
export function picked(
  rows: Row[],
  lists: Lists,
  shown: string | null,
  size: Size,
  y: number,
): string | null {
  const row = layout(rows, lists, shown, size).lines[y]?.row;
  return row?.running ? row.session : null;
}

// What the sidebar reads: Alt-Up and Alt-Down as tmux sends them, and the left button going
// down, with its place on screen.
const esc = "\x1b";
const input = new RegExp(`${esc}\\[1;3([AB])|${esc}\\[<0;\\d+;(\\d+)M`, "g");

// Runs the sidebar until its pane goes. The session given is its own, on the screen's server,
// and `where` says where skel runs, for the header above it.
// tmux brings it Alt-Up, Alt-Down and clicks on its input. It looks again each second, and
// writes only when something changed: over a slow link each write costs, and on a Sprite a
// terminal that stays quiet lets it sleep.
export async function runSidebar(agents: string, session: string, where: string): Promise<void> {
  const db = openDb();
  const tty = paneTty(screenSocket(agents), `=${session}:.1`);
  let rows: Row[] = [];
  let lists: Lists = { issues: { links: [], total: 0 }, prs: { links: [], total: 0 } };
  let shown: string | null = null;
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
  // Looks at the database and tmux again, and redraws what that changed.
  const refresh = () => {
    rows = sidebarRows(db, runningSessions(agents), maxRounds, Date.now());
    lists = sidebarLists(db, rows);
    shown = shownSession(agents, tty) ?? shown;
    const width = paneWidth(screenSocket(agents), `=${session}:.1`);
    const strip = drawStrip(rows, shown, { left: size().width + 1, width }, where);
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
  // Switches the right side to a session, if a row was picked at all.
  const show = (next: string | null) => {
    if (next === null) return;
    showSession(agents, tty, next);
    shown = next;
  };
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink at the end of the list. 1000 and 1006 ask for
  // clicks, in the form tmux can give a place of any size.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
  process.stdin.on("data", (bytes) => {
    for (const [, arrow, y] of bytes.toString().matchAll(input)) {
      if (arrow) show(stepped(rows, shown, arrow === "A" ? -1 : 1));
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
