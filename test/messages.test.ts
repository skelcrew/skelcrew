// A builder's waiting messages, kept in the database: the lead hears of every message of its own
// that waits too long, and each review or comment a message carries is kept to be marked seen.
// The builder isn't running, as the tmux socket has no server, so every message waits, unless a
// test starts a stand-in builder on that socket.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fakePlugin, source, threadSql } from "./harness.ts";

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
// set, as homedir() keeps the HOME this process started with. `again` runs it on the database a
// run before left, as a daemon starting again would. `env` adds to the process's environment.
// Each deliverAllWaiting the code awaits is one whole attempt, as the daemon makes every few
// seconds.
function run(body: string, again = false, env: Record<string, string> = {}): string {
  const setup = `db.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
${threadSql({ task: "12", status: "waiting" })}\`);`;
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { queueMessage, deliverAllWaiting, deliverMessages } from ${JSON.stringify(source("flow/messages.ts"))};
const db = openDb();
const tmux = ${JSON.stringify(socket)};
${again ? "" : setup}
${body}`;
  const done = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home, ...env },
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
await deliverAllWaiting(db, tmux);
await deliverAllWaiting(db, tmux);
console.log(JSON.stringify(db.query("SELECT text FROM notes").all()));`);
  const texts: { text: string }[] = JSON.parse(notes);
  expect(texts).toHaveLength(1);
  expect(texts[0]?.text).toContain(
    "app-12's builder hasn't got your message after 10 minutes: its builder isn't running",
  );
  // Esc can't help a builder that isn't running, so the note doesn't suggest it.
  expect(texts[0]?.text).not.toContain("Esc");
});

// The builder may be missing this long, in milliseconds, before the thread needs you, rather
// than the ten seconds the daemon gives it.
const missing = { SKELCREW_MISSING_WAIT_MS: "500" };

// A review's changes wait while the builder is mid-turn, and then its session ends. A session
// that is gone counts over a screen that last looked busy, so the thread needs you.
test("a builder whose session ends mid-turn, with a review's changes waiting, makes the thread need you", () => {
  // A stand-in builder mid-turn, whose status line redraws as Claude Code's does.
  writeFileSync(
    join(home, "busy.sh"),
    '#!/bin/sh\nwhile true; do echo "esc to interrupt $(date +%N)"; sleep 0.2; done\n',
    { mode: 0o755 },
  );
  const seen = run(
    `
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
Bun.spawnSync(["tmux", "-L", tmux, "new-session", "-d", "-s", "app-12", ${JSON.stringify(join(home, "busy.sh"))}]);
await Bun.sleep(300);
db.run("UPDATE threads SET status = 'working'");
db.run("UPDATE tasks SET telling = 'Fix it.'");
queueMessage(db, tmux, "app-12", { sender: "review", text: "Fix it.", said: "the review's changes", typed_in: [] });
// Each attempt finds it busy for longer than it may be missing.
for (let i = 0; i < 4; i++) {
  await deliverAllWaiting(db, tmux);
  await Bun.sleep(200);
}
const before = readThread(db, "app-12").needs_you;
Bun.spawnSync(["tmux", "-L", tmux, "kill-session", "-t", "=app-12"]);
for (let i = 0; i < 100 && !readThread(db, "app-12").needs_you; i++) {
  await deliverAllWaiting(db, tmux);
  await Bun.sleep(50);
}
const thread = readThread(db, "app-12");
console.log(JSON.stringify({ before, after: thread.needs_you, telling: thread.telling }));`,
    false,
    missing,
  );
  expect(JSON.parse(seen)).toEqual({ before: false, after: true, telling: "Fix it." });
}, 40_000);

// A conflict took an approved PR out of ready to merge, and its message waits for a builder
// that is missing. The thread needs you for that, but its PR still conflicts, so it isn't ready.
test("a missing builder makes an approved PR that conflicts need you, not ready to merge", () => {
  const seen = run(
    `
import { threadWord } from ${JSON.stringify(source("flow/status.ts"))};
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
db.run("UPDATE tasks SET verdict = 'approve', checks = 'passing', conflicts = 'main', pr = 7");
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Merge main.", said: "a conflict", typed_in: [] });
for (let i = 0; i < 100 && !readThread(db, "app-12").needs_you; i++) {
  await deliverAllWaiting(db, tmux);
  await Bun.sleep(50);
}
const thread = readThread(db, "app-12");
console.log(JSON.stringify({ needsYou: thread.needs_you, word: threadWord(thread, 3) }));`,
    false,
    missing,
  );
  expect(JSON.parse(seen)).toEqual({ needsYou: true, word: "needs you" });
});

test("a new round's drop takes only Skelcrew's notices and the review's changes, not the lead's message or a comment", () => {
  const left = run(`
import { dropOldEvents } from ${JSON.stringify(source("flow/messages.ts"))};
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Merge main.", said: "a conflict", typed_in: [] });
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Check failed.", said: "a failed check", typed_in: [] });
queueMessage(db, tmux, "app-12", { sender: "review", text: "Add a test.", said: "the review's changes", typed_in: [] });
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Comment: CSV too.", said: "a comment", typed_in: [{ kind: "comment", id: "7" }] });
queueMessage(db, tmux, "app-12", { sender: "lead", text: "Use v2.", said: "Use v2.", typed_in: [] });
dropOldEvents(db, tmux, "app-12");
console.log(JSON.stringify(db.query("SELECT said FROM messages ORDER BY id").all()));`);
  expect(JSON.parse(left)).toEqual([{ said: "a comment" }, { said: "Use v2." }]);
});

// Right after a message goes in, the builder's screen can still show a bare prompt before its
// status line draws. Its harness's hooks already say a turn runs, so the next message waits for
// the turn's end.
test("a message waits while the builder's hooks say a turn runs, though its screen looks idle", () => {
  // A stand-in builder, idle at Claude Code's prompt, keeping what is typed into it.
  writeFileSync(
    join(home, "builder.sh"),
    "#!/bin/sh\nprintf '\\033[?2004h'\nstty -echo\necho '❯'\ncat > received.txt\n",
    { mode: 0o755 },
  );
  const seen = run(`
import { readFileSync, existsSync } from "node:fs";
const received = ${JSON.stringify(join(home, "received.txt"))};
const got = () => (existsSync(received) ? readFileSync(received, "utf8") : "");
Bun.spawnSync(["tmux", "-L", tmux, "new-session", "-d", "-s", "app-12", "-c", ${JSON.stringify(home)}, ${JSON.stringify(join(home, "builder.sh"))}]);
await Bun.sleep(300);
db.run("UPDATE threads SET state = 'working'");
queueMessage(db, tmux, "app-12", { sender: "lead", text: "Use v2.", said: "Use v2.", typed_in: [] });
for (let i = 0; i < 4; i++) await deliverAllWaiting(db, tmux);
// A line typed after the attempts comes after anything they typed, so once the builder kept it,
// it kept whatever they typed too.
Bun.spawnSync(["tmux", "-L", tmux, "send-keys", "-t", "=app-12:", "-l", "attempts over\\r"]);
for (let i = 0; i < 200 && !got().includes("attempts over"); i++) await Bun.sleep(10);
if (!got().includes("attempts over")) throw new Error("the builder never kept the line");
const during = got().includes("Use v2.");
// The turn's Stop hook ran.
db.run("UPDATE threads SET state = 'idle'");
for (let i = 0; i < 100 && !got().includes("Use v2."); i++) {
  await deliverAllWaiting(db, tmux);
  await Bun.sleep(50);
}
console.log(JSON.stringify({ during, after: got().includes("Use v2.") }));`);
  expect(JSON.parse(seen)).toEqual({ during: false, after: true });
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
import { readFileSync, existsSync } from "node:fs";
import { dropOldEvents } from ${JSON.stringify(source("flow/messages.ts"))};
const received = ${JSON.stringify(join(home, "received.txt"))};
const got = () => (existsSync(received) ? readFileSync(received, "utf8") : "");
Bun.spawnSync(["tmux", "-L", tmux, "new-session", "-d", "-s", "app-12", "-c", ${JSON.stringify(home)}, ${JSON.stringify(join(home, "builder.sh"))}]);
await Bun.sleep(300);
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Merge main.", said: "a conflict", typed_in: [] });
await Bun.sleep(100);
dropOldEvents(db, tmux, "app-12");
queueMessage(db, tmux, "app-12", { sender: "lead", text: "Use v2.", said: "Use v2.", typed_in: [] });
// As the daemon does every few seconds.
for (let i = 0; i < 100 && db.query("SELECT 1 FROM messages").get(); i++) {
  await deliverAllWaiting(db, tmux);
  await Bun.sleep(50);
}
// The builder keeps what it got once its Enter reaches it.
for (let i = 0; i < 200 && !got().includes("Use v2."); i++) await Bun.sleep(10);
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
// As the daemon does every few seconds, and twice more once none waits, so a second paste
// would have had its chance.
for (let i = 0; i < 100 && db.query("SELECT 1 FROM messages").get(); i++) {
  await deliverAllWaiting(db, tmux);
  await Bun.sleep(50);
}
await deliverAllWaiting(db, tmux);
await deliverAllWaiting(db, tmux);
const { updates } = db.query("SELECT updates FROM tasks").get();
console.log(JSON.stringify({ left: db.query("SELECT 1 FROM messages").all().length, updates: JSON.parse(updates).length }));`);
  expect(JSON.parse(left)).toEqual({ left: 0, updates: 1 });
  const received = readFileSync(join(home, "received.txt"), "utf8");
  expect(received.split("Use v2.").length - 1).toBe(1);
});

// The builder can ask you a question between a message's paste and its Enter. The Enter would
// answer it, so the message is left at the prompt, still waiting, and sent once the question is
// over, with no second paste.
test("a question asked between a message's paste and its Enter leaves it unsent until it is over", () => {
  // A stand-in builder, idle at Claude Code's prompt, showing what is typed after it as a draft
  // and keeping each key as it comes, so the test sees the paste before its Enter.
  writeFileSync(
    join(home, "builder.sh"),
    "#!/bin/sh\nprintf '\\033[?2004h'\nstty raw\nprintf '❯ '\nexec cat > received.txt\n",
    { mode: 0o755 },
  );
  const seen = run(`
import { readFileSync, existsSync } from "node:fs";
import { forQuestion } from ${JSON.stringify(source("agents/transport.ts"))};
import { stopDelivering } from ${JSON.stringify(source("flow/messages.ts"))};
const received = ${JSON.stringify(join(home, "received.txt"))};
const got = () => (existsSync(received) ? readFileSync(received, "utf8") : "");
const count = () => db.query("SELECT 1 FROM messages").all().length;
Bun.spawnSync(["tmux", "-L", tmux, "new-session", "-d", "-s", "app-12", "-c", ${JSON.stringify(home)}, ${JSON.stringify(join(home, "builder.sh"))}]);
await Bun.sleep(300);
queueMessage(db, tmux, "app-12", { sender: "lead", text: "Use v2.", said: "Use v2.", typed_in: [] });
for (let i = 0; i < 200 && !got().includes("Use v2."); i++) await Bun.sleep(10);
if (got().includes("\\r")) throw new Error("the Enter came before the question");
// As the daemon does when the builder's hook says it asked a question.
db.run("UPDATE threads SET asking = 1");
stopDelivering(db, "app-12", false, forQuestion);
// Once the cancelled attempt ends, nothing presses Enter. Keys it sent reach the builder soon
// after.
await deliverMessages(db, tmux, "app-12");
await Bun.sleep(200);
const during = { entered: got().includes("\\r"), waiting: count() };
// The question is over.
db.run("UPDATE threads SET asking = 0");
for (let i = 0; i < 100 && count() > 0; i++) {
  await deliverAllWaiting(db, tmux);
  await Bun.sleep(50);
}
for (let i = 0; i < 200 && !got().endsWith("\\r"); i++) await Bun.sleep(10);
const { updates } = db.query("SELECT updates FROM tasks").get();
console.log(JSON.stringify({ during, waiting: count(), updates: JSON.parse(updates).length }));`);
  expect(JSON.parse(seen)).toEqual({
    during: { entered: false, waiting: 1 },
    waiting: 0,
    updates: 1,
  });
  const received = readFileSync(join(home, "received.txt"), "utf8");
  expect(received.split("Use v2.").length - 1).toBe(1);
  expect(received).toEndWith("\r");
});

// Skelcrew can start again while a message sits pasted at the prompt for a question. It still
// knows the draft for its own message, so a new round keeps it and, once the question is over,
// it goes in with Enter alone, instead of blocking every message after it as a person's draft.
test("a message left pasted for a question goes in once it is over, after the daemon starts again", () => {
  // A stand-in builder, idle at Claude Code's prompt, showing what is typed after it as a draft
  // until its Enter brings a fresh prompt, and keeping each key as it comes.
  writeFileSync(
    join(home, "builder.ts"),
    `import { appendFileSync } from "node:fs";
process.stdout.write("\\x1b[?2004h❯ ");
process.stdin.setRawMode(true);
process.stdin.on("data", (keys) => {
  appendFileSync("received.txt", keys);
  process.stdout.write(keys.toString().replaceAll("\\r", "\\r\\n❯ "));
});`,
  );
  writeFileSync(join(home, "builder.sh"), `#!/bin/sh\nexec ${process.execPath} builder.ts\n`, {
    mode: 0o755,
  });
  const reading = `import { readFileSync, existsSync } from "node:fs";
const received = ${JSON.stringify(join(home, "received.txt"))};
const got = () => (existsSync(received) ? readFileSync(received, "utf8") : "");
const count = () => db.query("SELECT 1 FROM messages").all().length;`;
  run(`
${reading}
import { forQuestion } from ${JSON.stringify(source("agents/transport.ts"))};
import { stopDelivering } from ${JSON.stringify(source("flow/messages.ts"))};
Bun.spawnSync(["tmux", "-L", tmux, "new-session", "-d", "-s", "app-12", "-c", ${JSON.stringify(home)}, ${JSON.stringify(join(home, "builder.sh"))}]);
await Bun.sleep(300);
queueMessage(db, tmux, "app-12", { sender: "skelcrew", text: "Merge main.", said: "a conflict", typed_in: [] });
for (let i = 0; i < 200 && !got().includes("Merge main."); i++) await Bun.sleep(10);
if (got().includes("\\r")) throw new Error("the Enter came before the question");
db.run("UPDATE threads SET asking = 1");
stopDelivering(db, "app-12", false, forQuestion);
// The cancelled attempt saves the draft as it ends.
await deliverMessages(db, tmux, "app-12");`);
  const seen = run(
    `
${reading}
import { dropOldEvents } from ${JSON.stringify(source("flow/messages.ts"))};
dropOldEvents(db, tmux, "app-12");
queueMessage(db, tmux, "app-12", { sender: "lead", text: "Use v2.", said: "Use v2.", typed_in: [] });
db.run("UPDATE threads SET asking = 0");
for (let i = 0; i < 100 && count() > 0; i++) {
  await deliverAllWaiting(db, tmux);
  await Bun.sleep(50);
}
for (let i = 0; i < 200 && !got().includes("Use v2."); i++) await Bun.sleep(10);
console.log(JSON.stringify({ waiting: count() }));`,
    true,
  );
  expect(JSON.parse(seen)).toEqual({ waiting: 0 });
  const received = readFileSync(join(home, "received.txt"), "utf8");
  expect(received.split("Merge main.").length - 1).toBe(1);
  expect(received.split("Use v2.").length - 1).toBe(1);
  // The conflict's Enter came before the lead's message was pasted.
  expect(received.indexOf("\r")).toBeLessThan(received.indexOf("Use v2."));
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
db.run("UPDATE tasks SET pr = 7");
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
// The forge is asked in the background, so this waits until it was asked twice.
const asked = ${JSON.stringify(join(plugin, "asked"))};
const seen = () => (existsSync(asked) ? readFileSync(asked, "utf8").split('"ask":"seen"').length - 1 : 0);
for (let i = 0; i < 300 && seen() < 2; i++) await Bun.sleep(10);`);
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
