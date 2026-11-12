// A page's description drawn from its markdown, as the tracker stores it: headings, bold, code,
// lists and links, wrapped to the page's width. Anything else stays the plain text it was
// written as.
import { clean } from "./look.ts";

// Return text bold, as inline code is coloured, or dim as a code block is. Each style is ended
// on its own, not with a reset, as wrapping carries a style over to the next line only when it
// knows where that style ends. Code is cyan, one of your terminal's own colours, which its theme
// keeps quiet. A 256-colour code would look the same everywhere, but wrapping doesn't carry it
// over, so code wrapped onto a second line would lose it.
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const code = (text: string) => `\x1b[36m${text}\x1b[39m`;
const dim = (text: string) => `\x1b[90m${text}\x1b[39m`;

// Bold, code and links within a line, whichever comes first. Code is matched in the same pass,
// so marks inside it stay as they are. A link takes only a web address with no space, as its
// address goes into the terminal link as it is.
const inline = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

// Returns a line's bold, code and links drawn for your terminal.
const drawInline = (line: string) =>
  line.replace(inline, (whole, inCode?: string, strong?: string, text?: string, url?: string) => {
    if (inCode !== undefined) return code(inCode);
    if (strong !== undefined) return bold(strong);
    if (text !== undefined && url !== undefined) return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
    return whole;
  });

// Returns text wrapped at word boundaries to fit a width, with `lead` before its first line and
// as many spaces before the others. So a list item's wrapped lines start under its text, not
// under its bullet, and an indented line stays indented. Words too long for a line are broken,
// so a line never wraps by itself in the pane. A lead wider than half the width loses columns
// from its start, so a deep indent in a narrow pane still leaves room for the text: the page cuts
// lines at the pane's edge, and text pushed past it would vanish.
function wrap(text: string, given: string, width: number): string[] {
  const most = Math.floor(width / 2);
  const lead = Bun.stringWidth(given) <= most ? given : most > 0 ? given.slice(-most) : "";
  const hang = " ".repeat(Bun.stringWidth(lead));
  const room = Math.max(width - hang.length, 1);
  return Bun.wrapAnsi(text, room, { hard: true })
    .split("\n")
    .map((line, i) => `${i === 0 ? lead : hang}${line}`);
}

// Returns markdown as lines for your terminal, wrapped to a width: headings bold without their
// marks and with a blank line before them, **bold**, inline code in its colour, a code block
// dim with its fences gone, a list item with a bullet, and a link as a terminal link that shows
// only its text. Headings, list items and plain lines all get their bold, code and links drawn,
// and only a code block shows its text as written. Control codes are removed from each line
// first, so text from outside can't reach your terminal as one, nor pass for Skelcrew's own styles.
export function drawMarkdown(markdown: string, width: number): string[] {
  // The fence that opened the code block we are in, or empty outside one. Only a fence of the
  // same character, at least as long and with nothing after it, closes it, so a block can show
  // shorter fences, or the other kind, as code. A block that never closes runs to the end.
  let open = "";
  const lines: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    // Cleans the line, then reads whether it is a fence: its marks, and what follows them. The
    // indent is kept apart, so every line it wraps to starts with it too.
    const line = clean(raw);
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/)?.slice(1) ?? [];
    const [marks = "", after = ""] = fence;
    const [, indent = "", text = ""] = line.match(/^(\s*)(.*)$/) ?? [];
    // A fence opens a code block or closes it, and shows as nothing either way. Inside a
    // block, a line shows dim and as written, with no marks drawn.
    if (!open && marks) {
      open = marks;
      continue;
    }
    if (open && marks.startsWith(open) && !after.trim()) {
      open = "";
      continue;
    }
    if (open) {
      lines.push(...wrap(text ? dim(text) : "", indent, width));
      continue;
    }
    // A heading has a blank line before it, so it starts a part of its own, unless it is the
    // first line or one is there already. Bold inside it ends with its own end of bold, so the
    // heading's bold starts again.
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
      const drawn = drawInline(heading[1] ?? "").replaceAll("\x1b[22m", "\x1b[22m\x1b[1m");
      lines.push(...wrap(bold(drawn), "", width));
      continue;
    }
    // A list item keeps its indent, with a bullet for its mark, and a numbered one its number.
    // Any other line is plain text.
    const bullet = text.match(/^[-*+]\s+(.*)$/);
    const numbered = text.match(/^(\d+[.)])\s+(.*)$/);
    if (bullet) lines.push(...wrap(drawInline(bullet[1] ?? ""), `${indent}• `, width));
    else if (numbered)
      lines.push(...wrap(drawInline(numbered[2] ?? ""), `${indent}${numbered[1]} `, width));
    else lines.push(...wrap(drawInline(text), indent, width));
  }
  return lines;
}
