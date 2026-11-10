// How Skelcrew speaks: its lines in a terminal it shares with gh, claude, codex and sprite, so
// you can tell them from theirs, and the words of what went wrong.

// Returns a line that says Skelcrew is speaking, bold when the terminal can show it. Without a
// mark, Skelcrew's lines read as part of what the tool before them printed.
export function skelLine(text: string): string {
  const line = `Skelcrew · ${text}`;
  // In a pipe or a dumb terminal the codes for bold would show as noise.
  const bold = process.stdout.isTTY && process.env.TERM !== "dumb";
  return bold ? `\x1b[1m${line}\x1b[22m` : line;
}

// Returns the text of anything thrown, for what Skelcrew prints, logs or replies. Anything can
// be thrown, so it may not be an Error.
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Returns the title of your terminal's window while Skelcrew runs in it, naming the server or
// Sprite you reached with --remote, if any.
export const windowTitle = (where?: string) => (where ? `Skelcrew · ${where}` : "Skelcrew");
