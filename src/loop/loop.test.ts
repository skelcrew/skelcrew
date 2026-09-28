import { describe, expect, test } from "bun:test";
import { ProjectId, SessionId, TaskId } from "../core/ids";
import type { Command, Config, Input } from "../core/types";
import { EventStore } from "../store/store";
import { type EventLog, Loop, type Tools } from "./loop";

const config: Config = {
  gates: ["local"],
  maxAttempts: 3,
  maxRunning: 1,
  specApproval: "never",
  criticalPaths: [],
  safetyCap: { tokens: 200_000, ms: 60 * 60_000 },
};

// Tools that only remember what they were asked to do.
class Recorded implements Tools {
  commands: Command[] = [];
  carryOut(command: Command): void {
    this.commands.push(command);
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

  test("creates and parks projects, and won't start a task in a parked one", () => {
    const loop = new Loop(config, new Recorded(), null);
    const archive = ProjectId.parse("archive");
    loop.sendProject(archive, { type: "create", name: "Archive", goal: "Old ideas" });
    loop.sendProject(archive, { type: "park" });
    loop.send(one, add(true, archive));
    expect(loop.startWaiting()).toEqual([]);
  });
});
