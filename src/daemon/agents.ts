// The agents Skelcrew starts itself. When the core asks for a spec or
// develop agent, this names its session, asks the harness for the command,
// starts it through the session runner, and records it.
//
// The record is what tells Skelcrew's agents apart from your own sessions:
// it only stops or types into sessions it started. It also links each agent
// to its task, its request, and the harness's own session ID, so its end
// can be reported and its transcript found, after a restart too.

import * as z from "zod";
import { SessionId, TaskId } from "../core/ids";
import type { Command } from "../core/types";
import type { Loaded, Saved } from "../loop/loop";
import type { Harness } from "../plugins/harness";
import type { SessionEnd, SessionRunner } from "../plugins/session-runner";
import type { Done } from "../plugins/version-control";

export const agentRecord = z.strictObject({
  session: SessionId,
  task: TaskId,
  // The request that started it, so its end can name it.
  request: z.number().int().positive(),
  kind: z.enum(["spec", "develop"]),
  harnessSession: z.string(),
  cwd: z.string(),
  ended: z.boolean(),
});
export type AgentRecord = z.infer<typeof agentRecord>;

export interface AgentLog {
  loadAgents(): Loaded<{ agents: AgentRecord[] }>;
  saveAgent(agent: AgentRecord): Saved;
}

type StartCommand = Extract<Command, { type: "start_spec_session" | "start_develop_session" }>;

export type AgentsOptions = {
  runner: SessionRunner;
  harness: Harness;
  log: AgentLog;
  // The repository's check commands, which a develop agent may run.
  checks: string[];
  // Names each session, such as "session-k3x9q2mf".
  newSession: () => string;
};

export class Agents {
  private readonly runner: SessionRunner;
  private readonly harness: Harness;
  private readonly log: AgentLog;
  private readonly checks: string[];
  private readonly newSession: () => string;
  private readonly records = new Map<string, AgentRecord>();
  private readonly listeners: ((agent: AgentRecord, end: SessionEnd) => void)[] = [];
  private detached = false;

  constructor(options: AgentsOptions) {
    this.runner = options.runner;
    this.harness = options.harness;
    this.log = options.log;
    this.checks = options.checks;
    this.newSession = options.newSession;
    const loaded = this.log.loadAgents();
    if (loaded.ok) for (const agent of loaded.agents) this.records.set(agent.session, agent);
    this.runner.onEnd((name, end) => {
      const agent = this.records.get(name);
      if (this.detached || agent === undefined || agent.ended) return;
      this.ended(agent);
      for (const listener of this.listeners) listener(agent, end);
    });
  }

  // Starts the agent a command asks for. The same start again, such as
  // after a restart, gives back the agent already running for it.
  async start(command: StartCommand): Promise<Done<SessionId>> {
    const running = [...this.records.values()].find(
      (agent) => agent.task === command.taskId && agent.request === command.request && !agent.ended,
    );
    if (running !== undefined) return { ok: true, value: running.session };

    const named = SessionId.safeParse(this.newSession());
    if (!named.success)
      return { ok: false, message: "Skelcrew couldn't name the agent's session." };
    const session = named.data;
    const kind = command.type === "start_spec_session" ? "spec" : "develop";
    const cwd = command.worktree.path;
    const launch = this.harness.launch({
      taskId: command.taskId,
      kind,
      session,
      cwd,
      checks: this.checks,
    });
    const agent: AgentRecord = {
      session,
      task: command.taskId,
      request: command.request,
      kind,
      harnessSession: launch.harnessSession,
      cwd,
      ended: false,
    };
    // Recorded before it starts, so a restart in between still knows it.
    this.records.set(session, agent);
    this.log.saveAgent(agent);
    const started = await this.runner.start({
      name: session,
      command: launch.command,
      cwd,
      env: launch.env,
    });
    if (!started.ok) {
      this.ended(agent);
      return started;
    }
    return { ok: true, value: session };
  }

  // Types into an agent's session, such as your answer. Your own sessions
  // are never touched.
  async type(session: SessionId, text: string): Promise<void> {
    if (!this.isRunning(session)) return;
    await this.runner.type(session, text);
  }

  async stop(session: SessionId): Promise<void> {
    if (!this.isRunning(session)) return;
    await this.runner.stop(session);
  }

  // Called with the agent and how it ended, for each agent that ends.
  onEnd(listener: (agent: AgentRecord, end: SessionEnd) => void): void {
    this.listeners.push(listener);
  }

  // The agents recorded as running that the runner no longer has, such as
  // the basic runner's after a restart. Each is given back once.
  async lost(): Promise<AgentRecord[]> {
    const open = await this.runner.running();
    const still = new Set(open.ok ? open.value : []);
    const lost = [...this.records.values()].filter(
      (agent) => !agent.ended && !still.has(agent.session),
    );
    for (const agent of lost) this.ended(agent);
    return lost;
  }

  // Stops hearing about ends, when the daemon stops. An agent that ends
  // after that stays recorded as running, so the next start finds it lost
  // and tells the core, instead of the end going unheard.
  detach(): void {
    this.detached = true;
  }

  private isRunning(session: SessionId): boolean {
    const agent = this.records.get(session);
    return agent !== undefined && !agent.ended;
  }

  private ended(agent: AgentRecord): void {
    const done = { ...agent, ended: true };
    this.records.set(agent.session, done);
    this.log.saveAgent(done);
  }
}
