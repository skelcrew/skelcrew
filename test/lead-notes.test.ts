// What reaches a repository's lead, and when: a builder's last message at the end of a turn,
// unless it told the lead in that turn, and the notes and messages that wait while the human
// reads further up in the lead's chat or has a draft at its prompt, then go in together. A shell
// script stands in for the lead, idle at Claude Code's prompt, on a tmux server of the test's own.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { source, threadSql } from "./harness.ts";

let home = "";
// The test's tmux servers: the agents', and one whose terminal watches the lead, as the screen's
// right pane does.
const socket = `skel-lead-notes-test-${process.pid}`;
const view = `${socket}-view`;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-lead-notes-test-")));
  // The stand-in lead shows a person's unsent draft at its prompt while the file draft is in
  // its folder, and keeps what is typed into it in received.txt.
  writeFileSync(
    join(home, "lead.sh"),
    `#!/bin/sh
printf '\\033[?2004h'
stty -echo
# A shell gives a command run in the background /dev/null as its input, unless told.
exec 3<&0
cat <&3 > received.txt &
while true; do
  now=idle; test -e draft && now=draft
  if [ "$now" != "$shown" ]; then
    clear; if [ $now = draft ]; then echo '❯ half a thought'; else echo '❯'; fi; shown=$now
  fi
  sleep 0.1
done
`,
    { mode: 0o755 },
  );
});
afterEach(() => {
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  for (const server of [view, socket]) {
    Bun.spawnSync(["tmux", "-L", server, "kill-server"], { stderr: "pipe" });
    rmSync(join(folder, server), { force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

// Runs the code with the database open as `db`, simon/app and its thread app-12 in it, and
// returns what it prints. `lead()` starts the stand-in lead, `watch()` has a terminal watch it,
// `tmuxLead(...)` runs tmux on the lead's pane, and `received()` is what was typed into it. It
// takes a process of its own with HOME set, as homedir() keeps the HOME this process started
// with.
function run(body: string): string {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { leadOf } from ${JSON.stringify(source("flow/lead.ts"))};
import { messageLead, noteForLead } from ${JSON.stringify(source("flow/messages.ts"))};
import { turnEnded } from ${JSON.stringify(source("flow/status.ts"))};
import { readThread, record } from ${JSON.stringify(source("flow/thread.ts"))};
import { existsSync, readFileSync } from "node:fs";
const db = openDb();
db.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
${threadSql({ task: "12", status: "working" })}\`);
const tmux = ${JSON.stringify(socket)};
const home = ${JSON.stringify(home)};
const { name } = leadOf(db, "simon", "app");
const app = { owner: "simon", repo: "app" };
const tmuxLead = (command, ...args) =>
  Bun.spawnSync(["tmux", "-L", tmux, command, "-t", "=" + name + ":", ...args]).stdout.toString();
const received = () => (existsSync(home + "/received.txt") ? readFileSync(home + "/received.txt", "utf8") : "");
const waiting = () => db.query("SELECT COUNT(*) AS n FROM notes").get().n;
async function until(done) {
  for (let i = 0; i < 300 && !done(); i++) await Bun.sleep(50);
  if (!done()) throw new Error("gave up waiting");
}
async function lead() {
  Bun.spawnSync(["tmux", "-L", tmux, "new-session", "-d", "-s", name, "-c", home, home + "/lead.sh"]);
  await until(() => tmuxLead("capture-pane", "-p").includes("❯"));
}
async function watch() {
  const attach = "env -u TMUX tmux -L " + tmux + " attach -t =" + name;
  Bun.spawnSync(["tmux", "-L", ${JSON.stringify(view)}, "new-session", "-d", "-x", "100", "-y", "30", attach]);
  await until(() => tmuxLead("display-message", "-p", "#{session_attached}").trim() === "1");
}
${body}`;
  const done = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!done.success) throw new Error(done.stderr.toString());
  return done.stdout.toString();
}

// The lead's session isn't running here, so what the lead is sent stays saved, to be read back.
test("a turn in which the builder told the lead forwards nothing more at its end", () => {
  const notes = run(`
messageLead(db, tmux, readThread(db, "app-12"), "Already fixed.");
turnEnded(db, tmux, "app-12", { message: "I told the lead." });
// A turn after it, with nothing typed in, such as when a background task ends, forwards again.
turnEnded(db, tmux, "app-12", { message: "Should it use JSON or YAML?" });
console.log(JSON.stringify(db.query("SELECT text FROM notes ORDER BY id").all().map((n) => n.text)));`);
  const texts: string[] = JSON.parse(notes);
  expect(texts).toHaveLength(2);
  expect(texts[0]).toContain("Already fixed.");
  expect(texts[1]).toContain(
    "My turn ended without a submit, saying:\n\nShould it use JSON or YAML?",
  );
  expect(texts.join("\n")).not.toContain("I told the lead.");
});

// A paste while the human reads further up would throw them back to the bottom. Back at the
// bottom, everything that waited goes in as one message, once. A thread needing you goes first,
// though it came last, then the builder's message, then Skelcrew's routine note.
test("messages for a lead the human has scrolled back in wait, then go in together", () => {
  const seen = JSON.parse(
    run(`
await lead();
await watch();
tmuxLead("copy-mode");
noteForLead(db, tmux, app, "started app-13 from github: Add import");
messageLead(db, tmux, readThread(db, "app-12"), "First part done.");
record(db, "app-12", { asking: true }, "its builder asked a question");
await Bun.sleep(3000);
const during = { received: received(), scrolled: tmuxLead("display-message", "-p", "#{pane_in_mode}").trim() };
tmuxLead("send-keys", "-X", "cancel");
await until(() => waiting() === 0 && received().includes("First part done."));
await Bun.sleep(1000);
console.log(JSON.stringify({ during, after: received(), noting: readThread(db, "app-12").noting }));`),
  );
  expect(seen.during).toEqual({ received: "", scrolled: "1" });
  const typed: string = seen.after;
  expect(typed.split("\x1b[201~")).toHaveLength(2);
  const needs = typed.indexOf("app-12 needs you: its builder asked a question");
  const started = typed.indexOf("started app-13 from github: Add import");
  expect(needs).toBeGreaterThan(-1);
  expect(needs).toBeLessThan(typed.indexOf("First part done."));
  expect(typed.indexOf("First part done.")).toBeLessThan(started);
  expect(seen.noting).toBeNull();
});

// Copy mode stays on a pane nobody watches, such as a lead you left for a builder from there.
// Its messages aren't held until you come back.
test("messages for a lead left scrolled back, that nobody watches, go in", () => {
  const typed = run(`
await lead();
tmuxLead("copy-mode");
noteForLead(db, tmux, app, "started app-13 from github: Add import");
await until(() => received().includes("Add import"));
console.log(received());`);
  expect(typed).toContain("started app-13 from github: Add import");
});

test("a person's unsent draft at the lead's prompt holds its messages", () => {
  const seen = JSON.parse(
    run(`
await lead();
Bun.write(home + "/draft", "");
await until(() => tmuxLead("capture-pane", "-p").includes("half a thought"));
noteForLead(db, tmux, app, "started app-13 from github: Add import");
await Bun.sleep(3000);
const during = received();
(await import("node:fs")).rmSync(home + "/draft");
await until(() => received().includes("Add import"));
console.log(JSON.stringify({ during }));`),
  );
  expect(seen.during).toBe("");
});

// Typing can wait a long while, such as on a draft. Scrolling back meanwhile still holds the
// messages, and a question answered meanwhile is no longer announced.
test("scrolling back while the lead's messages wait on a draft holds them, and an answered question drops out", () => {
  const seen = JSON.parse(
    run(`
await lead();
await watch();
Bun.write(home + "/draft", "");
await until(() => tmuxLead("capture-pane", "-p").includes("half a thought"));
record(db, "app-12", { asking: true }, "its builder asked a question");
messageLead(db, tmux, readThread(db, "app-12"), "First part done.");
await Bun.sleep(1500);
tmuxLead("copy-mode");
record(db, "app-12", { asking: false }, "its builder's question is over");
(await import("node:fs")).rmSync(home + "/draft");
await Bun.sleep(3000);
const during = { received: received(), scrolled: tmuxLead("display-message", "-p", "#{pane_in_mode}").trim() };
tmuxLead("send-keys", "-X", "cancel");
await until(() => waiting() === 0 && received().includes("First part done."));
await Bun.sleep(1000);
console.log(JSON.stringify({ during, after: received() }));`),
  );
  expect(seen.during).toEqual({ received: "", scrolled: "1" });
  expect(seen.after.split("\x1b[201~")).toHaveLength(2);
  expect(seen.after).not.toContain("needs you");
});
