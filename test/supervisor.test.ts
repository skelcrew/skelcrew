// The session supervisor's races, scripted as interleavings against a fake host, with no tmux,
// plugin or database.
import { expect, test } from "bun:test";
import { type SessionHost, supervisor } from "../src/flow/supervisor.ts";

// A host that runs at most one agent, and holds each call named in `held` until let go.
function fakeHost() {
  const asked: string[] = [];
  const holds = new Map<string, PromiseWithResolvers<void>>();
  const state = { running: false, reachable: true };
  const step = async (name: string) => {
    asked.push(name);
    await holds.get(name)?.promise;
    holds.delete(name);
    if (!state.reachable) throw new Error("the host can't be reached");
  };
  const host: SessionHost = {
    start: async () => {
      await step("start");
      state.running = true;
    },
    stop: async () => {
      await step("stop");
      state.running = false;
    },
    runs: async () => {
      await step("runs");
      return state.running;
    },
    clear: async () => {
      await step("clear");
    },
  };
  const hold = (name: string) => {
    const held = Promise.withResolvers<void>();
    holds.set(name, held);
    return () => held.resolve();
  };
  return { host, asked, state, hold };
}

const settle = () => Bun.sleep(10);

test("a stop that comes while a builder is brought back ends the builder it brought back", async () => {
  const { host, asked, state, hold } = fakeHost();
  const agent = supervisor("stop-during-bring-back");
  const letStart = hold("start");
  const back = agent.bringBack(host, () => true);
  await settle();
  const stop = agent.stop(() => agent.end(host));
  expect(agent.state().stopping).toBe(true);
  letStart();
  expect(await back).toBe("back");
  await stop;
  expect(asked).toEqual(["runs", "clear", "start", "stop"]);
  expect(state.running).toBe(false);
  expect(agent.state()).toEqual({
    seenRunning: false,
    stopping: false,
    removing: false,
    busy: false,
  });
});

test("a second stop joins the one under way rather than ending the builder again", async () => {
  const { host, asked } = fakeHost();
  const agent = supervisor("two-stops");
  await agent.start(host);
  const first = agent.stop(() => agent.end(host));
  const second = agent.stop(() => agent.end(host));
  expect(second).toBe(first);
  await second;
  expect(asked).toEqual(["start", "stop"]);
});

test("a removal that comes while a builder starts waits for it, and no poll takes it for ended", async () => {
  const { host, asked, state, hold } = fakeHost();
  const agent = supervisor("remove-during-start");
  const letStart = hold("start");
  const starting = agent.start(host);
  const removal = agent.remove(() => agent.end(host));
  expect(agent.state().removing).toBe(true);
  await expect(agent.remove(async () => {})).rejects.toThrow("under way already");
  expect(await agent.lookForEnd(host, () => true)).toBe(false);
  let removed = false;
  const ended = agent.removalEnded().then(() => {
    removed = true;
  });
  letStart();
  await starting;
  await removal;
  await ended;
  expect(removed).toBe(true);
  expect(asked).toEqual(["start", "stop"]);
  expect(state.running).toBe(false);
  expect(agent.state().removing).toBe(false);
});

test("a poll while the daemon brings a builder back waits for it, and takes nothing for ended", async () => {
  const { host, asked, hold } = fakeHost();
  const agent = supervisor("look-during-bring-back");
  const letStart = hold("start");
  const back = agent.bringBack(host, () => true);
  await settle();
  const look = agent.lookForEnd(host, () => true);
  letStart();
  await back;
  expect(await look).toBe(false);
  expect(asked).toEqual(["runs", "clear", "start", "runs"]);
});

test("a builder that never ran isn't taken for one that ended outside Skelcrew", async () => {
  const { host } = fakeHost();
  const agent = supervisor("never-ran");
  host.start = async () => {
    throw new Error("the builder exited as soon as it started");
  };
  await expect(agent.start(host)).rejects.toThrow("exited");
  expect(await agent.lookForEnd(host, () => true)).toBe(false);
});

test("a session that ends while the daemon restarts is found ended once it was seen running", async () => {
  const { host, state, hold } = fakeHost();
  const agent = supervisor("ends-during-restart");
  state.running = true;
  const letRuns = hold("runs");
  const back = agent.bringBack(host, () => true);
  await settle();
  const look = agent.lookForEnd(host, () => true);
  letRuns();
  expect(await back).toBe("back");
  expect(agent.state().seenRunning).toBe(true);
  state.running = false;
  expect(await look).toBe(true);
});

test("a host that can't be asked while bringing back is asked again, and a stop meanwhile wins", async () => {
  const { host, state } = fakeHost();
  const agent = supervisor("unreachable-host");
  state.reachable = false;
  const tries: unknown[] = [];
  let wanted = true;
  const back = agent.bringBack({ ...host, retry: (error) => tries.push(error) }, () => wanted);
  await settle();
  expect(tries).toHaveLength(1);
  wanted = false;
  expect(await back).toBe("not wanted");
  expect(tries).toHaveLength(1);
}, 10_000);

test("a host plugin that is gone brings nothing back and says why", async () => {
  const { host, asked } = fakeHost();
  const agent = supervisor("gone-host");
  expect(await agent.bringBack({ ...host, gone: () => "its host is gone" }, () => true)).toEqual({
    gone: "its host is gone",
  });
  expect(asked).toEqual([]);
});

test("a stop that comes while a restart ends the session keeps the builder ended", async () => {
  const { host, asked, state, hold } = fakeHost();
  const agent = supervisor("stop-during-restart");
  state.running = true;
  const letClear = hold("clear");
  const restart = agent.restart(host, () => true);
  await settle();
  const stop = agent.stop(() => agent.end(host));
  letClear();
  expect(await restart).toBe("stays ended");
  await stop;
  expect(asked).toEqual(["clear", "stop"]);
  expect(await agent.restart(host, () => true)).toEqual({ gone: null });
});

test("a restart is refused while a stop is under way", async () => {
  const { host, hold } = fakeHost();
  const agent = supervisor("restart-while-stopping");
  const letStop = hold("stop");
  const stop = agent.stop(() => agent.end(host));
  expect(await agent.restart(host, () => true)).toBe("refused");
  letStop();
  await stop;
});

test("a lead that exits while it is reopened is ended only after the reopening start is over", async () => {
  const { host, asked, state, hold } = fakeHost();
  const lead = supervisor("simon/app");
  const letStart = hold("start");
  const reopen = lead.start(host);
  expect(lead.state().busy).toBe(true);
  const exited = lead.end(host);
  letStart();
  await reopen;
  await exited;
  expect(asked).toEqual(["start", "stop"]);
  expect(state.running).toBe(false);
  expect(lead.state().busy).toBe(false);
});

test("nothing is typed into an agent from the moment its end is asked for", async () => {
  const { host, hold } = fakeHost();
  const agent = supervisor("hold-typing");
  const letStart = hold("start");
  const starting = agent.start(host);
  const held: string[] = [];
  const end = agent.end({
    ...host,
    hold: async (work) => {
      held.push("held");
      try {
        return await work();
      } finally {
        held.push("let go");
      }
    },
  });
  expect(held).toEqual(["held"]);
  letStart();
  await starting;
  await end;
  expect(held).toEqual(["held", "let go"]);
});

test("two bring backs at once start one builder", async () => {
  const { host, asked, hold } = fakeHost();
  const agent = supervisor("two-bring-backs");
  const letStart = hold("start");
  const first = agent.bringBack(host, () => true);
  const second = agent.bringBack(host, () => true);
  await settle();
  letStart();
  expect(await first).toBe("back");
  expect(await second).toBe("back");
  expect(asked).toEqual(["runs", "clear", "start", "runs"]);
});

test("a bring back no longer wanted once the old session is cleared starts nothing", async () => {
  const { host, asked, hold } = fakeHost();
  const agent = supervisor("unwanted-after-clear");
  const letClear = hold("clear");
  let wanted = true;
  const back = agent.bringBack(host, () => wanted);
  await settle();
  wanted = false;
  letClear();
  expect(await back).toBe("not wanted");
  expect(asked).toEqual(["runs", "clear"]);
});

test("a stop asked for while a bring back clears the old session wins, and nothing starts", async () => {
  const { host, asked, state, hold } = fakeHost();
  const agent = supervisor("stop-during-clear");
  const letClear = hold("clear");
  const back = agent.bringBack(host, () => true);
  await settle();
  const stop = agent.stop(() => agent.end(host));
  letClear();
  expect(await back).toBe("not wanted");
  await stop;
  expect(asked).toEqual(["runs", "clear", "stop"]);
  expect(state.running).toBe(false);
});

test("a bring back whose thread was stopped and started again while it waited leaves the new builder alone", async () => {
  const { host, asked, state, hold } = fakeHost();
  const agent = supervisor("stale-bring-back");
  const letStart = hold("start");
  const starting = agent.start(host);
  let started = 1;
  const stale = agent.bringBack(host, () => started === 1);
  started = 2;
  letStart();
  await starting;
  state.running = false;
  expect(await stale).toBe("not wanted");
  expect(asked).toEqual(["start"]);
});

test("a bring back whose thread changes while the host answers clears nothing", async () => {
  const { host, asked, hold } = fakeHost();
  const agent = supervisor("changed-while-asking");
  const letRuns = hold("runs");
  let wanted = true;
  const back = agent.bringBack(host, () => wanted);
  await settle();
  wanted = false;
  letRuns();
  expect(await back).toBe("not wanted");
  expect(asked).toEqual(["runs"]);
});

test("a host that fails a bring back no longer wanted fails nothing", async () => {
  const { host, state, hold } = fakeHost();
  const agent = supervisor("fails-when-unwanted");
  state.reachable = false;
  const letRuns = hold("runs");
  let wanted = true;
  const back = agent.bringBack(host, () => wanted);
  await settle();
  wanted = false;
  letRuns();
  expect(await back).toBe("not wanted");
});
