// The screen's sidebar keeps the lead, Needs you and tasks by stage, with the selected row marked.
// Items and task details show on the right; keys here answer items and steer the screen.
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
import { answerItem, moveQueued, openRepository, startOrMerge } from "../client.ts";
import { openDb } from "../db.ts";
import { leadOf } from "../flow/lead.ts";
import { closeRepo, removeRepo } from "../flow/repo.ts";
import { doing, watchForStalls } from "../flow/stall.ts";
import { cloneOf, liveThreads, typedTask } from "../flow/thread.ts";
import { errorText } from "../format.ts";
import {
  type Asking,
  canOpenLinks,
  itemFooter,
  itemKey,
  openPr,
  picked,
  type Reply,
  replyLine,
  stillOffered,
  typeReply,
} from "../list/actions.ts";
import {
  drawItem,
  drawRows,
  enterAttaches,
  listShare,
  type Pick,
  type Spin,
  spinner,
  type Target,
} from "../list/layout.ts";
import {
  buildersNote,
  listRows,
  numbered,
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
import { versionLabels } from "../version.ts";
import { dropAnswerOption, dropAsk, dropNoticeOption, escapeTime, unfinished } from "./drops.ts";
import { agentFooter, tellFooter } from "./footer.ts";
import { filled, grey, pad, paint, removeControlCodes } from "./look.ts";
import { attachedMark, leadOnHost, narrowBelow, panes, sidebarFor, zoomIn } from "./screen.ts";
import { attachTask, showTask } from "./task.ts";
import { drawTop, sidebarRange } from "./top.ts";

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
// The keys the screen's tmux sends the sidebar from anywhere: Alt with an arrow, a digit or W, a
// click, and a message such as a click on a tab. Any other key was typed into the sidebar.
const altPattern = new RegExp(`^${esc}(\\[1;3[AB]|\\[1;4[A-D]|[0-6w]|\\[<|\\])`);
// A press of the mouse, with its button, column and line, counted from 1. A release ends in m,
// and does nothing.
const clickPattern = new RegExp(`^${esc}\\[<(\\d+);(\\d+);(\\d+)M$`);
// The keys the sidebar acts on, by what they do. The Alt ones come from the screen's tmux, from
// anywhere. The plain ones come only while your typing goes to the sidebar. Alt with a digit and
// the digit alone open or close a stage. The screen's tmux sends Ctrl-\'s byte from anywhere,
// for Alt-Tab, Ctrl-\ or Ctrl-4, to switch your typing, and Shift-Enter as CSI-u, only while
// your typing is here already. Plain Tab and Shift-Tab switch your typing too, so a missed Alt
// never moves to another repository. Only Enter and Shift-Enter attach: a letter that isn't a pick
// does nothing. Alt-W and plain w ask whether to close or remove the open repository.
const keyNames: Record<string, string> = {
  "\x1c": "switch",
  "\x1bw": "close",
  w: "close",
  "\x1b": "esc",
  "\x1b[13;2u": "full screen",
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
  "\t": "switch",
  "\x1b[Z": "switch",
  "\r": "enter",
  "\n": "enter",
  "\x1b[5~": "page up",
  "\x1b[6~": "page down",
};

function sidebarFooter(row: Row, restarts: boolean): string {
  const first = "↑↓ move  ⇥ switch  w/⌥W close";
  const end = `${restarts ? "  R restart" : ""}  q/⌥Q quit`;
  if (row.part === "lead") return `${first}  ⏎ to lead  ⇧⏎ full screen  0-6 sections${end}`;
  if (row.part === "heading") {
    const fixed = row.section === "needs you";
    return `${first}${fixed ? "" : "  ⏎ open/close"}  0-6 sections${end}`;
  }
  const scroll = row.task ? " · pgup/pgdn scroll" : "";
  const reorder = row.section === "task queue" && row.place !== null ? "  ⇧↑↓ reorder" : "";
  const start = row.start ? (row.start.queues ? "  s queue" : "  s start") : "";
  const now = row.startNow ? "  f start now" : "";
  const merge = row.merge && "ask" in row.merge ? "  m merge" : "";
  const full = "⇧⏎ full screen";
  const enter = row.ask
    ? `⏎ open item  ${full}`
    : enterAttaches(row)
      ? `⏎ attach  ${full}`
      : "⏎ open";
  return `${first}  ${enter}${scroll}  0-6 sections${reorder}${start}${now}${merge}${end}`;
}

// The question the close key asks about the open repository, by the step it is at: which of
// closing its tab or removing it, then a yes to the one you chose, then at work on it, then a
// refusal to read. `name` is what it shows, and `fullName` the owner/name it acts on, as a
// name can pass to another repository while it asks. `said` is what it says at work, or the refusal. `back` is where your typing
// was before the question took it, so Esc puts it back there, full screen too.
type Closing = {
  step: "choose" | "close" | "remove" | "working" | "refused";
  name: string;
  fullName: string;
  said: string;
  back: { right: boolean; zoomed: boolean; held: boolean };
};

// Returns what the sidebar shows in place of its rows while the close key's question is open, as
// paragraphs, and what the footer says meanwhile.
function closingText(closing: Closing): { lines: string[]; footer: string } {
  const { name } = closing;
  if (closing.step === "choose")
    return {
      lines: [
        `Close ${name}?`,
        "c  close the tab: its lead stops, its tasks keep running, and it comes back when you open the repository again",
        "r  remove it from Skelcrew: deletes Skelcrew's clone and its record",
        "esc  cancel",
      ],
      footer: "c close  r remove  esc cancel",
    };
  if (closing.step === "close")
    return { lines: [`Close ${name}'s tab? y/n`], footer: "y yes  n no" };
  if (closing.step === "remove")
    return {
      lines: [
        `Remove ${name} from Skelcrew? Its clone is deleted; GitHub and your checkouts are untouched. y/n`,
      ],
      footer: "y yes  n no",
    };
  if (closing.step === "working") return { lines: [closing.said], footer: "" };
  return { lines: [closing.said], footer: "any key to go back" };
}

// What the right side shows once no tab is left: how to open a repository again.
const emptyText = "No repository is open. Run sc in a checkout of one to open it.";

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
// Only the spinners turn in between, and only on this machine, each by its own cell.
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
  const rightPane = `=${session}:.${panes.right}`;
  let tty = paneTty(agents, rightPane);
  // The list's rows: every row, those that show, which are the lead's and those of the open
  // sections, the row you are on among those and how far the sections scrolled. Needs you is always
  // open, and the task queue, Building, Reviewing and Checks start open, as that is where the work
  // under way is, and what starts next. The sections you open or close stay so, whichever
  // repository you move to, and so does a whole Backlog once you asked for it.
  let all: Row[] = [];
  let rows: Row[] = [];
  const opened = new Set<Section>(["needs you", "task queue", "building", "reviewing", "checks"]);
  // What Task queue's heading says of the builders, read with the rows.
  let builders: ReturnType<typeof buildersNote> = null;
  let wholeBacklog = false;
  let here = 0;
  let top = 0;
  let targets: Target[] = [];
  // The agents whose sessions run, on tmux or a plugin's host, as the last refresh found them.
  let running: string[] = [];
  // What is on the right: an agent's session, or a task's details, by detailsOf.
  let shown: string | null = null;
  // Whether you keep your typing in the sidebar yourself, by a switch or by any plain key there.
  // Moving then leaves it there, even onto the lead's row, so a digit or an arrow never lands in
  // an agent. Enter on the lead's row or a click on the lead gives it back. With Alt keys alone,
  // typing follows the row: the lead's row types to the lead.
  let held = false;
  // Where your typing went at the last look, which the top of the boxes shows and the footer says.
  let typingRight = true;
  let switchedFrom: { name: string; zoomed: boolean } | null = null;
  let narrow = false;
  // What the footer says in place of its keys until the next key, the question it asks, and
  // whether the daemon is at work on an answer.
  let said: string | null = null;
  let asking: Asking | null = null;
  let working = false;
  // The reply you are typing to the lead's item on a row, which takes every key until it is sent
  // or dropped, and how far the item you opened full-size with Enter is scrolled, or null.
  let replying: Reply | null = null;
  let item: number | null = null;
  let lastFrame = "";
  // The spinners on the marks of agents at work, where the last frame drew them, and the frame
  // they show. They turn only on this machine, as over sc --remote each turn would cost a write.
  let spins: Spin[] = [];
  let turn = 0;
  const spinning = where === "";
  let lastTop = "";
  let lastFooter = "";
  // The notice's lines, above the rest, which has the height that is left.
  let notice: string[] = [];
  // The lead this sidebar last asked the daemon to start, until it runs, so a lead that can't
  // start isn't asked for again each second. Whatever opened the screen asked already.
  let asked: string | null = open.lead;
  // The close key's question while it is open, and whether no tab is left, so the screen shows
  // how to open a repository rather than any repository's rows.
  let closing: Closing | null = null;
  let empty = false;
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
    const lead = rows[here]?.part === "lead" || rows[here]?.part === "ask";
    if (!lead && !command.includes(attachedMark)) return;
    held = false;
    screenTmux(agents, ["select-pane", "-t", rightPane]);
    if (zoom) screenTmux(agents, zoomIn(rightPane));
  };
  const toSidebar = () => {
    held = true;
    screenTmux(agents, ["select-pane", "-t", `=${session}:.${panes.sidebar}`]);
  };
  const switchTyping = () => {
    const asked = (format: string) =>
      screenTmux(agents, ["display", "-p", "-t", rightPane, format]).out.trim();
    const row = rows[here];
    if (asked("#{pane_active}") === "1") {
      switchedFrom = row
        ? { name: row.name, zoomed: asked("#{window_zoomed_flag}") === "1" }
        : null;
      toSidebar();
      if (asked("#{pane_start_command}").includes(attachedMark))
        screenTmux(agents, ["run-shell", "-t", rightPane, "pkill -P #{pane_pid}"]);
      return;
    }
    if (closing) return working ? undefined : goBack();
    if (!held || !row) return toSidebar();
    const zoom = switchedFrom?.name === row.name && switchedFrom.zoomed;
    if (row.part === "lead" || row.part === "ask") return toRight(zoom);
    if (switchedFrom?.name === row.name && row.session) attachBuilder(row, zoom);
  };
  const endAttachment = () => {
    const command = screenTmux(agents, ["display", "-p", "-t", rightPane, "#{pane_start_command}"]);
    if (!command.out.includes(attachedMark)) return toSidebar();
    screenTmux(agents, ["run-shell", "-t", rightPane, "pkill -P #{pane_pid}"]);
  };
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
    const agent = Number(active.out) === panes.right ? about() : null;
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

  const restartOf = (row: Row): Question | null => {
    const lead = row.part === "lead";
    const task = row.part !== "heading" ? row.task : null;
    const runs = lead
      ? running.includes(open.lead)
      : task !== null && row.running && row.session !== null && running.includes(row.session);
    if (!runs) return null;
    const repository = `${open.owner}/${open.repo}`;
    const who = lead
      ? `${tabs.find((tab) => tab.fullName === repository)?.name ?? open.repo}'s lead`
      : `${row.name}'s builder`;
    return {
      ask: `Restart ${who}? Its conversation is kept. y/n`,
      working: `Restarting ${who}…`,
      request: {
        command: "restart",
        repo: repository,
        ...(task === null ? {} : { task: typedTask(task) }),
      },
      queues: false,
    };
  };

  // Returns what the footer says now: a line said or a question asked, the keys for the row
  // while your typing goes to the sidebar, or while it goes to an agent which one it is, the keys
  // you need most and what Esc stops.
  const footerText = () => {
    if (closing) return closingText(closing).footer;
    if (replying) return replyLine(replying);
    if (item !== null && !said && !asking) return itemFooter(rows[here]) ?? "";
    if (empty) return "q/⌥Q quit";
    if (said ?? asking) return said ?? asking?.question.ask ?? "";
    const row = rows[here];
    if (!typingRight && row) return sidebarFooter(row, restartOf(row) !== null);
    const name = shown === open.lead ? "lead" : (row?.name ?? "");
    return agentFooter(name, harnessOf(about()));
  };

  // Draws the sidebar, the notice above the rest, only when it changed. Every line fills the
  // pane, and its last column is left blank, so text never touches the box's line.
  const draw = () => {
    const { width, height } = size();
    const headings = sectionHeadings(all, opened, builders);
    const room = Math.max(width - 1, 1);
    const keys = narrow && !typingRight ? keyLines(lastFooter, room) : [];
    const rowsHeight = Math.max(height - 1 - keys.length, 1);
    const onRow = rows[here];
    const read =
      narrow && item !== null && onRow?.ask ? drawItem(onRow, here, room, rowsHeight, item) : null;
    if (narrow || !onRow?.ask) item = read?.scroll ?? null;
    const drawn = closing
      ? { lines: questionLines(closingText(closing).lines, room), targets: [], top, spins: [] }
      : read
        ? { lines: read.lines, targets: read.targets, top, spins: [] }
        : drawRows(rows, headings, here, top, room, rowsHeight, spinning);
    top = drawn.top;
    spins = drawn.spins.map((spin) => ({ ...spin, line: notice.length + 1 + spin.line }));
    targets = [...notice.map((): Target => null), null, ...drawn.targets];
    const below = Math.max(rowsHeight - drawn.lines.length, 0);
    const padded = closing || keys.length > 0;
    const shownLines = padded ? [...drawn.lines, ...Array<string>(below).fill("")] : drawn.lines;
    const lines = ["", ...shownLines, ...keys].map((line) => filled(line, width));
    const frame = [...notice, ...lines].join("\n");
    if (frame === lastFrame) return;
    lastFrame = frame;
    doing("drawing the sidebar", () =>
      process.stdout.write(`\x1b[H${frame.replaceAll("\n", "\r\n")}`),
    );
    drawSpinners();
  };
  // Draws each spinner's cell alone, at the frame it is on, so turning one rewrites nothing else.
  const drawSpinners = () => {
    const shown = spinner.charAt(turn % spinner.length);
    const cells = spins.map(
      ({ line, column, cell }) =>
        `\x1b[${line + 1};${column + 1}H${cell.replace(spinner.charAt(0), shown)}`,
    );
    if (cells.length > 0) doing("turning the spinners", () => process.stdout.write(cells.join("")));
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
    // A repository you closed or removed, or whose lead you exited, has no tab left. The sidebar
    // moves to the tab that took its place, or the one before when it was last. With no tab
    // left, the screen says how to open a repository, until a tab comes back, such as one you
    // open from another terminal.
    const at = before.findIndex((tab) => tab.fullName === `${open.owner}/${open.repo}`);
    if (empty || !tabs.some((tab) => tab.fullName === `${open.owner}/${open.repo}`)) {
      const next = tabs[Math.min(Math.max(at, 0), tabs.length - 1)];
      if (next) switchTo(next.fullName);
      else if (!empty) showEmpty();
    }
    // Your typing goes to the right side while its pane is the active one, such as on the lead's
    // row or once you attached to a builder, and to the sidebar otherwise. It is asked before
    // anything is drawn, as the top rows and the footer show it.
    // Whether the right side fills the terminal, after Shift-Enter or a, is asked with it, and
    // when a dropped file was last on another machine, and this machine's name for sc --remote.
    const format = `#{pane_active} #{window_zoomed_flag} #{window_width} #{${dropNoticeOption}}`;
    const [active, zoomed, across, droppedAt = "0", machine = ""] = doing(
      "asking tmux where your typing goes",
      () => screenTmux(agents, ["display", "-p", "-t", rightPane, format]).out.trim().split(" "),
    );
    typingRight = active === "1";
    const fullScreen = zoomed === "1";
    const windowWidth = Number(across);
    narrow = windowWidth < narrowBelow;
    notice = noticeLines(updateNotice(db), size().width);
    // A repository Skelcrew no longer has has no rows, until the sidebar moves off it.
    all = doing("reading the rows", () => {
      if (empty) return [];
      try {
        return listRows(db, open, Date.now());
      } catch {
        return [];
      }
    });
    builders = doing("reading how full the builders are", () => {
      if (empty) return null;
      try {
        return buildersNote(db, open);
      } catch {
        return null;
      }
    });
    reshow();
    // An agent can end and its client move to the lead by itself, so the session shown is asked
    // of tmux, unless details show. With no client on the right while the lead isn't running,
    // the right side is waiting for the lead, such as after a builder ended while its lead was
    // gone, so the lead is what it shows. The sidebar then moves to the lead's row with it, unless
    // it is on the lead's item about the repository, which shows the lead too.
    if (!isDetails(shown) && !empty) {
      const client = doing("asking tmux which agent shows", () => shownSession(agents, tty));
      if (client) shown = client;
      else if (!running.includes(open.lead)) shown = open.lead;
      const onLead = rows[here]?.part === "lead" || rows[here]?.part === "ask";
      if (shown === open.lead && !onLead) here = 0;
    }
    // A lead that moved to or from a plugin's host, or to another session on it, is shown
    // through its host now, once the right side shows the lead. This comes once the sidebar knows
    // what the right side shows, as at the first look it doesn't yet.
    leadAttach = doing("reading the lead's host", () => leadOnHost(db, open));
    if (shown === open.lead && paneLead !== leadAttach && !empty) {
      respawnPane(agents, rightPane, paneOn(open.lead));
      tty = paneTty(agents, rightPane);
      paneLead = leadAttach;
    }
    // A lead that crashed while you look at it is brought back with its conversation, once,
    // as the daemon does at its start. One you exited closes its tab instead.
    if (running.includes(open.lead)) asked = null;
    else if (shown === open.lead && asked !== open.lead && !exited && !empty) {
      asked = open.lead;
      openRepository(`${open.owner}/${open.repo}`, true);
    }
    // The header and the top of the boxes go to tmux's status lines, and only when they changed.
    // A right side that fills the terminal is as wide as it, so the rows keep the sidebar's places
    // and the tabs take what is left.
    const sidebar = narrow ? sidebarFor(windowWidth) - 2 : size().width;
    const right = fullScreen
      ? windowWidth - sidebar - 5
      : doing("asking tmux the agent's width", () => paneWidth(agents, rightPane));
    const name = shown === open.lead ? "lead" : (rows[here]?.name ?? "");
    const look = {
      tabs,
      open: empty ? "" : `${open.owner}/${open.repo}`,
      where,
      versions: versionLabels(),
      typingRight,
      fullScreen,
      side: narrow ? (typingRight ? name : "sidebar") : "",
      elsewhere: Date.now() - Number(droppedAt) < dropNoticeFor ? machine : null,
    };
    const top = drawTop(look, { sidebar, right });
    const topText = [top.header, top.boxes, ...top.below].join("\n");
    if (topText !== lastTop) {
      lastTop = topText;
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
    if (fullName === `${open.owner}/${open.repo}` && !empty) return;
    empty = false;
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

  // Leaves the screen on its empty state once no tab is left: no rows, and on the right how to
  // open a repository, printed as given and never run. Your typing stays in the sidebar, as the
  // right side has nothing to type to, and Alt-Q still leaves.
  const showEmpty = () => {
    empty = true;
    all = [];
    rows = [];
    here = 0;
    asking = null;
    const say = 'printf "\\n %s\\n" "$1"; exec cat >/dev/null';
    respawnPane(agents, rightPane, ["sh", "-c", say, "sh", emptyText]);
    tty = paneTty(agents, rightPane);
    shown = null;
    held = true;
    screenTmux(agents, ["select-pane", "-t", `=${session}:.${panes.sidebar}`]);
  };

  // Asks whether to close or remove the open repository, from Alt-W anywhere or w in the sidebar.
  // The question takes your typing, leaving full screen if an agent had it, and keeps where your
  // typing was, so Esc can put it back. tmux shows every pane again once the sidebar's is selected.
  const askToClose = () => {
    const tab = tabs.find((one) => one.fullName === `${open.owner}/${open.repo}`);
    if (empty || !tab) return;
    const asked = (format: string) =>
      screenTmux(agents, ["display", "-p", "-t", rightPane, format]).out.trim() === "1";
    const back = { right: asked("#{pane_active}"), zoomed: asked("#{window_zoomed_flag}"), held };
    closing = { step: "choose", name: tab.name, fullName: tab.fullName, said: "", back };
    held = true;
    screenTmux(agents, ["select-pane", "-t", `=${session}:.${panes.sidebar}`]);
  };
  // Ends the close key's question, and gives your typing back to where it was before it, the
  // agent's full screen included.
  const goBack = () => {
    const back = closing?.back;
    closing = null;
    if (!back) return;
    held = back.held;
    if (!back.right) return;
    screenTmux(agents, ["select-pane", "-t", rightPane]);
    if (back.zoomed) screenTmux(agents, zoomIn(rightPane));
  };
  // Closes or removes the repository the question is about once you said y, as sc repo rm does
  // for a removal, which refuses the same way. The screen moves to the next tab as the closed one
  // goes. A refusal shows in place of the question until the next key.
  const closeOrRemove = async (question: Closing, remove: boolean) => {
    working = true;
    question.step = "working";
    question.said = remove ? `Removing ${question.name}…` : `Closing ${question.name}'s tab…`;
    refresh();
    try {
      said = await (remove ? removeRepo : closeRepo)(question.fullName, agents);
      closing = null;
      held = question.back.held;
      if (!held && !empty) screenTmux(agents, ["select-pane", "-t", rightPane]);
    } catch (error) {
      question.step = "refused";
      question.said = errorText(error);
    }
    working = false;
    refresh();
  };
  // Acts on a key while the close key's question is open, and takes every key but a switch, so
  // none moves or opens anything under it. c or r choose, y says yes to the choice, and n or Esc go
  // back. Any key goes back from a refusal.
  const answerClosing = (question: Closing, name: string) => {
    if (question.step === "refused") return goBack();
    if (name === "esc") return goBack();
    if (question.step === "choose" && (name === "c" || name === "r"))
      question.step = name === "c" ? "close" : "remove";
    else if (question.step !== "choose" && name === "n") goBack();
    else if (question.step !== "choose" && name === "y")
      void closeOrRemove(question, question.step === "remove");
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
  // Opens or closes a section. Needs you never closes, as it is where you must look. Opening one
  // moves you to its first row, so its heading and first rows show. Closing the one you are in
  // moves you to its heading, as your row hides.
  const toggle = (section: Section) => {
    if (section === "needs you") return;
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

  // Takes your answer to the lead's item on a row to the daemon, which tells the lead, and says
  // what the daemon answered, or why it refused, such as for an item the lead replaced meanwhile.
  const answerRow = async (
    row: Row,
    given: { pick: Exclude<Pick, "reply"> } | { reply: string },
  ) => {
    if (!row.ask) return;
    working = true;
    item = null;
    try {
      said = await answerItem(`${open.owner}/${open.repo}`, row.task, row.ask, given);
    } catch (error) {
      said = errorText(error);
    }
    working = false;
    refresh();
  };
  // Acts on what a key or a tap on an item's line picks: an option, which answers it, or a reply,
  // which you then type. An option of Skelcrew's own item does what it says, as picked says, and
  // opening the builder attaches once the daemon told the lead.
  const pickOn = (row: Row, pick: Pick) => {
    const does = picked(row, pick, `${open.owner}/${open.repo}`);
    if (does === null) return;
    if (does === "reply") replying = { row, text: "" };
    else if ("open" in does)
      void startOrMerge(does.open.request).then(
        () => {
          item = null;
          attachBuilder(row);
        },
        (error) => {
          item = null;
          said = errorText(error);
          refresh();
        },
      );
    else {
      item = null;
      if ("refused" in does) said = does.refused;
      else if ("answer" in does) void answerRow(row, { pick: does.answer });
      else if ("run" in does) void goAhead(does.run);
      else asking = { question: does.confirm, row: row.name, offer: "pick" };
    }
  };
  // Asks whether to merge a task ready for review, as m does, or says why it can't.
  const mergeRow = (row: Row) => {
    if (row.merge && "refused" in row.merge) said = row.merge.refused;
    else if (row.merge) asking = { question: row.merge, row: row.name, offer: "merge" };
    else said = openPr(db, open, row, canOpen, (text) => process.stdout.write(text));
  };
  // Acts on a key while you type a reply, which takes every key but a switch.
  const typeInReply = (reply: Reply, key: string) => {
    const typed = typeReply(reply, key);
    replying = typeof typed === "string" ? null : typed;
    if (typed === "send") void answerRow(reply.row, { reply: reply.text });
  };

  // Moves the queued task you are on one place earlier, by -1, or later, by 1, as in the list.
  // You stay on its row, and the footer says its place. A paused task has no place until sc start
  // queues it, so the footer says that instead.
  const reorder = async (row: Row, by: -1 | 1) => {
    if (row.task === null || row.section !== "task queue") return;
    if (row.place === null) {
      said = `${row.name} is paused: sc start ${row.name} brings it back`;
      return;
    }
    working = true;
    try {
      said = await moveQueued(`${open.owner}/${open.repo}`, typedTask(row.task), by);
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
    if (narrow) said = reason;
  };

  const enter = (zoom = false) => {
    const row = rows[here];
    if (!row) return;
    if (zoom && !enterAttaches(row)) return;
    if (row.ask && item === null && !zoom) {
      item = 0;
      return;
    }
    item = null;
    if (row.part === "lead" || row.part === "ask") return toRight(zoom);
    if (row.part === "heading" && row.section !== "lead") return toggle(row.section);
    if (row.more > 0) {
      wholeBacklog = true;
      return reshow();
    }
    if (row.part === "backlog" && row.start) {
      asking = { question: row.start, row: row.name, offer: "start" };
      return;
    }
    if (row.section === "task queue") {
      said = row.waits;
      return;
    }
    const atWork = row.part !== "ready" && row.part !== "done";
    if ((atWork || row.needsYou) && row.session) return attachBuilder(row, zoom);
    said = openPr(db, open, row, canOpen, (text) => process.stdout.write(text));
  };
  // Attaches to the builder of `row`, beside the sidebar or, with `zoom`, full screen.
  const attachBuilder = (row: Row, zoom = false) => {
    const repository = `${open.owner}/${open.repo}`;
    held = false;
    const takeTyping = () => !held;
    void attachTask(agents, session, repository, row.name, takeTyping, zoom).then((failed) => {
      if (failed !== null) refuse(row.name, failed);
      refresh();
    });
  };

  // Acts on a press of the mouse at a column and line, counted from 1. A left click anywhere
  // brings your typing to the sidebar, as Ctrl-\ does. A click on a task's row
  // moves to it, which shows its details, and a click on the row you are on opens it as Enter does.
  // A click on the lead's row opens the lead at once. A click on a stage's heading, or its name
  // pinned at an edge, opens or closes it. The wheel moves one row up or down. On an item open
  // full-size, the wheel scrolls it a line, and a tap on its ↑ more or ↓ more a page.
  const click = (button: string, column: number, line: number) => {
    if ((button === "64" || button === "65") && item !== null) {
      if (!narrow) {
        screenTmux(agents, ["send-keys", "-t", rightPane, button === "64" ? "Up" : "Down"]);
        return;
      }
      item += button === "64" ? -1 : 1;
      return;
    }
    if (button === "64") return moveTo(here - 1);
    if (button === "65") return moveTo(here + 1);
    if (button !== "0") return;
    toSidebar();
    const target = targets[line - 1] ?? null;
    if (target === null) return;
    if ("section" in target) return toggle(target.section);
    if ("pinned" in target) {
      const pinned = target.pinned.find((span) => span.from <= column && column <= span.to);
      return pinned && toggle(pinned.section);
    }
    if ("scroll" in target) {
      if (item !== null) item += target.scroll;
      return;
    }
    const tapped = rows[target.row];
    if (target.pick && tapped)
      return target.row === here ? pickOn(tapped, target.pick) : moveTo(target.row);
    if (target.row !== here && tapped?.part !== "lead") return moveTo(target.row);
    moveTo(target.row);
    enter();
  };

  const press = (key: string) => {
    if (key === dropAsk) return answerDrop();
    const name = keyNames[key] ?? key;
    if (name === "switch") return switchTyping();
    if (working) return;
    if (closing) return answerClosing(closing, name);
    if (replying) return typeInReply(replying, name === "enter" || name === "esc" ? name : key);
    if (item !== null && !asking) {
      const by = { up: -1, down: 1, "page up": -10, "page down": 10 }[name];
      if (by !== undefined) {
        if (!narrow) {
          screenTmux(agents, [
            "send-keys",
            "-t",
            rightPane,
            name === "up" ? "Up" : name === "down" ? "Down" : by < 0 ? "PPage" : "NPage",
          ]);
          return;
        }
        item += by;
        return;
      }
      if (name === "esc") {
        item = null;
        return;
      }
    }
    if (name === "close") return askToClose();
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
      if (action.question.request.command === "restart") return void goAhead(action.question);
      const offer = stillOffered(action, all);
      if (typeof offer === "string") said = offer;
      else void goAhead(offer);
      return;
    }
    if (key === "q") {
      screenTmux(agents, ["kill-session", "-t", `=${session}`]);
      return;
    }
    said = null;
    if (!altPattern.test(key)) held = true;
    const row = rows[here];
    const visible =
      !narrow && item !== null && row?.ask && /^[a-dr]$/.test(key)
        ? screenTmux(agents, ["capture-pane", "-p", "-t", rightPane]).out.split("\n")
        : [];
    const pick = itemKey(row, here, targets, key, visible);
    if (pick && row) return pickOn(row, pick);
    if (name === "up" || name === "down") return moveTo(here + (name === "up" ? -1 : 1));
    if ((name === "earlier" || name === "later") && row)
      return void reorder(row, name === "earlier" ? -1 : 1);
    if (name === "previous section" || name === "next section")
      return jump(name === "next section" ? 1 : -1);
    if (name === "next repository" || name === "previous repository")
      return nextRepository(name === "next repository" ? 1 : -1);
    if (key.startsWith(`${esc}]skel-tab;`)) {
      const range = key.slice(`${esc}]skel-tab;`.length, -1);
      const tab = /^\d+$/.test(range) ? tabs[Number(range)] : undefined;
      if (tab) switchTo(tab.fullName);
      if (range === sidebarRange) endAttachment();
      return refresh();
    }
    if (button && column && line) return click(button, Number(column), Number(line));
    const bare = key.startsWith(esc) ? key.slice(1) : key;
    const section = /^\d$/.test(bare) ? numbered[Number(bare)] : undefined;
    if (section) return toggle(section);
    if (name === "enter" || name === "full screen") return enter(name === "full screen");
    if ((name === "page up" || name === "page down") && row?.task && isDetails(shown)) {
      screenTmux(agents, ["send-keys", "-t", rightPane, name === "page up" ? "PPage" : "NPage"]);
      return;
    }
    if (key === "R" && row && restartOf(row)) {
      const question = restartOf(row);
      if (question) asking = { question, row: row.name, offer: "start" };
    } else if (key === "s" && row?.part === "backlog" && row.start)
      asking = { question: row.start, row: row.name, offer: "start" };
    else if (key === "f" && row?.startNow)
      asking = { question: row.startNow, row: row.name, offer: "startNow" };
    else if (key === "m" && row?.merge) {
      mergeRow(row);
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
  // Acts on each key and click in `text`, but none inside a paste, which goes into a reply you are
  // typing and is skipped otherwise.
  const act = (text: string) => {
    for (const [key] of text.matchAll(keyPattern)) {
      if (key === "\x1b[200~" || key === "\x1b[201~") pasting = key === "\x1b[200~";
      else if (!pasting) doing("acting on a key", () => press(key));
      else if (replying) typeInReply(replying, key);
    }
  };
  // A sequence a read ends inside, such as a paste's start or end cut in two, waits for its rest
  // in the next read, however late, so it is still seen whole. A lone Esc waits too, as the
  // sidebar has no use for it: when what comes next doesn't go on with [, the Esc was a key of its
  // own, and is taken apart from it, so Esc then a stays two keys rather than Alt-a. Only the
  // close key's question, a reply you type and an item you opened take Esc, to go back, so while
  // one is open a lone Esc also acts once nothing followed it for a moment longer than tmux waits. It stays cut all the same, so a
  // paste whose rest comes late is still skipped whole, and isn't acted on again.
  let cut = "";
  let lone: ReturnType<typeof setTimeout> | undefined;
  let actedOn = false;
  // Acts on each key and click that came together, then redraws.
  process.stdin.on("data", (bytes) => {
    clearTimeout(lone);
    let text = bytes.toString();
    if (cut === esc && !text.startsWith("[")) {
      if (!actedOn) act(cut);
    } else text = cut + text;
    actedOn = false;
    cut = unfinished("", text);
    act(text.slice(0, text.length - cut.length));
    if (cut === esc && (closing || replying || item !== null))
      lone = setTimeout(() => {
        actedOn = true;
        act(esc);
        refresh();
      }, escapeTime * 5);
    refresh();
  });
  // Draws now, on each resize and each second, until the pane goes and its input closes.
  process.on("SIGWINCH", refresh);
  refresh();
  setInterval(refresh, 1000);
  if (spinning)
    setInterval(() => {
      turn++;
      drawSpinners();
    }, 250);
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}

// Returns the lines of the close key's question for a sidebar `room` columns wide: each paragraph
// cut at words, two columns in, with a blank line between paragraphs.
function questionLines(paragraphs: string[], room: number): string[] {
  const width = Math.max(room - 2 * pad.length, 10);
  return paragraphs.flatMap((text, at) => [
    ...(at > 0 ? [""] : []),
    ...Bun.wrapAnsi(removeControlCodes(text), width, { hard: true })
      .split("\n")
      .map((line) => `${pad}${line}`),
  ]);
}

function keyLines(keys: string, room: number): string[] {
  const width = Math.max(room - pad.length, 1);
  const lines: string[] = [];
  for (const group of keys.split("  ").filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && Bun.stringWidth(`${last}  ${group}`) <= width)
      lines[lines.length - 1] = `${last}  ${group}`;
    else lines.push(group);
  }
  return lines.map((line) => paint(grey, `${pad}${line}`));
}

// How long, in milliseconds, the notice that a dropped file is on another machine shows.
const dropNoticeFor = 30_000;

// Returns the lines that go above the rest of the sidebar for a notice, such as a release installed
// in the background, or none without one. Cut at words to fit a sidebar `width` columns wide, and
// parted from what follows by a blank line. Each fills the pane.
function noticeLines(notice: string, width: number): string[] {
  if (!notice) return [];
  const room = Math.max(width - 2 * pad.length, 1);
  // A word goes on the last line while it fits, and starts a new one when it doesn't. A word
  // longer than a whole line has one to itself.
  const lines = [""];
  for (const word of notice.split(" ")) {
    const last = lines.length - 1;
    const longer = lines[last] ? `${lines[last]} ${word}` : word;
    if (Bun.stringWidth(longer) <= room || !lines[last]) lines[last] = longer;
    else lines.push(word);
  }
  // Each line is padded, and a blank one follows.
  return [...lines.map((line) => `${pad}${line}`), ""].map((line) => filled(line, width));
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
