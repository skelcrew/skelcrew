// The screen: the sidebar on the left of your terminal, with the lead or the task you are on at
// the right, the version and the tabs above them and the footer across the bottom. It is a
// second tmux server, one session per open terminal, ended when you leave.
import type { Database } from "bun:sqlite";
import { applyConfig, attachCommand } from "../agents/sessions.ts";
import { envWithoutTmux, screenSocket, tmuxIsAtLeast } from "../agents/tmux.ts";
import { openDb } from "../db.ts";
import { leadOf } from "../flow/lead.ts";
import { listShare, listWidth } from "../list/layout.ts";
import { attachOnHostLine, pluginHost } from "../plugins/runtime.ts";
import { windowTitle } from "../say.ts";
import { mainFile, singleFile } from "../version.ts";

// Returns how wide the sidebar is, with the line it draws at its edge, in a terminal `width`
// columns wide: as wide as sc --list's list, as both show the same rows. On a terminal too narrow
// for that beside half the terminal, it narrows to what the right side leaves, as the lead or an
// agent there must stay usable.
export const sidebarFor = (width: number) =>
  Math.min(listWidth(width), Math.floor((width - 1) / 2));

// The same width as a tmux format, which tmux works out itself on each resize, from the window's
// width. Its steps are those of the two functions above, from the narrowest terminal up.
const { percent, least, most } = listShare;
const share = `#{e|/:#{e|*:#{window_width},${percent}},100}`;
const sidebarFormat = [
  `#{?#{e|<:#{window_width},${2 * least + 1}},#{e|/:#{e|-:#{window_width},1},2},`,
  `#{?#{e|<:${share},${least}},${least},`,
  `#{?#{e|>:${share},${most}},${most},${share}}}}`,
].join("");

// A word in the command of a right side attached to a builder. The screen's tmux finds it there,
// so Ctrl-\ ends only that attachment, never the lead or a task's details.
export const attachedMark = "skelcrew-attached";

// The tmux commands that set up the screen's server. They run each time the screen opens,
// before its session starts, so a first draw never shows tmux's own look. Your own ~/.tmux.conf
// never applies.
const config = [
  // tmux's one status line is at the top, so the agent's height stays the same on every
  // session. The header and the tabs share it. It starts empty, as the sidebar fills
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
  // Mac terminal that doesn't send Option as Alt. Ctrl-\ never reaches a pane: left to reach the
  // agents' server or a host's own client, it would detach it and leave the right side empty. On
  // a builder you attached to on the right side, it ends that attachment instead, found by the
  // mark in the right pane's command, and the pane goes back to the task's details. It looks at
  // the right pane, not the one you type to, so it works with your typing in the sidebar too.
  // Anywhere else it does nothing. Ctrl-4 does the same: a terminal sending extended keys sends it as a key of its
  // own, which tmux would hand on to the pane as Ctrl-\'s byte.
  // Each key that leaves ends your terminal's session rather than detaching from it. tmux 3.6
  // crashed about one time in five when a detach met another command, such as the sidebar's,
  // ending at that moment, and every terminal on the server lost its screen.
  ["set", "-g", "prefix", "None"],
  ["set", "-g", "prefix2", "None"],
  ["unbind", "-a", "-T", "root"],
  ["bind", "-n", "M-q", "kill-session"],
  ["bind", "-n", "C-q", "kill-session"],
  ...["C-\\", "C-4"].map((key) => [
    "bind",
    "-n",
    key,
    "if",
    "-F",
    "-t",
    ":.1",
    `#{m:*${attachedMark}*,#{pane_start_command}}`,
    "run-shell -t :.1 'pkill -P #{pane_pid}'",
  ]),
  // Keys that arrive faster than a millisecond apart are taken for a paste, and tmux then hands
  // them to the pane you type to rather than act on them. Several Alt keys in one read, as fast
  // typing, key repeat or a slow link bring, would lose all but the first two, and type the rest
  // into the agent. A paste that matters comes bracketed anyway.
  ["set", "-g", "assume-paste-time", "0"],
  // Alt-Up and Alt-Down, with or without Shift, Alt-Shift-Left and Alt-Shift-Right, and Alt-1 to
  // Alt-6, which open and close the stages, go to the sidebar, in pane 0, without moving your
  // typing from the agent. Alt-Left and Alt-Right go there too, and the sidebar moves your typing
  // to itself or back to the agent. They move a word in an agent's prompt, but on a Mac they are
  // the only way to the sidebar, as Option with a digit types a character. A Mac terminal often
  // sends Option-Left and Option-Right as Esc b and Esc f, which tmux reads as Alt-B and Alt-F, so
  // those are taken too, and reach the sidebar as Alt-Left and Alt-Right.
  ["bind", "-n", "M-Left", "send-keys", "-t", ":.0", "M-Left"],
  ["bind", "-n", "M-Right", "send-keys", "-t", ":.0", "M-Right"],
  ["bind", "-n", "M-b", "send-keys", "-t", ":.0", "M-Left"],
  ["bind", "-n", "M-f", "send-keys", "-t", ":.0", "M-Right"],
  ["bind", "-n", "M-Up", "send-keys", "-t", ":.0", "M-Up"],
  ["bind", "-n", "M-Down", "send-keys", "-t", ":.0", "M-Down"],
  ["bind", "-n", "M-S-Up", "send-keys", "-t", ":.0", "M-S-Up"],
  ["bind", "-n", "M-S-Down", "send-keys", "-t", ":.0", "M-S-Down"],
  ["bind", "-n", "M-S-Left", "send-keys", "-t", ":.0", "M-S-Left"],
  ["bind", "-n", "M-S-Right", "send-keys", "-t", ":.0", "M-S-Right"],
  ...["1", "2", "3", "4", "5", "6"].map((digit) => [
    "bind",
    "-n",
    `M-${digit}`,
    "send-keys",
    "-t",
    ":.0",
    `M-${digit}`,
  ]),
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
  // Ends a session as its client goes, by a terminal or ssh link that drops, and the server goes
  // with its last session. It would also end a session made detached, so the
  // session is made attached, in one go.
  ["set", "-g", "destroy-unattached", "on"],
  // xterm-256color, unlike tmux's default, tells the client in the right pane that it may use
  // colour and more, and every machine knows it.
  ["set", "-g", "default-terminal", "xterm-256color"],
  // Synchronized output, as on the agents' server, so this server's redraws reach your terminal
  // whole too. Terminal links and the clipboard are turned on for every terminal: left alone,
  // tmux drops them on the way to a terminal it doesn't recognise. set-clipboard on passes the
  // sidebar's copy of a PR's link on to your terminal, as tmux otherwise keeps a program's
  // copies from it.
  ["set", "-s", "terminal-features[90]", "*:sync:hyperlinks:clipboard:extkeys"],
  ["set", "-s", "set-clipboard", "on"],
  // Extended keys, with the extkeys feature above, let Shift+Enter through as a key of its own,
  // for the agents' server to hand on, instead of as plain Enter, which sends the prompt. tmux
  // asks your terminal for them; Terminal.app can't, and still sends Enter. A modified key
  // still fires the bindings above, and the sidebar, which doesn't ask, gets keys as before.
  ["set", "-s", "extended-keys", "on"],
  // The footer is a pane of its own. A screen server an older Skelcrew started, still open in
  // another terminal, drew it as tmux's border line, which would add a row under every pane.
  ["set", "-g", "pane-border-status", "off"],
  // tmux 3.8 has colour themes of its own, which grey a popup and may change other colours. The
  // screen keeps your terminal's own. An older tmux doesn't know the option, and -q keeps it
  // from refusing the whole screen over it.
  ["set", "-sq", "theme", "terminal"],
  // tmux shares a resize out among panes, so tmux itself sets the sidebar's width back after
  // each, with no process of Skelcrew's to do it. run-shell -C works out the width's format
  // first, as resize-pane takes only a number.
  ["set-hook", "-g", "window-resized", `run-shell -C "resize-pane -t :.0 -x ${sidebarFormat}"`],
];

// Returns a command that runs this same Skelcrew with the given words. A Skelcrew built as a
// single file runs itself. Otherwise Bun runs this checkout's main file.
export function skelcrewCommand(...words: string[]): string[] {
  const checkout = singleFile ? [] : [mainFile];
  return [process.execPath, ...checkout, ...words];
}

// Returns the command that runs the footer across the bottom of the screen whose session is
// named.
const footerCommand = (agents: string, session: string) =>
  skelcrewCommand("footer", agents, session);

// Returns the command that runs Skelcrew's sidebar, with the owner/name of the repository it opens
// on, and the line the right pane attaches to its lead's host with, empty for tmux. The sidebar
// starts from that line rather than reading the host itself: the daemon can move the lead in
// between, and the sidebar would then think the right pane already shows it. Where Skelcrew runs
// goes along as a word, not in the environment: a tmux server hands its panes the environment of
// whichever terminal started it, and terminals on this server can come from different laptops.
const sidebarCommand = (
  agents: string,
  session: string,
  where: string,
  repository: string,
  onHost: string,
) => skelcrewCommand("sidebar", agents, session, where, repository, onHost);

// Returns the line for sh that attaches to a repository's lead when it runs on a runtime
// plugin's host, as the screen's tmux can't reach it. Null for a lead on tmux, one whose plugin
// is gone, and a repository Skelcrew no longer has.
export function leadOnHost(
  db: Database,
  { owner, repo }: { owner: string; repo: string },
): string | null {
  try {
    const { host, hostId, name } = leadOf(db, owner, repo);
    if (host === "tmux") return null;
    const plugin = pluginHost(db, host);
    return plugin && attachOnHostLine(plugin, hostId ?? name);
  } catch {
    return null;
  }
}

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
  // The title is the session's own: terminals on this server can come from different laptops.
  // tmux's border between the panes is blank where it can be: the sidebar draws its own line,
  // so the border is a gap before the agent. On an older tmux it stays tmux's thin line.
  // tmux can since 3.6, and an older one refuses the whole screen over it.
  const border = tmuxIsAtLeast(3, 6) ? [["set", "-g", "pane-border-lines", "spaces"]] : [];
  // The footer's pane starts as its line and its row, or its row alone where tmux's border above
  // it is a thin line already, and sizes itself from then on.
  const footerHeight = border.length > 0 ? "2" : "1";
  // The right side shows the lead. A lead on a runtime plugin's host is reached through the
  // host's own attach, started again whenever it ends, as tmux's attach to the lead is.
  const [owner = "", repo = ""] = repository.split("/");
  const onHost = leadOnHost(openDb(), { owner, repo });
  const right =
    onHost === null
      ? attachCommand(agents, session, lead)
      : ["sh", "-c", `while :; do ${onHost}; sleep 1; done`];
  const left = sidebarCommand(agents, name, where, repository, onHost ?? "");
  const open = [
    ...config,
    ...border,
    ["new-session", "-s", name, "--", ...right],
    ["set", "set-titles-string", windowTitle(env.SKELCREW_REMOTE_NAME)],
    ["split-window", "-hbd", "-l", String(sidebarFor(process.stdout.columns || 80)), "--", ...left],
    // The footer goes across the whole width, below both, as the screen's third pane.
    ["split-window", "-vfd", "-l", footerHeight, "--", ...footerCommand(agents, name)],
    // A pane that ended, such as one Ctrl-C stopped, would give the whole screen to the
    // sidebar. A dead one stays in its place, and moving away starts it again.
    ["set", "-p", "-t", ":.1", "remain-on-exit", "on"],
  ];
  // The lone ";" separates tmux commands.
  const commands = open.flatMap((command) => [...command, ";"]).slice(0, -1);
  const argv = ["tmux", "-L", screenSocket(agents), "-f", "/dev/null", ...commands];
  // tmux runs in your terminal until you leave. Only a screen that couldn't open is an error.
  const code = await Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (code !== 0) throw new Error(`couldn't open the screen: tmux exited with ${code}`);
  // tmux says [exited] on its way out, straight to your terminal, which reads like something went
  // wrong. Its line is the one above, so it is cleared, and the line saying what happened takes
  // its place.
  if (process.stdout.isTTY) process.stdout.write("\x1b[1A\r\x1b[2K");
  console.log("Your agents keep running. Run sc to come back.");
}
