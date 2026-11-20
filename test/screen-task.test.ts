// The screen's right side on a task's row: its details with the builder's screen live under them,
// read-only, and Enter's attachment to the builder there, which Ctrl-\ comes back from.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { source } from "./harness.ts";
import {
  agents,
  daemon,
  endTest,
  env,
  home,
  open,
  press,
  read,
  ready,
  screen,
  screenSessions,
  sql,
  startTest,
  tmux,
  type,
  until,
} from "./screen.ts";

// Longer than the waits below, so a test that fails says what it waited for.
setDefaultTimeout(30_000);
beforeEach(() => {
  startTest();
  daemon();
});
afterEach(endTest);

// The screen's session, of the one terminal these tests open.
const session = () => screenSessions()[0] ?? "";
// What the right side shows, and which of the screen's panes your typing goes to: 0 is the
// sidebar, 1 the right side.
const right = () => tmux(screen, "capture-pane", "-p", "-t", `=${session()}:.1`).out;
const typingTo = () =>
  tmux(screen, "display-message", "-p", "-t", `=${session()}:`, "#{pane_index}").out.trim();

// Does what the sidebar does on a task's row, by the row's name, as a process of its own with the
// test's home: `show` shows the task's details, and `attach` attaches to its builder, which
// prints why it couldn't, if it couldn't.
function onRow(action: "show" | "attach", name: string): string {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { listRows } from ${JSON.stringify(source("list/rows.ts"))};
import { attachTask, showTask } from ${JSON.stringify(source("screen/task.ts"))};
const agents = ${JSON.stringify(agents)};
const session = ${JSON.stringify(session())};
if (${JSON.stringify(action)} === "show") showTask(agents, session, "simon/app", ${JSON.stringify(name)});
else {
  const row = listRows(openDb(), { owner: "simon", repo: "app" }, Date.now()).find((one) => one.name === ${JSON.stringify(name)});
  if (!row) throw new Error("no row");
  console.log((await attachTask(agents, session, "simon/app", row)) ?? "");
}`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

// Opens the screen on the lead, then moves the right side to app-7's details.
async function onApp7(): Promise<void> {
  sql("UPDATE tasks SET title = 'Login redirect' WHERE task = '7'");
  open("lead");
  await ready("lead");
  onRow("show", "app-7");
  await until(() => right().includes("Login redirect"), "app-7's details");
}

test("a task's row shows its details with its builder live under them, and typing never reaches it", async () => {
  await onApp7();
  expect(right()).toContain("Building · working");
  await until(() => right().includes("I am app-7"), "app-7's screen, live");
  expect(typingTo()).toBe("0");
  // What app-7 prints next reaches the right side without attaching.
  tmux(agents, "send-keys", "-t", "=app-7:", "-l", "first line\r");
  await until(() => right().includes("first line"), "app-7's new line");
  type("hello\r");
  await Bun.sleep(500);
  expect(read("app-7.typed")).toBe("first line\n");
});

test("Enter attaches the right side to the builder, and Ctrl-\\ comes back to its details", async () => {
  await onApp7();
  expect(onRow("attach", "app-7")).toBe("");
  await until(() => typingTo() === "1", "typing to move to the builder");
  type("hi\r");
  await until(() => read("app-7.typed") === "hi\n", "what was typed");
  press("C-\\");
  await until(() => right().includes("Building · working"), "app-7's details again");
  expect(typingTo()).toBe("0");
  // Ctrl-\ again does nothing, and the builder got none of it.
  press("C-\\");
  type("x\r");
  await Bun.sleep(500);
  expect(right()).toContain("Login redirect");
  expect(read("app-7.typed")).toBe("hi\n");
});

test("moving to another row while attached comes back from the builder, and shows that row", async () => {
  await onApp7();
  onRow("attach", "app-7");
  await until(() => typingTo() === "1", "typing to move to the builder");
  onRow("show", "app-12");
  await until(() => right().includes("I am app-12"), "app-12's details");
  expect(typingTo()).toBe("0");
  expect(tmux(agents, "list-clients").out).not.toContain("app-7");
});

test("Ctrl-\\ on the lead or a task's details does nothing", async () => {
  open("lead");
  await ready("lead");
  press("C-\\");
  type("on the lead\r");
  await until(() => read("lead.typed") === "on the lead\n", "what reached the lead");
  onRow("show", "app-7");
  await until(() => right().includes("I am app-7"), "app-7's details");
  press("C-\\");
  await Bun.sleep(500);
  expect(right()).toContain("I am app-7");
});

test("Enter on a task whose builder isn't running says so, and attaches to nothing", async () => {
  sql("UPDATE threads SET status = 'stopped' WHERE folder = 'app-7'");
  await onApp7();
  expect(right()).toContain("Builder not running");
  expect(onRow("attach", "app-7")).toBe(
    "app-7's builder isn't running: sc start app-7 brings it back",
  );
  expect(typingTo()).toBe("0");
});

// The host's attach logs what it read, and ends once it reads a line.
test("a builder on a plugin's host attaches through its attach, never gets Ctrl-\\, and its end brings the details back", async () => {
  const plugin = join(home, "plugin-fake");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "attach.sh"),
    `echo "I am $1 on fake"; read -r line; printf '%s' "$line" > ${join(home, "host.typed")}\n`,
  );
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    "name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: A host\nkind: runtime\nprovides: [sessions]\nsession: [sh, session.sh]\nattach: [sh, attach.sh]\n",
  );
  sql(`INSERT INTO plugins (name, folder) VALUES ('fake', '${plugin}');
UPDATE threads SET host = 'fake', host_id = 'fake-app-7' WHERE folder = 'app-7'`);
  await onApp7();
  for (const leave of ["Ctrl-\\", "its end"]) {
    expect(onRow("attach", "app-7")).toBe("");
    await until(() => right().includes("I am fake-app-7 on fake"), "the host's attach");
    expect(typingTo()).toBe("1");
    if (leave === "Ctrl-\\") press("C-\\");
    else type("bye\r");
    await until(() => right().includes("Login redirect"), `the details again, after ${leave}`);
    expect(typingTo()).toBe("0");
  }
  // Only the line that ended it reached the host, and no Ctrl-\.
  expect(read("host.typed")).toBe("bye");
});
