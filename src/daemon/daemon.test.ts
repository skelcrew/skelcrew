import { describe, expect, test } from "bun:test";
import { SessionId, TaskId } from "../core/ids";
import type { Config } from "../core/types";
import type { Command } from "../protocol/protocol";
import { EventStore } from "../store/store";
import { config as base, spec } from "../test/fixtures";
import { Daemon } from "./daemon";

const config: Config = { ...base, gates: ["local"], maxRunning: 1, specApproval: "always" };

// A daemon on an in-memory event store. Session names are numbered, so
// tests can name them.
function open(store = EventStore.open(":memory:")) {
  let sessions = 0;
  const opened = Daemon.open({
    config,
    log: store,
    newSession: () => {
      sessions += 1;
      return `you-${sessions}`;
    },
  });
  if (!opened.ok) throw new Error(opened.message);
  return { daemon: opened.value, store };
}

async function ok(daemon: Daemon, command: Command): Promise<unknown> {
  const answer = await daemon.handle(command);
  if (!answer.ok) throw new Error(answer.message);
  return answer.result;
}

const add = (title: string, withSpec = true): Command => ({
  type: "add",
  title,
  spec: withSpec,
  project: null,
});
const task = (n: number) => TaskId.parse(n);
const you = (n: number) => SessionId.parse(`you-${n}`);

describe("the daemon", () => {
  test("gives each new task the next number", async () => {
    const { daemon } = open();
    expect(await ok(daemon, add("CSV export"))).toEqual({ task: 1 });
    expect(await ok(daemon, add("PDF export"))).toEqual({ task: 2 });
  });

  test("handles requests one at a time, so numbers never repeat", async () => {
    const { daemon } = open();
    const answers = await Promise.all(
      ["a", "b", "c", "d", "e"].map((title) => daemon.handle(add(title))),
    );
    expect(answers.map((a) => (a.ok ? a.result : null))).toEqual([
      { task: 1 },
      { task: 2 },
      { task: 3 },
      { task: 4 },
      { task: 5 },
    ]);
  });

  test("lets you claim a task in Spec, and hears only your session", async () => {
    const { daemon } = open();
    await ok(daemon, add("CSV export"));
    expect(await ok(daemon, { type: "claim", task: task(1) })).toEqual({
      session: "you-1",
      phase: "spec",
      spec: null,
      note: null,
    });
    const stranger = await daemon.handle({
      type: "submit",
      task: task(1),
      session: SessionId.parse("someone"),
      spec,
    });
    expect(stranger.ok).toBe(false);
    await ok(daemon, { type: "submit", task: task(1), session: you(1), spec });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, title: "CSV export", phase: "spec", waitingOnYou: "spec_approval" }],
    });
  });

  test("approves a spec, or sends it back with your note", async () => {
    const { daemon } = open();
    for (const title of ["one", "two"]) {
      await ok(daemon, add(title));
    }
    await ok(daemon, { type: "claim", task: task(1) });
    await ok(daemon, { type: "submit", task: task(1), session: you(1), spec });
    await ok(daemon, { type: "approve", task: task(1), sendBack: null });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "ready" }, { task: 2 }],
    });

    await ok(daemon, { type: "claim", task: task(2) });
    await ok(daemon, { type: "submit", task: task(2), session: you(2), spec });
    await ok(daemon, { type: "approve", task: task(2), sendBack: "Add totals." });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1 }, { task: 2, phase: "spec", waitingOnYou: null }],
    });
  });

  test("refuses an approval when nothing waits for one", async () => {
    const { daemon } = open();
    await ok(daemon, add("CSV export"));
    expect(await daemon.handle({ type: "approve", task: task(1), sendBack: null })).toEqual({
      ok: false,
      message: "#1 has nothing waiting for your approval.",
    });
  });

  test("refuses a claim when no slot is free", async () => {
    const { daemon } = open();
    await ok(daemon, add("one"));
    await ok(daemon, add("two"));
    await ok(daemon, { type: "claim", task: task(1) });
    const second = await daemon.handle({ type: "claim", task: task(2) });
    expect(second.ok).toBe(false);
  });

  test("passes on the core's refusals in plain words", async () => {
    const { daemon } = open();
    expect(await daemon.handle({ type: "spec", task: task(9) })).toEqual({
      ok: false,
      message: "#9 doesn't exist.",
    });
  });

  // Giving up is tested once a task can reach In progress, where the core
  // accepts it, which needs worktrees.
  test("drops a task", async () => {
    const { daemon } = open();
    await ok(daemon, add("one"));
    await ok(daemon, { type: "drop", task: task(1) });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "dropped" }],
    });
  });

  // Without git, a claim in Ready can't get its worktree. The core must
  // hear that at once, rather than wait for a worktree that never comes.
  test("answers a command it can't carry out yet with a failure, at once", async () => {
    const { daemon } = open();
    await ok(daemon, add("CSV export"));
    await ok(daemon, { type: "claim", task: task(1) });
    await ok(daemon, { type: "submit", task: task(1), session: you(1), spec });
    await ok(daemon, { type: "approve", task: task(1), sendBack: null });
    await ok(daemon, { type: "claim", task: task(1) });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [
        {
          task: 1,
          phase: "ready",
          blocked:
            "The worktree couldn't be made: Making worktrees isn't built into the daemon yet.",
        },
      ],
    });
  });

  test("picks up where it left off after a restart", async () => {
    const first = open();
    await ok(first.daemon, add("CSV export"));
    const second = open(first.store);
    expect(await ok(second.daemon, add("PDF export"))).toEqual({ task: 2 });
    expect(await ok(second.daemon, { type: "status" })).toMatchObject({
      tasks: [
        { task: 1, title: "CSV export" },
        { task: 2, title: "PDF export" },
      ],
    });
  });
});
