// The look: what the list, the screen's sidebar and its footer share to draw text, which is the
// colours, the padding, and making text from outside safe and fit to show.
import type { Colour } from "../flow/marks.ts";

// The colours of marks and words, and of the stages at work. 256-colour numbers, as they reach
// your terminal through both tmux servers and ssh, and mean the same whatever your theme. A
// theme's own green can be olive, close to the yellow of needs you. Each is a mid tone with about
// 3:1 contrast on a white theme, a dark one and the grey of the row you are looking at, and each
// has a hue of its own. They are the same on the row you are looking at, so a mark never changes
// colour as you move onto it.
export const [green, yellow, red] = ["38;5;34", "38;5;136", "38;5;203"];
export const [blue, purple, amber] = ["38;5;69", "38;5;171", "38;5;202"];
// Bright text, for the mark of a builder at work. It is the theme's own text in bold, not a fixed
// white, so it reads on a light theme too. On the row you are looking at it is white, as there
// the theme's own text can be dark on the grey.
export const bright = "1";
// Dim text is the theme's own grey, so it stays quiet whatever the theme.
export const grey = "90";
// The colour each kind of mark is drawn in.
export const markColours: Record<Colour, string> = { green, yellow, red, bright, dim: grey };
// A light grey, for text that matters more than dim text but less than a title. It is a fixed
// one, as a theme has no grey between its dim one and its text.
export const lightGrey = "38;5;250";
// Returns text in a colour or style. It ends just that style, not all of them, so a grey
// background behind the text goes on after it.
export const paint = (code: string, text: string) => `\x1b[${code}m${text}\x1b[22;39m`;
// The row you are looking at has a grey background, which is also what parts it from the rows
// around it. Dim text is a fixed light grey there, as a theme's own grey can vanish on it, and
// the title is white, as a theme's default text can be dark.
export const shade = "48;5;238";
export const white = "1;38;5;231";
export const greyOnShade = "38;5;250";
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

// Returns text in a colour. On the row you are looking at, dim text takes the light grey that
// shows on its background, and bright text white. Other colours stay as they are, so a mark
// looks the same whether or not you are on its row.
export function tinted(here: boolean, code: string, text: string): string {
  if (here && code === grey) return paint(greyOnShade, text);
  return paint(here && code === bright ? white : code, text);
}

// Returns a line with the grey behind it, out to the end of the row.
export const shaded = (line: string, width: number) =>
  `\x1b[${shade}m${filled(line, width)}\x1b[49m`;
