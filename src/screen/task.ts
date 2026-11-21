// The screen's right side on a task's row: the task's details alone, scrollable, as the list's
// details pane shows them. Enter attaches to the builder there instead, and Ctrl-\ or the builder
// ending comes back to the details.
import { attachUntilEnded } from "../agents/sessions.ts";
import { respawnPane, screenSocket, screenTmux } from "../agents/tmux.ts";
import { openDb } from "../db.ts";
import { builderSession, readThread } from "../flow/thread.ts";
import { type Details, readDetails } from "../list/details.ts";
import { liveNote, readLead } from "../list/live.ts";
import { drawPane, type Live } from "../list/pane.ts";
import { listRows, type Open, type Row } from "../list/rows.ts";
import { quoteForSh } from "../plugins/plugin.ts";
import { attachOnHostLine } from "../plugins/runtime.ts";
import { errorText } from "../say.ts";
import { attachedMark, skelcrewCommand } from "./screen.ts";

// What the details pane scrolls by: Page Up, as 5, or Page Down, as 6, then the wheel up, as 64,
// or down, as 65, as your terminal reports a press of the mouse.
const esc = "\x1b";
const scrollKeys = new RegExp(`${esc}\\[([56])~|${esc}\\[<(6[45]);\\d+;\\d+M`, "g");

// Returns the command that runs a task's details in the screen's right pane, by the task's row
// name, such as app-12, in the repository named by its owner/name.
const detailsCommand = (agents: string, repository: string, name: string) =>
  skelcrewCommand("details", agents, repository, name);

// Shows a task's details on the right side of the screen whose session is named, by the task's
// row name, such as app-12. What you type stays with the sidebar, so the list's keys work and
// nothing reaches the builder.
export function showTask(agents: string, session: string, repository: string, name: string): void {
  respawnPane(agents, `=${session}:.1`, detailsCommand(agents, repository, name));
  screenTmux(agents, ["select-pane", "-t", `=${session}:.0`]);
}

// Attaches the right side of the screen whose session is named to the builder of a task's row,
// by the row's name, such as APP-12, in the repository named by its owner/name. The row is read
// here, as it is now, so any sidebar can call this with only the name. It goes through the
// builder's session host, and moves your typing there, unless `takeTyping` says no once the
// builder is found: a host can take seconds, and you may have moved your typing to the sidebar
// meanwhile, with Ctrl-\. `zoom` gives the builder the whole terminal, as sc attach does, while it
// has your typing. Once the attachment ends, by Ctrl-\ or by the builder ending, even
// one on tmux whose session stays with its last screen, the right side shows the task's details
// again and your typing goes back to the sidebar. Returns why it
// couldn't attach, such as a builder that isn't running, or null once attached or when you moved
// to another row before it could.
export async function attachTask(
  agents: string,
  session: string,
  repository: string,
  name: string,
  takeTyping: () => boolean,
  zoom: boolean,
): Promise<string | null> {
  const db = openDb();
  const [owner = "", repo = ""] = repository.split("/");
  const row = listRows(db, { owner, repo }, Date.now()).find((one) => one.name === name);
  if (!row) return `${name} is no longer in the list`;
  if (row.session === null || !row.running)
    return `${name}'s builder isn't running: sc start ${name} brings it back`;
  // The right pane's process, so a move to another row while the host answers is seen: each
  // move starts the pane again.
  const pane = `=${session}:.1`;
  const paneProcess = () =>
    screenTmux(agents, ["display-message", "-p", "-t", pane, "#{pane_pid}"]).out.trim();
  const before = paneProcess();
  let attach: string[];
  try {
    const { host, id } = await builderSession(db, agents, readThread(db, row.session));
    // What runs once the attachment ends: your typing goes back to the sidebar, and the pane
    // becomes the details. The mark is a no-op word that names the pane's command as attached.
    const back = [
      `: ${attachedMark}`,
      `tmux -L ${quoteForSh(screenSocket(agents))} select-pane -t ${quoteForSh(`=${session}:.0`)}`,
      `exec ${detailsCommand(agents, repository, row.name).map(quoteForSh).join(" ")}`,
    ].join("; ");
    attach =
      typeof host === "string"
        ? attachUntilEnded(host, id, back)
        : ["sh", "-c", `${attachOnHostLine(host, id)}; ${back}`];
  } catch (error) {
    return errorText(error);
  }
  // A plugin's host can take seconds to say which session is the builder. If you moved to
  // another row meanwhile, the right side shows that row now, and the old Enter does nothing.
  if (paneProcess() !== before) return null;
  // Your typing moves to the right side before the attachment starts, not after: an attachment
  // that ends at once, such as a host's attach that fails, moves it back to the sidebar as it
  // ends, and that must come last. A pane that couldn't start leaves your typing on the sidebar,
  // which shows every pane again.
  if (takeTyping()) {
    screenTmux(agents, ["select-pane", "-t", pane]);
    if (zoom) screenTmux(agents, ["resize-pane", "-Z", "-t", pane]);
  }
  const started = screenTmux(agents, ["respawn-pane", "-k", "-t", pane, "--", ...attach]);
  if (!started.ok) {
    screenTmux(agents, ["select-pane", "-t", `=${session}:.0`]);
    return `${name}'s builder couldn't be shown: ${started.err}`;
  }
  return null;
}

// Runs a task's details in the screen's right pane until the pane is replaced, by the task's row
// name in the repository named by its owner/name. It reads the task again each second and writes
// only when what shows changed. A request of the lead's has no details, so there it shows the
// lead's screen, read 4 times a second, as the list's pane does. Your typing stays with the
// sidebar, which hands on only Page Up and Page Down, and those and the wheel over the pane scroll
// the details. Each row starts this again, so its details start at their top.
export async function runTaskDetails(
  agents: string,
  repository: string,
  name: string,
): Promise<void> {
  const db = openDb();
  const [owner = "", repo = ""] = repository.split("/");
  const open: Open = { owner, repo };
  let row: Row | undefined;
  let details: Details | null = null;
  let live: Live = { screen: "" };
  let lastFrame = "";
  // How far the details are scrolled, and how many lines of them the pane last had room for.
  let scroll = 0;
  let room = 0;

  // Draws the pane, filling it, only when it changed. The cursor stays hidden, as nothing here
  // is typed into.
  const draw = () => {
    const width = process.stdout.columns || 80;
    const height = process.stdout.rows || 24;
    // Only a request's row shows an agent's screen: the lead's, in place of details.
    const note = row ? liveNote(row) : null;
    const shown = row?.part !== "request" ? null : note === null ? live : { note };
    const pane = drawPane(row, details, shown, width, height, false, scroll);
    scroll = pane.scroll;
    room = pane.room;
    const text = `\x1b[?25l\x1b[H${pane.lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
    if (text === lastFrame) return;
    lastFrame = text;
    process.stdout.write(text);
  };

  // Reads the task's row and details again, from the database as it is now. A task that went,
  // such as one removed a moment ago, leaves the pane empty.
  const refresh = () => {
    row = listRows(db, open, Date.now()).find((one) => one.name === name);
    details = row?.task ? readDetails(db, open, row.task, Date.now()) : null;
    draw();
  };

  // Reads the lead's screen on a request's row, one read at a time, as a slow host must never
  // pile reads up.
  let reading = false;
  const look = async () => {
    if (reading || row?.part !== "request" || liveNote(row) !== null) return;
    reading = true;
    live = await readLead(db, agents, open);
    reading = false;
    draw();
  };

  // Page Up and Page Down scroll a page, keeping a line of the last one, and the wheel 3 lines.
  // 1000 and 1006 ask tmux for the wheel over this pane, and a click reaches nothing here.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    process.stdin.on("data", (bytes) => {
      for (const [, pageKey, wheel] of bytes.toString().matchAll(scrollKeys)) {
        const by = pageKey ? Math.max(room - 1, 1) : 3;
        scroll += pageKey === "5" || wheel === "64" ? -by : by;
      }
      draw();
    });
  }
  process.on("SIGWINCH", () => {
    lastFrame = "";
    draw();
  });
  refresh();
  void look();
  setInterval(refresh, 1000);
  setInterval(() => void look(), 250);
  await new Promise(() => {});
}
