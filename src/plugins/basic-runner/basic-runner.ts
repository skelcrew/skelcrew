// The basic runner, built into Skelcrew. The daemon holds each agent's
// session in a pseudo terminal of its own, so the agent sees a real
// terminal and runs interactively, with nothing else installed.
//
// Its limits, by design:
// - The developer can't step into a session. That needs tmux or Herdr.
// - The sessions are the daemon's children, so they end when it stops.
//   After a restart, running() lists none, and the daemon treats their
//   agents as stopped.

import type { Subprocess } from "bun";
import type { SessionEnd, SessionRunner, SessionStart } from "../session-runner";
import type { Done } from "../version-control";

// Enough output to find the last line with text on it.
const keptOutput = 4_096;

// How long a stop waits for the agent to exit after asking politely, and
// again after forcing it.
const graceMs = 2_000;

type Running = { process: Subprocess; output: string };

export class BasicRunner implements SessionRunner {
  readonly canStepIn = false;

  private readonly sessions = new Map<string, Running>();
  private readonly listeners: ((name: string, end: SessionEnd) => void)[] = [];
  private readonly stopping = new Map<string, Promise<void>>();

  async start(session: SessionStart): Promise<Done<null>> {
    if (this.sessions.has(session.name)) return { ok: true, value: null };
    let started: Subprocess;
    try {
      started = Bun.spawn(session.command, {
        cwd: session.cwd,
        env: { ...process.env, ...session.env },
        terminal: {
          cols: 120,
          rows: 40,
          data: (_terminal, data) => this.keep(session.name, data),
        },
        onExit: (exited) => this.ended(session.name, exitCode(exited)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `The agent couldn't start: ${message}` };
    }
    this.sessions.set(session.name, { process: started, output: "" });
    return { ok: true, value: null };
  }

  async type(name: string, text: string): Promise<Done<null>> {
    const terminal = this.sessions.get(name)?.process.terminal;
    if (terminal === undefined) return { ok: false, message: `${name} isn't running.` };
    // A terminal sends Enter as a carriage return.
    terminal.write(`${text}\r`);
    return { ok: true, value: null };
  }

  async stop(name: string): Promise<Done<null>> {
    await this.halt(name);
    return { ok: true, value: null };
  }

  async running(): Promise<Done<string[]>> {
    return { ok: true, value: [...this.sessions.keys()] };
  }

  onEnd(listener: (name: string, end: SessionEnd) => void): void {
    this.listeners.push(listener);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((name) => this.halt(name)));
  }

  // Asks the agent to stop, then forces it. An agent that ignores the first
  // signal is still stopped. If its exit is never reported, the session is
  // counted as ended anyway, so a stop never waits forever.
  private halt(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (session === undefined) return Promise.resolve();
    const already = this.stopping.get(name);
    if (already !== undefined) return already;
    const { pid } = session.process;
    const halting = (async () => {
      signal(pid, "SIGTERM");
      if (!(await exitsWithin(session.process, graceMs))) {
        signal(pid, "SIGKILL");
        await exitsWithin(session.process, graceMs);
      }
      // Reported here as well as on exit, so the end is known when the stop
      // returns. Only the first report counts.
      this.ended(name, exitCode(session.process));
    })().finally(() => this.stopping.delete(name));
    this.stopping.set(name, halting);
    return halting;
  }

  // Keeps the end of the session's output, for its last line.
  private keep(name: string, data: Uint8Array): void {
    const session = this.sessions.get(name);
    if (session === undefined) return;
    session.output = (session.output + new TextDecoder().decode(data)).slice(-keptOutput);
  }

  private ended(name: string, exitCode: number | null): void {
    const session = this.sessions.get(name);
    if (session === undefined) return;
    this.sessions.delete(name);
    const end = { exitCode, lastLine: lastLine(session.output) };
    for (const listener of this.listeners) listener(name, end);
  }
}

// The agent leads its own group of processes, so the signal reaches
// whatever it started too. A process that is already gone is left alone.
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

// A session ended by a signal, such as a stop, has no exit code. Nor has
// one whose exit was never reported.
function exitCode(running: Subprocess): number | null {
  return running.signalCode === null ? running.exitCode : null;
}

// Whether the process exits within the time given.
async function exitsWithin(running: Subprocess, ms: number): Promise<boolean> {
  return Promise.race([running.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

// The last line with text on it, without the codes a terminal uses for
// colour, cursor moves and window titles.
export function lastLine(output: string): string {
  const plain = output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal codes start with ESC.
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal codes start with ESC.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the rest of ESC's codes.
    .replace(/\u001b[@-_]/g, "");
  const lines = plain.split(/\r?\n|\r/).map((line) => line.trim());
  return lines.filter((line) => line !== "").at(-1) ?? "";
}
