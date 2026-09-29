// The daemon: where the CLI's requests become core inputs. It holds the
// loop and the event store, turns each protocol command into inputs for the
// core, and carries out the core's commands through its tools. Replies from
// the tools come back as new inputs.
//
// Everything runs one at a time: requests and the tools' replies share one
// queue. Neither the loop nor the git plugin is built for two things at
// once, and it keeps task numbers from ever repeating.
//
// This first version has no git and no checks. A command that needs them
// is answered at once with a failure, so the core never waits on something
// that won't happen.

import { randomUUID } from "node:crypto";
import { ProjectId, SessionId, TaskId } from "../core/ids";
import { waitingOnYou } from "../core/task";
import type { BlockReason, Config, Command as CoreCommand, Input, Task } from "../core/types";
import { Loop, type ReadableLog, type Tools } from "../loop/loop";
import type { Command } from "../protocol/protocol";

export type Answer = { ok: true; result: unknown } | { ok: false; message: string };

export type DaemonOptions = {
  config: Config;
  log: ReadableLog;
  // The core never makes up IDs, so the daemon names each claimed session.
  newSession?: () => string;
  now?: () => number;
  // A reply whose save failed is sent again after `retryMs`, then twice as
  // long each time, up to `retries` times.
  retryMs?: number;
  retries?: number;
};

export class Daemon {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly newSession: () => string;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly retries: number;

  private constructor(
    private readonly loop: Loop,
    options: DaemonOptions,
  ) {
    this.newSession = options.newSession ?? (() => `session-${randomUUID()}`);
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? 1_000;
    this.retries = options.retries ?? 5;
  }

  // Opens the loop from the saved log. The tools must exist before the
  // loop does, since opening carries out commands saved before the last
  // stop. Their replies wait in the queue until the daemon is ready.
  static open(
    options: DaemonOptions,
  ): { ok: true; value: Daemon } | { ok: false; message: string } {
    const tools = new DaemonTools();
    const opened = Loop.open(options.config, tools, options.log);
    if (!opened.ok)
      return { ok: false, message: `The saved log couldn't be read. ${opened.reason}` };
    const daemon = new Daemon(opened.loop, options);
    tools.connect((taskId, input) => daemon.reply(taskId, input));
    return { ok: true, value: daemon };
  }

  // One request from the CLI, answered once everything before it is done.
  // It always gets an answer: an error, such as a locked database, becomes
  // a refusal that says what happened.
  handle(command: Command): Promise<Answer> {
    return this.oneAtATime(() => {
      try {
        return this.answer(command);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, message: `Skelcrew couldn't handle that: ${message}` };
      }
    });
  }

  private answer(command: Command): Answer {
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
        const task = this.loop.task(command.task);
        if (task.phase === "spec") {
          return { ok: true, result: { session, phase: "spec", spec: task.spec, note: task.note } };
        }
        return { ok: true, result: { session, phase: task.phase } };
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

      case "done":
      case "log":
        return { ok: false, message: `\`${command.type}\` isn't built into the daemon yet.` };
    }
  }

  // A tool's reply, as a new input in the same queue as requests. If it
  // couldn't be saved, whether the save failed or threw, it is sent again
  // later, since the core may be waiting on it. After the last try it is
  // given up. Any other refusal means the reply came too late to matter.
  private reply(taskId: TaskId, input: Input, attempt = 0): void {
    void this.oneAtATime(() => {
      let saved: boolean;
      try {
        const decision = this.loop.send(taskId, input, this.now());
        saved =
          decision.ok || !decision.rejection.reason.startsWith("The events couldn't be saved");
      } catch {
        saved = false;
      }
      if (!saved && attempt < this.retries) {
        setTimeout(() => this.reply(taskId, input, attempt + 1), this.retryMs * 2 ** attempt);
      }
    });
  }

  private send(taskId: TaskId, input: Input): Answer {
    const decision = this.loop.send(taskId, input, this.now());
    return decision.ok
      ? { ok: true, result: {} }
      : { ok: false, message: decision.rejection.reason };
  }

  private find(taskId: TaskId): Task | null {
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

// Carries out the core's commands. This first version has no git and no
// checks, so the commands that need them are answered with a failure at
// once. An attended session can't be stopped or messaged by Skelcrew, so
// those commands do nothing: its next report is refused instead.
class DaemonTools implements Tools {
  private deliver: ((taskId: TaskId, input: Input) => void) | null = null;
  private early: [TaskId, Input][] = [];

  connect(deliver: (taskId: TaskId, input: Input) => void): void {
    this.deliver = deliver;
    for (const [taskId, input] of this.early) deliver(taskId, input);
    this.early = [];
  }

  carryOut(command: CoreCommand): void {
    const reply = this.replyTo(command);
    if (reply === null) return;
    const [taskId, input] = reply;
    if (this.deliver === null) this.early.push([taskId, input]);
    else this.deliver(taskId, input);
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
