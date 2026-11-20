// The screen and the agents it shows: switching between them, the keys that reach them,
// scrolling back and copying their text, several terminals, and your terminal's title.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startSession, stillRunning } from "../src/agents/sessions.ts";
import { tmuxIsAtLeast } from "../src/agents/tmux.ts";
import { threadSql } from "./harness.ts";
import {
  agent,
  agentColumn,
  agents,
  attachTo,
  click,
  endTest,
  env,
  given,
  home,
  labels,
  leaving,
  onDetails,
  onLead,
  open,
  pathNow,
  press,
  read,
  ready,
  right,
  screen,
  screenFile,
  screenSessions,
  scrolledBack,
  seen,
  selected,
  sidebar,
  sql,
  startTest,
  terminal,
  tmux,
  toFirstThread,
  toSecondThread,
  type,
  until,
  wheel,
} from "./screen.ts";

// Longer than the screen's waits, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
beforeEach(startTest);
afterEach(endTest);

test("shows the lead, then Needs you and the stages, beside the agent", async () => {
  open("lead");
  await ready("lead");
  const lines = seen().split("\n");
  const left = (y: number) => lines[y]?.slice(0, sidebar - 1).trimEnd();
  // The lead is at the top of the sidebar, below a blank line, then a blank line, Needs you and
  // the six stages, with only Building open.
  expect(left(1)).toBe("");
  expect(lines[1]).toContain("I am lead");
  expect(left(2)).toMatch(/^ ▸ ○ lead\b/);
  expect(left(3)).toBe("     running");
  expect(left(4)).toBe("");
  expect(left(5)).toBe("   Needs you 0");
  expect(left(6)).toBe(" 1 Backlog   0");
  expect(left(7)).toBe(" 2 Building  2");
  expect(left(8)).toMatch(/^ {3}○ app-12/);
  expect(left(9)).toMatch(/^ {5}working/);
  expect(left(10)).toMatch(/^ {3}○ app-7/);
  expect(left(12)).toBe("");
  expect(left(13)).toBe(" 3 Reviewing 0");
  expect(left(16)).toBe(" 6 Done      1");
  expect(selected()).toMatch(/^▸ ○ lead\b/);
  // Nothing of the screen is left in agents' sessions: each stays one pane.
  const panes = tmux(agents, "list-panes", "-a", "-F", "#{session_name}").out.trim().split("\n");
  expect(panes.sort()).toEqual(["app-12", "app-7", "lead"]);
});

test("Alt-Down and Alt-Up move the sidebar, and Enter on a task types to its builder", async () => {
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(() => selected().includes("app-12") && onDetails(), "app-12's details");
  press("M-Down");
  await until(() => selected().includes("app-7"), "the sidebar to move");
  await attachTo("app-7");
  type("hello\r");
  // The agent's shell makes the file before it writes the line, so wait for the whole line.
  await until(() => read("app-7.typed").endsWith("\n"), "the typing");
  expect(readFileSync(join(home, "app-7.typed"), "utf8")).toBe("hello\n");
  press("M-Up");
  await attachTo("app-12");
  type("back\r");
  await until(() => existsSync(join(home, "app-12.typed")), "the typing");
});

test("a click on a task shows its details, and a second click types to its builder", async () => {
  open("lead");
  await ready("lead");
  const y = seen()
    .split("\n")
    .findIndex((line) => line.includes("○ app-7"));
  click(5, y + 1);
  await until(() => selected().includes("app-7") && onDetails(), "app-7's details");
  click(5, y + 1);
  await until(() => !onDetails() && seen().includes("I am app-7"), "app-7");
  type("hello\r");
  await until(() => existsSync(join(home, "app-7.typed")), "the typing");
});

// A builder on a plugin's host is reached from the sidebar too: Enter on its row runs the host's
// own attach on the right.
test("Enter on a builder on a plugin's host attaches to it through that host", async () => {
  tmux(agents, "kill-session", "-t", "=app-12");
  const plugin = join(home, "plugin-fake");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "session.sh"),
    `read -r question; echo >> listed; echo '{"sessions":[{"id":"fake-app-12","running":true,"labels":null}]}'\n`,
  );
  writeFileSync(join(plugin, "attach.sh"), 'echo "I am $1 on fake"; exec sleep 300\n');
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    "name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: A host\nkind: runtime\nprovides: [sessions]\nsession: [sh, session.sh]\nattach: [sh, attach.sh]\n",
  );
  sql(`INSERT INTO plugins (name, folder) VALUES ('fake', '${plugin}');
UPDATE threads SET host = 'fake', host_id = 'fake-app-12' WHERE folder = 'app-12'`);
  open("lead");
  await ready("lead");
  // The sidebar asks the host in the background: once it asks a second time, it has the first
  // answer, and shows the builder running.
  await until(
    () => read(join("plugin-fake", "listed")).split("\n").length > 2,
    "the sidebar to ask the host",
  );
  press("M-S-Down");
  await until(onDetails, "app-12's details");
  press("Enter");
  await until(() => seen().includes("I am fake-app-12 on fake"), "the host's attach");
  await until(() => selected().includes("app-12"), "the sidebar to follow");
});

test("the screen starts on the lead's row, even while a task needs you", async () => {
  sql("UPDATE threads SET needs_you = 1 WHERE task = 12");
  open("lead");
  await ready("lead");
  await until(() => seen().includes("● app-12"), "app-12 under Needs you");
  expect(selected()).toMatch(/^▸ ○ lead\b/);
});

test("updates on its own, with needs you in the sidebar", async () => {
  open("lead");
  await ready("lead");
  sql("UPDATE threads SET needs_you = 1 WHERE task = 12");
  const colours = () => tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  await until(() => colours().includes("\x1b[38;5;221m●"), "needs you");
  expect(seen()).toContain("● app-12");
  expect(seen()).toContain("Needs you 1");
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

// Ctrl-\ only leaves an agent opened alone. Were it to reach the agents' server, it would detach
// the agent's pane and leave it empty, so the screen takes it and does nothing.
test("Ctrl-\\ leaves neither the screen nor the agent", async () => {
  open("lead");
  await ready("lead");
  press("C-\\");
  await Bun.sleep(300);
  expect(existsSync(join(home, "left-one"))).toBe(false);
  expect(seen()).toContain("I am lead");
  expect(tmux(agents, "list-clients", "-F", "#{client_tty}").out).not.toBe("");
  type("hello\r");
  await until(() => existsSync(join(home, "lead.typed")), "the typing");
});

// The sidebar, the footer and other terminals ask the screen's server things all the time. tmux
// 3.6 could crash when one of those commands ended just as a terminal left, and every terminal
// on the server lost its screen. Eight loops of commands make that moment common: leaving by
// detaching crashed the server in every one of six runs. So each key that leaves does so twice
// while they run, and a second terminal must keep its screen throughout.
test("leaving never takes the screen away from another terminal, however busy the server", async () => {
  open("lead", "two");
  await ready("lead", "two");
  const asking = `while tmux -L ${screen} -f /dev/null list-clients >/dev/null 2>&1; do :; done`;
  const busy = Array.from({ length: 8 }, () =>
    Bun.spawn(["sh", "-c", asking], { env: { ...env(), TMUX: "" } }),
  );
  try {
    for (const key of ["M-q", "C-q", "M-q", "C-q"]) {
      open("lead", "one");
      await ready("lead", "one");
      press(key, "one");
      await until(() => seen("one").includes(leaving), `${key} to leave`, "one");
      expect(seen("one")).not.toContain("server exited unexpectedly");
      expect(screenSessions()).toHaveLength(1);
      expect(seen("two")).toContain("I am lead");
      tmux(terminal, "kill-session", "-t", "=one");
      rmSync(join(home, "left-one"));
    }
  } finally {
    for (const one of busy) one.kill();
    await Promise.all(busy.map((one) => one.exited));
  }
}, 60_000);

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
  startSession(agents, "lead", { folder: home, command: [script], env: { PATH: pathNow }, labels });
}

test("Shift+Enter reaches the agent as a key of its own, through both tmux servers", async () => {
  given.extendedKeys = true;
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
    given.extendedKeys = extended;
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
    expect(selected()).toMatch(/^▸ ○ lead\b/);
    expect(seen()).toContain("I am lead");
  });

test("with a terminal that sends extended keys, the screen's own keys still work", async () => {
  given.extendedKeys = true;
  open("lead");
  await ready("lead");
  await toSecondThread();
  expect(selected()).toContain("app-7");
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

const history = 'for n in $(seq 1 200); do echo "line $n"; done';

// Claude Code's full-screen drawing: the alternate screen, with its own scrolling, and what
// it is sent logged byte by byte.
const fullScreen = (name: string, mouse: string) => `printf '\\033[?1049h${mouse}'
stty raw -echo
echo "I am ${name}"
exec cat > ${name}.bytes`;

test("the wheel scrolls back through the agent's output, and typing returns you to it", async () => {
  agent("output", history);
  sql(threadSql({ task: "20", folder: "output" }));
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
  open("output");
  await ready("output");
  wheel(64);
  await until(() => !seen().includes("I am output"), "the scrollback");
  press("M-Down");
  await until(() => selected().includes("app-12"), "the next row");
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
// had started. A moment can be too short on a busy machine, so a drag that `copies` also waits
// for copy mode before it lets go. An agent that asked for the mouse gets the drag instead.
async function drag(
  from: [number, number],
  through: [number, number][],
  copies = true,
): Promise<void> {
  const last = through.at(-1) ?? from;
  const moves = through.map((place) => `32;${place.join(";")}M`);
  for (const step of [`0;${from.join(";")}M`, ...moves]) {
    type(`\x1b[<${step}`);
    await Bun.sleep(100);
  }
  if (copies) await until(() => scrolledBack().includes("1"), "copy mode");
  type(`\x1b[<0;${last.join(";")}m`);
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
  sql(threadSql({ task: "20", folder: "words" }));
  open("words");
  await ready("words");
  tmux(terminal, "set", "-s", "set-clipboard", "on");
}

test("a drag over the agent copies just its text to your terminal's clipboard", async () => {
  await copying();
  const [column, row] = placeOf("first", "first word here");
  // tmux selects up to the cell before the one the button is let go on.
  await drag([column, row], [[column + 10, row]]);
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
  await drag(
    [column, row],
    [
      [column - 3, row],
      [10, row],
    ],
  );
  await until(() => clipboard() !== "", "the copy");
  expect(clipboard()).toBe("first ");
  type("after\r");
  await until(() => read("words.typed") === "after\n", "the typing");
});

test("a drag let go over the footer copies the agent's text to the end of its last row", async () => {
  await copying();
  const [column, row] = placeOf("line", "second line");
  await drag(
    [column, row],
    [
      [column + 2, row + 1],
      [60, 30],
    ],
  );
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
  await drag([column, row], [[column + 8, row]]);
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
  await drag([agentColumn, 5], [[agentColumn + 4, 5]], false);
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

test("two terminals each get their own session, and leaving one leaves the other", async () => {
  open("lead", "one");
  await ready("lead", "one");
  open("lead", "two");
  await ready("lead", "two");
  expect(screenSessions()).toHaveLength(2);
  press("M-Down", "two");
  await until(() => selected("two").includes("app-12"), "the second to switch", "two");
  expect(onLead("one")).toBe(true);
  press("C-q", "one");
  await until(() => screenSessions().length === 1, "the first to end");
  press("M-Down", "two");
  await until(() => selected("two").includes("app-7"), "the second to go on working", "two");
});

test("a terminal that just goes leaves no session behind, and no sidebar running", async () => {
  open("lead", "one");
  await ready("lead", "one");
  open("lead", "two");
  await ready("lead", "two");
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

test("when the builder you attached to ends, the right side goes back to its details", async () => {
  open("lead");
  await ready("lead");
  await toSecondThread();
  tmux(agents, "kill-session", "-t", "=app-7");
  await until(onDetails, "app-7's details");
  expect(selected()).toContain("app-7");
});

test("a task that ends while you are on it stays yours, under Done, which opens", async () => {
  open("lead");
  await ready("lead");
  await toSecondThread();
  sql("UPDATE threads SET status = 'done' WHERE task = 7");
  await until(() => seen().includes("6 Done      2"), "app-7 to end");
  await until(() => selected().includes("app-7"), "the sidebar to stay on app-7");
  expect(seen()).toContain("○ app-12");
});

test("Enter on a task whose builder isn't running says so on the right, until the next key", async () => {
  sql("UPDATE threads SET status = 'failed' WHERE task = 12");
  tmux(agents, "kill-session", "-t", "=app-12");
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(() => selected().includes("app-12"), "app-12's row");
  await until(() => right().includes("Builder not running"), "app-12's details");
  press("Enter");
  const why = "app-12's builder isn't running: sc start app-12";
  await until(() => right().includes(why), "the right side to say why");
  expect(tmux(agents, "list-clients").out).toBe("");
  type("q");
  await until(() => right().includes("Builder not running"), "app-12's details again");
  expect(right()).not.toContain(why);
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

// The title your terminal shows in its window and tab.
const title = (window = "one") =>
  tmux(terminal, "display-message", "-p", "-t", `=${window}:`, "#{pane_title}").out.trim();

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
  await toFirstThread();
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
  await toFirstThread();
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
