// The sidebar: the live left pane of the screen, which is the list of the open repository. Its
// lead is on top, then Needs you and the six stages, as sc --list shows them. The right side
// follows the row you are on: the lead's session on the lead's row, a task's details on a task's.
// The sidebar also keeps the top row up to date, with the header and the tabs, tells the footer
// what to say, and switches tabs.
import {
  attachCommand,
  attachThen,
  exitedCleanly,
  listSessions,
  listTmuxSessions,
  shownSession,
  showSession,
} from "../agents/sessions.ts";
import { paneTty, paneWidth, respawnPane, screenTmux, showTop } from "../agents/tmux.ts";
import { moveQueued, openRepository, startOrMerge } from "../client.ts";
import { openDb } from "../db.ts";
import { leadOf } from "../flow/lead.ts";
import { ListStage } from "../flow/stage.ts";
import { doing, watchForStalls } from "../flow/stall.ts";
import { cloneOf, liveThreads } from "../flow/thread.ts";
import { type Asking, answerOf, canOpenLinks, openPr, stillOffered } from "../list/actions.ts";
import { drawRows, enterAttaches, listShare, type Target } from "../list/layout.ts";
import {
  buildersNote,
  listRows,
  type Question,
  type Row,
  repositoryTabs,
  type Section,
  sectionHeadings,
  shownRows,
} from "../list/rows.ts";
import { updateNotice } from "../machine/update.ts";
import { leadPlaces, screenLogFile } from "../paths.ts";
import { quoteForSh } from "../plugins/plugin.ts";
import { pluginHost } from "../plugins/runtime.ts";
import { errorText } from "../say.ts";
import { shownVersions } from "../version.ts";
import { dropAnswerOption, dropAsk, unfinished } from "./drops.ts";
import { agentFooter, tellFooter } from "./footer.ts";
import { filled, lightGrey, pad, paint, removeControlCodes } from "./look.ts";
import { attachedMark, leadOnHost } from "./screen.ts";
import { attachTask, showTask } from "./task.ts";
import { drawTop } from "./top.ts";

// The repository open in the sidebar, by its owner and name, and its lead's session.
type Open = { owner: string; repo: string; lead: string };

// Splits what reaches the sidebar into keys: a message the screen's tmux types in as an OSC, such
// as a click on a tab, a CSI sequence, such as an arrow or a click, an SS3 one, Alt with a key,
// then any single character.
const esc = "\x1b";
const keyPattern = new RegExp(
  [
    `${esc}\\][^\x07]*\x07`,
    `${esc}\\[[0-?]*[ -/]*[@-~]`,
    `${esc}O[\\s\\S]`,
    `${esc}[^${esc}]`,
    "[\\s\\S]",
  ].join("|"),
  "g",
);
// The keys the screen's tmux sends the sidebar from anywhere: Alt with an arrow or a digit, a
// click, and a message such as a click on a tab. Any other key was typed into the sidebar.
const altPattern = new RegExp(`^${esc}(\\[1;3[AB]|\\[1;4[A-D]|[1-6]|\\[<|\\])`);
// A press of the mouse, with its button, column and line, counted from 1. A release ends in m,
// and does nothing.
const clickPattern = new RegExp(`^${esc}\\[<(\\d+);(\\d+);(\\d+)M$`);
// The keys the sidebar acts on, by what they do. The Alt ones come from the screen's tmux, from
// anywhere. The plain ones come only while your typing goes to the sidebar. Alt with a digit and
// the digit alone open or close a stage. The screen's tmux sends Ctrl-\'s byte from anywhere,
// to bring your typing here, and Shift-Enter as CSI-u, only while your typing is here already.
// `a` does what Shift-Enter does, for a terminal that sends Shift-Enter as plain Enter.
const keyNames: Record<string, string> = {
  "\x1c": "to sidebar",
  "\x1b[13;2u": "full screen",
  a: "full screen",
  "\x1b[1;3A": "up",
  "\x1b[1;3B": "down",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1b[1;2A": "earlier",
  "\x1b[1;2B": "later",
  "\x1b[1;4A": "previous section",
  "\x1b[1;4B": "next section",
  "\x1b[1;4C": "next repository",
  "\x1b[1;4D": "previous repository",
  "\t": "next repository",
  "\x1b[Z": "previous repository",
  "\r": "enter",
  "\n": "enter",
  "\x1b[5~": "page up",
  "\x1b[6~": "page down",
};

// The keys the footer shows while your typing goes to the sidebar, where the list's keys work
// without Alt. Enter says what it does on the row: to the lead on the lead's row, open/close on a
// stage's heading, none on the heading of Needs you or Up next, which never close, attach where it
// attaches to the builder, and open elsewhere. Where it attaches, or on the lead's row, Shift-Enter
// or `a` attach full screen. Page Up and Page Down scroll the details, Shift with an arrow moves a queued task in Up next, and s or m show
// only where the row can be started, or queued, or merged. A request of the lead's offers y and
// n, which answer it, in place of Enter.
function sidebarFooter(row: Row): string {
  if (row.part === "lead") return "↑↓ move  ⏎ to lead  ⇧⏎/a full screen  1-6 stages  ⌥Q quit";
  if (row.part === "request") return "↑↓ move  y yes  n no  1-6 stages  ⌥Q quit";
  if (row.part === "heading") {
    const fixed = row.section === "needs you" || row.section === "up next";
    return `↑↓ move${fixed ? "" : "  ⏎ open/close"}  1-6 stages  ⌥Q quit`;
  }
  const scroll = row.task ? " · pgup/pgdn scroll" : "";
  const reorder = row.section === "up next" && row.place !== null ? "  ⇧↑↓ reorder" : "";
  const start = row.start ? (row.start.queues ? "  s queue" : "  s start") : "";
  const merge = row.merge && "ask" in row.merge ? "  m merge" : "";
  const enter = enterAttaches(row) ? "⏎ attach  ⇧⏎/a full screen" : "⏎ open";
  return `↑↓ move  ${enter}${scroll}  1-6 stages${reorder}${start}${merge}  ⌥Q quit`;
}

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

// What the right side shows of a task: its details, by the task's name, such as APP-12. Anything
// else the right side shows is an agent's session, by its name.
const detailsOf = (name: string) => `details:${name}`;
const isDetails = (shown: string | null) => shown?.startsWith("details:") ?? false;
// What the right side shows while it says why Enter couldn't attach to a builder.
const refused = "refused";

// Runs the sidebar until its pane goes. The session given is its own, on the screen's server,
// `where` says which remote Skelcrew runs on, if any, for the header above it, `repository` is
// the owner/name of the repository it opens on, and `onHost` the line the right pane attaches to
// its lead's host with, empty for tmux.
// tmux brings it the Alt keys and clicks, and your typing while a task's details show. It looks
// again each second, and writes only when something changed, as over a slow link each write costs.
export async function runSidebar(
  agents: string,
  session: string,
  where: string,
  repository: string,
  onHost: string,
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
  // starting may land on a plugin's host, or move on it, after the pane began waiting for it.
  // paneLead is the line the right pane runs, as leadAttach was when the pane last started on the
  // lead, starting as the screen started it.
  let leadAttach = onHost === "" ? null : onHost;
  let paneLead = leadAttach;
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
  // its name, as the last look at the hosts found them. The look runs in the background, one at
  // a time, as a host can be slow, and the sidebar never waits on it.
  let hosted = new Set<string>();
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
  let tabs = repositoryTabs(db, null);
  const rightPane = `=${session}:.1`;
  let tty = paneTty(agents, rightPane);
  // The list's rows: every row, those that show, which are the lead's and those of the open
  // sections, the row you are on among those and how far the sections scrolled. Needs you and
  // Up next are always open. Of the stages, Building, Reviewing and Checks start open, as that is
  // where the work under way is. The sections you open or close stay so, whichever repository
  // you move to, and so does a whole Backlog once you asked for it.
  let all: Row[] = [];
  let rows: Row[] = [];
  const opened = new Set<Section>(["needs you", "up next", "building", "reviewing", "checks"]);
  // What Up next's heading says of the builders, read with the rows.
  let builders = "";
  let wholeBacklog = false;
  let here = 0;
  let top = 0;
  let targets: Target[] = [];
  // The agents whose sessions run, on tmux or a plugin's host, as the last refresh found them.
  let running: string[] = [];
  // What is on the right: an agent's session, or a task's details, by detailsOf.
  let shown: string | null = null;
  // Whether you keep your typing in the sidebar yourself, by Ctrl-\ or by any plain key there.
  // Moving then leaves it there, even onto the lead's row, so a digit or an arrow never lands in
  // an agent. Enter on the lead's row or a click on the lead gives it back. With Alt keys alone,
  // typing follows the row: the lead's row types to the lead.
  let held = false;
  // Where your typing went at the last look, which the sidebar draws and the footer says.
  let typingRight = true;
  // What the footer says in place of its keys until the next key, the question it asks, and
  // whether the daemon is at work on an answer.
  let said: string | null = null;
  let asking: Asking | null = null;
  let working = false;
  let lastFrame = "";
  let lastTop = "";
  let lastFooter = "";
  // The notice's lines, above the rest, which has the height that is left.
  let notice: string[] = [];
  // The lead this sidebar last asked the daemon to start, until it runs, so a lead that can't
  // start isn't asked for again each second. Whatever opened the screen asked already.
  let asked: string | null = open.lead;
  // Whether the screen is leaving, as no tab is left.
  let leaving = false;
  const canOpen = canOpenLinks(where);
  // Returns the size the rest has now, as the terminal can change it at any time.
  const size = () => ({
    width: process.stdout.columns || listShare.most,
    height: (process.stdout.rows || 24) - notice.length,
  });

  // Puts `next` on the right: an agent's session, or a task's details, which leave your typing
  // with the sidebar. A client can switch between agents, but coming from details the pane must
  // run something else, and so must a client still attaching, which can't switch yet. A lead on a
  // plugin's host runs that host's attach in the pane, as no tmux client can switch to it, where
  // the database says it runs now: the host's last list can lag behind a lead that moved. A
  // builder you attached to with Enter still counts as its task's details, which the pane goes
  // back to once you leave it.
  const show = (next: string) => {
    if (next === shown) return;
    if (next.startsWith("details:"))
      showTask(agents, session, `${open.owner}/${open.repo}`, next.slice("details:".length));
    else if (
      isDetails(shown) ||
      shownSession(agents, tty) === null ||
      (next === open.lead && leadAttach !== null)
    ) {
      respawnPane(agents, rightPane, paneOn(next));
      paneLead = leadAttach;
    } else showSession(agents, tty, next);
    tty = paneTty(agents, rightPane);
    if (!next.startsWith("details:") && !held) screenTmux(agents, ["select-pane", "-t", rightPane]);
    shown = next;
  };
  // Gives your typing to the right side, if it shows an agent: the lead, or a builder you
  // attached to. A task's details are only to look at, so there it does nothing, and your typing
  // stays kept in the sidebar as you move on, even onto the lead's row. `zoom` gives the agent
  // the whole terminal, as sc attach does, until Ctrl-\ or a move gives the sidebar your typing,
  // as tmux shows every pane again once another pane is selected.
  const toRight = (zoom = false) => {
    const command = screenTmux(agents, [
      "display",
      "-p",
      "-t",
      rightPane,
      "#{pane_start_command}",
    ]).out;
    // The lead's row always shows the lead. Its session isn't what the sidebar last showed when
    // it runs on a plugin's host, which no tmux client reports, so the row decides.
    if (rows[here]?.part !== "lead" && !command.includes(attachedMark)) return;
    held = false;
    screenTmux(agents, ["select-pane", "-t", rightPane]);
    if (zoom) screenTmux(agents, ["resize-pane", "-Z", "-t", rightPane]);
  };
  // Shows on the right what the row you are on is: the lead's session on the lead's row, and a
  // task's details on any other. A request of the lead's shows as a task's details do, with the
  // lead's screen read-only in place of the details, so your typing stays with the sidebar, y and
  // n answer the request, and nothing, a click included, reaches the lead.
  const follow = () => {
    const row = rows[here];
    if (row) show(row.part === "lead" ? open.lead : detailsOf(row.name));
  };

  // Returns the session of the agent the right side is about: the lead or an agent shown, or on a
  // task's row its builder, whether its details show or you attached to it.
  const about = () => (isDetails(shown) ? (rows[here]?.session ?? null) : shown);

  // Answers a file dropped onto the screen, which asks which agent's folder it goes to: the
  // folder of the agent your typing goes to now, or nothing while it goes to the sidebar, as on a
  // task's details. The keys typed before the drop reached the sidebar first, so the answer
  // follows where they moved you. Each answer starts with a mark of its own, so the screen sees
  // it change even when the folder stays the same.
  let answers = 0;
  const answerDrop = () => {
    const active = screenTmux(agents, ["display", "-p", "-t", `=${session}:`, "#{pane_index}"]);
    const agent = active.out.trim() === "1" ? about() : null;
    let folder = "";
    try {
      if (agent === open.lead) folder = leadOf(db, open.owner, open.repo).folder;
      else {
        const thread = liveThreads(db).find((one) => one.folder === agent);
        if (thread) folder = cloneOf(thread);
      }
    } catch {
      // A repository Skelcrew no longer has has no agent to copy to.
    }
    answers++;
    const answer = `${Date.now()}-${answers} ${folder}`;
    screenTmux(agents, ["set", "-t", `=${session}:`, dropAnswerOption, answer]);
  };

  // Returns the harness of the agent in the named session, for what Esc stops: the open lead's,
  // or a builder's, which is Claude Code for one from before Skelcrew saved it. Empty for a
  // session it can't name, such as a repository Skelcrew no longer has.
  const harnessOf = (agent: string | null) => {
    if (agent === open.lead) {
      try {
        return leadOf(db, open.owner, open.repo).harness ?? "";
      } catch {
        return "";
      }
    }
    const thread = liveThreads(db).find((one) => one.folder === agent);
    return thread ? (thread.harness ?? "claude") : "";
  };

  // Returns what the footer says now: a line said or a question asked, the keys for the row
  // while your typing goes to the sidebar, or while it goes to an agent which one it is, the keys
  // you need most and what Esc stops.
  const footerText = () => {
    if (said ?? asking) return said ?? asking?.question.ask ?? "";
    const row = rows[here];
    if (!typingRight && row) return sidebarFooter(row);
    const name = shown === open.lead ? "lead" : (row?.name ?? "");
    return agentFooter(name, harnessOf(about()));
  };

  // Draws the sidebar, the notice above the rest, only when it changed. Every line ends with the
  // sidebar's edge in the pane's last column, and a column before it is left blank. The row you
  // are on is lit while your typing goes to the sidebar, and only outlined while it goes to the
  // right side.
  const draw = () => {
    const { width, height } = size();
    const headings = sectionHeadings(all, opened, builders);
    const room = Math.max(width - 2, 1);
    const drawn = drawRows(rows, headings, here, top, room, height - 1, !typingRight);
    top = drawn.top;
    targets = [...notice.map((): Target => null), null, ...drawn.targets];
    const lines = ["", ...drawn.lines].map(
      (line) => `${filled(line, Math.max(width - 1, 0))}${divider(typingRight)}`,
    );
    const frame = [...notice, ...lines].join("\n");
    if (frame === lastFrame) return;
    lastFrame = frame;
    // Every line fills the pane, so nothing of the last frame is left to clear.
    doing("drawing the sidebar", () =>
      process.stdout.write(`\x1b[H${frame.replaceAll("\n", "\r\n")}`),
    );
  };

  // Shows the rows of the open sections again, keeping you on the same row by its name, or at
  // the same place when it went. So a task that starts or stops needing you moves between Needs
  // you and its stage with you still on it: a section it moves into that is closed opens, as
  // otherwise its row would leave the list under you. The right side follows a row that went,
  // but not the first rows read, as the screen opens on the lead already, on the lead's row.
  const reshow = () => {
    const name = rows[here]?.name;
    const before = rows[here]?.section;
    const moved = all.find((row) => row.name === name);
    if (moved && moved.section !== before && moved.section !== "lead") opened.add(moved.section);
    rows = shownRows(all, opened, wholeBacklog);
    const at = name === undefined ? -1 : rows.findIndex((row) => row.name === name);
    here = at >= 0 ? at : Math.max(Math.min(here, rows.length - 1), 0);
    if (name !== undefined && rows[here]?.name !== name) follow();
  };

  // Looks at the database and tmux again, and redraws what that changed.
  const refresh = () => {
    if (leaving) return;
    // tmux first, then the tabs: the daemon closes a tab before it ends the lead's session, so
    // a lead found gone here with its tab still read as open has crashed.
    const found = doing("asking tmux for the agents' sessions", () => listTmuxSessions(agents));
    running = [...found.flatMap((one) => (one.running ? [one.name] : [])), ...hosted];
    lookAtHosts();
    const exited = doing("asking tmux whether the lead exited", () =>
      exitedCleanly(agents, open.lead),
    );
    const before = tabs;
    tabs = doing("reading the tabs", () => repositoryTabs(db, null));
    // A repository you removed, or whose lead you exited, has no tab left. The sidebar moves to
    // the tab that took its place, or the one before when it was last. With no tab left, the
    // screen leaves as Alt-Q does.
    const at = before.findIndex((tab) => tab.fullName === `${open.owner}/${open.repo}`);
    if (!tabs.some((tab) => tab.fullName === `${open.owner}/${open.repo}`)) {
      const next = tabs[Math.min(Math.max(at, 0), tabs.length - 1)];
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
    // Your typing goes to the right side while its pane is the active one, such as on the lead's
    // row or once you attached to a builder, and to the sidebar otherwise. It is asked before
    // anything is drawn, as the sidebar and the top row show it.
    typingRight = doing(
      "asking tmux where your typing goes",
      () =>
        screenTmux(agents, ["display", "-p", "-t", rightPane, "#{pane_active}"]).out.trim() === "1",
    );
    notice = noticeLines(updateNotice(db), size().width, typingRight);
    // A repository Skelcrew no longer has has no rows, until the sidebar moves off it.
    all = doing("reading the rows", () => {
      try {
        return listRows(db, open, Date.now());
      } catch {
        return [];
      }
    });
    builders = doing("reading how full the builders are", () => {
      try {
        return buildersNote(db, open);
      } catch {
        return "";
      }
    });
    reshow();
    // An agent can end and its client move to the lead by itself, so the session shown is asked
    // of tmux, unless details show. With no client on the right while the lead isn't running,
    // the right side is waiting for the lead, such as after a builder ended while its lead was
    // gone, so the lead is what it shows. The sidebar then moves to the lead's row with it.
    if (!isDetails(shown)) {
      const client = doing("asking tmux which agent shows", () => shownSession(agents, tty));
      if (client) shown = client;
      else if (!running.includes(open.lead)) shown = open.lead;
      if (shown === open.lead && rows[here]?.part !== "lead") here = 0;
    }
    // A lead that moved to or from a plugin's host, or to another session on it, is shown
    // through its host now, once the right side shows the lead. This comes once the sidebar knows
    // what the right side shows, as at the first look it doesn't yet.
    leadAttach = doing("reading the lead's host", () => leadOnHost(db, open));
    if (shown === open.lead && paneLead !== leadAttach) {
      respawnPane(agents, rightPane, paneOn(open.lead));
      tty = paneTty(agents, rightPane);
      paneLead = leadAttach;
    }
    // A lead that crashed while you look at it is brought back with its conversation, once,
    // as the daemon does at its start. One you exited closes its tab instead.
    if (running.includes(open.lead)) asked = null;
    else if (shown === open.lead && asked !== open.lead && !exited) {
      asked = open.lead;
      openRepository(`${open.owner}/${open.repo}`, true);
    }
    // The header and the tabs go to tmux's status line, and only when they changed.
    const width = doing("asking tmux the agent's width", () => paneWidth(agents, rightPane));
    const left = size().width + 1;
    const look = {
      tabs,
      open: `${open.owner}/${open.repo}`,
      where,
      versions: shownVersions(),
      typingRight,
    };
    const top = drawTop(look, { left, width });
    if (top !== lastTop) {
      lastTop = top;
      doing("drawing the top row", () => showTop(agents, session, top));
    }
    // The footer, also only when it changed.
    const footer = doing("reading the footer's harness", footerText);
    if (footer !== lastFooter) {
      lastFooter = footer;
      doing("drawing the footer", () => tellFooter(agents, session, footer));
    }
    draw();
  };

  // Opens another repository: its rows on the left at once, on its lead's row, and its lead on
  // the right, which the daemon starts then if it never has. The client on the right tries again
  // each second until the lead's session is there.
  function switchTo(fullName: string) {
    if (fullName === `${open.owner}/${open.repo}`) return;
    open = repositoryAndLead(db, fullName);
    leadAttach = leadOnHost(db, open);
    // Not waited on, so the sidebar draws at once.
    openRepository(fullName, true);
    asked = open.lead;
    all = [];
    rows = [];
    here = 0;
    top = 0;
    asking = null;
    respawnPane(agents, rightPane, paneOn(open.lead));
    tty = paneTty(agents, rightPane);
    paneLead = leadAttach;
    if (!held) screenTmux(agents, ["select-pane", "-t", rightPane]);
    shown = open.lead;
  }
  // Moves to the tab after the open one, by 1, or before it, by -1, each wrapping round.
  const nextRepository = (by: 1 | -1) => {
    const at = tabs.findIndex((tab) => tab.fullName === `${open.owner}/${open.repo}`);
    const next = tabs[(at + by + tabs.length) % tabs.length];
    if (!next) return;
    switchTo(next.fullName);
    // Keys that came with the switch, such as Alt-Shift-Down, move in the new repository's rows.
    refresh();
  };

  // Moves to the row at `at` among those that show, staying among them, and shows it on the right.
  const moveTo = (at: number) => {
    here = Math.min(Math.max(at, 0), rows.length - 1);
    follow();
  };
  // Moves to the first row of the section before or after yours: the lead, Needs you, or an
  // open stage with rows, past the headings. Past the first and the last there is nowhere to go.
  const jump = (by: 1 | -1) => {
    const starts = rows.flatMap((row, at) =>
      at === 0 || (row.part !== "heading" && rows[at - 1]?.part === "heading") ? [at] : [],
    );
    const onHeading = rows[here]?.part === "heading";
    const mine = onHeading ? here : (starts.filter((at) => at <= here).at(-1) ?? 0);
    const next =
      by === 1 ? starts.find((at) => at > here) : starts.filter((at) => at < mine).at(-1);
    if (next !== undefined) moveTo(next);
  };
  // Opens or closes a stage. Needs you and Up next never close, as they are where you must look.
  // Opening one moves you to its first row, so its heading and first rows show. Closing the one
  // you are in moves you to its heading, as your row hides.
  const toggle = (section: Section) => {
    if (section === "needs you" || section === "up next") return;
    const inside = rows[here]?.section === section;
    const closing = opened.delete(section);
    if (!closing) opened.add(section);
    reshow();
    const first = rows.findIndex(
      (row) => row.section === section && (closing || row.part !== "heading"),
    );
    if (first >= 0 && (inside || !closing)) moveTo(first);
  };

  // Has the daemon start or merge once you said y, saying so meanwhile. A start says what the
  // daemon answered, as a builder can take the last free place while you are asked, and the task
  // then waits in the queue though the question said it would start. When the daemon or the
  // forge refuses, the footer says why until the next key.
  const goAhead = async (action: Question) => {
    working = true;
    said = action.working;
    refresh();
    try {
      said = await startOrMerge(action.request);
    } catch (error) {
      said = errorText(error);
    }
    working = false;
  };

  // Moves the queued task you are on one place earlier, by -1, or later, by 1, as in the list.
  // You stay on its row, and the footer says its place. A paused task has no place until sc start
  // queues it, so the footer says that instead.
  const reorder = async (row: Row, by: -1 | 1) => {
    if (row.task === null || row.section !== "up next") return;
    if (row.place === null) {
      said = `${row.name} is paused: sc start ${row.name} brings it back`;
      return;
    }
    working = true;
    try {
      said = await moveQueued(`${open.owner}/${open.repo}`, row.task, by);
    } catch (error) {
      said = errorText(error);
    }
    working = false;
    refresh();
  };

  // Shows on the right side why Enter couldn't attach to the builder of the task named, such as a
  // builder that isn't running, in place of its details, as that is where you meant to reach it.
  // Your next key or move brings the details back. A reason that comes after you moved on is
  // dropped, as the right side shows another row by then.
  const refuse = (name: string, reason: string) => {
    if (shown !== detailsOf(name)) return;
    // Cut at words to the pane's width, a column in, each line printed as given, never run.
    const room = Math.max(paneWidth(agents, rightPane) - 2, 10);
    const lines = Bun.wrapAnsi(removeControlCodes(reason), room, { hard: true }).split("\n");
    const say = 'printf "\\n"; printf " %s\\n" "$@"; exec cat >/dev/null';
    respawnPane(agents, rightPane, ["sh", "-c", say, "sh", ...lines]);
    tty = paneTty(agents, rightPane);
    shown = refused;
  };

  // Opens the row you are on, as Enter does in the list. On the lead's row it gives your typing
  // to the lead, and on a heading it opens or closes its stage. On a task at work, the builder
  // takes the right side and your typing, until Ctrl-\ brings back its details, or the right side
  // says why it can't. `zoom`, from Shift-Enter or `a`, gives the lead or the builder the whole
  // terminal, and does nothing on a row Enter doesn't attach on. Up next says what the task waits
  // on. Backlog asks to start the task, and the `… more` row shows every issue. Ready and Done
  // open the PR, or copy its link. A ready task whose builder needs you reaches the builder
  // instead, so one Enter reaches what it waits on.
  const enter = (zoom = false) => {
    const row = rows[here];
    if (!row) return;
    if (row.part === "request") {
      if (!zoom) said = "Press y to say yes to the lead, or n to say no.";
      return;
    }
    if (zoom && !enterAttaches(row)) return;
    if (row.part === "lead") return toRight(zoom);
    if (row.part === "heading" && row.section !== "lead") return toggle(row.section);
    if (row.more > 0) {
      wholeBacklog = true;
      return reshow();
    }
    if (row.part === "backlog" && row.start) {
      asking = { question: row.start, row: row.name, merge: false };
      return;
    }
    // A task up next has no builder running yet, so the footer says what it waits on.
    if (row.section === "up next") {
      said = row.waits;
      return;
    }
    const atWork = row.part !== "ready" && row.part !== "done";
    if ((atWork || row.needsYou) && row.session) {
      const repository = `${open.owner}/${open.repo}`;
      held = false;
      // The builder takes your typing as it comes, unless you kept it in the sidebar meanwhile.
      const takeTyping = () => !held;
      void attachTask(agents, session, repository, row.name, takeTyping, zoom).then((failed) => {
        if (failed !== null) refuse(row.name, failed);
        refresh();
      });
      return;
    }
    said = openPr(db, open, row, canOpen, (text) => process.stdout.write(text));
  };

  // Acts on a press of the mouse at a column and line, counted from 1. A click on the lead moves
  // to it, so the right side shows the lead, and gives the lead your typing. A click on a task
  // moves to it, and a second click on it opens it as Enter does. A click on a stage's heading, or
  // its name pinned at an edge, opens or closes it. The wheel moves one row up or down.
  const click = (button: string, column: number, line: number) => {
    if (button === "64") return moveTo(here - 1);
    if (button === "65") return moveTo(here + 1);
    if (button !== "0") return;
    const target = targets[line - 1] ?? null;
    if (target === null) return;
    if ("section" in target) return toggle(target.section);
    if ("pinned" in target) {
      const pinned = target.pinned.find((span) => span.from <= column && column <= span.to);
      return pinned && toggle(pinned.section);
    }
    if (rows[target.row]?.part === "lead") {
      moveTo(target.row);
      return toRight();
    }
    if (target.row === here) return enter();
    moveTo(target.row);
  };

  // Acts on one key. A question takes only y, and any other key is a no. A line said goes at the
  // next key, which then does what it does. Nothing acts while the daemon is at work on an
  // answer. s and m work as in the list, and only reach the sidebar on a task's row.
  const press = (key: string) => {
    // A drop's question is answered whatever else goes on, as the drop waits for it.
    if (key === dropAsk) return answerDrop();
    const name = keyNames[key] ?? key;
    // Ctrl-\ brings your typing here from anywhere, so it acts before anything else, and leaves a
    // question asked here open.
    if (name === "to sidebar") {
      held = true;
      screenTmux(agents, ["select-pane", "-t", `=${session}:.0`]);
      return;
    }
    if (working) return;
    // A reason shown on the right goes at the next key, which then does what it does.
    if (shown === refused) {
      shown = null;
      follow();
    }
    const [, button, column, line] = clickPattern.exec(key) ?? [];
    if (asking) {
      const action = asking;
      asking = null;
      if (name !== "y") return;
      refresh();
      const offer = stillOffered(action, all);
      if (typeof offer === "string") said = offer;
      else void goAhead(offer);
      return;
    }
    said = null;
    // A plain key reaches the sidebar only while it has your typing, and keeps it there as you
    // move. Alt keys, clicks and tabs clicked come through the screen's tmux from anywhere.
    if (!altPattern.test(key)) held = true;
    const row = rows[here];
    if (name === "up" || name === "down") return moveTo(here + (name === "up" ? -1 : 1));
    if ((name === "earlier" || name === "later") && row)
      return void reorder(row, name === "earlier" ? -1 : 1);
    if (name === "previous section" || name === "next section")
      return jump(name === "next section" ? 1 : -1);
    if (name === "next repository" || name === "previous repository")
      return nextRepository(name === "next repository" ? 1 : -1);
    if (key.startsWith(`${esc}]skel-tab;`)) {
      const tab = tabs[Number(key.slice(`${esc}]skel-tab;`.length, -1))];
      if (tab) switchTo(tab.fullName);
      return refresh();
    }
    if (button && column && line) return click(button, Number(column), Number(line));
    // 1 to 6, with Alt or without, open or close the stages, in the order they show.
    const bare = key.startsWith(esc) ? key.slice(1) : key;
    const stage = /^[1-6]$/.test(bare) ? ListStage.options[Number(bare) - 1] : undefined;
    if (stage) return toggle(stage);
    if (name === "enter" || name === "full screen") return enter(name === "full screen");
    // Page Up and Page Down scroll the details on the right, which run in a pane of their own,
    // so they are handed on to it.
    if ((name === "page up" || name === "page down") && row?.task && isDetails(shown)) {
      screenTmux(agents, ["send-keys", "-t", rightPane, name === "page up" ? "PPage" : "NPage"]);
      return;
    }
    // y and n answer the lead's request you are on at once, as its row is the question.
    const answer = (key === "y" || key === "n") && row ? answerOf(open, row, key === "y") : null;
    if (answer) void goAhead(answer);
    else if (key === "s" && row?.part === "backlog" && row.start)
      asking = { question: row.start, row: row.name, merge: false };
    else if (key === "m" && row?.merge) {
      if ("refused" in row.merge) said = row.merge.refused;
      else asking = { question: row.merge, row: row.name, merge: true };
    } else if (key === "m" && row?.part === "ready")
      said = row.needsYou
        ? `${row.name}'s builder needs you first: press Enter to reach it`
        : `${row.name} has no PR to merge here`;
  };

  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink at the end of the sidebar. 1000 and 1006 ask for
  // clicks and the wheel, in the form tmux can give a place of any size.
  // 2004 has tmux mark a paste's start and end, so text pasted here, such as a file's path dropped
  // onto your terminal, is skipped whole rather than pressing the keys its letters and digits are.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h");
  let pasting = false;
  // Acts on each key and click in `text`, but none inside a paste.
  const act = (text: string) => {
    for (const [key] of text.matchAll(keyPattern)) {
      if (key === "\x1b[200~" || key === "\x1b[201~") pasting = key === "\x1b[200~";
      else if (!pasting) doing("acting on a key", () => press(key));
    }
  };
  // A sequence a read ends inside, such as a paste's start or end cut in two, waits for its rest
  // in the next read, so it is still seen whole. One whose rest never comes goes on after a
  // second. That holds a lone Esc too, which the sidebar has no use for.
  let cut = "";
  let rest: ReturnType<typeof setTimeout> | null = null;
  // Acts on each key and click that came together, then redraws.
  process.stdin.on("data", (bytes) => {
    if (rest) clearTimeout(rest);
    rest = null;
    const text = cut + bytes.toString();
    cut = unfinished("", text);
    act(text.slice(0, text.length - cut.length));
    if (cut !== "")
      rest = setTimeout(() => {
        act(cut);
        cut = "";
        refresh();
      }, 1000);
    refresh();
  });
  // Draws now, on each resize and each second, until the pane goes and its input closes.
  process.on("SIGWINCH", refresh);
  refresh();
  setInterval(refresh, 1000);
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}

// Returns the sidebar's edge, the line between the two sides, which leans to the side your typing
// goes to, and is lit there: to the right side while `typingRight`, and to the sidebar otherwise.
// It is the last column of every line of the sidebar.
const divider = (typingRight: boolean) => paint(lightGrey, typingRight ? "▕" : "▏");

// Returns the lines that go above the rest of the sidebar for a notice, such as a release installed
// in the background, or none without one. Cut at words to fit a sidebar `width` columns wide, and
// parted from what follows by a blank line. Each fills the pane and ends with the sidebar's edge,
// which leans as `typingRight` says.
function noticeLines(notice: string, width: number, typingRight: boolean): string[] {
  if (!notice) return [];
  const room = Math.max(width - 1 - 2 * pad.length, 1);
  // A word goes on the last line while it fits, and starts a new one when it doesn't. A word
  // longer than a whole line has one to itself.
  const lines = [""];
  for (const word of notice.split(" ")) {
    const last = lines.length - 1;
    const longer = lines[last] ? `${lines[last]} ${word}` : word;
    if (Bun.stringWidth(longer) <= room || !lines[last]) lines[last] = longer;
    else lines.push(word);
  }
  // Each line is padded, a blank one follows, and all of them end at the sidebar's edge.
  return [...lines.map((line) => `${pad}${line}`), ""].map(
    (line) => `${filled(line, width - 1)}${divider(typingRight)}`,
  );
}

// Returns the agents running on a plugin's host, for the sidebar: builders by their thread's
// folder, and the open repository's lead by its name, so a lead there that ends is noticed and
// brought back, as one on tmux is. Each host is asked once for all its agents. While a host fails
// to answer, whether its agents run is unknown, and each counts as running: a host can fail for a
// moment, even before it ever answered, and a lead there must not be taken for crashed.
async function hostedAgents(db: ReturnType<typeof openDb>, open: Open): Promise<Set<string>> {
  const found = new Set<string>();
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
    const listed = await listSessions(host).catch(() => null);
    for (const agent of agents) {
      if (agent.host !== name) continue;
      if (listed === null || listed.some((one) => one.name === agent.id && one.running))
        found.add(agent.key);
    }
  }
  return found;
}
