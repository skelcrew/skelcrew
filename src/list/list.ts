// The list: what `sc` shows in your terminal. One repository's lead and tasks, by stage, as a
// picker. Enter attaches you full screen to an agent through its session host, and leaving it
// comes back here, on the same row. It also starts an issue, merges a task ready for review and
// opens its PR, each asking first where it can't be taken back.
import { cpus } from "node:os";
import { attachSession, typeKeys } from "../agents/sessions.ts";
import { openRepository, startOrMerge } from "../client.ts";
import { openDb } from "../db.ts";
import { updateNotice } from "../machine/update.ts";
import { errorText } from "../say.ts";
import { cpuBusy, cpuSample, loadText, memoryInUse, readMemory } from "../screen/load.ts";
import { grey, paint, removeControlCodes } from "../screen/look.ts";
import { version } from "../version.ts";
import { drawList, type Frame, keysFor } from "./layout.ts";
import { hasForge, listRows, type Open, type Question, type Row, repositoryTabs } from "./rows.ts";

// The command that opens a link in your browser.
const openCommand = process.platform === "darwin" ? "open" : "xdg-open";

// The keys the list reads, as your terminal sends them. Arrows come in either of the two forms a
// terminal may use, and Ctrl-C leaves as q does, since the terminal is raw.
const keyNames: Record<string, string> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x03": "q",
  "\x1b": "escape",
};
const esc = "\x1b";
const keyPattern = new RegExp(`${esc}\\[[AB]|${esc}O[AB]|[\\s\\S]`, "g");
// The start of an escape sequence at the end of a read, whose end may come in the next one.
const endOfSequence = new RegExp(`${esc}[[O]?$`);

// Runs the list in your terminal for the repository named by its owner/name, until you press q,
// then says your agents keep running.
// `agents` is the sessions' tmux server. It looks again each second, and writes only when what
// shows changed, as over a slow link each write costs. The load at the end of the bottom line is
// read every 5 seconds. Tests pin it with SKELCREW_FIXED_LOAD, which Skelcrew itself never sets,
// so a quiet list writes nothing at all.
export async function runList(agents: string, repository: string): Promise<void> {
  const db = openDb();
  const where = process.env.SKELCREW_REMOTE_NAME ?? "";
  const [owner = "", repo = ""] = repository.split("/");
  let open: Open = { owner, repo };
  // What the list keeps between draws: its rows, the row you are on and how far it scrolled,
  // the line at the bottom when it says something other than the keys, the question it asks,
  // and whether the daemon is at work on an answer.
  let rows: Row[] = [];
  let here = -1;
  let top = 0;
  let said: string | null = null;
  // The open question, with the row it is about and whether it is a merge or a start.
  let asking: { question: Question; row: string; merge: boolean } | null = null;
  let working = false;
  let attached = false;
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

  // Draws what shows, filling the terminal, only when it changed.
  const draw = () => {
    if (attached) return;
    // What the bottom line says can come from outside, such as a forge's reason for refusing a
    // merge, so its control codes never reach your terminal.
    const bottom = (tabs: number) =>
      removeControlCodes(said ?? asking?.question.ask ?? keysFor(rows[here], tabs));
    const size = { width: process.stdout.columns || 80, height: process.stdout.rows || 24 };
    const drawn = drawList(rows, here, top, frameWith(bottom, load), size);
    top = drawn.top;
    const text = `\x1b[H${drawn.lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
    if (text === lastFrame) return;
    lastFrame = text;
    process.stdout.write(text);
  };

  // Reads the rows again, keeping you on the same row by its name, or at the same place when it
  // went. The first time, you start on the first task that needs you, working or ready for
  // review, so one Enter reaches it, or else on the lead.
  const refresh = () => {
    if (attached) return;
    const name = rows[here]?.name;
    rows = listRows(db, open, Date.now());
    const at = name === undefined ? -1 : rows.findIndex((row) => row.name === name);
    const needing = rows.findIndex((row) => row.part !== "lead" && row.mark.sign === "●");
    if (at >= 0) here = at;
    else if (here < 0) here = Math.max(needing, 0);
    else here = Math.min(here, rows.length - 1);
    draw();
  };

  // Without a terminal, such as in a pipe, there are no keys to read, so the list is printed once,
  // whole and without colours, and sc returns.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    rows = listRows(db, open, Date.now());
    // Tall enough for every row, its heading and the blank line before it.
    const size = { width: 100, height: rows.length * 3 + 6 };
    const { lines } = drawList(
      rows,
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
  // no cursor, and raw keys. Gives it back as it was for an agent or for your shell.
  const takeTerminal = () => {
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    lastFrame = "";
  };
  const giveBack = () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.stdin.setRawMode(false);
  };

  // Attaches you full screen to an agent's session, and comes back to the list once you leave
  // it, on the same row. The list stops reading keys meanwhile, so every key reaches the agent.
  // Keys you typed after Enter that the list hasn't acted on yet, such as ones that came with
  // Enter in one read, were meant for the agent, so they are typed into it first.
  const attach = async (session: string) => {
    attached = true;
    process.stdin.pause();
    const after =
      typed
        .splice(0)
        .map((key) => key.sent)
        .join("") + partial;
    partial = "";
    if (after) typeKeys(agents, session, after);
    giveBack();
    const failed = await attachSession(agents, session);
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
  // a working task's builder. Asks before starting an issue. Opens a ready task's PR, or copies
  // its link, or without a forge says which branch waits for you.
  const openRow = async (row: Row) => {
    // The daemon starts the lead first if it isn't running, such as one you exited or one that
    // crashed, as only it knows. The list reads only the database, which can't tell a crash.
    if (row.part === "lead" && row.session) {
      if (!row.running) say("Starting the lead…");
      const failed = await openRepository(`${open.owner}/${open.repo}`, false);
      said = null;
      if (failed) return say(`The lead didn't start: ${failed}`);
      return attach(row.session);
    }
    if (row.part === "issue" && row.start) {
      asking = { question: row.start, row: row.name, merge: false };
      return draw();
    }
    // A builder that exited leaves its last screen behind, which would look like it still runs.
    if (row.part === "working" && row.session) {
      if (row.running) return attach(row.session);
      return say(`${row.name}'s builder isn't running: sc start ${row.name} brings it back`);
    }
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

  // Moves to the next repository, after the last back to the first, and has the daemon start
  // its lead if it never has. Not waited on, so the list draws at once.
  const nextRepository = () => {
    const tabs = repositoryTabs(db, open);
    if (tabs.length < 2) return;
    const at = tabs.findIndex((tab) => tab.fullName === `${open.owner}/${open.repo}`);
    const next = tabs[(at + 1) % tabs.length];
    if (!next) return;
    const [nextOwner = "", nextRepo = ""] = next.fullName.split("/");
    open = { owner: nextOwner, repo: nextRepo };
    openRepository(next.fullName, true).catch(() => {});
    rows = [];
    here = -1;
    top = 0;
    refresh();
  };

  // Acts on one key. A question takes only y and n, and anything else is a no. A line that says
  // something goes at the next key, which then does what it does. Nothing acts while the daemon
  // is at work on an answer.
  // Leaves the list, once the list is ready to leave. `left` says it has.
  let leave: () => void = () => {};
  let left = false;
  const press = async (key: string) => {
    if (working || left) return;
    // q and Ctrl-C leave from anywhere, an open question included, which then does nothing.
    if (key === "q") return leave();
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
    if (key === "up" || key === "down") {
      here = Math.min(Math.max(here + (key === "up" ? -1 : 1), 0), rows.length - 1);
      return draw();
    }
    if (key === "tab") return nextRepository();
    if (key === "enter" && row) return openRow(row);
    if (key === "m" && row?.merge) {
      if ("refused" in row.merge) return say(row.merge.refused);
      asking = { question: row.merge, row: row.name, merge: true };
      return draw();
    }
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
      const named = keyNames[key.sent] ?? key.sent;
      await press(named).catch((error) => say(errorText(error)));
      if (named === "enter" || asking) while (typed[0]?.read === key.read) typed.shift();
    }
    acting = false;
  };
  // An arrow's escape sequence can come in two reads, as over ssh. So a read that ends partway
  // into one keeps that end until the next read completes it. Esc alone looks the same, so what
  // is kept counts as typed once no more comes for a moment, as terminals and editors do.
  let flush: ReturnType<typeof setTimeout> | undefined;
  const take = (text: string) => {
    reads += 1;
    for (const [sent] of text.matchAll(keyPattern)) typed.push({ sent, read: reads });
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
  process.stdin.pause();
  giveBack();
  // Plain sc opens the split screen, so the way back to the list names --list.
  console.log("Your agents keep running. Run sc --list to come back.");
}
