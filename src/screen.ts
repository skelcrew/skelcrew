// The screen: the sidebar on the left of your terminal, with the agent you are looking at on
// the right and the strip above it. It is a second tmux server, one session per open terminal,
// ended when you leave.
import { join } from "node:path";
import { windowTitle } from "./say.ts";
import { applyConfig, cleanEnv } from "./tmux.ts";

// How wide the sidebar is, with the line it draws at its edge: room for 24 columns of a name or
// title, between its mark and two columns of padding. tmux shares a resize out among panes, so
// it is set back after each.
export const sidebarWidth = 31;

// Returns the screen's tmux server beside the agents': skel-screen beside skel, and a test's
// own beside the test's.
export const screenSocket = (agents: string) => `${agents}-screen`;

// Run with each opening, ahead of the new session, so a first draw never shows tmux's own
// look. Your own ~/.tmux.conf never applies, and all of tmux's own keys go: its default mouse
// keys pull a drag or the wheel into copy mode, which would swallow your typing, and its
// prefix belongs to the agents' server. Ctrl-Q here, not there, leaves the whole screen.
// Alt-Up, Alt-Down and clicks go to the sidebar, in pane 0, without moving your typing from
// the agent. A click needs its own key: left alone, it reaches only the pane you type to.
// The wheel goes on to the pane under it, as the agents' server decides what scrolling means.
// destroy-unattached ends a session as its client goes, by Ctrl-Q or by a terminal or ssh link
// that drops, and the server goes with its last session. It would also end a session made
// detached, so the session is made attached, in one go. The sync feature is the agents'
// server's, for the same reason: this server's redraws must reach your terminal whole too.
// Terminal links are turned on for every terminal: left alone, tmux drops them on the way to a
// terminal it doesn't recognise, and a row would be plain text you can't open.
// xterm-256color, unlike tmux's default, tells the client in the right pane that it may use
// colour and more, and every machine knows it. tmux writes the title to your terminal, over
// whatever sprite or your shell put there. An agent's own title stops at its pane, on the
// agents' server: Claude Code changes its title as it works, and the title says where you
// are, which switching agents doesn't change. tmux saves your terminal's title on the way in
// and puts it back on the way out, on terminals that keep one. It goes out as OSC 2, since
// sprite writes the Sprite's name in front of a title sent as OSC 0, tmux's usual way.
// tmux's own four status lines are at the top: a blank row, the header and strip, a blank row,
// then the thin line. The blank rows give the header the padding the sidebar has, as one row
// looks as wide as two columns. They are there on every session, so the agent's height stays the
// same. Its pane stays as wide as it was, and needs no process of its own. They start empty, as
// the sidebar fills them in, and have no clock to redraw for. tmux's border between the panes is blank: the sidebar draws its own line, so the border
// is a gap before the agent.
const config = [
  ["set", "-g", "status", "4"],
  ["set", "-g", "status-position", "top"],
  ["set", "-g", "status-interval", "0"],
  ["set", "-g", "status-style", "default"],
  ["set", "-g", "status-format[0]", ""],
  ["set", "-g", "status-format[1]", ""],
  ["set", "-g", "status-format[2]", ""],
  ["set", "-g", "status-format[3]", ""],
  ["set", "-g", "set-titles", "on"],
  ["set", "-s", "terminal-overrides[90]", "*:tsl=\\E]2;:fsl=\\007"],
  ["set", "-g", "prefix", "None"],
  ["set", "-g", "prefix2", "None"],
  ["unbind", "-a", "-T", "root"],
  ["bind", "-n", "C-q", "detach-client"],
  ["bind", "-n", "M-Up", "send-keys", "-t", ":.0", "M-Up"],
  ["bind", "-n", "M-Down", "send-keys", "-t", ":.0", "M-Down"],
  ["bind", "-n", "MouseDown1Pane", "send-keys", "-M"],
  ["bind", "-n", "MouseUp1Pane", "send-keys", "-M"],
  ["bind", "-n", "WheelUpPane", "send-keys", "-M"],
  ["bind", "-n", "WheelDownPane", "send-keys", "-M"],
  ["set", "-g", "mouse", "on"],
  ["set", "-g", "destroy-unattached", "on"],
  ["set", "-g", "default-terminal", "xterm-256color"],
  ["set", "-s", "terminal-features[90]", "*:sync:hyperlinks"],
  ["set", "-g", "pane-border-lines", "spaces"],
  ["set-hook", "-g", "window-resized", `resize-pane -t :.0 -x ${sidebarWidth}`],
];

// Returns the command for the right pane: an ordinary tmux client attached to the session.
// When the client ends, because the agent you were looking at ended or you left its session
// with its own keys, it comes back on the lead, trying again while the lead restarts. TMUX
// must go, or tmux refuses to attach from inside tmux.
function agentClient(agents: string, session: string): string[] {
  const client = `tmux -L "$1" -f /dev/null attach -t`;
  const script = `unset TMUX; ${client} "=$2"; while sleep 1; do ${client} =lead; done`;
  return ["sh", "-c", script, "sh", agents, session];
}

// Returns the command that runs skel's sidebar: the skel you are running, which is a single
// file on a server, or else this checkout. Where skel runs goes along as a word, not in the
// environment: a tmux server hands its panes the environment of whichever terminal started it,
// and terminals on this server can come from different laptops.
function sidebar(agents: string, session: string, where: string): string[] {
  const skel = import.meta.dir.startsWith("/$bunfs") ? [] : [join(import.meta.dir, "main.ts")];
  return [process.execPath, ...skel, "sidebar", agents, session, where];
}

// Opens the screen in your terminal on the named agent session, and returns when you leave
// with Ctrl-Q, saying that nothing stopped. The name of the session here only has to differ from
// other terminals', and this process runs as long as the terminal has it open. Agents' sessions
// are never touched.
export async function openScreen(agents: string, session: string): Promise<void> {
  const env = cleanEnv();
  // Reports whether this machine knows the terminal, so opening can choose a fallback.
  // tmux refuses unknown terminals, such as Ghostty's xterm-ghostty over ssh.
  // xterm-256color draws Claude Code well enough.
  const known = (term: string) =>
    !Bun.which("infocmp") ||
    Bun.spawnSync(["infocmp", term], { stdout: "ignore", stderr: "ignore" }).success;
  if (env.TERM && !known(env.TERM)) env.TERM = "xterm-256color";
  applyConfig(agents);
  const name = `screen-${process.pid}`;
  // The name skel --remote passes along, such as sprite:demo. Empty on this machine.
  const where = env.SKEL_REMOTE_NAME ?? "";
  const left = sidebar(agents, name, where);
  // The title is the session's own: terminals on this server can come from different laptops.
  const open = [
    ...config,
    ["new-session", "-s", name, "--", ...agentClient(agents, session)],
    ["set", "set-titles-string", windowTitle(env.SKEL_REMOTE_NAME)],
    ["split-window", "-hbd", "-l", String(sidebarWidth), "--", ...left],
  ];
  // The lone ";" separates tmux commands.
  const commands = open.flatMap((command) => [...command, ";"]).slice(0, -1);
  const argv = ["tmux", "-L", screenSocket(agents), "-f", "/dev/null", ...commands];
  const code = await Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (code !== 0) throw new Error(`couldn't open the screen: tmux exited with ${code}`);
  console.log("Your agents keep running. Run skel to come back.");
}
