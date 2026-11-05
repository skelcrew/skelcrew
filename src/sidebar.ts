// The sidebar: the left pane of the screen, listing the lead and every thread that isn't done.
// It only shows and switches. Picking a row switches the client in the right pane.
import type { Database } from "bun:sqlite";
import { openDb } from "./db.ts";
import { screenSocket, sidebarWidth } from "./screen.ts";
import { needsYou, Thread, threadName } from "./thread.ts";
import { paneTty, runningSessions, shownSession, showSession } from "./tmux.ts";

// One line of the sidebar. The lead has no status of its own.
export type Row = {
  name: string;
  session: string;
  status: Thread["status"] | null;
  needsYou: boolean;
  running: boolean;
};
type Size = { width: number; height: number };

// Returns text in a colour or style, ending it after the text.
const paint = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const [bold, blue, green, yellow, grey] = [1, 34, 32, 33, 90];
// Each status has its mark, so nothing is told by colour alone.
const marks: Record<Thread["status"], [string, number]> = {
  working: ["●", blue],
  waiting: ["○", grey],
  stopped: ["–", grey],
  failed: ["×", grey],
  done: ["✓", green],
};

// Returns the rows as the database and tmux have them now: the lead, then each thread that
// isn't done, newest first as in skel ps. It runs each second, so it reads only what shows.
export function sidebarRows(db: Database, running: string[]): Row[] {
  const threads = db.query("SELECT * FROM threads WHERE status != 'done' ORDER BY rowid DESC");
  return [
    {
      name: "lead",
      session: "lead",
      status: null,
      needsYou: false,
      running: running.includes("lead"),
    },
    ...threads.all().map((row) => {
      const thread = Thread.parse(row);
      return {
        name: threadName(db, thread),
        session: thread.folder,
        status: thread.status,
        needsYou: needsYou(thread),
        running: running.includes(thread.folder),
      };
    }),
  ];
}

// Returns the first row on screen. A list taller than the sidebar scrolls just enough to keep
// the row you are looking at in view, so Alt-Down never moves off the bottom.
function firstRow(rows: Row[], shown: string | null, height: number): number {
  return Math.max(0, rows.findIndex((row) => row.session === shown) - height + 1);
}

// Returns a name cut to fit, keeping its end, since the task number is what tells two threads
// of one repository apart.
function fitted(name: string, width: number): string {
  if (name.length <= width) return name;
  const end = name.match(/-\d+$/)?.[0] ?? "";
  if (end.length >= width) return name.slice(-Math.max(width, 1));
  return `${name.slice(0, width - end.length - 1)}…${end}`;
}

// Returns one row as a line: a pointer on the one you are looking at, a mark, the name, and
// the status at the right edge. An agent that isn't running is dim, as it can't be picked.
function line(row: Row, here: boolean, width: number): string {
  const pointer = here ? "›" : " ";
  // Returns the name as this row shows it, once it has been cut to fit.
  const styled = (name: string) => {
    if (here) return paint(bold, name);
    return row.running ? name : paint(grey, name);
  };
  if (row.status === null) return `${pointer} ${styled(row.name)}`;
  const [mark, colour] = row.needsYou ? ["?", yellow] : marks[row.status];
  const status = row.needsYou ? "needs you" : row.status;
  // A terminal narrower than the sidebar squeezes its pane, and the name matters more.
  const start = `${pointer} ${paint(colour, mark)} `;
  if (width - status.length - 7 < 6) return `${start}${styled(fitted(row.name, width - 5))}`;
  // Four columns go to the pointer and mark, one stays clear of the pane's edge, and two
  // keep a cut name from running into the status.
  const name = fitted(row.name, width - status.length - 7);
  const gap = " ".repeat(width - status.length - name.length - 5);
  // Blue is for the mark alone: a list of working threads reads calmer with the word in grey.
  const said = paint(colour === blue ? grey : colour, status);
  return `${start}${styled(name)}${gap}${said}`;
}

// Returns the whole sidebar as lines, given the rows, the session on the right, and the
// sidebar's size. It reads nothing, so what you see can be tested without a terminal.
export function draw(rows: Row[], shown: string | null, size: Size): string {
  const first = firstRow(rows, shown, size.height);
  const visible = rows.slice(first, first + size.height);
  return visible.map((row) => line(row, row.session === shown, size.width)).join("\n");
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
// null when there is no row there or its agent isn't running.
export function picked(rows: Row[], shown: string | null, size: Size, y: number): string | null {
  const row = rows[firstRow(rows, shown, size.height) + y];
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
  // Returns the pane's size now, as the terminal can change it at any time.
  const size = (): Size => ({
    width: process.stdout.columns || sidebarWidth,
    height: process.stdout.rows || 24,
  });
  // Looks at the database and tmux again, and redraws if that changed what shows.
  const refresh = () => {
    rows = sidebarRows(db, runningSessions(agents));
    shown = shownSession(agents, tty) ?? shown;
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
