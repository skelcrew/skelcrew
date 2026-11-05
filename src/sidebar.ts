// The sidebar: the left pane of the screen, listing the lead and every thread that isn't done,
// with what each is doing. It only shows and switches. Picking a row switches the client in the
// right pane. It also keeps the strip above that pane up to date.
import type { Database } from "bun:sqlite";
import { openDb } from "./db.ts";
import { screenSocket, sidebarWidth } from "./screen.ts";
import { drawStrip } from "./strip.ts";
import { needsYou, Thread, threadConfig, threadName } from "./thread.ts";
import {
  paneTty,
  paneWidth,
  runningSessions,
  shownSession,
  showSession,
  showStrip,
} from "./tmux.ts";

// One row of the sidebar, with what the strip says of the agent too. The lead has no status of
// its own.
export type Row = {
  name: string;
  session: string;
  status: Thread["status"] | null;
  needsYou: boolean;
  running: boolean;
  word: string;
  harness: string;
  title: string | null;
  pr: number | null;
  checks: Thread["checks"];
  review: { round: number; reviewer: string; verdict: string; line: string } | null;
};
type Size = { width: number; height: number };

// Claude Code is the only harness offered for the lead and builders.
const builderHarness = "claude";
const [bold, blue, green, yellow, grey] = [1, 34, 32, 33, 90];
// Returns text in a colour or style, ending it after the text.
const paint = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;
// Each status has its mark, so nothing is told by colour alone.
const marks: Record<Thread["status"], [string, number]> = {
  working: ["●", blue],
  waiting: ["○", grey],
  stopped: ["–", grey],
  failed: ["×", grey],
  done: ["✓", green],
};
// The keys you need most, at the bottom of the sidebar.
const hints = ["  ⌥↑↓ switch", "  ⌃Q  quit"];

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

// Returns the rows as the database and tmux have them now: the lead, then each thread that
// isn't done, newest first as in skel ps. It runs each second, so it reads only what shows.
export function sidebarRows(db: Database, running: string[], maxRounds: number): Row[] {
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
      title: null,
      pr: null,
      checks: null,
      review: null,
    },
    ...threads.all().map((row) => {
      const thread = Thread.parse(row);
      const { review_round: round, reviewer, verdict, review_line: line } = thread;
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
        title: thread.title,
        pr: thread.pr,
        checks: thread.checks,
        review:
          round !== null && verdict !== null
            ? { round, reviewer: reviewer ?? "", verdict, line: line ?? "" }
            : null,
      };
    }),
  ];
}

// Returns one row as lines: a pointer on the one you are looking at, a mark and the whole name,
// which goes on to more lines when it is too long, then the word and harness. A cut name could
// hide what tells two threads apart. An agent that isn't running is dim, as it can't be picked.
function rowLines(row: Row, here: boolean, width: number): string[] {
  // Returns part of the name as this row shows it.
  const styled = (name: string) => {
    if (here) return paint(bold, name);
    return row.running ? name : paint(grey, name);
  };
  const room = Math.max(width - 4, 1);
  const [first = "", ...rest] = row.name.match(new RegExp(`.{1,${room}}`, "g")) ?? [];
  let mark = paint(grey, "◆");
  if (row.status !== null) {
    const [sign, colour] = row.needsYou ? ["?", yellow] : marks[row.status];
    mark = paint(colour, sign);
  }
  const word = row.word.slice(0, room);
  const harness = row.harness ? ` · ${row.harness}`.slice(0, room - word.length) : "";
  return [
    `${here ? "›" : " "} ${mark} ${styled(first)}`,
    ...rest.map((part) => `    ${styled(part)}`),
    `    ${paint(row.needsYou ? yellow : grey, word)}${harness && paint(grey, harness)}`,
  ];
}

// Returns how many lines of the sidebar the list gets. The hints take the bottom two, until the
// sidebar can't hold them and a whole row: then they give way, as the rows are what you pick
// from and the keys are also in skel's help.
const listHeight = (height: number) =>
  height >= hints.length + 2 ? height - hints.length : height;

// Returns each row's lines, and the first row on screen. A list taller than its space scrolls by
// whole rows, just enough to keep the row you are looking at in view, so Alt-Down never moves
// off the bottom.
function layout(rows: Row[], shown: string | null, size: Size) {
  const blocks = rows.map((row) => rowLines(row, row.session === shown, size.width));
  const here = rows.findIndex((row) => row.session === shown);
  let used = blocks.slice(0, here + 1).flat().length;
  let first = 0;
  while (first < here && used > listHeight(size.height)) {
    used -= blocks[first]?.length ?? 0;
    first++;
  }
  return { blocks, first };
}

// Returns the whole sidebar as lines, given the rows, the session on the right, and the
// sidebar's size. It reads nothing, so what you see can be tested without a terminal.
export function draw(rows: Row[], shown: string | null, size: Size): string {
  const { blocks, first } = layout(rows, shown, size);
  const room = listHeight(size.height);
  const list = blocks.slice(first).flat().slice(0, room);
  if (room === size.height) return list.join("\n");
  const gap = Array<string>(room - list.length).fill("");
  const keys = hints.map((hint) => paint(grey, hint.slice(0, Math.max(size.width, 0))));
  return [...list, ...gap, ...keys].join("\n");
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
// null when there is no row there or its agent isn't running. Any line of a row picks it.
export function picked(rows: Row[], shown: string | null, size: Size, y: number): string | null {
  const { blocks, first } = layout(rows, shown, size);
  if (y >= listHeight(size.height)) return null;
  const lines = blocks.slice(first).flatMap((block, i) => block.map(() => rows[first + i]));
  const row = lines[y];
  return row?.running ? row.session : null;
}

// What the sidebar reads: Alt-Up and Alt-Down as tmux sends them, and the left button going
// down, with its place on screen.
const esc = "\x1b";
const input = new RegExp(`${esc}\\[1;3([AB])|${esc}\\[<0;\\d+;(\\d+)M`, "g");

// Runs the sidebar until its pane goes. The session given is its own, on the screen's server.
// tmux brings it Alt-Up, Alt-Down and clicks on its input. It looks again each second, and
// writes only when something changed: over a slow link each write costs, and on a Sprite a
// terminal that stays quiet lets it sleep.
export async function runSidebar(agents: string, session: string): Promise<void> {
  const db = openDb();
  const tty = paneTty(screenSocket(agents), `=${session}:.1`);
  let rows: Row[] = [];
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
    rows = sidebarRows(db, runningSessions(agents), maxRounds);
    shown = shownSession(agents, tty) ?? shown;
    const width = paneWidth(screenSocket(agents), `=${session}:.1`);
    const strip = drawStrip(rows, shown, { left: size().width + 1, width });
    if (strip.join("\n") !== lastStrip) {
      lastStrip = strip.join("\n");
      showStrip(screenSocket(agents), session, strip);
    }
    const frame = draw(rows, shown, size());
    if (frame === last) return;
    last = frame;
    // Each line clears what is left of the old one, and the end clears what is left below.
    const lines = frame.split("\n").map((text) => `${text}\x1b[K`);
    process.stdout.write(`\x1b[H${lines.join("\r\n")}\x1b[J`);
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
      else show(picked(rows, shown, size(), Number(y) - 1));
    }
    refresh();
  });
  process.on("SIGWINCH", refresh);
  refresh();
  setInterval(refresh, 1000);
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
