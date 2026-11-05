// The screen, on real tmux servers of the test's own: agents on one, the screen on a second,
// and a third standing in for your terminal, so a test can press keys and read what you see.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { startSession } from "../src/tmux.ts";

const dbFile = join(import.meta.dir, "..", "src", "db.ts");
const screenFile = join(import.meta.dir, "..", "src", "screen.ts");
const pathNow = process.env.PATH ?? "";
// Longer than the waits below, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
let home = "";
let agents = "";
let screen = "";
let terminal = "";

const env = () => ({ ...process.env, HOME: home });
// Runs tmux on one of the test's servers, never on skel's own.
function tmux(socket: string, ...args: string[]) {
  const run = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args], {
    env: { ...env(), TMUX: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString() };
}

async function until(done: () => boolean, what: string, window = "one") {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}:\n${seen(window)}`);
    await Bun.sleep(30);
  }
}

// What you see in the first terminal, or a second one.
const seen = (window = "one") => tmux(terminal, "capture-pane", "-p", "-t", `=${window}:`).out;
const screenSessions = () =>
  tmux(screen, "list-sessions", "-F", "#{session_name}").out.trim().split("\n").filter(Boolean);

// Starts an agent that says its name, logs what you type and the size of its window.
function agent(name: string): void {
  const script = join(home, `${name}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
cd ${JSON.stringify(home)}
trap 'stty size > ${name}.size' WINCH
stty size > ${name}.size
echo "I am ${name}"
# A resize cuts read short, which must not end the agent.
while :; do read -r line && echo "$line" >> ${name}.typed; done
`,
    { mode: 0o755 },
  );
  startSession(agents, name, { folder: home, command: [script], env: { PATH: pathNow } });
}

// Opens the screen on an agent in a terminal of its own, which logs how skel exited.
function open(session: string, window = "one", term = "xterm-256color", width = "120"): void {
  const script = join(home, `open-${window}.ts`);
  writeFileSync(
    script,
    `import { openScreen } from ${JSON.stringify(screenFile)};
await openScreen(${JSON.stringify(agents)}, ${JSON.stringify(session)});
await Bun.write(${JSON.stringify(join(home, `left-${window}`))}, "left");`,
  );
  const command = `TERM=${term} ${process.execPath} ${script}; sleep 300`;
  tmux(terminal, "new-session", "-d", "-s", window, "-x", width, "-y", "30", command);
}

// Presses keys in a terminal. Text goes as it would from a real one, including escape codes.
const type = (text: string, window = "one") =>
  tmux(terminal, "send-keys", "-t", `=${window}:`, "-l", text);
const press = (key: string, window = "one") =>
  tmux(terminal, "send-keys", "-t", `=${window}:`, key);
// A press and release of the left button at a place on screen, counted from 1.
const click = (x: number, y: number) => type(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);

function sql(statements: string): void {
  const script = `import { openDb } from ${JSON.stringify(dbFile)};
openDb().run(${JSON.stringify(statements)});`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-screen-test-")));
  agents = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  screen = `${agents}-screen`;
  terminal = `${agents}-terminal`;
  sql(`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
INSERT INTO threads (owner, repo, task, folder, branch, status, needs_you) VALUES
  ('simon', 'app', 3, 'app-3', 'skel/3', 'done', 0),
  ('simon', 'app', 7, 'app-7', 'skel/7', 'working', 0),
  ('simon', 'app', 12, 'app-12', 'skel/12', 'working', 0);`);
  agent("lead");
  agent("app-7");
  agent("app-12");
});
afterEach(() => {
  for (const socket of [terminal, screen, agents]) {
    tmux(socket, "kill-server");
    // tmux leaves the socket file behind after kill-server.
    const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    rmSync(join(folder, socket), { force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

// Waits until the screen shows the sidebar and the agent you opened it on.
const ready = (name: string, window = "one") =>
  until(
    () => seen(window).includes(`I am ${name}`) && seen(window).includes("› "),
    "the screen",
    window,
  );

test("shows the lead and every thread that isn't done, beside the agent", async () => {
  open("lead");
  await ready("lead");
  const lines = seen().split("\n");
  expect(lines[0]).toContain("› lead");
  expect(lines[0]).toContain("I am lead");
  expect(lines[1]).toContain("● app-12");
  expect(lines[2]).toContain("● app-7");
  expect(seen()).not.toContain("app-3");
  // Nothing of the screen is left in agents' sessions: each stays one pane.
  const panes = tmux(agents, "list-panes", "-a", "-F", "#{session_name}").out.trim().split("\n");
  expect(panes.sort()).toEqual(["app-12", "app-7", "lead"]);
});

test("Alt-Down and Alt-Up switch the right side, and you type to whichever agent it shows", async () => {
  open("lead");
  await ready("lead");
  press("M-Down");
  await until(() => seen().includes("I am app-12"), "app-12");
  await until(() => seen().includes("› ● app-12"), "the sidebar to follow");
  type("hello\r");
  await until(() => existsSync(join(home, "app-12.typed")), "the typing");
  expect(readFileSync(join(home, "app-12.typed"), "utf8")).toBe("hello\n");
  press("M-Up");
  await until(() => seen().includes("I am lead"), "the lead");
  type("back\r");
  await until(() => existsSync(join(home, "lead.typed")), "the typing");
});

test("clicking a row switches the right side and leaves your typing there", async () => {
  open("lead");
  await ready("lead");
  click(5, 3);
  await until(() => seen().includes("I am app-7"), "app-7");
  type("hello\r");
  await until(() => existsSync(join(home, "app-7.typed")), "the typing");
});

test("skel attach's screen starts on the agent it names, marked in the sidebar", async () => {
  open("app-7");
  await ready("app-7");
  expect(seen()).toContain("› ● app-7");
});

test("updates on its own, with needs you in the sidebar", async () => {
  open("lead");
  await ready("lead");
  sql("UPDATE threads SET needs_you = 1 WHERE task = 7");
  await until(() => seen().includes("? app-7"), "needs you");
  expect(seen()).toContain("needs you");
  sql("UPDATE threads SET status = 'done' WHERE task = 12");
  await until(() => !seen().includes("app-12"), "the done thread to go");
});

test("Ctrl-] leaves the whole screen and ends no agent", async () => {
  open("lead");
  await ready("lead");
  press("C-]");
  await until(() => existsSync(join(home, "left-one")), "skel to return");
  await until(() => screenSessions().length === 0, "the session to end");
  expect(tmux(screen, "list-sessions").ok).toBe(false);
  for (const name of ["lead", "app-7", "app-12"])
    expect(tmux(agents, "has-session", "-t", `=${name}`).ok).toBe(true);
  expect(tmux(agents, "list-clients", "-F", "#{client_tty}").out).toBe("");
});

test("the mouse wheel and a drag over the agent leave you typing to it", async () => {
  open("lead");
  await ready("lead");
  type("\x1b[<64;60;5M\x1b[<64;60;5M\x1b[<65;60;5M");
  type("\x1b[<0;60;5M\x1b[<32;62;6M\x1b[<0;62;6m");
  await Bun.sleep(200);
  const modes = tmux(screen, "list-panes", "-a", "-F", "#{pane_in_mode}").out.trim().split("\n");
  expect(modes).toEqual(["0", "0"]);
  type("hello\r");
  await until(() => existsSync(join(home, "lead.typed")), "the typing");
});

test("resizing the terminal resizes the agent and keeps the sidebar narrow", async () => {
  open("lead");
  await ready("lead");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "30 91\n",
    "the agent's size",
  );
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "40");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "40 121\n",
    "the agent to resize",
  );
  const widths = tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out.trim().split("\n");
  expect(widths).toEqual(["28", "121"]);
  // A terminal shorter than the list keeps the row you are looking at in view.
  press("M-Down");
  press("M-Down");
  await until(() => seen().includes("› ● app-7"), "app-7");
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "2");
  await until(() => seen().startsWith("  ● app-12"), "the sidebar to scroll");
});

test("two terminals each get their own session, and leaving one leaves the other", async () => {
  open("lead", "one");
  await ready("lead", "one");
  open("app-7", "two");
  await ready("app-7", "two");
  expect(screenSessions()).toHaveLength(2);
  press("M-Up", "two");
  await until(() => seen("two").includes("› ● app-12"), "the second to switch", "two");
  expect(seen("one")).toContain("› lead");
  press("C-]", "one");
  await until(() => screenSessions().length === 1, "the first to end");
  press("M-Down", "two");
  await until(() => seen("two").includes("› ● app-7"), "the second to go on working", "two");
});

test("a terminal that just goes leaves no session behind, and no sidebar running", async () => {
  open("lead", "one");
  await ready("lead", "one");
  open("app-7", "two");
  await ready("app-7", "two");
  const sidebars = tmux(screen, "list-panes", "-a", "-F", "#{pane_pid}").out.trim().split("\n");
  tmux(terminal, "kill-session", "-t", "=one");
  await until(() => screenSessions().length === 1, "the session to end");
  tmux(terminal, "kill-session", "-t", "=two");
  await until(() => !tmux(screen, "list-sessions").ok, "the server to end");
  const alive = (pid: string) => existsSync(join("/proc", pid));
  await until(() => !sidebars.some(alive), "the sidebars and clients to end");
  expect(tmux(agents, "has-session", "-t", "=lead").ok).toBe(true);
});

test("when the agent you are looking at ends, the right side goes to the lead", async () => {
  open("app-7");
  await ready("app-7");
  tmux(agents, "kill-session", "-t", "=app-7");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => seen().includes("› lead"), "the sidebar to follow");
});

test("a row whose agent isn't running can't be picked", async () => {
  sql("UPDATE threads SET status = 'stopped' WHERE task = 12");
  tmux(agents, "kill-session", "-t", "=app-12");
  open("lead");
  await ready("lead");
  expect(seen()).toContain("app-12");
  click(5, 2);
  press("M-Down");
  await until(() => seen().includes("I am app-7"), "the row after it");
});

test("opens from a terminal this machine has no description of", async () => {
  // Ghostty over ssh sets TERM=xterm-ghostty, which a server rarely knows, and tmux refuses
  // to attach to a terminal it can't look up.
  open("lead", "one", "xterm-skel-unknown");
  await ready("lead");
  expect(seen()).not.toContain("unsuitable terminal");
});

test("both tmux servers pass synchronized output on, so nesting brings no flicker back", async () => {
  open("lead");
  await ready("lead");
  for (const socket of [screen, agents])
    expect(tmux(socket, "list-clients", "-F", "#{client_termfeatures}").out).toContain("sync");
});

test("a terminal too narrow for a sidebar still shows the agent", async () => {
  open("lead", "one", "xterm-256color", "20");
  await until(() => seen().includes("I am lead"), "the agent");
  expect(seen()).not.toContain("failed");
});

test("without a terminal it fails, and leaves no session or server behind", async () => {
  mkdirSync(join(home, "piped"));
  const script = join(home, "piped", "open.ts");
  writeFileSync(
    script,
    `import { openScreen } from ${JSON.stringify(screenFile)};
await openScreen(${JSON.stringify(agents)}, "lead");`,
  );
  const run = Bun.spawnSync([process.execPath, script], {
    env: { ...env(), TMUX: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.success).toBe(false);
  expect(run.stderr.toString()).toContain("terminal");
  expect(tmux(screen, "list-sessions").ok).toBe(false);
});
