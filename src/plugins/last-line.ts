// What an agent printed last, for the reason a task is blocked when its
// agent stops. Every session runner reports it the same way.

// The last line with text on it, without the codes a terminal uses for
// colour, cursor moves, window titles, keyboard modes and the like. The
// patterns follow how ECMA-48 builds every such code, so a code Skelcrew
// hasn't seen yet is removed whole, not left behind as stray letters. For
// example, Claude Code's "ESC [ > 0 q" once left ">0q" in a block reason.
export function lastLine(output: string): string {
  const plain = output
    // A title or other text the terminal keeps: ESC ] or ESC P, _, ^ or X,
    // up to BEL or ESC \.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal codes start with ESC.
    .replace(/\u001b[\]PX^_][^\u0007\u001b]*(\u0007|\u001b\\)/g, "")
    // ESC [, then any of 0-9 : ; < = > ?, then any of space to /, then
    // one of @ to ~. Colours, cursor moves and keyboard modes.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal codes start with ESC.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // ESC, then any of space to /, then one of 0 to ~. Such as ESC ( B,
    // which picks a character set, and ESC 7, which saves the cursor.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal codes start with ESC.
    .replace(/\u001b[ -/]*[0-~]/g, "")
    // Control characters left over, such as a bell. Tabs and line ends stay.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lines = plain.split(/\r?\n|\r/).map((line) => line.trim());
  return lines.filter((line) => line !== "").at(-1) ?? "";
}
