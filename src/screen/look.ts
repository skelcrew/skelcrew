// The look: what the sidebar, the strip and a page share to draw text, which is the colours, the
// padding, and making text from outside safe and fit to show.

export const [green, yellow, red] = [32, 33, 31];
export const grey = 90;
// Returns text in a colour or style, ending just that, as a background behind it must go on.
export const paint = (code: number | string, text: string) => `\x1b[${code}m${text}\x1b[22;39m`;
// The row you are looking at has a grey background, which is also what parts it from the rows
// around it. 256-colour numbers, as they reach your terminal through both tmux servers and
// sprite, and mean the same whatever your theme. So do the colours on the grey: a theme's own
// red or grey can vanish there, and its default text can be dark.
export const shade = "48;5;238";
export const white = "1;38;5;231";
export const onShade: Record<number, string> = {
  [green]: "38;5;120",
  [yellow]: "38;5;221",
  [red]: "38;5;210",
  [grey]: "38;5;250",
};
// The line at the sidebar's edge, a shade quieter than dim text, as it only parts two things.
export const edge = "38;5;237";
// The padding on each side, in columns, which also starts every heading and mark. A terminal
// cell is about twice as tall as wide, so two columns look like the one blank row at the top.
export const pad = "  ";

// Returns text from outside, such as an issue's title, safe to show: its control codes would
// otherwise reach your terminal, or break the line.
export const clean = (text: string) => text.replace(/\p{Cc}/gu, " ");

// Returns text cut to fit a number of columns, with … where it was cut. Columns, not characters,
// as a Japanese title takes two for each.
export function fitted(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text;
  // Takes letters while they and the … still fit. With no room at all, not even the … shows.
  let cut = "";
  for (const letter of text) {
    if (Bun.stringWidth(`${cut}${letter}…`) > width) break;
    cut += letter;
  }
  return width > 0 ? `${cut}…` : "";
}
