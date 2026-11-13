// The sidebar: the live left pane of the screen, showing the open repository. Its lead is on top,
// then up to three lists. THREADS has the active threads, with what each is doing.
// ISSUES and PRS show what is open in its tracker and forge, as links. Picking a thread switches
// the client in the right pane, and picking an issue or PR puts its page there. The sidebar also
// keeps the top row up to date, with the header, the tabs and the strip, and switches tabs.
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
import { version } from "../version.ts";
import { draw, noticeLines, type Size } from "./lists.ts";
import { nextList, nextRow, rowAtLine } from "./moves.ts";
import {
  type Link,
  type Lists,
  type Open,
  type Row,
  repositoryTabs,
  sidebarLists,
  sidebarRows,
} from "./rows.ts";
import { agentClient, pageCommand, sidebarWidth } from "./screen.ts";
import { drawTop } from "./strip.ts";

// What the sidebar reads: Alt with an arrow as tmux sends it, 3 without Shift and 4 with it,
// the left button going down, with its place on screen, and a click on a tab, which the
// screen's tmux sends as an OSC with the tab's place in the row.
const esc = "\x1b";
const input = new RegExp(
  `${esc}\\[1;([34])([ABCD])|${esc}\\[<0;\\d+;(\\d+)M|${esc}\\]skel-tab;(\\d+)\x07`,
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
  let lists: Lists = { issues: { links: [], total: 0 }, prs: { links: [], total: 0 } };
  // What is on the right: a session, or a link's url while `page` is that link's row.
  let shown: string | null = null;
  let page: Link | null = null;
  let lastFrame = "";
  let lastStrip = "";
  // The notice's lines, above the lists, which have the height that is left.
  let notice: string[] = [];
  // Returns a thread's round limit, from its repository's skelcrew.yaml or your config. Settings
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
    [...(lists.issues?.links ?? []), ...(lists.prs?.links ?? [])].find(
      (link) => link.url === url,
    ) ?? null;
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
    // A page's row can leave its list at a refresh. The page stays until you move, so the old
    // row is kept for the strip.
    if (page) page = linkAt(shown) ?? page;
    else shown = shownSession(agents, tty) ?? shown;
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
    // Then the sidebar itself, the notice above its lists, also only when it changed.
    const frame = [...notice, draw(rows, lists, shown, size())].join("\n");
    if (frame === lastFrame) return;
    lastFrame = frame;
    // Every line fills the pane, so nothing of the last frame is left to clear.
    process.stdout.write(`\x1b[H${frame.replaceAll("\n", "\r\n")}`);
  };
  // Puts what was picked on the right, if anything was. A client can switch between agents, but
  // a page needs the pane to run something else, and so does a client still attaching, which
  // can't switch yet: keys pressed together when leaving a page would be lost. Landing where you
  // are does nothing, so a page isn't asked for again.
  const show = (next: string | null) => {
    if (next === null || next === shown) return;
    // A link's page runs in the pane in place of what was there. Coming from a page, or onto a
    // client still attaching, a new client starts on the agent. Otherwise the client switches.
    const link = linkAt(next);
    if (link) respawnPane(screenSocket(agents), rightPane, pageCommand(next, where));
    else if (page || shownSession(agents, tty) === null) {
      respawnPane(screenSocket(agents), rightPane, agentClient(agents, next, open.lead));
      tty = paneTty(screenSocket(agents), rightPane);
    } else showSession(agents, tty, next);
    page = link;
    shown = next;
  };
  // Opens another repository: its lists on the left at once, and its lead on the right, which
  // the daemon starts then if it never has. The client on the right tries again each second
  // until the lead's session is there.
  function switchTo(fullName: string) {
    if (fullName === `${open.owner}/${open.repo}`) return;
    open = repositoryAndLead(db, fullName);
    // Not waited on, so the sidebar draws at once. The right pane starts a client on the new
    // lead, and no page shows.
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
  // Without the cursor hidden it would blink at the end of the list. 1000 and 1006 ask for
  // clicks, in the form tmux can give a place of any size.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
  // Acts on each key and click that came together, then redraws. A click on a row picks it by
  // its line, counted from the top of the lists, below the notice.
  process.stdin.on("data", (bytes) => {
    for (const [, kind, arrow, y, clicked] of bytes.toString().matchAll(input)) {
      if (clicked !== undefined || arrow === "C" || arrow === "D") {
        // A click on a tab, or Alt-Right or Alt-Left for the tab after or before, with or
        // without Shift. Ghostty on a Mac turns Alt-Left and Alt-Right into word jumps, so
        // they never arrive, while the Shift ones do. Past either end there is nowhere to go.
        const sideways = kind === "3" || kind === "4" ? tabBeside(arrow === "C" ? 1 : -1) : null;
        const tab = clicked === undefined ? sideways : tabs[Number(clicked)]?.fullName;
        if (!tab) continue;
        switchTo(tab);
        // Keys that came with the switch, such as Alt-Down, move in the new repository's rows.
        refresh();
      } else if (arrow) {
        // Alt-Up or Alt-Down moves a row, and with Shift a list.
        const move = kind === "4" ? nextList : nextRow;
        show(move(rows, lists, shown, size(), arrow === "A" ? -1 : 1));
      } else if (y) show(rowAtLine(rows, lists, shown, size(), Number(y) - 1 - notice.length));
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
