// The simulator: the loop the daemon runs, with fake tools in place of real
// ones.
//
// The loop takes each input through the core, saves the events and hands
// out the commands. Here each command goes to a fake tool, which answers the
// way the real one would: a worktree gets created, an agent starts, a gate
// passes. The fake agents then do their job, driven by each task's
// behaviour. When nothing is left to do, the loop starts what the scheduler
// picks.
//
// It is test machinery, not rules, so it lives outside the core.

import { CommitSha, SessionId, TaskId } from "../core/ids";
import { type WaitingOn, waitingOnYou } from "../core/task";
import type {
  Command,
  Config,
  Decision,
  GateName,
  HumanInput,
  Input,
  Project,
  ProjectId,
  Spec,
  Task,
  TaskEvent,
} from "../core/types";
import { Loop, type Tools } from "../loop/loop";

// How a task's fake agents and tools behave. Anything left out goes well:
// gates pass, merges land, and agents never ask or give up.
export type Behaviour = {
  specQuestion?: string; // the spec agent asks this once, and submits after your answer
  changedFiles?: string[]; // what the develop agent changes
  giveUp?: boolean; // the develop agent gives up instead of reporting done
  gates?: Partial<Record<GateName, boolean[]>>; // each gate's results in order
  merges?: ("ok" | "conflict")[]; // each merge's result in order
};

// Something a task waits on you for, like an inbox item.
export type Waiting = {
  task: TaskId;
  for: WaitingOn;
};

type Queued = { taskId: TaskId; input: Input };
type Agent = { taskId: TaskId; kind: "spec" | "develop" };

// Safety net: a loop that never goes quiet is a bug, not a long test.
const maxSteps = 10_000;

export class Simulator implements Tools {
  readonly events: TaskEvent[] = [];
  readonly rejections: { taskId: TaskId; input: Input; reason: string }[] = [];
  mostAgentsAtOnce = 0;

  private readonly loop: Loop;
  private readonly behaviours = new Map<TaskId, Behaviour>();
  private readonly queue: Queued[] = [];
  private readonly agents = new Map<SessionId, Agent>();
  private readonly worktrees = new Set<string>();
  // How many times each task's gates and merges have run, and whether its
  // spec agent has asked its question yet.
  private readonly gateRuns = new Map<string, number>();
  private readonly mergeRuns = new Map<TaskId, number>();
  private readonly asked = new Set<TaskId>();
  private now = 0;
  private counter = 0;
  private heads = 0;

  constructor(
    readonly config: Config,
    projects: Project[] = [],
  ) {
    // The saved events are kept in memory, for tests to read. The simulator
    // never restarts, so its commands need no ids.
    const log = {
      appendTask: (events: TaskEvent[]) => {
        this.events.push(...events);
        return { ok: true as const, ids: [] };
      },
      appendProject: () => ({ ok: true as const }),
      carriedOut: () => ({ ok: true as const }),
    };
    this.loop = new Loop(
      config,
      this,
      log,
      new Map(),
      new Map(projects.map((project) => [project.id, project])),
    );
  }

  // `skelcrew add`: creates the next task, then runs until quiet.
  add(
    title: string,
    options: { requestSpec?: boolean; project?: ProjectId | null; behaviour?: Behaviour } = {},
  ): TaskId {
    const taskId = TaskId.parse(this.loop.tasks().length + 1);
    this.behaviours.set(taskId, options.behaviour ?? {});
    const decision = this.step(taskId, {
      by: "human",
      type: "add",
      title,
      project: options.project ?? null,
      requestSpec: options.requestSpec ?? false,
    });
    if (!decision.ok) throw new Error(decision.rejection.reason);
    return taskId;
  }

  // An input from you, like an approval or an answer. Runs until quiet after.
  send(taskId: TaskId, input: HumanInput): Decision {
    const decision = this.step(taskId, { ...input, by: "human" });
    this.run();
    return decision;
  }

  // Works through every queued input, and starts what the scheduler picks,
  // until nothing is left to do.
  run(): void {
    for (let steps = 0; steps < maxSteps; steps++) {
      const next = this.queue.shift();
      if (next !== undefined) {
        this.step(next.taskId, next.input);
        continue;
      }
      this.now += 1_000;
      const picks = this.loop.startWaiting(this.now);
      this.mostAgentsAtOnce = Math.max(this.mostAgentsAtOnce, this.agents.size);
      if (picks.length === 0) return;
    }
    throw new Error(`The simulation didn't go quiet within ${maxSteps} steps.`);
  }

  task(taskId: TaskId): Task {
    return this.loop.task(taskId);
  }

  waitingOnYou(): Waiting[] {
    const waiting: Waiting[] = [];
    for (const task of this.loop.tasks()) {
      const why = waitingOnYou(task);
      if (why !== null) waiting.push({ task: task.id, for: why });
    }
    return waiting;
  }

  liveSessions(): SessionId[] {
    return [...this.agents.keys()];
  }

  liveWorktrees(): string[] {
    return [...this.worktrees];
  }

  // ---------------------------------------------------------------------------
  // One input, through the loop
  // ---------------------------------------------------------------------------

  private step(taskId: TaskId, input: Input): Decision {
    this.now += 1_000;
    const decision = this.loop.send(taskId, input, this.now);
    if (!decision.ok) {
      this.rejections.push({ taskId, input, reason: decision.rejection.reason });
      return decision;
    }
    // A new agent is recorded, so it starts its work.
    if (input.type === "session_started" && decision.events.length > 0) {
      this.agentStarted(input.session);
    }
    this.mostAgentsAtOnce = Math.max(this.mostAgentsAtOnce, this.agents.size);
    return decision;
  }

  // ---------------------------------------------------------------------------
  // The fake tools
  // ---------------------------------------------------------------------------

  // Called by the loop for each command: the fake tools.
  carryOut(command: Command): void {
    switch (command.type) {
      case "start_spec_session":
        this.startAgent(command.taskId, command.request, "spec");
        return;

      case "start_develop_session":
        this.startAgent(command.taskId, command.request, "develop");
        return;

      case "stop_session":
        this.agents.delete(command.session);
        return;

      // A message reaches the agent: your answer, or a gate failure to fix.
      case "send_to_session": {
        const agent = this.agents.get(command.session);
        if (agent === undefined) return;
        if (agent.kind === "spec") {
          this.submitSpec(agent.taskId, command.session);
          return;
        }
        this.reportDone(agent.taskId, command.session);
        return;
      }

      case "create_worktree": {
        const path = `/sim/worktrees/${command.taskId}-${command.build}`;
        const branch = `task/${command.taskId}-build-${command.build}`;
        this.worktrees.add(path);
        this.reply(command.taskId, {
          by: "plugin",
          type: "worktree_created",
          worktree: { path, branch },
          request: command.request,
        });
        return;
      }

      case "remove_worktree":
        this.worktrees.delete(command.worktree.path);
        return;

      case "run_gate": {
        const key = `${command.taskId}:${command.gate}`;
        const run = this.gateRuns.get(key) ?? 0;
        this.gateRuns.set(key, run + 1);
        const ok = this.behaviour(command.taskId).gates?.[command.gate]?.[run] ?? true;
        this.reply(command.taskId, {
          by: "plugin",
          type: "gate_result",
          gate: command.gate,
          request: command.request,
          ok,
          summary: ok ? "Passed." : `The ${command.gate} gate failed.`,
        });
        return;
      }

      case "merge": {
        const run = this.mergeRuns.get(command.taskId) ?? 0;
        this.mergeRuns.set(command.taskId, run + 1);
        const result = this.behaviour(command.taskId).merges?.[run] ?? "ok";
        if (result === "conflict") {
          this.reply(command.taskId, {
            by: "plugin",
            type: "merge_failed",
            request: command.request,
            summary: "Conflicts with main.",
          });
          return;
        }
        this.reply(command.taskId, {
          by: "plugin",
          type: "merged",
          request: command.request,
          commit: this.commit(),
        });
        return;
      }

      case "revert":
        this.reply(command.taskId, { by: "plugin", type: "reverted", request: command.request });
        return;
    }
  }

  private startAgent(taskId: TaskId, request: number, kind: Agent["kind"]): void {
    const session = SessionId.parse(`session-${this.next()}`);
    this.agents.set(session, { taskId, kind });
    this.reply(taskId, { by: "plugin", type: "session_started", request, session });
  }

  // ---------------------------------------------------------------------------
  // The fake agents
  // ---------------------------------------------------------------------------

  private agentStarted(session: SessionId): void {
    const agent = this.agents.get(session);
    if (agent === undefined) return;
    const { taskId } = agent;
    const behaviour = this.behaviour(taskId);

    if (agent.kind === "spec") {
      if (behaviour.specQuestion !== undefined && !this.asked.has(taskId)) {
        this.asked.add(taskId);
        this.reply(taskId, {
          by: "agent",
          type: "ask",
          session,
          text: behaviour.specQuestion,
          options: ["Yes", "No"],
        });
        return;
      }
      this.submitSpec(taskId, session);
      return;
    }

    if (behaviour.giveUp) {
      this.reply(taskId, { by: "agent", type: "give_up", session, message: "I'm stuck." });
      return;
    }
    this.reportDone(taskId, session);
    return;
  }

  private submitSpec(taskId: TaskId, session: SessionId): void {
    const spec: Spec = {
      scope: `Build: ${this.task(taskId).title}.`,
      acceptance: ["It works as described."],
      openQuestions: [],
    };
    this.reply(taskId, { by: "agent", type: "submit_spec", session, spec });
  }

  private reportDone(taskId: TaskId, session: SessionId): void {
    const changedFiles = this.behaviour(taskId).changedFiles ?? [`src/task-${taskId}.ts`];
    this.reply(taskId, {
      by: "agent",
      type: "report_done",
      session,
      branch: { head: this.head(), commits: 1, changedFiles },
    });
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  private reply(taskId: TaskId, input: Input): void {
    this.queue.push({ taskId, input });
  }

  private behaviour(taskId: TaskId): Behaviour {
    return this.behaviours.get(taskId) ?? {};
  }

  // IDs and commits come from a counter, so every run is the same.
  private next(): number {
    this.counter += 1;
    return this.counter;
  }

  // Branch tips have their own counter, so adding them left every other ID
  // as it was. "1eee…", "2eee…": never the same as a zero-padded commit.
  private head(): CommitSha {
    this.heads += 1;
    return CommitSha.parse(this.heads.toString(16).padEnd(40, "e"));
  }

  private commit(): CommitSha {
    return CommitSha.parse(this.next().toString(16).padStart(40, "0"));
  }
}
