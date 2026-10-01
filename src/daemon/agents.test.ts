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

function setup(store = EventStore.open(":memory:"), runner = new FakeRunner()) {
  let made = 0;
  const agents = new Agents({
    runner,
    harness: new FakeHarness(),
    log: store,
    checks: ["bun run check"],
    newSession: () => {
      made += 1;
      return `session-a${made}`;
    },
  });
  return { agents, runner, store };
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
