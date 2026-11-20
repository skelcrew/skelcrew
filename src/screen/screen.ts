// The screen: the sidebar on the left of your terminal, with the agent or list you are looking
// at on the right, the strip above it and the footer across the bottom. It is a second tmux
// server, one session per open terminal, ended when you leave.
import { applyConfig, attachCommand } from "../agents/sessions.ts";
import { envWithoutTmux, screenSocket, tmuxIsAtLeast } from "../agents/tmux.ts";
import { windowTitle } from "../say.ts";
import { mainFile, singleFile } from "../version.ts";
import type { Entry } from "./lists.ts";

// How wide the sidebar is, with the line it draws at its edge: room for 31 columns of a title,
// between its mark and two columns of padding, so a thread's name, word, harness and time
// usually fit on one line whole. tmux shares a resize out among panes, so it is set back after
// each.
export const sidebarWidth = 38;

// The tmux commands that set up the screen's server. They run each time the screen opens,
// before its session starts, so a first draw never shows tmux's own look. Your own ~/.tmux.conf
// never applies.
const config = [
  // tmux's one status line is at the top, so the agent's height stays the same on every
  // session. The header, the tabs and the strip share it. It starts empty, as the sidebar fills
  // it in, and has no clock to redraw for.
  ["set", "-g", "status", "on"],
  ["set", "-g", "status-position", "top"],
  ["set", "-g", "status-interval", "0"],
  ["set", "-g", "status-style", "default"],
  ["set", "-g", "status-format[0]", ""],
  // tmux writes the title to your terminal, over whatever your shell put there. An agent's own
  // title stops at its pane, on the agents' server: Claude Code changes its title as it works,
  // and the title says where you are, which switching agents doesn't change. tmux saves your
  // terminal's title on the way in and puts it back on the way out, on terminals that keep one.
  ["set", "-g", "set-titles", "on"],
  // All of tmux's own keys go: its default mouse keys pull a drag or the wheel into copy mode,
  // which would swallow your typing, and its prefix belongs to the agents' server. Alt-Q
  // here, not there, leaves the whole screen. Ctrl-Q does too, though nothing shows it, for a
  // Mac terminal that doesn't send Option as Alt. So does Ctrl-\, the agents' server's key to
  // detach: left to reach it, it would detach the agent's pane and leave it empty.
  ["set", "-g", "prefix", "None"],
  ["set", "-g", "prefix2", "None"],
  ["unbind", "-a", "-T", "root"],
  ["bind", "-n", "M-q", "detach-client"],
  ["bind", "-n", "C-q", "detach-client"],
  ["bind", "-n", "C-\\", "detach-client"],
  // Keys that arrive faster than a millisecond apart are taken for a paste, and tmux then hands
  // them to the pane you type to rather than act on them. Several Alt keys in one read, as fast
  // typing, key repeat or a slow link bring, would lose all but the first two, and type the rest
  // into the agent. A paste that matters comes bracketed anyway.
  ["set", "-g", "assume-paste-time", "0"],
  // Alt-Up and Alt-Down, with or without Shift, and Alt-Shift-Left and Alt-Shift-Right go to
  // the sidebar, in pane 0, without moving your typing from the agent. Plain Alt-Left and
  // Alt-Right stay the agent's, as some terminals send them to move a word while you type.
  ["bind", "-n", "M-Up", "send-keys", "-t", ":.0", "M-Up"],
  ["bind", "-n", "M-Down", "send-keys", "-t", ":.0", "M-Down"],
  ["bind", "-n", "M-S-Up", "send-keys", "-t", ":.0", "M-S-Up"],
  ["bind", "-n", "M-S-Down", "send-keys", "-t", ":.0", "M-S-Down"],
  ["bind", "-n", "M-S-Left", "send-keys", "-t", ":.0", "M-S-Left"],
  ["bind", "-n", "M-S-Right", "send-keys", "-t", ":.0", "M-S-Right"],
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
  // goes on to the pane under it, as the agents' server decides what scrolling means, and the
  // footer scrolls the list of keys with it.
  ["bind", "-n", "MouseDown1Pane", "send-keys", "-M"],
  ["bind", "-n", "MouseUp1Pane", "send-keys", "-M"],
  ["bind", "-n", "WheelUpPane", "send-keys", "-M"],
  ["bind", "-n", "WheelDownPane", "send-keys", "-M"],
  // A drag, and the second and third press of a double or triple click, go on as they come,
  // so the agents' server selects and copies the agent's text itself, with its history.
  // DoubleClick1Pane stays unbound: tmux fires it a moment after the second press, which the
  // agents' server already got, and would count it as a press of its own.
  ["bind", "-n", "MouseDrag1Pane", "send-keys", "-M"],
  ["bind", "-n", "SecondClick1Pane", "send-keys", "-M"],
  ["bind", "-n", "TripleClick1Pane", "send-keys", "-M"],
  // A drag over the agent that is let go over the sidebar, the footer or the top row would end
  // in that other place, and the agents' server would wait for a release that never comes,
  // copying nothing. So the agent's pane gets the drag's end at its nearest edge: the start of
  // the same row beside the sidebar, the top left under the top row, the end of its last row
  // above the footer. It is a move there and a release, as tmux ends a selection where the
  // last move was, and ignores a place outside its window. Lists and the sidebar act only on
  // presses, so a stray release there does nothing.
  [
    "bind",
    "-n",
    "MouseDragEnd1Pane",
    "if",
    "-F",
    "#{==:#{pane_index},1}",
    "send-keys -M",
    `if -F "#{==:#{pane_index},0}" { run-shell -C 'send-keys -t :.1 -l "\x1b[<32;1;#{e|+:#{mouse_y},1}M\x1b[<0;1;#{e|+:#{mouse_y},1}m"' } { run-shell -C -t :.1 'send-keys -t :.1 -l "\x1b[<32;#{pane_width};#{pane_height}M\x1b[<0;#{pane_width};#{pane_height}m"' }`,
  ],
  [
    "bind",
    "-n",
    "MouseDragEnd1Status",
    "send-keys",
    "-t",
    ":.1",
    "-l",
    "\x1b[<32;1;1M\x1b[<0;1;1m",
  ],
  ["set", "-g", "mouse", "on"],
  // Ends a session as its client goes, by Alt-Q or by a terminal or ssh link that drops, and
  // the server goes with its last session. It would also end a session made detached, so the
  // session is made attached, in one go.
  ["set", "-g", "destroy-unattached", "on"],
  // xterm-256color, unlike tmux's default, tells the client in the right pane that it may use
  // colour and more, and every machine knows it.
  ["set", "-g", "default-terminal", "xterm-256color"],
  // Synchronized output, as on the agents' server, so this server's redraws reach your terminal
  // whole too. Terminal links and the clipboard are turned on for every terminal: left alone,
  // tmux drops them on the way to a terminal it doesn't recognise, and a row would be plain
  // text you can't open. set-clipboard on passes a page's copy of its link on to your
  // terminal, as tmux otherwise keeps a program's copies from it.
  ["set", "-s", "terminal-features[90]", "*:sync:hyperlinks:clipboard:extkeys"],
  ["set", "-s", "set-clipboard", "on"],
  // Extended keys, with the extkeys feature above, let Shift+Enter through as a key of its own,
  // for the agents' server to hand on, instead of as plain Enter, which sends the prompt. tmux
  // asks your terminal for them; Terminal.app can't, and still sends Enter. A modified key
  // still fires the bindings above, and the sidebar and lists, which don't ask, get keys as
  // before.
  ["set", "-s", "extended-keys", "on"],
  // The footer is a pane of its own. A screen server an older Skelcrew started, still open in
  // another terminal, drew it as tmux's border line, which would add a row under every pane.
  ["set", "-g", "pane-border-status", "off"],
  // tmux 3.8 has colour themes of its own, which grey a popup and may change other colours. The
  // screen keeps your terminal's own. An older tmux doesn't know the option, and -q keeps it
  // from refusing the whole screen over it.
  ["set", "-sq", "theme", "terminal"],
  // tmux shares a resize out among panes, so tmux itself sets the sidebar's width back after
  // each, with no process of Skelcrew's to do it.
  ["set-hook", "-g", "window-resized", `resize-pane -t :.0 -x ${sidebarWidth}`],
];

// Returns a command that runs this same Skelcrew with the given words. A Skelcrew built as a
// single file runs itself. Otherwise Bun runs this checkout's main file.
function skelcrewCommand(...words: string[]): string[] {
  const checkout = singleFile ? [] : [mainFile];
  return [process.execPath, ...checkout, ...words];
}

// Returns the command that runs the footer across the bottom of the screen whose session is
// named.
const footerCommand = (agents: string, session: string) =>
  skelcrewCommand("footer", agents, session);

// Returns the command that runs Skelcrew's sidebar, with the owner/name of the repository it opens
// on. Where Skelcrew runs goes along as a word, not in the environment: a tmux server hands its
// panes the environment of whichever terminal started it, and terminals on this server can
// come from different laptops.
const sidebarCommand = (agents: string, session: string, where: string, repository: string) =>
  skelcrewCommand("sidebar", agents, session, where, repository);

// Returns the command for the right pane while it shows an entry's list of the repository named
// by its owner/name. It gets the agents' server and the screen's session, to tell the sidebar
// what it opens, and the remote Skelcrew runs on, which decides whether a click on a page's link
// opens your browser or copies the link.
export const paneCommand = (
  agents: string,
  session: string,
  entry: Entry,
  where: string,
  repository: string,
) => skelcrewCommand("list", agents, session, entry, where, repository);

// Opens the screen in your terminal on the named agent session. `lead` is the open repository's
// lead's session and `repository` its owner/name. It returns when you leave with Alt-Q, and
// prints that your agents keep running. Each terminal gets a screen session of its own, named
// after this process, which runs as long as the terminal has it open. Agents' sessions are never
// touched.
export async function openScreen(
  agents: string,
  session: string,
  lead: string,
  repository: string,
): Promise<void> {
  const env = envWithoutTmux();
  // Reports whether this machine knows the terminal, so opening can choose a fallback.
  // tmux refuses unknown terminals, such as Ghostty's xterm-ghostty over ssh.
  // xterm-256color draws Claude Code well enough.
  const knownTerminal = (term: string) =>
    !Bun.which("infocmp") ||
    Bun.spawnSync(["infocmp", term], { stdout: "ignore", stderr: "ignore" }).success;
  if (env.TERM && !knownTerminal(env.TERM)) env.TERM = "xterm-256color";
  // The agents' server may have started under an older Skelcrew, so it gets today's settings.
  applyConfig(agents);
  // This screen's session, named by this process, and the sidebar that opens on it.
  const name = `screen-${process.pid}`;
  // The name sc --remote passes along, such as simon@workbox. Empty on this machine.
  const where = env.SKELCREW_REMOTE_NAME ?? "";
  const left = sidebarCommand(agents, name, where, repository);
  // The title is the session's own: terminals on this server can come from different laptops.
  // tmux's border between the panes is blank where it can be: the sidebar draws its own line,
  // so the border is a gap before the agent. On an older tmux it stays tmux's thin line.
  // tmux can since 3.6, and an older one refuses the whole screen over it.
  const border = tmuxIsAtLeast(3, 6) ? [["set", "-g", "pane-border-lines", "spaces"]] : [];
  // The footer's pane starts as its line and its row, or its row alone where tmux's border above
  // it is a thin line already, and sizes itself from then on.
  const footerHeight = border.length > 0 ? "2" : "1";
  const open = [
    ...config,
    ...border,
    ["new-session", "-s", name, "--", ...attachCommand(agents, session, lead)],
    ["set", "set-titles-string", windowTitle(env.SKELCREW_REMOTE_NAME)],
    ["split-window", "-hbd", "-l", String(sidebarWidth), "--", ...left],
    // The footer goes across the whole width, below both, as the screen's third pane.
    ["split-window", "-vfd", "-l", footerHeight, "--", ...footerCommand(agents, name)],
    // Ctrl-C reaches a list until it has made its terminal raw, and Bun won't stay ignoring it.
    // A pane that ended would give the whole screen to the sidebar. A dead one stays in its
    // place, and moving away starts it again.
    ["set", "-p", "-t", ":.1", "remain-on-exit", "on"],
  ];
  // The lone ";" separates tmux commands.
  const commands = open.flatMap((command) => [...command, ";"]).slice(0, -1);
  const argv = ["tmux", "-L", screenSocket(agents), "-f", "/dev/null", ...commands];
  // tmux runs in your terminal until you leave. Only a screen that couldn't open is an error.
  const code = await Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (code !== 0) throw new Error(`couldn't open the screen: tmux exited with ${code}`);
  console.log("Your agents keep running. Run sc to come back.");
}
