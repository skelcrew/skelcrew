// The questions sc init asks at a real terminal: the keys the picker and a typed line take, and
// that Esc and Ctrl-C stop them with the terminal as it was.
import { expect, test } from "bun:test";
import { source } from "./harness.ts";

// Runs a question at a terminal of its own and presses each key once `shown` is on the screen,
// waiting the given milliseconds before each. The terminal's settings are printed before and
// after, so a test can see they came back.
async function atTerminal(ask: string, shown: string, keys: [number, string][]) {
  const script = `import { pick, askLine } from ${JSON.stringify(source("machine/pick.ts"))};
console.log("answer", JSON.stringify(${ask}));`;
  let screen = "";
  const run = Bun.spawn(
    ["/bin/sh", "-c", 'stty -g; "$0" -e "$1"; echo "code $?"; stty -g', process.execPath, script],
    {
      env: { PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
      terminal: {
        cols: 120,
        rows: 40,
        data(_terminal, data) {
          screen += Buffer.from(data).toString();
        },
      },
    },
  );
  try {
    for (let tries = 0; tries < 100 && !screen.includes(shown); tries++) await Bun.sleep(50);
    expect(screen).toContain(shown);
    for (const [wait, key] of keys) {
      await Bun.sleep(wait);
      run.terminal?.write(key);
    }
    await run.exited;
  } finally {
    run.kill();
    run.terminal?.close();
  }
  const lines = screen.split(/\r?\n/);
  const [before] = lines;
  const after = lines.filter((line) => line.trim() !== "").at(-1);
  return { screen, restored: before !== undefined && before.trim() === after?.trim() };
}

const choose = `pick("Choose the coding agent for the lead:", [{ label: "Claude Code" }, { label: "Codex" }, { label: "Pi" }])`;
const help = "↑/↓ to move · Enter to choose · Esc to cancel";

test("Esc in the picker stops it with 130, the terminal as it was and the cursor shown", async () => {
  const run = await atTerminal(choose, help, [[100, "\x1b"]]);
  expect(run.screen).toContain("code 130");
  expect(run.screen).not.toContain("answer");
  expect(run.screen).toContain("\x1b[?25h");
  expect(run.restored).toBe(true);
});

test("Ctrl-C in the picker stops it the same way", async () => {
  const run = await atTerminal(choose, help, [[100, "\x03"]]);
  expect(run.screen).toContain("code 130");
  expect(run.screen).not.toContain("answer");
  expect(run.screen).toContain("\x1b[?25h");
  expect(run.restored).toBe(true);
});

test("arrows move in the picker, as escape [ and escape O, also split over slow reads", async () => {
  const run = await atTerminal(choose, help, [
    [100, "\x1b[B"],
    [100, "\x1bOB"],
    [100, "\x1bOA"],
    [100, "\x1b"],
    [20, "["],
    [300, "B"],
    [100, "\r"],
  ]);
  expect(run.screen).toContain("answer 2\r\ncode 0");
  expect(run.restored).toBe(true);
});

test("Ctrl-C right after Esc, or inside an arrow, still stops the picker", async () => {
  for (const keys of [["\x1b\x03"], ["\x1b[", "\x03"]]) {
    const run = await atTerminal(
      choose,
      help,
      keys.map((key): [number, string] => [100, key]),
    );
    expect(run.screen).toContain("code 130");
    expect(run.restored).toBe(true);
  }
});

const commit = `askLine("Commit and push them to main? [Y/n] ")`;

test("a typed line takes what you type, with backspace and arrows ignored", async () => {
  const run = await atTerminal(commit, "[Y/n]", [
    [100, "x"],
    [50, "\x7f"],
    [50, "\x1b[A"],
    [50, "y\r"],
  ]);
  expect(run.screen).toContain('answer "y"');
  expect(run.screen).toContain("code 0");
  expect(run.restored).toBe(true);
});

test("Esc at a typed line stops it with 130 and the terminal as it was", async () => {
  const run = await atTerminal(commit, "[Y/n]", [
    [100, "y"],
    [50, "\x1b"],
  ]);
  expect(run.screen).toContain("code 130");
  expect(run.screen).not.toContain("answer");
  expect(run.restored).toBe(true);
});

test("Ctrl-C at a typed line stops it the same way", async () => {
  const run = await atTerminal(commit, "[Y/n]", [[100, "\x03"]]);
  expect(run.screen).toContain("code 130");
  expect(run.screen).not.toContain("answer");
  expect(run.restored).toBe(true);
});
