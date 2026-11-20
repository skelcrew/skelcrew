// The sidebar: the live left pane of the screen, which is the list of the open repository. Its
// lead is on top, then Needs you and the six stages, as sc --list shows them. The right side
// follows the row you are on: the lead's session on the lead's row, a task's details on a task's.
// The sidebar also keeps the top row up to date, with the header, the tabs and the strip, tells
// the footer what to say, and switches tabs.
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
import { moveQueued, openRepository, startOrMerge } from "../client.ts";
import { openDb } from "../db.ts";
import { leadOf } from "../flow/lead.ts";
import { ListStage } from "../flow/stage.ts";
import { doing, watchForStalls } from "../flow/stall.ts";
import { liveThreads } from "../flow/thread.ts";
import { type Asking, canOpenLinks, openPr, stillOffered } from "../list/actions.ts";
import { drawRows, type Target } from "../list/layout.ts";
import {
  buildersNote,
  cutBacklog,
  listRows,
  type Question,
  type Row,
  type Section,
  sectionHeadings,
} from "../list/rows.ts";
import { updateNotice } from "../machine/update.ts";
import { leadPlaces, screenLogFile } from "../paths.ts";
import { quoteForSh } from "../plugins/plugin.ts";
import { attachOnHostLine, pluginHost } from "../plugins/runtime.ts";
import { errorText } from "../say.ts";
import { version } from "../version.ts";
import { agentFooter, tellFooter } from "./footer.ts";
import { noticeLines } from "./layout.ts";
import { roundLimit } from "./lists.ts";
import { edge, filled, paint, removeControlCodes } from "./look.ts";
import { type Open, repositoryTabs, sidebarRows } from "./rows.ts";
import { sidebarWidth } from "./screen.ts";
import { drawTop } from "./strip.ts";
import { attachTask, showTask } from "./task.ts";

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
// A press of the mouse, with its button, column and line, counted from 1. A release ends in m,
// and does nothing.
const clickPattern = new RegExp(`^${esc}\\[<(\\d+);(\\d+);(\\d+)M$`);
// The keys the sidebar acts on, by what they do. The Alt ones come from the screen's tmux, from
// anywhere. The plain ones come only while the right side shows a task's details, as your typing
// then goes to the sidebar. Alt with a digit and the digit alone open or close a stage.
const keyNames: Record<string, string> = {
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
};

// The keys the footer shows on a task's row, where your typing goes to the sidebar: Enter, the
// stages' numbers, Shift with an arrow only on a queued task in Up next, which it moves in the
// queue, and s or m only where the row can be started, or queued, or merged.
function taskFooter(row: Row): string {
  const reorder = row.section === "up next" && row.place !== null ? "  ⇧↑↓ reorder" : "";
  const start = row.start ? (row.start.queues ? "  s queue" : "  s start") : "";
  const merge = row.merge && "ask" in row.merge ? "  m merge" : "";
  return `⌥↑↓ move  ⏎ open  1-6 stages${reorder}${start}${merge}  ⌥Q quit`;
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

// Returns the line that attaches to the open repository's lead when it runs on a plugin's host,
// as the screen can't show it through tmux. Null for a lead on tmux, one whose plugin is gone,
// and a repository Skelcrew no longer has.
function leadOnHost(db: ReturnType<typeof openDb>, { owner, repo }: Open): string | null {
  try {
    const { host, hostId, name } = leadOf(db, owner, repo);
    if (host === "tmux") return null;
    const plugin = pluginHost(db, host);
    return plugin && attachOnHostLine(plugin, hostId ?? name);
  } catch {
    return null;
  }
}

// What the right side shows of a task: its details, by the task's name, such as app-12. Anything
// else the right side shows is an agent's session, by its name.
const detailsOf = (name: string) => `details:${name}`;
const isDetails = (shown: string | null) => shown?.startsWith("details:") ?? false;
// What the right side shows while it says why Enter couldn't attach to a builder.
const refused = "refused";

// Runs the sidebar until its pane goes. The session given is its own, on the screen's server,
// `where` says which remote Skelcrew runs on, if any, for the header above it, and `repository`
// is the owner/name of the repository it opens on.
// tmux brings it the Alt keys and clicks, and your typing while a task's details show. It looks
// again each second, and writes only when something changed, as over a slow link each write costs.
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
  // its name, with the line that attaches to each, as the last look at the hosts found them. The
  // look runs in the background, one at a time, as a host can be slow, and the sidebar never
  // waits on it.
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
  // The list's rows: every row, those that show, which are the lead's and those of the open
  // sections, the row you are on among those and how far the sections scrolled. Needs you is
  // always open, and so is Up next, and of the stages only Building at first. The sections you
  // open stay open,
  // whichever repository you move to, and so does a whole Backlog once you asked for it.
  let all: Row[] = [];
  let rows: Row[] = [];
  const opened = new Set<Section>(["needs you", "up next", "building"]);
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
  // What the footer says in place of its keys until the next key, the question it asks, and
  // whether the daemon is at work on an answer.
  let said: string | null = null;
  let asking: Asking | null = null;
  let working = false;
  let lastFrame = "";
  let lastStrip = "";
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
    width: process.stdout.columns || sidebarWidth,
    height: (process.stdout.rows || 24) - notice.length,
  });

  // Puts `next` on the right: an agent's session, or a task's details, which leave your typing
  // with the sidebar. A client can switch between agents, but coming from details the pane must
  // run something else, and so must a client still attaching, which can't switch yet. A lead on a
  // plugin's host runs that host's attach in the pane, as no tmux client can switch to it. A
  // builder you attached to with Enter still counts as its task's details, which the pane goes
  // back to once you leave it.
  const show = (next: string) => {
    if (next === shown) return;
    const onHost = hosted.get(next);
    if (next.startsWith("details:"))
      showTask(agents, session, `${open.owner}/${open.repo}`, next.slice("details:".length));
    else if (onHost !== undefined)
      respawnPane(agents, rightPane, ["sh", "-c", `${onHost}; ${leadLine()}`]);
    else if (
      isDetails(shown) ||
      shownSession(agents, tty) === null ||
      (next === open.lead && leadAttach !== null)
    )
      respawnPane(agents, rightPane, paneOn(next));
    else showSession(agents, tty, next);
    tty = paneTty(agents, rightPane);
    if (!next.startsWith("details:")) screenTmux(agents, ["select-pane", "-t", rightPane]);
    shown = next;
  };
  // Shows on the right what the row you are on is: the lead's session on the lead's row, and a
  // task's details on any other.
  const follow = () => {
    const row = rows[here];
    if (row) show(row.part === "lead" ? open.lead : detailsOf(row.name));
  };

  // Returns the session of the agent the right side is about: the lead or an agent shown, or on a
  // task's row its builder, whether its details show or you attached to it.
  const about = () => (isDetails(shown) ? (rows[here]?.session ?? null) : shown);

  // Returns what the footer says now: a line said or a question asked, the keys for a task's row
  // while your typing goes to the sidebar, or while it goes to an agent the keys you need most
  // and what Esc stops. `typing` says whether your typing goes to the right side.
  const footerText = (agentRows: ReturnType<typeof sidebarRows>, typing: boolean) => {
    if (said ?? asking) return said ?? asking?.question.ask ?? "";
    const row = rows[here];
    if (!typing && row) return taskFooter(row);
    const agent = agentRows.find((one) => one.session === about());
    return agentFooter(agent?.agentHarness ?? "");
  };

  // Draws the sidebar, the notice above the rest, only when it changed. Every line ends with the
  // sidebar's edge in the pane's last column, and a column before it is left blank.
  const draw = () => {
    const { width, height } = size();
    const headings = sectionHeadings(all, opened, builders);
    const drawn = drawRows(rows, headings, here, top, Math.max(width - 2, 1), height - 1);
    top = drawn.top;
    targets = [...notice.map((): Target => null), null, ...drawn.targets];
    const lines = ["", ...drawn.lines].map(
      (line) => `${filled(line, Math.max(width - 1, 0))}${paint(edge, "│")}`,
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
    rows = cutBacklog(all, wholeBacklog).filter(
      (row) => row.section === "lead" || opened.has(row.section),
    );
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
    running = [...found.flatMap((one) => (one.running ? [one.name] : [])), ...hosted.keys()];
    lookAtHosts();
    const exited = doing("asking tmux whether the lead exited", () =>
      exitedCleanly(agents, open.lead),
    );
    const before = tabs;
    tabs = doing("reading the tabs", () => repositoryTabs(db, roundLimit));
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
    // A lead that crashed while you look at it is brought back with its conversation, once,
    // as the daemon does at its start. One you exited closes its tab instead.
    if (running.includes(open.lead)) asked = null;
    else if (shown === open.lead && asked !== open.lead && !exited) {
      asked = open.lead;
      openRepository(`${open.owner}/${open.repo}`, true);
    }
    // The header, the tabs and the strip go to tmux's status line, and only when they changed.
    const agentRows = doing("reading the agents' rows", () =>
      sidebarRows(db, running, roundLimit, Date.now(), open),
    );
    const width = doing("asking tmux the agent's width", () => paneWidth(agents, rightPane));
    const left = size().width + 1;
    const fullName = `${open.owner}/${open.repo}`;
    const look = {
      rows: agentRows,
      shown: about(),
      page: null,
      tabs,
      open: fullName,
      where,
      version,
    };
    const strip = drawTop(look, { left, width });
    if (strip !== lastStrip) {
      lastStrip = strip;
      doing("drawing the strip", () => showStrip(agents, session, strip));
    }
    // The footer, also only when it changed. The list of keys stays hidden.
    // Your typing goes to the right side while its pane is the active one, such as once you
    // attached to a builder, and to the sidebar otherwise.
    const active = doing("asking tmux where your typing goes", () =>
      screenTmux(agents, ["display", "-p", "-t", `=${session}:`, "#{pane_index}"]),
    );
    const footer = footerText(agentRows, active.out.trim() !== "0");
    if (footer !== lastFooter) {
      lastFooter = footer;
      doing("drawing the footer", () => {
        tellFooter(agents, session, "keys", "hide");
        tellFooter(agents, session, "footer", footer);
      });
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
    screenTmux(agents, ["select-pane", "-t", rightPane]);
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
  // open stage with rows. Past the first and the last there is nowhere to go.
  const jump = (by: 1 | -1) => {
    const starts = rows.flatMap((row, at) =>
      at === 0 || row.section !== rows[at - 1]?.section ? [at] : [],
    );
    const mine = starts.filter((at) => at <= here).at(-1) ?? 0;
    const next =
      by === 1 ? starts.find((at) => at > here) : starts.filter((at) => at < mine).at(-1);
    if (next !== undefined) moveTo(next);
  };
  // Opens or closes a stage. Needs you and Up next never close, as they are where you must look.
  // Opening one moves you to its first row, so its heading and first rows show.
  const toggle = (section: Section) => {
    if (section === "needs you" || section === "up next") return;
    if (opened.delete(section)) return reshow();
    opened.add(section);
    reshow();
    const first = rows.findIndex((row) => row.section === section);
    if (first >= 0) moveTo(first);
  };

  // Has the daemon start or merge once you said y, saying so meanwhile. A start that queues the
  // task says what the daemon answered, so you know it waits. When the daemon or the forge
  // refuses, the footer says why until the next key.
  const goAhead = async (action: Question) => {
    working = true;
    said = action.working;
    refresh();
    try {
      const answer = await startOrMerge(action.request);
      said = action.queues ? answer : null;
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

  // Opens the row you are on, as Enter does in the list. On a task at work, the builder takes
  // the right side and your typing, until Ctrl-\ brings back its details, or the right side says
  // why it can't. Up next says what the task waits on. Backlog asks to start the task, and the `… more` row shows every issue. Ready and Done open the PR, or copy its link. A ready task
  // whose builder needs you reaches the builder instead, so one Enter reaches what it waits on.
  const enter = () => {
    const row = rows[here];
    if (!row || row.part === "lead") return;
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
      void attachTask(agents, session, `${open.owner}/${open.repo}`, row.name).then((failed) => {
        if (failed !== null) refuse(row.name, failed);
      });
      return;
    }
    said = openPr(db, open, row, canOpen, (text) => process.stdout.write(text));
  };

  // Acts on a press of the mouse at a column and line, counted from 1. A click on the lead moves
  // to it, so the right side shows the lead, ready to type to. A click on a task moves to it, and
  // a second click on it opens it as Enter does. A click on a stage's heading, or its name pinned
  // at an edge, opens or closes it. The wheel moves one row up or down.
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
    if (target.row === here && rows[here]?.part !== "lead") return enter();
    moveTo(target.row);
  };

  // Acts on one key. A question takes only y, and any other key is a no. A line said goes at the
  // next key, which then does what it does. Nothing acts while the daemon is at work on an
  // answer. s and m work as in the list, and only reach the sidebar on a task's row.
  const press = (key: string) => {
    if (working) return;
    // A reason shown on the right goes at the next key, which then does what it does.
    if (shown === refused) {
      shown = null;
      follow();
    }
    const name = keyNames[key] ?? key;
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
    if (name === "enter") return enter();
    if (key === "s" && row?.part === "backlog" && row.start)
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
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
  // Acts on each key and click that came together, then redraws.
  process.stdin.on("data", (bytes) => {
    for (const [key] of bytes.toString().matchAll(keyPattern))
      doing("acting on a key", () => press(key));
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
