// The screen: the sidebar on the left of your terminal, with the agent or page you are looking
// at on the right and the strip above it. It is a second tmux server, one session per open
// terminal, ended when you leave.
import { applyConfig, cleanEnv, screenSocket } from "../agents/tmux.ts";
import { windowTitle } from "../say.ts";
import { mainFile, singleFile } from "../version.ts";

// How wide the sidebar is, with the line it draws at its edge: room for 24 columns of a name or
// title, between its mark and two columns of padding. tmux shares a resize out among panes, so
// it is set back after each.
export const sidebarWidth = 31;

// Run with each opening, ahead of the new session, so a first draw never shows tmux's own
// look. Your own ~/.tmux.conf never applies.
const config = [
  // tmux's three status lines are at the top. The tabs are the first, the strip and header
  // share the second, and the thin line is the third, so the agent's height stays the same on
  // every session. No blank rows go around them: the thin line sits mid-cell, so half a row
  // falls on each side of it, which is the padding the header needs. They start empty, as the
  // sidebar fills them in, and have no clock to redraw for.
  ["set", "-g", "status", "3"],
  ["set", "-g", "status-position", "top"],
  ["set", "-g", "status-interval", "0"],
  ["set", "-g", "status-style", "default"],
  ["set", "-g", "status-format[0]", ""],
  ["set", "-g", "status-format[1]", ""],
  ["set", "-g", "status-format[2]", ""],
  // tmux writes the title to your terminal, over whatever sprite or your shell put there. An
  // agent's own title stops at its pane, on the agents' server: Claude Code changes its title
  // as it works, and the title says where you are, which switching agents doesn't change. tmux
  // saves your terminal's title on the way in and puts it back on the way out, on terminals
  // that keep one. It goes out as OSC 2, since sprite writes the Sprite's name in front of a
  // title sent as OSC 0, tmux's usual way.
  ["set", "-g", "set-titles", "on"],
  ["set", "-s", "terminal-overrides[90]", "*:tsl=\\E]2;:fsl=\\007"],
  // All of tmux's own keys go: its default mouse keys pull a drag or the wheel into copy mode,
  // which would swallow your typing, and its prefix belongs to the agents' server. Ctrl-Q
  // here, not there, leaves the whole screen.
  ["set", "-g", "prefix", "None"],
  ["set", "-g", "prefix2", "None"],
  ["unbind", "-a", "-T", "root"],
  ["bind", "-n", "C-q", "detach-client"],
  // Alt with an arrow, and the same with Shift, go to the sidebar, in pane 0, without moving
  // your typing from the agent.
  ["bind", "-n", "M-Up", "send-keys", "-t", ":.0", "M-Up"],
  ["bind", "-n", "M-Down", "send-keys", "-t", ":.0", "M-Down"],
  ["bind", "-n", "M-S-Up", "send-keys", "-t", ":.0", "M-S-Up"],
  ["bind", "-n", "M-S-Down", "send-keys", "-t", ":.0", "M-S-Down"],
  ["bind", "-n", "M-Left", "send-keys", "-t", ":.0", "M-Left"],
  ["bind", "-n", "M-Right", "send-keys", "-t", ":.0", "M-Right"],
  // A click on the tabs, in a status line, reaches no pane, so tmux types which tab it was
  // into the sidebar, as an OSC naming the tab's range. send-keys -F expands no format in what
  // it types, so run-shell -C expands it first. A second click soon after the first is a
  // double click to tmux, and must switch tabs all the same.
  ...["MouseDown1Status", "DoubleClick1Status", "TripleClick1Status"].map((click) => [
    "bind",
    "-n",
    click,
    "run-shell",
    "-C",
    'send-keys -t :.0 -l "\x1b]skel-tab;#{mouse_status_range}\x07"',
  ]),
  // A click needs its own key: left alone, it reaches only the pane you type to. The wheel
  // goes on to the pane under it, as the agents' server decides what scrolling means.
  ["bind", "-n", "MouseDown1Pane", "send-keys", "-M"],
  ["bind", "-n", "MouseUp1Pane", "send-keys", "-M"],
  ["bind", "-n", "WheelUpPane", "send-keys", "-M"],
  ["bind", "-n", "WheelDownPane", "send-keys", "-M"],
  ["set", "-g", "mouse", "on"],
  // Ends a session as its client goes, by Ctrl-Q or by a terminal or ssh link that drops, and
  // the server goes with its last session. It would also end a session made detached, so the
  // session is made attached, in one go.
  ["set", "-g", "destroy-unattached", "on"],
  // xterm-256color, unlike tmux's default, tells the client in the right pane that it may use
  // colour and more, and every machine knows it.
  ["set", "-g", "default-terminal", "xterm-256color"],
  // Synchronized output, as on the agents' server, so this server's redraws reach your terminal
  // whole too. Terminal links are turned on for every terminal: left
  // alone, tmux drops them on the way to a terminal it doesn't recognise, and a row would be
  // plain text you can't open.
  ["set", "-s", "terminal-features[90]", "*:sync:hyperlinks"],
  // tmux's border between the panes is blank: the sidebar draws its own line, so the border
  // is a gap before the agent.
  ["set", "-g", "pane-border-lines", "spaces"],
  // tmux shares a resize out among panes, so tmux itself sets the sidebar's width back after
  // each, with no process of Skelcrew's to do it.
  ["set-hook", "-g", "window-resized", `resize-pane -t :.0 -x ${sidebarWidth}`],
];

// Returns the command for the right pane: an ordinary tmux client attached to the session.
// When the client ends, because the agent you were looking at ended or you left its session
// with its own keys, it comes back on the lead's session, trying again while the lead
// restarts. TMUX must go, or tmux refuses to attach from inside tmux.
export function agentClient(agents: string, session: string, lead: string): string[] {
  const client = `tmux -L "$1" -f /dev/null attach -t`;
  const script = `unset TMUX; ${client} "=$2"; while sleep 1; do ${client} "=$3"; done`;
  return ["sh", "-c", script, "sh", agents, session, lead];
}

// Returns the command that runs the Skelcrew you are running, which is a single file on a server,
// or else this checkout.
function skel(...words: string[]): string[] {
  const checkout = singleFile ? [] : [mainFile];
  return [process.execPath, ...checkout, ...words];
}

// Returns the command that runs Skelcrew's sidebar, with the owner/name of the repository it opens
// on. Where Skelcrew runs goes along as a word, not in the environment: a tmux server hands its
// panes the environment of whichever terminal started it, and terminals on this server can
// come from different laptops.
const sidebar = (agents: string, session: string, where: string, repository: string) =>
  skel("sidebar", agents, session, where, repository);

// Returns the command for the right pane while it shows a page.
export const pageCommand = (url: string) => skel("page", url);

// Opens the screen in your terminal on the named agent session, with the open repository's
// lead's session and its owner/name, and returns when you leave with Ctrl-Q, saying that
// nothing stopped. The name of the session here only has to differ from
// other terminals', and this process runs as long as the terminal has it open. Agents' sessions
// are never touched.
export async function openScreen(
  agents: string,
  session: string,
  lead: string,
  repository: string,
): Promise<void> {
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
  // The name sc --remote passes along, such as sprite:demo. Empty on this machine.
  const where = env.SKELCREW_REMOTE_NAME ?? "";
  const left = sidebar(agents, name, where, repository);
  // The title is the session's own: terminals on this server can come from different laptops.
  const open = [
    ...config,
    ["new-session", "-s", name, "--", ...agentClient(agents, session, lead)],
    ["set", "set-titles-string", windowTitle(env.SKELCREW_REMOTE_NAME)],
    ["split-window", "-hbd", "-l", String(sidebarWidth), "--", ...left],
    // Ctrl-C reaches a page until it has made its terminal raw, and Bun won't stay ignoring it.
    // A pane that ended would give the whole screen to the sidebar. A dead one stays in its
    // place, and moving away starts it again.
    ["set", "-p", "-t", ":.1", "remain-on-exit", "on"],
  ];
  // The lone ";" separates tmux commands.
  const commands = open.flatMap((command) => [...command, ";"]).slice(0, -1);
  const argv = ["tmux", "-L", screenSocket(agents), "-f", "/dev/null", ...commands];
  const code = await Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (code !== 0) throw new Error(`couldn't open the screen: tmux exited with ${code}`);
  console.log("Your agents keep running. Run sc to come back.");
}
