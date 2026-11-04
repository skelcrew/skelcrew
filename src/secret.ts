// Asks for a secret, such as the agents' Claude token, showing a star for each character
// typed or pasted, so you can see the paste arrived without the secret showing on screen.
import { readSync, writeSync } from "node:fs";

type Typed = { token: string; shown: string; end: "enter" | "stop" | null; pending: string };

// What a terminal sends for keys that aren't characters, such as an arrow key, and the marks
// it puts around a paste when bracketed paste is on. Left in, they would end up in the token.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these sequences start with escape.
const escapes = /\x1b(\[[0-?]*[ -/]*[@-~]|O.|[^[O\x00-\x1f])/g;
// The start of one cut off at the end of a read. Over ssh, a sequence can arrive in two
// reads, and its second half would otherwise read as typed characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these sequences start with escape.
const cutOff = /\x1b(\[[0-?]*[ -/]*|O)?$/;

// Returns the token after the keys read from the terminal, what to show for them, and
// whether Enter or Ctrl-C ended the question. Keys after either are dropped. An escape
// sequence cut off at the end comes back as pending, to put before the next read.
export function typeKeys(before: string, keys: string): Typed {
  let token = before;
  let shown = "";
  const pending = keys.match(cutOff)?.[0] ?? "";
  const whole = keys.slice(0, keys.length - pending.length);
  for (const key of whole.replace(escapes, "")) {
    if (key === "\r" || key === "\n") return { token, shown, end: "enter", pending: "" };
    if (key === "\x03") return { token, shown, end: "stop", pending: "" };
    if (key === "\x7f" || key === "\b") {
      if (token === "") continue;
      token = token.slice(0, -1);
      shown += "\b \b";
    } else if (key >= " ") {
      token += key;
      shown += "*";
    }
  }
  return { token, shown, end: null, pending };
}

// Runs stty on your terminal and returns what it printed.
const stty = (args: string[]) =>
  Bun.spawnSync(["stty", ...args], { stdin: "inherit", stdout: "pipe", stderr: "inherit" })
    .stdout.toString()
    .trim();

// Asks the question and returns the answer, or null at the end of the input. Piped input
// is read as a plain line, since nobody watches it. At a terminal, raw mode lets skel see
// each key, and turns off what Ctrl-C does, so skel stops itself on one. The terminal's
// settings come back even if reading fails.
export function promptSecret(question: string): string | null {
  if (!process.stdin.isTTY) return prompt(question);
  writeSync(1, `${question} `);
  const saved = stty(["-g"]);
  stty(["raw", "-echo"]);
  let typed: Typed = { token: "", shown: "", end: null, pending: "" };
  try {
    const buffer = Buffer.alloc(4096);
    while (typed.end === null) {
      const read = readSync(0, buffer);
      if (read === 0) return null;
      typed = typeKeys(typed.token, typed.pending + buffer.toString("utf8", 0, read));
      writeSync(1, typed.shown);
    }
  } finally {
    stty([saved]);
    writeSync(1, "\n");
  }
  if (typed.end === "stop") process.exit(130);
  return typed.token;
}
