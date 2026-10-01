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

type Running = { process: Subprocess; output: string };

export class BasicRunner implements SessionRunner {
  readonly canStepIn = false;

  private readonly sessions = new Map<string, Running>();
  private readonly listeners: ((name: string, end: SessionEnd) => void)[] = [];

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
        onExit: (_process, exitCode, signalCode) => {
          // A session ended by a signal, such as a stop, has no exit code.
          this.ended(session.name, signalCode === null ? exitCode : null);
        },
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
    this.sessions.get(name)?.process.kill();
    return { ok: true, value: null };
  }

  async running(): Promise<Done<string[]>> {
    return { ok: true, value: [...this.sessions.keys()] };
  }

  onEnd(listener: (name: string, end: SessionEnd) => void): void {
    this.listeners.push(listener);
  }

  async close(): Promise<void> {
    const ending = [...this.sessions.values()].map(({ process: running }) => {
      running.kill();
      return running.exited;
    });
    await Promise.all(ending);
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
