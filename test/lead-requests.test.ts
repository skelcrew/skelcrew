// The lead's requests, against a running daemon: the lead asks with sc ask, you say yes as y in the
// list does, the task starts as sc start would, with what the lead asked for, and the lead hears
// your answer. A shell script stands in for Claude Code as the lead and the builder.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { leadPlaces } from "../src/paths.ts";
import { insideSandbox, read } from "./harness.ts";
import {
  addApp,
  askForLead,
  asLead,
  builder,
  data,
  home,
  lead,
  running,
  serve,
  setUp,
  skel,
  startApp12,
  tearDown,
  until,
} from "./needsyou.ts";

beforeEach(setUp);
afterEach(tearDown);

// Sends your answer to a request of the lead's, as y or n in the list does, and returns the
// daemon's reply.
function answer(id: number, yes: boolean): Promise<unknown> {
  return new Promise((done) => {
    const connection = createConnection(join(home, "run", "skelcrew.sock"));
    let reply = "";
    connection.on("connect", () =>
      connection.write(`${JSON.stringify({ command: "answer", repo: "simon/app", id, yes })}\n`),
    );
    connection.on("data", (more) => {
      reply += more.toString();
    });
    connection.on("close", () => done(JSON.parse(reply)));
  });
}

// A task's thread as Skelcrew keeps it, or null while it has none.
function threadOf(task: string): Record<string, unknown> | null {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT * FROM task_threads WHERE task = ?").get(task);
  db.close();
  return row && typeof row === "object" ? { ...row } : null;
}

// Whether a poll has put issue 12 in Skelcrew's copy of the tracker, where a request finds its
// title.
function hasIssue12(): boolean {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT 1 FROM items WHERE kind = 'task' AND id = '12'").get();
  db.close();
  return row !== null;
}

// Starts the daemon with app, and opens it, so its lead runs, once a poll has read the tracker.
async function openApp(): Promise<void> {
  addApp();
  serve();
  await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
  expect(await askForLead("simon/app")).toContain(leadPlaces("simon", "app").name);
  await until(hasIssue12, 30_000);
}

// bubblewrap can't start inside Skelcrew's own sandbox, so only there leads and builders can't.
describe.skipIf(insideSandbox)("the lead's requests", () => {
  test("a yes to starting an issue starts it from the branch, with the short title and flow asked", async () => {
    await openApp();
    const asked = await asLead([
      ...["ask", "start", "APP-12", "--from", "main"],
      ...["--short", "Export", "--flow", "default"],
    ]);
    expect(asked.err).toBe("");
    expect(asked.out).toBe(
      "Asked the human in the list: Start APP-12 Add export from the branch main? Their answer comes to you as a note.\n",
    );
    expect(threadOf("12")).toBeNull();
    expect(await answer(1, true)).toEqual({ said: "Started APP-12." });
    expect(threadOf("12")).toMatchObject({ base: "main", short: "Export", flow: "default" });
    await until(() => read(join(data(), "claude", "app-12", "args")) !== "", 30_000);
    await until(() =>
      read(join(lead(), "typed")).includes(
        "The human said yes in the list to your request: Start APP-12 Add export from the branch main? Started APP-12.",
      ),
    );
  }, 60_000);

  // A stop of the daemon right after your yes, before its start took effect, leaves the request
  // marked as answered. The daemon starts it as it comes back, and the lead hears.
  test("a yes whose start a stop cut short starts once the daemon is back", async () => {
    addApp();
    const db = new Database(join(data(), "skelcrew.db"));
    db.run(
      `INSERT INTO lead_requests (owner, repo, action, says, made, answered) VALUES
      ('simon', 'app', '{"kind":"start","task":"12","short":"Export"}', 'Start APP-12 Add export?', 1, ?)`,
      [Date.now()],
    );
    db.close();
    serve();
    await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
    expect(await askForLead("simon/app")).toContain(leadPlaces("simon", "app").name);
    await until(() => threadOf("12") !== null, 30_000);
    expect(threadOf("12")).toMatchObject({ short: "Export" });
    await until(() => read(join(data(), "claude", "app-12", "args")) !== "", 30_000);
    await until(() =>
      read(join(lead(), "typed")).includes(
        "Skelcrew stopped partway through the human's yes in the list to your request: Start APP-12 Add export? It did it again: Started APP-12.",
      ),
    );
  }, 60_000);

  // A stop right after your yes to a new task leaves it unfiled, or filed and named on the request.
  // Either way the daemon starts it once as it comes back, with one thread.
  test("a yes to a new task that a stop cut short starts it once the daemon is back", async () => {
    addApp();
    const db = new Database(join(data(), "skelcrew.db"));
    db.run(`INSERT INTO lead_requests (owner, repo, action, says, made, answered) VALUES
      ('simon', 'app', '{"kind":"start new","title":"CSV export","body":"Add it.","short":"CSV"}',
        'Start a new task: CSV export?', 1, 1)`);
    db.close();
    serve();
    await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
    expect(await askForLead("simon/app")).toContain(leadPlaces("simon", "app").name);
    await until(() => threadOf("t1") !== null, 30_000);
    expect(threadOf("t1")).toMatchObject({ title: "CSV export", body: "Add it.", short: "CSV" });
    await until(() =>
      read(join(lead(), "typed")).includes(
        "Skelcrew stopped partway through the human's yes in the list to your request: Start a new task: CSV export? It did it again: Started APP-T1.",
      ),
    );
    expect(threadOf("t2")).toBeNull();
  }, 60_000);

  // A yes that brings back a stopped task, cut short by a stop, is done again as the daemon comes
  // back. The daemon also brings back the builders that ran before the stop, and must not count
  // the one the yes brings back among them, which would start its builder twice.
  test("a yes that brings back a stopped task, cut short by a stop, brings its builder back once", async () => {
    addApp();
    await startApp12();
    expect((await skel(["stop", "app-12"])).err).toBe("");
    for (const run of running.splice(0)) {
      run.kill();
      await run.exited;
    }
    // Each start of a builder from here on is counted, in the builder's own folder, which its
    // sandbox can write.
    const bin = join(home, "bin");
    renameSync(join(bin, "claude"), join(bin, "claude-fake"));
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\necho start >> "$CLAUDE_CONFIG_DIR/starts"\nexec ${join(bin, "claude-fake")} "$@"\n`,
      { mode: 0o755 },
    );
    const db = new Database(join(data(), "skelcrew.db"));
    db.run(`INSERT INTO lead_requests (owner, repo, action, says, made, answered) VALUES
      ('simon', 'app', '{"kind":"start","task":"12"}', 'Start APP-12 Add export?', 1, 1)`);
    db.close();
    serve();
    await until(() => read(join(builder(), "starts")) !== "", 30_000);
    await until(() =>
      read(join(lead(), "typed")).includes(
        "Skelcrew stopped partway through the human's yes in the list to your request: Start APP-12 Add export? It did it again: Started APP-12 again",
      ),
    );
    // Long enough for a second start, had the daemon brought the builder back too.
    await Bun.sleep(3000);
    expect(read(join(builder(), "starts"))).toBe("start\n");
  }, 90_000);

  // A yes that brings back a stopped task keeps its request until the builder is back, so the
  // lead hears that it failed when the builder can't start, rather than that it is back.
  test("a yes that brings back a stopped task whose builder can't start tells the lead it failed", async () => {
    addApp();
    await startApp12();
    expect((await skel(["stop", "app-12"])).err).toBe("");
    // From here on a builder exits as soon as it starts.
    writeFileSync(join(home, "bin", "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const db = new Database(join(data(), "skelcrew.db"));
    db.run(`INSERT INTO lead_requests (owner, repo, action, says, made) VALUES
      ('simon', 'app', '{"kind":"start","task":"12"}', 'Start APP-12 Add export?', 1)`);
    db.close();
    expect(await answer(1, true)).toEqual({
      said: "Started APP-12 again: its builder is back where it was.",
    });
    await until(() => threadOf("12")?.status === "failed", 30_000);
    const failed =
      "The human said yes in the list to your request: Start APP-12 Add export? It failed: ";
    await until(() => read(join(lead(), "typed")).includes(failed), 30_000);
    expect(read(join(lead(), "typed"))).not.toContain("its builder is back where it was");
  }, 60_000);

  // A stop after the yes brought back a stopped task, but before its builder was back, leaves the
  // task live and the request saying what the start did. As the daemon comes back it brings the
  // builder back, as for every live task, and the lead hears only then: here that it failed.
  test("a yes whose bringing back a stop cut short tells the lead how the builder came back", async () => {
    addApp();
    await startApp12();
    expect((await skel(["stop", "app-12"])).err).toBe("");
    for (const run of running.splice(0)) {
      run.kill();
      await run.exited;
    }
    // What the yes left as the daemon stopped: the task live again, and what the start said.
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("UPDATE task_threads SET status = 'working' WHERE task = '12'");
    db.run(
      `INSERT INTO lead_requests (owner, repo, action, says, made, answered, outcome) VALUES
      ('simon', 'app', '{"kind":"start","task":"12"}', 'Start APP-12 Add export?', 1, 1,
        'Started APP-12 again: its builder is back where it was.')`,
    );
    db.close();
    // From here on APP-12's builder exits as soon as it starts, while the lead still starts.
    const bin = join(home, "bin");
    renameSync(join(bin, "claude"), join(bin, "claude-fake"));
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\ncase "$CLAUDE_CONFIG_DIR" in */app-12) exit 1 ;; esac\nexec ${join(bin, "claude-fake")} "$@"\n`,
      { mode: 0o755 },
    );
    serve();
    await until(() => threadOf("12")?.status === "failed", 30_000);
    const failed =
      "Skelcrew stopped partway through the human's yes in the list to your request: Start APP-12 Add export? It failed: ";
    await until(() => read(join(lead(), "typed")).includes(failed), 30_000);
    expect(read(join(lead(), "typed"))).not.toContain("It had done it already");
  }, 60_000);

  test("a yes to a new task starts it with its title, description, short title and flow", async () => {
    await openApp();
    const asked = await asLead([
      ...["ask", "start", "app", "CSV export", "Add a CSV export."],
      ...["--short", "CSV", "--flow", "default"],
    ]);
    expect(asked.out).toBe(
      "Asked the human in the list: Start a new task: CSV export? Their answer comes to you as a note.\n",
    );
    expect(await answer(1, true)).toEqual({ said: "Started APP-T1." });
    expect(threadOf("t1")).toMatchObject({
      title: "CSV export",
      body: "Add a CSV export.",
      short: "CSV",
      flow: "default",
    });
    await until(() =>
      read(join(lead(), "typed")).includes(
        "The human said yes in the list to your request: Start a new task: CSV export? Started APP-T1.",
      ),
    );
  }, 60_000);
});
