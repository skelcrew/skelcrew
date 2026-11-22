// A task's decisions and what its change must keep true, recorded by the lead in a process of the
// test's own against its own database, and shown by sc show.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
const first = decide(db, "app", "12", "Keep CSV only, as it is what users open.", undefined);
const second = decide(db, "app", "12", "Never save provider text.", "no, don't save what the provider says\\n");
const { decisions } = thread();
const view = readTask(db, { repo: "app", task: "12" });
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

test("what must stay true replaces the list it had, and sc show lists it", () => {
  const seen = inProcess(`
keepTrue(db, "app", "12", ["Exports stay under a second."]);
const said = keepTrue(db, "app", "12", [" Each agent's login stays separate. ", "Old exports still open."]);
const view = readTask(db, { repo: "app", task: "12" });
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
const view = readTask(db, { repo: "app", task: "12" });
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
  decided: attempt(() => decide(db, "app", "12", "Keep CSV.", undefined)),
  kept: attempt(() => keepTrue(db, "app", "12", ["Fast."])),
  missing: attempt(() => decide(db, "app", "13", "Keep CSV.", undefined)),
}));`,
    "done",
  );
  expect(seen).toEqual({
    decided: "APP-12 is done already",
    kept: "APP-12 is done already",
    missing: "there is no thread APP-13",
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
  expect(keep(["a", "b", "c", "d"])).toBe(true);
  expect(keep(["a", "b", "c", "d", "e"])).toBe(false);
  expect(keep(["a", "b"])).toBe(true);
  expect(keep(["a"])).toBe(false);
  expect(keep([])).toBe(false);
  expect(keep(["a", " "])).toBe(false);
});
