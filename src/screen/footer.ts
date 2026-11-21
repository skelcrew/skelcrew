// The footer: the bottom row of the screen, across the sidebar and the right side, under the line
// that closes their boxes. It has the keys you need most, then those for what the right side shows, and the machine's
// load at its right end. It runs in the screen's last pane, across the bottom.
import { cpus } from "node:os";
import { screenTmux } from "../agents/tmux.ts";
import { cpuBusy, cpuSample, loadText, memoryInUse, readMemory } from "./load.ts";
import { fitted, grey, pad, paint, removeControlCodes } from "./look.ts";
import { panes } from "./screen.ts";

// The keys you need most, which the footer always starts with.
const always = "⌥↑↓ move  ⌥Q quit";

// Returns the footer's text while your typing goes to an agent on the right side, named by
// `name`, such as lead or APP-12: which one it is and the key back to the list, then the keys you
// need most and what Esc stops there, with its harness's name, so you never have to guess that
// Esc is the agent's. An agent whose harness isn't known yet, given as empty, gets no Esc.
export function agentFooter(name: string, harness: string): string {
  const keys = `typing to ${name} · ⌃\\ to list  ${always}`;
  return harness ? `${keys}  Esc stops ${harness}` : keys;
}

// Returns the footer's row for a screen `width` columns wide: the footer's text, dim and two
// columns in. `load` is the machine's load, already coloured, or empty while it isn't known. It
// goes at the right end, two columns in, and is left out when the text and it don't both fit, so
// it gives way before any key. It reads nothing, so what you see can be tested without a terminal.
export function drawFooter(said: string, width: number, load: string): string {
  const room = Math.max(width - 2 * pad.length, 0);
  const text = fitted(removeControlCodes(said), room);
  // The load needs two columns between it and the text, and the rest of the room is the gap.
  const gap = room - Bun.stringWidth(text) - Bun.stringWidth(load);
  const right = load && gap >= 2 ? `${" ".repeat(gap)}${load}${pad}` : "";
  return `${paint(grey, `${pad}${text}`)}${right}`;
}

// Tells the footer of the screen's session what it says now, as text typed into its pane, which
// it reads as the sidebar reads a click on a tab. What it says can hold a forge's words, so
// control codes go, as one could end the message.
export function tellFooter(agents: string, session: string, said: string): void {
  const message = `\x1b]skel-footer;${removeControlCodes(said)}\x07`;
  screenTmux(agents, ["send-keys", "-t", `=${session}:.${panes.footer}`, "-l", message]);
}

// What the footer reads: what the sidebar tells it to say.
const input = new RegExp(`${"\x1b"}\\]skel-footer;([^\x07]*)\x07`, "g");

// Runs the footer until its pane goes. `agents` names the agents' tmux server and `session` the
// screen's session, whose last pane this is. It shows what it was last told, and reads the
// machine's load every 5 seconds. It writes only when what shows changed, so between changes of
// the load it sends nothing over a slow link. Tests pin the load with SKELCREW_FIXED_LOAD, which
// Skelcrew itself never sets: it is shown as the load, dim, and nothing is measured, so a test
// can check that a quiet screen writes nothing at all.
export async function runFooter(agents: string, session: string): Promise<void> {
  const self = `=${session}:.${panes.footer}`;
  let said = always;
  let lastFrame = "";
  // The machine's load, which shows from the second sample on, as the CPU figure needs two.
  const fixed = process.env.SKELCREW_FIXED_LOAD;
  let load = fixed ? paint(grey, removeControlCodes(fixed)) : "";
  let sample = cpuSample(cpus());
  // Draws what shows, after sizing the pane to its one row. tmux shares a resize of the screen
  // out among its panes, which can make this one taller, so it takes its own height back each
  // time.
  const draw = () => {
    if ((process.stdout.rows || 0) !== 1)
      screenTmux(agents, ["resize-pane", "-t", self, "-y", "1"]);
    // The row is cleared before it is written, not after: a row as wide as the pane leaves the
    // cursor on its last letter, which clearing after would take away.
    const frame = `\x1b[K${drawFooter(said, process.stdout.columns || 80, load)}`;
    if (frame === lastFrame) return;
    lastFrame = frame;
    process.stdout.write(`\x1b[H${frame}\x1b[J`);
  };
  process.stdin.setRawMode(true);
  // Without the cursor hidden it would blink in the footer. ?7l cuts a line at the edge rather
  // than wrap it.
  process.stdout.write("\x1b[?25l\x1b[?7l");
  // Takes the last of what the sidebar said, then draws.
  process.stdin.on("data", (bytes) => {
    for (const [, value] of bytes.toString().matchAll(input)) said = value ?? "";
    draw();
  });
  // Reads the load every 5 seconds, and draws only when its text changed. A pinned load is never
  // read.
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
