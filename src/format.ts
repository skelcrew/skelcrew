// Small helpers that turn things into the text Skelcrew shows: errors, commands for you to run
// and the window title.

// Returns the text of anything thrown, for what Skelcrew prints, logs or replies. Anything can
// be thrown, so it may not be an Error.
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Returns the title of your terminal's window while Skelcrew runs in it, naming the server you
// reached with --remote, if any.
export const windowTitle = (where?: string) => (where ? `Skelcrew · ${where}` : "Skelcrew");

// Returns whether stdout is a terminal that shows color, honoring NO_COLOR.
export function colorful(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

// Returns commands for you to run, each on its own indented line, bold where the terminal shows
// it, with a blank line above and below each one. Set apart so, a command reads as something to
// copy and run, not as part of the sentence around it, and two never run together.
export function toRun(commands: string[]): string {
  const bold = (text: string) => (colorful() ? `\x1b[1m${text}\x1b[22m` : text);
  return ["", ...commands.map((command) => `  ${bold(command)}`), ""].join("\n\n").slice(1, -1);
}
