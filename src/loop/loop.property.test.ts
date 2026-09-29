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
import { runningSession } from "../core/task";
import type { Command, Config, Input, Spec, Task, TaskEvent } from "../core/types";
import { EventStore } from "../store/store";
import { config as base, head } from "../test/fixtures";
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
  appendTask(events: TaskEvent[], starts: Starts, commands: Command[]) {
    return this.full
      ? { ok: false as const, reason: "disk full" }
      : this.store.appendTask(events, starts, commands);
  }
  carriedOut(id: number) {
    return this.store.carriedOut(id);
  }
  loadCommands() {
    return this.store.loadCommands();
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
// With `dying` set, the daemon dies at its next command, before it goes out.
// How the tools finish a command:
// - "now": the work is done and finished at once.
// - "held": the work only happens at a later "finish" step, like a worktree
//   still being made. A restart loses it.
// - "late": the work happens at once, so its reply can arrive and be saved,
//   but the tool only says it finished at a later step. A restart then
//   sends the command out again, though its work was done.
type Pace = "now" | "held" | "late";

class Recorded implements Tools {
  commands: Command[] = [];
  dying = false;
  pace: Pace = "now";
  unfinished: { command: Command; finished: () => void; done: boolean }[] = [];
  carryOut(command: Command, finished: () => void): void {
    if (this.dying) throw new DaemonDied();
    if (this.pace === "now") {
      this.commands.push(command);
      finished();
      return;
    }
    const done = this.pace === "late";
    if (done) this.commands.push(command);
    this.unfinished.push({ command, finished, done });
  }
  finish(): void {
    for (const { command, finished, done } of this.unfinished) {
      if (!done) this.commands.push(command);
      finished();
    }
    this.unfinished = [];
  }
  // Commands whose work hasn't happened yet.
  notDone(): Command[] {
    return this.unfinished.filter((u) => !u.done).map((u) => u.command);
  }
}
class DaemonDied extends Error {}

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
function messages(
  commands: Command[],
  started: Map<TaskId, SessionId[]>,
  nextClaim: SessionId,
): [TaskId, Input][] {
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
            branch: { head, commits: 1, changedFiles: ["a.ts"] },
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
      // Your harness session, with a session the daemon has never handed out.
      [taskId, { by: "human", type: "claim", session: nextClaim }],
    );
  }
  return out;
}

// The agents actually running outside the loop: started and not stopped or
// crashed, including ones whose start reply is waiting to be handled again.
// What the slot limit is about.
function runningAgents(commands: Command[], delivered: Input[]): Set<SessionId> {
  const up = new Set<SessionId>();
  const gone = new Set<SessionId>();
  for (const input of delivered) {
    if (input.type === "session_started") up.add(input.session);
    // A crashed agent stays down, even if its start reply arrives after.
    if (input.type === "session_crashed") gone.add(input.session);
  }
  for (const command of commands) if (command.type === "stop_session") gone.add(command.session);
  return new Set([...up].filter((session) => !gone.has(session)));
}

// Starts the tools were handed and that no reply has answered yet.
function startsOut(commands: Command[], delivered: [TaskId, Input][]): Set<string> {
  const out = new Set<string>();
  for (const command of commands) {
    if (
      command.type === "start_spec_session" ||
      command.type === "start_develop_session" ||
      command.type === "create_worktree"
    ) {
      out.add(`${command.taskId}:${command.request}`);
    }
  }
  for (const [taskId, input] of delivered) {
    switch (input.type) {
      case "session_started":
      case "session_failed":
      case "session_crashed":
      case "worktree_created":
      case "worktree_failed":
        out.delete(`${taskId}:${input.request}`);
        break;
      default:
        break;
    }
  }
  return out;
}

type Step =
  | { kind: "message"; guided: boolean; n: number }
  | { kind: "start" }
  | { kind: "restart" }
  | { kind: "die" }
  | { kind: "pace"; pace: Pace }
  | { kind: "finish" }
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
  { weight: 1, arbitrary: fc.constant({ kind: "die" as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("pace" as const),
      pace: fc.constantFrom<Pace>("now", "held", "late"),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "finish" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("disk" as const), full: fc.boolean() }) },
);

describe("the loop", () => {
  test("keeps the slot limit and its saved log true through failed saves, crashes and restarts", () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 200, size: "max" }), (steps) => {
        const log = new Flaky(EventStore.open(":memory:"));
        const tools = new Recorded();
        let loop = new Loop(config, tools, log);
        const delivered: [TaskId, Input][] = [];
        const started = new Map<TaskId, SessionId[]>();
        // Sessions you claimed tasks with, once they held a task.
        const claimed = new Set<SessionId>();
        const outcomes: Outcomes = new Map();
        // Inputs whose save failed: the daemon keeps them and delivers them
        // again once saving works.
        let retry: [TaskId, Input][] = [];
        let at = 0;

        // The daemon starts again after it died. Its commands that never
        // went out must go out now.
        const restart = () => {
          // Work still going on in the daemon dies with it.
          tools.unfinished = [];
          tools.dying = false;
          log.full = false;
          const reopened = Loop.open(config, tools, log);
          if (!reopened.ok) throw new Error(reopened.reason);
          loop = reopened.loop;
        };
        // Runs one daemon step. Returns its result, or `died` if the daemon
        // died during it.
        const died = Symbol("died");
        const attempt = <T>(run: () => T): T | typeof died => {
          try {
            return run();
          } catch (error) {
            if (!(error instanceof DaemonDied)) throw error;
            return died;
          }
        };

        const deliver = (id: TaskId, input: Input) => {
          const outcome = outcomeOf(id, input);
          if (outcome !== null && !outcomes.has(outcome[0])) outcomes.set(outcome[0], outcome[1]);
          const decision = attempt(() => loop.send(id, input, at));
          if (decision === died) {
            // The daemon only dies carrying out commands, after the input
            // was saved. So the input counts as delivered.
            delivered.push([id, input]);
            restart();
            const task = loop.tasks().find((t) => t.id === id);
            if (
              input.type === "session_started" &&
              task &&
              runningSession(task) === input.session
            ) {
              started.set(id, [...(started.get(id) ?? []), input.session]);
            }
            redeliver();
            return;
          }
          if (
            !decision.ok &&
            decision.rejection.reason.startsWith("The events couldn't be saved")
          ) {
            retry.push([id, input]);
            return;
          }
          delivered.push([id, input]);
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
              if (attempt(() => loop.startWaiting(at)) === died) {
                restart();
                redeliver();
              }
              break;

            case "die":
              tools.dying = true;
              break;

            case "pace":
              tools.pace = s.pace;
              break;

            case "finish":
              tools.finish();
              break;

            case "restart": {
              // A restart only happens with the disk working, like a real
              // daemon starting up. It must keep the count of starts in flight.
              const before = loop.startsInFlight;
              restart();
              expect(loop.startsInFlight).toBe(before);
              redeliver();
              break;
            }

            case "message": {
              const nextClaim = SessionId.parse(`you-${claimed.size + 1}`);
              const all = messages(tools.commands, started, nextClaim).filter(([id, input]) =>
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
          const inWorld = [...delivered, ...retry].map(([, input]) => input);
          // Your claimed sessions are agents too, and report like one. One
          // counts toward the limit while its task holds it. Once let go, it
          // stops at its next report.
          for (const task of loop.tasks()) {
            const session = runningSession(task);
            if (session === null || !session.startsWith("you-") || claimed.has(session)) continue;
            claimed.add(session);
            started.set(task.id, [...(started.get(task.id) ?? []), session]);
          }
          const attended = loop.tasks().filter((t) => runningSession(t)?.startsWith("you-")).length;
          const up = runningAgents(tools.commands, inWorld);
          // An agent being stopped keeps its slot until its stop has
          // finished, so every agent that is up counts.
          expect(up.size + attended).toBeLessThanOrEqual(config.maxRunning);
          const stopping = new Set(
            tools
              .notDone()
              .flatMap((command) => (command.type === "stop_session" ? [command.session] : [])),
          );

          // 13, in the world: every agent that is up is held by its task,
          // its start reply is waiting to be handled, or a stop for it is
          // still being carried out. Otherwise nothing will ever stop it.
          const held = new Set(loop.tasks().map(runningSession));
          const waiting = new Set(
            retry.flatMap(([, input]) => (input.type === "session_started" ? [input.session] : [])),
          );
          for (const session of up) {
            const tracked = held.has(session) || waiting.has(session) || stopping.has(session);
            expect({ session, tracked }).toEqual({ session, tracked: true });
          }

          // Every start the loop counts as out was handed to the tools, so a
          // reply can come back and free its slot.
          // Work still going on in the daemon counts too, until a restart
          // loses it.
          const handedOut = [...tools.commands, ...tools.notDone()];
          expect(loop.startsInFlight).toBeLessThanOrEqual(startsOut(handedOut, delivered).size);

          // Every agent the loop counts as being stopped has a stop the tools
          // really haven't finished, so a slot is never held for nothing.
          const stopsOut = new Set(
            tools.unfinished.flatMap(({ command }) =>
              command.type === "stop_session" ? [command.session] : [],
            ),
          );
          expect(loop.stopsInFlight).toBeLessThanOrEqual(stopsOut.size);

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
