// A builder's waiting messages, kept in the database: the lead hears of every message of its own
// that waits too long, and each review or comment a message carries is kept to be marked seen.
// The builder isn't running, as the tmux socket has no server, so every message waits.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-messages-test-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Runs the code with the database open as `db`, the messages functions imported and app-12
// waiting on its review, and returns what it prints. It takes a process of its own with HOME
// set, as homedir() keeps the HOME this process started with.
function run(body: string): string {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { queueMessage, deliverAllWaiting } from ${JSON.stringify(source("flow/messages.ts"))};
const db = openDb();
const tmux = ${JSON.stringify(`skel-messages-test-${process.pid}`)};
db.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
INSERT INTO threads (owner, repo, task, folder, branch, status)
  VALUES ('simon', 'app', 12, 'app-12', 'skelcrew/12', 'waiting')\`);
${body}`;
  const done = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!done.success) throw new Error(done.stderr.toString());
  return done.stdout.toString();
}

test("a lead's message waiting behind one of Skelcrew's still brings the lead its note", () => {
  const notes = run(`
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Merge main.", said: "a conflict", typed_in: [] });
queueMessage(db, tmux, "app-12", { sender: "lead", text: "Use v2.", said: "Use v2.", typed_in: [] });
db.run("UPDATE messages SET at = at - 11 * 60000");
deliverAllWaiting(db, tmux);
await Bun.sleep(1500);
deliverAllWaiting(db, tmux);
await Bun.sleep(1500);
console.log(JSON.stringify(db.query("SELECT text FROM notes").all()));`);
  const texts: { text: string }[] = JSON.parse(notes);
  expect(texts).toHaveLength(1);
  expect(texts[0]?.text).toContain(
    "app-12's builder hasn't got your message after 10 minutes: its builder isn't running",
  );
});

test("two comments with the same words both stay to be marked seen", () => {
  const kept = run(`
const text = "Comment from simon: Thanks!";
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text, said: "a comment", typed_in: [{ kind: "comment", id: "1" }] });
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text, said: "a comment", typed_in: [{ kind: "comment", id: "2" }] });
console.log(JSON.stringify(db.query("SELECT typed_in FROM messages").all()));`);
  expect(JSON.parse(kept)).toEqual([
    {
      typed_in: JSON.stringify([
        { kind: "comment", id: "1" },
        { kind: "comment", id: "2" },
      ]),
    },
  ]);
});
