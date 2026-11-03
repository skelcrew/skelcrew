// skel's tmux sessions: one each for the lead, builders and reviewers, on skel's own tmux
// server (`tmux -L skel`; tests pass a socket of their own).

// Sent on stdin with each new session instead of kept in a file, so there is no file to find
// or keep in step, and a server an older skel started picks up changes. Your own ~/.tmux.conf
// never applies: -f /dev/null replaces it. Ctrl-] with no prefix and no status bar make
// attaching feel like being inside Claude Code. A session whose command fails keeps its last
// screen, so skel can say why it ended instead of finding it gone.
const config = `set -g status off
bind -n C-] detach-client
set -g remain-on-exit failed
`;

type Waits = { moment?: number; timeout?: number };

// TMUX makes tmux refuse to attach from inside another tmux.
function cleanEnv(): Record<string, string> {
  const kept = Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || key === "TMUX" ? [] : [[key, value]],
  );
  return Object.fromEntries(kept);
}

// tmux reads any word ending in ";" as the end of a command, even a message or a folder,
// unless that ";" has a backslash before it.
const literal = (word: string) => (word.endsWith(";") ? `${word.slice(0, -1)}\\;` : word);

function tmux(socket: string, args: string[], input = "") {
  const run = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args.map(literal)], {
    env: cleanEnv(),
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

// A server started by the daemon would live in skel.service's cgroup, so stopping or
// OOM-killing the service would take every agent with it. A systemd scope of its own keeps
// it apart; without systemd-run it starts plainly. exit-empty off keeps it up until its
// first session, and the config applies to that session too.
export function startServer(socket: string): void {
  if (tmux(socket, ["list-sessions"]).ok) return;
  // The lone ";" separates tmux commands, so these words skip literal().
  const start = ["tmux", "-L", socket, "-f", "/dev/null", "start-server", ";"];
  start.push("set-option", "-g", "exit-empty", "off", ";", "source-file", "-");
  const scope = ["systemd-run", "--user", "--scope", "--quiet", `--unit=skel-tmux-${socket}`, "--"];
  const run = (command: string[]) =>
    Bun.spawnSync(command, {
      env: cleanEnv(),
      stdin: new Blob([config]),
      stdout: "pipe",
      stderr: "pipe",
    });
  if (Bun.which("systemd-run") && run([...scope, ...start]).success) return;
  const plain = run(start);
  if (!plain.success)
    throw new Error(`tmux start-server failed: ${plain.stderr.toString().trim()}`);
}

export function startSession(
  socket: string,
  name: string,
  session: { folder: string; command: string[]; env: Record<string, string> },
): void {
  // tmux would quietly rename the session, and then never find it under the name asked for.
  if (/[.:]/.test(name)) throw new Error(`a session can't be named ${name}: tmux changes . and :`);
  // The server hands its own environment to every session and -e only adds to it, so a token
  // the daemon has would reach the agent. env -i starts from nothing. TERM is the one value
  // the pane's own must win for: tmux sets it to what it draws.
  const env = Object.entries(session.env).flatMap(([key, value]) =>
    key === "TERM" ? [] : [`${key}=${value}`],
  );
  const clean = ["sh", "-c", 'exec env -i TERM="$TERM" "$@"', "sh", ...env];
  // With a single word, tmux would run the command through a shell, so sh always goes first.
  const start = ["new-session", "-d", "-s", name, "-c", session.folder];
  mustTmux(socket, [...start, "--", ...clean, ...session.command]);
  mustTmux(socket, ["source-file", "-"], config);
}

export function hasSession(socket: string, name: string): boolean {
  // The = asks for this exact name; without it tmux also accepts a session it starts with.
  return tmux(socket, ["has-session", "-t", `=${name}`]).ok;
}

// The last screen of a session whose command failed, or null while its command runs.
export function failedScreen(socket: string, name: string): string | null {
  if (tmux(socket, ["display-message", "-p", "-t", `=${name}:`, "#{pane_dead}"]).out.trim() !== "1")
    return null;
  // The visible screen can come back blank once the pane is dead; its history keeps the text.
  return mustTmux(socket, ["capture-pane", "-p", "-S", "-", "-t", `=${name}:`]).trim();
}

export function endSession(socket: string, name: string): void {
  mustTmux(socket, ["kill-session", "-t", `=${name}`]);
}

// Returns when you detach with Ctrl-].
export async function attach(socket: string, name: string): Promise<void> {
  const code = await Bun.spawn(["tmux", "-L", socket, "attach", "-t", `=${name}`], {
    env: cleanEnv(),
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
  if (code !== 0) throw new Error(`couldn't attach to ${name}: tmux exited with ${code}`);
}

const screen = (socket: string, name: string) =>
  mustTmux(socket, ["capture-pane", "-p", "-t", `=${name}:`]);

// Why the session isn't idle, or "" when it is. A quiet pane alone isn't enough: Claude Code
// can sit still mid-turn while a tool runs.
async function notIdle(socket: string, name: string, moment: number): Promise<string> {
  const before = screen(socket, name);
  await Bun.sleep(moment);
  const after = screen(socket, name);
  if (after.includes("esc to interrupt")) return "it shows esc to interrupt";
  if (before !== after) return "its screen kept changing";
  if (!after.split("\n").some((line) => line.trim() === "❯")) return "it shows no ❯ prompt";
  return "";
}

export async function isIdle(socket: string, name: string, waits: Waits = {}): Promise<boolean> {
  return (await notIdle(socket, name, waits.moment ?? 500)) === "";
}

// One message at a time per session, so two pastes can't land before either's Enter.
const typing = new Map<string, Promise<void>>();

export function typeInto(socket: string, name: string, text: string, waits: Waits = {}) {
  const key = `${socket}/${name}`;
  const earlier = typing.get(key) ?? Promise.resolve();
  const turn = earlier.then(() => typeNow(socket, name, text, waits));
  // The next message waits for this one whether or not it got through.
  const settled = turn.then(
    () => {},
    () => {},
  );
  typing.set(key, settled);
  settled.then(() => {
    if (typing.get(key) === settled) typing.delete(key);
  });
  return turn;
}

let buffers = 0;

async function typeNow(socket: string, name: string, text: string, waits: Waits) {
  const moment = waits.moment ?? 500;
  const timeout = waits.timeout ?? 60_000;
  const deadline = Date.now() + timeout;
  // Text typed while Claude Code is starting or busy can be lost.
  for (;;) {
    const why = await notIdle(socket, name, moment);
    if (why === "") break;
    if (Date.now() > deadline)
      throw new Error(`${name} wasn't idle for ${timeout / 1000}s (${why}), so nothing was typed`);
  }
  const buffer = `skel-${process.pid}-${buffers++}`;
  try {
    mustTmux(socket, ["load-buffer", "-b", buffer, "-"], text);
    // Without the paste marks, Claude Code reads the Enter after a long message as a new line,
    // and the message is never sent. So the Enter goes on its own, a moment after the paste.
    mustTmux(socket, ["paste-buffer", "-p", "-b", buffer, "-t", `=${name}:`]);
    await Bun.sleep(moment);
    mustTmux(socket, ["send-keys", "-t", `=${name}:`, "Enter"]);
  } finally {
    tmux(socket, ["delete-buffer", "-b", buffer]);
  }
}
