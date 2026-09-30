import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { localChecks } from "../checks/checks";
import { SessionId, TaskId } from "../core/ids";
import type { Config } from "../core/types";
import { Git } from "../plugins/git/git";
import type { VersionControl } from "../plugins/version-control";
import { git, makeRepo } from "../plugins/version-control.contract";
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
    const { daemon, broken } = failingReplies({ retryMs: 1, maxRetryMs: 5 });
    await readyToClaim(daemon);
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
    const store = EventStore.open(":memory:");
    const { daemon } = open(store);
    await ok(daemon, add("CSV export"));
    await ok(daemon, { type: "claim", task: task(1) });
    await ok(daemon, { type: "submit", task: task(1), session: you(1), spec });
    await ok(daemon, { type: "approve", task: task(1), sendBack: null });
    // Without git, the claim's worktree fails, and that reply is handled.
    expect((await daemon.handle({ type: "claim", task: task(1) })).ok).toBe(false);
    expect(store.loadCommands()).toEqual({ ok: true, commands: [] });
  });

  // A reply still unsaved when the daemon closes is left behind. Its
  // command then stays, and goes out again when the daemon next starts.
  test("keeps a command whose reply wasn't saved before closing, for the next start", async () => {
    const { daemon: first, store, broken } = failingReplies({ retryMs: 1, maxRetryMs: 5 });
    await readyToClaim(first);
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

  // A daemon for a real repository, with task 1 approved and Ready. Its
  // local gate runs `checks`, or only `true`.
  async function readyInRepo(
    repo?: Awaited<ReturnType<typeof makeRepo>>,
    options: { versionControl?: VersionControl; store?: EventStore; checks?: string[] } = {},
  ) {
    repo ??= await newRepo();
    let sessions = 0;
    const opened = Daemon.open({
      // Every path critical, as `skelcrew init` writes it.
      config: { ...config, criticalPaths: ["**"] },
      log: options.store ?? EventStore.open(":memory:"),
      versionControl: options.versionControl ?? new Git(repo.dir, repo.main),
      runChecks: localChecks(options.checks ?? ["true"]),
      newSession: () => {
        sessions += 1;
        return `you-${sessions}`;
      },
    });
    if (!opened.ok) throw new Error(opened.message);
    const daemon = opened.value;
    await readyToClaim(daemon);
    return { daemon, repo };
  }

  test("makes a worktree when you claim a task in Ready, and says where to work", async () => {
    const { daemon, repo } = await readyInRepo();
    const result = await ok(daemon, { type: "claim", task: task(1) });
    const path = join(repo.dir, ".skelcrew", "worktrees", "1-csv-export");
    expect(result).toEqual({
      session: "you-2",
      phase: "in_progress",
      worktree: { path, branch: "task/1-csv-export" },
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
      .parse(await ok(daemon, { type: "approve", task: task(1), sendBack: null }));
    expect(await git(repo.dir, "rev-parse", "main")).toBe(answer.commit);
    expect(await git(repo.dir, "show", "main:export.csv")).toBe("a,b");
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "done" }],
    });
  });

  test("approving a merge that fails says why, and the task goes back to its agent", async () => {
    const { daemon, repo } = await readyInRepo();
    await claimedWithWork(daemon);
    await ok(daemon, done());
    // Main gets its own export.csv meanwhile, so the two conflict.
    writeFileSync(join(repo.dir, "export.csv"), "x,y\n");
    await git(repo.dir, "add", "export.csv");
    await git(repo.dir, "commit", "-q", "-m", "Theirs");
    const answer = z
      .object({ merged: z.literal(false), summary: z.string() })
      .parse(await ok(daemon, { type: "approve", task: task(1), sendBack: null }));
    expect(answer.summary).toContain("conflicts");
    expect(await ok(daemon, { type: "status" })).toMatchObject({
      tasks: [{ task: 1, phase: "in_progress" }],
    });
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
});
