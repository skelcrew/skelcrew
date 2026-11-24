// The questions sc init asks: the arrow-key picker, such as for which coding agent agents run
// on, where ↑ and ↓ move between the choices and Enter takes the one marked, and a line typed.
// Esc or Ctrl-C at either stops Skelcrew.
import { readSync, writeSync } from "node:fs";
import { colorful } from "../format.ts";

// One choice: its name, and a dim word beside it, such as installed.
export type Choice = { label: string; hint?: string };

// What a key does in the picker. Only the keys it knows count, so a stray key moves nothing.
// Esc and Ctrl-C both stop.
type Key = "up" | "down" | "enter" | "stop" | "end" | null;

// Reads one byte of your input, or null when the input ends, a read fails, or, at a terminal set
// to time reads out, nothing comes in time. Bytes come as latin1, so each is one character.
function readByte(): string | null {
  const byte = Buffer.alloc(1);
  try {
    return readSync(0, byte) === 0 ? null : byte.toString("latin1");
  } catch {
    return null;
  }
}

// Reads what follows an escape byte. A key such as an arrow sends escape [ A, or escape O A in
// some terminals' keypad mode, at once. Nothing after it within a tenth of a second is Esc on its
// own. Only that wait is timed, so the rest of an arrow split over a slow connection still counts.
function afterEscape(tty: boolean): "up" | "down" | "stop" | null {
  if (tty) stty(["min", "0", "time", "1"]);
  const second = readByte();
  if (tty) stty(["min", "1", "time", "0"]);
  if (second === null) return "stop";
  if (second !== "[" && second !== "O") return null;
  while (true) {
    const next = readByte();
    if (next === null) return null;
    if (next === "A") return "up";
    if (next === "B") return "down";
    if (second === "O" || /[@-~]/.test(next)) return null;
  }
}

// Reads one key from your input, a byte at a time, so a question after the picker still finds
// its own line. j and k move too, as in less. Returns "end" when the input ends, such as after
// Ctrl-D, or a read fails.
function readKey(tty: boolean): Key {
  const first = readByte();
  if (first === null || first === "\x04") return "end";
  if (first === "\x03") return "stop";
  if (first === "\r" || first === "\n") return "enter";
  if (first === "k") return "up";
  if (first === "j") return "down";
  if (first === "\x1b") return afterEscape(tty);
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
// a script, the same keys are read from the input, and the list is shown once. Esc or Ctrl-C
// stops Skelcrew, with your terminal as it was.
export function pick(question: string, choices: Choice[]): number | null {
  const tty = Boolean(process.stdin.isTTY);
  const color = colorful();
  const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const width = Math.max(...choices.map((choice) => choice.label.length)) + 2;
  const row = (choice: Choice, marked: boolean) => {
    const hint = choice.hint ? paint("2", choice.hint) : "";
    const label = choice.hint ? choice.label.padEnd(width) : choice.label;
    return marked ? `${paint("1", `› ${label}`)}${hint}` : `  ${label}${hint}`;
  };
  const rows = (at: number) => choices.map((choice, index) => row(choice, index === at));
  const help = paint("2", "↑/↓ to move · Enter to choose · Esc to cancel");
  writeSync(1, `${question}\n${rows(0).join("\n")}\n${help}\n`);
  let at = 0;
  const saved = tty ? stty(["-g"]) : "";
  if (tty) {
    stty(["raw", "-echo"]);
    writeSync(1, "\x1b[?25l");
  }
  let key: Key = null;
  try {
    while (true) {
      key = readKey(tty);
      if (key === "enter" || key === "stop" || key === "end") break;
      if (key === "up") at = (at + choices.length - 1) % choices.length;
      if (key === "down") at = (at + 1) % choices.length;
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
  if (key === "stop") process.exit(130);
  return key === "enter" ? at : null;
}

// Asks for a line and returns it trimmed, or null when the input ends before anything is typed.
// At a terminal, each key is read as you press it, so Esc or Ctrl-C stops Skelcrew at once, with
// your terminal as it was. Backspace takes back the last character.
export function askLine(question: string): string | null {
  writeSync(1, question);
  const tty = Boolean(process.stdin.isTTY);
  const saved = tty ? stty(["-g"]) : "";
  if (tty) stty(["raw", "-echo"]);
  let line = "";
  let key: "enter" | "end" | "stop";
  try {
    while (true) {
      const byte = readByte();
      if (byte === null || byte === "\x04") {
        key = "end";
        break;
      }
      if (byte === "\r" || byte === "\n") {
        key = "enter";
        break;
      }
      if (byte === "\x03" || (byte === "\x1b" && afterEscape(tty) === "stop")) {
        key = "stop";
        break;
      }
      if (byte === "\x7f" || byte === "\b") {
        const kept = line.replace(/[^\x80-\xbf]?[\x80-\xbf]*$/, "");
        if (tty && kept !== line) writeSync(1, "\b \b");
        line = kept;
      } else if (byte >= " ") {
        line += byte;
        if (tty) writeSync(1, Buffer.from(byte, "latin1"));
      }
    }
  } finally {
    if (tty) {
      stty([saved]);
      writeSync(1, "\n");
    }
  }
  if (key === "stop") process.exit(130);
  const typed = Buffer.from(line, "latin1").toString("utf8").trim();
  return key === "end" && line === "" ? null : typed;
}
