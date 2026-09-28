import { describe, expect, test } from "bun:test";
import type { Config, TaskEvent } from "../core/types";
import { Simulator } from "../sim/simulator";
import { parseProjectEvent, parseTaskEvent } from "./schema";

const config: Config = {
  gates: ["local", "review"],
  maxAttempts: 2,
  maxRunning: 2,
  specApproval: "always",
  criticalPaths: ["src/auth/**"],
  safetyCap: { tokens: 200_000, ms: 60 * 60_000 },
};

// Real events from whole lifecycles: gates failing, a block and retry, a
// critical merge, a merge conflict, a question, and a revert.
function realEvents(): TaskEvent[] {
  const sim = new Simulator(config);
  const a = sim.add("CSV export", {
    requestSpec: true,
    behaviour: { specQuestion: "Include deleted rows?", gates: { local: [false, false] } },
  });
  const b = sim.add("Login fix", {
    requestSpec: true,
    behaviour: { changedFiles: ["src/auth/login.ts"], merges: ["conflict"] },
  });
  sim.add("Dark mode");
  sim.run();
  sim.send(a, { type: "answer", text: "No" });
  sim.send(a, { type: "approve_spec" });
  sim.send(a, { type: "retry" });
  sim.send(b, { type: "approve_spec" });
  sim.send(b, { type: "approve_merge" });
  sim.send(b, { type: "approve_merge" });
  sim.send(b, { type: "revert", reason: "Broke login." });
  return sim.events;
}

// What a stored event looks like after a trip through JSON and back.
function stored(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("parseTaskEvent", () => {
  test("reads back every event a real lifecycle writes, unchanged", () => {
    const events = realEvents();
    const types = new Set(events.map((e) => e.type));
    // A sanity check that the lifecycles above reach far.
    expect(types.size).toBeGreaterThanOrEqual(20);
    for (const event of events) {
      expect(parseTaskEvent(stored(event))).toEqual({ ok: true, event });
    }
  });

  test("refuses an event type it doesn't know", () => {
    const result = parseTaskEvent({ type: "task.teleported", v: 1, taskId: 12, at: 1 });
    expect(result.ok).toBe(false);
  });

  test("refuses a field of the wrong type, and says which", () => {
    const result = parseTaskEvent({ type: "task.dropped", v: 1, taskId: "12", at: 1 });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.reason).toContain("taskId");
  });

  test("refuses an extra field, rather than dropping it without a word", () => {
    const result = parseTaskEvent({ type: "task.dropped", v: 1, taskId: 12, at: 1, why: "x" });
    expect(result.ok).toBe(false);
  });

  test("refuses a version it doesn't know", () => {
    const result = parseTaskEvent({ type: "task.dropped", v: 2, taskId: 12, at: 1 });
    expect(result.ok).toBe(false);
  });
});

describe("parseProjectEvent", () => {
  test("reads back a project's events", () => {
    const events = [
      {
        type: "project.created",
        name: "Reports",
        goal: "Better reports",
        v: 1,
        projectId: "reports",
        at: 1,
      },
      { type: "project.parked", v: 1, projectId: "reports", at: 2 },
      { type: "project.activated", v: 1, projectId: "reports", at: 3 },
    ];
    for (const event of events) {
      expect<unknown>(parseProjectEvent(event)).toEqual({ ok: true, event });
    }
  });

  test("refuses a project ID that isn't a slug", () => {
    const result = parseProjectEvent({
      type: "project.parked",
      v: 1,
      projectId: "My Reports",
      at: 1,
    });
    expect(result.ok).toBe(false);
  });
});
