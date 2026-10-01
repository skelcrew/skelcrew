// The session-runner plugin: holds each agent's session in a terminal that
// stays open whether or not the developer is in it. The basic runner is
// built in. tmux and Herdr are runners the developer can pick instead, and
// they also let the developer step into a session and back out.
//
// A runner knows nothing about which agent it runs. The harness profile
// gives it the command, and the agent reports through the CLI.
//
// Each call answers with a value, never a throw.

import type { Done } from "./version-control";

// One agent's session: its name, the profile's command, the folder it
// works in, and the environment it adds, such as SKELCREW_SESSION.
export type SessionStart = {
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
};

// How a session ended. The exit code is null when the runner doesn't know
// it, such as for a session stopped by a signal. The last line is the last
// line of output with text on it, so the inbox can say what the agent was
// doing.
export type SessionEnd = { exitCode: number | null; lastLine: string };

export interface SessionRunner {
  // Whether the developer can step into a session and back out.
  readonly canStepIn: boolean;

  // Starts the command as an interactive session. Asked again for a name
  // that is still running, it starts nothing, so a repeated start never
  // makes a second agent.
  start(session: SessionStart): Promise<Done<null>>;

  // Types the text into the session, then presses Enter, as the developer
  // would. Refused for a session that isn't running.
  type(name: string, text: string): Promise<Done<null>>;

  // Ends the session. Stopping one that already ended does nothing.
  stop(name: string): Promise<Done<null>>;

  // The sessions still open, so the daemon can tell after a restart which
  // agents are still there.
  running(): Promise<Done<string[]>>;

  // Called once for each session that ends, whether it exited, crashed or
  // was stopped.
  onEnd(listener: (name: string, end: SessionEnd) => void): void;

  // Ends every session, when the daemon stops.
  close(): Promise<void>;
}
