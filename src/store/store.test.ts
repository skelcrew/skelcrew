import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectId, TaskId } from "../core/ids";
import type { Config, ProjectEvent, TaskEvent } from "../core/types";
import { Simulator } from "../sim/simulator";
import { EventStore } from "./store";

const config: Config = {
  gates: ["local", "review"],
  maxAttempts: 2,
  maxRunning: 2,
  specApproval: "never",
  criticalPaths: ["src/auth/**"],
  safetyCap: { tokens: 200_000, ms: 60 * 60_000 },
};

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
      branch: { commits: -1, changedFiles: [] },
      gate: "local",
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
      { type: "project.parked", v: 1, projectId: reports, at: 2 },
    ];
    expect(store.appendProject(events).ok).toBe(true);
    const loaded = store.loadProjects();
    expect(loaded.ok && loaded.projects.get(reports)?.status).toBe("parked");
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
      branch: { commits: -1, changedFiles: [] },
      gate: "local",
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
