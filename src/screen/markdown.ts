// A page's description drawn from its markdown, as the tracker stores it: headings, bold, code,
// lists and links. Anything else stays the plain text it was written as.
import { clean } from "./look.ts";

// Each style is ended on its own, not with a reset, as the page's wrapping carries a style
// over to the next line only when it knows where that style ends.
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const dim = (text: string) => `\x1b[90m${text}\x1b[39m`;

// Bold, code and links within a line, whichever comes first. Code is matched in the same pass,
// so marks inside it stay as they are. A link takes only a web address with no space, as its
// address goes into the terminal link as it is.
const inline = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

// Returns a line's bold, code and links drawn for your terminal.
const drawInline = (line: string) =>
  line.replace(inline, (whole, code?: string, strong?: string, text?: string, url?: string) => {
    if (code !== undefined) return dim(code);
    if (strong !== undefined) return bold(strong);
    if (text !== undefined && url !== undefined) return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
    return whole;
  });

// Returns markdown as lines for your terminal: headings bold without their marks, **bold**,
// code dim, a code block's fences gone, a list item with a bullet, and a link as a terminal
// link that shows only its text. Control codes are removed from each line first, so text from
// outside can't reach your terminal as one, nor pass for skel's own styles.
export function drawMarkdown(markdown: string): string[] {
  // The fence that opened the code block we are in, or empty outside one. Only a fence of the
  // same character, at least as long and with nothing after it, closes it, so a block can show
  // shorter fences, or the other kind, as code. A block that never closes runs to the end.
  let open = "";
  return markdown.split(/\r?\n/).flatMap((raw) => {
    const line = clean(raw);
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/)?.slice(1) ?? [];
    const [marks = "", after = ""] = fence;
    if (!open && marks) {
      open = marks;
      return [];
    }
    if (open && marks.startsWith(open) && !after.trim()) {
      open = "";
      return [];
    }
    if (open) return [line ? dim(line) : ""];
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) return [bold(heading[1] ?? "")];
    const item = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (item) return [`${item[1] ?? ""}• ${drawInline(item[2] ?? "")}`];
    return [drawInline(line)];
  });
}
