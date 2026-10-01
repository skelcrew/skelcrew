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
import { schedule, slotsInUse } from "../core/schedule";
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
  SessionId,
  Task,
  TaskEvent,
  TaskId,
} from "../core/types";

// Carries out the core's commands: starting agents, creating worktrees,
// running gates, merging. Replies come back later through Loop.send.
//
// A tool calls `finished` once the command's work is done. For a command
// that expects a reply, that means once the reply has been handled: saved,
// or refused because its time had passed. Until
// then the command counts as not done, so if the daemon dies first, work
// that was still going on isn't lost: the command goes out again after
// the restart. A tool whose work can't be lost, such as a real agent
// already running on its own, may call it as soon as it has handed the
// work on.
//
// So a command can arrive twice. Doing it twice must have the same effect
// as doing it once. For example, a second start for the same task and
// request starts nothing.
//
// An agent being stopped keeps its slot until its stop has finished, so a
// slow stop delays the next start rather than letting agents run past
// max_running.
export interface Tools {
  carryOut(command: Command, finished: () => void): void;
}

// A start the loop has sent out: an agent or worktree for one request.
export type StartRef = { taskId: TaskId; request: number };

// The starts a decision sent out, and the one its input answered. They're
// saved with its events, so a restart knows which starts are still out.
export type Starts = { sent: StartRef[]; answered: StartRef[] };

export type Saved = { ok: true } | { ok: false; reason: string };

// A saved decision, with the id of each of its commands, in order.
export type Queued = { ok: true; ids: number[] } | { ok: false; reason: string };

// A command saved with its decision and not yet carried out.
export type SavedCommand = { id: number; command: Command };

// A damaged log is reported with the position of the first event that
// couldn't be read or didn't fit, so it can be found and looked at.
export type Loaded<T> = ({ ok: true } & T) | { ok: false; seq: number; reason: string };

// Where events are saved, with the starts each decision sent out and the one
// its input answered. EventStore is the real one.
//
// Commands are saved with the events that caused them, and marked when
// they are carried out. So a daemon that dies in between loses nothing: the
// commands still waiting go out after the restart.
export interface EventLog {
  appendTask(events: TaskEvent[], starts: Starts, commands: Command[]): Queued;
  appendProject(events: ProjectEvent[]): Saved;
  carriedOut(id: number): Saved;
}

// A saved log that can be read back, to pick up where a loop left off.
export interface ReadableLog extends EventLog {
  loadTasks(): Loaded<{ tasks: Map<TaskId, Task> }>;
  loadProjects(): Loaded<{ projects: Map<ProjectId, Project> }>;
  loadStarts(): StartRef[];
  loadCommands(): Loaded<{ commands: SavedCommand[] }>;
}

export class Loop {
  private readonly taskMap: Map<TaskId, Task>;
  private readonly projectMap: Map<ProjectId, Project>;
  // Starts sent out and not yet answered, as "task:request".
  private readonly pending = new Set<string>();
  // Agents being stopped, with how many of their stops haven't finished.
  // Each agent counts once, however many stops it was sent.
  private readonly stopping = new Map<SessionId, number>();

  constructor(
    private readonly config: Config,
    private readonly tools: Tools,
    private readonly log: EventLog | null,
    tasks: Map<TaskId, Task> = new Map(),
    projects: Map<ProjectId, Project> = new Map(),
    starts: StartRef[] = [],
  ) {
    this.taskMap = tasks;
    this.projectMap = projects;
    for (const start of starts) this.pending.add(key(start.taskId, start.request));
  }

  // Rebuilds tasks and projects from a saved log, then carries on from there.
  // Commands saved but not carried out before the last stop go out first.
  static open(
    config: Config,
    tools: Tools,
    log: ReadableLog,
  ): { ok: true; loop: Loop } | { ok: false; reason: string } {
    const tasks = log.loadTasks();
    if (!tasks.ok) return { ok: false, reason: `Event ${tasks.seq}: ${tasks.reason}` };
    const projects = log.loadProjects();
    if (!projects.ok) return { ok: false, reason: `Event ${projects.seq}: ${projects.reason}` };
    const waiting = log.loadCommands();
    if (!waiting.ok) return { ok: false, reason: `Command ${waiting.seq}: ${waiting.reason}` };
    const loop = new Loop(config, tools, log, tasks.tasks, projects.projects, log.loadStarts());
    for (const { id, command } of waiting.commands) loop.carryOut(id, command);
    return { ok: true, loop };
  }

  get startsInFlight(): number {
    return this.pending.size;
  }

  get stopsInFlight(): number {
    return this.stopping.size;
  }

  // Slots taken by work on its way up or down: starts not yet answered,
  // and stops not yet finished. An agent being stopped holds its slot
  // until it has stopped, so max_running holds even while stops are slow.
  // Stops still to do are saved commands, so this survives a restart.
  private get inFlight(): number {
    return this.pending.size + this.stopping.size;
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
    // decide sees one task, so it can't tell whether a slot is free. A
    // start only comes from the scheduler, which checks. A claim is checked
    // here.
    if (input.type === "claim") {
      const inUse = slotsInUse(this.tasks(), this.inFlight);
      if (inUse >= this.config.maxRunning) {
        const reason = `No slot is free: ${inUse} of ${this.config.maxRunning} agents are working, starting or stopping.`;
        return { ok: false, rejection: { input: input.type, reason } };
      }
    }
    const before = this.taskMap.get(taskId) ?? null;
    const decision = decideTask(before, { taskId, at, input }, this.config, this.projectMap);
    // A reply answers its start once it has been handled: refused, or its
    // events saved. If saving fails, the start stays counted, since the task
    // never recorded what the reply said.
    // A refused reply still answers its start, so that must be saved too.
    // If it can't be, the caller hears about the failed save, not the
    // refusal, so it sends the reply again.
    const answered = answersStart(input) ? [{ taskId, request: input.request }] : [];
    const events = decision.ok ? decision.events : [];
    const sent = decision.ok
      ? decision.commands.filter(startsSomething).map((command) => ({
          taskId: command.taskId,
          request: command.request,
        }))
      : [];
    const commands = decision.ok ? decision.commands : [];
    const saved = this.save(events, { sent, answered }, commands);
    if (!saved.ok) {
      return {
        ok: false,
        rejection: { input: input.type, reason: `The events couldn't be saved: ${saved.reason}` },
      };
    }
    if (!decision.ok) return decision;
    for (const event of decision.events) this.apply(event);
    for (const [i, command] of commands.entries()) this.carryOut(saved.ids[i] ?? null, command);
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
    const picks = schedule(this.tasks(), this.projectMap, this.config, this.inFlight);
    for (const taskId of picks) this.send(taskId, { by: "system", type: "start" }, at);
    return picks;
  }

  // Saves a decision's events, starts and commands, then updates the count
  // of starts in flight to match. Nothing changes if saving fails. Without
  // a log, commands get no ids and are only carried out.
  private save(events: TaskEvent[], starts: Starts, commands: Command[]): Queued {
    const nothing =
      events.length === 0 &&
      starts.sent.length === 0 &&
      starts.answered.length === 0 &&
      commands.length === 0;
    let ids: number[] = [];
    if (this.log !== null && !nothing) {
      const saved = this.log.appendTask(events, starts, commands);
      if (!saved.ok) return saved;
      ids = saved.ids;
    }
    for (const start of starts.answered) this.pending.delete(key(start.taskId, start.request));
    for (const start of starts.sent) this.pending.add(key(start.taskId, start.request));
    return { ok: true, ids };
  }

  // Hands one command to the tools. It is marked done only when the tool
  // says it has finished. A stop holds its agent's slot until then.
  //
  // `finished` never throws: it runs inside the tool's own code, often
  // later, where an error could go unhandled. If marking fails, the command
  // simply goes out again after a restart, which the tools allow.
  //
  // A stop counts from the moment it is handed over. If the tool throws
  // instead of taking it, the count is undone before the error goes on, so
  // the slot isn't held for a stop that never started.
  private carryOut(id: number | null, command: Command): void {
    const agent = command.type === "stop_session" ? command.session : null;
    let counted = false;
    const letGo = () => {
      if (agent !== null && counted) this.stopDone(agent);
      counted = false;
    };
    if (agent !== null) {
      this.stopping.set(agent, (this.stopping.get(agent) ?? 0) + 1);
      counted = true;
    }
    try {
      this.tools.carryOut(command, () => {
        letGo();
        if (id === null || this.log === null) return;
        try {
          this.log.carriedOut(id);
        } catch {
          // Left for the next restart.
        }
      });
    } catch (error) {
      letGo();
      throw error;
    }
  }

  // One stop for this agent has finished. The agent keeps its slot until
  // every stop it was sent has.
  private stopDone(agent: SessionId): void {
    const left = (this.stopping.get(agent) ?? 1) - 1;
    if (left > 0) this.stopping.set(agent, left);
    else this.stopping.delete(agent);
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
  {
    type:
      | "start_spec_session"
      | "start_develop_session"
      | "create_worktree"
      | "create_spec_worktree";
  }
>;
// A crash names the request that started the agent, so it answers the start
// too: the agent may crash before its start reply arrives, or instead of it.
type StartReply = Extract<
  Input,
  {
    type:
      | "session_started"
      | "session_failed"
      | "session_crashed"
      | "worktree_created"
      | "worktree_failed"
      | "spec_worktree_created"
      | "spec_worktree_failed";
  }
>;

function startsSomething(command: Command): command is Start {
  return (
    command.type === "start_spec_session" ||
    command.type === "start_develop_session" ||
    command.type === "create_worktree" ||
    command.type === "create_spec_worktree"
  );
}

function answersStart(input: Input): input is StartReply {
  return (
    input.type === "session_started" ||
    input.type === "session_failed" ||
    input.type === "session_crashed" ||
    input.type === "worktree_created" ||
    input.type === "worktree_failed" ||
    input.type === "spec_worktree_created" ||
    input.type === "spec_worktree_failed"
  );
}

function key(taskId: TaskId, request: number): string {
  return `${taskId}:${request}`;
}
