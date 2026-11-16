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
  acted.length = 0;
  mergeAnswer = { merged: "Merged app#35." };
  release();
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
  // The lead is at the top of the sidebar, below a blank line, then a line, the entries with a
  // blank line between each, another line, then ACTIVE.
  expect(y).toBe(2);
  expect(lines[1]?.slice(0, sidebar - 1).trim()).toBe("");
  expect(selected()).toBe("◆ lead");
  expect(lines[1]).toContain("I am lead");
  expect(lines[y + 1]).toContain("running · claude");
  expect(lines[y + 2]?.slice(0, sidebar - 1)).toMatch(/^─+$/);
  expect(lines[y + 3]).toContain("Issues");
  expect(lines[y + 4]?.slice(0, sidebar - 1).trim()).toBe("");
  expect(lines[y + 5]).toContain("Threads");
  expect(lines[y + 6]?.slice(0, sidebar - 1).trim()).toBe("");
  expect(lines[y + 7]).toContain("PRs");
  expect(lines[y + 8]?.slice(0, sidebar - 1)).toMatch(/^─+$/);
  expect(lines[y + 9]).toContain("Active");
  expect(lines[y + 11]).toContain("● 12 app-12");
  expect(lines[y + 12]).toContain("claude");
  expect(lines[y + 13]).toContain("working");
  expect(lines[y + 14]).toContain("● 7 app-7");
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
  await until(() => selected() === "● 7 app-7", "the sidebar to follow");
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
    .findIndex((line) => line.includes("● 7 app-7"));
  click(5, y + 1);
  await until(() => seen().includes("I am app-7"), "app-7");
  type("hello\r");
  await until(() => existsSync(join(home, "app-7.typed")), "the typing");
});

test("sc attach's screen starts on the agent it names, marked in the sidebar", async () => {
  open("app-7");
  await ready("app-7");
  expect(selected()).toBe("● 7 app-7");
});

test("updates on its own, with needs you in the sidebar", async () => {
  open("lead");
  await ready("lead");
  sql("UPDATE threads SET needs_you = 1 WHERE task = 12");
  const colours = () => tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  await until(() => colours().includes("\x1b[38;5;221m●"), "needs you");
  expect(seen()).toContain("● 12 app-12");
  expect(seen()).toContain("needs you");
  // Its tab says so too, as other repositories' tabs would.
  expect(seen().split("\n")[0]?.trimEnd()).toMatch(/^ {2}Skelcrew v[\d.]+ +│ {3}app •1$/);
  sql("UPDATE threads SET status = 'done' WHERE task = 7");
  await until(() => !seen().includes("app-7"), "the done thread to go");
});

test("Alt-Q leaves the whole screen, ends no agent, and says so", async () => {
  open("lead");
  await ready("lead");
  press("M-q");
  await until(() => existsSync(join(home, "left-one")), "Skelcrew to return");
  await until(() => screenSessions().length === 0, "the session to end");
  expect(tmux(screen, "list-sessions").ok).toBe(false);
  for (const name of ["lead", "app-7", "app-12"])
    expect(tmux(agents, "has-session", "-t", `=${name}`).ok).toBe(true);
  expect(tmux(agents, "list-clients", "-F", "#{client_tty}").out).toBe("");
  await until(() => seen().includes(leaving), "the line that says what happened");
});

// A Mac terminal that doesn't send Option as Alt can't press Alt-Q, so Ctrl-Q leaves too.
test("Ctrl-Q still leaves, though nothing shows it", async () => {
  open("lead");
  await ready("lead");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "Skelcrew to return");
  await until(() => seen().includes(leaving), "the line that says what happened");
});

// Replaces the lead with an agent that asks for extended keys, says its name, and logs every
// byte it reads to lead.keys. Like Claude Code, it asks only when TERM_PROGRAM says it runs in
// tmux, as it can't tell from a TERM of tmux-256color alone.
function keyLoggingLead(): void {
  tmux(agents, "kill-session", "-t", "=lead");
  const script = join(home, "keys.sh");
  writeFileSync(
    script,
    `#!/bin/sh
cd ${JSON.stringify(home)}
[ "$TERM_PROGRAM" = tmux ] && printf '\\033[>4;2m'
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

// Mac terminals send Option-Left and Option-Right as Esc b and Esc f, and other terminals send
// Alt-Left and Alt-Right. All four move by word in a prompt, so they must reach the agent and
// leave the screen where it is, whether or not your terminal sends extended keys. The agent asks
// for extended keys, as Claude Code and Codex do, so Esc b and Esc f reach it as Alt-B and Alt-F
// in the form it asked for.
for (const extended of [false, true])
  test(`the keys that move by word reach the agent, from a terminal ${extended ? "with" : "without"} extended keys`, async () => {
    extendedKeys = extended;
    keyLoggingLead();
    open("lead");
    await ready("lead");
    // Each goes alone, as from a hand.
    for (const word of ["\x1bb", "\x1bf", "\x1b[1;3D", "\x1b[1;3C"]) {
      type(word);
      await Bun.sleep(100);
    }
    press("Enter");
    await until(() => read("lead.keys").endsWith("\r"), "the Enter");
    // tmux before 3.5 has only the xterm form of an extended key.
    const alt = (code: number) => (tmuxIsAtLeast(3, 5) ? `\x1b[${code};3u` : `\x1b[27;3;${code}~`);
    expect(read("lead.keys")).toBe(`${alt(98)}${alt(102)}\x1b[1;3D\x1b[1;3C\r`);
    expect(selected()).toBe("◆ lead");
    expect(seen()).toContain("I am lead");
  });

test("with a terminal that sends extended keys, the screen's own keys still work", async () => {
  extendedKeys = true;
  open("lead");
  await ready("lead");
  toSecondThread();
  await until(() => selected() === "● 7 app-7", "Alt-Shift-Down and Alt-Down to move");
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
  expect(modes).toEqual(["0", "0", "0"]);
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
  await until(() => selected() === "● 12 app-12", "the next row");
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

// What your terminal's clipboard got from the screen, by OSC 52, or nothing. The test's terminal
// keeps what a program copies as a buffer of its own, as it has no clipboard.
const clipboard = () => {
  const said = Bun.spawnSync(["tmux", "-L", terminal, "-f", "/dev/null", "show-buffer"], {
    env: { ...env(), TMUX: "" },
    stdout: "pipe",
    stderr: "ignore",
  });
  return said.stdout.toString();
};
// The left button pressed at the first place on screen, dragged through the others and let go
// at the last. Each step is a moment apart, as from a hand: tmux picks the binding for a mouse
// event as it arrives, so a release in the same read as the drag would come before copy mode
// had started.
async function drag(from: [number, number], ...through: [number, number][]): Promise<void> {
  const last = through.at(-1) ?? from;
  const moves = through.map((place) => `32;${place.join(";")}M`);
  const steps = [`0;${from.join(";")}M`, ...moves, `0;${last.join(";")}m`];
  for (const step of steps) {
    type(`\x1b[<${step}`);
    await Bun.sleep(100);
  }
}
// Where a word on a line of the agent is on screen, as the column and row a terminal counts
// from 1.
function placeOf(word: string, line: string): [number, number] {
  const rows = seen().split("\n");
  const row = rows.findIndex((text) => text.includes(line));
  return [(rows[row] ?? "").indexOf(word, (rows[row] ?? "").indexOf(line)) + 1, row + 1];
}
// What an agent to copy from prints.
const lines = 'echo "first word here"; echo "second line"';
// Opens the screen on an agent that printed `lines`, with a terminal that keeps what is copied.
async function copying(): Promise<void> {
  agent("words", lines);
  sql(`INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES
    ('simon', 'app', 20, 'words', 'skelcrew/20', 'working')`);
  open("words");
  await ready("words");
  tmux(terminal, "set", "-s", "set-clipboard", "on");
}

test("a drag over the agent copies just its text to your terminal's clipboard", async () => {
  await copying();
  const [column, row] = placeOf("first", "first word here");
  // tmux selects up to the cell before the one the button is let go on.
  await drag([column, row], [column + 10, row]);
  await until(() => clipboard() === "first word", "the copy");
  // The agents' server keeps no copy, so no agent can ask tmux for it.
  expect(tmux(agents, "list-buffers").out).toBe("");
  // Typing reaches the agent, and the agent's live screen is back.
  type("after\r");
  await until(() => read("words.typed") === "after\n", "the typing");
  expect(scrolledBack()).not.toContain("1");
});

test("a double click copies a word, and a triple click a line", async () => {
  await copying();
  // A click inside the word, not on its edge.
  const [start, row] = placeOf("second", "second line");
  const column = start + 1;
  // Clicks a number of times in quick succession, as a hand does, each a moment apart.
  const clicks = async (count: number) => {
    for (let n = 0; n < count; n++) {
      click(column, row);
      await Bun.sleep(50);
    }
  };
  await clicks(2);
  await until(() => clipboard() === "second", "the word");
  await until(() => !scrolledBack().includes("1"), "the live agent");
  // Past tmux's time for a double click, so the next three start afresh.
  await Bun.sleep(600);
  await clicks(3);
  await until(() => clipboard().startsWith("second line"), "the line");
});

test("a drag let go over the sidebar copies the agent's text up to its edge", async () => {
  await copying();
  const [column, row] = placeOf("word", "first word here");
  await drag([column, row], [column - 3, row], [10, row]);
  await until(() => clipboard() !== "", "the copy");
  expect(clipboard()).toBe("first ");
  type("after\r");
  await until(() => read("words.typed") === "after\n", "the typing");
});

test("a drag let go over the footer copies the agent's text to the end of its last row", async () => {
  await copying();
  const [column, row] = placeOf("line", "second line");
  await drag([column, row], [column + 2, row + 1], [60, 30]);
  await until(() => clipboard() !== "", "the copy");
  expect(clipboard()).toStartWith("line\nI am words\n");
});

test("copying while scrolled back keeps your place, and a key returns you to the agent", async () => {
  agent("output", history);
  open("output");
  await until(() => seen().includes("I am output"), "the agent");
  tmux(terminal, "set", "-s", "set-clipboard", "on");
  wheel(64);
  await until(() => seen().includes("line 190"), "the scrollback");
  const [column, row] = placeOf("line 190", "line 190");
  await drag([column, row], [column + 8, row]);
  await until(() => clipboard() === "line 190", "the copy");
  await Bun.sleep(300);
  expect(scrolledBack()).toContain("1");
  type("x\r");
  await until(() => read("output.typed") === "x\n", "the typing");
  expect(scrolledBack()).not.toContain("1");
});

test("an agent that asked for the mouse gets a drag itself", async () => {
  agent("drawn", fullScreen("drawn", "\\033[?1002h\\033[?1006h"));
  open("drawn");
  await until(() => seen().includes("I am drawn"), "the agent");
  await drag([60, 5], [64, 5]);
  await until(() => read("drawn.bytes").includes("\x1b[<0;25;4m"), "the release");
  expect(read("drawn.bytes")).toBe("\x1b[<0;21;4M\x1b[<32;25;4M\x1b[<0;25;4m");
  expect(scrolledBack()).not.toContain("1");
});

test("an agent's own copy reaches your terminal, and other agents can't read it", async () => {
  // An agent copies, as Claude Code's full-screen drawing does, once the test says go.
  const copy = "printf '\\033]52;c;%s\\007' $(printf 'from agent' | base64)";
  agent("copier", `while [ ! -e go ]; do sleep 0.1; done; ${copy}`);
  open("copier");
  await until(() => tmux(agents, "list-clients").out !== "", "the screen to show the agent");
  tmux(terminal, "set", "-s", "set-clipboard", "on");
  writeFileSync(join(home, "go"), "");
  await until(() => clipboard() === "from agent", "the agent's copy");
  // The agents' server keeps no copy, so a program asking tmux for the clipboard gets nothing.
  expect(tmux(agents, "list-buffers").out).toBe("");
});

test("resizing the terminal resizes the agent and keeps the sidebar narrow", async () => {
  open("lead");
  await ready("lead");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "26 81\n",
    "the agent's size",
  );
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "40");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "36 111\n",
    "the agent to resize",
  );
  const widths = tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out.trim().split("\n");
  expect(widths).toEqual(["38", "111", "150"]);
  // A terminal shorter than the list keeps the row you are looking at in view.
  toSecondThread();
  await until(() => selected() === "● 7 app-7", "app-7");
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "6");
  await until(() => selected() === "● 7 app-7", "the sidebar to scroll");
});

// The columns at the sidebar's edge, on each line of a screen `height` rows high above the
// footer, its line and the gap tmux leaves above them: the sidebar's line, where the lines between
// lists join it, then tmux's border. Blank past the end of a line that holds nothing else.
const edge = (height: number) =>
  seen()
    .split("\n")
    .slice(0, height - 3)
    .map((line) => `${line[sidebar - 1]}${line[sidebar] ?? " "}`);

test("the sidebar's line runs down to the footer, with a blank column before the agent", async () => {
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
      seen().includes("⌥Q quit");
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
  await until(() => seen().includes("⌥↑↓ move"), "the footer to come back");
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

// The bottom row as you see it, across the whole screen, without the machine's load at its right
// end, which comes and changes on its own, and the row above it.
const footer = () =>
  (seen().split("\n")[29] ?? "").replace(/ +cpu \d+% {2}mem [\d.]+\/\d+G *$/, "").trimEnd();
const aboveFooter = () => (seen().split("\n")[28] ?? "").trimEnd();
// What the footer says under a list or page: the keys you need most and ? keys, then s or m on a
// row that can be started or merged.
const listKeys = "  ⌥↑↓ move  ⌥Q quit  ? keys";
const startKeys = `${listKeys}  s start`;
const mergeKeys = `${listKeys}  m merge`;

test("the footer runs across the screen under a thin line, with move and quit, then what Esc stops", async () => {
  sql("UPDATE threads SET harness = 'codex' WHERE task = 7");
  open("lead");
  await ready("lead");
  const lead = "  ⌥↑↓ move  ⌥Q quit  Esc stops claude";
  await until(() => footer() === lead, "the lead's footer");
  expect(aboveFooter()).toBe("─".repeat(120));
  toSecondThread();
  await until(() => seen().includes("I am app-7"), "app-7");
  await until(() => footer() === "  ⌥↑↓ move  ⌥Q quit  Esc stops codex", "app-7's footer");
});

test("the footer ends with the machine's load, even with no thread working", async () => {
  sql("UPDATE threads SET status = 'waiting' WHERE status = 'working'");
  open("lead");
  await ready("lead");
  // The load shows from its second sample, 5 seconds after the footer starts.
  await until(
    () => /cpu \d+% {2}mem [\d.]+\/\d+G *$/.test(seen().split("\n")[29] ?? ""),
    "the load",
  );
  expect(footer()).toBe("  ⌥↑↓ move  ⌥Q quit  Esc stops claude");
});

test("under a list or page the footer adds ? keys, and s or m while the row can take it, and the agent's height stays", async () => {
  await openIssue();
  expect(footer()).toBe(startKeys);
  press("Left");
  await until(() => !tabRow().includes("app-31"), "the strip to go");
  expect(footer()).toBe(startKeys);
  // app#12 has a thread already, so it can't be started.
  press("Down");
  await until(() => footer() === listKeys, "no s on a started issue");
  clickRow("PRs");
  // The PR isn't approved yet, so it can't be merged.
  await until(() => right().includes("Bump deps") && !right().includes("Fix login"), "the PRs");
  await until(() => footer() === listKeys, "no m on a PR that isn't ready");
  clickRow("    Threads");
  await until(() => right().includes("Working"), "the threads");
  expect(footer()).toBe(listKeys);
  press("M-S-Up");
  await until(() => footer().endsWith("⌥Q quit  Esc stops claude"), "the lead's footer");
  expect(readFileSync(join(home, "lead.size"), "utf8")).toBe("26 81\n");
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
  open("lead", "one", "xterm-256color", "120", "simon@workbox");
  await ready("lead");
  open("lead", "two");
  await ready("lead", "two");
  const place = (window: string) => (seen(window).split("\n")[0] ?? "").slice(0, sidebar - 1);
  await until(
    () => place("one").startsWith(`  Skelcrew v${checkout.version} · simon@`),
    "the first place",
  );
  await until(
    () => place("two").trimEnd() === `  Skelcrew v${checkout.version}`,
    "the second header",
    "two",
  );
});

test("the sidebar's edge runs from the top row down to the footer, at every width", async () => {
  open("lead");
  await ready("lead");
  const column = () =>
    seen()
      .split("\n")
      .slice(0, 27)
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
  expect(modes).toEqual(["0", "0", "0"]);
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

test("the entries sit between the lead and ACTIVE, counting what their lists have", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  await until(() => /Issues +2/.test(seen()), "the entries");
  const lines = seen()
    .split("\n")
    .map((line) => line.slice(0, sidebar - 1).trimEnd());
  const at = (text: string) => lines.findIndex((line) => line.includes(text));
  // Each count ends two columns before the sidebar's edge.
  expect(lines[at("Issues")]).toBe(`${"    Issues".padEnd(34)}2`);
  expect(lines[at("    Threads")]).toBe(`${"    Threads".padEnd(34)}2`);
  expect(lines[at("PRs")]).toBe(`${"    PRs".padEnd(34)}1`);
  expect(at("◆ lead")).toBeLessThan(at("Issues"));
  expect(at("PRs")).toBeLessThan(lines.indexOf("  Active"));
});

test("the screen's server turns terminal links on, whatever your terminal says it is", async () => {
  open("lead");
  await ready("lead");
  expect(tmux(screen, "show", "-s", "terminal-features").out).toContain("hyperlinks");
});

// Stands in for the daemon on the test's own socket: it logs each repository asked to open,
// saying when a tab asked, which must never open a tab you closed, and answers with nothing to
// say.
// It also logs each thread started and PR merged, in `acted`, answering a merge with
// `mergeAnswer`. While `holding`, those wait for `release`, so a test sees what the screen says
// meanwhile.
const asked: string[] = [];
const acted: string[] = [];
let mergeAnswer: object = { merged: "Merged app#35." };
let holding = false;
const waiting: (() => void)[] = [];
const release = () => {
  holding = false;
  for (const reply of waiting.splice(0)) reply();
};
function daemon(): void {
  const answer = (connection: Socket) =>
    connection.on("data", (data) => {
      const { command, from, tab, repo, task, pr, commit } = z
        .object({
          command: z.string(),
          from: z.string().default(""),
          tab: z.boolean().default(false),
          repo: z.string().default(""),
          task: z.string().default(""),
          pr: z.number().default(0),
          commit: z.string().default(""),
        })
        .parse(JSON.parse(data.toString()));
      if (command === "lead") asked.push(`open ${from}${tab ? " from a tab" : ""}`);
      if (command !== "start" && command !== "merge") {
        connection.end("{}\n");
        return;
      }
      acted.push(command === "start" ? `start ${repo} ${task}` : `merge ${repo} ${pr} ${commit}`);
      const said = command === "start" ? { started: `Started app-${task}.` } : mergeAnswer;
      const reply = () => connection.end(`${JSON.stringify(said)}\n`);
      if (holding) waiting.push(reply);
      else reply();
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
  await until(() => /Issues +\d/.test(seen()), "the entries");
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

test("Left goes back from a page to its list, on the row you opened", async () => {
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
  press("Up");
  press("Left");
  await onRight("↑↓ move");
  press("Up");
  press("Enter");
  await onRight("line 1 of the description");
});

// Right opens as Left goes back, so the arrows alone take you in and out of a list.
test("Right opens the row on each kind of list, as Enter does", async () => {
  await openList("Issues");
  press("Right");
  await onRight("line 1 of the description");
  press("Left");
  await onRight("↑↓ move");
  clickRow("PRs");
  // The issues list says "↑↓ move" too, so wait until its rows have gone, or Right could open an
  // issue before the PRs list draws.
  await until(() => right().includes("Bump deps") && !right().includes("Fix login"), "the PRs");
  press("Right");
  await onRight("Approved. · codex");
  clickRow("    Threads");
  await onRight("Working");
  press("Right");
  await until(() => seen().includes("I am app-12"), "the agent");
});

// In an agent Esc stops its turn, so Esc going back on a page would teach your hand to reach for
// it to leave an agent too. An Esc takes about half a second to arrive through the terminals, so
// each wait is longer than that.
test("Esc does nothing on a list or a page", async () => {
  await openList("Issues");
  press("Down");
  press("Escape");
  await Bun.sleep(1500);
  expect(right()).toContain("↑↓ move");
  expect(selected()).toContain("Issues");
  press("Enter");
  await onRight("← back");
  press("Escape");
  await Bun.sleep(1500);
  expect(right()).toContain("← back");
  expect(right()).toContain("Fix login");
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
  await until(() => selected() === "● 12 app-12", "the sidebar to follow");
  type("from the list\r");
  await until(() => read("app-12.typed").includes("from the list"), "what you typed");
});

// What the footer says, as you see it: a line in place of its keys, or its keys back.
const says = (text: string) =>
  until(
    () => footer() === (text.startsWith("  ") ? text : `  ${text}`),
    `the footer to say ${text}`,
  );

test("s on an issue asks first, any key but y leaves it be, and y starts a thread on it", async () => {
  daemon();
  await openList("Issues");
  await says(startKeys);
  type("s");
  await says("Start a thread on app#31? y/n");
  type("n");
  await says(startKeys);
  // The key that left it be does nothing else: the list stays on its row.
  type("s");
  await says("Start a thread on app#31? y/n");
  press("Down");
  await says(startKeys);
  expect(acted).toEqual([]);
  type("s");
  await says("Start a thread on app#31? y/n");
  holding = true;
  type("y");
  await says("Starting app-31…");
  // The line changes as the request goes out, so it can show before the daemon has it.
  await until(() => acted.length === 1, "the start");
  expect(acted).toEqual(["start simon/app 31"]);
  release();
  await says(startKeys);
});

test("s on an issue a thread works on says which thread, until the next key", async () => {
  daemon();
  await openList("Issues");
  press("Down");
  type("s");
  await says("app#12 already has app-12");
  // The next key does what it does, and the footer's keys come back, with no s on this issue.
  press("Enter");
  await says(listKeys);
  await onRight("← back");
  expect(right()).toContain("Fix login");
  expect(acted).toEqual([]);
});

test("s on an issue's page starts a thread on that issue", async () => {
  daemon();
  await openIssue();
  type("s");
  await says("Start a thread on app#31? y/n");
  type("y");
  await until(() => acted.length === 1, "the start");
  expect(acted).toEqual(["start simon/app 31"]);
  await says(startKeys);
});

// A PR approved with its checks passing, which the forge last sent at a head commit.
const readyPr = (id = 35, created = "2026-11-06T10:00:00Z") =>
  sql(
    itemSql("app", "pr", id, `Add export ${id}`, created, {
      head: "c".repeat(40),
      checks: [{ name: "test", id: "1", state: "passed" }],
      reviews: [
        {
          id: "1",
          text: "Fine.",
          author: { login: "ana", bot: false, you: false },
          verdict: "approved",
          lines: [],
        },
      ],
    }),
  );

// The forge's reason comes from outside, so it is shown as written: never read as tmux's
// format, which would restyle the row, run a command, or cut it at the comma.
test("m on a ready PR asks first, y merges it at the commit you saw, and a refusal says why", async () => {
  daemon();
  readyPr();
  await openList("PRs");
  await onRight("Ready to merge");
  type("m");
  await says("Merge app#35 into main? y/n");
  holding = true;
  mergeAnswer = { error: "Blocked, by rule #[fg=red]2 #{pane_index} {main} 100%" };
  type("y");
  await says("Merging app#35…");
  await until(() => acted.length === 1, "the merge");
  expect(acted).toEqual([`merge simon/app 35 ${"c".repeat(40)}`]);
  release();
  await says("Blocked, by rule #[fg=red]2 #{pane_index} {main} 100%");
  // app#34 isn't ready, so the footer has no m on it.
  press("Down");
  await says(listKeys);
  mergeAnswer = { merged: "Merged app#35." };
  press("Up");
  type("m");
  await says("Merge app#35 into main? y/n");
  type("y");
  await until(() => acted.length === 2, "the second merge");
  await says(mergeKeys);
});

// A page is read once, but what s and m do follows Skelcrew's copy as it changes meanwhile.
test("m on a PR's page asks to merge once the PR became ready while the page was open", async () => {
  daemon();
  sql(itemSql("app", "pr", 35, "Add export", "2026-11-06T10:00:00Z", { head: "c".repeat(40) }));
  await openList("PRs");
  await onRight("app#35");
  press("Enter");
  await until(() => tabRow().includes("app#35"), "the PR's strip");
  type("m");
  await says("app#35 isn't approved yet");
  press("Down");
  await says(listKeys);
  readyPr();
  // The page's row is read again, so m shows once the PR is ready.
  await says(mergeKeys);
  type("m");
  await says("Merge app#35 into main? y/n");
  type("n");
  await says(mergeKeys);
  expect(acted).toEqual([]);
});

// A page shows one issue or PR, so s and m act on that one, even when the list behind it
// changed and another row took its place.
test("m on the page of a PR that closed meanwhile merges nothing, though another ready PR took its row", async () => {
  daemon();
  readyPr(35, "2026-11-06T10:00:00Z");
  readyPr(36, "2026-11-01T10:00:00Z");
  await openList("PRs");
  await onRight("app#36");
  press("Enter");
  await until(() => tabRow().includes("app#35"), "the PR's strip");
  await says(mergeKeys);
  sql("UPDATE items SET state = 'closed' WHERE kind = 'pr' AND id = '35'");
  await says(listKeys);
  type("m");
  await says("This PR is no longer open");
  await Bun.sleep(300);
  expect(acted).toEqual([]);
  expect(right()).toContain("Add export 35");
});

test("s on the page of an issue that closed meanwhile starts nothing", async () => {
  daemon();
  await openIssue();
  await says(startKeys);
  sql("UPDATE items SET state = 'closed' WHERE kind = 'task' AND id = '31'");
  await says(listKeys);
  type("s");
  await says("This issue is no longer open");
  await Bun.sleep(300);
  expect(acted).toEqual([]);
});

// The question names one PR, and y merges that one, however the list moved meanwhile.
test("y merges the PR the question named, even after the list moved under it", async () => {
  daemon();
  readyPr(35, "2026-11-06T10:00:00Z");
  readyPr(36, "2026-11-01T10:00:00Z");
  await openList("PRs");
  await onRight("app#36");
  type("m");
  await says("Merge app#35 into main? y/n");
  sql("UPDATE items SET state = 'closed' WHERE kind = 'pr' AND id = '35'");
  await until(() => !right().includes("app#35"), "the list to drop app#35");
  type("y");
  await until(() => acted.length === 1, "the merge");
  expect(acted).toEqual([`merge simon/app 35 ${"c".repeat(40)}`]);
});

test("s on an issue's page, once its thread started, says the issue has it", async () => {
  daemon();
  await openIssue();
  type("s");
  await says("Start a thread on app#31? y/n");
  type("y");
  await until(() => acted.length === 1, "the start");
  await says(startKeys);
  // The daemon records the thread, as sc start does.
  sql(`INSERT INTO threads (owner, repo, task, folder, branch, status, needs_you)
    VALUES ('simon', 'app', 31, 'app-31', 'skelcrew/31', 'working', 0);`);
  type("s");
  await says("app#31 already has app-31");
  expect(acted).toEqual(["start simon/app 31"]);
});

test("m on a PR that isn't ready says what it waits on, and merges nothing", async () => {
  daemon();
  await openList("PRs");
  press("Enter");
  await onRight("← back");
  type("m");
  await says("app#34 isn't approved yet");
  press("Left");
  await says(listKeys);
  expect(acted).toEqual([]);
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
  expect(right()).toContain("passed");
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
  open("lead", "one", "xterm-256color", "120", "simon@workbox");
  await ready("lead");
  // Your terminal keeps what a program copies, as Ghostty does.
  tmux(terminal, "set", "-s", "set-clipboard", "on");
  await until(() => /Issues +2/.test(seen()), "the entries");
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

test("Alt-Shift-Down and Alt-Shift-Up jump between the lead, the entries and ACTIVE", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await onRight("Not started");
  press("M-S-Down");
  await until(() => selected() === "● 12 app-12", "the first row of ACTIVE");
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
  // A client attaching slowly, as over a slow link, can't be switched yet.
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
  expect(selected()).toBe("● 7 app-7");
  expect(seen()).toContain("I am app-7");
});

test("a pane too narrow for a page's lines cuts them, so every line keeps its own row", async () => {
  await openList("Issues", "49");
  press("Enter");
  await onRight("Author");
  const panes = tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out.trim().split("\n");
  // The right side is the second pane, after the sidebar and before the footer.
  const width = Number(panes[1]);
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
  // The sidebar, the right side and the footer.
  expect(running().trim().split("\n")).toHaveLength(3);
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
  await until(() => /Issues +3/.test(seen()), "the count");
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
  // Four notches reach the list's end, where app-124 is the first issue. The first notch alone
  // already hides app-139, and the last moves fewer lines, so the wait is for the end.
  await until(() => !right().includes("app-125"), "the list to scroll to its end");
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

test("with nothing working, an open screen sends your terminal nothing but the machine's load", async () => {
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
  // Long enough for the load to refresh at least once.
  await Bun.sleep(6000);
  // tmux puts the cursor on a row and column before it writes there. Any text after a place
  // above the footer's two rows, at the bottom of the 30, is something else changing on its own.
  // A line feed, or a move or scroll up or down, could reach another row without naming it, so
  // none may come at all.
  const sent = existsSync(written) ? readFileSync(written, "utf8") : "";
  const esc = "\x1b";
  expect(sent).not.toMatch(new RegExp(`\\n|${esc}\\[\\d*[ABEFdLMST]|${esc}[DEM]`));
  const [before, ...placed] = sent.split(new RegExp(`${esc}\\[(\\d+);\\d+H`));
  expect(Bun.stripANSI(before ?? "")).toBe("");
  for (let at = 0; at < placed.length; at += 2) {
    const text = Bun.stripANSI(placed[at + 1] ?? "").trim();
    if (Number(placed[at]) < 29) expect(text).toBe("");
  }
});

test("a working thread's time moves on by itself, and writes when it does", async () => {
  sql(`UPDATE threads SET started = ${Date.now() - 58_000} WHERE folder = 'app-12'`);
  open("lead");
  await ready("lead");
  await until(() => seen().includes("claude · <1m"), "the time to start");
  const written = join(home, "written");
  tmux(terminal, "pipe-pane", "-O", "-t", "=one:", `cat >> ${written}`);
  await until(() => seen().includes("claude · 1m"), "the time to move on");
  await until(() => existsSync(written) && readFileSync(written, "utf8") !== "", "the write");
});

test("the footer has only the keys you need most, and a click on it away from ? keys does nothing", async () => {
  open("lead");
  await ready("lead");
  await until(() => footer().startsWith("  ⌥↑↓ move  ⌥Q quit"), "the footer");
  expect(seen()).not.toContain("? keys");
  expect(seen()).not.toContain("⌃Q");
  expect(seen()).not.toContain("⌥⇧↑↓");
  expect(seen()).not.toContain("⌥←→");
  click(5, 30);
  click(5, 29);
  click(5, 28);
  await Bun.sleep(200);
  expect(selected()).toBe("◆ lead");
  expect(keysOpen()).toBe(false);
});

// The rows of keys across the screen, between the thin line above them and the one above the
// footer. None while they are hidden.
function keysShown(): string[] {
  // The footer is the last row with anything on it, under its line.
  const lines = seen().trimEnd().split("\n");
  const footerLine = lines.length - 2;
  const rule = (line: string) => /^─{40,}$/.test(line.trimEnd());
  const above = lines.findLastIndex((line, at) => at < footerLine && rule(line));
  return above < 0 ? [] : lines.slice(above + 1, footerLine).map((text) => text.trimEnd());
}
const keysOpen = () => keysShown().some((line) => line.trim() !== "");
// Each key shown, as "key to what it does", down the first column, then the next.
function keyItems(): string[] {
  const cells = keysShown().map((line) => line.trim().split(/\s{3,}/));
  const columns = Math.max(0, ...cells.map((row) => row.length));
  return Array.from({ length: columns }, (_, column) =>
    cells.flatMap((row) => (row[column] ? [row[column]] : [])),
  ).flat();
}
// How many rows the right side has.
const rightHeight = () =>
  Number(tmux(screen, "display-message", "-p", "-t", ":.1", "#{pane_height}").out.trim());

test("? on a list shows the keys in columns across the screen above the footer, and ? hides them", async () => {
  await openList("Issues");
  const height = rightHeight();
  type("?");
  await until(() => keyItems().includes("enter/→ to open a row"), "the list of keys");
  // The keys sit just above the footer's line, across the sidebar too, in more than one column,
  // with no headings.
  expect(aboveFooter()).toBe("─".repeat(120));
  expect(footer()).toBe(startKeys);
  expect(keysShown().at(-1)?.trim()).not.toBe("");
  expect(keysShown()[0]?.startsWith("  alt + ↑/↓")).toBe(true);
  expect(keysShown().some((line) => line.trim().split(/\s{3,}/).length > 1)).toBe(true);
  expect(keyItems()[0]).toBe("alt + ↑/↓ to move in the sidebar");
  expect(keyItems().at(-1)).toBe("← to go back from a page");
  expect(seen()).not.toContain("Anywhere");
  // The sidebar and the right side are that many rows shorter, and nothing is drawn over them.
  expect(rightHeight()).toBe(height - keysShown().length - 1);
  expect(right()).toContain("↑↓ move");
  expect(right()).toContain("app-31");
  type("?");
  await until(() => !keysOpen(), "the list of keys to hide");
  expect(rightHeight()).toBe(height);
});

test("while the keys show every key works as usual, and they stay until ? hides them", async () => {
  await openIssue();
  type("?");
  await until(keysOpen, "the list of keys");
  // Up and Down scroll the page, and Left goes back to the list.
  press("Down");
  await until(() => !right().includes("← back"), "the page to scroll");
  press("Left");
  await onRight("↑↓ move");
  press("Down");
  await until(() => footer() === listKeys, "the next row");
  // A click in the sidebar still opens another list.
  clickRow("PRs");
  await until(() => right().includes("Bump deps"), "the PRs");
  expect(keysOpen()).toBe(true);
  type("?");
  await until(() => !keysOpen(), "the list of keys to hide");
  expect(right()).toContain("Bump deps");
});

test("moving onto an agent hides the keys", async () => {
  await openList("Issues");
  type("?");
  await until(keysOpen, "the list of keys");
  press("M-S-Up");
  await until(() => footer().endsWith("⌥Q quit  Esc stops claude"), "the lead's footer");
  await until(() => !keysOpen(), "the list of keys to hide");
  expect(seen()).toContain("I am lead");
});

test("Alt-/ is no key of Skelcrew's, and plain ? on an agent is the agent's, so neither shows the keys", async () => {
  open("lead");
  await ready("lead");
  type("\x1b/");
  type("?");
  press("Enter");
  await until(() => read("lead.typed").includes("?"), "the agent to get ?");
  expect(keysOpen()).toBe(false);
});

test("a click on ? keys in the footer shows the keys, and a click on them hides them", async () => {
  await openList("Issues");
  await until(() => footer() === startKeys, "the footer");
  const x = footer().indexOf("? keys") + 2;
  click(x, 30);
  await until(keysOpen, "the list of keys");
  click(10, 28 - 1);
  await until(() => !keysOpen(), "the list of keys to hide");
  click(x, 30);
  await until(keysOpen, "the list of keys again");
  click(x, 30);
  await until(() => !keysOpen(), "the list of keys to hide again");
  expect(right()).toContain("app-31");
});

test("the list of keys has the same keys as sc --help, in the same order", async () => {
  await openList("Issues");
  type("?");
  await until(keysOpen, "the list of keys");
  const run = Bun.spawnSync([process.execPath, source("main.ts"), "--help"], { env: env() });
  const help = run.stdout.toString();
  const keys = help
    .slice(help.indexOf("\nKEYS\n") + "\nKEYS\n".length, help.indexOf("\nEXAMPLES\n"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) =>
      line
        .trim()
        .split(/\s{2,}/)
        .join(" to "),
    );
  expect(keyItems()).toEqual(keys);
  expect(keyItems()).toContain("alt + shift + ←/→ to switch repository");
});

test("keys that need more than a third of the screen scroll with the wheel", async () => {
  await openList("Issues", "80");
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "80", "-y", "12");
  await until(() => seen().split("\n")[11]?.trimEnd() === startKeys, "the resize");
  type("?");
  await until(() => keyItems().includes("alt + ↑/↓ to move in the sidebar"), "the list of keys");
  // The screen has twelve rows, so the keys have four of the five they need at this width.
  expect(keysShown()).toHaveLength(4);
  const lines = seen().split("\n");
  const keysAt = lines.findIndex((line) => line.startsWith("  alt + ↑/↓"));
  const scrolled = () =>
    seen()
      .split("\n")
      .slice(keysAt, keysAt + 4)
      .join("\n");
  expect(scrolled()).not.toContain("← to go back from a page");
  for (let n = 0; n < 10; n++) type(`\x1b[<65;60;${keysAt + 2}M`);
  await until(() => scrolled().includes("← to go back from a page"), "the end");
  expect(scrolled()).not.toContain("alt + ↑/↓ to move in the sidebar");
  for (let n = 0; n < 10; n++) type(`\x1b[<64;60;${keysAt + 2}M`);
  await until(() => scrolled().includes("alt + ↑/↓ to move in the sidebar"), "the start");
});

test("two terminals each get their own session, and leaving one leaves the other", async () => {
  open("lead", "one");
  await ready("lead", "one");
  open("app-7", "two");
  await ready("app-7", "two");
  expect(screenSessions()).toHaveLength(2);
  press("M-Up", "two");
  await until(() => selected("two") === "● 12 app-12", "the second to switch", "two");
  expect(selected("one")).toBe("◆ lead");
  press("C-q", "one");
  await until(() => screenSessions().length === 1, "the first to end");
  press("M-Down", "two");
  await until(() => selected("two") === "● 7 app-7", "the second to go on working", "two");
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
  expect(seen()).toContain("● 12 app-12");
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
  open("lead", "one", "xterm-256color", "120", "simon@workbox");
  await ready("lead");
  await until(() => title() === "Skelcrew · simon@workbox", "the title");
});

test("two terminals on one machine keep a title each", async () => {
  open("lead", "one", "xterm-256color", "120", "simon@workbox");
  await ready("lead");
  open("lead", "two");
  await ready("lead", "two");
  await until(() => title("two") === "Skelcrew", "the second title");
  toFirstThread();
  await until(() => seen().includes("I am app-12"), "app-12");
  expect(title()).toBe("Skelcrew · simon@workbox");
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

test("Alt-Shift-Right and Alt-Shift-Left switch both sides to the repository beside, and open it", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  press("M-S-Right");
  await until(() => seen().includes(`I am ${siteLead}`), "site's lead");
  await until(() => seen().includes("site-8") && !seen().includes("app-12"), "site's threads");
  expect(selected()).toBe("◆ lead");
  await until(() => asked.includes("open simon/site from a tab"), "the daemon to open site");
  type("hello\r");
  await until(() => existsSync(join(home, `${siteLead}.typed`)), "the typing");
  // There is no tab after the last.
  press("M-S-Right");
  await Bun.sleep(300);
  expect(seen()).toContain(`I am ${siteLead}`);
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
  await until(() => selected() === "● 12 app-12", "the sidebar to follow");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});

test("Alt-Shift-Right then Alt-Shift-Down twice, typed together, lands on the new repository's thread", async () => {
  addSite();
  agent("site-8");
  daemon();
  open("lead");
  await ready("lead");
  type("\x1b[1;4C\x1b[1;4B\x1b[1;4B");
  await until(() => seen().includes("I am site-8"), "site-8");
  await until(() => selected() === "● 8 site-8", "the sidebar to follow");
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
  // The sidebar asks the daemon without waiting, and its request goes out only after it has
  // shown site, so site can show before the request lands.
  await until(() => asked.includes("open simon/site from a tab"), "the daemon to open site");
  // Nothing of app's ended: its builders still run.
  expect(tmux(agents, "has-session", "-t", "=app-7").ok).toBe(true);
});

test("the last tab closing moves the screen to the tab before it", async () => {
  addSite();
  daemon();
  open("lead");
  await ready("lead");
  press("M-S-Right");
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
