// The live sc --list picker: Needs you and tasks by stage, beside their details.
// Its keys answer items, attach to agents, and start or merge tasks.
import { cpus } from "node:os";
import { attachSession, typeKeys } from "../agents/sessions.ts";
import { answerItem, moveQueued, openRepository, startOrMerge } from "../client.ts";
import { openDb } from "../db.ts";
import { leadSession } from "../flow/lead.ts";
import { builderSession, readThread, typedTask } from "../flow/thread.ts";
import { errorText } from "../format.ts";
import { updateNotice } from "../machine/update.ts";
import { attachOnHost, type Host } from "../plugins/runtime.ts";
import { cpuBusy, cpuSample, loadText, memoryInUse, readMemory } from "../screen/load.ts";
import { grey, paint, removeControlCodes } from "../screen/look.ts";
import { versionLabels } from "../version.ts";
import {
  type Asking,
  askingInBox,
  canOpenLinks,
  itemFooter,
  itemKey,
  openPr,
  picked,
  type Reply,
  replyLine,
  stillOffered,
  typeReply,
} from "./actions.ts";
import { type Details, readDetails } from "./details.ts";
import {
  drawList,
  type Frame,
  keysFor,
  type Pick,
  paneEdge,
  paneWidth,
  type Target,
  tabAt,
} from "./layout.ts";
import { liveNote, readLive } from "./live.ts";
import { drawPane, type Live } from "./pane.ts";
import {
  buildersNote,
  listRows,
  numbered,
  type Open,
  type Question,
  type Row,
  repositoryTabs,
  type Section,
  sectionHeadings,
  sections,
  shownRows,
} from "./rows.ts";

// The keys the list reads, as your terminal sends them. Arrows come in either of the two forms a
// terminal may use, and Ctrl-C leaves as q does, since the terminal is raw. Esc leaves too, but
// first closes a question that is open. Any other escape sequence is one key, which does
// nothing. A terminal sends one for a key with Ctrl or Alt when a program asked it for extended
// keys, such as Ctrl-\ as ESC[92;5u, and neither its Esc nor its letters may act as keys of
// their own. Pressing Ctrl-\ once too often after coming back from an agent lands here too, in
// one of its three forms, and does nothing. Alt with a letter is matched whole, or its Esc or
// its q would quit. Alt-Shift-Left moves to the previous repository, and Alt-Shift-Right to the
// next, plain and with kitty's press event, which it adds when asked for events. Kitty
// sends the main arrows so even in its CSI-u mode, and its keypad arrows as CSI-u, 57417 left
// and 57418 right. Shift-Up and Shift-Down move a queued task in its queue, plain and with kitty's
// press event.
const keyNames: Record<string, string> = {
  "\x1b[1;2A": "earlier",
  "\x1b[1;2:1A": "earlier",
  "\x1b[1;2B": "later",
  "\x1b[1;2:1B": "later",
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\r": "enter",
  "\n": "enter",
  "\x1b[1;4C": "next repository",
  "\x1b[1;4:1C": "next repository",
  "\x1b[57418;4u": "next repository",
  "\x1b[57418;4:1u": "next repository",
  "\x1b[1;4D": "previous repository",
  "\x1b[1;4:1D": "previous repository",
  "\x1b[57417;4u": "previous repository",
  "\x1b[57417;4:1u": "previous repository",
  "\x1b[5~": "page up",
  "\x1b[6~": "page down",
  "\x03": "q",
  "\x1b": "escape",
};
const esc = "\x1b";
// A click comes as your terminal reports the mouse, with its button, column and row. Its
// sequence is a CSI one, so it reaches the list as one key.
const clickPattern = new RegExp(`^${esc}\\[<(\\d+);(\\d+);(\\d+)M$`);
// Splits what the terminal sent into keys. Every escape sequence is one key, read or not, as
// its Esc alone would leave the list. That covers keys such as Right, Home, F5 or Alt-x, and
// the answers a terminal sends to tmux's questions, which reach the list once you leave an
// agent. In order: a terminal's string ended by ST or BEL, a CSI sequence, an SS3 one, Alt
// with a key, then any single character, a lone Esc included.
const keyPattern = new RegExp(
  [
    `${esc}[P\\]X^_][\\s\\S]*?(?:${esc}\\\\|\\x07)`,
    `${esc}\\[[0-?]*[ -/]*[@-~]`,
    `${esc}O[\\s\\S]`,
    `${esc}[^${esc}]`,
    "[\\s\\S]",
  ].join("|"),
  "g",
);
// The start of an escape sequence at the end of a read, whose end may come in the next one: an
// Esc, a CSI or SS3 sequence short of its last character, or a terminal's string short of its ST
// or BEL.
const endOfSequence = new RegExp(
  `${esc}(?:\\[[0-?]*[ -/]*|O|[P\\]X^_](?:[^${esc}\\x07]|${esc}(?!\\\\))*)?$`,
);
// Any mouse report in SGR, a press with M or a release with m, which only the list reads.
const mousePattern = new RegExp(`^${esc}\\[<\\d+;\\d+;\\d+[Mm]$`);
// Ctrl-\ as a terminal sends it: one byte, or as an extended key in the kitty or the xterm form.
const back = new Set(["\x1c", "\x1b[92;5u", "\x1b[27;5;92~"]);

// Runs the list in your terminal for the repository named by its owner/name, until you press q,
// then says your agents keep running. `agents` is the sessions' tmux server. It looks again each
// second, and writes only when what shows changed, as over a slow link each write costs. In a
// terminal wide enough, the details pane beside the list shows the row you are on, and reads its
// agent's screen several times a second for its live view. The load at the end of the bottom line
// is read every 5 seconds. Tests pin it with SKELCREW_FIXED_LOAD, which Skelcrew itself never sets,
// so a quiet list writes nothing at all.
export async function runList(agents: string, repository: string): Promise<void> {
  const db = openDb();
  const where = process.env.SKELCREW_REMOTE_NAME ?? "";
  const [owner = "", repo = ""] = repository.split("/");
  let open: Open = { owner, repo };
  // What the list keeps between draws: every row, those that show, which are the lead's and those
  // of the open sections, the row you are on among those and how far it scrolled, the line at the
  // bottom when it says something other than the keys, the question it asks, and whether the daemon
  // is at work on an answer. Needs you is always open, and the task queue, Building, Reviewing and
  // Checks are open at first, as that is where the work under way is, and what starts next. The
  // sections you open or close stay so until you leave the list, whichever repository you move to,
  // and so does a whole Backlog once you asked for it, which shows its newest issues until then.
  let all: Row[] = [];
  let rows: Row[] = [];
  // What Task queue's heading says of the builders, read with the rows.
  let builders: ReturnType<typeof buildersNote> = null;
  const opened = new Set<Section>(["needs you", "task queue", "building", "reviewing", "checks"]);
  let wholeBacklog = false;
  const showing = () => askingInBox(shownRows(all, opened, wholeBacklog), asking);
  let here = -1;
  let top = 0;
  // What a click on each line of the screen reaches, as it was last drawn.
  let targets: Target[] = [];
  let said: string | null = null;
  // The open question, with the row it is about and whether it is a merge or a start.
  let asking: Asking | null = null;
  let working = false;
  let attached = false;
  // The reply you are typing to the lead's item on a row, which takes every key until it is sent
  // or dropped, and how far the item you opened full-size with Enter is scrolled, or null.
  let replying: Reply | null = null;
  let item: number | null = null;
  // The details of the row you are on, by its name, read again with the rows each second, and
  // the last screen read of its agent, by the name of the row it was read for.
  let details: { name: string; read: Details | null } | null = null;
  let live: { name: string; shown: Live } | null = null;
  // Whether the details pane shows its agent's whole screen, rather than its last few lines.
  let fullOutput = false;
  // How far the details pane's details are scrolled, and how many lines of them it last had room
  // for. Another row starts at its top.
  let paneScroll = 0;
  let paneRoom = 0;
  // How many times the row you are on changed, and the row it last was, so a read of the live
  // view knows when you moved while it waited, though you came back to the same row since.
  let selections = 0;
  let selected: string | undefined;
  let lastFrame = "";
  // Keys your terminal sent that the list hasn't acted on yet, oldest first, and the start of an
  // escape sequence whose end hasn't come yet.
  const typed: { sent: string; read: number }[] = [];
  let reads = 0;
  let partial = "";
  const fixed = process.env.SKELCREW_FIXED_LOAD;
  let load = fixed ? paint(grey, removeControlCodes(fixed)) : "";
  let sample = cpuSample(cpus());
  const canOpen = canOpenLinks(where);

  // Returns what the list shows around its rows, with this bottom line and load.
  const frameWith = (bottom: (tabs: number) => string, shownLoad: string): Frame => {
    const tabs = repositoryTabs(db, open);
    const name = tabs.find((tab) => tab.fullName === `${open.owner}/${open.repo}`)?.name ?? "";
    const notice = updateNotice(db);
    return {
      versions: versionLabels(),
      where,
      name,
      tabs,
      notice,
      bottom: bottom(tabs.length),
      load: shownLoad,
    };
  };

  const paneFor = (size: { width: number; height: number }) => {
    const beside = paneWidth(size.width);
    if (beside === 0) return null;
    const row = rows[here];
    if (!row || row.task === null) {
      const pane = drawPane(row, null, null, beside, size.height - 2, false, paneScroll);
      paneScroll = pane.scroll;
      paneRoom = pane.room;
      return pane;
    }
    if (details?.name !== row.name)
      details = { name: row.name, read: readDetails(db, open, row.task, Date.now(), row.changed) };
    const note = liveNote(row);
    const shown = note !== null ? { note } : live?.name === row.name ? live.shown : { screen: "" };
    const pane = drawPane(
      row,
      details.read,
      shown,
      beside,
      size.height - 2,
      fullOutput,
      paneScroll,
    );
    paneScroll = pane.scroll;
    paneRoom = pane.room;
    return pane;
  };

  // Draws what shows, filling the terminal, only when it changed.
  const draw = () => {
    // Every move to another row draws, so the selection is counted here, whatever moved it.
    if (rows[here]?.name !== selected) {
      selected = rows[here]?.name;
      selections++;
      paneScroll = 0;
    }
    if (attached) return;
    // What the bottom line says can come from outside, such as a forge's reason for refusing a
    // merge, so its control codes never reach your terminal.
    const bottom = (tabs: number) =>
      removeControlCodes(
        said ??
          (replying && replyLine(replying)) ??
          asking?.question.ask ??
          (item !== null ? itemFooter(rows[here]) : null) ??
          keysFor(rows[here], tabs, paneWidth(process.stdout.columns || 80) > 0),
      );
    const size = { width: process.stdout.columns || 80, height: process.stdout.rows || 24 };
    const drawn = drawList(
      rows,
      sectionHeadings(all, opened, builders),
      here,
      top,
      frameWith(bottom, load),
      size,
      paneFor(size)?.lines ?? null,
      item,
    );
    top = drawn.top;
    item = drawn.item;
    targets = drawn.targets;
    const text = `\x1b[H${drawn.lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
    if (text === lastFrame) return;
    lastFrame = text;
    process.stdout.write(text);
  };

  // Shows the rows of the open sections again, keeping you on the same row by its name, or at
  // the same place when it went. So a task that starts or stops needing you moves between Needs
  // you and its stage with you still on it: a section it moves into that is closed opens, as
  // otherwise its row would leave the list under you. The first time, you start on the first
  // task under Needs you, so one Enter reaches it, or else on the lead.
  const reshow = () => {
    const name = rows[here]?.name;
    const before = rows[here]?.section;
    const moved = all.find((row) => row.name === name);
    if (moved && moved.section !== before && moved.section !== "lead") opened.add(moved.section);
    rows = showing();
    const at = name === undefined ? -1 : rows.findIndex((row) => row.name === name);
    const needing = rows.findIndex((row) => row.section === "needs you" && row.part !== "heading");
    if (at >= 0) here = at;
    else if (here < 0) here = Math.max(needing, 0);
    else here = Math.min(here, rows.length - 1);
    draw();
  };

  // Reads the rows again, from the database as it is now.
  const refresh = () => {
    if (attached) return;
    details = null;
    all = listRows(db, open, Date.now());
    builders = buildersNote(db, open);
    reshow();
  };

  // Without a terminal, such as in a pipe, there are no keys to read, so the list is printed once,
  // whole, with every stage open, and without colours, and sc returns.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    rows = listRows(db, open, Date.now());
    // Tall enough for every row at two lines, the most one takes, every heading and the blank
    // line after each, so nothing scrolls out of the print.
    const size = { width: 100, height: rows.length * 2 + sections.length * 2 + 8 };
    const { lines } = drawList(
      rows,
      sectionHeadings(rows, new Set(sections), buildersNote(db, open)),
      -1,
      0,
      frameWith(() => "", ""),
      size,
    );
    const text = lines.map((line) => Bun.stripANSI(line).trimEnd()).join("\n");
    console.log(text.trimEnd());
    return;
  }

  // Says something on the bottom line in place of the keys, until the next key.
  const say = (text: string) => {
    said = text;
    draw();
  };

  // Takes the terminal for the list: the alternate screen, so leaving puts back what was there,
  // no cursor, raw keys, and clicks, which 1000 and 1006 ask your terminal to report, so a click
  // on a repository's tab opens it. Gives it back as it was for an agent or for your shell.
  const takeTerminal = () => {
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
    lastFrame = "";
  };
  const giveBack = () => {
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
    process.stdin.setRawMode(false);
  };

  // Attaches you full screen to an agent's session, and comes back to the list once you leave
  // it, on the same row. The list stops reading keys meanwhile, so every key reaches the agent.
  // Keys you typed after Enter that the list hasn't acted on yet, such as ones that came with
  // Enter in one read, were meant for the agent, so they are typed into it first. An agent on a
  // runtime plugin's host is reached through the host's own attach command, by its ID there.
  // Typing those keys in first takes tmux, so on such a host they are dropped. On tmux, the
  // terminal's title says which agent this is and how to come back, as nothing else on the
  // screen is Skelcrew's. The title you had is saved first and put back after, on terminals
  // that keep one. Mouse reports among those keys are the list's, such as the rest of the click
  // that attached, and would reach the agent's prompt as text, so they are dropped, and so is the
  // start of one cut off at the end of a read.
  const attach = async (session: string, name: string, host: Host = agents) => {
    attached = true;
    process.stdin.pause();
    const rest = partial.startsWith(`${esc}[<`) ? "" : partial;
    const after =
      typed
        .splice(0)
        .filter((key) => !mousePattern.test(key.sent))
        .map((key) => key.sent)
        .join("") + rest;
    partial = "";
    if (after && typeof host === "string") typeKeys(host, session, after);
    giveBack();
    let failed: string | null = null;
    if (typeof host === "string") {
      const title = removeControlCodes(`${name} · ctrl+\\ back`);
      process.stdout.write(`\x1b[22;0t\x1b]2;${title}\x07`);
      failed = await attachSession(host, session);
      process.stdout.write("\x1b[23;0t");
    } else attachOnHost(host, session);
    takeTerminal();
    process.stdin.resume();
    attached = false;
    if (failed) said = failed;
    refresh();
  };

  // Has the daemon start or merge once you said y, saying so meanwhile. The keys come back once
  // it is done, and the list shows the row move as the database changes. A start says what the
  // daemon answered, as a builder can take the last free place while you are asked, and the task
  // then waits in the queue though the question said it would start. When the daemon or the
  // forge refuses, the line says why until the next key.
  const goAhead = async (action: Question) => {
    working = true;
    say(action.working);
    try {
      said = await startOrMerge(action.request);
    } catch (error) {
      said = errorText(error);
    }
    working = false;
    refresh();
  };

  // Takes your answer to the lead's item on a row to the daemon, which tells the lead, and says
  // what the daemon answered, or why it refused, such as for an item the lead replaced meanwhile.
  const answerRow = async (
    row: Row,
    given: { pick: Exclude<Pick, "reply"> } | { reply: string },
  ) => {
    if (!row.ask) return draw();
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
  // Acts on what a key or a click on an item's line picks: an option of the lead's item, which
  // answers it, a reply, which you then type, or an option of Skelcrew's own, which does what it
  // says, as picked says. Opening the builder attaches once the daemon told the lead.
  const pickOn = async (row: Row, pick: Pick) => {
    const does = picked(row, pick, `${open.owner}/${open.repo}`);
    if (does === null) return draw();
    if (does === "reply") {
      replying = { row, text: "" };
      return draw();
    }
    if ("refused" in does) return say(does.refused);
    if ("open" in does) {
      try {
        await startOrMerge(does.open.request);
      } catch (error) {
        item = null;
        return say(errorText(error));
      }
      return openRow(row);
    }
    if ("confirm" in does) {
      asking = { question: does.confirm, row: row.name, offer: "pick" };
      return reshow();
    }
    item = null;
    if ("answer" in does) return answerRow(row, { pick: does.answer });
    return goAhead(does.run);
  };
  // Asks whether to merge a task ready for review, as m does, or says why it can't.
  const mergeRow = (row: Row) => {
    if (row.merge && "refused" in row.merge) return say(row.merge.refused);
    if (row.merge) {
      asking = { question: row.merge, row: row.name, offer: "merge" };
      return draw();
    }
    if (row.part === "ready" && row.needsYou)
      return say(`${row.name}'s builder needs you first: press Enter to reach it`);
    return say(openPr(db, open, row, canOpen, (text) => process.stdout.write(text)));
  };

  const openRow = async (row: Row) => {
    if (row.part === "heading" && row.section !== "lead") return toggleSection(row.section);
    if (row.ask && item === null) {
      item = 0;
      return draw();
    }
    item = null;
    if ((row.part === "lead" && row.session) || row.part === "ask") {
      if (!row.running) say("Starting the lead…");
      const failed = await openRepository(`${open.owner}/${open.repo}`, false);
      said = null;
      if (failed) return say(`The lead didn't start: ${failed}`);
      const lead = await leadSession(db, agents, open.owner, open.repo);
      if (lead === null) return say("The lead's session host isn't installed.");
      return attach(lead.id, row.name, lead.host);
    }
    if (row.more > 0) {
      wholeBacklog = true;
      return reshow();
    }
    if (row.part === "backlog" && row.start) {
      asking = { question: row.start, row: row.name, offer: "start" };
      return draw();
    }
    if (row.section === "task queue") return say(row.waits);
    const atWork = row.part !== "ready" && row.part !== "done";
    if ((atWork || row.needsYou) && row.session) {
      if (!row.running)
        return say(`${row.name}'s builder isn't running: sc start ${row.name} brings it back`);
      try {
        const { host, id } = await builderSession(db, agents, readThread(db, row.session));
        return attach(id, row.name, host);
      } catch (error) {
        return say(errorText(error));
      }
    }
    say(openPr(db, open, row, canOpen, (text) => process.stdout.write(text)));
  };

  // Moves to a repository by its owner/name, and has the daemon start its lead if it never has.
  // Not waited on, so the list draws at once.
  const goTo = (fullName: string) => {
    if (fullName === `${open.owner}/${open.repo}`) return draw();
    const [nextOwner = "", nextRepo = ""] = fullName.split("/");
    open = { owner: nextOwner, repo: nextRepo };
    openRepository(fullName, true).catch(() => {});
    all = [];
    rows = [];
    here = -1;
    top = 0;
    refresh();
  };

  // Moves to the next repository by `by` 1, or the previous by -1, from the last round to the
  // first and from the first back to the last.
  const nextRepository = (by: 1 | -1) => {
    const tabs = repositoryTabs(db, open);
    const at = tabs.findIndex((tab) => tab.fullName === `${open.owner}/${open.repo}`);
    const next = tabs[(at + by + tabs.length) % tabs.length];
    if (tabs.length > 1 && next) goTo(next.fullName);
  };

  // Opens or closes a section, as a stage's number key, Enter on its heading or a click on it
  // does. Opening one moves you to its first row, so the list scrolls to show it, rather than open
  // it out of sight. Closing the one you are in moves you to its heading, as your row hides. Needs
  // you is always open: it has no key, so once closed nothing but a click would bring back what
  // waits, so a click on its heading does nothing.
  const toggleSection = (section: Section) => {
    if (section === "needs you") return draw();
    const inside = rows[here]?.section === section;
    const closing = opened.delete(section);
    if (!closing) opened.add(section);
    reshow();
    const first = rows.findIndex(
      (candidate) => candidate.section === section && (closing || candidate.part !== "heading"),
    );
    if (first >= 0 && (inside || !closing)) here = first;
    return draw();
  };

  // Moves the queued task you are on one place earlier, by -1, or later, by 1, in its queue, as
  // the daemon keeps the queue. You stay on its row, which moves with it once the rows are read
  // again, and the bottom line says its place. A paused task has no place until sc start
  // queues it, so the line says that instead.
  const reorder = async (row: Row, by: -1 | 1) => {
    if (row.task === null || row.section !== "task queue") return draw();
    if (row.place === null)
      return say(`${row.name} is paused: sc start ${row.name} brings it back`);
    working = true;
    try {
      said = await moveQueued(`${open.owner}/${open.repo}`, typedTask(row.task), by);
    } catch (error) {
      said = errorText(error);
    }
    working = false;
    refresh();
  };

  // Moves you one row up, by -1, or down, by 1, staying among the rows. The live view reads the
  // new row's agent at once, rather than at its next look. That read isn't waited on, as a
  // runtime plugin's host can take many seconds to answer, and the keys after it must not wait.
  const move = (by: 1 | -1) => {
    here = Math.min(Math.max(here + by, 0), rows.length - 1);
    draw();
    void look();
  };

  // Scrolls the details pane's details `by` lines, down when more than 0, as far as they go.
  const scrollPane = (by: number) => {
    paneScroll += by;
    draw();
  };

  // Acts on the mouse, by what was drawn where it was pressed. The left button on a repository's
  // tab opens that repository, and on a section's heading, or its name pinned at an edge, opens
  // or closes the section. On a task's row it moves you there, and on the row you are on already
  // it opens it, as Enter does, so a double click opens a row too. The lead's row opens the lead at
  // once. The wheel moves you a row up or down, which scrolls the list, as the row you are on
  // always stays in view. Over the details pane, the wheel scrolls its details 3 lines instead.
  // Another button, or a click on nothing, does nothing.
  const click = (sent: string) => {
    const [, button, column, line] = clickPattern.exec(sent) ?? [];
    const width = process.stdout.columns || 80;
    const beside = paneWidth(width);
    const overPane = beside > 0 && Number(column) > width - 1 - beside - paneEdge.length;
    if ((button === "64" || button === "65") && overPane)
      return scrollPane(button === "64" ? -3 : 3);
    if ((button === "64" || button === "65") && item !== null) {
      if (beside > 0) return scrollPane(button === "64" ? -1 : 1);
      item += button === "64" ? -1 : 1;
      return draw();
    }
    if (button === "64") return move(-1);
    if (button === "65") return move(1);
    if (button !== "0") return draw();
    if (line === "1") {
      const tab = tabAt(
        frameWith(() => "", ""),
        width,
        Number(column),
      );
      return tab ? goTo(tab) : draw();
    }
    if (overPane) return draw();
    const target = targets[Number(line) - 1] ?? null;
    if (target === null) return draw();
    if ("section" in target) return toggleSection(target.section);
    if ("pinned" in target) {
      const at = Number(column);
      const pinned = target.pinned.find((span) => span.from <= at && at <= span.to);
      return pinned ? toggleSection(pinned.section) : draw();
    }
    if ("scroll" in target) {
      if (item !== null) item += target.scroll;
      return draw();
    }
    const row = rows[target.row];
    if (!row) return draw();
    if (target.pick && target.row === here) return pickOn(row, target.pick);
    if (target.row === here || row.part === "lead") {
      here = target.row;
      return openRow(row);
    }
    here = target.row;
    return draw();
  };

  const reading = new Set<string>();
  const look = async () => {
    const row = rows[here];
    if (attached || left || !row || row.task === null || liveNote(row) !== null) return;
    if (reading.has(row.name) || paneWidth(process.stdout.columns || 80) === 0) return;
    reading.add(row.name);
    const asked = selections;
    const wanted = () =>
      !attached && !left && selections === asked && paneWidth(process.stdout.columns || 80) > 0;
    const shown = await readLive(db, agents, row, wanted);
    reading.delete(row.name);
    if (shown === null || !wanted()) return;
    if (live?.name === row.name && Bun.deepEquals(live.shown, shown)) return;
    live = { name: row.name, shown };
    draw();
  };

  // Leaves the list, once the list is ready to leave. `left` says it has.
  let leave: () => void = () => {};
  let left = false;
  const press = async (key: string) => {
    if (working || left || key === "back") return;
    if (replying) {
      const reply = replying;
      const typed = typeReply(reply, key);
      replying = typeof typed === "string" ? null : typed;
      return typed === "send" ? answerRow(reply.row, { reply: reply.text }) : draw();
    }
    if (item !== null && !asking) {
      const by = { up: -1, down: 1, "page up": -10, "page down": 10 }[key];
      if (by !== undefined) {
        if (paneWidth(process.stdout.columns || 80) > 0) return scrollPane(by);
        item += by;
        return draw();
      }
      if (key === "escape") {
        item = null;
        return draw();
      }
    }
    if (key === "q" || (key === "escape" && !asking)) return leave();
    if (asking) {
      const action = asking;
      asking = null;
      if (key !== "y") return reshow();
      if (action.offer === "pick") item = null;
      refresh();
      const offer = stillOffered(action, all);
      return typeof offer === "string" ? say(offer) : goAhead(offer);
    }
    said = null;
    const row = rows[here];
    const beside = paneFor({
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24,
    });
    const pick = itemKey(row, here, targets, key, beside?.picks ?? []);
    if (pick && row) return pickOn(row, pick);
    if (key === "up" || key === "down") return move(key === "up" ? -1 : 1);
    if ((key === "earlier" || key === "later") && row)
      return reorder(row, key === "earlier" ? -1 : 1);
    if (key === "next repository") return nextRepository(1);
    if (key === "previous repository") return nextRepository(-1);
    if (key.startsWith(`${esc}[<`)) return click(key);
    const numberedSection = /^\d$/.test(key) ? numbered[Number(key)] : undefined;
    if (numberedSection) return toggleSection(numberedSection);
    if (key === "enter" && row) return openRow(row);
    if (key === "o" && row?.task && paneWidth(process.stdout.columns || 80) > 0) {
      fullOutput = !fullOutput;
      return draw();
    }
    if ((key === "page up" || key === "page down") && row?.task)
      return scrollPane((key === "page up" ? -1 : 1) * Math.max(paneRoom - 1, 1));
    if (key === "s" && row?.part === "backlog" && row.start) {
      asking = { question: row.start, row: row.name, offer: "start" };
      return draw();
    }
    if (key === "f" && row?.startNow) {
      asking = { question: row.startNow, row: row.name, offer: "startNow" };
      return draw();
    }
    if (key === "m" && row?.merge) return mergeRow(row);
    if (key === "m" && row?.part === "ready" && row.needsYou)
      return say(`${row.name}'s builder needs you first: press Enter to reach it`);
    if (key === "m" && row?.part === "ready") return say(`${row.name} has no PR to merge here`);
    draw();
  };

  takeTerminal();
  refresh();
  // Keys are acted on one after another, as attaching or asking the daemon takes a while and
  // keys typed meanwhile must not race it. They wait in `typed`, as your terminal sent them, with
  // the read each came in, so attaching can hand those after Enter to the agent. Whatever Enter
  // did, and whenever a key asks a question, the rest of its read was typed before you could see
  // it, such as a y that would answer that question, so the list never acts on it.
  let acting = false;
  const act = async () => {
    if (acting) return;
    acting = true;
    while (true) {
      // Once the list has left, nothing more is acted on: a key that came with q, such as
      // Enter, would otherwise attach after the terminal was given back.
      const key = left ? undefined : typed.shift();
      if (key === undefined) break;
      const named = back.has(key.sent) ? "back" : (keyNames[key.sent] ?? key.sent);
      await press(named).catch((error) => say(errorText(error)));
      if (named === "enter" || asking) while (typed[0]?.read === key.read) typed.shift();
    }
    acting = false;
  };
  // An arrow's escape sequence can come in two reads, as over ssh. So a read that ends partway
  // into one keeps that end until the next read completes it. Esc alone looks the same, so what
  // is kept counts as typed once no more comes for a moment, as terminals and editors do.
  let flush: ReturnType<typeof setTimeout> | undefined;
  // A mouse button's release follows its press, often in a read of its own. The press did what a
  // click does, so the release is dropped here: as a key it would answer the question a click
  // just asked, as no.
  const take = (text: string) => {
    reads += 1;
    for (const [sent] of text.matchAll(keyPattern))
      if (!(mousePattern.test(sent) && sent.endsWith("m"))) typed.push({ sent, read: reads });
    void act();
  };
  process.stdin.on("data", (bytes) => {
    clearTimeout(flush);
    const text = partial + bytes.toString();
    partial = text.match(endOfSequence)?.[0] ?? "";
    take(text.slice(0, text.length - partial.length));
    if (partial)
      flush = setTimeout(() => {
        const kept = partial;
        partial = "";
        take(kept);
      }, 100);
  });
  process.on("SIGWINCH", () => {
    lastFrame = "";
    draw();
  });
  const looks = setInterval(refresh, 1000);
  // The live view reads 4 times a second, so the agent's screen looks live, and each read costs
  // only a capture of its screen.
  const watching = setInterval(look, 250);
  // Reads the load every 5 seconds, unless a test pinned it.
  const loads = setInterval(() => {
    if (fixed) return;
    const now = cpuSample(cpus());
    const memory = memoryInUse(readMemory());
    load = loadText(cpuBusy(sample, now), memory.used, memory.total);
    sample = now;
    draw();
  }, 5000);
  await new Promise<void>((done) => {
    leave = () => {
      left = true;
      typed.length = 0;
      done();
    };
    process.stdin.on("close", leave);
  });
  clearInterval(looks);
  clearInterval(loads);
  clearInterval(watching);
  process.stdin.pause();
  giveBack();
  // Plain sc opens the split screen, so the way back to the list names --list.
  console.log("Your agents keep running. Run sc --list to come back.");
}
