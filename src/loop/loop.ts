// The loop: what every host of the core does with an input. The daemon runs
// it with real tools, and the simulator with fake ones.
//
// For each input it asks decideTask, saves the events, applies them with
// evolveTask, and hands the commands to the tools. The order matters: events
// are saved before anything else happens, so if saving fails, the task
// doesn't change and no command goes out. The tools answer later, as new
// inputs.
//
// It also counts the starts it has sent out and not yet had answered, by
// request number, and gives that count to the scheduler. A task dropped while
// its agent was starting no longer says so, but the agent is still on its
// way up and needs its slot until it reports in.

import { decideTask } from "../core/decide";
import { evolveTask } from "../core/evolve";
import { decideProject, evolveProject } from "../core/projects";
import { schedule } from "../core/schedule";
import type {
  Command,
  Config,
  Decision,
  Input,
  Project,
  ProjectDecision,
  ProjectEvent,
  ProjectId,
  ProjectInput,
  Task,
  TaskEvent,
  TaskId,
} from "../core/types";

// Carries out the core's commands: starting agents, creating worktrees,
// running gates, merging. Replies come back later through Loop.send.
export interface Tools {
  carryOut(command: Command): void;
}

// Where events are saved. EventStore is the real one.
export interface EventLog {
  appendTask(events: TaskEvent[]): { ok: true } | { ok: false; reason: string };
  appendProject(events: ProjectEvent[]): { ok: true } | { ok: false; reason: string };
}

// A saved log that can be read back, to pick up where a loop left off.
export interface ReadableLog extends EventLog {
  loadTasks(): { ok: true; tasks: Map<TaskId, Task> } | { ok: false; seq: number; reason: string };
  loadProjects():
    | { ok: true; projects: Map<ProjectId, Project> }
    | { ok: false; seq: number; reason: string };
}

export class Loop {
  private readonly taskMap: Map<TaskId, Task>;
  private readonly projectMap: Map<ProjectId, Project>;
  // Starts sent out and not yet answered, as "task:request".
  private readonly pending = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly tools: Tools,
    private readonly log: EventLog | null,
    tasks: Map<TaskId, Task> = new Map(),
    projects: Map<ProjectId, Project> = new Map(),
  ) {
    this.taskMap = tasks;
    this.projectMap = projects;
  }

  // Rebuilds tasks and projects from a saved log, then carries on from there.
  static open(
    config: Config,
    tools: Tools,
    log: ReadableLog,
  ): { ok: true; loop: Loop } | { ok: false; reason: string } {
    const tasks = log.loadTasks();
    if (!tasks.ok) return { ok: false, reason: `Event ${tasks.seq}: ${tasks.reason}` };
    const projects = log.loadProjects();
    if (!projects.ok) return { ok: false, reason: `Event ${projects.seq}: ${projects.reason}` };
    return { ok: true, loop: new Loop(config, tools, log, tasks.tasks, projects.projects) };
  }

  get startsInFlight(): number {
    return this.pending.size;
  }

  task(taskId: TaskId): Task {
    const task = this.taskMap.get(taskId);
    if (task === undefined) throw new Error(`There is no task #${taskId}.`);
    return task;
  }

  tasks(): Task[] {
    return [...this.taskMap.values()];
  }

  projects(): ReadonlyMap<ProjectId, Project> {
    return this.projectMap;
  }

  // One input for one task, at the given time: the clock by default, or a
  // simulated one in tests.
  send(taskId: TaskId, input: Input, at: number = Date.now()): Decision {
    const before = this.taskMap.get(taskId) ?? null;
    const decision = decideTask(before, { taskId, at, input }, this.config, this.projectMap);
    // A reply answers its start once it has been handled: refused, or its
    // events saved. If saving fails below, the start stays counted, since
    // the task never recorded what the reply said.
    if (!decision.ok) {
      this.answered(taskId, input);
      return decision;
    }

    if (this.log !== null && decision.events.length > 0) {
      const saved = this.log.appendTask(decision.events);
      if (!saved.ok) {
        return {
          ok: false,
          rejection: { input: input.type, reason: `The events couldn't be saved: ${saved.reason}` },
        };
      }
    }
    this.answered(taskId, input);
    for (const event of decision.events) this.apply(event);
    for (const command of decision.commands) {
      if (startsSomething(command)) this.pending.add(key(command.taskId, command.request));
      this.tools.carryOut(command);
    }
    return decision;
  }

  sendProject(projectId: ProjectId, input: ProjectInput, at: number = Date.now()): ProjectDecision {
    const before = this.projectMap.get(projectId) ?? null;
    const decision = decideProject(before, { projectId, at, input });
    if (!decision.ok) return decision;
    if (this.log !== null) {
      const saved = this.log.appendProject(decision.events);
      if (!saved.ok) {
        return {
          ok: false,
          rejection: { input: input.type, reason: `The events couldn't be saved: ${saved.reason}` },
        };
      }
    }
    for (const event of decision.events) {
      const result = evolveProject(this.projectMap.get(projectId) ?? null, event);
      if (!result.ok)
        throw new Error(`evolveProject refused decideProject's event: ${result.reason}`);
      this.projectMap.set(projectId, result.project);
    }
    return decision;
  }

  // Starts what the scheduler picks, within max_running. Returns the tasks
  // it started.
  startWaiting(at: number = Date.now()): TaskId[] {
    const picks = schedule(this.tasks(), this.projectMap, this.config, this.startsInFlight);
    for (const taskId of picks) this.send(taskId, { by: "system", type: "start" }, at);
    return picks;
  }

  private answered(taskId: TaskId, input: Input): void {
    if (answersStart(input)) this.pending.delete(key(taskId, input.request));
  }

  // decideTask never produces an event evolveTask refuses. If it ever does,
  // that is a bug in the core, and carrying on would build a wrong task.
  private apply(event: TaskEvent): void {
    const result = evolveTask(this.taskMap.get(event.taskId) ?? null, event);
    if (!result.ok) throw new Error(`evolveTask refused decideTask's event: ${result.reason}`);
    this.taskMap.set(event.taskId, result.task);
  }
}

type Start = Extract<
  Command,
  { type: "start_spec_session" | "start_develop_session" | "create_worktree" }
>;
type StartReply = Extract<
  Input,
  { type: "session_started" | "session_failed" | "worktree_created" | "worktree_failed" }
>;

function startsSomething(command: Command): command is Start {
  return (
    command.type === "start_spec_session" ||
    command.type === "start_develop_session" ||
    command.type === "create_worktree"
  );
}

function answersStart(input: Input): input is StartReply {
  return (
    input.type === "session_started" ||
    input.type === "session_failed" ||
    input.type === "worktree_created" ||
    input.type === "worktree_failed"
  );
}

function key(taskId: TaskId, request: number): string {
  return `${taskId}:${request}`;
}
