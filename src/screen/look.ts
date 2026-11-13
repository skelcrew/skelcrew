// The look: what the sidebar, the strip and a page share to draw text, which is the colours, the
// padding, and making text from outside safe and fit to show.

// The colours of marks and words. 256-colour numbers, as they reach your terminal through both
// tmux servers and sprite, and mean the same whatever your theme. A theme's own green can be olive,
// close to the yellow of needs you. They are the same on the row you are looking at, so a mark
// never changes colour as you move onto it.
export const [green, yellow, red] = ["38;5;120", "38;5;221", "38;5;210"];
// Dim text is the theme's own grey, so it stays quiet whatever the theme.
export const grey = "90";
// Returns text in a colour or style. It ends just that style, not all of them, so a grey
// background behind the text goes on after it.
export const paint = (code: string, text: string) => `\x1b[${code}m${text}\x1b[22;39m`;
// The row you are looking at has a grey background, which is also what parts it from the rows
// around it. Dim text is a fixed light grey there, as a theme's own grey can vanish on it, and
// the title is white, as a theme's default text can be dark.
export const shade = "48;5;238";
export const white = "1;38;5;231";
export const greyOnShade = "38;5;250";
// The line at the sidebar's edge, a shade quieter than dim text, as it only parts two things.
export const edge = "38;5;237";
// The padding on each side, in columns, which also starts every heading and mark.
export const pad = "  ";

// Returns text from outside, such as an issue's title, safe to show: its control codes would
// otherwise reach your terminal, or break the line.
export const removeControlCodes = (text: string) => text.replace(/\p{Cc}/gu, " ");

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

// Returns a line with spaces added out to a width.
export const filled = (line: string, width: number) =>
  `${line}${" ".repeat(Math.max(width - Bun.stringWidth(line), 0))}`;

// Returns text in a colour. Dim text on the row you are looking at takes the light grey that
// shows on its background. Other colours stay as they are, so a mark looks the same whether or
// not you are on its row.
export const tinted = (here: boolean, code: string, text: string) =>
  paint(here && code === grey ? greyOnShade : code, text);

// Returns a line with the grey behind it, out to the end of the row.
export const shaded = (line: string, width: number) =>
  `\x1b[${shade}m${filled(line, width)}\x1b[49m`;
