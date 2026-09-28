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

// Tools that only remember what they were asked to do.
class Recorded implements Tools {
  commands: Command[] = [];
  carryOut(command: Command): void {
    this.commands.push(command);
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

  test("creates and parks projects, and won't start a task in a parked one", () => {
    const loop = new Loop(config, new Recorded(), null);
    const archive = ProjectId.parse("archive");
    loop.sendProject(archive, { type: "create", name: "Archive", goal: "Old ideas" });
    loop.sendProject(archive, { type: "park" });
    loop.send(one, add(true, archive));
    expect(loop.startWaiting()).toEqual([]);
  });
});
