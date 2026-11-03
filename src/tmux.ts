// skel's tmux sessions: one each for the lead, builders and reviewers, on skel's own tmux
// server (`tmux -L skel`; tests pass a socket of their own).

// Sent on stdin with each new session instead of kept in a file, so there is no file to find
// or keep in step, and a server an older skel started picks up changes. Your own ~/.tmux.conf
// never applies: -f /dev/null replaces it. Ctrl-] with no prefix and no status bar make
// attaching feel like being inside Claude Code.
const config = `set -g status off
bind -n C-] detach-client
`;

type Waits = { moment?: number; timeout?: number };

function tmux(socket: string, args: string[], input = "") {
  const run = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString(), err: run.stderr.toString().trim() };
}

function mustTmux(socket: string, args: string[], input = ""): string {
  const run = tmux(socket, args, input);
  if (!run.ok) throw new Error(`tmux ${args[0]} failed: ${run.err}`);
  return run.out;
}

export function startSession(
  socket: string,
  name: string,
  session: { folder: string; command: string[]; env: Record<string, string> },
): void {
  const env = Object.entries(session.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const start = ["new-session", "-d", "-s", name, "-c", session.folder, ...env];
  mustTmux(socket, [...start, "--", ...session.command, ";", "source-file", "-"], config);
}

export function hasSession(socket: string, name: string): boolean {
  // The = asks for this exact name; without it tmux also accepts a session it starts with.
  return tmux(socket, ["has-session", "-t", `=${name}`]).ok;
}

export function endSession(socket: string, name: string): void {
  mustTmux(socket, ["kill-session", "-t", `=${name}`]);
}

// Returns when you detach with Ctrl-].
export async function attach(socket: string, name: string): Promise<void> {
  await Bun.spawn(["tmux", "-L", socket, "attach", "-t", `=${name}`], {
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
}

const screen = (socket: string, name: string) =>
  mustTmux(socket, ["capture-pane", "-p", "-t", `=${name}:`]);

// A quiet pane alone isn't enough: Claude Code can sit still mid-turn while a tool runs.
export async function isIdle(socket: string, name: string, waits: Waits = {}): Promise<boolean> {
  const before = screen(socket, name);
  await Bun.sleep(waits.moment ?? 500);
  const after = screen(socket, name);
  return (
    before === after &&
    !after.includes("esc to interrupt") &&
    after.split("\n").some((line) => line.trim() === "❯")
  );
}

export async function typeInto(
  socket: string,
  name: string,
  text: string,
  waits: Waits = {},
): Promise<void> {
  const moment = waits.moment ?? 500;
  const timeout = waits.timeout ?? 60_000;
  const deadline = Date.now() + timeout;
  // Text typed while Claude Code is starting or busy can be lost.
  while (!(await isIdle(socket, name, { moment }))) {
    if (Date.now() > deadline)
      throw new Error(`${name} stayed busy for ${timeout / 1000}s, so nothing was typed`);
  }
  // A buffer per session, so two messages typed into different sessions at once don't mix.
  const buffer = `skel-${name}`;
  mustTmux(socket, ["load-buffer", "-b", buffer, "-"], text);
  // Without the paste marks, Claude Code reads the Enter after a long message as a new line,
  // and the message is never sent. So the Enter goes on its own, a moment after the paste.
  mustTmux(socket, ["paste-buffer", "-p", "-d", "-b", buffer, "-t", `=${name}:`]);
  await Bun.sleep(moment);
  mustTmux(socket, ["send-keys", "-t", `=${name}:`, "Enter"]);
}
