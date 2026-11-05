// The screen: the sidebar on the left of your terminal, with the agent you are looking at on
// the right. It is a second tmux server, one session per open terminal, ended when you leave.
import { join } from "node:path";
import { applyConfig, cleanEnv } from "./tmux.ts";

// How wide the sidebar is. tmux shares a resize out among panes, so it is set back after each.
export const sidebarWidth = 28;

// Returns the screen's tmux server beside the agents': skel-screen beside skel, and a test's
// own beside the test's.
export const screenSocket = (agents: string) => `${agents}-screen`;

// Run with each opening, ahead of the new session, so a first draw never shows tmux's own
// look. Your own ~/.tmux.conf never applies, and all of tmux's own keys go: its default mouse
// keys pull a drag or the wheel into copy mode, which would swallow your typing, and its
// prefix belongs to the agents' server. Ctrl-] here, not there, leaves the whole screen.
// Alt-Up, Alt-Down and clicks go to the sidebar, in pane 0, without moving your typing from
// the agent. A click needs its own key: left alone, it reaches only the pane you type to.
// The wheel goes on to the pane under it, as the agents' server decides what scrolling means.
// destroy-unattached ends a session as its client goes, by Ctrl-] or by a terminal or ssh link
// that drops, and the server goes with its last session. It would also end a session made
// detached, so the session is made attached, in one go. The sync feature is the agents'
// server's, for the same reason: this server's redraws must reach your terminal whole too.
// xterm-256color, unlike tmux's default, tells the client in the right pane that it may use
// colour and more, and every machine knows it.
const config = [
  ["set", "-g", "status", "off"],
  ["set", "-g", "prefix", "None"],
  ["set", "-g", "prefix2", "None"],
  ["unbind", "-a", "-T", "root"],
  ["bind", "-n", "C-]", "detach-client"],
  ["bind", "-n", "M-Up", "send-keys", "-t", ":.0", "M-Up"],
  ["bind", "-n", "M-Down", "send-keys", "-t", ":.0", "M-Down"],
  ["bind", "-n", "MouseDown1Pane", "send-keys", "-M"],
  ["bind", "-n", "MouseUp1Pane", "send-keys", "-M"],
  ["bind", "-n", "WheelUpPane", "send-keys", "-M"],
  ["bind", "-n", "WheelDownPane", "send-keys", "-M"],
  ["set", "-g", "mouse", "on"],
  ["set", "-g", "destroy-unattached", "on"],
  ["set", "-g", "default-terminal", "xterm-256color"],
  ["set", "-s", "terminal-features[90]", "*:sync"],
  ["set", "-g", "pane-border-style", "fg=brightblack"],
  ["set", "-g", "pane-active-border-style", "fg=brightblack"],
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
// file on a server, or else this checkout.
function sidebar(agents: string, session: string): string[] {
  const skel = import.meta.dir.startsWith("/$bunfs") ? [] : [join(import.meta.dir, "main.ts")];
  return [process.execPath, ...skel, "sidebar", agents, session];
}

// Opens the screen in your terminal on the named agent session, and returns when you leave
// with Ctrl-]. The name of the session here only has to differ from other terminals', and
// this process runs as long as the terminal has it open. Agents' sessions are never touched.
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
  const open = [
    ...config,
    ["new-session", "-s", name, "--", ...agentClient(agents, session)],
    ["split-window", "-hbd", "-l", String(sidebarWidth), "--", ...sidebar(agents, name)],
  ];
  // The lone ";" separates tmux commands.
  const commands = open.flatMap((command) => [...command, ";"]).slice(0, -1);
  const argv = ["tmux", "-L", screenSocket(agents), "-f", "/dev/null", ...commands];
  const code = await Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (code !== 0) throw new Error(`couldn't open the screen: tmux exited with ${code}`);
}
