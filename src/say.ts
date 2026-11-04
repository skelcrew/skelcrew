// How skel speaks in a terminal it shares with gh, claude, codex and sprite, so you can
// tell its lines from theirs.

// Returns a line that says skel is speaking, bold when the terminal can show it. Without a
// mark, skel's lines read as part of what the tool before them printed.
export function skelLine(text: string): string {
  const line = `skel · ${text}`;
  const bold = process.stdout.isTTY && process.env.TERM !== "dumb";
  return bold ? `\x1b[1m${line}\x1b[22m` : line;
}
