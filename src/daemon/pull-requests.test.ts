// Draft pull requests for reading, as the daemon keeps them. A real git
// repository takes each task to "merge waits for your approval". GitHub is
// a fake that behaves like the real one: it keeps the pull requests it
// opened, and showing a branch that already has one gives that one back.
// No test here runs gh or reaches GitHub.

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { localChecks } from "../checks/checks";
import { SessionId, TaskId } from "../core/ids";
import type { Config, Spec } from "../core/types";
import { Git } from "../plugins/git/git";
import type {
  CloseRequest,
  PullRequest,
  PullRequests,
  ShowRequest,
} from "../plugins/pull-requests";
import type { Done } from "../plugins/version-control";
import { git, makeRepo } from "../plugins/version-control.contract";
import type { Command } from "../protocol/protocol";
import { EventStore } from "../store/store";
import { config as base, spec } from "../test/fixtures";
import { Daemon } from "./daemon";

// Every path critical, as `skelcrew init` writes it, so every merge waits.
const config: Config = {
  ...base,
  gates: ["local"],
  maxRunning: 1,
  specApproval: "always",
  criticalPaths: ["**"],
};

class FakeGitHub implements PullRequests {
  shown: ShowRequest[] = [];
  closed: CloseRequest[] = [];
  // Open pull requests, by branch.
  open = new Map<string, PullRequest>();
  opened = 0;
  // While set, `show` fails with it, the way the real one says why.
  failure: string | null = null;
  // While set, `show` waits for it before answering.
  hold: Promise<void> | null = null;
  // While set, `close` waits for it before closing.
  closeHold: Promise<void> | null = null;

  async show(request: ShowRequest): Promise<Done<PullRequest>> {
    this.shown.push(request);
    if (this.hold !== null) await this.hold;
    if (this.failure !== null) return { ok: false, message: this.failure };
    const existing = this.open.get(request.branch);
    if (existing !== undefined) return { ok: true, value: existing };
    this.opened += 1;
    const number = 40 + this.opened;
    const made = { number, url: `https://github.com/owner/repo/pull/${number}` };
    this.open.set(request.branch, made);
    return { ok: true, value: made };
  }

  async close(request: CloseRequest): Promise<Done<null>> {
    this.closed.push(request);
    if (this.closeHold !== null) await this.closeHold;
    if (this.failure !== null) return { ok: false, message: this.failure };
    this.open.delete(request.branch);
    return { ok: true, value: null };
  }
}

const repos: string[] = [];
afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const one = TaskId.parse(1);

async function ok(daemon: Daemon, command: Command): Promise<unknown> {
  const answer = await daemon.handle(command);
  if (!answer.ok) throw new Error(answer.message);
  return answer.result;
}

function open(
  repo: { dir: string; main: string },
  github: FakeGitHub,
  store: EventStore,
  retryMs = 60_000,
) {
  let sessions = 0;
  const opened = Daemon.open({
    config,
    log: store,
    versionControl: new Git(repo.dir, repo.main),
    runChecks: localChecks(["true"]),
    pullRequests: { plugin: github, log: store, base: repo.main, retryMs },
    newSession: () => {
      sessions += 1;
      return `you-${sessions}`;
    },
  });
  if (!opened.ok) throw new Error(opened.message);
  return opened.value;
}

// Claims task 1 and commits a file in its worktree, as an agent would, then
// reports it done. Gives back the session.
async function workDone(daemon: Daemon, file = "export.csv"): Promise<SessionId> {
  const claim = z
    .object({ session: SessionId, worktree: z.object({ path: z.string() }) })
    .parse(await ok(daemon, { type: "claim", task: one }));
  const path = claim.worktree.path;
  writeFileSync(join(path, file), "a,b\n");
  await git(path, "add", file);
  await git(path, "-c", "user.name=Agent", "-c", "user.email=a@a", "commit", "-q", "-m", file);
  expect(await ok(daemon, { type: "done", task: one, session: claim.session })).toEqual({
    passed: true,
  });
  return claim.session;
}

// A daemon with task 1's merge waiting for your approval.
async function waitingForApproval(
  github = new FakeGitHub(),
  store = EventStore.open(":memory:"),
  retryMs = 60_000,
  taskSpec: Spec = spec,
) {
  const repo = await makeRepo();
  repos.push(repo.dir);
  const daemon = open(repo, github, store, retryMs);
  await ok(daemon, { type: "add", title: "CSV export", spec: true, project: null });
  const claim = z
    .object({ session: SessionId })
    .parse(await ok(daemon, { type: "claim", task: one }));
  await ok(daemon, { type: "submit", task: one, session: claim.session, spec: taskSpec });
  await workDone(daemon);
  return { daemon, repo, github, store };
}

const taskView = z.object({
  task: z.number(),
  waitingOnYou: z.string().nullable(),
  pullRequest: z.string().nullable(),
  noPullRequest: z.string().nullable(),
  pullRequestNote: z.string().nullable(),
});

async function statusOf(daemon: Daemon) {
  const result = z.object({ tasks: z.array(taskView) }).parse(await ok(daemon, { type: "status" }));
  const [first] = result.tasks;
  if (first === undefined) throw new Error("No task.");
  return first;
}

// Waits until `ready` holds, checking every 10 ms, for up to 3 seconds.
async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await ready()) return;
    await Bun.sleep(10);
  }
  throw new Error("Waited 3 seconds, and it didn't happen.");
}

describe("a draft pull request for reading", () => {
  test("opens once a merge waits for your approval, and status gives its link", async () => {
    const { daemon, repo, github } = await waitingForApproval();
    await until(async () => (await statusOf(daemon)).pullRequest !== null);
    expect(await statusOf(daemon)).toMatchObject({
      waitingOnYou: "merge_approval",
      pullRequest: "https://github.com/owner/repo/pull/41",
      noPullRequest: null,
    });
    const head = await git(repo.dir, "rev-parse", "task/1-csv-export");
    expect(github.shown).toHaveLength(1);
    const shown = github.shown[0];
    expect(shown).toMatchObject({
      branch: "task/1-csv-export",
      head,
      base: "main",
      // Not "#1": on GitHub, "#1" links to its own pull request or issue 1.
      title: "Task 1: CSV export",
    });
    expect(shown?.body).toContain(spec.scope);
    expect(shown?.body).toContain(`- ${spec.acceptance[0]}`);
    expect(shown?.body).toContain(`passed on commit ${head.slice(0, 7)}`);
    expect(shown?.body).toContain("`skelcrew approve 1`");
    // Sending it back is its own command now.
    expect(shown?.body).toContain('`skelcrew reject 1 "<what to change>"`');
    expect(shown?.body).not.toContain("--send-back");
  });

  test("opens only one, however often the daemon looks again", async () => {
    const { daemon, github } = await waitingForApproval();
    await until(() => github.shown.length === 1);
    for (let i = 0; i < 5; i++) await ok(daemon, { type: "status" });
    await Bun.sleep(100);
    expect(github.shown).toHaveLength(1);
  });

  test("opens no second one after a restart", async () => {
    const store = EventStore.open(":memory:");
    const first = await waitingForApproval(new FakeGitHub(), store);
    await until(() => first.github.shown.length === 1);
    await Bun.sleep(50);
    await first.daemon.close();

    const second = open(first.repo, first.github, store);
    await Bun.sleep(200);
    expect(first.github.shown).toHaveLength(1);
    expect((await statusOf(second)).pullRequest).toBe("https://github.com/owner/repo/pull/41");
  });

  // The daemon stopped while GitHub was still opening it. The next daemon
  // doesn't know it was opened, asks again, and gets the same one back.
  test("isn't lost when the daemon stops while it is being opened", async () => {
    const store = EventStore.open(":memory:");
    const github = new FakeGitHub();
    let release = () => {};
    github.hold = new Promise((resolve) => {
      release = resolve;
    });
    const first = await waitingForApproval(github, store);
    await until(() => github.shown.length === 1);
    await first.daemon.close();
    release();
    github.hold = null;

    const second = open(first.repo, github, store);
    await until(async () => (await statusOf(second)).pullRequest !== null);
    expect(github.opened).toBe(1);
    expect(github.open.size).toBe(1);
  });

  test("without GitHub, the merge waits as today, and status says why there is none", async () => {
    const github = new FakeGitHub();
    github.failure = "This repository has no `origin` remote.";
    const { daemon, repo } = await waitingForApproval(github);
    await until(async () => (await statusOf(daemon)).noPullRequest !== null);
    expect(await statusOf(daemon)).toMatchObject({
      waitingOnYou: "merge_approval",
      pullRequest: null,
      noPullRequest: "No pull request was opened. This repository has no `origin` remote.",
    });
    const merged = z
      .object({ merged: z.literal(true), commit: z.string() })
      .parse(await ok(daemon, { type: "approve", task: one }));
    expect(await git(repo.dir, "rev-parse", "main")).toBe(merged.commit);
  });

  test("a failed push doesn't stop the merge, and isn't tried again for the same work", async () => {
    const github = new FakeGitHub();
    github.failure = "git couldn't push the branch: ! [rejected] (non-fast-forward)";
    const { daemon } = await waitingForApproval(github);
    await until(async () => (await statusOf(daemon)).noPullRequest !== null);
    for (let i = 0; i < 3; i++) await ok(daemon, { type: "status" });
    await Bun.sleep(100);
    expect(github.shown).toHaveLength(1);
    expect(await ok(daemon, { type: "approve", task: one })).toMatchObject({
      merged: true,
    });
  });

  // For example, gh was logged out, and you ran `gh auth login`. The draft
  // appears without restarting the daemon.
  test("is tried again on a timer after it failed to open", async () => {
    const github = new FakeGitHub();
    github.failure = "`gh` isn't logged in to GitHub. Run `gh auth login`.";
    const { daemon } = await waitingForApproval(github, EventStore.open(":memory:"), 50);
    await until(async () => (await statusOf(daemon)).noPullRequest !== null);
    github.failure = null;
    await until(async () => (await statusOf(daemon)).pullRequest !== null);
    expect(github.opened).toBe(1);
  });

  test("a close that failed is tried again on a timer", async () => {
    const github = new FakeGitHub();
    const { daemon } = await waitingForApproval(github, EventStore.open(":memory:"), 50);
    await until(() => github.open.size === 1);
    github.failure = "`gh pr close` didn't answer within 1 minute, so Skelcrew stopped it.";
    await ok(daemon, { type: "drop", task: one });
    await until(() => github.closed.length === 1);
    github.failure = null;
    await until(() => github.open.size === 0);
  });

  test("is closed after the merge, with a comment naming the commit", async () => {
    const { daemon, github } = await waitingForApproval();
    await until(() => github.open.size === 1);
    const merged = z
      .object({ merged: z.literal(true), commit: z.string() })
      .parse(await ok(daemon, { type: "approve", task: one }));
    await until(() => github.closed.length === 1);
    expect(github.closed[0]).toMatchObject({ number: 41, branch: "task/1-csv-export" });
    expect(github.closed[0]?.comment).toContain(merged.commit.slice(0, 7));
    expect(github.closed[0]?.comment).toContain("`skelcrew approve 1`");
    expect(await statusOf(daemon)).toMatchObject({ pullRequest: null, noPullRequest: null });
  });

  // The daemon stopped while GitHub was still closing it.
  test("is closed after a restart when the daemon stopped before closing it", async () => {
    const store = EventStore.open(":memory:");
    const github = new FakeGitHub();
    const first = await waitingForApproval(github, store);
    await until(() => github.open.size === 1);
    await Bun.sleep(50);
    github.closeHold = new Promise(() => {});
    await ok(first.daemon, { type: "approve", task: one });
    await until(() => github.closed.length === 1);
    await first.daemon.close();
    github.closeHold = null;

    open(first.repo, github, store);
    await until(() => github.closed.length === 2);
    expect(github.closed[1]).toMatchObject({ number: 41 });
    expect(github.open.size).toBe(0);
  });

  test("stays open after a send-back, and the next wait pushes the new work to it", async () => {
    const { daemon, repo, github } = await waitingForApproval();
    await until(() => github.open.size === 1);
    await ok(daemon, { type: "reject", task: one, note: "Add totals." });
    await Bun.sleep(100);
    expect(github.closed).toHaveLength(0);
    expect((await statusOf(daemon)).pullRequest).toBe("https://github.com/owner/repo/pull/41");

    await workDone(daemon, "totals.csv");
    await until(() => github.shown.length === 2);
    const head = await git(repo.dir, "rev-parse", "task/1-csv-export");
    expect(github.shown[1]).toMatchObject({ branch: "task/1-csv-export", head });
    expect(github.opened).toBe(1);
  });

  // For example, the agent amended its commit after a send-back, and the
  // push was refused. The link alone would show the old work as if new.
  test("says the pull request shows older work when the new work couldn't be pushed", async () => {
    const { daemon, repo, github } = await waitingForApproval();
    await until(() => github.open.size === 1);
    const old = await git(repo.dir, "rev-parse", "task/1-csv-export");
    await ok(daemon, { type: "reject", task: one, note: "Add totals." });
    github.failure = "git couldn't push the branch: ! [rejected] (non-fast-forward)";
    await workDone(daemon, "totals.csv");
    await until(() => github.shown.length === 2);
    await until(async () => (await statusOf(daemon)).pullRequestNote !== null);
    expect(await statusOf(daemon)).toMatchObject({
      waitingOnYou: "merge_approval",
      pullRequest: "https://github.com/owner/repo/pull/41",
      noPullRequest: null,
      pullRequestNote: `It still shows older work, commit ${old.slice(0, 7)}. git couldn't push the branch: ! [rejected] (non-fast-forward)`,
    });
  });

  test("says nothing more once the pull request shows the newest work", async () => {
    const { daemon, github } = await waitingForApproval();
    await until(async () => (await statusOf(daemon)).pullRequest !== null);
    expect((await statusOf(daemon)).pullRequestNote).toBeNull();
    await ok(daemon, { type: "reject", task: one, note: "Add totals." });
    await workDone(daemon, "totals.csv");
    await until(() => github.shown.length === 2);
    await Bun.sleep(50);
    expect(await statusOf(daemon)).toMatchObject({
      waitingOnYou: "merge_approval",
      pullRequestNote: null,
    });
  });

  test("is closed when the task is dropped", async () => {
    const { daemon, github } = await waitingForApproval();
    await until(() => github.open.size === 1);
    await ok(daemon, { type: "drop", task: one });
    await until(() => github.closed.length === 1);
    expect(github.closed[0]?.comment).toContain("dropped");
  });

  // On GitHub, "#1" links to GitHub's own issue or pull request 1, which
  // is something else. So Skelcrew's comments say "Task 1".
  test("names the task in words in its closing comment, not as #1", async () => {
    const { daemon, github } = await waitingForApproval();
    await until(() => github.open.size === 1);
    await ok(daemon, { type: "drop", task: one });
    await until(() => github.closed.length === 1);
    expect(github.closed[0]?.comment).toBe(
      "Task 1 was dropped, so this pull request is closed. Nothing was merged.",
    );
  });

  // The spec is pasted into the body. There, "#56" would link to GitHub's
  // pull request 56, and "@simon" would notify someone. Inside a fenced
  // block GitHub shows both as plain text.
  test("puts the spec's text in fenced blocks, so GitHub links and notifies nothing", async () => {
    const github = new FakeGitHub();
    const taskSpec: Spec = {
      scope: "Fix the export from #56, as @simon asked.",
      acceptance: ["Works like #57.", "Ask @ana to try ```csv``` files."],
      openQuestions: [],
    };
    await waitingForApproval(github, EventStore.open(":memory:"), 60_000, taskSpec);
    await until(() => github.shown.length === 1);
    const body = github.shown[0]?.body ?? "";
    expect(body).toContain(
      "## Scope\n\n```text\nFix the export from #56, as @simon asked.\n```\n\n## Acceptance criteria\n\n````text\n- Works like #57.\n- Ask @ana to try ```csv``` files.\n````\n",
    );
  });
});
