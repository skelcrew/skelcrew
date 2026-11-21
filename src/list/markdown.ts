// A task's description, or a message of the lead's, drawn as markdown for the details pane:
// headings bold, lists and code blocks kept, inline code dim, and no raw # or ** left over.

// Codes that turn a style on and off again. Each turns off only its own, so inline code inside
// a bold heading leaves the heading bold.
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const italic = (text: string) => `\x1b[3m${text}\x1b[23m`;
const struck = (text: string) => `\x1b[9m${text}\x1b[29m`;
const dim = (text: string) => `\x1b[90m${text}\x1b[39m`;

// Returns a link as its text, then its address, dim, when the two differ, so the address can
// always be read. A link wraps like any other text: a terminal link around it couldn't be broken
// over lines, so a long one would run past the pane. Most terminals open an address shown whole.
function linked(url: string, text: string): string {
  const address = url.replace(/\p{Cc}/gu, " ");
  return Bun.stripANSI(text) === address ? text : `${text} ${dim(`(${address})`)}`;
}

// Returns a block's lines with `first` before its first line and `rest` before each line after
// it, as a list item's marker or a quote's bar. Blank lines stay blank, so a loose list doesn't
// leave stray spaces.
function prefixed(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, i) => (line === "" ? "" : `${i === 0 ? first : rest}${line}`))
    .join("\n");
}

// Returns markdown drawn as plain lines with styles, before wrapping. Each block ends in a blank
// line, which markdownLines collapses. Bun's parser calls these from the innermost element out,
// each with its children already drawn.
function drawn(text: string): string {
  return Bun.markdown.render(text, {
    // A paragraph is one line: its soft line breaks were only where the writer's editor wrapped.
    paragraph: (children) => `${children.replace(/\n/g, " ")}\n\n`,
    heading: (children) => `${bold(children)}\n\n`,
    // A code block's lines are kept as written, indented and dim, so they read apart from text.
    code: (children) =>
      `${children
        .trimEnd()
        .split("\n")
        .map((line) => `  ${dim(line)}`)
        .join("\n")}\n\n`,
    blockquote: (children) => `${prefixed(children.trim(), "│ ", "│ ")}\n\n`,
    hr: () => `${dim("───")}\n\n`,
    // An item's lines after its first start under its text, past its marker, so a list item
    // still reads as one. A nested list comes inside its item, so it gets indented with it.
    listItem: (children, meta) => {
      // A task list's item keeps its box, ticked or not, so done work reads apart from the rest.
      const box = meta.checked === undefined ? "" : meta.checked ? "[x] " : "[ ] ";
      const marker = `${meta.ordered ? `${(meta.start ?? 1) + meta.index}. ` : "- "}${box}`;
      const body = children.trim().replace(/\n{3,}/g, "\n\n");
      return `${prefixed(body, marker, " ".repeat(marker.length))}\n`;
    },
    // A nested list starts on a line of its own, under its item's text.
    list: (children, meta) => (meta.depth === 0 ? `${children}\n` : `\n${children}`),
    // A table keeps its rows, its cells two spaces apart and its header bold.
    table: (children) => `${children}\n`,
    tr: (children) => `${children.trimEnd()}\n`,
    th: (children) => `${bold(children)}  `,
    td: (children) => `${children}  `,
    strong: bold,
    emphasis: italic,
    strikethrough: struck,
    codespan: dim,
    link: (children, meta) => linked(meta.href, children),
    // An image can't show here, so it shows as its alt text and its address, to open it from.
    image: (children, meta) => linked(meta.src, children || "image"),
  });
}

// Returns markdown as lines `width` columns wide at most, wrapped at word breaks. Runs of blank
// lines become one. A long line of a list item or a quote wraps under its own text, past its
// indent, its marker and its bar, unless that would leave it less than half the width.
export function markdownLines(text: string, width: number): string[] {
  if (text.trim() === "" || width <= 0) return [];
  // Only blank lines are trimmed off the ends: a code block's first line keeps its indent.
  const lines = drawn(text)
    .replace(/^\n+/, "")
    .trimEnd()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, i, all) => line !== "" || all[i - 1] !== "");
  return lines.flatMap((line) => {
    if (line === "") return [""];
    // What the line starts with, uncoloured: quote bars, an indent, then a list marker and box.
    const found =
      /^(?:│ )*(?: *(?:[-*+]|\d+[.)]) +(?:\[[ x]\] )?| *)/.exec(Bun.stripANSI(line))?.[0] ?? "";
    const start = found.length * 2 <= width ? found : "";
    const hang = start.replace(/[^│]/g, " ");
    const pieces = Bun.wrapAnsi(Bun.sliceAnsi(line, start.length), width - start.length, {
      hard: true,
    }).split("\n");
    return pieces.map((piece, i) => `${i === 0 ? start : hang}${piece}`);
  });
}
