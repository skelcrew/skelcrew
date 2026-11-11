// Skelcrew's tmux sessions: one for each repository's lead and one per builder, on Skelcrew's own
// tmux server (`tmux -L skelcrew`; tests pass a socket of their own).
import { onSprite, startTmuxService } from "../machine/sprite.ts";

// Returns the screen's tmux server beside the agents': skelcrew-screen beside skelcrew, and a
// test's own beside the test's.
export const screenSocket = (agents: string) => `${agents}-screen`;

// Sent on stdin with each new session instead of kept in a file, so there is no file to
// find or keep in step, and a server that outlives an upgrade picks up changes. Your own
// ~/.tmux.conf never applies: -f /dev/null replaces it. Ctrl-Q with no prefix and no status
// bar make attaching feel like being inside Claude Code. A session whose command fails
// keeps its last screen, so Skelcrew can say why it ended instead of finding it gone. tmux only
// passes synchronized output on to terminals it knows have it, and without it Claude Code's
// redraws arrive in pieces, so the prompt flickers over a slow link such as a Sprite's.
// Terminals without it ignore the codes. A fixed index, since this runs again with each
// new session and appending would add it every time.
//
// The wheel scrolls back through an agent's output. Claude Code draws in one of two ways. Its
// classic drawing leaves its output in tmux's history, so copy mode shows it. Its full-screen
// drawing keeps its own, and asks for the mouse, so the wheel goes to it. A program on the
// alternate screen that didn't ask has no history here, so it gets arrow keys, as a terminal
// would send it. Copy mode's own keys are all gone, as they would swallow what you type and
// leave you wondering why the agent doesn't answer: any key goes back to the live agent and
// reaches it too, as send-keys alone sends the key that ran it. mode-keys, since tmux picks
// vi's table, and keeps these keys out of it, when $EDITOR says vi.
const config = `set -g status off
bind -n C-q detach-client
set -g remain-on-exit failed
set -s terminal-features[90] "*:sync"
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
unbind -a -T copy-mode
bind -T copy-mode WheelUpPane send-keys -X -N 5 scroll-up
bind -T copy-mode WheelDownPane send-keys -X -N 5 scroll-down
bind -T copy-mode Any { send-keys -X cancel; send-keys }
`;

// Returns the inherited environment without TMUX, which otherwise prevents attaching from
// inside tmux.
export function cleanEnv(): Record<string, string> {
  const kept = Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || key === "TMUX" ? [] : [[key, value]],
  );
  return Object.fromEntries(kept);
}

// Quotes a trailing semicolon so tmux treats messages and folders as single arguments. tmux
// reads any word ending in ";" as the end of a command, even a message or a folder, unless
// that ";" has a backslash before it.
const literal = (word: string) => (word.endsWith(";") ? `${word.slice(0, -1)}\\;` : word);

// Runs a command on Skelcrew's tmux server and returns its output and whether it succeeded.
export function tmux(socket: string, args: string[], input = "") {
  const run = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args.map(literal)], {
    env: cleanEnv(),
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString(), err: run.stderr.toString().trim() };
}

// Returns tmux output or throws with its error, so session operations cannot fail silently.
export function mustTmux(socket: string, args: string[], input = ""): string {
  const run = tmux(socket, args, input);
  if (!run.ok) throw new Error(`tmux ${args[0]} failed: ${run.err}`);
  return run.out;
}

// Starts Skelcrew's tmux server if needed, keeping agent sessions alive independently of the
// daemon. A server started by the daemon would live in skelcrew.service's cgroup, so stopping
// or OOM-killing the service would take every agent with it. A systemd scope of its own
// keeps it apart, as a Sprite service does on a Sprite; without either it starts plainly.
// exit-empty off keeps it up until its first session, and the config applies to that
// session too.
export function startServer(socket: string): void {
  // A server that answers is already up, and keeps its sessions.
  if (tmux(socket, ["list-sessions"]).ok) return;
  // The lone ";" separates tmux commands, so these words skip literal().
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
      env: cleanEnv(),
      stdin: new Blob([config]),
      stdout: "pipe",
      stderr: "pipe",
    });
  // On a Sprite the server runs as a Sprite service of its own, as one the daemon started would
  // end with the daemon's service. The plain start below then finds it running, and only gives
  // it Skelcrew's options.
  if (onSprite()) startTmuxService(socket);
  else if (Bun.which("systemd-run") && run([...scope, ...start]).success) return;
  const plain = run(start);
  if (!plain.success)
    throw new Error(`tmux start-server failed: ${plain.stderr.toString().trim()}`);
}

// Starts a named agent session with only its supplied environment and Skelcrew's terminal
// settings.
export function startSession(
  socket: string,
  name: string,
  session: { folder: string; command: string[]; env: Record<string, string> },
): void {
  // tmux would quietly rename the session, and then never find it under the name asked for.
  if (/[.:]/.test(name)) throw new Error(`a session can't be named ${name}: tmux changes . and :`);
  // The server hands its own environment to every session and -e only adds to it, so a
  // token the daemon has would reach the agent. env -i starts from nothing. TERM is the one
  // value the pane's own must win for: tmux sets it to what it draws.
  const env = Object.entries(session.env).flatMap(([key, value]) =>
    key === "TERM" ? [] : [`${key}=${value}`],
  );
  const clean = ["sh", "-c", 'exec env -i TERM="$TERM" "$@"', "sh", ...env];
  // With a single word, tmux would run the command through a shell, so sh always goes
  // first.
  const start = ["new-session", "-d", "-s", name, "-c", session.folder];
  mustTmux(socket, [...start, "--", ...clean, ...session.command]);
  mustTmux(socket, ["source-file", "-"], config);
}

// Gives a running tmux server Skelcrew's settings, so one that outlived an upgrade scrolls too.
// Quietly does nothing without a server.
export function applyConfig(socket: string): void {
  tmux(socket, ["source-file", "-"], config);
}

// Reports whether the exact session exists so Skelcrew can reconnect instead of starting it
// twice.
export function hasSession(socket: string, name: string): boolean {
  // The = asks for this exact name; without it tmux also accepts a session it starts with.
  return tmux(socket, ["has-session", "-t", `=${name}`]).ok;
}

// Returns a failed session's last screen so Skelcrew can explain why the agent ended. Returns
// null while the command runs or no dead pane is found.
export function failedScreen(socket: string, name: string): string | null {
  // A pane still running its command, or no pane at all, has no last screen to give.
  if (tmux(socket, ["display-message", "-p", "-t", `=${name}:`, "#{pane_dead}"]).out.trim() !== "1")
    return null;
  // The visible screen can come back blank once the pane is dead; its history keeps the
  // text.
  return mustTmux(socket, ["capture-pane", "-p", "-S", "-", "-t", `=${name}:`]).trim();
}

// Reports whether the agent in the named session is still running, so Skelcrew only types into
// or attaches to a live one. A session alone doesn't say: an agent that failed leaves its
// last screen behind in a session that looks alive.
export const agentRuns = (socket: string, name: string) =>
  hasSession(socket, name) && failedScreen(socket, name) === null;

// Ends the named session so Skelcrew can replace an agent that has stopped working.
export function endSession(socket: string, name: string): void {
  mustTmux(socket, ["kill-session", "-t", `=${name}`]);
}

// Waits a moment after an agent's start, and throws with its last screen when it has ended.
// One that can't start, such as one whose login is gone, ends within moments, and attaching
// would only find it gone. A failed session is ended, so Skelcrew can start the agent again.
// `who` names the agent in the error: the lead or the builder.
export async function checkItLived(socket: string, name: string, who: string): Promise<void> {
  await Bun.sleep(1000);
  // A failed agent leaves its session behind with its last screen; one that is simply gone
  // left nothing to show.
  const failed = failedScreen(socket, name);
  if (failed !== null) endSession(socket, name);
  if (failed !== null || !hasSession(socket, name))
    throw new Error(`the ${who} exited as soon as it started:\n${failed ?? ""}`);
}

// Returns every process with what started it and its state letter, Z for one that exited
// but wasn't yet reaped. It asks ps, since a Mac has no /proc. Each column is its own -o: a
// Mac's ps reads what follows an = as the column's title, commas and all.
function processes(): { pid: number; parent: number; state: string }[] {
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
  for (const { pid, parent } of processes())
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  // Walk down from the root: each process found adds its children to the end of the list,
  // so the loop reaches them in turn.
  const tree = [root];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i] ?? 0) ?? []));
  return tree;
}

// Returns those of the given processes that haven't exited, to wait for them to end.
export function stillRunning(tree: number[]): number[] {
  const alive = processes().filter(({ state }) => state !== "Z");
  return tree.filter((pid) => alive.some((process) => process.pid === pid));
}

// Ends the named session and returns once every process it ran has exited, so what it was
// using, such as a thread's clone, can be removed. Claude Code can outlive the end of its
// session for a few seconds, so it gets `timeout` milliseconds before being killed.
export async function stopSession(socket: string, name: string, timeout = 10_000): Promise<void> {
  // Find the pane's process first, as its processes can't be listed once the session is gone.
  // No pane means no session, so there is nothing to stop.
  const pane = Number(
    tmux(socket, ["display-message", "-p", "-t", `=${name}:`, "#{pane_pid}"]).out,
  );
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
}

// Returns the sessions whose agent is running, for the sidebar. A builder that exited keeps
// its session and last screen, which would look like it still runs. Nothing when the server
// isn't up.
export function runningSessions(socket: string): string[] {
  // Each line starts with 0 for a pane whose agent runs and 1 for a dead one, then the
  // session's name.
  const panes = tmux(socket, ["list-panes", "-a", "-F", "#{pane_dead} #{session_name}"]).out;
  return panes.split("\n").flatMap((pane) => (pane.startsWith("0 ") ? [pane.slice(2)] : []));
}

// Returns the terminal of a pane, by which another tmux server knows the client running in
// it. Throws when the pane is gone, since the sidebar then has nothing to switch.
export const paneTty = (socket: string, target: string) =>
  mustTmux(socket, ["display-message", "-p", "-t", target, "#{pane_tty}"]).trim();

// Returns the width of a pane, or 0 once it is gone.
export const paneWidth = (socket: string, target: string) =>
  Number(tmux(socket, ["display-message", "-p", "-t", target, "#{pane_width}"]).out.trim());

// Sets the status line of a session, as a tmux format: the header, the tabs and the strip. Each
// set makes tmux redraw the whole screen, so the sidebar calls this only when the line changed.
export function showStrip(socket: string, session: string, line: string): void {
  tmux(socket, ["set", "-t", `=${session}:`, "status-format[0]", literal(line)]);
}

// Returns the session a client on the given terminal is showing, or null while it has none,
// such as the moment between an agent ending and the client attaching to the lead.
export function shownSession(socket: string, tty: string): string | null {
  // Each line is a client's terminal and its session; the session is what follows the
  // terminal and a space.
  const clients = tmux(socket, ["list-clients", "-F", "#{client_tty} #{session_name}"]).out;
  const line = clients.split("\n").find((client) => client.startsWith(`${tty} `));
  return line ? line.slice(tty.length + 1) : null;
}

// Switches the client on the given terminal to another session. Quietly does nothing if that
// session ended this moment: the sidebar shows what is left at its next look.
export function showSession(socket: string, tty: string, name: string): void {
  tmux(socket, ["switch-client", "-c", tty, "-t", `=${name}`]);
}

// Replaces what a pane runs with a command. Its terminal is a new one, with a new name.
export function respawnPane(socket: string, target: string, command: string[]): void {
  tmux(socket, ["respawn-pane", "-k", "-t", target, "--", ...command]);
}
