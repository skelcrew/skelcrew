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
import { sidebarWidth } from "../src/screen.ts";
import { startSession } from "../src/tmux.ts";

const dbFile = join(import.meta.dir, "..", "src", "db.ts");
const screenFile = join(import.meta.dir, "..", "src", "screen.ts");
const pathNow = process.env.PATH ?? "";
const sidebar = sidebarWidth;
const leaving = "Your agents keep running. Run skel to come back.";
// Longer than the waits below, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
let home = "";
let agents = "";
let screen = "";
let terminal = "";

// The sockets are the test's own too, as a sidebar tells whatever daemon it finds that it opened.
const env = () => ({ ...process.env, HOME: home, XDG_RUNTIME_DIR: join(home, "run") });
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
// The row you are looking at, as the name line with the grey background shows it. Empty
// until the sidebar has drawn one.
function selected(window = "one"): string {
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", `=${window}:`).out;
  const line = colours.split("\n").find((text) => text.includes("48;5;238"));
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
while :; do read -r line && echo "$line" >> ${name}.typed; done
`,
    { mode: 0o755 },
  );
  startSession(agents, name, { folder: home, command: [script], env: { PATH: pathNow } });
}

// Opens the screen on an agent in a terminal of its own, whose title until then is "my shell",
// and which logs how skel exited. `where` is the name a laptop's skel --remote passes along.
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
await openScreen(${JSON.stringify(agents)}, ${JSON.stringify(session)});
await Bun.write(${JSON.stringify(join(home, `left-${window}`))}, "left");`,
  );
  const named = where ? `SKEL_REMOTE_NAME=${where} ` : "";
  const title = `printf '\\033]2;my shell\\007'`;
  const command = `${title}; ${named}TERM=${term} ${process.execPath} ${script}; sleep 300`;
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
    () => seen(window).includes(`I am ${name}`) && selected(window) !== "",
    "the screen",
    window,
  );

test("shows the lead and every thread that isn't done, beside the agent", async () => {
  open("lead");
  await ready("lead");
  const lines = seen().split("\n");
  const y = lines.findIndex((line) => line.includes("◆ lead"));
  expect(y).toBeGreaterThan(2);
  expect(selected()).toBe("◆ lead");
  expect(lines[2]).toContain("I am lead");
  expect(lines[y + 1]).toContain("running · claude");
  expect(lines[y + 2]).toContain("● app-12");
  expect(lines[y + 3]).toContain("working · claude");
  expect(lines[y + 4]).toContain("● app-7");
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
  await until(() => selected() === "● app-12", "the sidebar to follow");
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
  const y = seen()
    .split("\n")
    .findIndex((line) => line.includes("● app-7"));
  click(5, y + 1);
  await until(() => seen().includes("I am app-7"), "app-7");
  type("hello\r");
  await until(() => existsSync(join(home, "app-7.typed")), "the typing");
});

test("skel attach's screen starts on the agent it names, marked in the sidebar", async () => {
  open("app-7");
  await ready("app-7");
  expect(selected()).toBe("● app-7");
});

test("updates on its own, with needs you in the sidebar", async () => {
  open("lead");
  await ready("lead");
  sql("UPDATE threads SET needs_you = 1 WHERE task = 7");
  const colours = () => tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  await until(() => colours().includes("\x1b[33m●"), "needs you");
  expect(seen()).toContain("● app-7");
  expect(seen()).toContain("needs you");
  sql("UPDATE threads SET status = 'done' WHERE task = 12");
  await until(() => !seen().includes("app-12"), "the done thread to go");
});

test("Ctrl-Q leaves the whole screen, ends no agent, and says so", async () => {
  open("lead");
  await ready("lead");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "skel to return");
  await until(() => screenSessions().length === 0, "the session to end");
  expect(tmux(screen, "list-sessions").ok).toBe(false);
  for (const name of ["lead", "app-7", "app-12"])
    expect(tmux(agents, "has-session", "-t", `=${name}`).ok).toBe(true);
  expect(tmux(agents, "list-clients", "-F", "#{client_tty}").out).toBe("");
  await until(() => seen().includes(leaving), "the line that says what happened");
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
    ('simon', 'app', 20, 'output', 'skel/20', 'working')`);
  open("output");
  await ready("output");
  for (let turn = 0; turn < 4; turn++) wheel(64);
  await until(() => seen().includes("line 160"), "the agent's older output");
  expect(seen()).not.toContain("I am output");
  expect(seen()).toContain("app-12");
  type("æble\r");
  await until(() => existsSync(join(home, "output.typed")), "the typing");
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
  await until(() => existsSync(join(home, "output.typed")), "the Enter");
  expect(readFileSync(join(home, "output.typed"), "utf8")).toBe(`${keys.join("")}\n`);
});

test("Ctrl-Q and switching still work while scrolled back", async () => {
  agent("output", history);
  sql(`INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES
    ('simon', 'app', 20, 'output', 'skel/20', 'working')`);
  open("output");
  await ready("output");
  wheel(64);
  await until(() => !seen().includes("I am output"), "the scrollback");
  press("M-Down");
  await until(() => selected() === "● app-12", "the next row");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "skel to return");
});

test("an agent drawing the full screen with the mouse gets the wheel itself", async () => {
  agent("drawn", fullScreen("drawn", "\\033[?1000h\\033[?1006h"));
  open("drawn");
  await until(() => seen().includes("I am drawn"), "the agent");
  wheel(64);
  await until(() => existsSync(join(home, "drawn.bytes")), "the wheel");
  await until(
    () => readFileSync(join(home, "drawn.bytes"), "utf8").startsWith("\x1b[<64;28;3M"),
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

test("a tmux server started by an older skel gets scrolling when the screen opens", async () => {
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
    () => readFileSync(join(home, "lead.size"), "utf8") === "28 88\n",
    "the agent's size",
  );
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "40");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "38 118\n",
    "the agent to resize",
  );
  const widths = tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out.trim().split("\n");
  expect(widths).toEqual(["31", "118"]);
  // A terminal shorter than the list keeps the row you are looking at in view.
  press("M-Down");
  press("M-Down");
  await until(() => selected() === "● app-7", "app-7");
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "7");
  await until(() => !seen().includes("switch"), "the hints to give way");
  await until(() => selected() === "● app-7", "the sidebar to scroll");
});

// The columns at the sidebar's edge, on each line below the strip: the sidebar's line, where
// the lines between lists join it, then tmux's border. Blank past the end of a line that holds
// nothing else.
const edge = (height: number) =>
  seen()
    .split("\n")
    .slice(2, height)
    .map((line) => `${line[sidebar - 1]}${line[sidebar] ?? " "}`);

test("the sidebar's line runs to the bottom, with a blank column before the agent", async () => {
  open("lead");
  await ready("lead");
  expect(new Set(edge(30))).toEqual(new Set(["│ ", "┤ "]));
  expect(seen().split("\n")[2]?.indexOf("I am lead")).toBe(sidebar + 1);
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
      seen().includes("⌃Q  quit");
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
  await until(() => seen().includes("switch"), "the hints to come back");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "skel to return");
});

test("the strip sits above the agent, and the agent's height stays as you switch", async () => {
  sql(`UPDATE threads SET title = 'Fix the login', pr = 34, checks = 'passing',
    review_round = 2, reviewer = 'claude', reviewed_by = 'codex', verdict = 'changes',
    review_line = 'A test is missing.' WHERE task = 7`);
  open("lead");
  await ready("lead");
  const height = readFileSync(join(home, "lead.size"), "utf8");
  press("M-Down");
  press("M-Down");
  const line = "app-7  Fix the login  #34  checks passing  round 2 · codex · changes";
  await until(() => seen().includes(line), "the strip");
  const [first = ""] = seen().split("\n");
  expect(first.indexOf("app-7")).toBe(sidebar + 1);
  expect(seen()).not.toContain("A test is missing.");
  expect(readFileSync(join(home, "app-7.size"), "utf8")).toBe(height);
  press("M-Up");
  await until(() => seen().split("\n")[0]?.trimEnd().endsWith("app-12") === true, "app-12's strip");
  expect(readFileSync(join(home, "app-12.size"), "utf8")).toBe(height);
});

test("above the sidebar it says just skel, in white, when no laptop sent you here", async () => {
  open("lead");
  await ready("lead");
  await until(() => seen().split("\n")[0]?.trimEnd() === "  skel", "the header");
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
  const place = (window: string) => seen(window).split("\n")[0] ?? "";
  await until(() => place("one").startsWith("  skel · sprite:demo"), "the first place");
  await until(() => place("two").trimEnd() === "  skel", "the second header", "two");
});

// The divider under the strip, as you see it.
const divider = () => (seen().split("\n")[1] ?? "").trimEnd();

test("a thin line runs under the strip, meeting the sidebar's edge, at every width", async () => {
  open("lead");
  await ready("lead");
  await until(() => divider().length === 120, "the divider");
  expect(divider().indexOf("┬")).toBe(sidebar - 1);
  expect(divider().replace("┬", "")).toMatch(/^─+$/);
  expect(seen().split("\n")[2]?.[sidebar - 1]).toBe("│");
  for (const width of [150, 90, 120]) {
    tmux(terminal, "resize-window", "-t", "=one:", "-x", String(width), "-y", "30");
    // tmux stretches the sidebar for a moment before the screen's hook sets its width back.
    await until(
      () => divider().length === width && divider().indexOf("┬") === sidebar - 1,
      `the divider at ${width}`,
    );
  }
});

test("a thread's strip follows it as it changes", async () => {
  open("app-7");
  await ready("app-7");
  await until(() => seen().split("\n")[0]?.trimEnd().endsWith("app-7") === true, "the strip");
  sql(`UPDATE threads SET review_round = 1, reviewed_by = 'codex', verdict = 'approve',
    review_line = 'Looks right.' WHERE task = 7`);
  await until(() => seen().includes("app-7  round 1 · codex · approved"), "the review");
});

test("what a title says is shown, never run or read as a format", async () => {
  const proof = join(home, "ran");
  const title = `100% %H #(touch ${proof}) #[fg=red] #{pane_pid}`;
  sql(`UPDATE threads SET title = '${title}' WHERE task = 7`);
  open("app-7");
  await ready("app-7");
  await until(() => seen().includes("#(touch"), "the strip");
  expect(seen()).toContain(title);
  await Bun.sleep(300);
  expect(existsSync(proof)).toBe(false);
});

test("clicking the strip, or turning the wheel over it, does nothing", async () => {
  open("lead");
  await ready("lead");
  click(60, 1);
  click(60, 2);
  type("\x1b[<64;60;1M");
  await Bun.sleep(200);
  const modes = tmux(screen, "list-panes", "-a", "-F", "#{pane_in_mode}").out.trim().split("\n");
  expect(modes).toEqual(["0", "0"]);
  expect(scrolledBack()).not.toContain("1");
  expect(seen()).toContain("I am lead");
});

// Puts two open issues and a PR in the database, as a poll would.
const openOnGitHub = () =>
  sql(`INSERT INTO open_items (owner, repo, kind, number, title, created) VALUES
  ('simon', 'app', 'issue', 31, 'Add CSV export', '2026-11-05T10:00:00Z'),
  ('simon', 'app', 'issue', 12, 'Fix login', '2026-11-04T10:00:00Z'),
  ('simon', 'app', 'pr', 34, 'Bump deps', '2026-11-05T10:00:00Z');
UPDATE repositories SET open_issues = 2, open_prs = 1;`);

test("open issues and PRs reach your terminal as links, through both tmux servers", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  await until(() => seen().includes("Add CSV export"), "the issue");
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  expect(colours).toContain("https://github.com/simon/app/issues/31");
  expect(colours).toContain("https://github.com/simon/app/pull/34");
  expect(seen()).toContain("Bump deps");
  expect(seen()).toContain("app#34");
});

test("the screen's server turns terminal links on, whatever your terminal says it is", async () => {
  open("lead");
  await ready("lead");
  expect(tmux(screen, "show", "-s", "terminal-features").out).toContain("hyperlinks");
});

test("a click on a link leaves the agent as it is, and Alt-Down still goes to a thread", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  await until(() => seen().includes("app-31"), "the issue");
  const y = seen()
    .split("\n")
    .findIndex((line) => line.includes("app-31"));
  click(6, y + 1);
  await Bun.sleep(300);
  expect(selected()).toBe("◆ lead");
  expect(seen()).toContain("I am lead");
  press("M-Down");
  await until(() => selected() === "● app-12", "the first thread");
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
  expect(lines.at(-2)).toContain("⌥↑↓ switch");
  expect(lines.at(-1)).toContain("⌃Q  quit");
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
  const alive = (pid: string) => existsSync(join("/proc", pid));
  await until(() => !sidebars.some(alive), "the sidebars and clients to end");
  expect(tmux(agents, "has-session", "-t", "=lead").ok).toBe(true);
});

test("when the agent you are looking at ends, the right side goes to the lead", async () => {
  open("app-7");
  await ready("app-7");
  tmux(agents, "kill-session", "-t", "=app-7");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => selected() === "◆ lead", "the sidebar to follow");
});

test("a row whose agent isn't running can't be picked", async () => {
  sql("UPDATE threads SET status = 'stopped' WHERE task = 12");
  tmux(agents, "kill-session", "-t", "=app-12");
  open("lead");
  await ready("lead");
  expect(seen()).toContain("app-12");
  click(5, 6);
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

test("the terminal's title says skel while the screen is open, and comes back after", async () => {
  open("lead");
  await ready("lead");
  await until(() => title() === "skel", "the title");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "skel to return");
  expect(title()).toBe("my shell");
});

test("the title names the machine when you came from a laptop", async () => {
  open("lead", "one", "xterm-256color", "120", "sprite:demo");
  await ready("lead");
  await until(() => title() === "skel · sprite:demo", "the title");
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
    await until(() => wrote.includes("skel\x07") || wrote.includes("skel\x1b\\"), "the title");
    expect(wrote).toContain("\x1b]2;skel");
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
  await until(() => title("two") === "skel", "the second title");
  press("M-Down");
  await until(() => seen().includes("I am app-12"), "app-12");
  expect(title()).toBe("skel · sprite:demo");
});

test("an agent's own title never reaches the terminal, even after switching", async () => {
  open("lead");
  await ready("lead");
  await until(() => title() === "skel", "the title");
  expect(tmux(agents, "list-panes", "-t", "=lead:", "-F", "#{pane_title}").out).toContain(
    "title of lead",
  );
  press("M-Down");
  await until(() => seen().includes("I am app-12"), "app-12");
  expect(title()).toBe("skel");
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
