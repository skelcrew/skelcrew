// The harness plugin: everything Skelcrew needs to know about one kind of
// agent, such as Claude Code. The core, the daemon and the session runner
// never assume which agent they run. They ask the harness.
//
// Each call that reads from disk answers with a value, never a throw.

import type { SessionId, TaskId } from "../core/types";
import type { Done } from "./version-control";

// A spec agent writes a task's spec. A develop agent builds it.
export type AgentKind = "spec" | "develop";

// One agent to start: its task, what it does, Skelcrew's name for its
// session, the worktree it works in, and the repository's check commands
// from workflow.yml, which a develop agent may run before it reports done.
export type AgentToStart = {
  taskId: TaskId;
  kind: AgentKind;
  session: SessionId;
  cwd: string;
  checks: string[];
};

// How to start it: the command for the session runner, the environment it
// adds, and the harness's own ID for the session. Skelcrew keeps that ID
// next to its own session name, as the link to the harness's transcript.
export type Launch = {
  command: string[];
  env: Record<string, string>;
  harnessSession: string;
};

// What an agent has used so far. Tokens leave out cache reads, which are
// counted on their own, since they would swamp the rest. Working time
// leaves out time spent waiting for the developer's answer, so the safety
// cap counts only time the agent works.
export type AgentUsage = { tokens: number; cacheReads: number; workingMs: number };

export interface Harness {
  readonly name: string;

  // The command that starts the agent as an interactive session, with
  // nobody watching. It must never stop at a question nobody can answer.
  launch(agent: AgentToStart): Launch;

  // What the agent has used so far, read from the harness's own record of
  // the session. A session with no record yet has used nothing.
  usage(cwd: string, harnessSession: string): Promise<Done<AgentUsage>>;
}
