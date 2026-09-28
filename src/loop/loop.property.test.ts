// Property test for the loop: random input sequences through the real loop,
// with saves that sometimes fail and restarts at random moments. After every
// step it checks the slot limit, that the loop's tasks match a fresh replay
// of the saved log, and that a restart keeps the count of starts in flight.
//
// The core's own rules are checked in src/core/invariants.test.ts. This test
// covers what only the loop does: saving, counting starts, and restarting.

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { decideTask } from "../core/decide";
import { CommitSha, SessionId, TaskId } from "../core/ids";
import type { Command, Config, Input, Spec, Task, TaskEvent } from "../core/types";
import { EventStore } from "../store/store";
import { config as base } from "../test/fixtures";
import { type EventLog, Loop, type ReadableLog, type Starts, type Tools } from "./loop";

const config: Config = {
  ...base,
  gates: ["local"],
  maxAttempts: 2,
  specApproval: "never",
  criticalPaths: [],
};
const spec: Spec = { scope: "Export CSV.", acceptance: ["It downloads."], openQuestions: [] };
const commit = CommitSha.parse("c".repeat(40));
const ids = [1, 2, 3, 4].map((n) => TaskId.parse(n));

// The event store, with saves that fail whenever `full` is set.
class Flaky implements ReadableLog {
  full = false;
  constructor(readonly store: EventStore) {}
  appendTask(events: TaskEvent[], starts: Starts) {
    return this.full
      ? { ok: false as const, reason: "disk full" }
      : this.store.appendTask(events, starts);
  }
  appendProject(events: Parameters<EventLog["appendProject"]>[0]) {
    return this.store.appendProject(events);
  }
  loadTasks() {
    return this.store.loadTasks();
  }
  loadProjects() {
    return this.store.loadProjects();
  }
  loadStarts() {
    return this.store.loadStarts();
  }
}

// Tools that remember every command, so replies can be built from them.
class Recorded implements Tools {
  commands: Command[] = [];
  carryOut(command: Command): void {
    this.commands.push(command);
  }
}

// A request's outcome, fixed by its first reply: a real tool answers each
// request one way, possibly more than once, never "failed" and then
// "started".
type Outcomes = Map<string, string>;
const outcomeOf = (taskId: TaskId, input: Input): [string, string] | null => {
  switch (input.type) {
    case "session_started":
    case "session_failed":
      return [`${taskId}:${input.request}`, input.type];
    case "worktree_created":
    case "worktree_failed":
      return [`${taskId}:${input.request}`, input.type];
    case "merged":
    case "merge_failed":
      return [`${taskId}:${input.request}`, input.type];
    default:
      return null;
  }
};
// A crash only follows an agent that started, or overtakes its start reply.
const allowed = (outcomes: Outcomes, taskId: TaskId, input: Input): boolean => {
  if (input.type === "session_crashed") {
    return outcomes.get(`${taskId}:${input.request}`) !== "session_failed";
  }
  const outcome = outcomeOf(taskId, input);
  if (outcome === null) return true;
  const fixed = outcomes.get(outcome[0]);
  return fixed === undefined || fixed === outcome[1];
};

// Replies to every command handed out so far, old ones included, and reports
// from every agent started so far.
function messages(commands: Command[], started: Map<TaskId, SessionId[]>): [TaskId, Input][] {
  const out: [TaskId, Input][] = [];
  for (const command of commands) {
    switch (command.type) {
      case "start_spec_session":
      case "start_develop_session": {
        const session = SessionId.parse(`s${command.taskId}-${command.request}`);
        const { taskId, request } = command;
        out.push(
          [taskId, { by: "plugin", type: "session_started", request, session }],
          [taskId, { by: "plugin", type: "session_failed", request, message: "No." }],
          [taskId, { by: "plugin", type: "session_crashed", request, session, message: "Boom." }],
        );
        break;
      }
      case "create_worktree": {
        const { taskId, request } = command;
        const worktree = { path: `/wt/${taskId}-${request}`, branch: `task/${taskId}-${request}` };
        out.push(
          [taskId, { by: "plugin", type: "worktree_created", request, worktree }],
          [taskId, { by: "plugin", type: "worktree_failed", request, message: "No." }],
        );
        break;
      }
      case "run_gate":
        out.push([
          command.taskId,
          {
            by: "plugin",
            type: "gate_result",
            request: command.request,
            gate: command.gate,
            ok: true,
            summary: ".",
          },
        ]);
        break;
      case "merge":
        out.push(
          [command.taskId, { by: "plugin", type: "merged", request: command.request, commit }],
          [
            command.taskId,
            { by: "plugin", type: "merge_failed", request: command.request, summary: "x" },
          ],
        );
        break;
      default:
        break;
    }
  }
  for (const [taskId, sessions] of started) {
    for (const session of sessions) {
      out.push(
        [taskId, { by: "agent", type: "submit_spec", session, spec }],
        [
          taskId,
          {
            by: "agent",
            type: "report_done",
            session,
            branch: { commits: 1, changedFiles: ["a.ts"] },
          },
        ],
        [taskId, { by: "agent", type: "give_up", session, message: "Stuck." }],
      );
    }
  }
  for (const taskId of ids) {
    out.push(
      [taskId, { by: "human", type: "retry" }],
      [taskId, { by: "human", type: "drop" }],
      [taskId, { by: "human", type: "back_to_spec", note: "Again." }],
    );
  }
  return out;
}

// The agents actually running outside the loop: started and not stopped or
// crashed, including ones whose start reply is waiting to be handled again.
// What the slot limit is about.
function runningAgents(commands: Command[], delivered: Input[]): number {
  const up = new Set<string>();
  const gone = new Set<string>();
  for (const input of delivered) {
    if (input.type === "session_started") up.add(input.session);
    // A crashed agent stays down, even if its start reply arrives after.
    if (input.type === "session_crashed") gone.add(input.session);
  }
  for (const command of commands) if (command.type === "stop_session") gone.add(command.session);
  return [...up].filter((session) => !gone.has(session)).length;
}

type Step =
  | { kind: "message"; guided: boolean; n: number }
  | { kind: "start" }
  | { kind: "restart" }
  | { kind: "disk"; full: boolean };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.record({
      kind: fc.constant("message" as const),
      guided: fc.boolean(),
      n: fc.nat(),
    }),
  },
  { weight: 4, arbitrary: fc.constant({ kind: "start" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "restart" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("disk" as const), full: fc.boolean() }) },
);

describe("the loop", () => {
  test("keeps the slot limit and its saved log true through failed saves and restarts", () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 200, size: "max" }), (steps) => {
        const log = new Flaky(EventStore.open(":memory:"));
        const tools = new Recorded();
        let loop = new Loop(config, tools, log);
        const delivered: Input[] = [];
        const started = new Map<TaskId, SessionId[]>();
        const outcomes: Outcomes = new Map();
        // Inputs whose save failed: the daemon keeps them and delivers them
        // again once saving works.
        let retry: [TaskId, Input][] = [];
        let at = 0;

        const deliver = (id: TaskId, input: Input) => {
          const outcome = outcomeOf(id, input);
          if (outcome !== null && !outcomes.has(outcome[0])) outcomes.set(outcome[0], outcome[1]);
          const decision = loop.send(id, input, at);
          if (
            !decision.ok &&
            decision.rejection.reason.startsWith("The events couldn't be saved")
          ) {
            retry.push([id, input]);
            return;
          }
          delivered.push(input);
          if (decision.ok && input.type === "session_started" && decision.events.length > 0) {
            started.set(id, [...(started.get(id) ?? []), input.session]);
          }
        };
        const redeliver = () => {
          const again = retry;
          retry = [];
          for (const [id, input] of again) deliver(id, input);
        };

        for (const id of ids) {
          loop.send(
            id,
            { by: "human", type: "add", title: "T", project: null, requestSpec: true },
            at,
          );
        }

        for (const s of steps) {
          at += 1;
          switch (s.kind) {
            case "disk":
              log.full = s.full;
              if (!s.full) redeliver();
              break;

            case "start":
              loop.startWaiting(at);
              break;

            case "restart": {
              // A restart only happens with the disk working, like a real
              // daemon starting up. It must keep the count of starts in flight.
              log.full = false;
              const before = loop.startsInFlight;
              const reopened = Loop.open(config, tools, log);
              if (!reopened.ok) throw new Error(reopened.reason);
              loop = reopened.loop;
              expect(loop.startsInFlight).toBe(before);
              redeliver();
              break;
            }

            case "message": {
              const all = messages(tools.commands, started).filter(([id, input]) =>
                allowed(outcomes, id, input),
              );
              const fits = all.filter(([id, input]) => {
                const task: Task | null = loop.tasks().find((t) => t.id === id) ?? null;
                return decideTask(task, { taskId: id, at, input }, config, loop.projects()).ok;
              });
              const from = s.guided && fits.length > 0 ? fits : all;
              const picked = from[s.n % from.length];
              if (picked === undefined) break;
              deliver(picked[0], picked[1]);
              break;
            }
          }

          // 8. Never more agents than max_running: the ones running outside
          // the loop never exceed the limit the loop enforces.
          const inWorld = [...delivered, ...retry.map(([, input]) => input)];
          expect(runningAgents(tools.commands, inWorld)).toBeLessThanOrEqual(config.maxRunning);

          // A failed save changes nothing: the loop's tasks always match a
          // fresh replay of the saved log.
          const saved = log.loadTasks();
          if (!saved.ok) throw new Error(saved.reason);
          expect(new Map(loop.tasks().map((t) => [t.id, t]))).toEqual(saved.tasks);
        }
      }),
      { numRuns: 100 },
    );
  });
});
