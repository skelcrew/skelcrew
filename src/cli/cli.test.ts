import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectId } from "../core/ids";
import { daemonPaths } from "../daemon/paths";
import { type Server, serve } from "../daemon/server";
import { cleanUp, throwawayRepo } from "../daemon/testing";
import { EventStore } from "../store/store";
import { type Context, run } from "./cli";

const dirs: string[] = [];
const servers: Server[] = [];
const fakes: NetServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const fake of fakes.splice(0)) fake.close();
  cleanUp(dirs);
});

// A throwaway repository with its daemon running in this process. Sessions
// are numbered, so tests can name them. There is no project command yet, so
// the projects are made straight in the store before the daemon starts.
async function repoWithDaemon(projects: string[] = []): Promise<string> {
  const repo = throwawayRepo(dirs);
  if (projects.length > 0) {
    const found = daemonPaths(repo);
    if (!found.ok) throw new Error(found.message);
    const store = EventStore.open(found.paths.store);
    const saved = store.appendProject(
      projects.map((id) => ({
        v: 1,
        type: "project.created",
        projectId: ProjectId.parse(id),
        at: 1,
        name: id,
        goal: `The ${id} project.`,
      })),
    );
    store.close();
    if (!saved.ok) throw new Error(saved.reason);
  }
  let sessions = 0;
  const served = await serve(repo, {
    newSession: () => {
      sessions += 1;
      return `you-${sessions}`;
    },
  });
  if (!served.ok) throw new Error(served.message);
  servers.push(served.server);
  return repo;
}

// Runs the CLI as a function, the way a person would from the repository.
// It never starts a daemon: the tests start their own.
function cli(repo: string, args: string[], context: Partial<Context> = {}) {
  return run(args, {
    cwd: repo,
    session: undefined,
    readStdin: async () => "",
    start: () => ({ ok: false, message: "The test starts no daemon." }),
    ...context,
  });
}

const said = (out: string[]) => ({ code: 0, out, err: [] });
const refused = (...err: string[]) => ({ code: 1, out: [], err });

const specJson = JSON.stringify({
  scope: "Add a CSV export button to the reports page.",
  acceptance: ["Clicking Export downloads a CSV of the visible rows."],
  openQuestions: [],
});

// A task in Spec, claimed as session you-1, with its spec submitted.
async function specced(repo: string) {
  await cli(repo, ["add", "CSV export", "--spec"]);
  await cli(repo, ["claim", "1"]);
  await cli(repo, ["submit", "1", "--file", "-"], {
    session: "you-1",
    readStdin: async () => specJson,
  });
}

// A stand-in daemon that answers every request with this result, for the
// commands the real daemon can't carry out yet.
async function fakeDaemon(repo: string, result: unknown) {
  const found = daemonPaths(repo);
  if (!found.ok) throw new Error(found.message);
  const fake = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line: string) => {
      const { id } = JSON.parse(line);
      socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    });
  });
  fakes.push(fake);
  await new Promise<void>((resolve) => fake.listen(found.paths.socket, resolve));
}

describe("finding the repository", () => {
  test("finds .skelcrew/ from a folder inside the repository", async () => {
    const repo = await repoWithDaemon();
    const inside = join(repo, "src", "reports");
    mkdirSync(inside, { recursive: true });
    expect(await cli(inside, ["add", "CSV export"])).toEqual(said(["Added #1: CSV export."]));
  });

  test("refuses outside a Skelcrew repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "sk-"));
    dirs.push(outside);
    expect(await cli(outside, ["status"])).toEqual(
      refused("No Skelcrew repository here. Run `skelcrew init` in your repository first."),
    );
  });
});

describe("skelcrew add", () => {
  test("adds a task as an Idea", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["add", "CSV export"])).toEqual(said(["Added #1: CSV export."]));
  });

  test("with --spec, asks for a spec too", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["add", "CSV export", "--spec"])).toEqual(
      said(["Added #1: CSV export.", "It waits for a spec."]),
    );
    expect((await cli(repo, ["status"])).out).toContain("Spec:");
  });

  test("with --project, passes on a refusal for a project that doesn't exist", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["add", "CSV export", "--project", "inbox"])).toEqual(
      refused("There is no project called inbox."),
    );
  });

  test("refuses without a title", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["add"])).toEqual(
      refused('Say what the task is, like this: skelcrew add "CSV export"'),
    );
  });

  test("refuses an option it doesn't know", async () => {
    const repo = await repoWithDaemon();
    const outcome = await cli(repo, ["add", "CSV export", "--force"]);
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("--force");
    expect(outcome.err.join("\n")).toContain("skelcrew add --help");
  });
});

describe("skelcrew spec", () => {
  test("asks for a spec, with the task written as #1", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "CSV export"]);
    expect(await cli(repo, ["spec", "#1"])).toEqual(said(["Asked for a spec for #1."]));
  });

  test("passes on the daemon's refusal", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["spec", "9"])).toEqual(refused("#9 doesn't exist."));
  });

  test("refuses something that isn't a task number", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["spec", "csv"])).toEqual(
      refused('"csv" isn\'t a task number. Write it as 12 or #12.'),
    );
  });
});

describe("skelcrew claim", () => {
  test("prints the session, and how to report with it", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "CSV export", "--spec"]);
    expect(await cli(repo, ["claim", "1"])).toEqual(
      said([
        "Claimed #1. It is in Spec.",
        "Your session is you-1.",
        "Set SKELCREW_SESSION to it for each report, like this:",
        "SKELCREW_SESSION=you-1 skelcrew submit 1",
      ]),
    );
  });

  test("in Ready, says where to work once the worktree is made", async () => {
    const repo = await repoWithDaemon();
    await specced(repo);
    await cli(repo, ["approve", "1"]);
    const worktree = join(realpathSync(repo), ".skelcrew", "worktrees", "1-csv-export");
    expect(await cli(repo, ["claim", "1"])).toEqual(
      said([
        "Claimed #1. It is in In progress.",
        `Work in ${worktree}, on the branch task/1-csv-export.`,
        "Your session is you-2.",
        "Set SKELCREW_SESSION to it for each report, like this:",
        "SKELCREW_SESSION=you-2 skelcrew done 1",
      ]),
    );
  });

  test("shows the developer's note when a spec was sent back", async () => {
    const repo = await repoWithDaemon();
    await specced(repo);
    await cli(repo, ["approve", "1", "--send-back", "Add totals."]);
    const outcome = await cli(repo, ["claim", "1"]);
    expect(outcome.out).toContain("The developer's note: Add totals.");
    expect(outcome.out).toContain("Scope: Add a CSV export button to the reports page.");
  });

  test("passes on the daemon's refusal", async () => {
    const repo = await repoWithDaemon();
    const outcome = await cli(repo, ["claim", "1"]);
    expect(outcome).toEqual(refused("#1 doesn't exist."));
  });
});

describe("skelcrew submit", () => {
  test("submits a spec read from standard input", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "CSV export", "--spec"]);
    await cli(repo, ["claim", "1"]);
    const outcome = await cli(repo, ["submit", "1", "--file", "-"], {
      session: "you-1",
      readStdin: async () => specJson,
    });
    expect(outcome).toEqual(said(["Submitted the spec for #1."]));
    expect((await cli(repo, ["status"])).out).toContain("- #1 CSV export: approve its spec.");
  });

  test("submits a spec read from --file", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "CSV export", "--spec"]);
    await cli(repo, ["claim", "1"]);
    const file = join(repo, "spec.json");
    writeFileSync(file, specJson);
    const outcome = await cli(repo, ["submit", "1", "--file", file], { session: "you-1" });
    expect(outcome).toEqual(said(["Submitted the spec for #1."]));
  });

  test("refuses without SKELCREW_SESSION", async () => {
    const repo = await repoWithDaemon();
    expect(
      await cli(repo, ["submit", "1", "--file", "-"], { readStdin: async () => specJson }),
    ).toEqual(
      refused(
        "SKELCREW_SESSION isn't set. Set it to the session `skelcrew claim` printed, like this:",
        "SKELCREW_SESSION=<session> skelcrew submit 1",
      ),
    );
  });

  test("says plainly what is wrong with a spec that doesn't fit", async () => {
    const repo = await repoWithDaemon();
    const file = join(repo, "spec.json");
    writeFileSync(file, JSON.stringify({ scope: "", acceptance: "it works", extra: 1 }));
    expect(await cli(repo, ["submit", "1", "--file", file], { session: "you-1" })).toEqual(
      refused(
        "The spec doesn't fit:",
        "- extra isn't part of a spec.",
        "- scope: say what the task changes.",
        "- acceptance: must be a list of criteria, each one text.",
        "- openQuestions: must be a list of questions. Leave it empty, [], when none are left.",
        "Run `skelcrew submit --help` to see the form.",
      ),
    );
  });

  test("refuses a spec that isn't JSON", async () => {
    const repo = await repoWithDaemon();
    const outcome = await cli(repo, ["submit", "1", "--file", "-"], {
      session: "you-1",
      readStdin: async () => "scope: CSV",
    });
    expect(outcome.code).toBe(1);
    expect(outcome.err[0]).toStartWith("The spec isn't valid JSON:");
  });

  test("refuses a spec file that can't be read", async () => {
    const repo = await repoWithDaemon();
    const outcome = await cli(repo, ["submit", "1", "--file", "missing.json"], {
      session: "you-1",
    });
    expect(outcome.code).toBe(1);
    expect(outcome.err[0]).toStartWith("The file missing.json couldn't be read:");
  });

  test("passes on the daemon's refusal of a stranger's session", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "CSV export", "--spec"]);
    await cli(repo, ["claim", "1"]);
    const outcome = await cli(repo, ["submit", "1", "--file", "-"], {
      session: "someone-else",
      readStdin: async () => specJson,
    });
    expect(outcome).toEqual(refused("#1's agent isn't someone-else."));
  });

  // The spec skill tells agents to read it before they submit.
  test("--help says how to hand over the spec", async () => {
    const repo = await repoWithDaemon();
    const help = (await cli(repo, ["submit", "--help"])).out.join("\n");
    expect(help).toContain("--file <path>");
    expect(help).toContain("standard input");
    expect(help).toContain('"scope"');
    expect(help).toContain('"acceptance"');
    expect(help).toContain('"openQuestions"');
  });
});

// Found by review: with standard input open and never written, submit
// waited for ever.
describe("skelcrew submit, without a spec", () => {
  test("refuses at once, rather than wait on standard input", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "CSV export", "--spec"]);
    await cli(repo, ["claim", "1"]);
    const outcome = await cli(repo, ["submit", "1"], {
      session: "you-1",
      readStdin: () => new Promise<string>(() => {}),
    });
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("--file -");
  });
});

// Found by review: help was shown for any argument that was exactly -h or
// --help, even a reason, and nothing was reported.
describe("arguments that start with a dash", () => {
  test("shows a command's help only when --help is its only argument", async () => {
    const repo = await repoWithDaemon();
    expect((await cli(repo, ["give-up", "--help"])).code).toBe(0);
    const outcome = await cli(repo, ["give-up", "1", "-h"], { session: "you-1" });
    expect(outcome.code).toBe(1);
    expect(outcome.out).toEqual([]);
  });

  test("says in plain words how to pass a title that starts with a dash", async () => {
    const repo = await repoWithDaemon();
    const outcome = await cli(repo, ["add", "-x: remove the flag"]);
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain('skelcrew add -- "-x: remove the flag"');
    expect(await cli(repo, ["add", "--", "-x: remove the flag"])).toEqual(
      said(["Added #1: -x: remove the flag."]),
    );
  });
});

describe("skelcrew approve", () => {
  test("approves a spec", async () => {
    const repo = await repoWithDaemon();
    await specced(repo);
    expect(await cli(repo, ["approve", "#1"])).toEqual(said(["Approved #1."]));
    expect((await cli(repo, ["status"])).out).toContain("Ready:");
  });

  test("with --send-back, returns it with a note", async () => {
    const repo = await repoWithDaemon();
    await specced(repo);
    expect(await cli(repo, ["approve", "1", "--send-back", "Add totals."])).toEqual(
      said(["Sent #1 back with your note."]),
    );
  });

  test("passes on the refusal when nothing waits for approval", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "CSV export"]);
    expect(await cli(repo, ["approve", "1"])).toEqual(
      refused("#1 has nothing waiting for your approval."),
    );
  });
});

describe("skelcrew drop", () => {
  test("drops a task", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "CSV export"]);
    expect(await cli(repo, ["drop", "1"])).toEqual(said(["Dropped #1."]));
  });

  test("passes on the daemon's refusal", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["drop", "4"])).toEqual(refused("#4 doesn't exist."));
  });
});

describe("skelcrew status", () => {
  test("shows what waits on you, then tasks by phase", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "Totals"]);
    await cli(repo, ["add", "CSV export", "--spec"]);
    await cli(repo, ["claim", "2"]);
    await cli(repo, ["submit", "2", "--file", "-"], {
      session: "you-1",
      readStdin: async () => specJson,
    });
    await cli(repo, ["add", "PDF export"]);
    await cli(repo, ["drop", "3"]);
    expect(await cli(repo, ["status"])).toEqual(
      said([
        "Waiting on you:",
        "- #2 CSV export: approve its spec.",
        "",
        "Idea:",
        "- #1 Totals",
        "Spec:",
        "- #2 CSV export",
        "Dropped:",
        "- #3 PDF export",
      ]),
    );
  });

  test("shows a blocked task with its reason", async () => {
    const repo = await repoWithDaemon();
    await specced(repo);
    await cli(repo, ["approve", "1"]);
    // A folder where the worktree should go, so it can't be made.
    const worktree = join(realpathSync(repo), ".skelcrew", "worktrees", "1-csv-export");
    mkdirSync(worktree, { recursive: true });
    await cli(repo, ["claim", "1"]);
    expect((await cli(repo, ["status"])).out).toEqual([
      "Waiting on you:",
      "- #1 CSV export: blocked, so retry or drop it.",
      "",
      "Ready:",
      `- #1 CSV export (blocked: The worktree couldn't be made: ${worktree} exists, but isn't a worktree of ${realpathSync(repo)}.)`,
    ]);
  });

  test("groups tasks by project first when any task has one", async () => {
    const repo = await repoWithDaemon(["reports"]);
    await cli(repo, ["add", "CSV export", "--project", "reports"]);
    await cli(repo, ["add", "Totals"]);
    await cli(repo, ["add", "PDF export", "--project", "reports", "--spec"]);
    expect(await cli(repo, ["status"])).toEqual(
      said([
        "Project reports:",
        "  Idea:",
        "  - #1 CSV export",
        "  Spec:",
        "  - #3 PDF export",
        "",
        "No project:",
        "  Idea:",
        "  - #2 Totals",
      ]),
    );
  });

  test("says so when there are no tasks", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["status"])).toEqual(
      said(['No tasks yet. Add one with: skelcrew add "<task>"']),
    );
  });
});

describe("skelcrew log", () => {
  test("shows each event with its time, oldest first, in plain words", async () => {
    const repo = await repoWithDaemon(["reports"]);
    const submit = (session: string) =>
      cli(repo, ["submit", "1", "--file", "-"], { session, readStdin: async () => specJson });
    await cli(repo, ["add", "CSV export", "--spec", "--project", "reports"]);
    await cli(repo, ["claim", "1"]);
    await submit("you-1");
    await cli(repo, ["approve", "1", "--send-back", "Add totals."]);
    await cli(repo, ["claim", "1"]);
    await submit("you-2");
    await cli(repo, ["approve", "1"]);
    // Claiming in Ready makes a worktree, and your session works in it.
    await cli(repo, ["claim", "1"]);
    const worktree = join(realpathSync(repo), ".skelcrew", "worktrees", "1-csv-export");

    const outcome = await cli(repo, ["log", "#1"]);
    expect(outcome.code).toBe(0);
    for (const line of outcome.out) expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}\S/);
    expect(outcome.out.map((line) => line.slice(18))).toEqual([
      "Added to project reports: CSV export.",
      "A spec was asked for.",
      "You claimed it, as session you-1.",
      "The agent sent a spec: Add a CSV export button to the reports page.",
      "You sent the spec back: Add totals.",
      "You claimed it, as session you-2.",
      "The agent sent a spec: Add a CSV export button to the reports page.",
      "The task is Ready to build from this spec.",
      "You claimed it, as session you-3.",
      `Its worktree was made on branch task/1-csv-export, at ${worktree}.`,
      "Your session is working on it.",
    ]);
  });

  // Found by review: every spec is saved whole, so a long-lived task's
  // events passed the 1 MB limit on a reply, and log failed outright.
  test("leaves out the oldest events when all of them don't fit in a reply", async () => {
    const repo = await repoWithDaemon();
    // Three specs of 400 KB each: more than 1 MB together.
    const scope = `Add a CSV export. ${"x".repeat(400_000)}`;
    const big = JSON.stringify({ scope, acceptance: ["It downloads."], openQuestions: [] });
    await cli(repo, ["add", "CSV export", "--spec"]);
    for (const session of ["you-1", "you-2", "you-3"]) {
      await cli(repo, ["claim", "1"]);
      await cli(repo, ["submit", "1", "--file", "-"], { session, readStdin: async () => big });
      await cli(repo, ["approve", "1", "--send-back", "Shorter, please."]);
    }

    const outcome = await cli(repo, ["log", "1"]);
    expect(outcome.err).toEqual([]);
    expect(outcome.code).toBe(0);
    // Two specs fit. The first spec, its claim, the request for a spec and
    // the task's creation are left out.
    expect(outcome.out[0]).toBe("4 older events are left out.");
    expect(outcome.out.slice(1).map((line) => line.slice(18, 60))).toEqual([
      "You sent the spec back: Shorter, please.",
      "You claimed it, as session you-2.",
      "The agent sent a spec: Add a CSV export. x",
      "You sent the spec back: Shorter, please.",
      "You claimed it, as session you-3.",
      "The agent sent a spec: Add a CSV export. x",
      "You sent the spec back: Shorter, please.",
    ]);
  });

  // The daemon can't take a task this far yet, so a stand-in answers.
  test("shows checks, a merge and multi-line summaries", async () => {
    const repo = throwawayRepo(dirs);
    const task = 4;
    const at = (minute: number) => new Date(2026, 8, 30, 10, minute).getTime();
    const stamp = (minute: number) => ({ v: 1, taskId: task, at: at(minute) });
    await fakeDaemon(repo, {
      leftOut: 0,
      events: [
        {
          ...stamp(2),
          type: "task.done_reported",
          branch: { head: "a".repeat(40), commits: 3, changedFiles: ["src/export.ts"] },
          gate: "local",
          request: 2,
        },
        {
          ...stamp(3),
          type: "task.gate_failed",
          failure: { step: "local", summary: "bun test failed.\n1 test failed." },
        },
        { ...stamp(4), type: "task.question_asked", question: question() },
        { ...stamp(5), type: "task.question_answered", text: "Semicolons." },
        { ...stamp(6), type: "task.gate_passed", gate: "local", next: null },
        { ...stamp(6), type: "task.checks_passed" },
        {
          ...stamp(6),
          type: "task.merge_approval_requested",
          criticalFiles: ["src/core/decide.ts"],
        },
        { ...stamp(7), type: "task.merge_started", request: 3 },
        { ...stamp(8), type: "task.merged", commit: "b".repeat(40) },
      ],
    });
    expect(await cli(repo, ["log", "4"])).toEqual(
      said([
        "2026-09-30 10:02  The agent said it's done: 3 commits, 1 changed file. The local checks started.",
        "2026-09-30 10:03  The local checks failed: bun test failed.",
        "                  1 test failed.",
        "2026-09-30 10:04  The agent asked: Commas or semicolons?",
        "                  Options: Commas, Semicolons.",
        "2026-09-30 10:05  You answered: Semicolons.",
        "2026-09-30 10:06  The local checks passed.",
        "2026-09-30 10:06  All checks passed.",
        "2026-09-30 10:06  It waits for your approval to merge, since it changes critical files: src/core/decide.ts.",
        "2026-09-30 10:07  Merging started.",
        "2026-09-30 10:08  Merged as commit bbbbbbb.",
      ]),
    );

    function question() {
      return {
        from: "develop",
        text: "Commas or semicolons?",
        options: ["Commas", "Semicolons"],
        askedAt: at(4),
      };
    }
  });

  // Found by review: the log named the undone merge as the revert's own
  // commit, "Reverted by commit ...".
  test("names the merge a revert undid", async () => {
    const repo = throwawayRepo(dirs);
    const at = new Date(2026, 8, 30, 10, 2).getTime();
    const stamp = { v: 1, taskId: 4, at };
    await fakeDaemon(repo, {
      leftOut: 0,
      events: [
        { ...stamp, type: "task.merged", commit: "a".repeat(40) },
        { ...stamp, type: "task.revert_started", reason: "It broke the export.", request: 5 },
        { ...stamp, type: "task.reverted", commit: "a".repeat(40), reason: "It broke the export." },
      ],
    });
    expect(await cli(repo, ["log", "4"])).toEqual(
      said([
        "2026-09-30 10:02  Merged as commit aaaaaaa.",
        "2026-09-30 10:02  Reverting it, because: It broke the export.",
        "2026-09-30 10:02  The revert went through, undoing commit aaaaaaa. The task went back to Spec with your reason: It broke the export.",
      ]),
    );
  });

  // Found by review: the log said "The spec was approved." when nobody
  // approved it. With spec_approval: never, or a spec you wrote yourself,
  // the task goes to Ready on its own. The saved events can't tell your
  // approval from spec_approval: never, so that line fits both.
  test("says when a spec went to Ready without an approval", async () => {
    const repo = throwawayRepo(dirs);
    const stamp = (minute: number) => ({
      v: 1,
      taskId: 4,
      at: new Date(2026, 8, 30, 10, minute).getTime(),
    });
    const spec = { scope: "Add a CSV export.", acceptance: ["It downloads."], openQuestions: [] };
    await fakeDaemon(repo, {
      leftOut: 0,
      events: [
        { ...stamp(2), type: "task.specced", spec, by: "agent" },
        { ...stamp(2), type: "task.ready" },
        { ...stamp(3), type: "task.specced", spec, by: "human" },
        { ...stamp(3), type: "task.ready" },
      ],
    });
    expect(await cli(repo, ["log", "4"])).toEqual(
      said([
        "2026-09-30 10:02  The agent sent a spec: Add a CSV export.",
        "2026-09-30 10:02  The task is Ready to build from this spec.",
        "2026-09-30 10:03  A spec was written by hand: Add a CSV export.",
        "2026-09-30 10:03  A spec you write needs no approval, so the task is Ready.",
      ]),
    );
  });

  // Found by review: "Used 1234567 tokens in 0 minutes so far."
  test("shows token use with separators, and a short run as under a minute", async () => {
    const repo = throwawayRepo(dirs);
    const stamp = { v: 1, taskId: 4, at: new Date(2026, 8, 30, 10, 2).getTime() };
    const used = (tokens: number, ms: number) => ({
      ...stamp,
      type: "task.usage_recorded",
      usage: { tokens, ms },
    });
    await fakeDaemon(repo, {
      leftOut: 0,
      events: [used(800, 20_000), used(1_234_567, 60_000), used(2_500_000, 2_700_000)],
    });
    expect(await cli(repo, ["log", "4"])).toEqual(
      said([
        "2026-09-30 10:02  Used 800 tokens in under a minute so far.",
        "2026-09-30 10:02  Used 1,234,567 tokens in 1 minute so far.",
        "2026-09-30 10:02  Used 2,500,000 tokens in 45 minutes so far.",
      ]),
    );
  });

  // Found by review: "The agent asked: Use Postgres Options: Yes, No."
  test("keeps a question apart from its options", async () => {
    const repo = throwawayRepo(dirs);
    const at = new Date(2026, 8, 30, 10, 2).getTime();
    await fakeDaemon(repo, {
      leftOut: 0,
      events: [
        {
          v: 1,
          taskId: 4,
          at,
          type: "task.question_asked",
          question: { from: "develop", text: "Use Postgres", options: ["Yes", "No"], askedAt: at },
        },
      ],
    });
    expect(await cli(repo, ["log", "4"])).toEqual(
      said([
        "2026-09-30 10:02  The agent asked: Use Postgres",
        "                  Options: Yes, No.",
      ]),
    );
  });

  // Found by review: "Picked to start, since a slot was free." A slot means
  // nothing to someone who hasn't read max_running's docs.
  test("says Skelcrew picked the task to start", async () => {
    const repo = throwawayRepo(dirs);
    const at = new Date(2026, 8, 30, 10, 2).getTime();
    await fakeDaemon(repo, {
      leftOut: 0,
      events: [{ v: 1, taskId: 4, at, type: "task.dispatch_started", request: 1 }],
    });
    expect(await cli(repo, ["log", "4"])).toEqual(
      said(["2026-09-30 10:02  Skelcrew picked it to start."]),
    );
  });

  // Found by review: "The review checks passed." The review is one step.
  test("calls the review step the review", async () => {
    const repo = throwawayRepo(dirs);
    const stamp = { v: 1, taskId: 4, at: new Date(2026, 8, 30, 10, 2).getTime() };
    await fakeDaemon(repo, {
      leftOut: 0,
      events: [
        { ...stamp, type: "task.gate_passed", gate: "local", next: { gate: "review", request: 3 } },
        { ...stamp, type: "task.gate_failed", failure: { step: "review", summary: "No tests." } },
        { ...stamp, type: "task.gate_passed", gate: "review", next: null },
      ],
    });
    expect(await cli(repo, ["log", "4"])).toEqual(
      said([
        "2026-09-30 10:02  The local checks passed. The review started.",
        "2026-09-30 10:02  The review failed: No tests.",
        "2026-09-30 10:02  The review passed.",
      ]),
    );
  });

  test("refuses an answer that isn't a list of events", async () => {
    const repo = throwawayRepo(dirs);
    await fakeDaemon(repo, {
      leftOut: 0,
      events: [{ type: "task.exploded", v: 1, taskId: 1, at: 1 }],
    });
    const outcome = await cli(repo, ["log", "1"]);
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("The daemon's answer to log doesn't fit");
  });

  test("passes on the daemon's refusal", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["log", "9"])).toEqual(refused("#9 doesn't exist."));
  });
});

describe("skelcrew done", () => {
  test("prints that the checks passed", async () => {
    const repo = throwawayRepo(dirs);
    await fakeDaemon(repo, { passed: true });
    expect(await cli(repo, ["done", "1"], { session: "you-1" })).toEqual(
      said(["The checks passed for #1."]),
    );
  });

  test("prints that the checks failed, with the summary", async () => {
    const repo = throwawayRepo(dirs);
    await fakeDaemon(repo, { passed: false, summary: "bun test failed.\n2 tests failed." });
    expect(await cli(repo, ["done", "1"], { session: "you-1" })).toEqual({
      code: 1,
      out: ["The checks failed for #1.", "bun test failed.", "2 tests failed."],
      err: [],
    });
  });

  test("refuses without SKELCREW_SESSION", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["done", "1"])).toEqual(
      refused(
        "SKELCREW_SESSION isn't set. Set it to the session `skelcrew claim` printed, like this:",
        "SKELCREW_SESSION=<session> skelcrew done 1",
      ),
    );
  });

  test("passes on the daemon's refusal", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["done", "1"], { session: "you-1" })).toEqual(
      refused("`done` isn't built into the daemon yet."),
    );
  });
});

describe("skelcrew give-up", () => {
  test("gives up with a reason", async () => {
    const repo = throwawayRepo(dirs);
    await fakeDaemon(repo, {});
    expect(
      await cli(repo, ["give-up", "1", "The API it needs doesn't exist."], { session: "you-1" }),
    ).toEqual(said(["Gave up on #1."]));
  });

  test("refuses without a reason", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["give-up", "1"], { session: "you-1" })).toEqual(
      refused('Say why, like this: skelcrew give-up 1 "The API it needs doesn\'t exist."'),
    );
  });

  test("refuses without SKELCREW_SESSION", async () => {
    const repo = await repoWithDaemon();
    expect((await cli(repo, ["give-up", "1", "Stuck."])).err[0]).toStartWith(
      "SKELCREW_SESSION isn't set.",
    );
  });

  // The core only hears giving up from a task In progress.
  test("passes on the daemon's refusal", async () => {
    const repo = await repoWithDaemon();
    await cli(repo, ["add", "CSV export", "--spec"]);
    await cli(repo, ["claim", "1"]);
    expect(await cli(repo, ["give-up", "1", "Stuck."], { session: "you-1" })).toEqual(
      refused("#1 is in Spec, so it can't take an agent giving up."),
    );
  });
});

describe("other commands", () => {
  test("init says it isn't here yet", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["init"])).toEqual(
      refused("`skelcrew init` isn't built yet. It comes with pull request #34."),
    );
  });

  test("refuses a command it doesn't know", async () => {
    const repo = await repoWithDaemon();
    expect(await cli(repo, ["merge", "1"])).toEqual(
      refused("There is no command merge. Run `skelcrew --help` to see them all."),
    );
  });

  test("--help lists the commands", async () => {
    const repo = await repoWithDaemon();
    const help = (await cli(repo, ["--help"])).out.join("\n");
    for (const command of ["add", "spec", "approve", "drop", "status", "log", "claim"]) {
      expect(help).toContain(`skelcrew ${command}`);
    }
    for (const command of ["submit", "done", "give-up", "serve"]) {
      expect(help).toContain(`skelcrew ${command}`);
    }
  });

  test("passes on why the daemon couldn't be started", async () => {
    const repo = throwawayRepo(dirs);
    expect(await cli(repo, ["status"])).toEqual(refused("The test starts no daemon."));
  });
});
