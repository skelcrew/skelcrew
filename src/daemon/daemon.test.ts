import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { localChecks } from "../checks/checks";
import { ProjectId, SessionId, TaskId } from "../core/ids";
import type { Config } from "../core/types";
import { Git } from "../plugins/git/git";
import type { VersionControl } from "../plugins/version-control";
import { git, makeRepo } from "../plugins/version-control.contract";
import type { Command } from "../protocol/protocol";
import { EventStore } from "../store/store";
import { backgroundSpecced, config as base, spec } from "../test/fixtures";
import { Daemon } from "./daemon";
import { FakeHarness, FakeRunner } from "./testing";

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

async function ok(daemon: Daemon, command: Command, from?: SessionId): Promise<unknown> {
  const answer = await daemon.handle(command, from);
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

// Claims task n and gives back the session name the claim printed.
async function claimedSession(daemon: Daemon, n: number): Promise<string> {
  const result = await ok(daemon, { type: "claim", task: task(n) });
  return z.object({ session: z.string() }).parse(result).session;
}
const you = (n: number) => SessionId.parse(`you-${n}`);

// A daemon whose store throws when saving a tool's reply, while
// `broken.replies` is on. Here the only reply is the failure that blocks
// a task. `broken.tries` counts the saves it refused.
function failingReplies(
  options: { retryMs: number; maxRetryMs: number },
  store = EventStore.open(":memory:"),
) {
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
    loadTaskEvents: store.loadTaskEvents.bind(store),
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

// Takes task 1 through Spec in your own session, so the next claim asks
// for a worktree. A spec from your claimed session needs no approval, so
// it is Ready at once. A claim in Spec needs a spec worktree, so this needs
// a daemon with git.
async function readyToClaim(daemon: Daemon) {
  await ok(daemon, add("CSV export"));
  await ok(daemon, { type: "claim", task: task(1) });
  await ok(daemon, { type: "submit", task: task(1), session: you(1), spec });
}

// Specs written by agents Skelcrew started, waiting for your approval, one
// task per title, numbered from 1.
function withBackgroundSpecs(...titles: string[]): EventStore {
  const store = EventStore.open(":memory:");
  titles.forEach((title, i) => {
    const saved = store.appendTask(
      backgroundSpecced(task(i + 1), title),
      {
        sent: [],
        answered: [],
      },
      [],
    );
    if (!saved.ok) throw new Error(saved.reason);
  });
  return store;
}

// Task 1 Ready without git: a background agent's spec, which you approve.
async function openReady<T extends { daemon: Daemon }>(open: (store: EventStore) => T): Promise<T> {
  const opened = open(withBackgroundSpecs("CSV export"));
  await ok(opened.daemon, { type: "approve", task: task(1) });
  return opened;
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

  // A spec is written in a copy of main, which only git can make.
  test("refuses a claim in Spec without git, and says why", async () => {
    const { daemon } = open();
    await ok(daemon, add("CSV export"));
    expect(await daemon.handle({ type: "claim", task: task(1) })).toEqual({
      ok: false,
      message:
        "The worktree couldn't be made: Making spec worktrees isn't built into the daemon yet.",
    });
  });

  test("approves a spec, or sends it back with your note", async () => {
    const { daemon } = open(withBackgroundSpecs("one", "two"));
    await ok(daemon, { type: "approve", task: task(1) });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "ready" }, { task: 2 }],
    });

    await ok(daemon, { type: "reject", task: task(2), note: "Add totals." });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1 }, { task: 2, phase: "spec", waitingOnYou: null }],
    });
  });

  test("reject refuses when nothing waits for your approval", async () => {
    const { daemon } = open();
    await ok(daemon, add("CSV export"));
    expect(await daemon.handle({ type: "reject", task: task(1), note: "Add totals." })).toEqual({
      ok: false,
      message: "#1 has nothing waiting for your approval.",
    });
    expect(await daemon.handle({ type: "reject", task: task(9), note: "Add totals." })).toEqual({
      ok: false,
      message: "#9 doesn't exist.",
    });
  });

  test("refuses an approval when nothing waits for one", async () => {
    const { daemon } = open();
    await ok(daemon, add("CSV export"));
    expect(await daemon.handle({ type: "approve", task: task(1) })).toEqual({
      ok: false,
      message: "#1 has nothing waiting for your approval.",
    });
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

  test("refuses to retry a task that isn't blocked, in the core's words", async () => {
    const { daemon } = open();
    await ok(daemon, add("CSV export"));
    expect(await daemon.handle({ type: "retry", task: task(1) })).toEqual({
      ok: false,
      message: "#1 isn't blocked.",
    });
  });

  test("refuses to retry a task that doesn't exist", async () => {
    const { daemon } = open();
    expect(await daemon.handle({ type: "retry", task: task(9) })).toEqual({
      ok: false,
      message: "#9 doesn't exist.",
    });
  });

  // Without git, a claim in Ready can't get its worktree. The core must
  // hear that at once, rather than wait for a worktree that never comes.
  test("answers a command it can't carry out yet with a failure, at once", async () => {
    const { daemon } = await openReady(open);
    // The claim waits for the worktree, so it hears why there is none.
    expect(await daemon.handle({ type: "claim", task: task(1) })).toEqual({
      ok: false,
      message: "The worktree couldn't be made: Making worktrees isn't built into the daemon yet.",
    });
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
      loadTaskEvents: store.loadTaskEvents.bind(store),
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
    const { daemon, store, broken } = await openReady((seeded) =>
      failingReplies({ retryMs: 1, maxRetryMs: 5 }, seeded),
    );

    // Claiming in Ready asks for a worktree. Without git its reply is a
    // failure that blocks the task, and saving that reply now throws. The
    // claim waits for that reply, so it gets its answer only once it saves.
    broken.replies = true;
    const claim = daemon.handle({ type: "claim", task: task(1) });
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
    expect(await claim).toEqual({
      ok: false,
      message: "The worktree couldn't be made: Making worktrees isn't built into the daemon yet.",
    });
    await daemon.close();
  });

  test("once closed, sends no more replies and refuses requests", async () => {
    const { daemon, broken } = await openReady((seeded) =>
      failingReplies({ retryMs: 1, maxRetryMs: 5 }, seeded),
    );
    broken.replies = true;
    const claim = daemon.handle({ type: "claim", task: task(1) });
    await Bun.sleep(20);
    await daemon.close();
    // A claim still waiting for its worktree hears the daemon has closed.
    expect(await claim).toEqual({ ok: false, message: "The daemon is shutting down." });
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
    const { daemon, store } = await openReady(open);
    // Without git, the claim's worktree fails, and that reply is handled.
    expect((await daemon.handle({ type: "claim", task: task(1) })).ok).toBe(false);
    expect(store.loadCommands()).toEqual({ ok: true, commands: [] });
  });

  // A reply still unsaved when the daemon closes is left behind. Its
  // command then stays, and goes out again when the daemon next starts.
  test("keeps a command whose reply wasn't saved before closing, for the next start", async () => {
    const {
      daemon: first,
      store,
      broken,
    } = await openReady((seeded) => failingReplies({ retryMs: 1, maxRetryMs: 5 }, seeded));
    broken.replies = true;
    const claim = first.handle({ type: "claim", task: task(1) });
    await Bun.sleep(20);
    await first.close();
    expect(await claim).toEqual({ ok: false, message: "The daemon is shutting down." });
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

// There is no project command yet, so a test makes its project straight in
// the store, the way `skelcrew project add` will.
function withProject(id: string): EventStore {
  const store = EventStore.open(":memory:");
  const saved = store.appendProject([
    {
      v: 1,
      type: "project.created",
      projectId: ProjectId.parse(id),
      at: 1,
      name: id,
      goal: "Export reports as CSV and PDF.",
    },
  ]);
  if (!saved.ok) throw new Error(saved.reason);
  return store;
}

describe("log", () => {
  test("refuses a task that doesn't exist", async () => {
    const { daemon } = open();
    expect(await daemon.handle({ type: "log", task: task(9) })).toEqual({
      ok: false,
      message: "#9 doesn't exist.",
    });
  });
});

// Every request from an agent's CLI carries its session, from
// SKELCREW_SESSION. Only the developer approves, sends work back, claims or
// changes tasks, so those are refused from an agent. Not a lock: an agent
// that removes the variable looks like the developer (see the spec's open
// questions).
describe("an agent's identity", () => {
  const agent = SessionId.parse("agent-1");
  // #1's background spec agent, agent-1, is running.
  const withRunningAgent = () => {
    const store = EventStore.open(":memory:");
    const saved = store.appendTask(
      backgroundSpecced(task(1), "CSV export").slice(0, 5),
      { sent: [], answered: [] },
      [],
    );
    if (!saved.ok) throw new Error(saved.reason);
    return store;
  };

  test("refuses the developer's commands from an agent, and says how to run them yourself", async () => {
    const { daemon } = open(withBackgroundSpecs("CSV export"));
    expect(await daemon.handle({ type: "approve", task: task(1) }, agent)).toEqual({
      ok: false,
      message:
        "Only the developer can approve. This call came from agent-1, an agent's session. If you are the developer, unset SKELCREW_SESSION and run it again.",
    });
    const theirs: Command[] = [
      { type: "reject", task: task(1), note: "Add totals." },
      { type: "spec", task: task(1) },
      { type: "drop", task: task(1) },
      { type: "retry", task: task(1) },
      { type: "claim", task: task(1) },
      { type: "answer", task: task(1), text: "No" },
      add("PDF export"),
      { type: "project_new", name: "Reports", goal: "Export what the page shows." },
      { type: "project_add", task: task(1), project: "reports" },
      { type: "project_remove", task: task(1) },
      { type: "project_archive", project: "reports" },
      { type: "project_unarchive", project: "reports" },
    ];
    for (const command of theirs) {
      const answer = await daemon.handle(command, agent);
      expect(answer.ok).toBe(false);
      expect(!answer.ok && answer.message).toStartWith("Only the developer can ");
    }
    // Nothing changed: the spec still waits for your approval.
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, waitingOnYou: "spec_approval" }],
    });
  });

  test("lets an agent read the status and a task's log", async () => {
    const { daemon } = open(withBackgroundSpecs("CSV export"));
    expect((await daemon.handle({ type: "status" }, agent)).ok).toBe(true);
    expect((await daemon.handle({ type: "log", task: task(1) }, agent)).ok).toBe(true);
  });

  test("lets an agent ask you a question, which waits for your answer", async () => {
    const { daemon } = open(withRunningAgent());
    const question: Command = {
      type: "ask",
      task: task(1),
      session: agent,
      text: "Include deleted rows?",
      options: ["Yes", "No"],
    };
    expect(await daemon.handle(question, agent)).toEqual({ ok: true, result: {} });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, waitingOnYou: "answer", question: "Include deleted rows?" }],
    });

    expect(await ok(daemon, { type: "answer", task: task(1), text: "No" })).toEqual({});
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, waitingOnYou: null }],
    });
  });

  test("passes on the core's refusal of a question without two to four options", async () => {
    const { daemon } = open(withRunningAgent());
    const question: Command = {
      type: "ask",
      task: task(1),
      session: agent,
      text: "Include deleted rows?",
      options: ["Yes"],
    };
    expect(await daemon.handle(question, agent)).toEqual({
      ok: false,
      message: "A question needs two to four options.",
    });
  });
});

describe("status", () => {
  test("says which project each task is in, or none", async () => {
    const { daemon } = open(withProject("reports"));
    await ok(daemon, { type: "add", title: "CSV export", spec: false, project: "reports" });
    await ok(daemon, add("Totals", false));
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [
        { task: 1, title: "CSV export", project: "reports" },
        { task: 2, title: "Totals", project: null },
      ],
    });
  });

  // The daemon can't start agents yet, so the agent's end is written into
  // the store, the way a runner's report will block the task.
  test("says when an agent stopped before it finished, with its exit code if known", async () => {
    const store = EventStore.open(":memory:");
    for (const [n, exitCode] of [
      [1, 137],
      [2, null],
    ] as const) {
      const id = task(n);
      const stamp = { v: 1 as const, taskId: id, at: 1 };
      const saved = store.appendTask(
        [
          // Up to its running spec agent.
          ...backgroundSpecced(id, `Task ${n}`).slice(0, 5),
          {
            ...stamp,
            type: "task.blocked",
            reason: { kind: "agent_stopped", exitCode, message: "Out of memory." },
          },
        ],
        { sent: [], answered: [] },
        [],
      );
      if (!saved.ok) throw new Error(saved.reason);
    }
    const { daemon } = open(store);
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [
        {
          task: 1,
          blocked: "The agent stopped before it finished (exit code 137): Out of memory.",
        },
        { task: 2, blocked: "The agent stopped before it finished: Out of memory." },
      ],
    });
  });
});

describe("projects", () => {
  const reports: Command = {
    type: "project_new",
    name: "Reports page",
    goal: "Export what the reports page shows.",
  };

  test("a new project gets an ID made from its name, and starts active", async () => {
    const { daemon } = open();
    expect(await ok(daemon, reports)).toEqual({
      project: { id: "reports-page", name: "Reports page" },
    });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      projects: [
        {
          id: "reports-page",
          name: "Reports page",
          goal: "Export what the reports page shows.",
          status: "active",
        },
      ],
    });
  });

  test("a name with accents gets an ID without them", async () => {
    const { daemon } = open();
    expect(await ok(daemon, { ...reports, name: "Søg på café" })).toEqual({
      project: { id: "sog-pa-cafe", name: "Søg på café" },
    });
  });

  test("a name with no letters or digits is refused", async () => {
    const { daemon } = open();
    expect(await daemon.handle({ ...reports, name: "!!!" })).toEqual({
      ok: false,
      message: '"!!!" has no letters or digits, so it can\'t name a project.',
    });
  });

  test("a second project with the same ID is refused", async () => {
    const { daemon } = open();
    await ok(daemon, reports);
    expect(await daemon.handle({ ...reports, name: "reports PAGE" })).toEqual({
      ok: false,
      message: "There is already a project called reports-page.",
    });
  });

  test("archive and unarchive take the name or the ID, and status says which it is", async () => {
    const { daemon } = open();
    await ok(daemon, reports);
    expect(await ok(daemon, { type: "project_archive", project: "Reports Page" })).toEqual({
      project: { id: "reports-page", name: "Reports page" },
    });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      projects: [{ id: "reports-page", status: "archived" }],
    });
    await ok(daemon, { type: "project_unarchive", project: "reports-page" });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      projects: [{ id: "reports-page", status: "active" }],
    });
  });

  test("a project that doesn't exist is refused", async () => {
    const { daemon } = open();
    expect(await daemon.handle({ type: "project_archive", project: "Search" })).toEqual({
      ok: false,
      message: "There is no project called Search.",
    });
    await ok(daemon, add("CSV export"));
    expect(await daemon.handle({ type: "project_add", task: task(1), project: "!!!" })).toEqual({
      ok: false,
      message: "There is no project called !!!.",
    });
  });

  test("add puts a task in a project, and says which one it came from", async () => {
    const { daemon } = open();
    await ok(daemon, reports);
    await ok(daemon, { type: "project_new", name: "Search", goal: "Find any task." });
    await ok(daemon, add("CSV export"));
    expect(
      await ok(daemon, { type: "project_add", task: task(1), project: "Reports page" }),
    ).toEqual({ from: null, to: { id: "reports-page", name: "Reports page" } });
    expect(await ok(daemon, { type: "project_add", task: task(1), project: "search" })).toEqual({
      from: { id: "reports-page", name: "Reports page" },
      to: { id: "search", name: "Search" },
    });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, project: "search" }],
    });
  });

  test("adding a task to the project it is in records nothing", async () => {
    const { daemon } = open();
    await ok(daemon, reports);
    await ok(daemon, add("CSV export"));
    await ok(daemon, { type: "project_add", task: task(1), project: "reports-page" });
    const same = { from: { id: "reports-page", name: "Reports page" } };
    expect(
      await ok(daemon, { type: "project_add", task: task(1), project: "reports-page" }),
    ).toEqual({ ...same, to: same.from });
    const log = z
      .object({ events: z.array(z.object({ type: z.string() })) })
      .parse(await ok(daemon, { type: "log", task: task(1) }));
    expect(log.events.filter((event) => event.type === "task.project_changed")).toHaveLength(1);
  });

  test("remove takes a task out of its project, and refuses a task in none", async () => {
    const { daemon } = open();
    await ok(daemon, reports);
    await ok(daemon, add("CSV export"));
    await ok(daemon, { type: "project_add", task: task(1), project: "reports-page" });
    expect(await ok(daemon, { type: "project_remove", task: task(1) })).toEqual({
      from: { id: "reports-page", name: "Reports page" },
    });
    expect(await daemon.handle({ type: "project_remove", task: task(1) })).toEqual({
      ok: false,
      message: "#1 isn't in a project.",
    });
  });

  test("a new task can be added to a project by its name", async () => {
    const { daemon } = open();
    await ok(daemon, reports);
    await ok(daemon, { type: "add", title: "CSV export", spec: false, project: "Reports page" });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, project: "reports-page" }],
    });
  });

  test("status lists every project by name, even one with no tasks", async () => {
    const { daemon } = open();
    await ok(daemon, reports);
    await ok(daemon, { type: "project_new", name: "Archive search", goal: "Find old work." });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      projects: [{ name: "Archive search" }, { name: "Reports page" }],
    });
  });
});

describe("the daemon with git", () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function newRepo() {
    const repo = await makeRepo();
    repos.push(repo.dir);
    return repo;
  }

  // A daemon for a real repository. Its local gate runs `checks`, or only
  // `true`. Sessions are numbered, unless `namedSessions` asks for the
  // daemon's own names.
  type InRepo = {
    versionControl?: VersionControl;
    store?: EventStore;
    checks?: string[];
    maxAttempts?: number;
    maxRunning?: number;
    namedSessions?: boolean;
    // Starts agents itself, through this runner and a fake harness.
    runner?: FakeRunner;
  };

  async function inRepo(repo?: Awaited<ReturnType<typeof makeRepo>>, options: InRepo = {}) {
    repo ??= await newRepo();
    const store = options.store ?? EventStore.open(":memory:");
    let sessions = 0;
    const numbered = () => {
      sessions += 1;
      return `you-${sessions}`;
    };
    const opened = Daemon.open({
      // Every path critical, as `skelcrew init` writes it.
      config: {
        ...config,
        criticalPaths: ["**"],
        maxAttempts: options.maxAttempts ?? 3,
        maxRunning: options.maxRunning ?? config.maxRunning,
      },
      log: store,
      versionControl: options.versionControl ?? new Git(repo.dir, repo.main),
      runChecks: localChecks(options.checks ?? ["true"]),
      ...(options.namedSessions === true ? {} : { newSession: numbered }),
      ...(options.runner === undefined
        ? {}
        : {
            agents: {
              runner: options.runner,
              harness: new FakeHarness(),
              log: store,
              checks: options.checks ?? ["true"],
            },
          }),
    });
    if (!opened.ok) throw new Error(opened.message);
    return { daemon: opened.value, repo, store };
  }

  // The same, with task 1 Ready.
  async function readyInRepo(repo?: Awaited<ReturnType<typeof makeRepo>>, options: InRepo = {}) {
    const opened = await inRepo(repo, options);
    await readyToClaim(opened.daemon);
    return opened;
  }

  // Every spec is written in a copy of main of its own, so two specs never
  // see each other's files.
  // Waits until the check passes, for at most five seconds.
  async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await Bun.sleep(50);
    }
    throw new Error("It didn't happen within five seconds.");
  }

  // Background runs: the daemon starts agents itself, through a runner and
  // a harness. Here both are fakes, so no real agent ever starts.
  async function withAgent() {
    const runner = new FakeRunner();
    const opened = await inRepo(undefined, { runner });
    await ok(opened.daemon, add("CSV export"));
    await eventually(() => runner.started.length === 1);
    const started = runner.started[0];
    if (started === undefined) throw new Error("No agent started.");
    return { ...opened, runner, agent: SessionId.parse(started.name) };
  }

  const statusOf = async (daemon: Daemon) =>
    z
      .object({ tasks: z.array(z.object({ session: z.string().nullable() }).passthrough()) })
      .parse(await ok(daemon, { type: "status" }));

  test("starts a spec agent in its spec worktree for a task that waits for a spec", async () => {
    const { daemon, repo, runner, agent } = await withAgent();
    expect(runner.started[0]).toMatchObject({
      command: ["fake-agent", "spec", "1"],
      cwd: join(repo.dir, ".skelcrew", "spec-worktrees", "1-csv-export"),
      env: { SKELCREW_SESSION: agent },
    });
    expect((await statusOf(daemon)).tasks[0]).toMatchObject({ session: agent, phase: "spec" });
  });

  test("types your answer into the agent's session", async () => {
    const { daemon, runner, agent } = await withAgent();
    const question: Command = {
      type: "ask",
      task: task(1),
      session: agent,
      text: "Include deleted rows?",
      options: ["Yes", "No"],
    };
    await ok(daemon, question);
    await ok(daemon, { type: "answer", task: task(1), text: "No" });
    await eventually(() => runner.typed.length === 1);
    expect(runner.typed).toEqual([{ name: agent, text: "No" }]);
  });

  test("blocks the task when its agent's session ends before it reports", async () => {
    const { daemon, runner, agent } = await withAgent();
    runner.end(agent, { exitCode: 1, lastLine: "Out of memory." });
    const blocked = "The agent stopped before it finished (exit code 1): Out of memory.";
    await eventually(async () => (await statusOf(daemon)).tasks[0]?.blocked === blocked);
  });

  test("stops the agent, and removes its spec worktree, once it submits the spec", async () => {
    const { daemon, repo, runner, agent } = await withAgent();
    await ok(daemon, { type: "submit", task: task(1), session: agent, spec }, agent);
    await eventually(() => runner.stopped.includes(agent));
    const copy = join(repo.dir, ".skelcrew", "spec-worktrees", "1-csv-export");
    await eventually(() => !existsSync(copy));
    expect((await statusOf(daemon)).tasks[0]).toMatchObject({ waitingOnYou: "spec_approval" });
  });

  // The basic runner's sessions end with the daemon. After a restart, the
  // core must hear that its agents are gone.
  test("after a restart, says an agent the runner lost has stopped", async () => {
    const { daemon, repo, store } = await withAgent();
    await daemon.close();
    const after = await inRepo(repo, { store, runner: new FakeRunner() });
    const blocked =
      "The agent stopped before it finished: Skelcrew restarted, and the agent's session ended with it.";
    await eventually(async () => (await statusOf(after.daemon)).tasks[0]?.blocked === blocked);
  });

  test("makes a spec worktree when you claim a task in Spec, and says where to work", async () => {
    const { daemon, repo } = await inRepo();
    await ok(daemon, add("CSV export"));
    const path = join(repo.dir, ".skelcrew", "spec-worktrees", "1-csv-export");
    expect(await ok(daemon, { type: "claim", task: task(1) })).toEqual({
      session: "you-1",
      phase: "spec",
      worktree: { path },
      spec: null,
      note: null,
    });
    expect(existsSync(join(path, "README.md"))).toBe(true);
  });

  test("hears only your session in Spec, and your spec is Ready at once", async () => {
    const { daemon } = await inRepo();
    await ok(daemon, add("CSV export"));
    await ok(daemon, { type: "claim", task: task(1) });
    const stranger = await daemon.handle({
      type: "submit",
      task: task(1),
      session: SessionId.parse("someone"),
      spec,
    });
    expect(stranger.ok).toBe(false);
    await ok(daemon, { type: "submit", task: task(1), session: you(1), spec });
    // A spec from your claimed session needs no approval.
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, title: "CSV export", phase: "ready", waitingOnYou: null }],
    });
  });

  test("removes the spec worktree once your spec is submitted", async () => {
    const { daemon, repo } = await inRepo();
    await ok(daemon, add("CSV export"));
    await ok(daemon, { type: "claim", task: task(1) });
    await ok(daemon, { type: "submit", task: task(1), session: you(1), spec });
    await Bun.sleep(100);
    expect(existsSync(join(repo.dir, ".skelcrew", "spec-worktrees", "1-csv-export"))).toBe(false);
  });

  test("reject sends a spec back to Spec with your note", async () => {
    const { daemon } = await inRepo(undefined, { store: withBackgroundSpecs("CSV export") });
    expect(await ok(daemon, { type: "reject", task: task(1), note: "Add totals." })).toEqual({
      phase: "spec",
    });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "spec", waitingOnYou: null }],
    });
    expect(await ok(daemon, { type: "claim", task: task(1) })).toMatchObject({
      note: "Add totals.",
    });
  });

  test("says in status which session is working on each task", async () => {
    const { daemon } = await inRepo();
    await ok(daemon, add("CSV export"));
    await ok(daemon, add("PDF export"));
    await ok(daemon, { type: "claim", task: task(1) });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [
        { task: 1, session: "you-1" },
        { task: 2, session: null },
      ],
    });
  });

  test("refuses a claim when no slot is free", async () => {
    const { daemon } = await inRepo();
    await ok(daemon, add("one"));
    await ok(daemon, add("two"));
    await ok(daemon, { type: "claim", task: task(1) });
    const second = await daemon.handle({ type: "claim", task: task(2) });
    expect(second.ok).toBe(false);
  });

  // Found in the first real run: "session-e41c254c-3354-4fa3-b176-ad7aba45064c
  // is working on it" was too long to read.
  test("names each claimed session short and different", async () => {
    const { daemon } = await inRepo(undefined, { maxRunning: 2, namedSessions: true });
    await ok(daemon, add("CSV export"));
    await ok(daemon, add("PDF export"));
    const first = await claimedSession(daemon, 1);
    const second = await claimedSession(daemon, 2);
    expect(first).toMatch(/^session-[a-z0-9]{8}$/);
    expect(second).toMatch(/^session-[a-z0-9]{8}$/);
    expect(second).not.toBe(first);
  });

  test("log answers with a task's events, oldest first", async () => {
    const { daemon, repo } = await inRepo();
    await ok(daemon, add("CSV export"));
    await ok(daemon, add("PDF export"));
    await ok(daemon, { type: "claim", task: task(1) });
    const path = join(repo.dir, ".skelcrew", "spec-worktrees", "1-csv-export");
    expect(await ok(daemon, { type: "log", task: task(1) })).toMatchObject({
      events: [
        { type: "task.created", taskId: 1, title: "CSV export" },
        { type: "task.spec_requested", taskId: 1 },
        { type: "task.claimed", taskId: 1, session: "you-1" },
        { type: "task.spec_worktree_created", taskId: 1, worktree: { path } },
      ],
      leftOut: 0,
    });
  });

  test("makes a worktree when you claim a task in Ready, and says where to work", async () => {
    const { daemon, repo } = await readyInRepo();
    const result = await ok(daemon, { type: "claim", task: task(1) });
    const path = join(repo.dir, ".skelcrew", "worktrees", "1-csv-export");
    expect(result).toEqual({
      session: "you-2",
      phase: "in_progress",
      worktree: { path, branch: "task/1-csv-export" },
      spec,
    });
    expect(await git(path, "branch", "--show-current")).toBe("task/1-csv-export");
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "in_progress", step: "running", blocked: null }],
    });
  });

  // Found by review: at start-up, the daemon sent unfinished commands out
  // before it could look up titles. A worktree cut off by a restart was
  // made again on a branch named "task/1-1", beside the first.
  test("makes a worktree cut off by a restart again, on the same branch", async () => {
    const repo = await newRepo();
    const store = EventStore.open(":memory:");
    // Makes the worktree, then never answers, as if the daemon stopped.
    const real = new Git(repo.dir, repo.main);
    const cutOff: VersionControl = {
      createWorktree: async (request) => {
        await real.createWorktree(request);
        return new Promise(() => {});
      },
      readBranch: (worktree) => real.readBranch(worktree),
      merge: (request, runChecks) => real.merge(request, runChecks),
      revert: (request) => real.revert(request),
      removeWorktree: (worktree) => real.removeWorktree(worktree),
      checkCommit: (request, runChecks) => real.checkCommit(request, runChecks),
      uncommittedOnMain: () => real.uncommittedOnMain(),
      createSpecWorktree: (request) => real.createSpecWorktree(request),
      removeSpecWorktree: (worktree) => real.removeSpecWorktree(worktree),
    };
    const first = await readyInRepo(repo, { versionControl: cutOff, store });
    void first.daemon.handle({ type: "claim", task: task(1) });
    await Bun.sleep(300);
    await first.daemon.close();

    const second = Daemon.open({ config, log: store, versionControl: real });
    if (!second.ok) throw new Error(second.message);
    await Bun.sleep(300);
    expect(await git(repo.dir, "branch", "--list", "task/*", "--format=%(refname:short)")).toBe(
      "task/1-csv-export",
    );
    expect(await ok(second.value, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "in_progress", step: "running", blocked: null }],
    });
  });

  // Found by review: a claim waiting for its worktree only looked again
  // after a tool's reply. Dropped meanwhile, it waited for git, then said
  // "Claimed".
  test("tells a waiting claim at once that its task was dropped", async () => {
    const repo = await newRepo();
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = new Git(repo.dir, repo.main);
    const held: VersionControl = {
      createWorktree: async (request) => {
        await released;
        return real.createWorktree(request);
      },
      readBranch: (worktree) => real.readBranch(worktree),
      merge: (request, runChecks) => real.merge(request, runChecks),
      revert: (request) => real.revert(request),
      removeWorktree: (worktree) => real.removeWorktree(worktree),
      checkCommit: (request, runChecks) => real.checkCommit(request, runChecks),
      uncommittedOnMain: () => real.uncommittedOnMain(),
      createSpecWorktree: (request) => real.createSpecWorktree(request),
      removeSpecWorktree: (worktree) => real.removeSpecWorktree(worktree),
    };
    const { daemon } = await readyInRepo(repo, { versionControl: held });
    const claim = daemon.handle({ type: "claim", task: task(1) });
    await Bun.sleep(50);
    await ok(daemon, { type: "drop", task: task(1) });
    const answer = await Promise.race([claim, Bun.sleep(200).then(() => "still waiting")]);
    release();
    expect(answer).toEqual({
      ok: false,
      message: "#1 was dropped before its worktree was made.",
    });
  });

  // Found by review: the daemon made worktrees but never removed them, so
  // a dropped task's folder stayed.
  test("removes a dropped task's worktree", async () => {
    const { daemon, repo } = await readyInRepo();
    await ok(daemon, { type: "claim", task: task(1) });
    const path = join(repo.dir, ".skelcrew", "worktrees", "1-csv-export");
    expect(existsSync(path)).toBe(true);
    await ok(daemon, { type: "drop", task: task(1) });
    await Bun.sleep(300);
    expect(existsSync(path)).toBe(false);
  });

  // Claims task 1 and commits a file in its worktree, as an agent would.
  async function claimedWithWork(daemon: Daemon): Promise<string> {
    const claim = z
      .object({ worktree: z.object({ path: z.string() }) })
      .parse(await ok(daemon, { type: "claim", task: task(1) }));
    const path = claim.worktree.path;
    writeFileSync(join(path, "export.csv"), "a,b\n");
    await git(path, "add", "export.csv");
    await git(
      path,
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=a@a",
      "commit",
      "-q",
      "-m",
      "Export",
    );
    return path;
  }

  // Task 1's claim in Ready is the second session named.
  const done = (session = you(2)): Command => ({ type: "done", task: task(1), session });

  test("done runs the checks on your branch, and says they passed", async () => {
    const { daemon } = await readyInRepo();
    await claimedWithWork(daemon);
    expect(await ok(daemon, done())).toEqual({ passed: true });
    // Every path is critical, so the merge waits for you.
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "checks", waitingOnYou: "merge_approval" }],
    });
  });

  test("done says why the checks failed, and the task goes back to its agent", async () => {
    const { daemon } = await readyInRepo(undefined, {
      checks: ["echo 'expected 1 got 2'; exit 1"],
    });
    await claimedWithWork(daemon);
    const answer = z
      .object({ passed: z.literal(false), summary: z.string() })
      .parse(await ok(daemon, done()));
    expect(answer.summary).toContain("expected 1 got 2");
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "in_progress", step: "running", blocked: null }],
    });
  });

  // Found by review: the checks ran in the agent's own worktree, so an
  // edit made while they ran was checked instead of the commit.
  test("done checks the commit, even if the agent edits while the checks run", async () => {
    const { daemon } = await readyInRepo(undefined, {
      checks: ["sleep 0.5; grep -q 'a,b' export.csv"],
    });
    const path = await claimedWithWork(daemon);
    const answer = daemon.handle(done());
    await Bun.sleep(200);
    writeFileSync(join(path, "export.csv"), "BROKEN\n");
    expect(await answer).toEqual({ ok: true, result: { passed: true } });
  });

  // Found by review: a check that wrote a file, such as a coverage
  // report, left "uncommitted changes" behind, so done always failed.
  test("done passes a check that writes a file", async () => {
    const { daemon } = await readyInRepo(undefined, { checks: ["echo 95% > coverage.txt"] });
    const path = await claimedWithWork(daemon);
    expect(await ok(daemon, done())).toEqual({ passed: true });
    expect(existsSync(join(path, "coverage.txt"))).toBe(false);
  });

  // Found by review: a second done while the checks ran was refused as
  // "isn't in In progress", though the work was being checked.
  test("done while the checks are already running waits for their result", async () => {
    const { daemon } = await readyInRepo(undefined, { checks: ["sleep 0.5"] });
    await claimedWithWork(daemon);
    const first = daemon.handle(done());
    await Bun.sleep(100);
    expect(await daemon.handle(done())).toEqual({ ok: true, result: { passed: true } });
    expect(await first).toEqual({ ok: true, result: { passed: true } });
  });

  // Found by review: after a restart, the checks ran again, but the agent
  // couldn't hear the result.
  test("done after a restart waits for the checks that run again", async () => {
    const repo = await newRepo();
    const store = EventStore.open(":memory:");
    const first = await readyInRepo(repo, { store, checks: ["sleep 5"] });
    await claimedWithWork(first.daemon);
    const cut = first.daemon.handle(done());
    await Bun.sleep(300);
    await first.daemon.close();
    expect(await cut).toEqual({ ok: false, message: "The daemon is shutting down." });

    const second = Daemon.open({
      config: { ...config, criticalPaths: ["**"] },
      log: store,
      versionControl: new Git(repo.dir, repo.main),
      runChecks: localChecks(["true"]),
    });
    if (!second.ok) throw new Error(second.message);
    expect(await second.value.handle(done())).toEqual({ ok: true, result: { passed: true } });
  });

  test("done from another session is refused before anything is read", async () => {
    const { daemon } = await readyInRepo();
    const path = await claimedWithWork(daemon);
    writeFileSync(join(path, "draft.txt"), "not yet\n");
    expect(await daemon.handle(done(you(9)))).toEqual({
      ok: false,
      message: "#1's agent isn't you-9.",
    });
  });

  test("done says so when the task is dropped while its checks run", async () => {
    const { daemon } = await readyInRepo(undefined, { checks: ["sleep 1"] });
    await claimedWithWork(daemon);
    const answer = daemon.handle(done());
    await Bun.sleep(200);
    await ok(daemon, { type: "drop", task: task(1) });
    expect(await answer).toEqual({ ok: false, message: "#1 was dropped while its checks ran." });
  });

  // Found by review: a check kept running after the daemon stopped, and
  // could overlap with the same check run again at the next start.
  test("closing the daemon stops a check that is running", async () => {
    const marker = join(await newRepo().then((r) => r.dir), "finished.txt");
    const { daemon } = await readyInRepo(undefined, { checks: [`sleep 1; touch ${marker}`] });
    await claimedWithWork(daemon);
    void daemon.handle(done());
    await Bun.sleep(300);
    await daemon.close();
    await Bun.sleep(1_200);
    expect(existsSync(marker)).toBe(false);
  });

  test("approving a merge merges the task into main, and says as which commit", async () => {
    const { daemon, repo } = await readyInRepo();
    await claimedWithWork(daemon);
    await ok(daemon, done());
    const answer = z
      .object({ merged: z.literal(true), commit: z.string() })
      .parse(await ok(daemon, { type: "approve", task: task(1) }));
    expect(await git(repo.dir, "rev-parse", "main")).toBe(answer.commit);
    expect(await git(repo.dir, "show", "main:export.csv")).toBe("a,b");
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "done" }],
    });
  });

  test("reject sends a merge back to In progress with your note, and merges nothing", async () => {
    const { daemon, repo } = await readyInRepo();
    await claimedWithWork(daemon);
    await ok(daemon, done());
    const main = await git(repo.dir, "rev-parse", "main");
    expect(await ok(daemon, { type: "reject", task: task(1), note: "Add totals." })).toEqual({
      phase: "in_progress",
    });
    expect(await git(repo.dir, "rev-parse", "main")).toBe(main);
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "in_progress", waitingOnYou: null }],
    });
  });

  // Decided with the developer: the approved spec lands with the work, in
  // the one commit on main. Skelcrew writes it at merge time, so the
  // agent's branch never holds it and the agent can't change it.
  const specPath = "docs/specs/1-csv-export.md";
  const specText = [
    "# #1 CSV export",
    "",
    "The spec task #1 was built from.",
    "",
    "## Scope",
    "",
    "Add a CSV export button to the reports page.",
    "",
    "## Acceptance criteria",
    "",
    "- Clicking Export downloads a CSV of the visible rows.",
    "",
  ].join("\n");

  test("approving a merge lands the task's spec with its work, and not on its branch", async () => {
    const { daemon, repo } = await readyInRepo();
    await claimedWithWork(daemon);
    await ok(daemon, done());
    const answer = z
      .object({ merged: z.literal(true), commit: z.string() })
      .parse(await ok(daemon, { type: "approve", task: task(1) }));
    expect(await git(repo.dir, "rev-parse", "main")).toBe(answer.commit);
    expect(await git(repo.dir, "show", `main:${specPath}`)).toBe(specText.trim());
    expect(await git(repo.dir, "show", "main:export.csv")).toBe("a,b");
    expect(await git(repo.dir, "ls-tree", "-r", "--name-only", "task/1-csv-export")).not.toContain(
      specPath,
    );
  });

  test("approving a merge replaces an older spec on main at the same path", async () => {
    const { daemon, repo } = await readyInRepo();
    mkdirSync(join(repo.dir, "docs", "specs"), { recursive: true });
    writeFileSync(join(repo.dir, specPath), "# #1 An earlier build's spec\n");
    await git(repo.dir, "add", specPath);
    await git(repo.dir, "commit", "-q", "-m", "An earlier build");
    await claimedWithWork(daemon);
    await ok(daemon, done());
    await ok(daemon, { type: "approve", task: task(1) });
    expect(await git(repo.dir, "show", `main:${specPath}`)).toBe(specText.trim());
  });

  test("approving a merge leaves the same spec already on main as it is", async () => {
    const { daemon, repo } = await readyInRepo();
    mkdirSync(join(repo.dir, "docs", "specs"), { recursive: true });
    writeFileSync(join(repo.dir, specPath), specText);
    await git(repo.dir, "add", specPath);
    await git(repo.dir, "commit", "-q", "-m", "The same spec");
    await claimedWithWork(daemon);
    await ok(daemon, done());
    await ok(daemon, { type: "approve", task: task(1) });
    expect(await git(repo.dir, "diff", "--name-only", "main^", "main")).toBe("export.csv");
  });

  test("approving a merge that fails says why, and the task goes back to its agent", async () => {
    const { daemon, repo } = await readyInRepo();
    await claimedWithWork(daemon);
    await ok(daemon, done());
    await conflictOnMain(repo.dir);
    const answer = z
      .object({ merged: z.literal(false), summary: z.string() })
      .parse(await ok(daemon, { type: "approve", task: task(1) }));
    expect(answer.summary).toContain("conflicts");
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "in_progress" }],
    });
  });

  // Main gets its own export.csv, so the task's merge conflicts with it.
  async function conflictOnMain(dir: string) {
    writeFileSync(join(dir, "export.csv"), "x,y\n");
    await git(dir, "add", "export.csv");
    await git(dir, "commit", "-q", "-m", "Theirs");
  }

  // Decided with the developer: your own edits in your checkout of main
  // would stop the merge, through no fault of the task's work. So the
  // approval is refused first, and the task keeps waiting for it.
  test("refuses to approve a merge while your checkout of main has uncommitted edits", async () => {
    const { daemon, repo } = await readyInRepo();
    await claimedWithWork(daemon);
    await ok(daemon, done());
    writeFileSync(join(repo.dir, "README.md"), "# Mine, not committed\n");
    expect(await daemon.handle({ type: "approve", task: task(1) })).toEqual({
      ok: false,
      message:
        "Your checkout of main has uncommitted changes in README.md. Commit or stash them, then approve again. Nothing was merged.",
    });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, waitingOnYou: "merge_approval" }],
    });
  });

  // Found by review: after a failed merge, the next claim didn't say why
  // the task was back.
  test("a claim after a failed merge says why the task is back", async () => {
    const { daemon, repo } = await readyInRepo();
    await claimedWithWork(daemon);
    await ok(daemon, done());
    await conflictOnMain(repo.dir);
    await ok(daemon, { type: "approve", task: task(1) });
    const claim = z
      .object({ failure: z.string() })
      .parse(await ok(daemon, { type: "claim", task: task(1) }));
    expect(claim.failure).toContain("conflicts");
  });

  // Found by review: a second approve while the merge ran was refused, so
  // after a restart nobody could hear the result.
  test("approving a merge that is already under way waits for its result", async () => {
    const { daemon } = await readyInRepo(undefined, { checks: ["sleep 0.5"] });
    await claimedWithWork(daemon);
    await ok(daemon, done());
    const first = daemon.handle({ type: "approve", task: task(1) });
    await Bun.sleep(150);
    const second = await daemon.handle({ type: "approve", task: task(1) });
    expect(second).toEqual(await first);
    expect(second).toMatchObject({ ok: true, result: { merged: true } });
  });

  test("a merge that fails on the last attempt says the task is out of attempts", async () => {
    const { daemon, repo } = await readyInRepo(undefined, { maxAttempts: 1 });
    await claimedWithWork(daemon);
    await ok(daemon, done());
    await conflictOnMain(repo.dir);
    const answer = z
      .object({ merged: z.literal(false), outOfAttempts: z.literal(true), summary: z.string() })
      .parse(await ok(daemon, { type: "approve", task: task(1) }));
    expect(answer.summary).toContain("conflicts");
  });

  test("done is refused while the worktree has uncommitted work", async () => {
    const { daemon } = await readyInRepo();
    const path = await claimedWithWork(daemon);
    writeFileSync(join(path, "draft.txt"), "not yet\n");
    const answer = await daemon.handle(done());
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.message).toContain("has uncommitted changes");
  });

  test("done is refused when the branch has no commits", async () => {
    const { daemon } = await readyInRepo();
    await ok(daemon, { type: "claim", task: task(1) });
    expect(await daemon.handle(done())).toEqual({
      ok: false,
      message: "The branch has no commits.",
    });
  });

  test("done is refused from a session that isn't the task's", async () => {
    const { daemon } = await readyInRepo();
    await claimedWithWork(daemon);
    expect(await daemon.handle(done(you(9)))).toEqual({
      ok: false,
      message: "#1's agent isn't you-9.",
    });
  });

  test("refuses the claim and says why when the worktree can't be made", async () => {
    const { daemon, repo } = await readyInRepo();
    mkdirSync(join(repo.dir, ".skelcrew", "worktrees", "1-csv-export"), { recursive: true });
    const answer = await daemon.handle({ type: "claim", task: task(1) });
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.message).toStartWith("The worktree couldn't be made:");
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, blocked: expect.stringMatching(/^The worktree couldn't be made:/) }],
    });
  });

  // Skelcrew doesn't start agents itself yet, so after a retry the task
  // waits in its phase until you claim it again.
  test("retries a task whose agent gave up, and a new claim works in the same worktree", async () => {
    const { daemon, repo } = await readyInRepo();
    await ok(daemon, { type: "claim", task: task(1) });
    await ok(daemon, { type: "give_up", task: task(1), session: you(2), message: "Stuck." });
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "in_progress", blocked: "The agent gave up: Stuck." }],
    });

    expect(await ok(daemon, { type: "retry", task: task(1) })).toEqual({});
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "in_progress", step: "queued", blocked: null, waitingOnYou: null }],
    });

    const path = join(repo.dir, ".skelcrew", "worktrees", "1-csv-export");
    expect(await ok(daemon, { type: "claim", task: task(1) })).toEqual({
      session: "you-3",
      phase: "in_progress",
      worktree: { path, branch: "task/1-csv-export" },
      spec,
    });
  });
});
