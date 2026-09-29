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

// A daemon whose store throws when saving a tool's reply, while
// `broken.replies` is on. Here the only reply is the failure that blocks
// a task. `broken.tries` counts the saves it refused.
function failingReplies(options: { retryMs: number; maxRetryMs: number }) {
  const store = EventStore.open(":memory:");
  const broken = { replies: false, tries: 0 };
  const log = {
    appendTask: (...args: Parameters<EventStore["appendTask"]>) => {
      const [events] = args;
      if (broken.replies && events.some((e) => e.type === "task.blocked")) {
        broken.tries += 1;
        throw new Error("database is locked");
      }
      return store.appendTask(...args);
    },
    appendProject: store.appendProject.bind(store),
    carriedOut: store.carriedOut.bind(store),
    loadTasks: store.loadTasks.bind(store),
    loadProjects: store.loadProjects.bind(store),
    loadStarts: store.loadStarts.bind(store),
    loadCommands: store.loadCommands.bind(store),
  };
  let sessions = 0;
  const opened = Daemon.open({
    config,
    log,
    ...options,
    newSession: () => {
      sessions += 1;
      return `you-${sessions}`;
    },
  });
  if (!opened.ok) throw new Error(opened.message);
  return { daemon: opened.value, store, broken };
}

// Takes task 1 through Spec, so the next claim asks for a worktree.
async function readyToClaim(daemon: Daemon) {
  await ok(daemon, add("CSV export"));
  await ok(daemon, { type: "claim", task: task(1) });
  await ok(daemon, { type: "submit", task: task(1), session: you(1), spec });
  await ok(daemon, { type: "approve", task: task(1), sendBack: null });
}

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

  // Found by review: the real store throws on errors such as a locked
  // database, and the request then got no answer at all.
  test("answers every request, even when saving throws", async () => {
    const store = EventStore.open(":memory:");
    let broken = false;
    const log = {
      appendTask: (...args: Parameters<EventStore["appendTask"]>) => {
        if (broken) throw new Error("database is locked");
        return store.appendTask(...args);
      },
      appendProject: store.appendProject.bind(store),
      carriedOut: store.carriedOut.bind(store),
      loadTasks: store.loadTasks.bind(store),
      loadProjects: store.loadProjects.bind(store),
      loadStarts: store.loadStarts.bind(store),
      loadCommands: store.loadCommands.bind(store),
    };
    const opened = Daemon.open({ config, log });
    if (!opened.ok) throw new Error(opened.message);
    broken = true;
    const answer = await opened.value.handle(add("CSV export"));
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.message).toContain("database is locked");
    broken = false;
    expect(await ok(opened.value, add("CSV export"))).toEqual({ task: 1 });
  });

  // Found by review: a tool's reply whose save threw was dropped. A later
  // review found that giving up after a few tries kept the task's slot
  // taken until the next restart, even once the database was fine again.
  test("keeps sending a reply until it is saved, then the command finishes", async () => {
    const { daemon, store, broken } = failingReplies({ retryMs: 1, maxRetryMs: 5 });
    await readyToClaim(daemon);

    // Claiming in Ready asks for a worktree. Without git its reply is a
    // failure that blocks the task, and saving that reply now throws.
    broken.replies = true;
    await ok(daemon, { type: "claim", task: task(1) });
    await Bun.sleep(200);
    // Waits double from 1 ms but stop growing at 5 ms, so 200 ms fits
    // many tries. Without the cap it would be about 8.
    expect(broken.tries).toBeGreaterThan(15);
    expect(store.loadCommands()).toMatchObject({
      commands: [{ command: { type: "create_worktree" } }],
    });

    broken.replies = false;
    await Bun.sleep(50);
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, blocked: expect.stringContaining("The worktree couldn't be made") }],
    });
    expect(store.loadCommands()).toEqual({ ok: true, commands: [] });
    await daemon.close();
  });

  test("once closed, sends no more replies and refuses requests", async () => {
    const { daemon, broken } = failingReplies({ retryMs: 1, maxRetryMs: 5 });
    await readyToClaim(daemon);
    broken.replies = true;
    await ok(daemon, { type: "claim", task: task(1) });
    await Bun.sleep(20);
    await daemon.close();
    const tries = broken.tries;
    await Bun.sleep(50);
    expect(broken.tries).toBe(tries);
    const answer = await daemon.handle({ type: "status" });
    expect(answer).toEqual({ ok: false, message: "The daemon is shutting down." });
  });

  // Found by review: a session name the schema refuses threw.
  test("refuses a claim when it can't name a session", async () => {
    const opened = Daemon.open({
      config,
      log: EventStore.open(":memory:"),
      newSession: () => "",
    });
    if (!opened.ok) throw new Error(opened.message);
    await ok(opened.value, add("CSV export"));
    const answer = await opened.value.handle({ type: "claim", task: task(1) });
    expect(answer.ok).toBe(false);
  });

  // The loop keeps a command until its tool says it has finished, which for
  // a command with a reply means once the reply is handled. Otherwise every
  // command would go out again at each start.
  test("leaves no command pending once its reply is handled", async () => {
    const store = EventStore.open(":memory:");
    const { daemon } = open(store);
    await ok(daemon, add("CSV export"));
    await ok(daemon, { type: "claim", task: task(1) });
    await ok(daemon, { type: "submit", task: task(1), session: you(1), spec });
    await ok(daemon, { type: "approve", task: task(1), sendBack: null });
    await ok(daemon, { type: "claim", task: task(1) });
    await Bun.sleep(20);
    expect(store.loadCommands()).toEqual({ ok: true, commands: [] });
  });

  // A reply still unsaved when the daemon closes is left behind. Its
  // command then stays, and goes out again when the daemon next starts.
  test("keeps a command whose reply wasn't saved before closing, for the next start", async () => {
    const { daemon: first, store, broken } = failingReplies({ retryMs: 1, maxRetryMs: 5 });
    await readyToClaim(first);
    broken.replies = true;
    await ok(first, { type: "claim", task: task(1) });
    await Bun.sleep(20);
    await first.close();
    expect(store.loadCommands()).toMatchObject({
      commands: [{ command: { type: "create_worktree" } }],
    });

    // The next start carries it out again, and this time the reply is saved.
    const second = Daemon.open({ config, log: store });
    if (!second.ok) throw new Error(second.message);
    await Bun.sleep(20);
    expect(await ok(second.value, { type: "status" })).toMatchObject({
      tasks: [
        {
          task: 1,
          blocked:
            "The worktree couldn't be made: Making worktrees isn't built into the daemon yet.",
        },
      ],
    });
    expect(store.loadCommands()).toEqual({ ok: true, commands: [] });
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
