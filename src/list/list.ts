// The list: what `sc --list` shows in your terminal. One repository's lead and tasks, by stage, as
// a picker. Enter attaches you full screen to an agent through its session host, and leaving it
// comes back here, on the same row. It also starts an issue, merges a task ready for review and
// opens its PR, each asking first where it can't be taken back. The number keys open and close
// the stages.
import { cpus } from "node:os";
import { attachSession, typeKeys } from "../agents/sessions.ts";
import { openRepository, startOrMerge } from "../client.ts";
import { openDb } from "../db.ts";
import { leadSession } from "../flow/lead.ts";
import { ListStage } from "../flow/stage.ts";
import { builderSession, readThread } from "../flow/thread.ts";
import { updateNotice } from "../machine/update.ts";
import { attachOnHost, type Host } from "../plugins/runtime.ts";
import { errorText } from "../say.ts";
import { cpuBusy, cpuSample, loadText, memoryInUse, readMemory } from "../screen/load.ts";
import { grey, paint, removeControlCodes } from "../screen/look.ts";
import { version } from "../version.ts";
import { type Details, readDetails } from "./details.ts";
import {
  drawList,
  type Frame,
  keysFor,
  paneEdge,
  paneWidth,
  type Target,
  tabAt,
} from "./layout.ts";
import { liveNote, readLive } from "./live.ts";
import { drawPane, type Live } from "./pane.ts";
import {
  cutBacklog,
  hasForge,
  listRows,
  type Open,
  type Question,
  type Row,
  repositoryTabs,
  stageHeadings,
} from "./rows.ts";

// The command that opens a link in your browser.
const openCommand = process.platform === "darwin" ? "open" : "xdg-open";

// The keys the list reads, as your terminal sends them. Arrows come in either of the two forms a
// terminal may use, and Ctrl-C leaves as q does, since the terminal is raw. Esc leaves too, but
// first closes a question that is open. Any other escape sequence is one key, which does
// nothing. A terminal sends one for a key with Ctrl or Alt when a program asked it for extended
// keys, such as Ctrl-\ as ESC[92;5u, and neither its Esc nor its letters may act as keys of
// their own. Pressing Ctrl-\ once too often after coming back from an agent lands here too, in
// one of its three forms, and does nothing. Alt with a letter is matched whole, or its Esc or
// its q would quit. Shift-Tab and Alt-Shift-Left move to the previous repository, and Tab and
// Alt-Shift-Right to the next: Shift-Tab plain, as kitty's CSI-u and as xterm's extended key,
// and the arrows plain and with kitty's press event, which it adds when asked for events. Kitty
// sends the main arrows so even in its CSI-u mode, and its keypad arrows as CSI-u, 57417 left
// and 57418 right.
const keyNames: Record<string, string> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x1b[1;4C": "tab",
  "\x1b[1;4:1C": "tab",
  "\x1b[57418;4u": "tab",
  "\x1b[57418;4:1u": "tab",
  "\x1b[Z": "back tab",
  "\x1b[9;2u": "back tab",
  "\x1b[27;2;9~": "back tab",
  "\x1b[1;4D": "back tab",
  "\x1b[1;4:1D": "back tab",
  "\x1b[57417;4u": "back tab",
  "\x1b[57417;4:1u": "back tab",
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
// then says your agents keep running.
// `agents` is the sessions' tmux server. It looks again each second, and writes only when what
// shows changed, as over a slow link each write costs. In a terminal wide enough, the details pane
// beside the list shows the row you are on, and reads its agent's screen several times a second
// for its live view. The load at the end of the bottom line is read every 5 seconds. Tests pin it with SKELCREW_FIXED_LOAD, which Skelcrew itself never sets,
// so a quiet list writes nothing at all.
export async function runList(agents: string, repository: string): Promise<void> {
  const db = openDb();
  const where = process.env.SKELCREW_REMOTE_NAME ?? "";
  const [owner = "", repo = ""] = repository.split("/");
  let open: Open = { owner, repo };
  // What the list keeps between draws: every row, those that show, which are the lead's and
  // those of the open stages, the row you are on among those and how far it scrolled, the line
  // at the bottom when it says something other than the keys, the question it asks, and whether
  // the daemon is at work on an answer. Only Building is open at first. The stages you open
  // stay open until you leave the list, whichever repository you move to, and so does a whole
  // Backlog once you asked for it, which shows its newest issues until then.
  let all: Row[] = [];
  let rows: Row[] = [];
  const opened = new Set<ListStage>(["building"]);
  let wholeBacklog = false;
  const showing = () =>
    cutBacklog(all, wholeBacklog).filter((row) => row.part === "lead" || opened.has(row.part));
  let here = -1;
  let top = 0;
  // What a click on each line of the screen reaches, as it was last drawn.
  let targets: Target[] = [];
  let said: string | null = null;
  // The open question, with the row it is about and whether it is a merge or a start.
  let asking: { question: Question; row: string; merge: boolean } | null = null;
  let working = false;
  let attached = false;
  // The details of the row you are on, by its name, read again with the rows each second, and
  // the last screen read of its agent, by the name of the row it was read for.
  let details: { name: string; read: Details | null } | null = null;
  let live: { name: string; shown: Live } | null = null;
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
  // Your browser opens a PR only on the machine you sit at. A Linux machine with no display,
  // such as a server you ssh to, has none, so Enter copies the link to your clipboard instead.
  const canOpen =
    where === "" &&
    (process.platform === "darwin" || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY) &&
    Bun.which(openCommand) !== null;

  // Returns what the list shows around its rows, with this bottom line and load.
  const frameWith = (bottom: (tabs: number) => string, shownLoad: string): Frame => {
    const tabs = repositoryTabs(db, open);
    const name = tabs.find((tab) => tab.fullName === `${open.owner}/${open.repo}`)?.name ?? "";
    const notice = updateNotice(db);
    return { version, where, name, tabs, notice, bottom: bottom(tabs.length), load: shownLoad };
  };

  // Returns the details pane's lines for a terminal of this size, or null when it is too narrow
  // for the pane. A task's details are read only when you move onto it or the rows are read again.
  // Its agent's screen is the last one read for this row, or blank until the first read comes.
  // A row with no agent running says so at once.
  const paneFor = (size: { width: number; height: number }) => {
    const beside = paneWidth(size.width);
    if (beside === 0) return null;
    const row = rows[here];
    if (!row || row.task === null) return drawPane(row, null, null, beside, size.height - 2);
    if (details?.name !== row.name)
      details = { name: row.name, read: readDetails(db, open, row.task, Date.now()) };
    const note = liveNote(row);
    const shown = note !== null ? { note } : live?.name === row.name ? live.shown : { screen: "" };
    return drawPane(row, details.read, shown, beside, size.height - 2);
  };

  // Draws what shows, filling the terminal, only when it changed.
  const draw = () => {
    // Every move to another row draws, so the selection is counted here, whatever moved it.
    if (rows[here]?.name !== selected) {
      selected = rows[here]?.name;
      selections++;
    }
    if (attached) return;
    // What the bottom line says can come from outside, such as a forge's reason for refusing a
    // merge, so its control codes never reach your terminal.
    const bottom = (tabs: number) =>
      removeControlCodes(said ?? asking?.question.ask ?? keysFor(rows[here], tabs));
    const size = { width: process.stdout.columns || 80, height: process.stdout.rows || 24 };
    const drawn = drawList(
      rows,
      stageHeadings(all, opened),
      here,
      top,
      frameWith(bottom, load),
      size,
      paneFor(size),
    );
    top = drawn.top;
    targets = drawn.targets;
    const text = `\x1b[H${drawn.lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
    if (text === lastFrame) return;
    lastFrame = text;
    process.stdout.write(text);
  };

  // Shows the rows of the open stages again, keeping you on the same row by its name, or at the
  // same place when it went. The first time, you start on the first task that needs you in an
  // open stage, so one Enter reaches it, or else on the lead.
  const reshow = () => {
    const name = rows[here]?.name;
    rows = showing();
    const at = name === undefined ? -1 : rows.findIndex((row) => row.name === name);
    const needing = rows.findIndex((row) => row.part !== "lead" && row.needsYou);
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
    reshow();
  };

  // Without a terminal, such as in a pipe, there are no keys to read, so the list is printed once,
  // whole, with every stage open, and without colours, and sc returns.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    rows = listRows(db, open, Date.now());
    // Tall enough for every row at two lines, the most one takes, every heading and the blank
    // line after each, so nothing scrolls out of the print.
    const size = { width: 100, height: rows.length * 2 + ListStage.options.length * 2 + 8 };
    const { lines } = drawList(
      rows,
      stageHeadings(rows, new Set(ListStage.options)),
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
  // it is done, and the list shows the row move as the database changes. When the daemon or the
  // forge refuses, the line says why until the next key.
  const goAhead = async (action: Question) => {
    working = true;
    say(action.working);
    try {
      await startOrMerge(action.request);
      said = null;
    } catch (error) {
      said = errorText(error);
    }
    working = false;
    refresh();
  };

  // Opens a row with Enter: attaches to the lead, starting it first when it isn't running, or to
  // the builder of a task at work. Asks before starting an issue. Opens the PR of a task ready
  // for review or ended, or copies its link, or without a forge says which branch waits for you.
  // A ready task whose builder needs you, such as for a question, attaches to the builder, so one
  // Enter reaches what it waits on.
  const openRow = async (row: Row) => {
    // The daemon starts the lead first if it isn't running, such as one you exited or one that
    // crashed, as only it knows. The list reads only the database, which can't tell a crash.
    if (row.part === "lead" && row.session) {
      if (!row.running) say("Starting the lead…");
      const failed = await openRepository(`${open.owner}/${open.repo}`, false);
      said = null;
      if (failed) return say(`The lead didn't start: ${failed}`);
      // The lead is reached on the host it runs on, which the daemon saved as it started it.
      const lead = await leadSession(db, agents, open.owner, open.repo);
      if (lead === null) return say("The lead's session host isn't installed.");
      return attach(lead.id, row.name, lead.host);
    }
    if (row.more > 0) {
      wholeBacklog = true;
      return reshow();
    }
    if (row.part === "backlog" && row.start) {
      asking = { question: row.start, row: row.name, merge: false };
      return draw();
    }
    // A builder that exited leaves its last screen behind, which would look like it still runs.
    const atWork = row.part !== "ready" && row.part !== "done";
    if ((atWork || row.needsYou) && row.session) {
      if (!row.running)
        return say(`${row.name}'s builder isn't running: sc start ${row.name} brings it back`);
      // The builder may run on a runtime plugin's host, which a plugin no longer installed
      // leaves out of reach.
      try {
        const { host, id } = await builderSession(db, agents, readThread(db, row.session));
        return attach(id, row.name, host);
      } catch (error) {
        return say(errorText(error));
      }
    }
    // A task that ended before Skelcrew saved PR links, and whose PR has left the forge's copy,
    // still had a PR: the line names it, as there is no link left to open.
    if (row.link === null && row.part === "done")
      return say(
        row.pr
          ? `${row.name}'s PR ${row.pr} has no link saved, as it ended before Skelcrew kept them: open it on the forge`
          : `${row.name} has no PR to open`,
      );
    if (row.link === null) {
      const branch = row.branch ? ` on branch ${row.branch}` : "";
      return say(
        hasForge(db, open)
          ? `${row.name} has no PR yet`
          : `${row.name} is ready${branch}: open a PR or merge it yourself`,
      );
    }
    if (canOpen) {
      Bun.spawn([openCommand, row.link], { stdout: "ignore", stderr: "ignore" });
      return say(`Opened ${row.link}`);
    }
    // OSC 52 puts the link on your terminal's clipboard, which reaches your laptop over ssh too.
    process.stdout.write(`\x1b]52;c;${Buffer.from(row.link).toString("base64")}\x07`);
    say(`Copied ${row.link}`);
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

  // Opens or closes a stage, as its number key does. Opening one moves you to its first row, so
  // the list scrolls to show it, rather than open it out of sight.
  const toggleStage = (stage: ListStage) => {
    if (opened.delete(stage)) return reshow();
    opened.add(stage);
    reshow();
    const first = rows.findIndex((candidate) => candidate.part === stage);
    if (first >= 0) here = first;
    return draw();
  };

  // Moves you one row up, by -1, or down, by 1, staying among the rows. The live view reads the
  // new row's agent at once, rather than at its next look. That read isn't waited on, as a
  // runtime plugin's host can take many seconds to answer, and the keys after it must not wait.
  const move = (by: 1 | -1) => {
    here = Math.min(Math.max(here + by, 0), rows.length - 1);
    draw();
    void look();
  };

  // Acts on the mouse, by what was drawn where it was pressed. The left button on a repository's
  // tab opens that repository, and on a stage's heading, or its name pinned at an edge, opens or
  // closes the stage. On a task's row it moves you there, and on the row you are on already it
  // opens it, as Enter does, so a double click opens a row too. The lead's row opens the lead at
  // once. The wheel moves you a row up or down, which scrolls the list, as the row you are on
  // always stays in view. Another button, or a click on nothing, does nothing.
  const click = (sent: string) => {
    const [, button, column, line] = clickPattern.exec(sent) ?? [];
    if (button === "64") return move(-1);
    if (button === "65") return move(1);
    if (button !== "0") return draw();
    if (line === "1") {
      const width = process.stdout.columns || 80;
      const tab = tabAt(
        frameWith(() => "", ""),
        width,
        Number(column),
      );
      return tab ? goTo(tab) : draw();
    }
    // The pane beside the list is only to look at, so a click on it reaches nothing.
    const width = process.stdout.columns || 80;
    const beside = paneWidth(width);
    if (beside > 0 && Number(column) > width - 1 - beside - paneEdge.length) return draw();
    const target = targets[Number(line) - 1] ?? null;
    if (target === null) return draw();
    if ("stage" in target) return toggleStage(target.stage);
    if ("pinned" in target) {
      const at = Number(column);
      const pinned = target.pinned.find((span) => span.from <= at && at <= span.to);
      return pinned ? toggleStage(pinned.stage) : draw();
    }
    const row = rows[target.row];
    if (!row) return draw();
    if (target.row === here || row.part === "lead") {
      here = target.row;
      return openRow(row);
    }
    here = target.row;
    return draw();
  };

  // Reads the screen of the agent on the row you are on, for the pane's live view, and draws it
  // when it changed, as a quiet agent's screen mostly hasn't. It reads only while the list shows
  // with its pane, never while you are attached to an agent or once you left. Each row has one
  // read at a time, so a slow host never piles reads up, and a slow read of a row you left never
  // holds up the row you moved to. A read that comes back after you moved, even back to the same
  // row, is dropped, so it never takes the place of a newer screen of the row you are on.
  const reading = new Set<string>();
  const look = async () => {
    const row = rows[here];
    if (attached || left || !row || row.task === null || liveNote(row) !== null) return;
    if (reading.has(row.name) || paneWidth(process.stdout.columns || 80) === 0) return;
    reading.add(row.name);
    const asked = selections;
    const shown = await readLive(db, agents, row);
    reading.delete(row.name);
    // You may have left while the host answered, and the terminal is then your shell's again.
    if (left || selections !== asked) return;
    if (live?.name === row.name && Bun.deepEquals(live.shown, shown)) return;
    live = { name: row.name, shown };
    draw();
  };

  // Acts on one key. A question takes only y and n, and anything else is a no, Esc included. A
  // line that says something goes at the next key, which then does what it does. Nothing acts
  // while the daemon is at work on an answer.
  // Leaves the list, once the list is ready to leave. `left` says it has.
  let leave: () => void = () => {};
  let left = false;
  // Ctrl-\ does nothing here, an open question included, so pressing it once too often after
  // coming back from an agent never answers or drops a question.
  const press = async (key: string) => {
    if (working || left || key === "back") return;
    // q and Ctrl-C leave from anywhere, an open question included, which then does nothing. Esc
    // leaves only with no question open, so a stray Esc while you answer is a no and stays.
    if (key === "q" || (key === "escape" && !asking)) return leave();
    if (asking) {
      const action = asking;
      asking = null;
      if (key !== "y") return draw();
      // The task can change while the question is open: CI can fail, the approval can go, or
      // the issue can start elsewhere. So its row is read again, and only goes ahead while it
      // still offers the very same request. Otherwise the line says why, when the row does.
      refresh();
      const row = rows.find((candidate) => candidate.name === action.row);
      const offer = action.merge ? row?.merge : row?.start;
      if (offer && "ask" in offer && Bun.deepEquals(offer.request, action.question.request))
        return goAhead(offer);
      return say(
        offer && "refused" in offer
          ? offer.refused
          : `${action.row} changed while you were asked, so nothing was done`,
      );
    }
    said = null;
    const row = rows[here];
    if (key === "up" || key === "down") return move(key === "up" ? -1 : 1);
    if (key === "tab") return nextRepository(1);
    if (key === "back tab") return nextRepository(-1);
    if (key.startsWith(`${esc}[<`)) return click(key);
    // 1 to 6 open or close the stages, in the order they show.
    const stage = ListStage.options[Number(key) - 1];
    if (/^[1-6]$/.test(key) && stage) return toggleStage(stage);
    if (key === "enter" && row) return openRow(row);
    // s starts a task not started yet, an issue or one of the backlog, as Enter does there.
    if (key === "s" && row?.part === "backlog" && row.start) {
      asking = { question: row.start, row: row.name, merge: false };
      return draw();
    }
    if (key === "m" && row?.merge) {
      if ("refused" in row.merge) return say(row.merge.refused);
      asking = { question: row.merge, row: row.name, merge: true };
      return draw();
    }
    // A ready task whose builder needs you offers no merge until you have seen to it.
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
