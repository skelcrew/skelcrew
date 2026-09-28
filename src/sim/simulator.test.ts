import { describe, expect, test } from "bun:test";
import type { Config } from "../core/types";
import { Simulator } from "./simulator";

const config: Config = {
  gates: ["local", "review"],
  maxAttempts: 3,
  maxRunning: 2,
  specApproval: "always",
  criticalPaths: ["src/auth/**"],
  safetyCap: { tokens: 200_000, ms: 60 * 60_000 },
};
const noApproval: Config = { ...config, specApproval: "never" };

function count(sim: Simulator, type: string): number {
  return sim.events.filter((event) => event.type === type).length;
}

describe("the simulator", () => {
  test("leaves an idea alone until you ask for a spec", () => {
    const sim = new Simulator(config);
    const id = sim.add("CSV export");
    sim.run();
    expect(sim.task(id).phase).toBe("idea");
    expect(sim.liveSessions()).toEqual([]);
  });

  test("takes a task from idea to merged, stopping only for your approval", () => {
    const sim = new Simulator(config);
    const id = sim.add("CSV export", { requestSpec: true });
    sim.run();
    expect(sim.waitingOnYou()).toEqual([{ task: id, for: "spec_approval" }]);

    sim.send(id, { type: "approve_spec" });
    expect(sim.task(id)).toMatchObject({ phase: "done" });
    expect(sim.waitingOnYou()).toEqual([]);
  });

  test("leaves no agent running and no worktree behind once a task is done", () => {
    const sim = new Simulator(noApproval);
    sim.add("CSV export", { requestSpec: true });
    sim.run();
    expect(sim.liveSessions()).toEqual([]);
    expect(sim.liveWorktrees()).toEqual([]);
  });

  test("never runs more agents than max_running, and finishes every task", () => {
    const sim = new Simulator({ ...noApproval, maxRunning: 1 });
    const ids = ["CSV export", "PDF export", "Dark mode"].map((title) =>
      sim.add(title, { requestSpec: true }),
    );
    sim.run();
    expect(ids.map((id) => sim.task(id).phase)).toEqual(["done", "done", "done"]);
    expect(sim.mostAgentsAtOnce).toBe(1);
  });

  test("sends a failing gate back to the agent until it passes", () => {
    const sim = new Simulator(noApproval);
    const id = sim.add("CSV export", {
      requestSpec: true,
      behaviour: { gates: { local: [false, false] } },
    });
    sim.run();
    expect(sim.task(id).phase).toBe("done");
    expect(count(sim, "task.gate_failed")).toBe(2);
  });

  test("blocks a task that runs out of attempts, and finishes it after a retry", () => {
    const sim = new Simulator(noApproval);
    const id = sim.add("CSV export", {
      requestSpec: true,
      behaviour: { gates: { local: [false, false, false] } },
    });
    sim.run();
    expect(sim.waitingOnYou()).toEqual([{ task: id, for: "retry" }]);

    sim.send(id, { type: "retry" });
    expect(sim.task(id).phase).toBe("done");
  });

  test("waits for your approval before merging a critical file", () => {
    const sim = new Simulator(noApproval);
    const id = sim.add("Login fix", {
      requestSpec: true,
      behaviour: { changedFiles: ["src/auth/login.ts"] },
    });
    sim.run();
    expect(sim.waitingOnYou()).toEqual([{ task: id, for: "merge_approval" }]);

    sim.send(id, { type: "approve_merge" });
    expect(sim.task(id).phase).toBe("done");
  });

  test("starts a new agent after a merge conflict, and merges on the second try", () => {
    const sim = new Simulator(noApproval);
    const id = sim.add("CSV export", { requestSpec: true, behaviour: { merges: ["conflict"] } });
    sim.run();
    expect(sim.task(id).phase).toBe("done");
    expect(count(sim, "task.merge_failed")).toBe(1);
    // One spec agent, then a develop agent for each try.
    expect(count(sim, "task.spec_session_started") + count(sim, "task.dispatched")).toBe(3);
  });

  test("holds the spec until you answer the spec agent's question", () => {
    const sim = new Simulator(config);
    const id = sim.add("CSV export", {
      requestSpec: true,
      behaviour: { specQuestion: "Include deleted rows?" },
    });
    sim.run();
    expect(sim.waitingOnYou()).toEqual([{ task: id, for: "answer" }]);

    sim.send(id, { type: "answer", text: "No" });
    expect(sim.waitingOnYou()).toEqual([{ task: id, for: "spec_approval" }]);
  });

  test("blocks a task whose agent gives up", () => {
    const sim = new Simulator(noApproval);
    const id = sim.add("CSV export", { requestSpec: true, behaviour: { giveUp: true } });
    sim.run();
    expect(sim.waitingOnYou()).toEqual([{ task: id, for: "retry" }]);
    expect(sim.liveSessions()).toEqual([]);
  });

  test("runs the same way every time", () => {
    const events = () => {
      const sim = new Simulator(noApproval);
      sim.add("CSV export", { requestSpec: true, behaviour: { gates: { local: [false] } } });
      sim.add("PDF export", { requestSpec: true, behaviour: { merges: ["conflict"] } });
      sim.run();
      return sim.events;
    };
    expect(events()).toEqual(events());
  });
});
