// A page's description, drawn from its markdown: what each kind of markdown becomes on your
// terminal, and that text from outside still can't reach it as control codes.
import { expect, test } from "bun:test";
import { drawMarkdown } from "../src/screen/markdown.ts";

const esc = "\x1b";
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const dim = (text: string) => `\x1b[90m${text}\x1b[39m`;
const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

const cases: [string, string, string[]][] = [
  ["plain text stays as it is", "Sign-in landed on a 404.", ["Sign-in landed on a 404."]],
  ["a heading is bold, without its marks", "## Steps to reproduce", [bold("Steps to reproduce")]],
  ["every heading level", "# One\n###### Six", [bold("One"), bold("Six")]],
  ["bold text", "It **must** stay small.", [`It ${bold("must")} stay small.`]],
  ["inline code is dim", "Run `bun test` first.", [`Run ${dim("bun test")} first.`]],
  ["bold marks inside code stay code", "`a **b** c`", [dim("a **b** c")]],
  [
    "a code block is dim, and its fences go",
    "Before:\n```ts\nconst a = **1**;\n\n```\nAfter.",
    ["Before:", dim("const a = **1**;"), "", "After."],
  ],
  ["a code block with no end runs to the end", "```\nx", [dim("x")]],
  [
    "a longer fence holds shorter ones as code",
    "````md\n```\n**x**\n```\n````\nafter **y**",
    [dim("```"), dim("**x**"), dim("```"), `after ${bold("y")}`],
  ],
  [
    "a fence closes only with its own character",
    "~~~\n```\n# not a heading\n~~~\n# Heading",
    [dim("```"), dim("# not a heading"), bold("Heading")],
  ],
  [
    "a fence that never closes keeps the rest as code",
    "Before\n```\n- not a list\n**not bold**",
    ["Before", dim("- not a list"), dim("**not bold**")],
  ],
  ["a list item gets a bullet", "- one\n* two\n+ three", ["• one", "• two", "• three"]],
  ["a nested list item keeps its indent", "- one\n  - inner", ["• one", "  • inner"]],
  ["a list item's text is drawn too", "- **Done**", [`• ${bold("Done")}`]],
  [
    "a link is a terminal link with only its text shown",
    "See [the docs](https://example.com/docs).",
    [`See ${link("https://example.com/docs", "the docs")}.`],
  ],
  [
    "a link that isn't a web address stays as it was written",
    "[x](javascript:alert)",
    ["[x](javascript:alert)"],
  ],
  ["a numbered list stays plain", "1. first", ["1. first"]],
  ["a quote stays plain", "> said", ["> said"]],
  ["a lone star stays", "2 * 3", ["2 * 3"]],
  ["Windows line ends are lines too", "a\r\nb", ["a", "b"]],
];

for (const [what, markdown, lines] of cases)
  test(what, () => {
    expect(drawMarkdown(markdown)).toEqual(lines);
  });

test("control codes from outside are removed before any markdown is drawn", () => {
  const evil = "**\x1b]0;owned\x07** `\x1b[2J` [a](https://x.y/\x1b]8;;evil)";
  const drawn = drawMarkdown(`${evil}\n\x9b31m`).join("\n");
  const ours = drawn
    .replaceAll(new RegExp(`${esc}\\[(1|22|90|39)m`, "g"), "")
    .replaceAll(new RegExp(`${esc}\\]8;;[^${esc}]*${esc}\\\\`, "g"), "");
  expect(ours.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
});
