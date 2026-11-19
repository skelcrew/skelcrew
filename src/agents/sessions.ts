// The sessions module: runs each agent, a repository's lead or a thread's builder, in a terminal
// session of its own, lets you attach to it, and finds it again after a restart. Its built-in is
// tmux, on Skelcrew's own tmux server (`tmux -L skelcrew`; tests pass a socket of their own). A
// runtime plugin that provides sessions can host them instead: each function that takes a host
// asks that plugin when the host is one. What goes in and out is plain data, so the rest of
// Skelcrew never deals with tmux or a plugin for its agents.
import { closeSync, constants, openSync, rmSync, writeSync } from "node:fs";
import { z } from "zod";
import { askHost, type Host, type PluginHost } from "../plugins/runtime.ts";
import { sandboxFolders } from "./seatbelt.ts";
import { envWithoutTmux, mustTmux, tmux, tmuxIsAtLeast } from "./tmux.ts";

// What every session carries, so Skelcrew can tell whose it is: its repository, as owner/name,
// its role, and for a builder its thread's task, such as app-12.
export const Labels = z.object({
  repository: z.string().min(1),
  role: z.enum(["lead", "builder"]),
  task: z.string().min(1).optional(),
});
export type Labels = z.infer<typeof Labels>;

// Skelcrew's tmux settings. They are sent on stdin with each new session instead of kept in a
// file, so there is no file to find or keep in step, and a server that outlives an upgrade
// picks up changes. Your own ~/.tmux.conf never applies: -f /dev/null replaces it. Ctrl-\ with
// no prefix and no status bar make attaching feel like being inside Claude Code. Ctrl-\ is
// herdr's key to detach, so an agent is left the same way on either host. tmux reads it however
// your terminal sends it, as one byte or as an extended key, and in pieces over a slow link.
// Ctrl-4 sends the same byte, for a keyboard where backslash needs AltGr. Alt-Q and Ctrl-Q,
// which an older Skelcrew bound, are unbound on a server it left running. A session whose
// command fails keeps its last screen, so Skelcrew can say why it ended instead
// of finding it gone. tmux only passes synchronized output on to terminals it knows have it, and
// without it Claude Code's redraws arrive in pieces, so the prompt flickers over a slow link.
// Terminals without it ignore the codes. That setting has a fixed index, since these settings
// run again with each new session, and appending would add it every time.
//
// The wheel scrolls back through an agent's output. Claude Code draws in one of two ways. Its
// classic drawing leaves its output in tmux's history, so copy mode shows it. Its full-screen
// drawing keeps its own, and asks for the mouse, so the wheel goes to it. A program on the
// alternate screen that didn't ask has no history here, so it gets arrow keys, as a terminal
// would send it. Copy mode's own keys are all gone, as they would swallow what you type and
// leave you wondering why the agent doesn't answer: any key goes back to the live agent and
// reaches it too, as send-keys alone sends the key that ran it. A copy can leave copy mode in
// the moment before that key, so the key leaves it only if it is still there. mode-keys is set
// to emacs because when $EDITOR says vi, tmux uses vi's copy-mode table, which these bindings
// don't touch. In copy mode tmux looks only in copy mode's table, never at the keys bound
// without a prefix, so Ctrl-\ is bound there too. Otherwise an agent you scrolled back would
// keep you, and get the key typed into it.
//
// Extended keys let Shift+Enter reach the agent as a key of its own, which Claude Code and
// Codex take for a newline. Without them, tmux reads it from your terminal as plain Enter, and
// the prompt is sent. The extkeys feature makes tmux ask your terminal for them, or the screen
// in front of this server; a terminal that can't, such as Terminal.app, still sends Enter.
// tmux hands them on only to an agent that asked for them. Claude Code asks only when it can
// tell it runs in tmux, which is why a session keeps tmux's TERM_PROGRAM.
//
// A drag over an agent selects its text, a double click a word and a triple click a line, and
// letting go copies it to your terminal's clipboard, as OSC 52, which reaches a laptop over
// ssh too. The clipboard feature lets tmux send it to the screen in front, or any terminal. An
// agent that asked for the mouse, such as Claude Code's full-screen drawing, gets the mouse
// itself, and copies on its own by OSC 52, which set-clipboard on passes on. tmux answers any
// program that asks for the clipboard with its newest copy, so an agent could read what you
// copied from another. So the server keeps no copy: each is deleted as soon as it is sent. In
// copy mode a press clears the selection and a release does nothing, as either would
// otherwise count as a key and leave copy mode.
//
// Copies what is selected, then goes back to the live agent, or stays where you scrolled back
// to. The pause shows the selection a moment, and is needed: tmux sends nothing to the
// terminal while the pane waits to be drawn again, as it does just after a double click
// entered copy mode.
const copied = `run-shell -d 0.3; send-keys -X copy-selection-no-clear; delete-buffer
  if -F "#{==:#{scroll_position},0}" { send-keys -X cancel }`;
const tmuxConfig = `set -g status off
unbind -n M-q
unbind -n C-q
bind -n C-\\\\ detach-client
set -g remain-on-exit failed
set -s terminal-features[90] "*:sync:extkeys:clipboard"
set -s extended-keys on
set -s set-clipboard on
set-hook -g pane-set-clipboard delete-buffer
set -g mouse on
set -g mode-keys emacs
bind -n WheelUpPane {
  if -F "#{mouse_any_flag}" { send-keys -M } {
    if -F "#{alternate_on}" { send-keys Up } { copy-mode -e; send-keys -X -N 5 scroll-up }
  }
}
bind -n WheelDownPane {
  if -F "#{mouse_any_flag}" { send-keys -M } { if -F "#{alternate_on}" { send-keys Down } }
}
bind -n MouseDrag1Pane { if -F "#{mouse_any_flag}" { send-keys -M } { copy-mode -M } }
bind -n DoubleClick1Pane {
  if -F "#{mouse_any_flag}" { send-keys -M } { copy-mode -H; send-keys -X select-word; ${copied} }
}
bind -n TripleClick1Pane {
  if -F "#{mouse_any_flag}" { send-keys -M } { copy-mode -H; send-keys -X select-line; ${copied} }
}
unbind -a -T copy-mode
bind -T copy-mode C-\\\\ detach-client
bind -T copy-mode WheelUpPane send-keys -X -N 5 scroll-up
bind -T copy-mode WheelDownPane send-keys -X -N 5 scroll-down
bind -T copy-mode MouseDown1Pane send-keys -X clear-selection
bind -T copy-mode MouseUp1Pane select-pane
bind -T copy-mode MouseDrag1Pane send-keys -X begin-selection
bind -T copy-mode MouseDragEnd1Pane { ${copied} }
bind -T copy-mode DoubleClick1Pane { send-keys -X select-word; ${copied} }
bind -T copy-mode TripleClick1Pane { send-keys -X select-line; ${copied} }
bind -T copy-mode Any { if -F "#{pane_in_mode}" { send-keys -X cancel }; send-keys }
`;

// Returns Skelcrew's tmux settings for this machine's tmux. tmux sends extended keys in the
// xterm form unless told otherwise, and Codex reads Shift+Enter only in the CSI u form, which
// Claude Code reads too. tmux before 3.5 has only the xterm form, and refuses the setting.
function settings(): string {
  return tmuxIsAtLeast(3, 5) ? `${tmuxConfig}set -s extended-keys-format csi-u\n` : tmuxConfig;
}

// Starts Skelcrew's tmux server if needed, keeping agent sessions alive independently of the
// daemon. A server started by the daemon would live in skelcrew.service's cgroup, so stopping
// or OOM-killing the service would take every agent with it. A systemd scope of its own
// keeps it apart; without systemd it starts plainly.
// exit-empty off keeps it up until its first session, and the config applies to that
// session too.
function startServer(socket: string): void {
  // A server that answers is already up, and keeps its sessions.
  if (tmux(socket, ["list-sessions"]).ok) return;
  // The lone ";" separates tmux commands, so these words go to tmux as they are, not through
  // tmux(), which would quote it.
  const start = ["tmux", "-L", socket, "-f", "/dev/null", "start-server", ";"];
  start.push("set-option", "-g", "exit-empty", "off", ";", "source-file", "-");
  const scope = [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    `--unit=skelcrew-tmux-${socket}`,
    "--",
  ];
  // Starts the server with Skelcrew's configuration, either in its own scope or directly.
  const run = (command: string[]) =>
    Bun.spawnSync(command, {
      env: envWithoutTmux(),
      stdin: new Blob([settings()]),
      stdout: "pipe",
      stderr: "pipe",
    });
  if (Bun.which("systemd-run") && run([...scope, ...start]).success) return;
  const plain = run(start);
  if (!plain.success)
    throw new Error(`tmux start-server failed: ${plain.stderr.toString().trim()}`);
}

// Starts a named agent session with only its supplied environment, its labels and Skelcrew's
// terminal settings, starting Skelcrew's tmux server first if it isn't up, and returns the
// session's ID on its host. On tmux the ID is the name. A plugin's host gives its own, and is
// handed the name and labels to show. With `keepOnExit`, the session stays when its agent exits
// cleanly too, so Skelcrew can tell a lead you exited from one that crashed: the first closes its
// tab, the second doesn't. Only leads ask for that, and they run on tmux.
export async function startSession(
  host: Host,
  name: string,
  session: {
    folder: string;
    command: string[];
    env: Record<string, string>;
    labels: Labels;
    keepOnExit?: boolean;
  },
): Promise<string> {
  if (typeof host !== "string") {
    const { folder, command, env, labels } = session;
    const question = { ask: "start", name, folder, command, env, labels };
    return (await askHost(host, question, z.object({ id: z.string().min(1) }))).id;
  }
  const socket = host;
  startServer(socket);
  // tmux would quietly rename the session, and then never find it under the name asked for.
  if (/[.:]/.test(name)) throw new Error(`a session can't be named ${name}: tmux changes . and :`);
  // The server hands its own environment to every session and -e only adds to it, so a
  // token the daemon has would reach the agent. env -i starts from nothing. TERM and
  // TERM_PROGRAM are the values the pane's own must win for: tmux sets TERM to what it draws,
  // and TERM_PROGRAM to tmux. Claude Code asks for Shift+Enter as a key of its own only when
  // TERM_PROGRAM or TMUX says tmux, so without it Shift+Enter sends the prompt.
  const env = Object.entries(session.env).flatMap(([key, value]) =>
    key === "TERM" || key === "TERM_PROGRAM" ? [] : [`${key}=${value}`],
  );
  const keep = 'TERM="$TERM" TERM_PROGRAM="$TERM_PROGRAM"';
  const clean = ["sh", "-c", `exec env -i ${keep} "$@"`, "sh", ...env];
  // With a single word, tmux would run the command through a shell, so sh always goes
  // first.
  const start = ["new-session", "-d", "-s", name, "-c", session.folder];
  mustTmux(socket, [...start, "--", ...clean, ...session.command]);
  mustTmux(socket, ["source-file", "-"], settings());
  // On a Mac the sandbox's folders are removed by a shell that a SIGKILL takes with it, so
  // the session keeps their names for stopSession to remove them.
  const folders = sandboxFolders(session.command);
  if (folders.length > 0)
    mustTmux(socket, [
      "set-option",
      "-t",
      `=${name}:`,
      "@sandbox-folders",
      JSON.stringify(folders),
    ]);
  // The labels go on the session as tmux user options, which it keeps for as long as it lives,
  // so listSessions finds them after a restart. An agent that has already exited took its
  // session with it, and then has nothing to label, which is no error.
  const { repository, role, task } = session.labels;
  const label = (option: string, value: string) =>
    tmux(socket, ["set-option", "-t", `=${name}:`, `@skelcrew-${option}`, value]);
  label("repository", repository);
  label("role", role);
  if (task) label("task", task);
  if (session.keepOnExit) keepOnExit(socket, name);
  return name;
}

// Has a session stay when its agent exits cleanly too, so Skelcrew can read how it ended. The
// window's own setting wins over the server's, which keeps only failed sessions. An agent that
// exits before this is set takes its session with it, which reads as a crash, never as a clean
// exit.
export function keepOnExit(socket: string, name: string): void {
  tmux(socket, ["set", "-w", "-t", `=${name}:`, "remain-on-exit", "on"]);
}

// Gives a running tmux server Skelcrew's settings, so one that outlived an upgrade scrolls too.
// Quietly does nothing without a server. It also turns on extended keys for every agent that
// never asked for them: a Claude Code started before sessions kept TERM_PROGRAM, which would
// otherwise send the prompt on Shift+Enter until it restarts. Codex, the other harness, always
// asks, so only those are left.
export function applyConfig(socket: string): void {
  tmux(socket, ["source-file", "-"], settings());
  // The request goes into the pane's terminal, where tmux reads it as if the agent had sent
  // it. A tmux that doesn't know pane_key_mode leaves it empty, and nothing is written.
  // O_NOCTTY keeps the terminal from becoming Skelcrew's own.
  const panes = tmux(socket, [
    "list-panes",
    "-a",
    "-F",
    "#{pane_dead} #{pane_key_mode} #{pane_tty}",
  ]);
  for (const line of panes.out.split("\n")) {
    const tty = line.match(/^0 VT10x (\S+)$/)?.[1];
    if (!tty) continue;
    // A pane that ended in the meantime has no terminal left, and needs nothing.
    try {
      const fd = openSync(tty, constants.O_WRONLY | constants.O_NOCTTY);
      writeSync(fd, "\x1b[>4;2m");
      closeSync(fd);
    } catch {}
  }
}

// Returns what a plugin's host says of one of its sessions, or nothing when it has no such
// session.
const hosted = async (host: PluginHost, id: string) =>
  (await listSessions(host)).find((session) => session.name === id);

// Reports whether the exact session exists so Skelcrew can reconnect instead of starting it
// twice.
export async function hasSession(host: Host, name: string): Promise<boolean> {
  if (typeof host !== "string") return (await hosted(host, name)) !== undefined;
  // The = asks for this exact name; without it tmux also accepts a session it starts with.
  return tmux(host, ["has-session", "-t", `=${name}`]).ok;
}

// Returns an ended agent's last screen, left behind by a failed command or a session kept on
// exit, so Skelcrew can explain why the agent ended. Returns null while the command runs or no
// dead pane is found. A plugin's host gives the screen of a session it lists as ended, if it
// can still read it.
export async function failedScreen(host: Host, name: string): Promise<string | null> {
  if (typeof host !== "string") {
    if ((await hosted(host, name))?.running !== false) return null;
    try {
      return (await readSession(host, name)).trim();
    } catch {
      return "";
    }
  }
  const socket = host;
  // A pane still running its command, or no pane at all, has no last screen to give.
  if (tmux(socket, ["display-message", "-p", "-t", `=${name}:`, "#{pane_dead}"]).out.trim() !== "1")
    return null;
  // The visible screen can come back blank once the pane is dead; its history keeps the
  // text.
  return mustTmux(socket, ["capture-pane", "-p", "-S", "-", "-t", `=${name}:`]).trim();
}

// Reports whether the agent in the named session exited with code 0 and left its session
// behind, as one started with `keepOnExit` does. False while it runs, after it failed, and
// when its session is gone.
export function exitedCleanly(socket: string, name: string): boolean {
  const target = ["display-message", "-p", "-t", `=${name}:`, "#{pane_dead} #{pane_dead_status}"];
  return tmux(socket, target).out.trim() === "1 0";
}

// Ends the named tmux session at once when its agent exited cleanly, and says whether it did. A
// lead you exited leaves its session behind, and the daemon must clear it before anything else
// runs, or its next look for exited leads would take it for one you just exited.
export function endExitedSession(socket: string, name: string): boolean {
  if (!exitedCleanly(socket, name)) return false;
  mustTmux(socket, ["kill-session", "-t", `=${name}`]);
  return true;
}

// Reports whether the agent in the named session is still running, so Skelcrew only types into
// or attaches to a live one. A session alone doesn't say: an agent that failed leaves its
// last screen behind in a session that looks alive.
export async function agentRuns(host: Host, name: string): Promise<boolean> {
  if (typeof host !== "string") return (await hosted(host, name))?.running === true;
  return (await hasSession(host, name)) && (await failedScreen(host, name)) === null;
}

// Ends the named session so Skelcrew can replace an agent that has stopped working.
export async function endSession(host: Host, name: string): Promise<void> {
  if (typeof host !== "string") await askHost(host, { ask: "end", id: name }, z.unknown());
  else mustTmux(host, ["kill-session", "-t", `=${name}`]);
}

// Waits a moment after an agent's start, and throws with its last screen when it has ended.
// One that can't start, such as one whose login is gone, ends within moments, and attaching
// would only find it gone. A failed session is ended, so Skelcrew can start the agent again.
// `who` names the agent in the error: the lead or the builder.
export async function checkAgentStarted(host: Host, name: string, who: string): Promise<void> {
  await Bun.sleep(1000);
  // A failed agent leaves its session behind with its last screen; one that is simply gone
  // left nothing to show.
  const failed = await failedScreen(host, name);
  if (failed !== null) await endSession(host, name);
  if (failed !== null || !(await hasSession(host, name)))
    throw new Error(`the ${who} exited as soon as it started:\n${failed ?? ""}`);
}

// Returns every process with what started it and its state letter, Z for one that exited
// but wasn't yet reaped. It asks ps, since a Mac has no /proc. Each column is its own -o: a
// Mac's ps reads what follows an = as the column's title, commas and all.
function listProcesses(): { pid: number; parent: number; state: string }[] {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "stat="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  // Each line holds a pid, its parent and its state, padded with spaces. A line missing any
  // of them, such as the empty one at the end, is skipped.
  return ps.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const [pid, parent, state] = line.trim().split(/\s+/);
      return pid && parent && state
        ? [{ pid: Number(pid), parent: Number(parent), state: state.slice(0, 1) }]
        : [];
    });
}

// Returns a process and every process under it, so stopping a session can wait for all of
// them: an agent in its sandbox runs a few levels down from the pane's own process.
export function processTree(root: number): number[] {
  // List each process's children, from one look at every process.
  const children = new Map<number, number[]>();
  for (const { pid, parent } of listProcesses())
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  // Walk down from the root: each process found adds its children to the end of the list,
  // so the loop reaches them in turn.
  const tree = [root];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i] ?? 0) ?? []));
  return tree;
}

// Returns those of the given processes that haven't exited, to wait for them to end.
export function stillRunning(tree: number[]): number[] {
  const alive = listProcesses().filter(({ state }) => state !== "Z");
  return tree.filter((pid) => alive.some((process) => process.pid === pid));
}

// Ends the named session and returns once every process it ran has exited, so what it was
// using, such as a thread's clone, can be removed. Claude Code can outlive the end of its
// session for a few seconds, so it gets `timeout` milliseconds before being killed. On a Mac
// it then removes the sandbox's folders, which a killed agent would leave behind in /tmp. A
// plugin's host waits for its session's processes itself, as only it knows them.
export async function stopSession(host: Host, name: string, timeout = 10_000): Promise<void> {
  if (typeof host !== "string") {
    if (await hasSession(host, name)) await endSession(host, name);
    return;
  }
  const socket = host;
  // Find the pane's process and the sandbox's folders first, as neither can be found once the
  // session is gone. No pane means no session, so there is nothing to stop. The folders are
  // a JSON list after the process number, or nothing outside a Mac.
  const format = "#{pane_pid} #{@sandbox-folders}";
  const found = tmux(socket, ["display-message", "-p", "-t", `=${name}:`, format]).out.trim();
  const [pid = "", ...folders] = found.split(" ");
  const pane = Number(pid);
  if (!pane) return;
  // Note every process under the pane, then end the session.
  const tree = processTree(pane);
  tmux(socket, ["kill-session", "-t", `=${name}`]);
  // Wait for them all to exit. Past the deadline, kill those left on each pass; one may have
  // exited in between, so a failed kill is fine.
  const deadline = Date.now() + timeout;
  while (stillRunning(tree).length > 0) {
    if (Date.now() > deadline)
      for (const pid of stillRunning(tree))
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
    await Bun.sleep(100);
  }
  // A sandbox that ended on its own removed them already, so they may be gone.
  const named = z.array(z.string()).parse(JSON.parse(folders.join(" ") || "[]"));
  for (const folder of named) rmSync(folder, { recursive: true, force: true });
}

// Lists the sessions on a host, each with its labels and whether its agent is running, so a
// starting daemon can find them. A builder that exited keeps its session and last screen, which
// would look like it still runs. A plugin's host lists its own, each named by its ID there,
// with null labels for a session started without them. Labels Skelcrew can't read make the whole
// answer an error: taken for none, they would hide a builder the daemon started but stopped
// before saving its ID, and the thread would start a second builder in the same clone.
export async function listSessions(
  host: Host,
): Promise<{ name: string; running: boolean; labels: Labels | null }[]> {
  if (typeof host === "string") return listTmuxSessions(host);
  const Listed = z.object({ id: z.string(), running: z.boolean(), labels: Labels.nullable() });
  const answer = z.object({ sessions: z.array(Listed) });
  const { sessions } = await askHost(host, { ask: "list" }, answer);
  return sessions.map(({ id, running, labels }) => ({ name: id, running, labels }));
}

// Lists the sessions on Skelcrew's tmux server as listSessions does, at once, for the sidebar,
// which shows which agents run and draws without waiting. A session started by a release before
// labels has none. Nothing when the server isn't up.
export function listTmuxSessions(
  socket: string,
): { name: string; running: boolean; labels: Labels | null }[] {
  // One line per pane, its fields apart by tabs, which no name holds: 0 for a pane whose agent
  // runs and 1 for a dead one, the session's name, then its labels, empty where unset.
  const format =
    "#{pane_dead}\t#{session_name}\t#{@skelcrew-repository}\t#{@skelcrew-role}\t#{@skelcrew-task}";
  const panes = tmux(socket, ["list-panes", "-a", "-F", format]).out;
  return panes.split("\n").flatMap((line) => {
    const [dead, name, repository, role, task] = line.split("\t");
    if (dead === undefined || !name) return [];
    const labels = Labels.safeParse({ repository, role, ...(task ? { task } : {}) });
    return [{ name, running: dead === "0", labels: labels.success ? labels.data : null }];
  });
}

// Returns the screen the agent in the named session shows now, as text, such as to see whether
// it is ready for a message. Throws when the session is gone.
export async function readSession(host: Host, name: string): Promise<string> {
  if (typeof host !== "string")
    return (await askHost(host, { ask: "read", id: name }, z.object({ screen: z.string() })))
      .screen;
  return mustTmux(host, ["capture-pane", "-p", "-t", `=${name}:`]);
}

// Types text into the agent in the named session as if from your keyboard, keys such as Enter
// included, for keys you typed just before attaching to it.
export function typeKeys(socket: string, name: string, text: string): void {
  tmux(socket, ["send-keys", "-t", `=${name}:`, "-l", text]);
}

// Reports whether someone has scrolled back in the named session, in tmux's copy mode, so
// Skelcrew can hold a message rather than throw them back to the bottom while they read. Copy
// mode stays on a pane you left for another session, so its messages wait until you come back
// and leave it, and you find the chat where you left it.
export function scrolledBack(socket: string, name: string): boolean {
  return (
    tmux(socket, ["display-message", "-p", "-t", `=${name}:`, "#{pane_in_mode}"]).out.trim() === "1"
  );
}

// Sends one key to the agent in the named session, such as Enter after a pasted message.
export async function sendKey(host: Host, name: string, key: "Enter" | "Escape"): Promise<void> {
  if (typeof host !== "string") await askHost(host, { ask: "keys", id: name, key }, z.unknown());
  else mustTmux(host, ["send-keys", "-t", `=${name}:`, key]);
}

// Stops the agent's turn, as pressing Esc in its session does.
export async function interruptSession(host: Host, name: string): Promise<void> {
  if (typeof host !== "string") await askHost(host, { ask: "interrupt", id: name }, z.unknown());
  else await sendKey(host, name, "Escape");
}

// How many paste buffers this process has made, so each gets a name of its own.
let buffersMade = 0;

// Pasting goes in steps, so the caller can take its last look at the screen after the slow
// part and just before the paste: a person may start a draft at any moment, and the paste would
// send it. stagePaste readies the text, pasteStaged pastes it, and dropStaged forgets it.

// Readies text for pasteStaged into the named session, and returns the name it is kept under.
// Someone scrolled back would swallow the Enter that follows a paste, and the message would
// never be sent. Being scrolled back shows nowhere in the pane's text, so it is left here,
// whether or not anyone is. That fails when nobody is, which is fine. A plugin's host keeps
// nothing in between, so the text itself is what pasteStaged gets.
export function stagePaste(host: Host, name: string, text: string): string {
  if (typeof host !== "string") return text;
  const socket = host;
  // A paste buffer of its own, so two daemons or two messages never paste each other's text.
  const staged = `skelcrew-${process.pid}-${buffersMade++}`;
  tmux(socket, ["send-keys", "-X", "-t", `=${name}:`, "cancel"]);
  mustTmux(socket, ["load-buffer", "-b", staged, "-"], text);
  return staged;
}

// Pastes text stagePaste readied into the named session as one bracketed paste, so the agent
// reads it as a whole, however long, and newlines in it don't send it. Throws when the session
// is gone.
export async function pasteStaged(host: Host, name: string, staged: string): Promise<void> {
  if (typeof host !== "string")
    await askHost(host, { ask: "paste", id: name, text: staged }, z.unknown());
  else mustTmux(host, ["paste-buffer", "-p", "-b", staged, "-t", `=${name}:`]);
}

// Forgets text stagePaste readied, pasted or not, so the server keeps no copy an agent could
// read back. A plugin's host kept none.
export function dropStaged(host: Host, staged: string): void {
  if (typeof host === "string") tmux(host, ["delete-buffer", "-b", staged]);
}

// Returns whether this machine knows the terminal. tmux refuses one it doesn't, such as Ghostty's
// xterm-ghostty over ssh, so attaching falls back to xterm-256color, which draws Claude Code well
// enough.
const knownTerminal = (term: string) =>
  !Bun.which("infocmp") ||
  Bun.spawnSync(["infocmp", term], { stdout: "ignore", stderr: "ignore" }).success;

// Attaches your terminal full screen to the named session, and returns once you leave it with
// Ctrl-\, or its agent ends. Gives tmux's error when it couldn't attach, such as to a session
// that just ended, or null. A session can stay after its agent ends, showing its last
// screen, and tmux would keep you on it. So while you are attached it looks each half second,
// and detaches you once the agent no longer runs. The server may have started under an older
// Skelcrew, so it gets today's settings first. TMUX must go, or tmux refuses to attach from
// inside tmux.
export async function attachSession(socket: string, name: string): Promise<string | null> {
  const env = envWithoutTmux();
  if (env.TERM && !knownTerminal(env.TERM)) env.TERM = "xterm-256color";
  applyConfig(socket);
  const client = Bun.spawn(["tmux", "-L", socket, "-f", "/dev/null", "attach", "-t", `=${name}`], {
    env,
    stdio: ["inherit", "inherit", "pipe"],
  });
  // Only this attachment's client is detached, found by its process, as you may have the same
  // agent open in another terminal too.
  const watch = setInterval(async () => {
    if (await agentRuns(socket, name)) return;
    const clients = tmux(socket, ["list-clients", "-F", "#{client_pid} #{client_tty}"]).out;
    const mine = clients.split("\n").find((line) => line.startsWith(`${client.pid} `));
    if (mine) tmux(socket, ["detach-client", "-t", mine.slice(`${client.pid} `.length)]);
  }, 500);
  const [code, said] = await Promise.all([client.exited, new Response(client.stderr).text()]);
  clearInterval(watch);
  return code === 0 ? null : said.trim() || `tmux attach exited with ${code}`;
}

// Returns a command that attaches a terminal to the named session, for the screen's right pane.
// When the session ends, or you leave it with its own keys, the terminal comes back on `then`,
// the lead's session, trying again while the lead restarts. While there is no session to attach
// to, such as for a lead starting or a repository just removed, it says so in one line, not
// tmux's error each second. TMUX must go, or tmux refuses to attach from inside tmux.
export function attachCommand(socket: string, name: string, then: string): string[] {
  const client = `tmux -L "$1" -f /dev/null attach -t`;
  const wait = `[ -n "$said" ] || { echo; echo 'Waiting for the lead to start.'; said=1; }`;
  const script = `unset TMUX; ${client} "=$2" 2>/dev/null || ${wait}; while sleep 1; do ${client} "=$3" 2>/dev/null && said= || { ${wait}; }; done`;
  return ["sh", "-c", script, "sh", socket, name, then];
}

// Returns the session shown in the terminal at `tty`, which attachCommand attached, or null while
// it shows none, such as the moment between an agent ending and the terminal coming back on the
// lead. The screen's sidebar asks, as an agent can end and its terminal move to the lead alone.
export function shownSession(socket: string, tty: string): string | null {
  // Each line is a client's terminal and its session; the session is what follows the
  // terminal and a space.
  const clients = tmux(socket, ["list-clients", "-F", "#{client_tty} #{session_name}"]).out;
  const line = clients.split("\n").find((client) => client.startsWith(`${tty} `));
  return line ? line.slice(tty.length + 1) : null;
}

// Switches the terminal at `tty`, which attachCommand attached, to another session. Quietly does
// nothing if that session ended this moment: the sidebar shows what is left at its next look.
export function showSession(socket: string, tty: string, name: string): void {
  tmux(socket, ["switch-client", "-c", tty, "-t", `=${name}`]);
}
