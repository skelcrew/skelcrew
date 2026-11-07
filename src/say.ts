// How skel speaks: its lines in a terminal it shares with gh, claude, codex and sprite, so
// you can tell them from theirs, and the words of what went wrong.

// Returns a line that says skel is speaking, bold when the terminal can show it. Without a
// mark, skel's lines read as part of what the tool before them printed.
export function skelLine(text: string): string {
  const line = `skel · ${text}`;
  const bold = process.stdout.isTTY && process.env.TERM !== "dumb";
  return bold ? `\x1b[1m${line}\x1b[22m` : line;
}

// Returns the text of anything thrown, for what skel prints, logs or replies. Anything can
// be thrown, so it may not be an Error.
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Returns the title of your terminal's window while skel runs in it, naming the server or
// Sprite you reached with --remote, if any.
export const windowTitle = (where?: string) => (where ? `skel · ${where}` : "skel");

// Returns a rule across the terminal with a name in it, to mark where an outside tool takes
// over the terminal and where skel takes it back. 80 wide when the output isn't a terminal.
export function rule(name: string): string {
  const width = (process.stdout.isTTY && process.stdout.columns) || 80;
  const start = `──── ${name} `;
  return start + "─".repeat(Math.max(0, width - start.length));
}
