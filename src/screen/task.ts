// The screen's right pane shows the item and task details, with scrolling, and tells the sidebar
// which of the item's options it shows. Enter attaches to the builder; leaving it returns here.
import { attachUntilEnded } from "../agents/sessions.ts";
import { respawnPane, screenSocket, screenTmux } from "../agents/tmux.ts";
import { openDb } from "../db.ts";
import { type Letter, letters } from "../flow/requests.ts";
import { builderSession, readThread } from "../flow/thread.ts";
import { errorText } from "../format.ts";
import { pickSent } from "../list/actions.ts";
import { type Details, readDetails } from "../list/details.ts";
import type { Pick } from "../list/layout.ts";
import { drawPane } from "../list/pane.ts";
import { type Ask, listRows, type Open, type Row } from "../list/rows.ts";
import { quoteForSh } from "../plugins/plugin.ts";
import { attachOnHostLine } from "../plugins/runtime.ts";
import { attachedMark, panes, skelcrewCommand, zoomIn } from "./screen.ts";

// What the details pane scrolls by: Page Up, as 5, or Page Down, as 6, then the wheel up, as 64,
// or down, as 65, as your terminal reports a press of the mouse.
const esc = "\x1b";
const scrollKeys = new RegExp(`${esc}\\[([56])~|${esc}\\[<(6[45]);\\d+;\\d+M|${esc}\\[([AB])`, "g");

// Returns the command that runs a task's details in the screen's right pane, by the task's row
// name, such as app-12, in the repository named by its owner/name, with the y/n question a pick
// on its item asks, or empty, and the letter of a pick on its way to the daemon, if any.
const detailsCommand = (
  agents: string,
  repository: string,
  name: string,
  confirm = "",
  sent?: Letter,
) =>
  skelcrewCommand(
    "details",
    agents,
    repository,
    name,
    ...(confirm === "" && sent === undefined ? [] : [confirm]),
    ...(sent === undefined ? [] : [sent]),
  );

// Shows a task's details on the right side of the screen whose session is named, by the task's
// row name, such as app-12, with `confirm` in its item's box while a pick on it asks y/n, and the
// pick `sent` shown as the daemon shows it once it has it. What you type stays with the sidebar,
// so the list's keys work and nothing reaches the builder.
export function showTask(
  agents: string,
  session: string,
  repository: string,
  name: string,
  confirm = "",
  sent?: Letter,
): void {
  respawnPane(
    agents,
    `=${session}:.${panes.right}`,
    detailsCommand(agents, repository, name, confirm, sent),
  );
  screenTmux(agents, ["select-pane", "-t", `=${session}:.${panes.sidebar}`]);
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
  const pane = `=${session}:.${panes.right}`;
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
      `tmux -L ${quoteForSh(screenSocket(agents))} select-pane -t ${quoteForSh(`=${session}:.${panes.sidebar}`)}`,
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
    if (zoom) screenTmux(agents, zoomIn(pane));
  }
  const started = screenTmux(agents, ["respawn-pane", "-k", "-t", pane, "--", ...attach]);
  if (!started.ok) {
    screenTmux(agents, ["select-pane", "-t", `=${session}:.${panes.sidebar}`]);
    return `${name}'s builder couldn't be shown: ${started.err}`;
  }
  return null;
}

export async function runTaskDetails(
  agents: string,
  repository: string,
  name: string,
  confirm = "",
  sent = "",
): Promise<void> {
  const db = openDb();
  const [owner = "", repo = ""] = repository.split("/");
  const open: Open = { owner, repo };
  let row: Row | undefined;
  let details: Details | null = null;
  let lastFrame = "";
  let scroll = 0;
  let room = 0;
  let toldPicks: string | null = null;

  const draw = () => {
    const width = process.stdout.columns || 80;
    const height = process.stdout.rows || 24;
    const pane = drawPane(row, details, null, width, height, false, scroll);
    scroll = pane.scroll;
    room = pane.room;
    const text = `\x1b[?25l\x1b[H${pane.lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
    if (text !== lastFrame) process.stdout.write(text);
    lastFrame = text;
    const picks = `${process.pid} ${row?.ask ? itemId(row.ask) : "-"} ${pane.picks.join(",")}`;
    const here = process.env.TMUX_PANE;
    if (picks === toldPicks || !here) return;
    toldPicks = picks;
    screenTmux(agents, ["set", "-p", "-t", here, "@picks", picks]);
  };

  const pick = letters.find((letter) => letter === sent);
  const refresh = () => {
    const listed = pickSent(listRows(db, open, Date.now()), pick ? { row: name, pick } : null);
    const found = listed.find((one) => one.name === name);
    row = found?.ask && confirm ? { ...found, ask: { ...found.ask, confirm } } : found;
    details = row?.task ? readDetails(db, open, row.task, Date.now(), row.changed) : null;
    draw();
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    process.stdin.on("data", (bytes) => {
      for (const [, pageKey, wheel, arrow] of bytes.toString().matchAll(scrollKeys)) {
        const by = pageKey ? Math.max(room - 1, 1) : arrow ? 1 : 3;
        scroll += pageKey === "5" || wheel === "64" || arrow === "A" ? -by : by;
      }
      draw();
    });
  }
  process.on("SIGWINCH", () => {
    lastFrame = "";
    draw();
  });
  refresh();
  setInterval(refresh, 1000);
  await new Promise(() => {});
}

// Names an item by what it asks and what its options do, so a replaced item has another name.
const itemId = (ask: Ask) =>
  Bun.hash(JSON.stringify([ask.title, ask.text, ask.options, ask.acts])).toString(36);

// Returns the options of `ask` that the details in the screen's pane `target` show now, as the
// details told the pane. Anything else in the pane, such as a builder attached there, details
// still starting, or details still showing an item since replaced, tells nothing.
export function picksBeside(agents: string, target: string, ask: Ask): Pick[] {
  const told = screenTmux(agents, ["display", "-p", "-t", target, "#{pane_pid} #{@picks}"]);
  const [pid, from, item, picks = ""] = told.out.trim().split(" ");
  if (!told.ok || !pid || pid !== from || item !== itemId(ask)) return [];
  const all: Pick[] = [...letters, "reply"];
  return all.filter((pick) => picks.split(",").includes(pick));
}
