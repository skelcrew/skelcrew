// The tmux runner: holds each agent's session in a tmux session, on a tmux
// server of Skelcrew's own. Your own tmux, and your tmux settings, are never
// touched: the server has its own name and reads no settings file.
//
// Its sessions keep running when the daemon stops, and the next daemon
// finds them again. tmux keeps a finished session on screen, with its exit
// code, until the runner has read how it ended. So an agent that finishes
// while no daemon runs is still reported, with its real exit code.
//
// The developer can step into a session and back out. That part comes with
// the TUI.

import { lastLine } from "../last-line";
import type { SessionEnd, SessionRunner, SessionStart } from "../session-runner";
import type { Done } from "../version-control";

export type TmuxRunnerOptions = {
  // The tmux server's name, such as "skelcrew-3f9a1c2b7d4e". One per
  // repository, so a daemon only ever sees its own repository's agents.
  server: string;
  // How often it looks for sessions that ended.
  checkEveryMs?: number;
};

// How long a stop waits for the agent after asking it politely, and again
// after forcing it.
const graceMs = 2_000;

// The size of the terminal an agent gets, as with the basic runner.
const columns = "120";
const rows = "40";

type Pane = { session: string; dead: boolean; status: number | null; pid: number };

export class TmuxRunner implements SessionRunner {
  readonly canStepIn = true;
  readonly keepsSessions = true;

  private readonly server: string;
  private readonly listeners: ((name: string, end: SessionEnd) => void)[] = [];
  // Sessions whose end is being reported, so it is reported once. A stop
  // that comes meanwhile waits for that report.
  private readonly ending = new Map<string, Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: TmuxRunnerOptions) {
    this.server = options.server;
    this.timer = setInterval(() => void this.reportEnds(), options.checkEveryMs ?? 250);
    // The checks alone never keep the process running.
    this.timer.unref();
  }

  async start(session: SessionStart): Promise<Done<null>> {
    const panes = await this.panes();
    if (panes.some((pane) => pane.session === session.name && !pane.dead)) {
      return { ok: true, value: null };
    }
    // The command runs through env, which drops the variables in `unset`
    // and adds the session's own. tmux would otherwise give the agent the
    // environment the server started with.
    const command = [
      "env",
      ...session.unset.flatMap((name) => ["-u", name]),
      ...Object.entries(session.env).map(([name, value]) => `${name}=${value}`),
      ...session.command,
    ];
    // Both options are set before the first session starts, in the same
    // call. A finished session stays, so its exit code can be read, and
    // shows no "Pane is dead" line of tmux's own under the agent's output.
    const started = await this.tmux(
      "set-option",
      "-g",
      "remain-on-exit",
      "on",
      ";",
      "set-option",
      "-g",
      "remain-on-exit-format",
      "",
      ";",
      "new-session",
      "-d",
      "-s",
      session.name,
      "-c",
      session.cwd,
      "-x",
      columns,
      "-y",
      rows,
      "--",
      ...command,
    );
    if (!started.ok) return { ok: false, message: `The agent couldn't start: ${started.message}` };
    return { ok: true, value: null };
  }

  async type(name: string, text: string): Promise<Done<null>> {
    if (!(await this.isRunning(name))) return { ok: false, message: `${name} isn't running.` };
    // -l types the text as it is, so a word such as "Enter" stays a word.
    const typed = await this.tmux("send-keys", "-t", exact(name), "-l", "--", text);
    if (!typed.ok) return typed;
    const entered = await this.tmux("send-keys", "-t", exact(name), "Enter");
    return entered.ok ? { ok: true, value: null } : entered;
  }

  // Asks the agent to stop, then forces it, as the basic runner does. The
  // signal goes to the agent's whole group of processes: tmux starts each
  // session's command as the leader of a group of its own.
  async stop(name: string): Promise<Done<null>> {
    const already = this.ending.get(name);
    if (already !== undefined) {
      await already;
      return { ok: true, value: null };
    }
    const pane = (await this.panes()).find((found) => found.session === name);
    if (pane === undefined) return { ok: true, value: null };
    const stopping = (async () => {
      if (!pane.dead) {
        signal(pane.pid, "SIGTERM");
        if (!(await this.diesWithin(name, graceMs))) {
          signal(pane.pid, "SIGKILL");
          await this.diesWithin(name, graceMs);
        }
      }
      // A stopped session has no exit code.
      await this.finish(name, null);
    })();
    this.ending.set(name, stopping);
    await stopping;
    return { ok: true, value: null };
  }

  async running(): Promise<Done<string[]>> {
    const panes = await this.panes();
    return { ok: true, value: panes.filter((pane) => !pane.dead).map((pane) => pane.session) };
  }

  onEnd(listener: (name: string, end: SessionEnd) => void): void {
    this.listeners.push(listener);
  }

  // Stops looking. The sessions keep running for the next daemon.
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
  }

  // Reports each session that ended, whether it ended now or while no
  // daemon ran.
  private async reportEnds(): Promise<void> {
    if (this.closed) return;
    for (const pane of await this.panes()) {
      if (!pane.dead || this.ending.has(pane.session)) continue;
      const finishing = this.finish(pane.session, pane.status);
      this.ending.set(pane.session, finishing);
      await finishing;
    }
  }

  // Reads the session's last line, removes it, and reports its end.
  private async finish(name: string, exitCode: number | null): Promise<void> {
    const screen = await this.tmux("capture-pane", "-p", "-t", exact(name), "-S", "-200");
    await this.tmux("kill-session", "-t", exact(name));
    this.ending.delete(name);
    if (this.closed) return;
    const end = { exitCode, lastLine: screen.ok ? lastLine(screen.value) : "" };
    for (const listener of this.listeners) listener(name, end);
  }

  private async isRunning(name: string): Promise<boolean> {
    return (await this.panes()).some((pane) => pane.session === name && !pane.dead);
  }

  private async diesWithin(name: string, ms: number): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 50) {
      const pane = (await this.panes()).find((found) => found.session === name);
      if (pane === undefined || pane.dead) return true;
      await Bun.sleep(50);
    }
    return false;
  }

  // Every session's pane. Each session has one. With no server running,
  // there are none.
  private async panes(): Promise<Pane[]> {
    const listed = await this.tmux(
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}",
    );
    if (!listed.ok) return [];
    return listed.value
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [session = "", dead = "0", status = "", pid = "0"] = line.split("\t");
        return {
          session,
          dead: dead === "1",
          status: status === "" ? null : Number(status),
          pid: Number(pid),
        };
      });
  }

  // Runs tmux on Skelcrew's own server. -f /dev/null keeps your tmux
  // settings out, when this call starts the server.
  private async tmux(...args: string[]): Promise<Done<string>> {
    try {
      const ran = Bun.spawn(["tmux", "-L", this.server, "-f", "/dev/null", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(ran.stdout).text(),
        new Response(ran.stderr).text(),
        ran.exited,
      ]);
      return code === 0 ? { ok: true, value: out } : { ok: false, message: err.trim() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `tmux couldn't run: ${message}` };
    }
  }
}

// A target that matches the session's name exactly. tmux would otherwise
// also match a session whose name starts with it.
function exact(name: string): string {
  return `=${name}:`;
}

// The signal goes to the whole group. A process that is already gone is
// left alone.
function signal(pid: number, name: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, name);
  } catch {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  }
}
