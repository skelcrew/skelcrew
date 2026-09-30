// The daemon: where the CLI's requests become core inputs. It holds the
// loop and the event store, turns each protocol command into inputs for the
// core, and carries out the core's commands through its tools. Replies from
// the tools come back as new inputs.
//
// Everything runs one at a time: requests and the tools' replies share one
// queue. Neither the loop nor the git plugin is built for two things at
// once, and it keeps task numbers from ever repeating.
//
// Making and removing worktrees, and reading branches, go to the version
// control plugin, and the local gate to the checks runner. Merging isn't
// wired in yet. A command that needs it is answered at once with a failure,
// so the core never waits on something that won't happen.

import { randomUUID } from "node:crypto";
import { ProjectId, SessionId, TaskId } from "../core/ids";
import { phaseNames, runningSession, waitingOnYou } from "../core/task";
import type {
  BlockReason,
  Config,
  Command as CoreCommand,
  Input,
  Task,
  Worktree,
} from "../core/types";
import { Loop, type ReadableLog, type Tools } from "../loop/loop";
import type { RunChecks, VersionControl } from "../plugins/version-control";
import type { Command } from "../protocol/protocol";

export type Answer = { ok: true; result: unknown } | { ok: false; message: string };

export type DaemonOptions = {
  config: Config;
  log: ReadableLog;
  // The core never makes up IDs, so the daemon names each claimed session.
  newSession?: () => string;
  now?: () => number;
  // A reply whose save failed is sent again after `retryMs`, then twice as
  // long each time, but never more than `maxRetryMs` apart.
  retryMs?: number;
  maxRetryMs?: number;
  // Makes the worktrees and reads their branches. Without it, making one
  // fails at once, and `done` is refused.
  versionControl?: VersionControl;
  // The local gate: runs the repository's checks in a folder. Without it,
  // the gate fails at once.
  runChecks?: RunChecks;
};

// An answer that has to wait for a tool's reply, such as a claim waiting
// for its worktree. `until` says when the task is ready to answer.
type Later = { later: { task: TaskId; until: (task: Task) => boolean; answer: () => Answer } };

type Waiter = { task: TaskId; until: (task: Task) => boolean; wake: (task: Task | null) => void };

export class Daemon {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly newSession: () => string;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly versionControl: VersionControl | null;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;
  private waiters = new Set<Waiter>();

  private constructor(
    private readonly loop: Loop,
    options: DaemonOptions,
  ) {
    this.newSession = options.newSession ?? (() => `session-${randomUUID()}`);
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
    this.versionControl = options.versionControl ?? null;
  }

  // Rebuilds every task from the saved events, and carries out any command
  // that hadn't finished when the last daemon stopped. Then it takes
  // requests. The tools must exist before that, since those commands go to
  // them while the daemon is still being set up. Their replies wait in the
  // queue until it is ready.
  static open(
    options: DaemonOptions,
  ): { ok: true; value: Daemon } | { ok: false; message: string } {
    const tools = new DaemonTools(options.versionControl ?? null, options.runChecks ?? null);
    const opened = Loop.open(options.config, tools, options.log);
    if (!opened.ok)
      return { ok: false, message: `The saved log couldn't be read. ${opened.reason}` };
    const daemon = new Daemon(opened.loop, options);
    tools.connect(
      (taskId, input, finished) => daemon.reply(taskId, input, finished),
      (taskId) => daemon.find(taskId)?.title ?? `#${taskId}`,
    );
    return { ok: true, value: daemon };
  }

  // One request from the CLI, answered once everything before it is done.
  // It always gets an answer: an error, such as a locked database, becomes
  // a refusal that says what happened.
  // An answer that waits for a tool's reply waits outside the queue, so
  // the reply can get in.
  async handle(command: Command): Promise<Answer> {
    if (command.type === "done") return this.done(command.task, command.session);
    const first = await this.oneAtATime(() => {
      const answered = this.guarded(() => this.answer(command));
      // A request can settle a waiting claim too, such as a drop.
      this.wakeWaiters();
      return answered;
    });
    if (!("later" in first)) return first;
    const { task, until, answer } = first.later;
    await this.settled(task, until);
    return this.oneAtATime(() => this.guarded(answer));
  }

  // An agent reports its work done. The daemon reads the task's branch,
  // which the core needs, then waits while the gates run. Reading the
  // branch and waiting both happen outside the queue, so replies can get
  // in. The answer says whether the checks passed, and why not.
  private async done(taskId: TaskId, session: SessionId): Promise<Answer> {
    const versionControl = this.versionControl;
    if (versionControl === null) {
      return { ok: false, message: "`done` needs git, which this daemon doesn't have." };
    }
    const found = await this.oneAtATime(() => this.guarded(() => this.worktreeOf(taskId)));
    if (!("worktree" in found)) return found;

    let facts: Awaited<ReturnType<VersionControl["readBranch"]>>;
    try {
      facts = await versionControl.readBranch(found.worktree);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      facts = { ok: false, message: `git couldn't read the branch: ${message}` };
    }
    if (!facts.ok) return { ok: false, message: facts.message };
    const branch = facts.value;

    const reported = await this.oneAtATime(() =>
      this.guarded(() => this.send(taskId, { by: "agent", type: "report_done", session, branch })),
    );
    if (!reported.ok) return reported;
    // Read at the moment the gates finish. A merge may start right after,
    // and its outcome isn't the checks'.
    const settled = await this.settled(
      taskId,
      (task) => !(task.phase === "checks" && task.step.kind === "gate"),
    );
    if (this.closed || settled === null)
      return { ok: false, message: "The daemon is shutting down." };
    return this.checked(settled);
  }

  private worktreeOf(taskId: TaskId): { worktree: Worktree } | Answer {
    const task = this.find(taskId);
    if (task === null) return { ok: false, message: `#${taskId} doesn't exist.` };
    if (task.phase !== "in_progress") {
      return {
        ok: false,
        message: `#${taskId} isn't in In progress, so there is no work to report.`,
      };
    }
    return { worktree: task.worktree };
  }

  // What `done` tells the agent once the gates have run.
  private checked(task: Task): Answer {
    const taskId = task.id;
    if (task.blocked !== null) return { ok: false, message: describeBlock(task.blocked) };
    switch (task.phase) {
      case "in_progress":
        return {
          ok: true,
          result: {
            passed: false,
            summary: task.brief.failure?.summary ?? "The checks didn't pass.",
          },
        };
      case "checks":
      case "done":
        return { ok: true, result: { passed: true } };
      default:
        return { ok: false, message: `#${taskId} is now in ${task.phase}.` };
    }
  }

  private guarded<T>(work: () => T): T | Answer {
    if (this.closed) return { ok: false, message: "The daemon is shutting down." };
    try {
      return work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Skelcrew couldn't handle that: ${message}` };
    }
  }

  // Resolves once `until` holds for the task, checked after each reply,
  // with the task as it was then. Null if the task is gone. Closing the
  // daemon wakes every waiter.
  private settled(taskId: TaskId, until: (task: Task) => boolean): Promise<Task | null> {
    return new Promise((wake) => {
      const task = this.find(taskId);
      if (task === null || until(task) || this.closed) wake(task);
      else this.waiters.add({ task: taskId, until, wake });
    });
  }

  private wakeWaiters(): void {
    for (const waiter of this.waiters) {
      const task = this.find(waiter.task);
      if (task === null || waiter.until(task) || this.closed) {
        this.waiters.delete(waiter);
        waiter.wake(task);
      }
    }
  }

  private answer(command: Command): Answer | Later {
    switch (command.type) {
      case "add": {
        let project: ProjectId | null = null;
        if (command.project !== null) {
          const parsed = ProjectId.safeParse(command.project);
          if (!parsed.success) {
            return { ok: false, message: `"${command.project}" isn't a project name.` };
          }
          project = parsed.data;
        }
        const task = this.nextTaskId();
        const added = this.send(task, {
          by: "human",
          type: "add",
          title: command.title,
          project,
          requestSpec: command.spec,
        });
        return added.ok ? { ok: true, result: { task } } : added;
      }

      case "spec":
        return this.send(command.task, { by: "human", type: "request_spec" });

      case "approve": {
        const task = this.find(command.task);
        if (task === null) return { ok: false, message: `#${command.task} doesn't exist.` };
        const note = command.sendBack;
        const waiting = waitingOnYou(task);
        const input: Input | null =
          waiting === "spec_approval"
            ? note === null
              ? { by: "human", type: "approve_spec" }
              : { by: "human", type: "revise_spec", note }
            : waiting === "merge_approval"
              ? note === null
                ? { by: "human", type: "approve_merge" }
                : { by: "human", type: "revise_merge", note }
              : null;
        if (input === null) {
          return { ok: false, message: `#${command.task} has nothing waiting for your approval.` };
        }
        return this.send(command.task, input);
      }

      case "drop":
        return this.send(command.task, { by: "human", type: "drop" });

      case "status": {
        const tasks = [...this.loop.tasks()].sort((a, b) => a.id - b.id).map(view);
        return { ok: true, result: { tasks } };
      }

      case "claim": {
        const named = SessionId.safeParse(this.newSession());
        if (!named.success)
          return { ok: false, message: "Skelcrew couldn't name a session for the claim." };
        const session = named.data;
        const claimed = this.send(command.task, { by: "human", type: "claim", session });
        if (!claimed.ok) return claimed;
        // In Ready, the claim waits for the task's worktree, since that is
        // where the session works.
        const making = (task: Task) =>
          task.phase === "ready" && task.step.kind === "creating_worktree";
        return {
          later: {
            task: command.task,
            until: (task) => !making(task),
            answer: () => this.claimed(command.task, session),
          },
        };
      }

      case "submit":
        return this.send(command.task, {
          by: "agent",
          type: "submit_spec",
          session: command.session,
          spec: command.spec,
        });

      case "give_up":
        return this.send(command.task, {
          by: "agent",
          type: "give_up",
          session: command.session,
          message: command.message,
        });

      // Answered in `handle`, since it waits outside the queue.
      case "done":
        return { ok: false, message: "`done` couldn't be handled." };
      case "log":
        return { ok: false, message: `\`${command.type}\` isn't built into the daemon yet.` };
    }
  }

  // Stops the daemon. Requests after this are refused, and replies still
  // waiting to be sent again are dropped. Their commands haven't finished,
  // so they go out again when the daemon next starts. Resolves once the
  // work already in the queue is done, so the store can then be closed.
  close(): Promise<void> {
    this.closed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.wakeWaiters();
    return this.oneAtATime(() => undefined);
  }

  // A tool's reply, as a new input in the same queue as requests. Once it
  // is handled, saved or refused as too late to matter, the command it
  // answers has finished. If it couldn't be saved, whether the save failed
  // or threw, it is sent again later, since the core may be waiting on it.
  // It keeps being sent until it is saved or the daemon closes: a task
  // keeps its slot until then.
  private reply(taskId: TaskId, input: Input, finished: () => void, attempt = 0): void {
    void this.oneAtATime(() => {
      if (this.closed) return;
      let handled: boolean;
      try {
        const decision = this.loop.send(taskId, input, this.now());
        handled =
          decision.ok || !decision.rejection.reason.startsWith("The events couldn't be saved");
      } catch {
        handled = false;
      }
      if (handled) {
        finished();
        this.wakeWaiters();
        return;
      }
      const wait = Math.min(this.retryMs * 2 ** attempt, this.maxRetryMs);
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.reply(taskId, input, finished, attempt + 1);
      }, wait);
      this.retryTimers.add(timer);
    });
  }

  // What a claim tells the session: where the task stands, and where to
  // work once it has a worktree.
  private claimed(taskId: TaskId, session: SessionId): Answer {
    const task = this.loop.task(taskId);
    if (task.blocked !== null) return { ok: false, message: describeBlock(task.blocked) };
    if (task.phase === "dropped") {
      return { ok: false, message: `#${taskId} was dropped before its worktree was made.` };
    }
    if (runningSession(task) !== session) {
      return {
        ok: false,
        message: `#${taskId}'s claim didn't go through. It is in ${phaseNames[task.phase]} now.`,
      };
    }
    switch (task.phase) {
      case "spec":
        return { ok: true, result: { session, phase: "spec", spec: task.spec, note: task.note } };
      case "in_progress":
        return { ok: true, result: { session, phase: "in_progress", worktree: task.worktree } };
      default:
        return { ok: true, result: { session, phase: task.phase } };
    }
  }

  private send(taskId: TaskId, input: Input): Answer {
    const decision = this.loop.send(taskId, input, this.now());
    return decision.ok
      ? { ok: true, result: {} }
      : { ok: false, message: decision.rejection.reason };
  }

  find(taskId: TaskId): Task | null {
    return this.loop.tasks().find((task) => task.id === taskId) ?? null;
  }

  // One more than the highest number so far. The queue keeps two adds from
  // ever getting the same one.
  private nextTaskId(): TaskId {
    const highest = Math.max(0, ...this.loop.tasks().map((task) => task.id));
    return TaskId.parse(highest + 1);
  }

  private oneAtATime<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

// What `status` shows of a task.
function view(task: Task) {
  return {
    task: task.id,
    title: task.title,
    phase: task.phase,
    step: "step" in task ? task.step.kind : null,
    blocked: task.blocked === null ? null : describeBlock(task.blocked),
    question: task.question?.text ?? null,
    waitingOnYou: waitingOnYou(task),
  };
}

function describeBlock(reason: BlockReason): string {
  switch (reason.kind) {
    case "out_of_attempts":
      return `Out of attempts. The last failure, in ${reason.failure.step}: ${reason.failure.summary}`;
    case "safety_cap":
      return `The safety cap was reached: ${reason.usage.tokens} tokens in ${Math.round(reason.usage.ms / 60_000)} minutes.`;
    case "agent_gave_up":
      return `The agent gave up: ${reason.message}`;
    case "worktree_failed":
      return `The worktree couldn't be made: ${reason.message}`;
    case "session_failed":
      return `The agent couldn't start: ${reason.message}`;
  }
}

// Carries out the core's commands. Worktrees go to the version control
// plugin, and the local gate to the checks runner. Merging isn't built in
// yet, so the commands that need it are answered with a failure at once. An attended session can't
// be stopped or messaged by Skelcrew, so those commands do nothing: its
// next report is refused instead.
type Deliver = (taskId: TaskId, input: Input, finished: () => void) => void;

class DaemonTools implements Tools {
  private deliver: Deliver | null = null;
  private titleOf: (taskId: TaskId) => string = (taskId) => `#${taskId}`;
  private early: [TaskId, Input, () => void][] = [];
  // Commands that go to a plugin, held until `connect`: at start-up the
  // loop sends out unfinished commands before titles can be looked up.
  private held: [CoreCommand, () => void][] = [];

  constructor(
    private readonly versionControl: VersionControl | null,
    private readonly runChecks: RunChecks | null,
  ) {}

  connect(deliver: Deliver, titleOf: (taskId: TaskId) => string): void {
    this.deliver = deliver;
    this.titleOf = titleOf;
    for (const [taskId, input, finished] of this.early) deliver(taskId, input, finished);
    this.early = [];
    for (const [command, finished] of this.held.splice(0)) this.carryOut(command, finished);
  }

  // A command with no reply has finished as soon as it is done here. One
  // with a reply finishes when the daemon has handled that reply.
  carryOut(command: CoreCommand, finished: () => void): void {
    if (command.type === "create_worktree" && this.versionControl !== null) {
      if (this.deliver === null) this.held.push([command, finished]);
      else void this.createWorktree(this.versionControl, command, finished);
      return;
    }
    if (command.type === "remove_worktree" && this.versionControl !== null) {
      void this.removeWorktree(this.versionControl, command.worktree, finished);
      return;
    }
    if (
      command.type === "run_gate" &&
      command.gate === "local" &&
      this.versionControl !== null &&
      this.runChecks !== null
    ) {
      void this.runLocalGate(this.versionControl, this.runChecks, command, finished);
      return;
    }
    const reply = this.replyTo(command);
    if (reply === null) {
      finished();
      return;
    }
    const [taskId, input] = reply;
    this.send(taskId, input, finished);
  }

  // The checks run in a fresh copy of the commit the agent reported, never
  // in its worktree. So an agent editing meanwhile, or a check that writes
  // files, can't change what is checked.
  private async runLocalGate(
    versionControl: VersionControl,
    runChecks: RunChecks,
    command: Extract<CoreCommand, { type: "run_gate" }>,
    finished: () => void,
  ): Promise<void> {
    const { taskId, request, gate, head } = command;
    let summary: string | null;
    try {
      const checked = await versionControl.checkCommit({ taskId, head }, runChecks);
      summary = checked.ok ? null : checked.message;
    } catch (error) {
      summary = `The checks couldn't run: ${error instanceof Error ? error.message : String(error)}`;
    }
    const input: Input =
      summary === null
        ? {
            by: "plugin",
            type: "gate_result",
            request,
            gate,
            ok: true,
            summary: "The checks passed.",
          }
        : { by: "plugin", type: "gate_result", request, gate, ok: false, summary };
    this.send(taskId, input, finished);
  }

  private send(taskId: TaskId, input: Input, finished: () => void): void {
    if (this.deliver === null) this.early.push([taskId, input, finished]);
    else this.deliver(taskId, input, finished);
  }

  // Nothing waits on a removal. A worktree that can't be removed stays, and
  // `git worktree list` shows it. The command is finished either way, so it
  // isn't tried again at every start.
  private async removeWorktree(
    versionControl: VersionControl,
    worktree: Worktree,
    finished: () => void,
  ): Promise<void> {
    try {
      await versionControl.removeWorktree(worktree);
    } catch {
      // As above: it stays where it is.
    }
    finished();
  }

  // The plugin never throws, but a failure here must still reach the core,
  // which would otherwise wait for the worktree for ever.
  private async createWorktree(
    versionControl: VersionControl,
    command: Extract<CoreCommand, { type: "create_worktree" }>,
    finished: () => void,
  ): Promise<void> {
    const { taskId, request, build } = command;
    let input: Input;
    try {
      const made = await versionControl.createWorktree({
        taskId,
        title: this.titleOf(taskId),
        build,
      });
      input = made.ok
        ? { by: "plugin", type: "worktree_created", request, worktree: made.value }
        : { by: "plugin", type: "worktree_failed", request, message: made.message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input = { by: "plugin", type: "worktree_failed", request, message };
    }
    this.send(taskId, input, finished);
  }

  private replyTo(command: CoreCommand): [TaskId, Input] | null {
    const notYet = "isn't built into the daemon yet";
    switch (command.type) {
      case "create_worktree":
        return [
          command.taskId,
          {
            by: "plugin",
            type: "worktree_failed",
            request: command.request,
            message: `Making worktrees ${notYet}.`,
          },
        ];
      case "start_spec_session":
      case "start_develop_session":
        return [
          command.taskId,
          {
            by: "plugin",
            type: "session_failed",
            request: command.request,
            message: "Skelcrew doesn't start agents itself yet. Claim the task instead.",
          },
        ];
      case "run_gate":
        return [
          command.taskId,
          {
            by: "plugin",
            type: "gate_result",
            request: command.request,
            gate: command.gate,
            ok: false,
            summary: `Running the ${command.gate} gate ${notYet}.`,
          },
        ];
      case "merge":
        return [
          command.taskId,
          {
            by: "plugin",
            type: "merge_failed",
            request: command.request,
            summary: `Merging ${notYet}.`,
          },
        ];
      case "revert":
        return [
          command.taskId,
          {
            by: "plugin",
            type: "revert_failed",
            request: command.request,
            summary: `Reverting ${notYet}.`,
          },
        ];
      case "stop_session":
      case "send_to_session":
      case "remove_worktree":
        return null;
    }
  }
}
