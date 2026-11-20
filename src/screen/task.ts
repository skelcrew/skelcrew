// The screen's right side on a task's row: the task's details with its builder's screen live
// under them, read-only, as the list's details pane shows them. Enter attaches to the builder
// there instead, and Ctrl-\ or the builder ending comes back to the details.
import { attachThen } from "../agents/sessions.ts";
import { respawnPane, screenSocket, screenTmux } from "../agents/tmux.ts";
import { openDb } from "../db.ts";
import { builderSession, readThread } from "../flow/thread.ts";
import { type Details, readDetails } from "../list/details.ts";
import { liveNote, readLive } from "../list/live.ts";
import { drawPane, type Live } from "../list/pane.ts";
import { listRows, type Open, type Row } from "../list/rows.ts";
import { quoteForSh } from "../plugins/plugin.ts";
import { attachOnHostLine } from "../plugins/runtime.ts";
import { errorText } from "../say.ts";
import { attachedMark, skelcrewCommand } from "./screen.ts";

// Returns the command that runs a task's details in the screen's right pane, by the task's row
// name, such as app-12, in the repository named by its owner/name.
const detailsCommand = (agents: string, repository: string, name: string) =>
  skelcrewCommand("details", agents, repository, name);

// Shows a task's details and its builder's live screen on the right side of the screen whose
// session is named, by the task's row name, such as app-12. What you type stays with the
// sidebar, so the list's keys work and nothing reaches the builder.
export function showTask(agents: string, session: string, repository: string, name: string): void {
  respawnPane(agents, `=${session}:.1`, detailsCommand(agents, repository, name));
  screenTmux(agents, ["select-pane", "-t", `=${session}:.0`]);
}

// Attaches the right side of the screen whose session is named to the builder of a task's row,
// through its session host, and moves your typing there. Once the attachment ends, by Ctrl-\ or
// by the builder's session ending, the right side shows the task's details again and your typing
// goes back to the sidebar. Returns why it couldn't attach, such as a builder that isn't running,
// or null once attached.
export async function attachTask(
  agents: string,
  session: string,
  repository: string,
  row: Row,
): Promise<string | null> {
  if (row.session === null || !row.running)
    return `${row.name}'s builder isn't running: sc start ${row.name} brings it back`;
  const db = openDb();
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
        ? attachThen(host, id, back)
        : ["sh", "-c", `${attachOnHostLine(host, id)}; ${back}`];
  } catch (error) {
    return errorText(error);
  }
  respawnPane(agents, `=${session}:.1`, attach);
  screenTmux(agents, ["select-pane", "-t", `=${session}:.1`]);
  return null;
}

// Runs a task's details in the screen's right pane until the pane is replaced, by the task's row
// name in the repository named by its owner/name. It reads the task again each second and its
// builder's screen 4 times a second, as the list's pane does, and writes only when what shows
// changed. It reads no keys: the sidebar has your typing while this shows.
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

  // Draws the pane, filling it, only when it changed. The cursor stays hidden, as nothing here
  // is typed into.
  const draw = () => {
    const width = process.stdout.columns || 80;
    const height = process.stdout.rows || 24;
    const note = row ? liveNote(row) : null;
    const lines = drawPane(row, details, note === null ? live : { note }, width, height);
    const text = `\x1b[?25l\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
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

  // Reads the builder's screen, one read at a time, as a slow host must never pile reads up.
  let reading = false;
  const look = async () => {
    if (reading || !row || liveNote(row) !== null) return;
    reading = true;
    live = await readLive(db, agents, row);
    reading = false;
    draw();
  };

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
