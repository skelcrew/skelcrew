import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectId, TaskId } from "../core/ids";
import type { Command, Config, ProjectEvent, TaskEvent } from "../core/types";
import { Simulator } from "../sim/simulator";
import { config as base, head } from "../test/fixtures";
import { EventStore } from "./store";

const config: Config = { ...base, maxAttempts: 2, specApproval: "never" };

// Three tasks run to the end, one of them through a failed gate and a merge
// conflict, and a fourth left as an idea.
function simulated(): Simulator {
  const sim = new Simulator(config);
  sim.add("CSV export", { requestSpec: true, behaviour: { gates: { local: [false] } } });
  sim.add("PDF export", { requestSpec: true, behaviour: { merges: ["conflict"] } });
  sim.add("Dark mode", { requestSpec: true });
  sim.add("Later idea");
  sim.run();
  return sim;
}

// Saves events the way the daemon will: one append per decision. Here each
// event is its own batch, which is enough to test reading back.
function save(store: EventStore, events: TaskEvent[]): void {
  for (const event of events) {
    const saved = store.appendTask([event]);
    if (!saved.ok) throw new Error(saved.reason);
  }
}

let dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "skelcrew-store-"));
  dirs.push(dir);
  return join(dir, "skelcrew.db");
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("the event store", () => {
  test("rebuilds every task exactly from its saved events", () => {
    const sim = simulated();
    const store = EventStore.open(":memory:");
    save(store, sim.events);

    const loaded = store.loadTasks();
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.tasks.size).toBe(4);
    for (const [id, task] of loaded.tasks) expect(task).toEqual(sim.task(id));
  });

  test("keeps tasks across closing and reopening the file", () => {
    const sim = simulated();
    const file = tempFile();
    const first = EventStore.open(file);
    save(first, sim.events);
    first.close();

    const loaded = EventStore.open(file).loadTasks();
    expect(loaded.ok && [...loaded.tasks.values()].map((t) => t.phase)).toEqual([
      "done",
      "done",
      "done",
      "idea",
    ]);
  });

  test("saves all of a decision's events, or none of them", () => {
    const store = EventStore.open(":memory:");
    const id = TaskId.parse(1);
    const created: TaskEvent = {
      type: "task.created",
      title: "CSV export",
      project: null,
      source: null,
      v: 1,
      taskId: id,
      at: 1,
    };
    // The type allows a negative count, but the stored shape doesn't.
    const bad: TaskEvent = {
      type: "task.done_reported",
      branch: { head, commits: -1, changedFiles: [] },
      gate: "local",
      request: 1,
      v: 1,
      taskId: id,
      at: 2,
    };
    const saved = store.appendTask([created, bad]);
    expect(saved.ok).toBe(false);
    const loaded = store.loadTasks();
    expect(loaded.ok && loaded.tasks.size).toBe(0);
  });

  test("reports a damaged row with its position, instead of guessing", () => {
    const file = tempFile();
    const store = EventStore.open(file);
    save(store, simulated().events.slice(0, 3));
    store.close();

    const raw = new Database(file);
    raw.run('UPDATE events SET body = \'{"type":"task.ready","v":1}\' WHERE seq = 2');
    raw.close();

    const loaded = EventStore.open(file).loadTasks();
    expect(loaded).toMatchObject({ ok: false, seq: 2 });
  });

  test("reports an event that doesn't fit its task, with its position", () => {
    const store = EventStore.open(":memory:");
    const id = TaskId.parse(1);
    save(store, [
      {
        type: "task.created",
        title: "CSV export",
        project: null,
        source: null,
        v: 1,
        taskId: id,
        at: 1,
      },
      { type: "task.ready", v: 1, taskId: id, at: 2 },
    ]);
    expect(store.loadTasks()).toEqual({
      ok: false,
      seq: 2,
      reason: "task.ready can't apply to #1 in Idea.",
    });
  });

  test("rebuilds projects from their saved events", () => {
    const store = EventStore.open(":memory:");
    const reports = ProjectId.parse("reports");
    const events: ProjectEvent[] = [
      {
        type: "project.created",
        name: "Reports",
        goal: "Better reports",
        v: 1,
        projectId: reports,
        at: 1,
      },
      { type: "project.archived", v: 1, projectId: reports, at: 2 },
    ];
    expect(store.appendProject(events).ok).toBe(true);
    const loaded = store.loadProjects();
    expect(loaded.ok && loaded.projects.get(reports)?.status).toBe("archived");
  });

  test("reads back one task's events, oldest first", () => {
    const sim = simulated();
    const store = EventStore.open(":memory:");
    save(store, sim.events);
    const two = TaskId.parse(2);
    const events = sim.events.filter((event) => event.taskId === two);
    expect(events.length).toBeGreaterThan(5);
    expect(store.loadTaskEvents(two)).toEqual({ ok: true, events });
    expect(store.loadTaskEvents(TaskId.parse(9))).toEqual({ ok: true, events: [] });
  });

  test("reports a damaged row among one task's events with its position", () => {
    const file = tempFile();
    const store = EventStore.open(file);
    save(store, simulated().events.slice(0, 3));
    store.close();

    const raw = new Database(file);
    raw.run('UPDATE events SET body = \'{"type":"task.ready","v":1,"taskId":1}\' WHERE seq = 2');
    raw.close();

    const loaded = EventStore.open(file).loadTaskEvents(TaskId.parse(1));
    expect(loaded).toMatchObject({ ok: false, seq: 2 });
  });

  test("opens an existing file without redoing its setup", () => {
    const file = tempFile();
    EventStore.open(file).close();
    const store = EventStore.open(file);
    save(store, simulated().events.slice(0, 1));
    const loaded = store.loadTasks();
    expect(loaded.ok && loaded.tasks.size).toBe(1);
  });
});

describe("starts in flight", () => {
  const id = TaskId.parse(1);
  const created: TaskEvent = {
    type: "task.created",
    title: "CSV export",
    project: null,
    source: null,
    v: 1,
    taskId: id,
    at: 1,
  };

  test("are kept across closing and reopening the file, until answered", () => {
    const file = tempFile();
    const first = EventStore.open(file);
    first.appendTask([created], { sent: [{ taskId: id, request: 1 }], answered: [] });
    first.appendTask([], { sent: [{ taskId: id, request: 2 }], answered: [] });
    first.close();

    const second = EventStore.open(file);
    expect(second.loadStarts()).toEqual([
      { taskId: id, request: 1 },
      { taskId: id, request: 2 },
    ]);
    second.appendTask([], { sent: [], answered: [{ taskId: id, request: 1 }] });
    expect(second.loadStarts()).toEqual([{ taskId: id, request: 2 }]);
  });

  test("are saved together with the decision's events, or not at all", () => {
    const store = EventStore.open(":memory:");
    const bad: TaskEvent = {
      type: "task.done_reported",
      branch: { head, commits: -1, changedFiles: [] },
      gate: "local",
      request: 1,
      v: 1,
      taskId: id,
      at: 2,
    };
    const saved = store.appendTask([created, bad], {
      sent: [{ taskId: id, request: 1 }],
      answered: [],
    });
    expect(saved.ok).toBe(false);
    expect(store.loadStarts()).toEqual([]);
  });
});

describe("commands not yet carried out", () => {
  const id = TaskId.parse(1);
  const created: TaskEvent = {
    type: "task.created",
    title: "CSV export",
    project: null,
    source: null,
    v: 1,
    taskId: id,
    at: 1,
  };
  const start: Command = { type: "start_spec_session", taskId: id, request: 1, note: null };
  const none = { sent: [], answered: [] };

  test("are kept across closing and reopening the file, until carried out", () => {
    const file = tempFile();
    const first = EventStore.open(file);
    const saved = first.appendTask([created], none, [start]);
    if (!saved.ok) throw new Error(saved.reason);
    first.close();

    const [only] = saved.ids;
    if (only === undefined) throw new Error("The command got no id.");

    const second = EventStore.open(file);
    expect(second.loadCommands()).toEqual({ ok: true, commands: [{ id: only, command: start }] });
    second.carriedOut(only);
    expect(second.loadCommands()).toEqual({ ok: true, commands: [] });
  });

  test("are saved together with the decision's events, or not at all", () => {
    const store = EventStore.open(":memory:");
    // The type allows a negative count, but the stored shape doesn't.
    const bad: TaskEvent = {
      type: "task.done_reported",
      branch: { head, commits: -1, changedFiles: [] },
      gate: "local",
      request: 1,
      v: 1,
      taskId: id,
      at: 2,
    };
    expect(store.appendTask([created, bad], none, [start]).ok).toBe(false);
    expect(store.loadCommands()).toEqual({ ok: true, commands: [] });
  });

  test("reports a damaged command with its position", () => {
    const file = tempFile();
    const store = EventStore.open(file);
    store.appendTask([created], none, [start]);
    store.close();

    const raw = new Database(file);
    raw.run('UPDATE commands SET body = \'{"type":"launch_rocket"}\'');
    raw.close();

    expect(EventStore.open(file).loadCommands()).toMatchObject({ ok: false, seq: 1 });
  });
});

describe("pull requests opened for reading", () => {
  const opened = (task: number, number: number) => ({
    task: TaskId.parse(task),
    branch: `task/${task}-csv-export`,
    head,
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
  });

  test("are remembered after the store is opened again, one per task", () => {
    const file = tempFile();
    const store = EventStore.open(file);
    expect(store.savePullRequest(opened(1, 40))).toEqual({ ok: true });
    store.savePullRequest(opened(2, 41));
    // Task 1 was built again and has a new pull request.
    store.savePullRequest(opened(1, 42));
    store.close();

    expect(EventStore.open(file).loadPullRequests()).toEqual({
      ok: true,
      pullRequests: [opened(1, 42), opened(2, 41)],
    });
  });

  test("are forgotten once closed", () => {
    const store = EventStore.open(":memory:");
    store.savePullRequest(opened(1, 40));
    store.savePullRequest(opened(2, 41));
    expect(store.forgetPullRequest(TaskId.parse(1))).toEqual({ ok: true });
    expect(store.loadPullRequests()).toEqual({ ok: true, pullRequests: [opened(2, 41)] });
  });

  test("a damaged one is reported with its task", () => {
    const file = tempFile();
    const store = EventStore.open(file);
    store.savePullRequest(opened(3, 40));
    store.close();

    const raw = new Database(file);
    raw.run(`UPDATE pull_requests SET body = '{"number":"forty"}'`);
    raw.close();

    expect(EventStore.open(file).loadPullRequests()).toMatchObject({ ok: false, seq: 3 });
  });
});
