// The screen: the sidebar on the left of your terminal, with the lead or the task you are on at
// the right, the version and the tabs above them and the footer across the bottom. It is a
// second tmux server, one session per open terminal, ended when you leave.
import type { Database } from "bun:sqlite";
import { applyConfig, attachCommand } from "../agents/sessions.ts";
import { envWithoutTmux, screenSocket } from "../agents/tmux.ts";
import { openDb } from "../db.ts";
import { leadOf } from "../flow/lead.ts";
import { listShare, listWidth } from "../list/layout.ts";
import { attachOnHostLine, pluginHost } from "../plugins/runtime.ts";
import { windowTitle } from "../say.ts";
import { mainFile, singleFile } from "../version.ts";
import {
  answeredFolder,
  copyDrops,
  type Drop,
  dropAnswerOption,
  dropAsk,
  dropSignalColumn,
  escapeTime,
  runWithDrops,
} from "./drops.ts";

// The screen's panes, by their place in tmux's list, which runs left to right and then down: a
// pad of one column at the left edge, the sidebar, the right side, a pad at the right edge, and
// the footer across the bottom. tmux draws its lines only between panes, so the pads are what
// give each side a whole box, its outer edges included.
export const panes = { leftPad: 0, sidebar: 1, right: 2, rightPad: 3, footer: 4 };

// Returns how wide the sidebar's side is in a terminal `width` columns wide, from the left edge
// of the terminal up to the line the two sides share: as wide as sc --list's list, as both show
// the same rows. On a terminal too narrow for that beside half the terminal, it narrows to what
// the right side leaves, as the lead or an agent there must stay usable.
export const sidebarFor = (width: number) =>
  Math.min(listWidth(width), Math.floor((width - 1) / 2));

// The width of the sidebar's own pane as a tmux format, which tmux works out itself on each
// resize, from the window's width. Its steps are those of the function above, from the narrowest
// terminal up, less the pad and the line at the sidebar's left.
const { percent, least, most } = listShare;
const share = `#{e|/:#{e|*:#{window_width},${percent}},100}`;
const sidebarFormat = [
  "#{e|-:",
  `#{?#{e|<:#{window_width},${2 * least + 1}},#{e|/:#{e|-:#{window_width},1},2},`,
  `#{?#{e|<:${share},${least}},${least},`,
  `#{?#{e|>:${share},${most}},${most},${share}}}}`,
  ",2}",
].join("");

// What runs in the pads at the edges: nothing that draws or ends, as a pad only makes room for
// tmux's line beside it. A pane whose program ended would close and give its column away.
const padCommand = ["sh", "-c", "exec cat >/dev/null"];

// The colour of the box around the side your typing goes to, and of the other side's lines,
// which only part the screen. A fixed blue, as it reads on a light theme as on a dark one, and
// no mark or word uses blue. The dim lines are the theme's own grey.
export const [lit, dim] = ["colour33", "brightblack"];

// A word in the command of a right side attached to a builder. The screen's tmux finds it there,
// so Ctrl-\ ends only that attachment, never the lead or a task's details.
export const attachedMark = "skelcrew-attached";

// The sidebar's pane and the right side's, as tmux targets in the session a command runs in.
const toSidebar = `:.${panes.sidebar}`;
const toRight = `:.${panes.right}`;

// Returns the name of the screen's session in one terminal. sc --remote picks the name on your
// laptop and passes it along, so it can ask which agent shows. Otherwise it is this process's.
export function screenName(given: string | undefined): string {
  return given !== undefined && /^screen-[\w-]+$/.test(given) ? given : `screen-${process.pid}`;
}

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
  // agents' server or a host's own client, it would detach it and leave the right side empty.
  // It brings your typing back to the sidebar instead. On a builder you attached to on the right
  // side, found by the mark in the right pane's command, it ends that attachment, and the pane
  // goes back to the task's details with your typing in the sidebar. Anywhere else it tells the
  // sidebar, as the byte Ctrl-\ sends, and the sidebar takes your typing. It looks at the right
  // pane, not the one you type to, so it ends an attachment with your typing in the sidebar too.
  // Ctrl-4 does the same: a terminal sending extended keys sends it as a key of its own, which
  // tmux would hand on to the pane as Ctrl-\'s byte.
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
    toRight,
    `#{m:*${attachedMark}*,#{pane_start_command}}`,
    `run-shell -t ${toRight} 'pkill -P #{pane_pid}'`,
    `send-keys -t ${toSidebar} -H 1c`,
  ]),
  // Shift-Enter in the sidebar attaches full screen to the agent of the row you are on. tmux reads
  // it from your terminal as a key of its own, by the extended keys below, but hands the sidebar
  // only plain Enter, as the sidebar never asks for extended keys. So it is typed into the
  // sidebar as the CSI-u sequence the sidebar knows. Anywhere else it goes on to the pane, as
  // Claude Code takes Shift-Enter for a new line in its prompt.
  [
    "bind",
    "-n",
    "S-Enter",
    "if",
    "-F",
    `#{==:#{pane_index},${panes.sidebar}}`,
    `send-keys -t ${toSidebar} -H 1b 5b 31 33 3b 32 75`,
    "send-keys S-Enter",
  ],
  // Keys that arrive faster than a millisecond apart are taken for a paste, and tmux then hands
  // them to the pane you type to rather than act on them. Several Alt keys in one read, as fast
  // typing, key repeat or a slow link bring, would lose all but the first two, and type the rest
  // into the agent. A paste that matters comes bracketed anyway.
  ["set", "-g", "assume-paste-time", "0"],
  // tmux waits this long for the rest of a sequence cut off after its Esc. It is set, as its
  // default was 500 ms before tmux 3.5, so it matches the wait of the layer that sees your pastes
  // first: a paste start that layer lets go of unfinished is never one tmux still reads as a paste.
  ["set", "-s", "escape-time", String(escapeTime)],
  // Alt-Up and Alt-Down, with or without Shift, Alt-Shift-Left and Alt-Shift-Right, and Alt-0 to
  // Alt-6, which open and close the task queue and the stages, go to the sidebar, in its own pane,
  // without moving your typing from the agent. Plain Alt-Left and Alt-Right stay the agent's, as
  // they move a word in its prompt, and so do Alt-B and Alt-F, which is how tmux reads the Esc b
  // and Esc f a Mac terminal often sends for Option-Left and Option-Right.
  ["bind", "-n", "M-Up", "send-keys", "-t", toSidebar, "M-Up"],
  ["bind", "-n", "M-Down", "send-keys", "-t", toSidebar, "M-Down"],
  ["bind", "-n", "M-S-Up", "send-keys", "-t", toSidebar, "M-S-Up"],
  ["bind", "-n", "M-S-Down", "send-keys", "-t", toSidebar, "M-S-Down"],
  ["bind", "-n", "M-S-Left", "send-keys", "-t", toSidebar, "M-S-Left"],
  ["bind", "-n", "M-S-Right", "send-keys", "-t", toSidebar, "M-S-Right"],
  ...["0", "1", "2", "3", "4", "5", "6"].map((digit) => [
    "bind",
    "-n",
    `M-${digit}`,
    "send-keys",
    "-t",
    toSidebar,
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
    `send-keys -t ${toSidebar} -l "\x1b]skel-tab;#{mouse_status_range}\x07"`,
  ]),
  // A right click on the top row, at a column past the edge of any real terminal, is how a file
  // dropped onto the screen asks the sidebar which agent it goes to, after the keys typed before
  // it. A real right click there does nothing, as before. tmux names the click by the part of the
  // row it hit, so each name is bound.
  ...["", "Default", "Left", "Right"].map((part) => [
    "bind",
    "-n",
    `MouseDown3Status${part}`,
    "if",
    "-F",
    `#{==:#{mouse_x},${dropSignalColumn}}`,
    `send-keys -t ${toSidebar} -l "${dropAsk}"`,
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
  // A drag over the agent that is let go over the sidebar, the footer or the top row would end in
  // that other place, and the agents' server would wait for a release that never comes, copying
  // nothing. So the agent's pane gets the drag's end at its nearest edge: the start of the same row
  // beside the sidebar or the pad at its left, the top left under the top row, the end of its last
  // row above the footer. It is a move there and a release, as tmux ends a selection where the last
  // move was, and ignores a place outside its window. Lists and the sidebar act only on presses, so
  // a stray release there does nothing.
  [
    "bind",
    "-n",
    "MouseDragEnd1Pane",
    "if",
    "-F",
    `#{==:#{pane_index},${panes.right}}`,
    "send-keys -M",
    `if -F "#{e|<:#{pane_index},${panes.right}}" { run-shell -C 'send-keys -t ${toRight} -l "\x1b[<32;1;#{e|+:#{mouse_y},1}M\x1b[<0;1;#{e|+:#{mouse_y},1}m"' } { run-shell -C -t ${toRight} 'send-keys -t ${toRight} -l "\x1b[<32;#{pane_width};#{pane_height}M\x1b[<0;#{pane_width};#{pane_height}m"' }`,
  ],
  [
    "bind",
    "-n",
    "MouseDragEnd1Status",
    "send-keys",
    "-t",
    toRight,
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
  // They reach a pane that asks as CSI-u, as on the agents' server. A tmux older than 3.5 has
  // only its own form, and -q keeps it from refusing the whole screen over the option.
  ["set", "-s", "extended-keys", "on"],
  ["set", "-sq", "extended-keys-format", "csi-u"],
  // The footer is a pane of its own. A screen server an older Skelcrew started, still open in
  // another terminal, drew it as tmux's border line, which would add a row under every pane.
  ["set", "-g", "pane-border-status", "off"],
  // The box that shows where your typing goes is tmux's own lines between the panes, which tmux
  // draws in the active style all round the pane you type to, corners included, and dim
  // elsewhere. The top row carries them up, as tmux draws no line above a pane. An older
  // Skelcrew's screen, still open in another terminal, may have made the lines blank.
  ["set", "-g", "pane-border-lines", "single"],
  ["set", "-g", "pane-active-border-style", `fg=${lit}`],
  ["set", "-g", "pane-border-style", `fg=${dim}`],
  // tmux 3.8 has colour themes of its own, which grey a popup and may change other colours. The
  // screen keeps your terminal's own. An older tmux doesn't know the option, and -q keeps it
  // from refusing the whole screen over it.
  ["set", "-sq", "theme", "terminal"],
  // tmux shares a resize out among panes, so tmux itself sets the pads and the sidebar's width
  // back after each, with no process of Skelcrew's to do it. run-shell -C works out the width's
  // format first, as resize-pane takes only a number.
  [
    "set-hook",
    "-g",
    "window-resized",
    [
      `resize-pane -t :.${panes.leftPad} -x 1`,
      `resize-pane -t :.${panes.rightPad} -x 1`,
      `run-shell -C "resize-pane -t ${toSidebar} -x ${sidebarFormat}"`,
    ].join(" ; "),
  ],
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
  // This screen's session, and the sidebar that opens on it.
  const name = screenName(env.SKELCREW_SCREEN_NAME);
  // The name sc --remote passes along, such as simon@workbox. Empty on this machine.
  const where = env.SKELCREW_REMOTE_NAME ?? "";
  // The title is the session's own: terminals on this server can come from different laptops.
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
    ["new-session", "-s", name, "--", ...right],
    ["set", "set-titles-string", windowTitle(env.SKELCREW_REMOTE_NAME)],
    // The sidebar's side, then its pad split off at its left, which leaves the sidebar's pane
    // that much narrower and the line the sides share where it was. The right side's pad comes
    // off the right side in the same way. Each split goes into tmux's list beside the pane it
    // splits, so the panes keep the places `panes` gives.
    ["split-window", "-hbd", "-l", String(sidebarFor(process.stdout.columns || 80)), "--", ...left],
    ["split-window", "-hbd", "-l", "1", "-t", ":.0", "--", ...padCommand],
    ["split-window", "-hd", "-l", "1", "-t", toRight, "--", ...padCommand],
    // The footer goes across the whole width, below both sides, as the last pane. It is one row,
    // as tmux's line above it closes both boxes.
    ["split-window", "-vfd", "-l", "1", "--", ...footerCommand(agents, name)],
    // A pane that ended, such as one Ctrl-C stopped, would give the whole screen to the
    // sidebar. A dead one stays in its place, and moving away starts it again.
    ["set", "-p", "-t", toRight, "remain-on-exit", "on"],
  ];
  // The lone ";" separates tmux commands.
  const commands = open.flatMap((command) => [...command, ";"]).slice(0, -1);
  const argv = ["tmux", "-L", screenSocket(agents), "-f", "/dev/null", ...commands];
  // tmux runs in your terminal until you leave. Only a screen that couldn't open is an error.
  // Files dropped onto the screen are copied into the folder of the agent your typing goes to,
  // once the sidebar answers, and to none while your typing goes to the sidebar. A sidebar that
  // doesn't answer within two seconds leaves the paste as it came.
  // Reads the sidebar's last answer. It never holds up the screen, and a tmux that doesn't answer
  // within a second is stopped, so a drop never waits on it for long.
  const answer = async () => {
    const asked = ["display", "-p", "-t", `=${name}:`, `#{${dropAnswerOption}}`];
    const run = Bun.spawn(["tmux", "-L", screenSocket(agents), ...asked], {
      env,
      stdout: "pipe",
      stderr: "ignore",
    });
    const stop = setTimeout(() => run.kill(), 1000);
    const said = await new Response(run.stdout).text();
    clearTimeout(stop);
    return said.trim();
  };
  const drop: Drop = {
    where: async (ask) => {
      const before = await answer();
      ask();
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        await Bun.sleep(10);
        const now = await answer();
        if (now !== before) return answeredFolder(now);
      }
      return null;
    },
    put: async (folder, files) => copyDrops(folder, files),
  };
  // A screen opened from a laptop with sc --remote leaves drops to the laptop's sc, as a file you
  // drop is on the laptop. A path in such a paste that names a file here too must never bring
  // this machine's file to the agent.
  const code =
    where === ""
      ? await runWithDrops(argv, drop, env)
      : await Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (code !== 0) throw new Error(`couldn't open the screen: tmux exited with ${code}`);
  // tmux says [exited] on its way out, straight to your terminal, which reads like something went
  // wrong. Its line is the one above, so it is cleared, and the line saying what happened takes
  // its place.
  if (process.stdout.isTTY) process.stdout.write("\x1b[1A\r\x1b[2K");
  console.log("Your agents keep running. Run sc to come back.");
}
