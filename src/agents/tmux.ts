// Running tmux: the commands the sessions module's tmux server takes, and the screen's own tmux
// server, which shows the agents' sessions beside the sidebar. Only the sessions module runs
// tmux for agents.

// Returns the screen's tmux server beside the agents': skelcrew-screen beside skelcrew, and a
// test's own beside the test's.
export const screenSocket = (agents: string) => `${agents}-screen`;

// Returns whether this machine's tmux is the given version or newer, for settings an older
// one refuses. One bad setting fails the whole command, so the screen or a session wouldn't
// start. A version that isn't a plain number, such as "next-3.7" or "master", is taken as new.
export function tmuxIsAtLeast(major: number, minor: number): boolean {
  const said = Bun.spawnSync(["tmux", "-V"], { env: envWithoutTmux(), stderr: "ignore" });
  const version = said.stdout.toString().match(/^tmux (\d+)\.(\d+)/);
  if (!version) return true;
  const [has, hasMinor] = [Number(version[1]), Number(version[2])];
  return has > major || (has === major && hasMinor >= minor);
}

// Returns the inherited environment without TMUX, which otherwise prevents attaching from
// inside tmux.
export function envWithoutTmux(): Record<string, string> {
  const kept = Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || key === "TMUX" ? [] : [[key, value]],
  );
  return Object.fromEntries(kept);
}

// Quotes a trailing semicolon so tmux treats messages and folders as single arguments. tmux
// reads any word ending in ";" as the end of a command, even a message or a folder, unless
// that ";" has a backslash before it.
const escapeSemicolon = (word: string) => (word.endsWith(";") ? `${word.slice(0, -1)}\\;` : word);

// Runs a command on the tmux server with this socket and returns its output and whether it
// succeeded. Only the sessions module runs it on the agents' server.
export function tmux(socket: string, args: string[], input = "") {
  const run = Bun.spawnSync(
    ["tmux", "-L", socket, "-f", "/dev/null", ...args.map(escapeSemicolon)],
    {
      env: envWithoutTmux(),
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { ok: run.success, out: run.stdout.toString(), err: run.stderr.toString().trim() };
}

// Returns tmux output or throws with its error, so session operations cannot fail silently.
export function mustTmux(socket: string, args: string[], input = ""): string {
  const run = tmux(socket, args, input);
  if (!run.ok) throw new Error(`tmux ${args[0]} failed: ${run.err}`);
  return run.out;
}

// Runs a command on the screen's own tmux server, beside the agents' server `agents`, and
// returns its output and whether it succeeded.
export const screenTmux = (agents: string, args: string[]) => tmux(screenSocket(agents), args);

// Returns the terminal of a pane on the screen's server, by which the agents' server knows the
// client running in it. Throws when the pane is gone, since the sidebar then has nothing to
// switch.
export const paneTty = (agents: string, target: string) =>
  mustTmux(screenSocket(agents), ["display-message", "-p", "-t", target, "#{pane_tty}"]).trim();

// Returns the width of a pane on the screen's server, or 0 once it is gone.
export const paneWidth = (agents: string, target: string) =>
  Number(screenTmux(agents, ["display-message", "-p", "-t", target, "#{pane_width}"]).out.trim());

// Sets the two status lines of a screen's session, as tmux formats: the header with the tabs, and
// the top of the boxes under it. Each set makes tmux redraw the whole screen, so the sidebar calls
// this only when a line changed.
export function showTop(
  agents: string,
  session: string,
  { header, boxes }: { header: string; boxes: string },
): void {
  screenTmux(agents, ["set", "-t", `=${session}:`, "status-format[0]", escapeSemicolon(header)]);
  screenTmux(agents, ["set", "-t", `=${session}:`, "status-format[1]", escapeSemicolon(boxes)]);
}

// Replaces what a pane on the screen's server runs with a command. Its terminal is a new one,
// with a new name.
export function respawnPane(agents: string, target: string, command: string[]): void {
  screenTmux(agents, ["respawn-pane", "-k", "-t", target, "--", ...command]);
}
