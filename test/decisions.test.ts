// A task's decisions and what its change must keep true, recorded by the lead in a process of the
// test's own against its own database, and shown by sc show.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowed, DaemonRequest } from "../src/flow/requests.ts";
import { source, threadSql } from "./harness.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-decisions-test-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// Runs the code with app-12 in the database as `db`, its thread in the given status, and returns
// what it printed last, as JSON.
function inProcess(body: string, status = "working"): Record<string, unknown> {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { decide, keepTrue } from ${JSON.stringify(source("flow/decisions.ts"))};
import { readTask } from ${JSON.stringify(source("flow/list.ts"))};
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
${threadSql({ task: "12", status, title: "Add export", body: "Export as CSV." })}\`);
const thread = () => readThread(db, "app-12");
const attempt = (run) => { try { return run(); } catch (error) { return error.message; } };
${body}
process.exit(0);`;
  const done = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!done.success) throw new Error(done.stderr.toString());
  return JSON.parse(done.stdout.toString().trim().split("\n").at(-1) ?? "{}");
}

test("the lead's decisions add up on the task, the human's with their words, and sc show lists them", () => {
  const seen = inProcess(`
const first = decide(db, "app", "t12", "Keep CSV only, as it is what users open.", undefined);
const second = decide(db, "app", "t12", "Never save provider text.", "no, don't save what the provider says\\n");
const { decisions } = thread();
const view = readTask(db, { repo: "app", task: "t12" });
console.log(JSON.stringify({ first, second, decisions, shown: view.decisions }));`);
  expect(seen.first).toBe(
    "Recorded the decision on APP-12. Every review of it from now on gets it.",
  );
  expect(seen.decisions).toEqual([
    { by: "lead", at: expect.any(Number), text: "Keep CSV only, as it is what users open." },
    {
      by: "human",
      at: expect.any(Number),
      text: "Never save provider text.",
      words: "no, don't save what the provider says\n",
    },
  ]);
  expect(seen.shown).toEqual([
    { by: "lead", text: "Keep CSV only, as it is what users open." },
    { by: "human", text: "Never save provider text." },
  ]);
});

// Starting the task over clears its decisions, so the thread's log keeps the human's words.
test("the thread's log keeps a human decision's words, for after the task starts over", () => {
  const seen = inProcess(`
decide(db, "app", "t12", "Never save provider text.", "no, don't save it\\n");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { threadsDir } = await import(${JSON.stringify(source("paths.ts"))});
const lines = readFileSync(join(threadsDir(), "app-12.log"), "utf8").trim().split("\\n");
const last = JSON.parse(lines.at(-1));
console.log(JSON.stringify({ why: last.why, decisions: last.decisions }));`);
  expect(seen.why).toBe("the human decided: Never save provider text.");
  expect(seen.decisions).toEqual([
    {
      by: "human",
      at: expect.any(Number),
      text: "Never save provider text.",
      words: "no, don't save it\n",
    },
  ]);
});

test("what must stay true replaces the list it had, and sc show lists it", () => {
  const seen = inProcess(`
keepTrue(db, "app", "t12", ["Exports stay under a second."]);
const said = keepTrue(db, "app", "t12", [" Each agent's login stays separate. ", "Old exports still open."]);
const view = readTask(db, { repo: "app", task: "t12" });
console.log(JSON.stringify({ said, kept: thread().stay_true, shown: view.mustStayTrue }));`);
  expect(seen.said).toBe(
    "Set what APP-12 must keep true. Every review of it from now on checks each one.",
  );
  const kept = ["Each agent's login stays separate.", "Old exports still open."];
  expect(seen.kept).toEqual(kept);
  expect(seen.shown).toEqual(kept);
});

// The human and the lead can still see what finished work was reviewed against.
test("sc show keeps both lists once the work is done or failed", () => {
  for (const status of ["done", "failed"]) {
    const seen = inProcess(
      `
db.run(\`UPDATE tasks SET decisions = '[{"by":"lead","at":1,"text":"Keep CSV."}]', stay_true = '["Fast.","Small."]'\`);
const view = readTask(db, { repo: "app", task: "t12" });
console.log(JSON.stringify({ decisions: view.decisions, kept: view.mustStayTrue }));`,
      status,
    );
    expect(seen).toEqual({
      decisions: [{ by: "lead", text: "Keep CSV." }],
      kept: ["Fast.", "Small."],
    });
  }
});

test("a task whose work is done takes neither, as its next start begins fresh", () => {
  const seen = inProcess(
    `
console.log(JSON.stringify({
  decided: attempt(() => decide(db, "app", "t12", "Keep CSV.", undefined)),
  kept: attempt(() => keepTrue(db, "app", "t12", ["Fast."])),
  missing: attempt(() => decide(db, "app", "t13", "Keep CSV.", undefined)),
}));`,
    "done",
  );
  expect(seen).toEqual({
    decided: "APP-12 is done already",
    kept: "APP-12 is done already",
    missing: "there is no thread APP-13",
  });
});

// The list is set before the builder starts, so its first submit can't reach a reviewer without it.
test("a thread started with what must stay true holds it from the start, and a restart starts fresh", () => {
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", clone]);
  writeFileSync(join(clone, "skelcrew.yaml"), "setup: []\ntest: []\nlimits: { threads: 9 }\n");
  Bun.spawnSync(["git", "init", "-q", "--bare", join(home, "app.git")]);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { startThread } from ${JSON.stringify(source("flow/builder.ts"))};
import { readThread, record } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, opened, remote, claimed) VALUES ('app', 'simon', 'app', 1, ?, 1)", [${JSON.stringify(`file://${join(home, "app.git")}`)}]);
const keep = [" Old exports still open. ", "Exports stay under a second."];
const thread = await startThread(db, { repo: "app", title: "Add export", body: "As JSON", keep });
const first = readThread(db, thread.folder).stay_true;
record(db, thread.folder, { status: "done" }, "done");
await Bun.sleep(5);
const again = await startThread(db, { repo: "app", task: "t1" });
console.log(JSON.stringify({ first, again: readThread(db, again.folder).stay_true }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString().trim().split("\n").at(-1) ?? "{}")).toEqual({
    first: ["Old exports still open.", "Exports stay under a second."],
    again: [],
  });
});

// A builder must never change what it is reviewed against, so only the lead writes either list.
test("only the lead may record a decision or what must stay true, and two to four of those", () => {
  for (const command of ["decide", "keep true"] as const) {
    expect(allowed.lead).toContain(command);
    expect(allowed.builder).not.toContain(command);
    expect(allowed.review).not.toContain(command);
    expect(allowed.you).not.toContain(command);
  }
  const keep = (items: string[]) =>
    DaemonRequest.safeParse({ command: "keep true", repo: "app", task: "12", items }).success;
  const start = (items: string[]) =>
    DaemonRequest.safeParse({ command: "start", repo: "app", task: "12", keep: items }).success;
  expect(start(["a", "b"])).toBe(true);
  expect(start(["a"])).toBe(false);
  expect(keep(["a", "b", "c", "d"])).toBe(true);
  expect(keep(["a", "b", "c", "d", "e"])).toBe(false);
  expect(keep(["a", "b"])).toBe(true);
  expect(keep(["a"])).toBe(false);
  expect(keep([])).toBe(false);
  expect(keep(["a", " "])).toBe(false);
});
