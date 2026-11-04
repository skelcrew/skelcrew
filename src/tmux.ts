// skel's tmux sessions: one each for the lead, builders and reviewers, on skel's own tmux
// server (`tmux -L skel`; tests pass a socket of their own).
import { readdirSync, readFileSync } from "node:fs";
import { onSprite, startTmuxService } from "./sprite.ts";

// Sent on stdin with each new session instead of kept in a file, so there is no file to
// find or keep in step, and a server an older skel started picks up changes. Your own
// ~/.tmux.conf never applies: -f /dev/null replaces it. Ctrl-] with no prefix and no status
// bar make attaching feel like being inside Claude Code. A session whose command fails
// keeps its last screen, so skel can say why it ended instead of finding it gone. tmux only
// passes synchronized output on to terminals it knows have it, and without it Claude Code's
// redraws arrive in pieces, so the prompt flickers over a slow link such as a Sprite's.
// Terminals without it ignore the codes. A fixed index, since this runs again with each
// new session and appending would add it every time.
const config = `set -g status off
bind -n C-] detach-client
set -g remain-on-exit failed
set -s terminal-features[90] "*:sync"
`;

type Waits = { moment?: number; timeout?: number; signal?: AbortSignal };

// Returns the inherited environment without TMUX, which otherwise prevents attaching from
// inside tmux.
function cleanEnv(): Record<string, string> {
  const kept = Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || key === "TMUX" ? [] : [[key, value]],
  );
  return Object.fromEntries(kept);
}

// Quotes a trailing semicolon so tmux treats messages and folders as single arguments. tmux
// reads any word ending in ";" as the end of a command, even a message or a folder, unless
// that ";" has a backslash before it.
const literal = (word: string) => (word.endsWith(";") ? `${word.slice(0, -1)}\\;` : word);

// Runs a command on skel's tmux server and returns its output and whether it succeeded.
function tmux(socket: string, args: string[], input = "") {
  const run = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args.map(literal)], {
    env: cleanEnv(),
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString(), err: run.stderr.toString().trim() };
}

// Returns tmux output or throws with its error, so session operations cannot fail silently.
function mustTmux(socket: string, args: string[], input = ""): string {
  const run = tmux(socket, args, input);
  if (!run.ok) throw new Error(`tmux ${args[0]} failed: ${run.err}`);
  return run.out;
}

// Starts skel's tmux server if needed, keeping agent sessions alive independently of the
// daemon. A server started by the daemon would live in skel.service's cgroup, so stopping
// or OOM-killing the service would take every agent with it. A systemd scope of its own
// keeps it apart, as a Sprite service does on a Sprite; without either it starts plainly. exit-empty off keeps it up until
// its first session, and the config applies to that session too.
export function startServer(socket: string): void {
  if (tmux(socket, ["list-sessions"]).ok) return;
  // The lone ";" separates tmux commands, so these words skip literal().
  const start = ["tmux", "-L", socket, "-f", "/dev/null", "start-server", ";"];
  start.push("set-option", "-g", "exit-empty", "off", ";", "source-file", "-");
  const scope = ["systemd-run", "--user", "--scope", "--quiet", `--unit=skel-tmux-${socket}`, "--"];
  // Starts the server with skel's configuration, either in its own scope or directly.
  const run = (command: string[]) =>
    Bun.spawnSync(command, {
      env: cleanEnv(),
      stdin: new Blob([config]),
      stdout: "pipe",
      stderr: "pipe",
    });
  // On a Sprite the server runs as a service, and then only takes skel's options. Never
  // plainly there: the daemon's service would end it.
  if (onSprite()) startTmuxService(socket);
  else if (Bun.which("systemd-run") && run([...scope, ...start]).success) return;
  const plain = run(start);
  if (!plain.success)
    throw new Error(`tmux start-server failed: ${plain.stderr.toString().trim()}`);
}

// Starts a named agent session with only its supplied environment and skel's terminal
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

// Reports whether the exact session exists so skel can reconnect instead of starting it
// twice.
export function hasSession(socket: string, name: string): boolean {
  // The = asks for this exact name; without it tmux also accepts a session it starts with.
  return tmux(socket, ["has-session", "-t", `=${name}`]).ok;
}

// Returns a failed session's last screen so skel can explain why the agent ended. Returns
// null while the command runs or no dead pane is found.
export function failedScreen(socket: string, name: string): string | null {
  if (tmux(socket, ["display-message", "-p", "-t", `=${name}:`, "#{pane_dead}"]).out.trim() !== "1")
    return null;
  // The visible screen can come back blank once the pane is dead; its history keeps the
  // text.
  return mustTmux(socket, ["capture-pane", "-p", "-S", "-", "-t", `=${name}:`]).trim();
}

// Ends the named session so skel can replace an agent that has stopped working.
export function endSession(socket: string, name: string): void {
  mustTmux(socket, ["kill-session", "-t", `=${name}`]);
}

// Returns the state letter of a process from /proc, or null once it is gone. A process that
// exited but wasn't yet reaped shows Z.
function processState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command's name, in parentheses, can hold spaces, so fields count from its end.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? null;
  } catch {
    return null;
  }
}

// Returns a process and every process under it, so stopping a session can wait for all of
// them: an agent in its sandbox runs a few levels down from the pane's own process.
function processTree(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
    } catch {}
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i] ?? 0) ?? []));
  return tree;
}

// Ends the named session and returns once every process it ran has exited, so what it was
// using, such as a thread's clone, can be removed. Claude Code can outlive the end of its
// session for a few seconds, so it gets `timeout` milliseconds before being killed.
export async function stopSession(socket: string, name: string, timeout = 10_000): Promise<void> {
  const pane = Number(
    tmux(socket, ["display-message", "-p", "-t", `=${name}:`, "#{pane_pid}"]).out,
  );
  if (!pane) return;
  const tree = processTree(pane);
  tmux(socket, ["kill-session", "-t", `=${name}`]);
  const running = () => tree.filter((pid) => ![null, "Z"].includes(processState(pid)));
  const deadline = Date.now() + timeout;
  while (running().length > 0) {
    if (Date.now() > deadline)
      for (const pid of running())
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
    await Bun.sleep(100);
  }
}

// Attaches your terminal to the named agent session and returns when you detach with
// Ctrl-].
export async function attach(socket: string, name: string): Promise<void> {
  const env = cleanEnv();
  // Reports whether this machine knows the terminal, so attachment can choose a fallback.
  // tmux refuses unknown terminals, such as Ghostty's xterm-ghostty over ssh.
  // xterm-256color draws Claude Code well enough.
  const known = (term: string) =>
    !Bun.which("infocmp") ||
    Bun.spawnSync(["infocmp", term], { stdout: "ignore", stderr: "ignore" }).success;
  if (env.TERM && !known(env.TERM)) env.TERM = "xterm-256color";
  const code = await Bun.spawn(["tmux", "-L", socket, "attach", "-t", `=${name}`], {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
  if (code !== 0) throw new Error(`couldn't attach to ${name}: tmux exited with ${code}`);
}

// Returns the visible pane text so skel can check whether Claude Code is ready for a
// message.
const screen = (socket: string, name: string) =>
  mustTmux(socket, ["capture-pane", "-p", "-t", `=${name}:`]);

// Returns why Claude Code is busy, or empty text when it is ready to accept a message. A
// quiet pane alone isn't enough: Claude Code can sit still mid-turn while a tool runs.
async function notIdle(socket: string, name: string, moment: number): Promise<string> {
  const before = screen(socket, name);
  await Bun.sleep(moment);
  const after = screen(socket, name);
  if (after.includes("esc to interrupt")) return "it shows esc to interrupt";
  if (before !== after) return "its screen kept changing";
  if (!after.split("\n").some((line) => line.trim() === "❯")) return "it shows no ❯ prompt";
  return "";
}

// Reports whether Claude Code shows a quiet, ready prompt so skel can avoid interrupting
// work.
export async function isIdle(socket: string, name: string, waits: Waits = {}): Promise<boolean> {
  return (await notIdle(socket, name, waits.moment ?? 500)) === "";
}

// One message at a time per session, so two pastes can't land before either's Enter.
const typing = new Map<string, Promise<void>>();

// Queues a message for the session and returns a promise that settles after its typing
// attempt. Messages wait their turn so two pastes cannot arrive before either message's
// Enter.
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

// Waits for Claude Code to be ready, then pastes and submits the message without losing
// long text. Throws if it stays busy too long, and removes the temporary paste buffer after
// the attempt. Types nothing once the signal is aborted, however long it waited.
async function typeNow(socket: string, name: string, text: string, waits: Waits) {
  const moment = waits.moment ?? 500;
  const timeout = waits.timeout ?? 60_000;
  const deadline = Date.now() + timeout;
  // Text typed while Claude Code is starting or busy can be lost.
  for (;;) {
    if (waits.signal?.aborted) return;
    const why = await notIdle(socket, name, moment);
    if (waits.signal?.aborted) return;
    if (why === "") break;
    if (Date.now() > deadline)
      throw new Error(`${name} wasn't idle for ${timeout / 1000}s (${why}), so nothing was typed`);
  }
  const buffer = `skel-${process.pid}-${buffers++}`;
  try {
    mustTmux(socket, ["load-buffer", "-b", buffer, "-"], text);
    // Without the paste marks, Claude Code reads the Enter after a long message as a new
    // line, and the message is never sent. So the Enter goes on its own, a moment after the
    // paste.
    mustTmux(socket, ["paste-buffer", "-p", "-b", buffer, "-t", `=${name}:`]);
    await Bun.sleep(moment);
    mustTmux(socket, ["send-keys", "-t", `=${name}:`, "Enter"]);
  } finally {
    tmux(socket, ["delete-buffer", "-b", buffer]);
  }
}
