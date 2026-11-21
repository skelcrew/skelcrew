// The arrow-key picker the first run asks its questions with, such as which coding agent agents
// run on: ↑ and ↓ move between the choices, and Enter takes the one marked.
import { readSync, writeSync } from "node:fs";
import { colorful } from "../format.ts";

// One choice: its name, and a dim word beside it, such as installed.
export type Choice = { label: string; hint?: string };

// What a key does in the picker. Only the keys it knows count, so a stray key moves nothing.
type Key = "up" | "down" | "enter" | "stop" | "end" | null;

// Reads one key from your input, a byte at a time, so a question after the picker still finds
// its own line. An arrow is three bytes, escape [ A, and j and k move too, as in less. Returns
// "end" when the input ends, such as after Ctrl-D, or a read fails.
function readKey(): Key {
  const byte = Buffer.alloc(1);
  const next = () => {
    try {
      return readSync(0, byte) === 0 ? null : byte.toString();
    } catch {
      return null;
    }
  };
  const first = next();
  if (first === null || first === "\x04") return "end";
  if (first === "\x03") return "stop";
  if (first === "\r" || first === "\n") return "enter";
  if (first === "k") return "up";
  if (first === "j") return "down";
  if (first !== "\x1b") return null;
  // An arrow key, as the terminal sends it in raw mode, and as SS3 in some terminals' keypad mode.
  const second = next();
  if (second !== "[" && second !== "O") return null;
  const third = next();
  if (third === "A") return "up";
  if (third === "B") return "down";
  return null;
}

// Runs stty on your terminal, to put it in raw mode and back.
const stty = (args: string[]) =>
  Bun.spawnSync(["stty", ...args], { stdin: "inherit", stdout: "pipe", stderr: "inherit" })
    .stdout.toString()
    .trim();

// Asks the question and returns the index of the choice taken, or null when the input ends
// before one is. The first choice is marked to start, so Enter takes it. At a terminal, each key
// is read as you press it and the list is drawn again with the mark moved. Without one, such as in
// a script, the same keys are read from the input, and the list is shown once. Ctrl-C stops
// Skelcrew, with your terminal as it was.
export function pick(question: string, choices: Choice[]): number | null {
  const tty = Boolean(process.stdin.isTTY);
  const color = colorful();
  const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  // Each choice's hint lines up in one column, two spaces past the longest name.
  const width = Math.max(...choices.map((choice) => choice.label.length)) + 2;
  const row = (choice: Choice, marked: boolean) => {
    const hint = choice.hint ? paint("2", choice.hint) : "";
    const label = choice.hint ? choice.label.padEnd(width) : choice.label;
    return marked ? `${paint("1", `› ${label}`)}${hint}` : `  ${label}${hint}`;
  };
  const rows = (at: number) => choices.map((choice, index) => row(choice, index === at));
  const help = paint("2", "↑/↓ to move · Enter to choose");
  writeSync(1, `${question}\n${rows(0).join("\n")}\n${help}\n`);
  let at = 0;
  // Raw mode hands each key over as it is pressed, with no echo, and the cursor hides while the
  // list is drawn again.
  const saved = tty ? stty(["-g"]) : "";
  if (tty) {
    stty(["raw", "-echo"]);
    writeSync(1, "\x1b[?25l");
  }
  let key: Key = null;
  try {
    while (true) {
      key = readKey();
      if (key === "enter" || key === "stop" || key === "end") break;
      if (key === "up") at = (at + choices.length - 1) % choices.length;
      if (key === "down") at = (at + 1) % choices.length;
      // Up past the list and its help line, then each row again over the old one, and back down
      // under the help line. Raw mode turns off what makes a new line start at the left, so each
      // row starts there itself.
      if (tty && key !== null) {
        const drawn = rows(at).map((line) => `\r\x1b[K${line}\r\n`);
        writeSync(1, `\x1b[${choices.length + 1}A${drawn.join("")}\x1b[1B`);
      }
    }
  } finally {
    if (tty) {
      stty([saved]);
      writeSync(1, "\x1b[?25h");
    }
  }
  // 130 is what a shell reports for a program Ctrl-C stopped.
  if (key === "stop") process.exit(130);
  return key === "enter" ? at : null;
}
