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
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import checkout from "../package.json";
import { startSession, stillRunning, tmuxIsAtLeast } from "../src/agents/tmux.ts";
import type { Page } from "../src/flow/page.ts";
import { leadPlaces } from "../src/paths.ts";
import { drawPage } from "../src/screen/page.ts";
import { sidebarWidth } from "../src/screen/screen.ts";
import { fakePlugin, itemSql, source, until as wait } from "./harness.ts";

const dbFile = source("db.ts");
const screenFile = source("screen/screen.ts");
const pathNow = process.env.PATH ?? "";
const sidebar = sidebarWidth;
const leaving = "Your agents keep running. Run sc to come back.";
// Longer than the waits below, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
let home = "";
let standIn: Server | null = null;
let agents = "";
let screen = "";
let terminal = "";

// The sockets are the test's own too, as a sidebar tells whatever daemon it finds that it opened.
const env = () => ({ ...process.env, HOME: home, XDG_RUNTIME_DIR: join(home, "run") });
// Runs tmux on one of the test's servers, never on Skelcrew's own.
function tmux(socket: string, ...args: string[]) {
  const run = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args], {
    env: { ...env(), TMUX: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString() };
}

// Says what it waited for and shows the window it watched, if it gives up.
const until = (done: () => boolean, what: string, window = "one") =>
  wait(done, { every: 30, what: () => `${what}:\n${seen(window)}` });

// What an agent's script logged in a file of the test's folder, or nothing before it has.
const read = (file: string) => {
  const path = join(home, file);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

// What you see in the first terminal, or a second one.
const seen = (window = "one") => tmux(terminal, "capture-pane", "-p", "-t", `=${window}:`).out;
// The top row as you see it: Skelcrew above the sidebar, then the tabs and the strip above the
// agent.
const tabRow = () => (seen().split("\n")[0] ?? "").trimEnd();
// The row you are looking at, as the name line with the grey background shows it, below the
// status line, where the open tab has the same grey, and left of the sidebar's edge, as the
// row you are on in a list on the right has it too. Empty until the sidebar has drawn one.
function selected(window = "one"): string {
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", `=${window}:`).out;
  const line = colours
    .split("\n")
    .slice(1)
    .find((text) => (text.split(/[│┤]/)[0] ?? "").includes("48;5;238"));
  return Bun.stripANSI(line ?? "")
    .slice(0, sidebar - 1)
    .trim();
}
// The title your terminal shows in its window and tab.
const title = (window = "one") =>
  tmux(terminal, "display-message", "-p", "-t", `=${window}:`, "#{pane_title}").out.trim();
const screenSessions = () =>
  tmux(screen, "list-sessions", "-F", "#{session_name}").out.trim().split("\n").filter(Boolean);

// Starts an agent that sets a title of its own, as Claude Code does, says its name, and logs
// what you type and the size of its window. It first runs `before`, such as printing a long
// history.
function agent(name: string, before = ""): void {
  const script = join(home, `${name}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
cd ${JSON.stringify(home)}
trap 'stty size > ${name}.size' WINCH
stty size > ${name}.size
${before}
printf '\\033]0;title of ${name}\\007'
echo "I am ${name}"
# A resize cuts read short, which must not end the agent.
while test -d ${JSON.stringify(home)}; do read -r line && echo "$line" >> ${name}.typed; done
`,
    { mode: 0o755 },
  );
  startSession(agents, name, { folder: home, command: [script], env: { PATH: pathNow } });
}

// What goes ahead of Skelcrew in a terminal's command, such as a PATH that changes what it finds.
let before = "";
// Whether the terminals send Shift+Enter and other modified keys as keys of their own when asked,
// as Ghostty, kitty and WezTerm do. Terminal.app never does.
let extendedKeys = false;

// Opens the screen on an agent in a terminal of its own, whose title until then is "my shell",
// and which logs how Skelcrew exited. `where` is the name a laptop's sc --remote passes along.
function open(
  session: string,
  window = "one",
  term = "xterm-256color",
  width = "120",
  where = "",
): void {
  const script = join(home, `open-${window}.ts`);
  writeFileSync(
    script,
    `import { openScreen } from ${JSON.stringify(screenFile)};
await openScreen(${JSON.stringify(agents)}, ${JSON.stringify(session)}, "lead", "simon/app");
await Bun.write(${JSON.stringify(join(home, `left-${window}`))}, "left");`,
  );
  const named = `${where ? `SKELCREW_REMOTE_NAME=${where} ` : ""}${before}`;
  const title = `printf '\\033]2;my shell\\007'`;
  const command = `${title}; ${named}TERM=${term} ${process.execPath} ${script}; sleep 300`;
  const start = ["new-session", "-d", "-s", window, "-x", width, "-y", "30", command];
  // The terminal must already send extended keys when the screen asks for them, as tmux ignores
  // a request it got while they were off.
  const extended = extendedKeys ? [";", "set", "-s", "extended-keys", "on"] : [];
  tmux(terminal, ...start, ...extended);
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
  before = "";
  extendedKeys = false;
  agents = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  screen = `${agents}-screen`;
  terminal = `${agents}-terminal`;
  // app's lead is the one Skelcrew kept from before, as its session is named lead. It has started,
  // so its row names its harness.
  // The fake plugin is app's tracker and forge, so its sidebar has ISSUES and PRS.
  fakePlugin(home);
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: github\n");
  sql(`INSERT INTO repositories (name, owner, repo, kept_lead, lead_session, forge)
  VALUES ('app', 'simon', 'app', 1, 's', 'github');
INSERT INTO threads (owner, repo, task, folder, branch, status, needs_you) VALUES
  ('simon', 'app', 3, 'app-3', 'skelcrew/3', 'done', 0),
  ('simon', 'app', 7, 'app-7', 'skelcrew/7', 'working', 0),
  ('simon', 'app', 12, 'app-12', 'skelcrew/12', 'working', 0);`);
  agent("lead");
  agent("app-7");
  agent("app-12");
});
afterEach(() => {
  standIn?.close();
  standIn = null;
  asked.length = 0;
  for (const socket of [terminal, screen, agents]) {
    tmux(socket, "kill-server");
    // tmux leaves the socket file behind after kill-server.
    const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    rmSync(join(folder, socket), { force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

// Moves from the lead to the first thread that runs, past the entries, or to the one after it.
const toFirstThread = () => {
  press("M-S-Down");
  press("M-S-Down");
};
const toSecondThread = () => {
  toFirstThread();
  press("M-Down");
};

// Waits until the screen shows the sidebar and the agent you opened it on.
const ready = (name: string, window = "one") =>
  until(
    () => seen(window).includes(`I am ${name}`) && selected(window) !== "",
    "the screen",
    window,
  );

test("shows the lead and every thread that isn't done, beside the agent", async () => {
  open("lead");
  await ready("lead");
  const lines = seen().split("\n");
  const y = lines.findIndex((line) => line.includes("◆ lead"));
  // The lead is at the top of the sidebar, below a blank line, then a line, the entries, another
  // line, then THREADS.
  expect(y).toBe(2);
  expect(lines[1]?.slice(0, sidebar - 1).trim()).toBe("");
  expect(selected()).toBe("◆ lead");
  expect(lines[1]).toContain("I am lead");
  expect(lines[y + 1]).toContain("running · claude");
  expect(lines[y + 2]?.slice(0, sidebar - 1)).toMatch(/^─+$/);
  expect(lines[y + 3]).toContain("Issues");
  expect(lines[y + 4]).toContain("Threads");
  expect(lines[y + 5]).toContain("PRs");
  expect(lines[y + 6]?.slice(0, sidebar - 1)).toMatch(/^─+$/);
  expect(lines[y + 7]).toContain("Threads");
  expect(lines[y + 9]).toContain("● app-12");
  expect(lines[y + 10]).toContain("working · claude");
  expect(lines[y + 11]).toContain("● app-7");
  expect(seen()).not.toContain("app-3");
  // Nothing of the screen is left in agents' sessions: each stays one pane.
  const panes = tmux(agents, "list-panes", "-a", "-F", "#{session_name}").out.trim().split("\n");
  expect(panes.sort()).toEqual(["app-12", "app-7", "lead"]);
});

test("Alt-Down and Alt-Up switch the right side, and you type to whichever agent it shows", async () => {
  open("app-12");
  await ready("app-12");
  press("M-Down");
  await until(() => seen().includes("I am app-7"), "app-7");
  await until(() => selected() === "● app-7", "the sidebar to follow");
  type("hello\r");
  // The agent's shell makes the file before it writes the line, so wait for the whole line.
  await until(() => read("app-7.typed").endsWith("\n"), "the typing");
  expect(readFileSync(join(home, "app-7.typed"), "utf8")).toBe("hello\n");
  press("M-Up");
  await until(() => seen().includes("I am app-12"), "app-12");
  type("back\r");
  await until(() => existsSync(join(home, "app-12.typed")), "the typing");
});

test("clicking a row switches the right side and leaves your typing there", async () => {
  open("lead");
  await ready("lead");
  const y = seen()
    .split("\n")
    .findIndex((line) => line.includes("● app-7"));
  click(5, y + 1);
  await until(() => seen().includes("I am app-7"), "app-7");
  type("hello\r");
  await until(() => existsSync(join(home, "app-7.typed")), "the typing");
});

test("sc attach's screen starts on the agent it names, marked in the sidebar", async () => {
  open("app-7");
  await ready("app-7");
  expect(selected()).toBe("● app-7");
});

test("updates on its own, with needs you in the sidebar", async () => {
  open("lead");
  await ready("lead");
  sql("UPDATE threads SET needs_you = 1 WHERE task = 12");
  const colours = () => tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  await until(() => colours().includes("\x1b[38;5;221m●"), "needs you");
  expect(seen()).toContain("● app-12");
  expect(seen()).toContain("needs you");
  // Its tab says so too, as other repositories' tabs would.
  expect(seen().split("\n")[0]?.trimEnd()).toMatch(/^ {2}Skelcrew v[\d.]+ +│ {3}app •1$/);
  sql("UPDATE threads SET status = 'done' WHERE task = 7");
  await until(() => !seen().includes("app-7"), "the done thread to go");
});

test("Ctrl-Q leaves the whole screen, ends no agent, and says so", async () => {
  open("lead");
  await ready("lead");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "Skelcrew to return");
  await until(() => screenSessions().length === 0, "the session to end");
  expect(tmux(screen, "list-sessions").ok).toBe(false);
  for (const name of ["lead", "app-7", "app-12"])
    expect(tmux(agents, "has-session", "-t", `=${name}`).ok).toBe(true);
  expect(tmux(agents, "list-clients", "-F", "#{client_tty}").out).toBe("");
  await until(() => seen().includes(leaving), "the line that says what happened");
});

// Replaces the lead with an agent that asks for extended keys, as Claude Code and Codex do, says
// its name, and logs every byte it reads to lead.keys.
function keyLoggingLead(): void {
  tmux(agents, "kill-session", "-t", "=lead");
  const script = join(home, "keys.sh");
  writeFileSync(
    script,
    `#!/bin/sh
cd ${JSON.stringify(home)}
printf '\\033[>4;2m'
echo "I am lead"
stty raw -echo
exec cat > lead.keys
`,
    { mode: 0o755 },
  );
  startSession(agents, "lead", { folder: home, command: [script], env: { PATH: pathNow } });
}

test("Shift+Enter reaches the agent as a key of its own, through both tmux servers", async () => {
  extendedKeys = true;
  keyLoggingLead();
  open("lead");
  await ready("lead");
  type("a");
  press("S-Enter");
  type("b");
  press("Enter");
  await until(() => read("lead.keys").endsWith("\r"), "the Enter");
  // CSI u, the form Claude Code and Codex both read as Shift+Enter. tmux before 3.5 has only
  // the xterm form, which Claude Code reads too. Plain Enter stays a CR.
  const shiftEnter = tmuxIsAtLeast(3, 5) ? "\x1b[13;2u" : "\x1b[27;2;13~";
  expect(read("lead.keys")).toBe(`a${shiftEnter}b\r`);
});

test("with a terminal that sends extended keys, the screen's own keys still work", async () => {
  extendedKeys = true;
  open("lead");
  await ready("lead");
  toSecondThread();
  await until(() => selected() === "● app-7", "Alt-Shift-Down and Alt-Down to move");
  await until(() => seen().includes("I am app-7"), "app-7");
  type("hello");
  press("Enter");
  await until(() => read("app-7.typed") === "hello\n", "the typing");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "Ctrl-Q to leave");
});

test("Ctrl-] no longer leaves", async () => {
  open("lead");
  await ready("lead");
  press("C-]");
  await Bun.sleep(300);
  expect(existsSync(join(home, "left-one"))).toBe(false);
  expect(seen()).toContain("I am lead");
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

// The wheel, as a terminal sends it, turned up or down over the agent.
const wheel = (button: 64 | 65) => type(`\x1b[<${button};60;5M`);
const history = 'for n in $(seq 1 200); do echo "line $n"; done';
// Claude Code's full-screen drawing: the alternate screen, with its own scrolling, and what
// it is sent logged byte by byte.
const fullScreen = (name: string, mouse: string) => `printf '\\033[?1049h${mouse}'
stty raw -echo
echo "I am ${name}"
exec cat > ${name}.bytes`;
const scrolledBack = () => tmux(agents, "list-panes", "-a", "-F", "#{pane_in_mode}").out;

test("the wheel scrolls back through the agent's output, and typing returns you to it", async () => {
  agent("output", history);
  sql(`INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES
    ('simon', 'app', 20, 'output', 'skelcrew/20', 'working')`);
  open("output");
  await ready("output");
  for (let turn = 0; turn < 4; turn++) wheel(64);
  await until(() => seen().includes("line 160"), "the agent's older output");
  expect(seen()).not.toContain("I am output");
  expect(seen()).toContain("app-12");
  type("æble\r");
  // The agent's shell makes the file before it writes the line, so wait for the whole line.
  await until(() => read("output.typed").endsWith("\n"), "the typing");
  expect(readFileSync(join(home, "output.typed"), "utf8")).toBe("æble\n");
  await until(() => seen().includes("I am output"), "the live agent");
  expect(scrolledBack()).not.toContain("1");
});

test("any key leaves the scrollback, and turning the wheel back to the end does too", async () => {
  agent("output", history);
  open("output");
  await until(() => seen().includes("I am output"), "the agent");
  wheel(64);
  await until(() => !seen().includes("I am output"), "the scrollback");
  press("Down");
  await until(() => seen().includes("I am output"), "the live agent");
  wheel(64);
  await until(() => !seen().includes("I am output"), "the scrollback");
  wheel(65);
  await until(() => seen().includes("I am output"), "the live agent");
  expect(scrolledBack()).not.toContain("1");
});

test("every key pressed while scrolled back reaches the agent, Enter too", async () => {
  agent("output", history);
  open("output");
  await until(() => seen().includes("I am output"), "the agent");
  const keys = ["a", ";", "'", '"', "~", "#", "{", " ", "æ", "€", "日"];
  for (const key of keys) {
    wheel(64);
    await until(() => scrolledBack().includes("1"), "the scrollback");
    // tmux reads a bare ; on its command line as the end of a command.
    type(key === ";" ? "\\;" : key);
    await until(() => !scrolledBack().includes("1"), "the live agent");
  }
  wheel(64);
  await until(() => scrolledBack().includes("1"), "the scrollback");
  press("Enter");
  // The shell makes the file a moment before it writes to it.
  const typed = () => {
    const file = join(home, "output.typed");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  await until(() => typed() !== "", "the Enter");
  expect(typed()).toBe(`${keys.join("")}\n`);
});

test("Ctrl-Q and switching still work while scrolled back", async () => {
  agent("output", history);
  sql(`INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES
    ('simon', 'app', 20, 'output', 'skelcrew/20', 'working')`);
  open("output");
  await ready("output");
  wheel(64);
  await until(() => !seen().includes("I am output"), "the scrollback");
  press("M-Down");
  await until(() => selected() === "● app-12", "the next row");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "Skelcrew to return");
});

test("an agent drawing the full screen with the mouse gets the wheel itself", async () => {
  agent("drawn", fullScreen("drawn", "\\033[?1000h\\033[?1006h"));
  open("drawn");
  await until(() => seen().includes("I am drawn"), "the agent");
  wheel(64);
  await until(() => existsSync(join(home, "drawn.bytes")), "the wheel");
  await until(
    () => readFileSync(join(home, "drawn.bytes"), "utf8").startsWith("\x1b[<64;21;4M"),
    "the wheel at its place in the agent's window",
  );
  expect(scrolledBack()).not.toContain("1");
});

test("an agent drawing the full screen without the mouse gets arrow keys, as from a terminal", async () => {
  agent("drawn", fullScreen("drawn", ""));
  open("drawn");
  await until(() => seen().includes("I am drawn"), "the agent");
  wheel(64);
  wheel(65);
  await until(() => existsSync(join(home, "drawn.bytes")), "the wheel");
  await until(
    () =>
      readFileSync(join(home, "drawn.bytes"), "utf8").replaceAll("\x1bO", "\x1b[") ===
      "\x1b[A\x1b[B",
    "the arrow keys",
  );
  expect(scrolledBack()).not.toContain("1");
});

test("a tmux server started by an older Skelcrew gets scrolling when the screen opens", async () => {
  agent("output", history);
  tmux(agents, "set", "-g", "mouse", "off");
  open("output");
  await until(() => seen().includes("I am output"), "the agent");
  wheel(64);
  await until(() => !seen().includes("I am output"), "the scrollback");
});

test("resizing the terminal resizes the agent and keeps the sidebar narrow", async () => {
  open("lead");
  await ready("lead");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "29 81\n",
    "the agent's size",
  );
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "40");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "39 111\n",
    "the agent to resize",
  );
  const widths = tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out.trim().split("\n");
  expect(widths).toEqual(["38", "111"]);
  // A terminal shorter than the list keeps the row you are looking at in view.
  toSecondThread();
  await until(() => selected() === "● app-7", "app-7");
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "4");
  await until(() => !seen().includes("⌥↑↓ move"), "the hints to give way");
  await until(() => selected() === "● app-7", "the sidebar to scroll");
});

// The columns at the sidebar's edge, on each line below the thin line: the sidebar's line, where
// the lines between lists join it, then tmux's border. Blank past the end of a line that holds
// nothing else.
const edge = (height: number) =>
  seen()
    .split("\n")
    .slice(0, height)
    .map((line) => `${line[sidebar - 1]}${line[sidebar] ?? " "}`);

test("the sidebar's line runs to the bottom, with a blank column before the agent", async () => {
  open("lead");
  await ready("lead");
  expect(new Set(edge(30))).toEqual(new Set(["│ ", "┤ "]));
  expect(seen().split("\n")[1]?.indexOf("I am lead")).toBe(sidebar + 1);
});

// Puts a tmux ahead of the real one that says it is this version, and is the real one for
// everything else.
function tmuxSays(version: string): void {
  const real = Bun.which("tmux") ?? "tmux";
  mkdirSync(join(home, "versioned"));
  writeFileSync(
    join(home, "versioned", "tmux"),
    `#!/bin/sh\n[ "$1" = -V ] && echo "${version}" && exit 0\nexec ${real} "$@"\n`,
    { mode: 0o755 },
  );
  before = `PATH=${join(home, "versioned")}:$PATH `;
}

// tmux before 3.6 refuses a blank border, and the screen would never open. There the border is
// tmux's own thin line. A version that can't be read is taken as new.
test.each([
  ["tmux 3.5a", "single"],
  ["tmux 3.4", "single"],
  ["tmux 3.6", "spaces"],
  ["tmux 3.6a", "spaces"],
  ["tmux next-3.7", "spaces"],
  ["tmux master", "spaces"],
  ["tmux openbsd-7.6", "spaces"],
])("with %p, the border before the agent is %p", async (version, border) => {
  tmuxSays(version);
  open("lead");
  await ready("lead");
  expect(tmux(screen, "show", "-gv", "pane-border-lines").out.trim()).toBe(border);
});

test("the sidebar's line stays whole however the terminal is resized", async () => {
  open("lead");
  await ready("lead");
  for (const [width, height] of [
    [150, 40],
    [100, 20],
    [121, 21],
    [120, 30],
    [80, 24],
  ]) {
    tmux(terminal, "resize-window", "-t", "=one:", "-x", `${width}`, "-y", `${height}`);
    // Right after a resize you can see the old frame, cut to the new size.
    const whole = () =>
      edge(height ?? 0).every((columns) => ["│ ", "┤ "].includes(columns)) &&
      seen().split("◆ lead").length === 2 &&
      seen().includes("⌃Q quit");
    await until(whole, "the sidebar to be whole");
  }
});

test("the sidebar is whole after the terminal goes narrower than it and straight back", async () => {
  open("lead");
  await ready("lead");
  for (let turn = 0; turn < 5; turn++) {
    tmux(terminal, "resize-window", "-t", "=one:", "-x", "20", "-y", "30");
    tmux(terminal, "resize-window", "-t", "=one:", "-x", "120", "-y", "30");
  }
  await Bun.sleep(1500);
  expect(new Set(edge(30))).toEqual(new Set(["│ ", "┤ "]));
  expect(seen().split("◆ lead")).toHaveLength(2);
  expect(selected()).toBe("◆ lead");
});

test("a terminal a few lines high still shows the agent, and Ctrl-Q still leaves", async () => {
  open("lead");
  await ready("lead");
  for (const height of ["4", "3", "2", "1"]) {
    tmux(terminal, "resize-window", "-t", "=one:", "-x", "120", "-y", height);
    await Bun.sleep(200);
    expect(screenSessions()).toHaveLength(1);
  }
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "120", "-y", "30");
  await until(() => seen().includes("I am lead"), "the agent to come back");
  await until(() => seen().includes("⌥↑↓ move"), "the hints to come back");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "Skelcrew to return");
});

test("the strip ends the top row, and the agent's height stays as you switch", async () => {
  sql(`UPDATE threads SET title = 'Fix the login', pr = 34, checks = 'passing',
    review_round = 2, reviewer = 'claude', reviewed_by = 'codex', verdict = 'changes',
    review_line = 'A test is missing.' WHERE task = 7`);
  open("lead");
  await ready("lead");
  const height = readFileSync(join(home, "lead.size"), "utf8");
  toSecondThread();
  const line = "app-7  Fix the login  #34  checks passing  round 2 · codex · changes";
  await until(() => tabRow().endsWith(line), "the strip");
  expect(seen()).not.toContain("A test is missing.");
  expect(readFileSync(join(home, "app-7.size"), "utf8")).toBe(height);
  press("M-Up");
  await until(() => tabRow().endsWith("app-12"), "app-12's strip");
  expect(readFileSync(join(home, "app-12.size"), "utf8")).toBe(height);
});

test("the header, the tabs and the strip share one row, and the agent starts right under it", async () => {
  sql("UPDATE threads SET title = 'Fix the login', pr = 34 WHERE task = 7");
  open("lead");
  await ready("lead");
  toSecondThread();
  await until(() => seen().includes("#34"), "the strip");
  const lines = seen().split("\n");
  // Skelcrew above the sidebar, its edge, and the tab above the agent, then the strip.
  expect(lines[0]?.trimEnd()).toMatch(
    /^ {2}Skelcrew v[\d.]+ +│ {3}app +app-7 {2}Fix the login {2}#34$/,
  );
  // The open tab's grey starts where the agent's text does, with its name two columns in.
  expect(lines[0]?.indexOf("app")).toBe((lines[1]?.indexOf("I am") ?? 0) + 2);
  expect(lines[1]).toContain("I am app-7");
});

test("above the sidebar it says Skelcrew, in white, and the checkout's version when no laptop sent you here", async () => {
  open("lead");
  await ready("lead");
  const above = () => (seen().split("\n")[0] ?? "").slice(0, sidebar - 1).trimEnd();
  await until(() => above() === `  Skelcrew v${checkout.version}`, "the header");
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  const header = colours.split("\n")[0];
  expect(header).toContain("\x1b[1m");
  expect(header).toContain("38;5;231m");
});

test("each terminal says where it came from, as they can come from different laptops", async () => {
  open("lead", "one", "xterm-256color", "120", "sprite:demo");
  await ready("lead");
  open("lead", "two");
  await ready("lead", "two");
  const place = (window: string) => (seen(window).split("\n")[0] ?? "").slice(0, sidebar - 1);
  await until(
    () => place("one").startsWith(`  Skelcrew v${checkout.version} · sprite:`),
    "the first place",
  );
  await until(
    () => place("two").trimEnd() === `  Skelcrew v${checkout.version}`,
    "the second header",
    "two",
  );
});

test("the sidebar's edge runs from the top row to the bottom, at every width", async () => {
  open("lead");
  await ready("lead");
  const column = () =>
    seen()
      .split("\n")
      .slice(0, 30)
      .map((line) => line[sidebar - 1]);
  await until(() => column().every((mark) => mark === "│" || mark === "┤"), "the edge");
  for (const width of [150, 90, 120]) {
    tmux(terminal, "resize-window", "-t", "=one:", "-x", String(width), "-y", "30");
    // tmux stretches the sidebar for a moment before the screen's hook sets its width back.
    await until(
      () => tabRow().length > sidebar && column().every((mark) => mark === "│" || mark === "┤"),
      `the edge at ${width}`,
    );
  }
});

test("a thread's strip follows it as it changes", async () => {
  open("app-7");
  await ready("app-7");
  await until(() => tabRow().endsWith("app-7"), "the strip");
  sql(`UPDATE threads SET review_round = 1, reviewed_by = 'codex', verdict = 'approve',
    review_line = 'Looks right.' WHERE task = 7`);
  await until(() => seen().includes("app-7  round 1 · codex · approved"), "the review");
});

test("what a title says is shown, never run or read as a format", async () => {
  const proof = join(home, "ran");
  const title = `100% %H #(touch ${proof}) #[fg=red] #{pane_pid}`;
  sql(`UPDATE threads SET title = '${title}' WHERE task = 7`);
  // Wide enough for the whole title, which holds a path as long as the test's folder.
  open("app-7", "one", "xterm-256color", "200");
  await ready("app-7");
  await until(() => seen().includes("#(touch"), "the strip");
  expect(seen()).toContain(title);
  await Bun.sleep(300);
  expect(existsSync(proof)).toBe(false);
});

test("clicking the strip, or turning the wheel over it, does nothing", async () => {
  open("lead");
  await ready("lead");
  click(100, 1);
  type("\x1b[<64;100;1M");
  await Bun.sleep(200);
  const modes = tmux(screen, "list-panes", "-a", "-F", "#{pane_in_mode}").out.trim().split("\n");
  expect(modes).toEqual(["0", "0"]);
  expect(scrolledBack()).not.toContain("1");
  expect(seen()).toContain("I am lead");
});

// Puts two open issues and a PR in Skelcrew's copy, as a poll would, with what their pages say.
const openOnGitHub = () =>
  sql(`${itemSql("app", "task", 31, "Add CSV export", "2026-11-05T10:00:00Z", {
    author: { login: "ana", bot: false, you: false },
    labels: ["skelcrew"],
    body: Array.from({ length: 80 }, (_, i) => `line ${i + 1} of the description`).join("\n"),
  })}
${itemSql("app", "task", 12, "Fix login", "2026-11-04T10:00:00Z", { author: { login: "ana", bot: false, you: false } })}
${itemSql("app", "pr", 34, "Bump deps", "2026-11-05T10:00:00Z", {
  body: "All of them.",
  branch: "skelcrew/12",
  checks: [{ name: "test", id: "1", state: "passed" }],
  reviews: [
    {
      id: "1",
      text: "**Approved.**\n\nFine.",
      author: { login: "codex", bot: false, you: false },
      verdict: "commented",
      lines: [],
    },
  ],
})}
UPDATE repositories SET open_issues = 2, open_prs = 1;`);

test("the entries sit between the lead and THREADS, counting what their lists have", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  await until(() => seen().includes("1 new · 2"), "the entries");
  const lines = seen()
    .split("\n")
    .map((line) => line.slice(0, sidebar - 1).trimEnd());
  const at = (text: string) => lines.findIndex((line) => line.includes(text));
  // Each count ends two columns before the sidebar's edge.
  expect(lines[at("Issues")]).toBe(`${"    Issues".padEnd(26)}1 new · 2`);
  expect(lines[at("    Threads")]).toBe(`${"    Threads".padEnd(34)}2`);
  expect(lines[at("PRs")]).toBe(`${"    PRs".padEnd(34)}1`);
  expect(at("◆ lead")).toBeLessThan(at("Issues"));
  expect(at("PRs")).toBeLessThan(lines.indexOf("  Threads"));
});

test("the screen's server turns terminal links on, whatever your terminal says it is", async () => {
  open("lead");
  await ready("lead");
  expect(tmux(screen, "show", "-s", "terminal-features").out).toContain("hyperlinks");
});

// Stands in for the daemon on the test's own socket: it logs each repository asked to open,
// saying when a tab asked, which must never open a tab you closed, and answers with nothing to
// say.
const asked: string[] = [];
function daemon(): void {
  const answer = (connection: Socket) =>
    connection.on("data", (data) => {
      const { command, from, tab } = z
        .object({
          command: z.string(),
          from: z.string().default(""),
          tab: z.boolean().default(false),
        })
        .parse(JSON.parse(data.toString()));
      if (command === "lead") asked.push(`open ${from}${tab ? " from a tab" : ""}`);
      connection.end("{}\n");
    });
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  standIn = createServer(answer).listen(join(home, "run", "skelcrew.sock"));
}

const issueUrl = "https://github.com/simon/app/issues/31";
// What the issue's page says, as drawn from Skelcrew's copy.
const issuePage: Page = {
  title: "Add CSV export",
  facts: [
    ["State", "open"],
    ["Author", "ana"],
    ["Labels", "skelcrew"],
  ],
  body: Array.from({ length: 80 }, (_, i) => `line ${i + 1} of the description`).join("\n"),
};

// Clicks a row of the sidebar, found by what it says.
function clickRow(text: string): void {
  const y = seen()
    .split("\n")
    .findIndex((line) => line.slice(0, sidebar).includes(text));
  click(6, y + 1);
}
// What the right side shows, without the sidebar.
const right = () =>
  seen()
    .split("\n")
    .map((line) => line.slice(sidebar + 1))
    .join("\n");
// Clicks a row of the list on the right, found by what it says.
function clickListRow(text: string): void {
  const y = right()
    .split("\n")
    .findIndex((line) => line.includes(text));
  click(sidebar + 8, y + 1);
}
// Waits for text on the right.
const onRight = (text: string) =>
  until(() => right().includes(text), `the right side to say ${text}`);
// Opens the screen on the lead with issues and PRs open, and lands on an entry's list.
async function openList(entry: "Issues" | "Threads" | "PRs", width = "120"): Promise<void> {
  openOnGitHub();
  open("lead", "one", "xterm-256color", width);
  await ready("lead");
  await until(() => seen().includes(" new · "), "the entries");
  clickRow(entry === "Threads" ? "    Threads" : entry);
  await onRight("↑↓ move");
}
// Opens the issue's page, from its list. The list's pane draws the page, then the sidebar, told
// by that pane, names it in the strip a moment later, so this waits for both. Otherwise what a
// test reads first could change on its own while it looks.
async function openIssue(width = "120"): Promise<void> {
  await openList("Issues", width);
  press("Enter");
  await onRight("line 1 of the description");
  await until(() => right().split("\n")[0]?.includes("app-31") ?? false, "the strip");
}
// How many of the processes under the screen's tmux server run a list.
const listsRunning = () => {
  const panes = tmux(screen, "list-panes", "-a", "-F", "#{pane_pid}").out.trim().split("\n");
  return panes.filter((pid) => {
    const about = Bun.spawnSync(["ps", "-o", "args=", "-p", pid], { stdout: "pipe" });
    return about.stdout.toString().includes(" list ");
  }).length;
};

test("landing on an entry shows its list across the right side, in groups, with no strip", async () => {
  await openList("Issues");
  await onRight("Not started");
  const lines = right().split("\n");
  const at = (text: string) => lines.findIndex((line) => line.includes(text));
  expect(at("Not started")).toBeLessThan(at("app-31"));
  expect(at("app-31")).toBeLessThan(at("Started"));
  expect(lines[at("app-12")]).toContain("◐ app-12  Fix login");
  expect(lines[at("app-12")]?.trimEnd()).toEndWith("working");
  expect(right()).not.toContain("I am lead");
  await until(() => !tabRow().includes("Add CSV"), "no strip");
  expect(tabRow()).toMatch(/app$/);
});

test("an issue's or PR's row reaches your terminal as a link, through both tmux servers", async () => {
  await openList("Issues");
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  // tmux gives each link an id of its own, ahead of the url.
  expect(colours).toContain(`;${issueUrl}\x1b\\`);
});

test("Up and Down move in the list, and Enter opens the issue's page, which fills the strip", async () => {
  await openList("Issues");
  press("Down");
  press("Up");
  press("Enter");
  await onRight("line 1 of the description");
  expect(right()).toContain("← back");
  expect(right()).toContain("Author");
  await until(() => tabRow().endsWith("app-31  Add CSV export"), "the strip");
  // The sidebar stays on the entry.
  expect(selected()).toContain("Issues");
});

test("Esc or Left goes back from a page to its list, on the row you opened", async () => {
  await openList("Issues");
  press("Down");
  press("Enter");
  await onRight("Fix login");
  await onRight("← back");
  press("Left");
  await onRight("↑↓ move");
  await until(() => !tabRow().includes("Fix login"), "the strip to go");
  press("Enter");
  await onRight("← back");
  expect(right()).toContain("Fix login");
  press("Escape");
  await onRight("↑↓ move");
  press("Up");
  press("Enter");
  await onRight("line 1 of the description");
});

test("a click on a row opens it, and a click on its entry goes back to the list", async () => {
  await openList("Issues");
  clickListRow("Add CSV export");
  await onRight("line 1 of the description");
  clickRow("Issues");
  await onRight("↑↓ move");
  expect(right()).toContain("Fix login");
});

test("Enter on a thread in the list of threads shows its agent, and the sidebar moves to its row", async () => {
  await openList("Threads");
  await onRight("Working");
  expect(right()).toContain("app-12");
  press("Enter");
  await until(() => seen().includes("I am app-12"), "the agent");
  await until(() => selected() === "● app-12", "the sidebar to follow");
  type("from the list\r");
  await until(() => read("app-12.typed").includes("from the list"), "what you typed");
});

test("a stopped thread is listed under Stopped, and opening it does nothing", async () => {
  sql("UPDATE threads SET status = 'stopped' WHERE task = 7");
  await openList("Threads");
  await onRight("Stopped");
  clickListRow("app-7");
  await Bun.sleep(500);
  expect(right()).toContain("Stopped");
  expect(listsRunning()).toBe(1);
});

test("a PR's page shows its branch, checks and latest review", async () => {
  await openList("PRs");
  press("Enter");
  await onRight("Approved. · codex");
  expect(right()).toContain("skelcrew/12 → main");
  expect(right()).toContain("passing");
  expect(right()).toContain("All of them.");
});

test("the page's link reaches your terminal as a terminal link, through tmux", async () => {
  await openIssue();
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  expect(colours).toContain(`;${issueUrl}\x1b\\`);
  expect(seen()).toContain(`GitHub  ${issueUrl}`);
});

// Puts a stand-in for the command that opens a link in your browser ahead of the real one, on a
// machine with a display, so a test never opens a real browser. It logs each link it gets.
function fakeOpener(): void {
  mkdirSync(join(home, "opener"));
  const log = JSON.stringify(join(home, "opened"));
  for (const name of ["open", "xdg-open"])
    writeFileSync(join(home, "opener", name), `#!/bin/sh\necho "$1" >> ${log}\n`, { mode: 0o755 });
  before = `PATH=${join(home, "opener")}:$PATH DISPLAY=:9 `;
}
// Clicks the page's link to GitHub, a few columns into it, where the screen shows it.
function clickLink(): void {
  const lines = seen().split("\n");
  const y = lines.findIndex((line) => line.includes(`GitHub  ${issueUrl}`));
  click((lines[y] ?? "").indexOf(issueUrl) + 4, y + 1);
}

test("a plain click on the page's link opens it in your browser, on the machine you sit at", async () => {
  fakeOpener();
  await openIssue();
  await onRight("click to open");
  // A click elsewhere on the page opens nothing.
  const lines = seen().split("\n");
  click(sidebar + 6, lines.findIndex((line) => line.includes("Author")) + 1);
  clickLink();
  await until(() => read("opened") !== "", "the link to open");
  await Bun.sleep(300);
  expect(read("opened")).toBe(`${issueUrl}\n`);
});

test("on a remote, a click on the page's link copies it to your terminal's clipboard", async () => {
  fakeOpener();
  openOnGitHub();
  open("lead", "one", "xterm-256color", "120", "sprite:demo");
  await ready("lead");
  // Your terminal keeps what a program copies, as Ghostty does.
  tmux(terminal, "set", "-s", "set-clipboard", "on");
  await until(() => seen().includes("1 new · 2"), "the entries");
  clickRow("Issues");
  await onRight("↑↓ move");
  press("Enter");
  await onRight("click to copy");
  clickLink();
  await onRight("copied");
  expect(tmux(terminal, "show-buffer").out).toBe(issueUrl);
  expect(read("opened")).toBe("");
});

test("Alt-Down moves from the lead through the entries, and Alt-Up back puts you in the agent", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  press("M-Down");
  await onRight("Not started");
  expect(selected()).toContain("Issues");
  press("M-Down");
  await onRight("Working");
  press("M-Down");
  await onRight("In review");
  press("M-Down");
  await until(() => seen().includes("I am app-12"), "the first thread");
  press("M-Up");
  await onRight("In review");
  press("M-S-Up");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => selected() === "◆ lead", "the lead's row");
  type("straight back\r");
  await until(() => read("lead.typed").includes("straight back"), "what you typed");
});

test("Alt-Shift-Down and Alt-Shift-Up jump between the lead, the entries and THREADS", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await onRight("Not started");
  press("M-S-Down");
  await until(() => selected() === "● app-12", "the first row of THREADS");
  await until(() => seen().includes("I am app-12"), "its agent");
  press("M-S-Up");
  await onRight("Not started");
  press("M-S-Up");
  await until(() => seen().includes("I am lead"), "the lead");
});

test("landing on an entry from elsewhere starts its list on the first row", async () => {
  await openList("Issues");
  press("Down");
  press("M-S-Down");
  await until(() => seen().includes("I am app-12"), "the thread");
  press("M-S-Up");
  await onRight("↑↓ move");
  press("Enter");
  await onRight("line 1 of the description");
});

test("keys pressed together when leaving a list all count, however slowly the client attaches", async () => {
  // A client attaching slowly, as over a busy Sprite, can't be switched yet.
  const real = Bun.which("tmux") ?? "tmux";
  mkdirSync(join(home, "slow"));
  writeFileSync(
    join(home, "slow", "tmux"),
    `#!/bin/sh\ncase "$*" in *" attach "*) sleep 0.4 ;; esac\nexec ${real} "$@"\n`,
    { mode: 0o755 },
  );
  before = `PATH=${join(home, "slow")}:$PATH `;
  await openList("PRs");
  type("\x1b[1;3B\x1b[1;3B");
  await until(() => seen().includes("I am app-7"), "the second row's agent");
  await Bun.sleep(1200);
  expect(selected()).toBe("● app-7");
  expect(seen()).toContain("I am app-7");
});

test("a pane too narrow for a page's lines cuts them, so every line keeps its own row", async () => {
  await openList("Issues", "49");
  press("Enter");
  await onRight("Author");
  const panes = tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out.trim().split("\n");
  const width = Number(panes.at(-1));
  expect(width).toBeLessThan(11);
  const rows = right().split("\n").slice(2, 20);
  const lines = drawPage(issuePage, issueUrl, width, "click to open").map((line) =>
    Bun.stripANSI(line).slice(0, width).trimEnd(),
  );
  expect(rows.map((row) => row.trimEnd())).toEqual(lines.slice(0, 18));
});

test("a list leaves none of its terminal's modes behind on the agent", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  const modes = () =>
    tmux(screen, "list-panes", "-a", "-F", "#{wrap_flag} #{cursor_flag} #{mouse_any_flag}").out;
  const before = modes();
  press("M-Down");
  await onRight("Not started");
  expect(modes()).not.toBe(before);
  press("M-Up");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => modes() === before, "the modes to come back");
});

test("the wheel, Up and Down scroll a page and stop at both ends", async () => {
  await openIssue();
  wheel(65);
  await until(() => !right().includes("State"), "the page to scroll");
  for (let i = 0; i < 30; i++) wheel(65);
  await onRight("line 80 of the description");
  await Bun.sleep(200);
  const atEnd = right();
  press("Down");
  await Bun.sleep(200);
  expect(right()).toBe(atEnd);
  press("Up");
  await until(() => right() !== atEnd, "a key to scroll");
  for (let i = 0; i < 30; i++) wheel(64);
  await onRight("Author");
});

test("other typing on a list or page goes nowhere, and the agent never gets it", async () => {
  await openIssue();
  const before = right();
  type("not for anyone\r");
  press("C-c");
  press("C-z");
  press("C-\\");
  await Bun.sleep(300);
  expect(right()).toBe(before);
  press("M-S-Up");
  await until(() => seen().includes("I am lead"), "the agent");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});

test("Ctrl-C pressed the moment a list opens can't take the right side away", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  const running = () => tmux(screen, "list-panes", "-a", "-F", "#{pane_pid}").out;
  const before = running();
  press("M-Down");
  await until(() => running() !== before, "the pane to start the list");
  for (let i = 0; i < 10; i++) {
    press("C-c");
    await Bun.sleep(10);
  }
  await Bun.sleep(500);
  expect(running().trim().split("\n")).toHaveLength(2);
  press("M-Up");
  await until(() => seen().includes("I am lead"), "the lead");
  type("still here\r");
  await until(() => read("lead.typed").includes("still here"), "what you typed");
});

test("a list or page left open writes nothing", async () => {
  sql("UPDATE threads SET status = 'waiting', changed = 0 WHERE status = 'working'");
  await openList("Threads");
  await Bun.sleep(1500);
  const written = join(home, "written");
  tmux(terminal, "pipe-pane", "-O", "-t", "=one:", `cat >> ${written}`);
  await Bun.sleep(3000);
  expect(existsSync(written) ? readFileSync(written, "utf8") : "").toBe("");
  clickRow("Issues");
  await onRight("Not started");
  press("Enter");
  await onRight("line 1 of the description");
  await Bun.sleep(1500);
  rmSync(written, { force: true });
  await Bun.sleep(3000);
  expect(existsSync(written) ? readFileSync(written, "utf8") : "").toBe("");
});

test("a list follows Skelcrew's copy as it changes", async () => {
  await openList("Issues");
  sql(itemSql("app", "task", 40, "A new issue", "2026-11-06T10:00:00Z"));
  await onRight("A new issue");
  await until(() => seen().includes("2 new · 3"), "the count");
});

test("a row that moves out of view as the list changes is scrolled back into view", async () => {
  const many = Array.from({ length: 40 }, (_, n) =>
    itemSql(
      "app",
      "task",
      100 + n,
      `Issue ${100 + n}`,
      `2026-11-06T10:${String(n).padStart(2, "0")}:00Z`,
    ),
  );
  sql(many.join("\n"));
  await openList("Issues");
  await onRight("app-139");
  // The issue you are on gets a thread, which moves it under Started, far below.
  sql(`INSERT INTO threads (owner, repo, task, folder, branch, status)
    VALUES ('simon', 'app', 139, 'app-139', 'skelcrew/139', 'working')`);
  await until(() => right().includes("Started") && right().includes("app-139"), "the row in view");
  press("Enter");
  await onRight("← back");
  expect(right()).toContain("Issue 139");
});

test("a list scrolled with the wheel stays where you put it as it reads the copy again", async () => {
  const many = Array.from({ length: 40 }, (_, n) =>
    itemSql(
      "app",
      "task",
      100 + n,
      `Issue ${100 + n}`,
      `2026-11-06T10:${String(n).padStart(2, "0")}:00Z`,
    ),
  );
  sql(many.join("\n"));
  await openList("Issues");
  for (let i = 0; i < 4; i++) wheel(65);
  await until(() => !right().includes("app-139"), "the list to scroll");
  const scrolled = right();
  await Bun.sleep(2500);
  expect(right()).toBe(scrolled);
});

// Returns the process running the right pane, which is the list while one shows.
const rightPane = () =>
  tmux(screen, "list-panes", "-a", "-F", "#{pane_pid}").out.trim().split("\n").at(-1);

test("clicking the entry of the list you are on doesn't start it again", async () => {
  await openList("Issues");
  const list = rightPane();
  clickRow("Issues");
  await Bun.sleep(300);
  expect(rightPane()).toBe(list);
});

test("a page Skelcrew's copy no longer has says so, and you can still move on", async () => {
  await openList("Issues");
  sql("DELETE FROM items WHERE id = '31'");
  press("Enter");
  await onRight("Skelcrew has no open issue or PR at this link now");
  expect(seen()).toContain(`GitHub  ${issueUrl}`);
  press("M-S-Down");
  await until(() => seen().includes("I am app-12"), "the thread");
});

test("a page follows a resize, and the sidebar stays as wide", async () => {
  await openIssue();
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "80", "-y", "24");
  await until(() => seen().split("\n").length <= 25, "the terminal");
  await onRight("line 1 of the description");
  expect(tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out).toContain(`${sidebar}\n`);
});

test("the wheel over an agent still scrolls it after a list came and went", async () => {
  openOnGitHub();
  agent("app-5", "seq 1 200");
  sql(`INSERT INTO threads (owner, repo, task, folder, branch, status, needs_you) VALUES
  ('simon', 'app', 5, 'app-5', 'skelcrew/5', 'working', 0);`);
  open("app-5");
  await ready("app-5");
  clickRow("Issues");
  await onRight("Not started");
  clickRow("app-5");
  await until(() => seen().includes("I am app-5"), "the agent");
  wheel(64);
  await until(() => !seen().includes("I am app-5"), "the agent's history");
});

test("Ctrl-Q leaves from a page, and no list is left running", async () => {
  await openIssue();
  expect(listsRunning()).toBe(1);
  const panes = tmux(screen, "list-panes", "-a", "-F", "#{pane_pid}").out.trim().split("\n");
  press("C-q");
  await until(() => seen().includes(leaving), "Skelcrew to say goodbye");
  await until(() => stillRunning(panes.map(Number)).length === 0, "the panes' processes to end");
});

test("leaving a list for an agent ends the list, and no client is left behind it", async () => {
  await openIssue();
  press("M-S-Up");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => listsRunning() === 0, "the list to end");
  expect(tmux(agents, "list-clients").out.trim().split("\n")).toHaveLength(1);
});

test("two terminals can each be on a list of their own", async () => {
  await openIssue();
  open("lead", "two");
  await ready("lead", "two");
  expect(seen("two")).toContain("I am lead");
  expect(right()).toContain("line 1 of the description");
});

test("with nothing working, an open screen sends your terminal nothing at all", async () => {
  // Close enough to a minute that a time shown on any row would change during the wait.
  const started = Date.now() - 56_000;
  sql(`UPDATE threads SET status = 'waiting', started = ${started} WHERE status = 'working'`);
  open("lead");
  await ready("lead");
  await until(() => seen().includes("checks · claude"), "the threads");
  // tmux redraws its border once as the screen settles.
  await Bun.sleep(1500);
  const written = join(home, "written");
  tmux(terminal, "pipe-pane", "-O", "-t", "=one:", `cat >> ${written}`);
  await Bun.sleep(4000);
  expect(existsSync(written) ? readFileSync(written, "utf8") : "").toBe("");
});

test("a working thread's time moves on by itself, and writes when it does", async () => {
  sql(`UPDATE threads SET started = ${Date.now() - 58_000} WHERE folder = 'app-12'`);
  open("lead");
  await ready("lead");
  await until(() => seen().includes("working · claude · <1m"), "the time to start");
  const written = join(home, "written");
  tmux(terminal, "pipe-pane", "-O", "-t", "=one:", `cat >> ${written}`);
  await until(() => seen().includes("working · claude · 1m"), "the time to move on");
  await until(() => existsSync(written) && readFileSync(written, "utf8") !== "", "the write");
});

test("the hints stay at the bottom, and a click there picks nothing", async () => {
  open("lead");
  await ready("lead");
  const lines = seen().trimEnd().split("\n");
  expect(lines.at(-2)).toContain("⌥↑↓ move");
  expect(lines.at(-1)).toContain("⌃Q quit");
  expect(seen()).not.toContain("⌥⇧↑↓");
  expect(seen()).not.toContain("⌥←→");
  click(5, 30);
  await Bun.sleep(200);
  expect(selected()).toBe("◆ lead");
});

test("two terminals each get their own session, and leaving one leaves the other", async () => {
  open("lead", "one");
  await ready("lead", "one");
  open("app-7", "two");
  await ready("app-7", "two");
  expect(screenSessions()).toHaveLength(2);
  press("M-Up", "two");
  await until(() => selected("two") === "● app-12", "the second to switch", "two");
  expect(selected("one")).toBe("◆ lead");
  press("C-q", "one");
  await until(() => screenSessions().length === 1, "the first to end");
  press("M-Down", "two");
  await until(() => selected("two") === "● app-7", "the second to go on working", "two");
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
  // One that exited stays a zombie until the test run ends, which only this tells from running.
  const gone = () => stillRunning(sidebars.map(Number)).length === 0;
  await until(gone, "the sidebars and clients to end");
  expect(tmux(agents, "has-session", "-t", "=lead").ok).toBe(true);
});

test("when the agent you are looking at ends, the right side goes to the lead", async () => {
  open("app-7");
  await ready("app-7");
  tmux(agents, "kill-session", "-t", "=app-7");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => selected() === "◆ lead", "the sidebar to follow");
});

test("when the thread you are on stops, its row goes and the right side goes to the lead", async () => {
  open("app-7");
  await ready("app-7");
  sql("UPDATE threads SET status = 'stopped' WHERE task = 7");
  tmux(agents, "kill-session", "-t", "=app-7");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => selected() === "◆ lead", "the sidebar to follow");
  await until(() => !seen().includes("app-7"), "the stopped thread to go");
  expect(seen()).toContain("● app-12");
});

test("a row whose agent isn't running can't be picked", async () => {
  sql("UPDATE threads SET status = 'failed' WHERE task = 12");
  tmux(agents, "kill-session", "-t", "=app-12");
  open("lead");
  await ready("lead");
  await until(() => seen().includes("app-12"), "the row");
  const y = seen()
    .split("\n")
    .findIndex((line) => line.includes("app-12"));
  click(5, y + 1);
  toFirstThread();
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

test("the terminal's title says Skelcrew while the screen is open, and comes back after", async () => {
  open("lead");
  await ready("lead");
  await until(() => title() === "Skelcrew", "the title");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "Skelcrew to return");
  expect(title()).toBe("my shell");
});

test("the title names the machine when you came from a laptop", async () => {
  open("lead", "one", "xterm-256color", "120", "sprite:demo");
  await ready("lead");
  await until(() => title() === "Skelcrew · sprite:demo", "the title");
});

test("the title goes out in the form sprite leaves alone", async () => {
  // sprite writes its own name in front of a title sent the other way, OSC 0.
  const script = join(home, "open-raw.ts");
  writeFileSync(
    script,
    `import { openScreen } from ${JSON.stringify(screenFile)};
await openScreen(${JSON.stringify(agents)}, "lead");`,
  );
  let wrote = "";
  const run = Bun.spawn([process.execPath, script], {
    env: { ...env(), TMUX: "", TERM: "xterm-256color" },
    terminal: {
      cols: 120,
      rows: 30,
      data: (_, bytes) => {
        wrote += new TextDecoder().decode(bytes);
      },
    },
  });
  try {
    await until(
      () => wrote.includes("Skelcrew\x07") || wrote.includes("Skelcrew\x1b\\"),
      "the title",
    );
    expect(wrote).toContain("\x1b]2;Skelcrew");
    expect(wrote).not.toContain("\x1b]0;");
  } finally {
    tmux(screen, "kill-server");
    await run.exited;
    run.terminal?.close();
  }
});

test("two terminals on one machine keep a title each", async () => {
  open("lead", "one", "xterm-256color", "120", "sprite:demo");
  await ready("lead");
  open("lead", "two");
  await ready("lead", "two");
  await until(() => title("two") === "Skelcrew", "the second title");
  toFirstThread();
  await until(() => seen().includes("I am app-12"), "app-12");
  expect(title()).toBe("Skelcrew · sprite:demo");
});

test("an agent's own title never reaches the terminal, even after switching", async () => {
  open("lead");
  await ready("lead");
  await until(() => title() === "Skelcrew", "the title");
  expect(tmux(agents, "list-panes", "-t", "=lead:", "-F", "#{pane_title}").out).toContain(
    "title of lead",
  );
  toFirstThread();
  await until(() => seen().includes("I am app-12"), "app-12");
  expect(title()).toBe("Skelcrew");
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

// site, a second repository, whose thread needs you, and whose lead runs.
const siteLead = leadPlaces("simon", "site").name;
function addSite(): void {
  sql(`INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site');
INSERT INTO threads (owner, repo, task, folder, branch, status, needs_you) VALUES
  ('simon', 'site', 8, 'site-8', 'skelcrew/8', 'waiting', 1);`);
  agent(siteLead);
}

test("a tab for each repository runs across the top, with a badge for what needs you", async () => {
  addSite();
  open("lead");
  await ready("lead");
  await until(() => /^ {2}Skelcrew v[\d.]+ +│ {3}app {4}site •1$/.test(tabRow()), "the tabs");
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out.split("\n")[0];
  // The open one is on its dark grey, the others on a lighter one.
  expect(colours).toContain("48;5;234");
  expect(colours).toContain("48;5;237");
  // The sidebar shows only app's threads.
  expect(seen()).not.toContain("site-8");
});

test("Alt-Right and Alt-Left switch both sides to the repository beside, and open it", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  press("M-Right");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => seen().includes("site-8") && !seen().includes("app-12"), "site's threads");
  expect(selected()).toBe("◆ lead");
  await until(() => asked.includes("open simon/site from a tab"), "the daemon to open site");
  type("hello\r");
  await until(() => existsSync(join(home, `${siteLead}.typed`)), "the typing");
  // There is no tab after the last.
  press("M-Right");
  await Bun.sleep(300);
  expect(seen()).toContain(`I am ${siteLead}`);
  press("M-Left");
  await until(() => seen().includes("I am lead") && seen().includes("app-12"), "app again");
});

// Ghostty on a Mac turns Alt-Left and Alt-Right into word jumps, so they never reach Skelcrew,
// while Alt-Shift-Left and Alt-Shift-Right come through.
test("Alt-Shift-Right and Alt-Shift-Left switch repositories too", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  press("M-S-Right");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => seen().includes("site-8") && !seen().includes("app-12"), "site's threads");
  press("M-S-Left");
  await until(() => seen().includes("I am lead") && seen().includes("app-12"), "app again");
});

test("a click on a tab switches to its repository", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  await until(() => tabRow().includes("site"), "the tabs");
  click(tabRow().indexOf("site") + 2, 1);
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => seen().includes("site-8"), "site's threads");
  click(tabRow().indexOf("app") + 2, 1);
  await until(() => seen().includes("I am lead") && seen().includes("app-12"), "app again");
});

// A terminal can hand both keys over at once, and the second must move in the new repository.
test("several Alt keys typed together all move, and none is typed into the agent", async () => {
  open("lead");
  await ready("lead");
  type("\x1b[1;3B\x1b[1;3B\x1b[1;3B\x1b[1;3B");
  await until(() => seen().includes("I am app-12"), "the first thread, past the three entries");
  await until(() => selected() === "● app-12", "the sidebar to follow");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});

test("Alt-Right then Alt-Shift-Down twice, typed together, lands on the new repository's thread", async () => {
  addSite();
  agent("site-8");
  daemon();
  open("lead");
  await ready("lead");
  type("\x1b[1;3C\x1b[1;4B\x1b[1;4B");
  await until(() => seen().includes("I am site-8"), "site-8");
  await until(() => selected() === "● site-8", "the sidebar to follow");
  expect(seen()).not.toContain("app-12");
});

// The daemon closes a repository's tab when you exit its lead, by marking it in the database.
const closeTab = (repo: string) =>
  sql(`UPDATE repositories SET tab_closed = 1 WHERE repo = '${repo}'`);

test("a tab that closes moves the screen to the tab after it, and leaves the threads alone", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  await until(() => tabRow().includes("site"), "the tabs");
  closeTab("app");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => seen().includes("site-8") && !/\bapp\b/.test(tabRow()), "app's tab to go");
  expect(asked).toContain("open simon/site from a tab");
  // Nothing of app's ended: its builders still run.
  expect(tmux(agents, "has-session", "-t", "=app-7").ok).toBe(true);
});

test("the last tab closing moves the screen to the tab before it", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  press("M-Right");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  closeTab("site");
  await until(() => seen().includes("I am lead") && seen().includes("app-12"), "app again");
  expect(tabRow()).not.toContain("site");
});

test("with no tab left, the screen leaves as Ctrl-Q does", async () => {
  open("lead");
  await ready("lead");
  closeTab("app");
  await until(() => read("left-one") === "left", "the screen to leave");
  expect(seen()).toContain(leaving);
  expect(screenSessions()).toEqual([]);
  expect(tmux(agents, "has-session", "-t", "=lead").ok).toBe(true);
});

test("a lead that stops while you look at it is brought back, once", async () => {
  daemon();
  open("lead");
  await ready("lead");
  tmux(agents, "kill-session", "-t", "=lead");
  await until(
    () => asked.includes("open simon/app from a tab"),
    "the daemon to bring the lead back",
  );
  // The stand-in brings nothing back, and the sidebar doesn't ask again each second. The right
  // side says once that it waits, never tmux's error each second.
  await Bun.sleep(3000);
  expect(asked.filter((open) => open === "open simon/app from a tab")).toHaveLength(1);
  expect(right().split("Waiting for the lead to start.")).toHaveLength(2);
  expect(seen()).not.toContain("can't find session");
});

// The right side falls back to the lead when the builder you look at ends. A lead that went
// while you looked at the builder must be asked back then, or the right side waits forever.
test("a lead that stopped while you look at a builder is brought back once the builder ends", async () => {
  daemon();
  open("app-7");
  await ready("app-7");
  tmux(agents, "kill-session", "-t", "=lead");
  await Bun.sleep(1500);
  expect(asked).toEqual([]);
  tmux(agents, "kill-session", "-t", "=app-7");
  await until(
    () => asked.includes("open simon/app from a tab"),
    "the daemon to bring the lead back",
  );
  await until(() => right().includes("Waiting for the lead to start."), "the waiting line");
});

test("a lead you exited isn't brought back, as its tab closes", async () => {
  daemon();
  open("lead");
  await ready("lead");
  tmux(agents, "set", "-w", "-t", "=lead:", "remain-on-exit", "on");
  tmux(agents, "respawn-pane", "-k", "-t", "=lead:", "sh", "-c", "exit 0");
  await until(
    () => tmux(agents, "display-message", "-p", "-t", "=lead:", "#{pane_dead}").out.trim() === "1",
    "the lead to exit",
  );
  await Bun.sleep(2000);
  expect(asked).toEqual([]);
});

test("a repository removed while the screen shows it loses its tab, and the screen moves on", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  sql("DELETE FROM repositories WHERE repo = 'app'");
  tmux(agents, "kill-session", "-t", "=lead");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => !/\bapp\b/.test(tabRow()), "app's tab to go");
  expect(seen()).not.toContain("can't find session");
});

// sc repo rm ends the lead and waits for it before it removes the repository. A screen that
// finds the lead gone meanwhile must not take it for a crash and ask the daemon to bring back
// the lead of a repository on its way out.
test("sc repo rm while the screen shows the repository moves the screen on, and never asks for its lead", async () => {
  addSite();
  daemon();
  sql("UPDATE threads SET status = 'stopped' WHERE repo = 'app'");
  // A lead that takes a few seconds to end, as a real one can.
  tmux(agents, "kill-session", "-t", "=lead");
  startSession(agents, "lead", {
    folder: home,
    command: ["sh", "-c", "trap 'sleep 3; exit' HUP; echo I am lead; while :; do sleep 0.2; done"],
    env: { PATH: pathNow },
  });
  open("lead");
  await ready("lead");
  const script = `import { removeRepo } from ${JSON.stringify(source("flow/repo.ts"))};
await removeRepo("app", ${JSON.stringify(agents)});`;
  const removed = Bun.spawn([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  expect(await removed.exited).toBe(0);
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => !/\bapp\b/.test(tabRow()), "app's tab to go");
  expect(asked.filter((open) => open.includes("simon/app"))).toEqual([]);
  expect(seen()).not.toContain("can't find session");
});
