// The footer: the bottom row of the screen, across the sidebar and the right side, under a thin
// line. It has the keys you need most, then those for what the right side shows, and the machine's
// load at its right end. Above it, while
// you toggle them on, the list of keys shows under a thin line of its own. It runs in the
// screen's third pane, across the bottom, and sizes that pane to what it shows.
import { cpus } from "node:os";
import { screenTmux, tmuxIsAtLeast } from "../agents/tmux.ts";
import { keyLines } from "./keys.ts";
import { cpuBusy, cpuSample, loadText, memoryInUse, readMemory } from "./load.ts";
import { edge, fitted, grey, pad, paint, removeControlCodes } from "./look.ts";

// The keys you need most, which the footer always starts with.
const always = "⌥↑↓ move  ⌥Q quit";
// The footer's hint that a click shows or hides the list of keys from.
const keysHint = "? keys";

// Returns the footer's text under an agent: the keys you need most, then what Esc stops there,
// with its harness's name, so you never have to guess that Esc is the agent's. An agent whose
// harness isn't known yet, given as empty, gets only the keys you need most.
export function agentFooter(harness: string): string {
  return harness ? `${always}  Esc stops ${harness}` : always;
}

// Returns the footer's text under a list or a page: the keys you need most, then the key for the
// list of keys, then s or m while the chosen issue or PR can be started or merged.
export function listFooter(key: "s" | "m" | null): string {
  const can = key === "s" ? "  s start" : key === "m" ? "  m merge" : "";
  return `${always}  ${keysHint}${can}`;
}

// Returns the footer's pane as lines, from the top, for a screen `width` columns wide: a thin
// line, then the keys shown, if any, under a thin line of their own, then the footer's text, dim
// and two columns in. `load` is the machine's load, already coloured, or empty while it isn't
// known. It goes at the right end, two columns in, and is left out when the text and it don't
// both fit, so it gives way before any key. `ruled` says whether the top line is drawn: on tmux
// before 3.6 the border above the pane is tmux's thin line already. It reads nothing, so what you
// see can be tested without a terminal.
export function drawFooter(
  said: string,
  keys: string[],
  width: number,
  ruled: boolean,
  load: string,
): string[] {
  const rule = paint(edge, "─".repeat(Math.max(width, 0)));
  const room = Math.max(width - 2 * pad.length, 0);
  const text = fitted(removeControlCodes(said), room);
  // The load needs two columns between it and the text, and the rest of the room is the gap.
  const gap = room - Bun.stringWidth(text) - Bun.stringWidth(load);
  const right = load && gap >= 2 ? `${" ".repeat(gap)}${load}${pad}` : "";
  return [
    ...(ruled ? [rule] : []),
    ...(keys.length > 0 ? [...keys.map((line) => paint(grey, line)), rule] : []),
    `${paint(grey, `${pad}${text}`)}${right}`,
  ];
}

// Tells the footer of the screen's session something, as text typed into its pane, which it reads
// as the sidebar reads a click on a tab: what it says now, or to show or hide the list of keys.
// What it says can hold a forge's words, so control codes go, as one could end the message.
export function tellFooter(
  agents: string,
  session: string,
  what: "footer" | "keys",
  value: string,
): void {
  const message = `\x1b]skel-${what};${removeControlCodes(value)}\x07`;
  screenTmux(agents, ["send-keys", "-t", `=${session}:.2`, "-l", message]);
}

// What the footer reads: a press of the mouse, with its button, column and row counted from 1,
// and what the sidebar and the right pane tell it.
const esc = "\x1b";
const input = new RegExp(
  `${esc}\\[<(\\d+);(\\d+);(\\d+)M|${esc}\\]skel-(footer|keys);([^\x07]*)\x07`,
  "g",
);

// Runs the footer until its pane goes. `agents` names the agents' tmux server and `session` the
// screen's session, whose third pane this is. It shows what it was last told, and the list of
// keys while they are toggled on, taking as many rows as they need, up to a third of the screen.
// More keys than that scroll with the wheel. A click on ? keys shows or hides them, and a click
// on them hides them. It reads the machine's load every 5 seconds. It writes only when what shows
// changed, so between changes of the load it sends nothing over a slow link. Tests pin the load
// with SKELCREW_FIXED_LOAD, which Skelcrew itself never sets: it is shown as the load, dim, and
// nothing is measured, so a test can check that a quiet screen writes nothing at all.
export async function runFooter(agents: string, session: string): Promise<void> {
  const self = `=${session}:.2`;
  const ruled = tmuxIsAtLeast(3, 6);
  // What the footer says, whether the keys show, and how far they scrolled.
  let said = always;
  let shown = false;
  let top = 0;
  let lastFrame = "";
  // How many lines were drawn last, which puts the footer's own row last. A click is read by
  // this, not by the pane's height, as a click can come before tmux has told of a resize.
  let drawn = 0;
  // The machine's load, which shows from the second sample on, as the CPU figure needs two.
  const fixed = process.env.SKELCREW_FIXED_LOAD;
  let load = fixed ? paint(grey, removeControlCodes(fixed)) : "";
  let sample = cpuSample(cpus());
  const width = () => process.stdout.columns || 80;
  // Draws what shows, after sizing the pane to it. The keys take at most a third of the screen,
  // so the agent above keeps most of it, and scroll inside that.
  const draw = () => {
    const all = shown ? keyLines(width()) : [];
    // The screen is the window and the status line above it.
    const window = Number(
      screenTmux(agents, ["display", "-p", "-t", self, "#{window_height}"]).out,
    );
    const room = Math.min(all.length, Math.max(Math.floor(((window || 23) + 1) / 3), 1));
    top = Math.min(Math.max(top, 0), all.length - room);
    const lines = drawFooter(said, all.slice(top, top + room), width(), ruled, load);
    drawn = lines.length;
    // The pane grows or shrinks to the lines, which takes rows from the sidebar and the right
    // side, or gives them back. tmux then sends a resize, which draws again.
    if ((process.stdout.rows || 0) !== lines.length)
      screenTmux(agents, ["resize-pane", "-t", self, "-y", String(lines.length)]);
    // Each line is cleared before it is written, not after: a line as wide as the pane leaves
    // the cursor on its last letter, which clearing after would take away.
    const frame = lines.map((line) => `\x1b[K${line}`).join("\r\n");
    if (frame === lastFrame) return;
    lastFrame = frame;
    process.stdout.write(`\x1b[H${frame}\x1b[J`);
  };
  // Returns whether a press at a column on the footer's own row is on ? keys.
  const onKeysHint = (column: number) => {
    const at = said.indexOf(keysHint);
    const start = pad.length + Bun.stringWidth(said.slice(0, at));
    return at >= 0 && column > start && column <= start + keysHint.length;
  };
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink in the footer. 1000 and 1006 ask for the wheel and
  // clicks, so tmux hands them here. ?7l cuts a line at the edge rather than wrap it.
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?7l");
  // Acts on each press, notch of the wheel and message that came together, then draws.
  process.stdin.on("data", (bytes) => {
    for (const [, button, column, row, what, value] of bytes.toString().matchAll(input)) {
      if (what === "footer") said = value ?? "";
      else if (what === "keys") shown = value === "toggle" ? !shown : false;
      else if (button === "64" || button === "65") top += button === "64" ? -1 : 1;
      else if (button === "0") {
        // A click on ? keys shows or hides the keys, and a click above the footer's row, on the
        // keys or their lines, hides them.
        const footerRow = Number(row) === drawn;
        if (footerRow && onKeysHint(Number(column))) shown = !shown;
        else if (!footerRow) shown = false;
      }
    }
    draw();
  });
  // Reads the load every 5 seconds, and draws only when its text changed, as drawing asks tmux
  // for the window's height. A pinned load is never read.
  if (!fixed)
    setInterval(() => {
      const now = cpuSample(cpus());
      const memory = memoryInUse(readMemory());
      const text = loadText(cpuBusy(sample, now), memory.used, memory.total);
      sample = now;
      if (text === load) return;
      load = text;
      draw();
    }, 5000);
  // Draws now and on each resize, until the pane goes and its input closes.
  process.on("SIGWINCH", () => {
    lastFrame = "";
    draw();
  });
  draw();
  await new Promise((gone) => process.stdin.on("close", gone));
  process.exit(0);
}
