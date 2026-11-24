// How a terminal sends keys: what it sent, split into keys, and Ctrl-D in each of its forms.
const esc = "\x1b";

// Splits what the terminal sent into keys. Every escape sequence is one key, read or not. That
// covers keys such as Right, Home, F5 or Alt-x, and the answers a terminal sends to tmux's
// questions. In order: a terminal's string ended by ST or BEL, a CSI sequence, an SS3 one, Alt
// with a key, then any single character, a lone Esc included.
export const keyPattern = new RegExp(
  [
    `${esc}[P\\]X^_][\\s\\S]*?(?:${esc}\\\\|\\x07)`,
    `${esc}\\[[0-?]*[ -/]*[@-~]`,
    `${esc}O[\\s\\S]`,
    `${esc}[^${esc}]`,
    "[\\s\\S]",
  ].join("|"),
  "g",
);

// The start of an escape sequence at the end of a read, whose end may come in the next one: an
// Esc, a CSI or SS3 sequence short of its last character, or a terminal's string short of its ST
// or BEL.
export const endOfSequence = new RegExp(
  `${esc}(?:\\[[0-?]*[ -/]*|O|[P\\]X^_](?:[^${esc}\\x07]|${esc}(?!\\\\))*)?$`,
);

// Ctrl-D as one byte, as kitty's CSI-u, with a press or repeat event, or as xterm's extended key.
const ctrlD = new RegExp(`^(?:\\x04|${esc}\\[100;5(?::[12])?u|${esc}\\[27;5;100~)$`);

// Reports whether a key is Ctrl-D, in any of its forms.
export const isCtrlD = (key: string) => ctrlD.test(key);
