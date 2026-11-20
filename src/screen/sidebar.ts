// The sidebar: the live left pane of the screen, showing the open repository. Its lead is on top,
// then the entries Issues, Threads and PRs, then ACTIVE, with the active threads and what each
// is doing. Picking a thread switches the client in the right pane, and picking an entry puts its
// list there. The sidebar also keeps the top row up to date, with the header, the tabs and the
// strip, tells the footer what to say under an agent, and switches tabs.
import {
  attachCommand,
  attachThen,
  exitedCleanly,
  listSessions,
  listTmuxSessions,
  shownSession,
  showSession,
} from "../agents/sessions.ts";
import { paneTty, paneWidth, respawnPane, screenTmux, showStrip } from "../agents/tmux.ts";
import { openRepository } from "../client.ts";
import { openDb } from "../db.ts";
import { leadOf } from "../flow/lead.ts";
import { doing, watchForStalls } from "../flow/stall.ts";
import { liveThreads } from "../flow/thread.ts";
import { updateNotice } from "../machine/update.ts";
import { leadPlaces, screenLogFile } from "../paths.ts";
import { quoteForSh } from "../plugins/plugin.ts";
import { attachOnHostLine, pluginHost } from "../plugins/runtime.ts";
import { version } from "../version.ts";
import { agentFooter, tellFooter } from "./footer.ts";
import { draw, entryPlace, noticeLines, type Size } from "./layout.ts";
import { type EntryCount, entryCounts, pageRow, roundLimit } from "./lists.ts";
import { nextList, nextRow, rowAtLine } from "./moves.ts";
import { type Open, type Row, repositoryTabs, sidebarRows } from "./rows.ts";
import { leadOnHost, paneCommand, sidebarWidth } from "./screen.ts";
import { drawTop } from "./strip.ts";

// What the sidebar reads: Alt with an arrow as tmux sends it, 3 without Shift and 4 with it,
// the left button going down, with its line on screen, and what the screen's tmux and the right
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
// writes only when something changed, as over a slow link each write costs.
export async function runSidebar(
  agents: string,
  session: string,
  where: string,
  repository: string,
): Promise<void> {
  // A freeze of the screen leaves nothing behind, as everything the sidebar says is drawn in
  // your terminal. So it logs its own stalls to a file, with the step it was stuck on.
  watchForStalls("The screen's sidebar", screenLogFile());
  // What the sidebar keeps between redraws: the open repository and its tabs, the right pane and
  // its terminal, and what it last drew.
  const db = openDb();
  let open = repositoryAndLead(db, repository);
  // How the right pane reaches the open repository's lead: through its plugin's host, by this
  // line, or through tmux when null. It is read again each second, as a lead the daemon is still
  // starting may land on a plugin's host after the pane began waiting for it.
  let leadAttach = leadOnHost(db, open);
  // Returns a shell line that shows the open repository's lead, and again whenever it ends or you
  // leave it, as tmux's attach to the lead does.
  const leadLine = () =>
    leadAttach === null
      ? attachCommand(agents, open.lead, open.lead).map(quoteForSh).join(" ")
      : `while :; do ${leadAttach}; sleep 1; done`;
  // Returns the command for the right pane that shows `first`, a tmux session, then the lead
  // once it ends or you leave it.
  const paneOn = (first: string): string[] => {
    if (leadAttach === null) return attachCommand(agents, first, open.lead);
    if (first === open.lead) return ["sh", "-c", leadLine()];
    return attachThen(agents, first, leadLine());
  };
  // The agents running on a plugin's host, builders by their thread's folder and the open lead by
  // its name, with the line that attaches to each, as the last look at the hosts found them. The look runs in the background, one at a
  // time, as a host can be slow, and the sidebar never waits on it.
  let hosted = new Map<string, string>();
  let lookingAtHosts = false;
  const lookAtHosts = () => {
    if (lookingAtHosts) return;
    lookingAtHosts = true;
    hostedAgents(db, open)
      .then((found) => {
        hosted = found;
      })
      .catch(() => {})
      .finally(() => {
        lookingAtHosts = false;
      });
  };
  let tabs = repositoryTabs(db, roundLimit);
  const rightPane = `=${session}:.1`;
  let tty = paneTty(agents, rightPane);
  let rows: Row[] = [];
  let entries: EntryCount[] = [];
  // What is on the right: a session, or an entry's place while its list or a page from it shows.
  // `page` is the issue or PR whose page is open there, for the strip.
  let shown: string | null = null;
  let page: { name: string; title: string } | null = null;
  let lastFrame = "";
  let lastStrip = "";
  let lastFooter = "";
  // The notice's lines, above the rest, which has the height that is left.
  let notice: string[] = [];
  // The lead this sidebar last asked the daemon to start, until it runs, so a lead that can't
  // start isn't asked for again each second. Whatever opened the screen asked already.
  let asked: string | null = open.lead;
  // Returns the size the rest has now, as the terminal can change it at any time.
  const size = (): Size => ({
    width: process.stdout.columns || sidebarWidth,
    height: (process.stdout.rows || 24) - notice.length,
  });
  // Returns whether a place is one of the entries', whose list runs in the right pane.
  const isEntry = (place: string | null) =>
    entries.some((entry) => entryPlace(entry.entry) === place);
  // Whether the screen is leaving, as no tab is left.
  let leaving = false;
  // Looks at the database and tmux again, and redraws what that changed.
  const refresh = () => {
    if (leaving) return;
    // tmux first, then the tabs: the daemon closes a tab before it ends the lead's session, so
    // a lead found gone here with its tab still read as open has crashed.
    const found = doing("asking tmux for the agents' sessions", () => listTmuxSessions(agents));
    const running = [...found.flatMap((one) => (one.running ? [one.name] : [])), ...hosted.keys()];
    lookAtHosts();
    const exited = doing("asking tmux whether the lead exited", () =>
      exitedCleanly(agents, open.lead),
    );
    const before = tabs;
    tabs = doing("reading the tabs", () => repositoryTabs(db, roundLimit));
    // A repository you removed, or whose lead you exited, has no tab left. The sidebar moves to
    // the tab that took its place, or the one before when it was last. With no tab left, the
    // screen leaves as Alt-Q does.
    const here = before.findIndex((tab) => tab.fullName === `${open.owner}/${open.repo}`);
    if (!tabs.some((tab) => tab.fullName === `${open.owner}/${open.repo}`)) {
      const next = tabs[Math.min(Math.max(here, 0), tabs.length - 1)];
      if (!next) {
        // The session is ended, not detached. Detaching it from here made tmux 3.6 crash
        // about one time in six on a busy machine, as destroy-unattached ended the session,
        // and your terminal showed "server exited unexpectedly" in place of the usual line.
        // The server ends it itself a moment after this command is gone, so no one-off
        // command disconnects as it goes, and the sidebar asks tmux nothing more.
        leaving = true;
        screenTmux(agents, ["run-shell", "-d", "0.5", "-C", `kill-session -t =${session}`]);
        return;
      }
      switchTo(next.fullName);
    }
    // A lead that moved to or from a plugin's host is shown through its host now.
    const lead = doing("reading the lead's host", () => leadOnHost(db, open));
    if (lead !== leadAttach) {
      leadAttach = lead;
      if (shown === open.lead) {
        respawnPane(agents, rightPane, paneOn(open.lead));
        tty = paneTty(agents, rightPane);
      }
    }
    notice = noticeLines(updateNotice(db), size().width);
    rows = doing("reading the rows", () => sidebarRows(db, running, roundLimit, Date.now(), open));
    entries = doing("counting the lists", () => entryCounts(db, open));
    // An agent can end and its client move to the lead by itself, so the session shown is asked
    // of tmux, unless a list shows. With no client on the right while the lead isn't running,
    // the right side is waiting for the lead, such as after a builder ended while its lead was
    // gone, so the lead is what it shows.
    if (!isEntry(shown)) {
      const client = doing("asking tmux which agent shows", () => shownSession(agents, tty));
      if (client) shown = client;
      else if (!running.includes(open.lead)) shown = open.lead;
    }
    // A lead that crashed while you look at it is brought back with its conversation, once,
    // as the daemon does at its start. One you exited closes its tab instead.
    if (running.includes(open.lead)) asked = null;
    else if (shown === open.lead && asked !== open.lead && !exited) {
      asked = open.lead;
      openRepository(`${open.owner}/${open.repo}`, true);
    }
    // The header, the tabs and the strip go to tmux's status line, and only when they changed.
    const width = doing("asking tmux the agent's width", () => paneWidth(agents, rightPane));
    const left = size().width + 1;
    const fullName = `${open.owner}/${open.repo}`;
    const look = { rows, shown, page, tabs, open: fullName, where, version };
    const top = drawTop(look, { left, width });
    if (top !== lastStrip) {
      lastStrip = top;
      doing("drawing the strip", () => showStrip(agents, session, top));
    }
    // The footer under an agent, also only when it changed. Moving onto an agent hides the list
    // of keys, as every key but the Alt ones is the agent's there. A list or page tells the
    // footer what to say itself, as only it knows whether its row can be started or merged, so
    // the sidebar forgets what it said and says it again on coming back to an agent.
    if (isEntry(shown)) lastFooter = "";
    else {
      const agent = rows.find((row) => row.session === shown);
      const footer = agentFooter(agent?.agentHarness ?? "");
      if (footer !== lastFooter) {
        lastFooter = footer;
        doing("drawing the footer", () => {
          tellFooter(agents, session, "keys", "hide");
          tellFooter(agents, session, "footer", footer);
        });
      }
    }
    // Then the sidebar itself, the notice above the rest, also only when it changed.
    const frame = [...notice, draw(rows, entries, shown, size())].join("\n");
    if (frame === lastFrame) return;
    lastFrame = frame;
    // Every line fills the pane, so nothing of the last frame is left to clear.
    doing("drawing the sidebar", () =>
      process.stdout.write(`\x1b[H${frame.replaceAll("\n", "\r\n")}`),
    );
  };
  // Puts what was picked on the right, if anything was. A client can switch between agents, but
  // a list needs the pane to run something else, and so does a client still attaching, which
  // can't switch yet: keys pressed together when leaving a list would be lost. Landing on the
  // entry whose page shows goes back to its list, on the row you opened. Landing anywhere else
  // you are does nothing, so a list isn't started again.
  const show = (next: string | null) => {
    if (next === null) return;
    if (next === shown) {
      if (page && isEntry(next)) screenTmux(agents, ["send-keys", "-t", rightPane, "Left"]);
      return;
    }
    // An entry's list runs in the pane in place of what was there. Coming from a list, or onto
    // a client still attaching, a new client starts on the agent. Otherwise the client switches.
    // A builder on a plugin's host runs that host's attach in the pane, and the lead comes back
    // once you leave it, as after a tmux session. So does a lead on a plugin's host, which no
    // tmux client can switch to.
    const entry = entries.find((candidate) => entryPlace(candidate.entry) === next);
    const fullName = `${open.owner}/${open.repo}`;
    const onHost = hosted.get(next);
    if (entry)
      respawnPane(agents, rightPane, paneCommand(agents, session, entry.entry, where, fullName));
    else if (onHost !== undefined) {
      respawnPane(agents, rightPane, ["sh", "-c", `${onHost}; ${leadLine()}`]);
      tty = paneTty(agents, rightPane);
    } else if (
      isEntry(shown) ||
      shownSession(agents, tty) === null ||
      (next === open.lead && leadAttach !== null)
    ) {
      respawnPane(agents, rightPane, paneOn(next));
      tty = paneTty(agents, rightPane);
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
    leadAttach = leadOnHost(db, open);
    // Not waited on, so the sidebar draws at once. The right pane starts on the new lead, through
    // its own host, and no list shows.
    openRepository(fullName, true);
    asked = open.lead;
    respawnPane(agents, rightPane, paneOn(open.lead));
    tty = paneTty(agents, rightPane);
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
        // A thread picked in the list of threads shows as picking it in ACTIVE does, while its
        // agent runs.
        if (rows.some((row) => row.session === about && row.running)) show(about);
      } else if (said === "skel-tab" || arrow === "C" || arrow === "D") {
        // A click on a tab, or Alt-Shift-Right or Alt-Shift-Left for the tab after or before.
        // tmux sends no other arrow sideways. Past either end there is nowhere to go.
        const tab =
          said === "skel-tab" ? tabs[Number(about)]?.fullName : tabBeside(arrow === "C" ? 1 : -1);
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

// Returns the agents running on a plugin's host, each with the line that attaches to it, for the
// sidebar: builders by their thread's folder, and the open repository's lead by its name, so a
// lead there that ends is noticed and brought back, as one on tmux is. Each host is asked once
// for all its agents. A host that fails shows none of them as running.
async function hostedAgents(
  db: ReturnType<typeof openDb>,
  open: Open,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  // Each agent on a plugin's host: what the sidebar knows it by, its host and its ID there.
  const agents = liveThreads(db).flatMap((thread) =>
    thread.host !== null && thread.host !== "tmux" && thread.host_id !== null
      ? [{ key: thread.folder, host: thread.host, id: thread.host_id }]
      : [],
  );
  try {
    const lead = leadOf(db, open.owner, open.repo);
    if (lead.host !== "tmux" && lead.hostId !== null)
      agents.push({ key: open.lead, host: lead.host, id: lead.hostId });
  } catch {}
  for (const name of new Set(agents.map((agent) => agent.host))) {
    const host = pluginHost(db, name);
    if (host === null) continue;
    const listed = await listSessions(host).catch(() => []);
    for (const agent of agents)
      if (agent.host === name && listed.some((one) => one.name === agent.id && one.running))
        found.set(agent.key, attachOnHostLine(host, agent.id));
  }
  return found;
}
