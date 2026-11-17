// A builder's waiting messages, kept in the database: the lead hears of every message of its own
// that waits too long, and each review or comment a message carries is kept to be marked seen.
// The builder isn't running, as the tmux socket has no server, so every message waits, unless a
// test starts a stand-in builder on that socket.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fakePlugin, source } from "./harness.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-messages-test-")));
});
// The tmux server a test may start, which ends with it.
const socket = `skel-messages-test-${process.pid}`;
afterEach(() => {
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
});

// Runs the code with the database open as `db`, the messages functions imported and app-12
// waiting on its review, and returns what it prints. It takes a process of its own with HOME
// set, as homedir() keeps the HOME this process started with.
function run(body: string): string {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { queueMessage, deliverAllWaiting } from ${JSON.stringify(source("flow/messages.ts"))};
const db = openDb();
const tmux = ${JSON.stringify(socket)};
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
  // Esc can't help a builder that isn't running, so the note doesn't suggest it.
  expect(texts[0]?.text).not.toContain("Esc");
});

test("a new round's drop takes only Skelcrew's notices, not the lead's message or a comment", () => {
  const left = run(`
import { dropOldEvents } from ${JSON.stringify(source("flow/messages.ts"))};
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Merge main.", said: "a conflict", typed_in: [] });
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Check failed.", said: "a failed check", typed_in: [] });
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Comment: CSV too.", said: "a comment", typed_in: [{ kind: "comment", id: "7" }] });
queueMessage(db, tmux, "app-12", { sender: "lead", text: "Use v2.", said: "Use v2.", typed_in: [] });
dropOldEvents(db, tmux, "app-12");
console.log(JSON.stringify(db.query("SELECT said FROM messages ORDER BY id").all()));`);
  expect(JSON.parse(left)).toEqual([{ said: "a comment" }, { said: "Use v2." }]);
});

// A new round can drop a notice while it is being typed in, and the lead's message saved right
// after must still go in, whatever the database numbers it.
test("a lead's message saved while a dropped notice was being typed in still goes in", () => {
  // A stand-in builder, idle at Claude Code's prompt, keeping what is typed into it.
  writeFileSync(
    join(home, "builder.sh"),
    "#!/bin/sh\nprintf '\\033[?2004h'\nstty -echo\necho '❯'\ncat > received.txt\n",
    { mode: 0o755 },
  );
  const left = run(`
import { dropOldEvents } from ${JSON.stringify(source("flow/messages.ts"))};
Bun.spawnSync(["tmux", "-L", tmux, "new-session", "-d", "-s", "app-12", "-c", ${JSON.stringify(home)}, ${JSON.stringify(join(home, "builder.sh"))}]);
await Bun.sleep(300);
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Merge main.", said: "a conflict", typed_in: [] });
await Bun.sleep(100);
dropOldEvents(db, tmux, "app-12");
queueMessage(db, tmux, "app-12", { sender: "lead", text: "Use v2.", said: "Use v2.", typed_in: [] });
// As the daemon does every few seconds.
for (let i = 0; i < 20 && db.query("SELECT 1 FROM messages").get(); i++) {
  deliverAllWaiting(db, tmux);
  await Bun.sleep(500);
}
await Bun.sleep(500);
console.log(JSON.stringify(db.query("SELECT said FROM messages").all()));`);
  expect(JSON.parse(left)).toEqual([]);
  const received = readFileSync(join(home, "received.txt"), "utf8");
  expect(received).toContain("Use v2.");
  expect(received).not.toContain("Merge main.");
});

// A new round can start between the paste of a message and its Enter. The message went in, so
// it must not go in again once typing starts over.
test("a message pasted when a new round's drop cancels typing goes in once", () => {
  // A stand-in builder, idle at Claude Code's prompt, keeping each key as it comes, so the test
  // sees the paste before its Enter.
  writeFileSync(
    join(home, "builder.sh"),
    "#!/bin/sh\nprintf '\\033[?2004h'\nstty raw -echo\necho '❯'\nexec cat > received.txt\n",
    { mode: 0o755 },
  );
  const left = run(`
import { readFileSync, existsSync } from "node:fs";
import { dropOldEvents } from ${JSON.stringify(source("flow/messages.ts"))};
const received = ${JSON.stringify(join(home, "received.txt"))};
const got = () => (existsSync(received) ? readFileSync(received, "utf8") : "");
Bun.spawnSync(["tmux", "-L", tmux, "new-session", "-d", "-s", "app-12", "-c", ${JSON.stringify(home)}, ${JSON.stringify(join(home, "builder.sh"))}]);
await Bun.sleep(300);
queueMessage(db, tmux, "app-12", { sender: "lead", text: "Use v2.", said: "Use v2.", typed_in: [] });
for (let i = 0; i < 200 && !got().includes("Use v2."); i++) await Bun.sleep(10);
if (got().includes("\\r")) throw new Error("the Enter came before the drop");
dropOldEvents(db, tmux, "app-12");
// As the daemon does every few seconds.
for (let i = 0; i < 8; i++) {
  deliverAllWaiting(db, tmux);
  await Bun.sleep(500);
}
const { updates } = db.query("SELECT updates FROM threads").get();
console.log(JSON.stringify({ left: db.query("SELECT 1 FROM messages").all().length, updates: JSON.parse(updates).length }));`);
  expect(JSON.parse(left)).toEqual({ left: 0, updates: 1 });
  const received = readFileSync(join(home, "received.txt"), "utf8");
  expect(received.split("Use v2.").length - 1).toBe(1);
});

// The same words can come in a second comment while the first is being typed in. Both went
// in, so both are marked seen on the PR.
test("a comment that joins a message being typed in is marked seen too", () => {
  const plugin = fakePlugin(home);
  // A stand-in builder, idle at Claude Code's prompt, keeping each key as it comes, so the test
  // sees the paste before its Enter.
  writeFileSync(
    join(home, "builder.sh"),
    "#!/bin/sh\nprintf '\\033[?2004h'\nstty raw -echo\necho '❯'\nexec cat > received.txt\n",
    { mode: 0o755 },
  );
  run(`
import { readFileSync, existsSync } from "node:fs";
db.run("UPDATE repositories SET forge = 'github'");
db.run("UPDATE threads SET pr = 7");
const received = ${JSON.stringify(join(home, "received.txt"))};
const got = () => (existsSync(received) ? readFileSync(received, "utf8") : "");
Bun.spawnSync(["tmux", "-L", tmux, "new-session", "-d", "-s", "app-12", "-c", ${JSON.stringify(home)}, ${JSON.stringify(join(home, "builder.sh"))}]);
await Bun.sleep(300);
const text = "simon commented on the PR: Thanks!";
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text, said: "a comment", typed_in: [{ kind: "comment", id: "1" }] });
for (let i = 0; i < 200 && !got().includes("Thanks!"); i++) await Bun.sleep(10);
if (got().includes("\\r")) throw new Error("the Enter came before the second comment");
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text, said: "a comment", typed_in: [{ kind: "comment", id: "2" }] });
for (let i = 0; i < 100 && db.query("SELECT 1 FROM messages").get(); i++) await Bun.sleep(50);
// The forge is asked in the background.
await Bun.sleep(3000);`);
  const asked = readFileSync(join(plugin, "asked"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((question) => question.ask === "seen");
  expect(asked.map((question) => question.id).sort()).toEqual(["1", "2"]);
  expect(readFileSync(join(home, "received.txt"), "utf8").split("Thanks!").length - 1).toBe(1);
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
