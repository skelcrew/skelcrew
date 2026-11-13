// The sidebar: the live left pane of the screen, showing the open repository. Its lead is on top,
// then the entries Issues, Threads and PRs, then THREADS, with the active threads and what each
// is doing. Picking a thread switches the client in the right pane, and picking an entry puts its
// list there. The sidebar also keeps the top row up to date, with the header, the tabs and the
// strip, and switches tabs.
import {
  paneTty,
  paneWidth,
  respawnPane,
  runningSessions,
  screenSocket,
  shownSession,
  showSession,
  showStrip,
  tmux,
} from "../agents/tmux.ts";
import { openRepository } from "../client.ts";
import { openDb } from "../db.ts";
import { leadOf } from "../flow/lead.ts";
import { updateNotice } from "../machine/update.ts";
import { leadPlaces } from "../paths.ts";
import { version } from "../version.ts";
import { draw, entryPlace, noticeLines, type Size } from "./layout.ts";
import { type EntryCount, entryCounts, pageRow, roundLimit } from "./lists.ts";
import { nextList, nextRow, rowAtLine } from "./moves.ts";
import { type Open, type Row, repositoryTabs, sidebarRows } from "./rows.ts";
import { agentClient, paneCommand, sidebarWidth } from "./screen.ts";
import { drawTop } from "./strip.ts";

// What the sidebar reads: Alt with an arrow as tmux sends it, 3 without Shift and 4 with it,
// the left button going down, with its place on screen, and what the screen's tmux and the right
// pane type into it as an OSC: a click on a tab, with the tab's place in the row, the page now
// open on the right, or none, and a thread picked in the list of threads.
const esc = "\x1b";
const input = new RegExp(
  `${esc}\\[1;([34])([ABCD])|${esc}\\[<0;\\d+;(\\d+)M|${esc}\\](skel-(?:tab|page|thread));([^\x07]*)\x07`,
  "g",
);

// Returns the repository open in the sidebar, given its owner/name, with its lead's session.
// For a repository Skelcrew no longer has, such as one just removed, the session is named as a
// new lead's would be.
function repositoryAndLead(db: ReturnType<typeof openDb>, fullName: string): Open {
  const [owner = "", repo = ""] = fullName.split("/");
  try {
    return { owner, repo, lead: leadOf(db, owner, repo).name };
  } catch {
    return { owner, repo, lead: leadPlaces(owner, repo).name };
  }
}

// Runs the sidebar until its pane goes. The session given is its own, on the screen's server,
// `where` says which remote Skelcrew runs on, if any, for the header above it, and `repository`
// is the owner/name of the repository it opens on.
// tmux brings it the keys that move and clicks on its input. It looks again each second, and
// writes only when something changed: over a slow link each write costs, and on a Sprite a
// terminal that stays quiet lets it sleep.
export async function runSidebar(
  agents: string,
  session: string,
  where: string,
  repository: string,
): Promise<void> {
  // What the sidebar keeps between redraws: the open repository and its tabs, the right pane and
  // its terminal, and what it last drew.
  const db = openDb();
  let open = repositoryAndLead(db, repository);
  let tabs = repositoryTabs(db);
  const rightPane = `=${session}:.1`;
  let tty = paneTty(screenSocket(agents), rightPane);
  let rows: Row[] = [];
  let entries: EntryCount[] = [];
  // What is on the right: a session, or an entry's place while its list or a page from it shows.
  // `page` is the issue or PR whose page is open there, for the strip.
  let shown: string | null = null;
  let page: { name: string; title: string } | null = null;
  let lastFrame = "";
  let lastStrip = "";
  // The notice's lines, above the rest, which has the height that is left.
  let notice: string[] = [];
  // Returns the size the rest has now, as the terminal can change it at any time.
  const size = (): Size => ({
    width: process.stdout.columns || sidebarWidth,
    height: (process.stdout.rows || 24) - notice.length,
  });
  // Returns whether a place is one of the entries', whose list runs in the right pane.
  const isEntry = (place: string | null) =>
    entries.some((entry) => entryPlace(entry.entry) === place);
  // Looks at the database and tmux again, and redraws what that changed.
  const refresh = () => {
    tabs = repositoryTabs(db);
    // A repository you removed has no tab left, and the sidebar moves to the first one.
    const first = tabs[0];
    if (first && !tabs.some((tab) => tab.fullName === `${open.owner}/${open.repo}`))
      switchTo(first.fullName);
    notice = noticeLines(updateNotice(), size().width);
    rows = sidebarRows(db, runningSessions(agents), roundLimit, Date.now(), open);
    entries = entryCounts(db, open);
    // An agent can end and its client move to the lead by itself, so the session shown is asked
    // of tmux, unless a list shows.
    if (!isEntry(shown)) shown = shownSession(agents, tty) ?? shown;
    // The header, the tabs and the strip go to tmux's status line, and only when they changed.
    const width = paneWidth(screenSocket(agents), rightPane);
    const left = size().width + 1;
    const fullName = `${open.owner}/${open.repo}`;
    const look = { rows, shown, page, tabs, open: fullName, where, version };
    const top = drawTop(look, { left, width });
    if (top !== lastStrip) {
      lastStrip = top;
      showStrip(screenSocket(agents), session, top);
    }
    // Then the sidebar itself, the notice above the rest, also only when it changed.
    const frame = [...notice, draw(rows, entries, shown, size())].join("\n");
    if (frame === lastFrame) return;
    lastFrame = frame;
    // Every line fills the pane, so nothing of the last frame is left to clear.
    process.stdout.write(`\x1b[H${frame.replaceAll("\n", "\r\n")}`);
  };
  // Puts what was picked on the right, if anything was. A client can switch between agents, but
  // a list needs the pane to run something else, and so does a client still attaching, which
  // can't switch yet: keys pressed together when leaving a list would be lost. Landing on the
  // entry whose page shows goes back to its list, on the row you opened. Landing anywhere else
  // you are does nothing, so a list isn't started again.
  const show = (next: string | null) => {
    if (next === null) return;
    if (next === shown) {
      if (page && isEntry(next)) tmux(screenSocket(agents), ["send-keys", "-t", rightPane, "Left"]);
      return;
    }
    // An entry's list runs in the pane in place of what was there. Coming from a list, or onto
    // a client still attaching, a new client starts on the agent. Otherwise the client switches.
    const entry = entries.find((candidate) => entryPlace(candidate.entry) === next);
    const fullName = `${open.owner}/${open.repo}`;
    if (entry)
      respawnPane(
        screenSocket(agents),
        rightPane,
        paneCommand(agents, session, entry.entry, where, fullName),
      );
    else if (isEntry(shown) || shownSession(agents, tty) === null) {
      respawnPane(screenSocket(agents), rightPane, agentClient(agents, next, open.lead));
      tty = paneTty(screenSocket(agents), rightPane);
    } else showSession(agents, tty, next);
    page = null;
    shown = next;
  };
  // Opens another repository: its sidebar on the left at once, and its lead on the right, which
  // the daemon starts then if it never has. The client on the right tries again each second
  // until the lead's session is there.
  function switchTo(fullName: string) {
    if (fullName === `${open.owner}/${open.repo}`) return;
    open = repositoryAndLead(db, fullName);
    // Not waited on, so the sidebar draws at once. The right pane starts a client on the new
    // lead, and no list shows.
    openRepository(fullName);
    respawnPane(screenSocket(agents), rightPane, agentClient(agents, open.lead, open.lead));
    tty = paneTty(screenSocket(agents), rightPane);
    page = null;
    shown = open.lead;
  }
  // Returns the owner/name of the tab before or after the open one, or null at either end.
  const tabBeside = (by: 1 | -1) => {
    const here = tabs.findIndex((tab) => tab.fullName === `${open.owner}/${open.repo}`);
    return tabs[here + by]?.fullName ?? null;
  };
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink at the end of the sidebar. 1000 and 1006 ask for
  // clicks, in the form tmux can give a place of any size.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
  // Acts on each key and click that came together, then redraws. A click on a row picks it by
  // its line, counted from the top, below the notice.
  process.stdin.on("data", (bytes) => {
    for (const [, kind, arrow, y, said, about = ""] of bytes.toString().matchAll(input)) {
      if (said === "skel-page") {
        // The list on the right opened a page, or went back from one.
        page = about ? pageRow(db, open, about) : null;
      } else if (said === "skel-thread") {
        // A thread picked in the list of threads shows as picking it in THREADS does, while its
        // agent runs.
        if (rows.some((row) => row.session === about && row.running)) show(about);
      } else if (said === "skel-tab" || arrow === "C" || arrow === "D") {
        // A click on a tab, or Alt-Right or Alt-Left for the tab after or before, with or
        // without Shift. Ghostty on a Mac turns Alt-Left and Alt-Right into word jumps, so
        // they never arrive, while the Shift ones do. Past either end there is nowhere to go.
        const sideways = kind === "3" || kind === "4" ? tabBeside(arrow === "C" ? 1 : -1) : null;
        const tab = said === "skel-tab" ? tabs[Number(about)]?.fullName : sideways;
        if (!tab) continue;
        switchTo(tab);
        // Keys that came with the switch, such as Alt-Down, move in the new repository's rows.
        refresh();
      } else if (arrow) {
        // Alt-Up or Alt-Down moves a row, and with Shift a part.
        const move = kind === "4" ? nextList : nextRow;
        show(move(rows, entries, shown, size(), arrow === "A" ? -1 : 1));
      } else if (y) show(rowAtLine(rows, entries, shown, size(), Number(y) - 1 - notice.length));
    }
    refresh();
  });
  // Draws now, on each resize and each second, until the pane goes and its input closes.
  process.on("SIGWINCH", refresh);
  refresh();
  setInterval(refresh, 1000);
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
