import { describe, expect, test } from "bun:test";
import { ProjectId, SessionId, TaskId } from "../core/ids";
import type { Command, Config, Input } from "../core/types";
import { EventStore } from "../store/store";
import { config as base } from "../test/fixtures";
import { type EventLog, Loop, type Tools } from "./loop";

const config: Config = {
  ...base,
  gates: ["local"],
  maxRunning: 1,
  specApproval: "never",
  criticalPaths: [],
};

// Tools that only remember what they were asked to do, and finish it at once.
class Recorded implements Tools {
  commands: Command[] = [];
  carryOut(command: Command, finished: () => void): void {
    this.commands.push(command);
    finished();
  }
}

// Tools that take a command but never finish it, like a daemon that dies
// while a worktree is still being made.
class Unfinished implements Tools {
  carryOut(): void {}
}

// Tools that finish everything at once, except stops, which finish only
// when `finishStops` is called.
class SlowStops implements Tools {
  commands: Command[] = [];
  private stops: (() => void)[] = [];
  carryOut(command: Command, finished: () => void): void {
    this.commands.push(command);
    if (command.type === "stop_session") this.stops.push(finished);
    else finished();
  }
  finishStops(): void {
    for (const finished of this.stops) finished();
    this.stops = [];
  }
}

// Tools in a daemon that dies before it carries out anything.
class Dying implements Tools {
  carryOut(): void {
    throw new Error("The daemon died.");
  }
}

const one = TaskId.parse(1);
const two = TaskId.parse(2);
const add = (requestSpec = true, project: ProjectId | null = null): Input => ({
  by: "human",
  type: "add",
  title: "CSV export",
  project,
  requestSpec,
});
const claim = (session: string): Input => ({
  by: "human",
  type: "claim",
  session: SessionId.parse(session),
});
const started = (request: number, session: string): Input => ({
  by: "plugin",
  type: "session_started",
  request,
  session: SessionId.parse(session),
});

describe("the loop", () => {
  test("saves an accepted input's events, applies them, and hands its commands to the tools", () => {
    const tools = new Recorded();
    const store = EventStore.open(":memory:");
    const loop = new Loop(config, tools, store);

    loop.send(one, add());
    expect(loop.startWaiting()).toEqual([one]);

    expect(loop.task(one)).toMatchObject({ phase: "spec", step: { kind: "starting", request: 1 } });
    expect(tools.commands).toEqual([
      { type: "start_spec_session", taskId: one, request: 1, note: null },
    ]);
    const saved = store.loadTasks();
    expect(saved.ok && saved.tasks.get(one)).toEqual(loop.task(one));
  });

  test("saves nothing and hands out nothing for a rejected input", () => {
    const tools = new Recorded();
    const store = EventStore.open(":memory:");
    const loop = new Loop(config, tools, store);
    loop.send(one, add(false));

    const decision = loop.send(one, { by: "human", type: "approve_spec" });
    expect(decision.ok).toBe(false);
    expect(tools.commands).toEqual([]);
    const saved = store.loadTasks();
    expect(saved.ok && saved.tasks.get(one)?.phase).toBe("idea");
  });

  test("applies nothing and hands out nothing when the events can't be saved", () => {
    const tools = new Recorded();
    const broken: EventLog = {
      appendTask: () => ({ ok: false, reason: "disk full" }),
      appendProject: () => ({ ok: false, reason: "disk full" }),
      carriedOut: () => ({ ok: false, reason: "disk full" }),
    };
    const loop = new Loop(config, tools, broken);

    expect(loop.send(one, add())).toEqual({
      ok: false,
      rejection: { input: "add", reason: "The events couldn't be saved: disk full" },
    });
    expect(loop.tasks()).toEqual([]);
    expect(tools.commands).toEqual([]);
  });

  test("counts a start in flight until its own reply arrives", () => {
    const loop = new Loop(config, new Recorded(), null);
    loop.send(one, add());
    loop.startWaiting();
    expect(loop.startsInFlight).toBe(1);

    // A reply to some other request doesn't answer this start.
    loop.send(one, started(7, "stray"));
    expect(loop.startsInFlight).toBe(1);

    loop.send(one, started(1, "s1"));
    expect(loop.startsInFlight).toBe(0);
  });

  test("keeps the slot of a dropped task's start until its agent reports in", () => {
    const tools = new Recorded();
    const loop = new Loop(config, tools, null);
    loop.send(one, add());
    loop.send(two, add());
    expect(loop.startWaiting()).toEqual([one]);

    loop.send(one, { by: "human", type: "drop" });
    expect(loop.startWaiting()).toEqual([]);

    // #1's agent comes up late: it's stopped, and its slot is free again.
    loop.send(one, started(1, "late"));
    expect(tools.commands).toContainEqual({
      type: "stop_session",
      session: SessionId.parse("late"),
    });
    expect(loop.startWaiting()).toEqual([two]);
  });

  test("keeps counting a start whose reply couldn't be saved", () => {
    let full = false;
    const store = EventStore.open(":memory:");
    const flaky: EventLog = {
      appendTask: (events, starts, commands) =>
        full ? { ok: false, reason: "disk full" } : store.appendTask(events, starts, commands),
      appendProject: (events) => store.appendProject(events),
      carriedOut: (id) => store.carriedOut(id),
    };
    const loop = new Loop(config, new Recorded(), flaky);
    loop.send(one, add());
    loop.send(two, add());
    loop.startWaiting();

    full = true;
    expect(loop.send(one, started(1, "s1")).ok).toBe(false);
    full = false;

    // #1's agent is up, but the task never recorded it. Its slot stays taken
    // until the reply is handled, so #2 must wait.
    expect(loop.startsInFlight).toBe(1);
    expect(loop.startWaiting()).toEqual([]);
  });

  test("reports a failed save for a refused reply, so it can be sent again", () => {
    let full = false;
    const store = EventStore.open(":memory:");
    const flaky: EventLog = {
      appendTask: (events, starts, commands) =>
        full ? { ok: false, reason: "disk full" } : store.appendTask(events, starts, commands),
      appendProject: (events) => store.appendProject(events),
      carriedOut: (id) => store.carriedOut(id),
    };
    const loop = new Loop(config, new Recorded(), flaky);
    loop.send(one, add());
    loop.send(two, add());
    loop.startWaiting();
    loop.send(one, { by: "human", type: "drop" });

    // #1's agent didn't start. The reply is refused, since #1 was dropped,
    // but it still answers the start. Saving that fails.
    const failed: Input = { by: "plugin", type: "session_failed", request: 1, message: "No." };
    full = true;
    expect(loop.send(one, failed)).toEqual({
      ok: false,
      rejection: { input: "session_failed", reason: "The events couldn't be saved: disk full" },
    });
    full = false;

    // Sent again once saving works, the reply frees #1's slot for #2.
    loop.send(one, failed);
    expect(loop.startWaiting()).toEqual([two]);
  });

  test("picks up where it left off from the saved events", () => {
    const store = EventStore.open(":memory:");
    const first = new Loop(config, new Recorded(), store);
    first.send(one, add(false));

    const reopened = Loop.open(config, new Recorded(), store);
    if (!reopened.ok) throw new Error(reopened.reason);
    const loop = reopened.loop;
    expect(loop.task(one)).toMatchObject({ phase: "idea" });
    loop.send(one, { by: "human", type: "request_spec" });
    const saved = store.loadTasks();
    expect(saved.ok && saved.tasks.get(one)?.phase).toBe("spec");
  });

  test("frees the slot when an agent crashes before its start reply", () => {
    const loop = new Loop(config, new Recorded(), null);
    loop.send(one, add());
    loop.send(two, add());
    expect(loop.startWaiting()).toEqual([one]);

    loop.send(one, {
      by: "plugin",
      type: "session_crashed",
      request: 1,
      session: SessionId.parse("gone"),
      message: "herdr crashed",
    });
    expect(loop.startsInFlight).toBe(0);
    expect(loop.startWaiting()).toEqual([two]);
  });

  test("still counts a start in flight after a restart", () => {
    const store = EventStore.open(":memory:");
    const first = new Loop(config, new Recorded(), store);
    first.send(one, add());
    first.send(two, add());
    expect(first.startWaiting()).toEqual([one]);

    // The loop restarts before #1's agent reports in.
    const reopened = Loop.open(config, new Recorded(), store);
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(reopened.loop.startsInFlight).toBe(1);
    expect(reopened.loop.startWaiting()).toEqual([]);

    // Its reply still clears the start after the restart.
    reopened.loop.send(one, started(1, "s1"));
    expect(reopened.loop.startsInFlight).toBe(0);
  });

  test("carries out a saved start after a crash, instead of holding its slot forever", () => {
    const store = EventStore.open(":memory:");
    const first = new Loop(config, new Dying(), store);
    first.send(one, add());
    expect(() => first.startWaiting()).toThrow("The daemon died.");

    // The start was saved, but never sent. After the restart it goes out.
    const tools = new Recorded();
    const reopened = Loop.open(config, tools, store);
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(tools.commands).toEqual([
      { type: "start_spec_session", taskId: one, request: 1, note: null },
    ]);
  });

  test("stops a late agent after a crash, so it can't run past the limit", () => {
    const store = EventStore.open(":memory:");
    const first = new Loop(config, new Recorded(), store);
    first.send(one, add());
    first.send(two, add());
    first.startWaiting();
    first.send(one, { by: "human", type: "drop" });

    // #1's agent comes up late. The loop saves that, then dies before it
    // can stop the agent.
    const dying = Loop.open(config, new Dying(), store);
    if (!dying.ok) throw new Error(dying.reason);
    expect(() => dying.loop.send(one, started(1, "late"))).toThrow("The daemon died.");

    const tools = new Recorded();
    const reopened = Loop.open(config, tools, store);
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(tools.commands).toEqual([{ type: "stop_session", session: SessionId.parse("late") }]);
  });

  // Found by review: a command counted as done as soon as the tools took
  // it, so work that was still going on when the daemon died was lost.
  test("carries out a command again after a restart if its tool never finished it", () => {
    const store = EventStore.open(":memory:");
    const first = new Loop(config, new Unfinished(), store);
    first.send(one, add());
    first.startWaiting();

    const tools = new Recorded();
    const reopened = Loop.open(config, tools, store);
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(tools.commands).toEqual([
      { type: "start_spec_session", taskId: one, request: 1, note: null },
    ]);
  });

  // Found by review: each stop still in progress freed a slot, so with a
  // stop that hung, any number of agents could run past max_running.
  test("keeps a stopping agent's slot until its stop has finished", () => {
    const tools = new SlowStops();
    const loop = new Loop(config, tools, EventStore.open(":memory:"));
    loop.send(one, add());
    loop.send(two, add());
    expect(loop.startWaiting()).toEqual([one]);
    loop.send(one, started(1, "s1"));
    loop.send(one, { by: "human", type: "drop" });

    // #1's agent is still being stopped, so its slot stays taken.
    expect(loop.startWaiting()).toEqual([]);
    tools.finishStops();
    expect(loop.startWaiting()).toEqual([two]);
  });

  test("keeps that slot across a restart, until the stop finishes", () => {
    const store = EventStore.open(":memory:");
    const first = new Loop(config, new SlowStops(), store);
    first.send(one, add());
    first.send(two, add());
    first.startWaiting();
    first.send(one, started(1, "s1"));
    first.send(one, { by: "human", type: "drop" });

    const tools = new SlowStops();
    const reopened = Loop.open(config, tools, store);
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(reopened.loop.startWaiting()).toEqual([]);
    tools.finishStops();
    expect(reopened.loop.startWaiting()).toEqual([two]);
  });

  // Found by review: a stop was counted before the tool took it, so a tool
  // that threw kept the slot taken until the daemon restarted.
  test("frees the slot when the tool throws instead of taking a stop", () => {
    const throwing: Tools = {
      carryOut: (command, finished) => {
        if (command.type === "stop_session") throw new Error("kill: EPERM");
        finished();
      },
    };
    const loop = new Loop(config, throwing, EventStore.open(":memory:"));
    loop.send(one, add());
    loop.send(two, add());
    loop.startWaiting();
    loop.send(one, started(1, "s1"));
    expect(() => loop.send(one, { by: "human", type: "drop" })).toThrow("kill: EPERM");
    expect(loop.startWaiting()).toEqual([two]);
  });

  // Found by review: two stops for the same agent counted twice, so one
  // agent held two slots.
  test("counts an agent being stopped once, however many stops it gets", () => {
    const tools = new SlowStops();
    const loop = new Loop({ ...config, maxRunning: 2 }, tools, EventStore.open(":memory:"));
    loop.send(one, add());
    loop.startWaiting();
    loop.send(one, { by: "human", type: "drop" });
    // #1's agent comes up late, and its start reply arrives twice: each
    // brings a stop for the same agent.
    loop.send(one, started(1, "s1"));
    loop.send(one, started(1, "s1"));
    loop.send(two, add());
    loop.send(TaskId.parse(3), add());
    expect(loop.startWaiting()).toEqual([two]);
  });

  // Found by review: an error while marking a command done was thrown into
  // the tool's own code, where it could go unhandled.
  test("never throws from finished, and a command it couldn't mark goes out again", () => {
    const store = EventStore.open(":memory:");
    let broken = false;
    const log = {
      appendTask: store.appendTask.bind(store),
      appendProject: store.appendProject.bind(store),
      carriedOut: (id: number) => {
        if (broken) throw new Error("database is locked");
        return store.carriedOut(id);
      },
      loadTasks: store.loadTasks.bind(store),
      loadProjects: store.loadProjects.bind(store),
      loadStarts: store.loadStarts.bind(store),
      loadCommands: store.loadCommands.bind(store),
    };
    let finish: () => void = () => {};
    const holding: Tools = {
      carryOut: (_command, finished) => {
        finish = finished;
      },
    };
    const loop = new Loop(config, holding, log);
    loop.send(one, add());
    loop.startWaiting();
    broken = true;
    expect(() => finish()).not.toThrow();

    const tools = new Recorded();
    const reopened = Loop.open(config, tools, store);
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(tools.commands).toHaveLength(1);
  });

  // Found by review: the reply was saved, then the daemon died before the
  // tool said it had finished, so the start goes out again. By the Tools
  // rules a repeated start starts nothing. This is the backstop for a tool
  // that breaks that rule and starts a second agent anyway: the core stops it.
  test("stops a second agent if a tool breaks the rule and starts one on a repeated start", () => {
    const store = EventStore.open(":memory:");
    const first = new Loop(config, new Unfinished(), store);
    first.send(one, add());
    first.startWaiting();
    first.send(one, started(1, "s1"));

    const tools = new Recorded();
    const reopened = Loop.open(config, tools, store);
    if (!reopened.ok) throw new Error(reopened.reason);
    reopened.loop.send(one, started(1, "s1-again"));
    expect(tools.commands).toContainEqual({
      type: "stop_session",
      session: SessionId.parse("s1-again"),
    });
  });

  test("doesn't carry out a command again once it went out", () => {
    const store = EventStore.open(":memory:");
    const first = new Loop(config, new Recorded(), store);
    first.send(one, add());
    first.startWaiting();

    const tools = new Recorded();
    const reopened = Loop.open(config, tools, store);
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(tools.commands).toEqual([]);
  });

  test("refuses a claim when every slot is taken, and saves nothing", () => {
    const store = EventStore.open(":memory:");
    const loop = new Loop(config, new Recorded(), store);
    loop.send(one, add());
    loop.send(two, add());
    expect(loop.startWaiting()).toEqual([one]);

    // #1's agent is on its way up, and max_running is 1.
    expect(loop.send(two, claim("you-1"))).toEqual({
      ok: false,
      rejection: {
        input: "claim",
        reason: "No slot is free: 1 of 1 agents are working, starting or stopping.",
      },
    });
    const saved = store.loadTasks();
    expect(saved.ok && saved.tasks.get(two)?.phase).toBe("spec");
    expect(saved.ok && saved.tasks.get(two)).toMatchObject({ step: { kind: "queued" } });
  });

  test("lets a claim through when a slot is free, and your session then holds it", () => {
    const loop = new Loop(config, new Recorded(), null);
    loop.send(one, add());
    loop.send(two, add());

    expect(loop.send(one, claim("you-1")).ok).toBe(true);
    expect(loop.startWaiting()).toEqual([]);
  });

  test("creates and parks projects, and won't start a task in a parked one", () => {
    const loop = new Loop(config, new Recorded(), null);
    const archive = ProjectId.parse("archive");
    loop.sendProject(archive, { type: "create", name: "Archive", goal: "Old ideas" });
    loop.sendProject(archive, { type: "park" });
    loop.send(one, add(true, archive));
    expect(loop.startWaiting()).toEqual([]);
  });
});
