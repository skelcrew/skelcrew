import { describe, expect, test } from "bun:test";
import { SessionId, TaskId } from "../core/ids";
import type { Command } from "../core/types";
import type { SessionEnd, SessionStart } from "../plugins/session-runner";
import type { Done } from "../plugins/version-control";
import { EventStore } from "../store/store";
import { spec, worktree } from "../test/fixtures";
import { type AgentRecord, Agents } from "./agents";
import { FakeHarness, FakeRunner } from "./testing";

const task = TaskId.parse(12);
const develop: Command = {
  type: "start_develop_session",
  taskId: task,
  request: 3,
  worktree,
  spec,
  brief: { failure: null, note: null, blocked: null },
};
const specCopy = { path: "/repo/.skelcrew/spec-worktrees/12-csv-export" };
const specAgent: Command = {
  type: "start_spec_session",
  taskId: task,
  request: 2,
  note: null,
  worktree: specCopy,
};

function setup(
  store = EventStore.open(":memory:"),
  runner = new FakeRunner(),
  harness = new FakeHarness(),
) {
  let made = 0;
  const agents = new Agents({
    runner,
    harness,
    log: store,
    checks: ["bun run check"],
    newSession: () => {
      made += 1;
      return `session-a${made}`;
    },
  });
  return { agents, runner, store, harness };
}

describe("starting an agent", () => {
  test("starts the profile's command in the task's worktree, and records the agent", async () => {
    const { agents, runner, store } = setup();
    expect(await agents.start(develop)).toEqual({ ok: true, value: SessionId.parse("session-a1") });
    expect(runner.started).toEqual([
      {
        name: "session-a1",
        command: ["fake-agent", "develop", "12"],
        cwd: worktree.path,
        env: { SKELCREW_SESSION: "session-a1" },
        unset: ["FAKE_PARENT_SESSION"],
      },
    ]);
    expect(store.loadAgents()).toEqual({
      ok: true,
      agents: [
        {
          session: SessionId.parse("session-a1"),
          task,
          request: 3,
          kind: "develop",
          harnessSession: "fake-session-a1",
          cwd: worktree.path,
          ended: false,
          usage: null,
        },
      ],
    });
  });

  test("starts a spec agent in its spec worktree", async () => {
    const { agents, runner } = setup();
    await agents.start(specAgent);
    expect(runner.started[0]).toMatchObject({
      command: ["fake-agent", "spec", "12"],
      cwd: specCopy.path,
    });
  });

  // After a restart, the start can go out again. It must not make a
  // second agent.
  test("gives back the same agent when the same start comes again, and starts nothing", async () => {
    const { agents, runner } = setup();
    await agents.start(develop);
    expect(await agents.start(develop)).toEqual({
      ok: true,
      value: SessionId.parse("session-a1"),
    });
    expect(runner.started).toHaveLength(1);
  });

  test("says why, and keeps no running agent, when the runner can't start it", async () => {
    class Refusing extends FakeRunner {
      override async start(_session: SessionStart): Promise<Done<null>> {
        return { ok: false, message: "claude: command not found" };
      }
    }
    const { agents, store } = setup(EventStore.open(":memory:"), new Refusing());
    expect(await agents.start(develop)).toEqual({
      ok: false,
      message: "claude: command not found",
    });
    const loaded = store.loadAgents();
    expect(loaded.ok && loaded.agents.map((agent) => agent.ended)).toEqual([true]);
  });
});

// Skelcrew can't stop or type into a session it didn't start, such as
// yours after a claim.
describe("stopping and typing", () => {
  test("only touch sessions it started", async () => {
    const { agents, runner } = setup();
    await agents.start(develop);
    await agents.type(SessionId.parse("you-1"), "No");
    await agents.stop(SessionId.parse("you-1"));
    expect(runner.typed).toEqual([]);
    expect(runner.stopped).toEqual([]);

    await agents.type(SessionId.parse("session-a1"), "No");
    await agents.stop(SessionId.parse("session-a1"));
    expect(runner.typed).toEqual([{ name: "session-a1", text: "No" }]);
    expect(runner.stopped).toEqual(["session-a1"]);
  });
});

describe("an agent's end", () => {
  test("is reported with the agent's task and request, and recorded", async () => {
    const { agents, runner, store } = setup();
    const ends: { agent: AgentRecord; end: SessionEnd }[] = [];
    agents.onEnd((agent, end) => ends.push({ agent, end }));
    await agents.start(develop);
    runner.end("session-a1", { exitCode: 1, lastLine: "Out of memory." });
    // The end waits for the agent's last usage reading.
    await waitFor(() => ends.length === 1);
    expect(ends).toEqual([
      {
        agent: expect.objectContaining({ session: "session-a1", task, request: 3 }),
        end: { exitCode: 1, lastLine: "Out of memory." },
      },
    ]);
    const loaded = store.loadAgents();
    expect(loaded.ok && loaded.agents.map((agent) => agent.ended)).toEqual([true]);
  });

  // The basic runner's sessions end with the daemon. After a restart, its
  // agents are gone, and the daemon must tell the core.
  test("after a restart, the agents the runner no longer has are given back once", async () => {
    const store = EventStore.open(":memory:");
    await setup(store).agents.start(develop);
    const after = setup(store, new FakeRunner()).agents;
    expect(await after.lost()).toEqual([
      expect.objectContaining({ session: "session-a1", task, request: 3 }),
    ]);
    expect(await after.lost()).toEqual([]);
  });
});

// What each agent has used, read from its harness. Only agents Skelcrew
// started are read. Your own sessions are never counted.
describe("usage", () => {
  const used = (tokens: number, cacheReads: number, minutes: number) => ({
    tokens,
    cacheReads,
    workingMs: minutes * 60_000,
  });

  test("reads each running agent and adds a task's agents up by phase", async () => {
    const { agents, harness } = setup();
    await agents.start(specAgent);
    await agents.start({ ...develop, request: 5 });
    harness.used.set("session-a1", used(30_000, 400_000, 5));
    harness.used.set("session-a2", used(20_000, 900_000, 4));
    expect(await agents.readRunning()).toEqual([task]);
    expect(agents.usageOf(task)).toEqual({
      spec: { tokens: 30_000, cacheReads: 400_000, ms: 5 * 60_000 },
      develop: { tokens: 20_000, cacheReads: 900_000, ms: 4 * 60_000 },
    });
  });

  test("adds up every agent a phase had, such as a develop agent after a retry", async () => {
    const { agents, runner, harness } = setup();
    await agents.start(develop);
    harness.used.set("session-a1", used(10_000, 0, 2));
    runner.end("session-a1", { exitCode: 1, lastLine: "Out of memory." });
    await agents.start({ ...develop, request: 7 });
    harness.used.set("session-a2", used(5_000, 0, 1));
    await agents.readRunning();
    expect(agents.usageOf(task).develop).toEqual({ tokens: 15_000, cacheReads: 0, ms: 3 * 60_000 });
  });

  test("has nothing for a task with no agents, such as one you claimed", () => {
    const { agents } = setup();
    const none = { tokens: 0, cacheReads: 0, ms: 0 };
    expect(agents.usageOf(TaskId.parse(99))).toEqual({ spec: none, develop: none });
  });

  // A reading can only come from a transcript that grew. A lower one, such
  // as from a transcript that couldn't be found for a moment, is ignored.
  test("never lowers a reading", async () => {
    const { agents, harness } = setup();
    await agents.start(develop);
    harness.used.set("session-a1", used(10_000, 50_000, 3));
    await agents.readRunning();
    harness.used.set("session-a1", used(0, 0, 0));
    await agents.readRunning();
    expect(agents.usageOf(task).develop).toEqual({
      tokens: 10_000,
      cacheReads: 50_000,
      ms: 3 * 60_000,
    });
  });

  test("reads an agent one last time before its end is reported, then never again", async () => {
    const { agents, runner, harness } = setup();
    const ends: AgentRecord[] = [];
    agents.onEnd((agent) => ends.push(agent));
    await agents.start(develop);
    harness.used.set("session-a1", used(12_000, 0, 6));
    runner.end("session-a1", { exitCode: 0, lastLine: "" });
    await waitFor(() => ends.length === 1);
    expect(ends[0]?.usage).toEqual(used(12_000, 0, 6));
    expect(agents.usageOf(task).develop.tokens).toBe(12_000);

    const before = harness.reads.length;
    expect(await agents.readRunning()).toEqual([]);
    expect(harness.reads.length).toBe(before);
  });

  test("keeps the last reading across a restart", async () => {
    const store = EventStore.open(":memory:");
    const first = setup(store);
    await first.agents.start(develop);
    first.harness.used.set("session-a1", used(8_000, 0, 1));
    await first.agents.readRunning();
    expect(setup(store).agents.usageOf(task).develop.tokens).toBe(8_000);
  });

  test("reads an agent lost in a restart before giving it back", async () => {
    const store = EventStore.open(":memory:");
    await setup(store).agents.start(develop);
    const harness = new FakeHarness();
    harness.used.set("session-a1", used(9_000, 0, 2));
    const lost = await setup(store, new FakeRunner(), harness).agents.lost();
    expect(lost[0]?.usage).toEqual(used(9_000, 0, 2));
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("It didn't happen within a second.");
}
