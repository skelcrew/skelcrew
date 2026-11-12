// A page's description, drawn from its markdown: what each kind of markdown becomes on your
// terminal, and that text from outside still can't reach it as control codes.
import { expect, test } from "bun:test";
import { drawMarkdown } from "../src/screen/markdown.ts";

const esc = "\x1b";
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const dim = (text: string) => `\x1b[90m${text}\x1b[39m`;
const code = (text: string) => `\x1b[36m${text}\x1b[39m`;
const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

const cases: [string, string, string[]][] = [
  ["plain text stays as it is", "Sign-in landed on a 404.", ["Sign-in landed on a 404."]],
  ["a heading is bold, without its marks", "## Steps to reproduce", [bold("Steps to reproduce")]],
  ["every heading level", "# One\n###### Six", [bold("One"), "", bold("Six")]],
  [
    "a heading's code has its colour and stays bold",
    "## Run `bun test`",
    [bold(`Run ${code("bun test")}`)],
  ],
  [
    "a heading's link is a terminal link",
    "# See [the docs](https://example.com/docs)",
    [bold(`See ${link("https://example.com/docs", "the docs")}`)],
  ],
  [
    "a heading stays bold after bold inside it",
    "## A **big** step",
    [bold(`A ${bold("big")}\x1b[1m step`)],
  ],
  ["bold text", "It **must** stay small.", [`It ${bold("must")} stay small.`]],
  [
    "inline code has a colour of its own",
    "Run `bun test` first.",
    [`Run ${code("bun test")} first.`],
  ],
  ["bold marks inside code stay code", "`a **b** c`", [code("a **b** c")]],
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
    [dim("```"), dim("# not a heading"), "", bold("Heading")],
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
  ["a numbered list keeps its numbers", "1. first\n10) tenth", ["1. first", "10) tenth"]],
  ["a blank line comes before a heading", "Intro\n## Steps", ["Intro", "", bold("Steps")]],
  ["a heading already after a blank line gets no second", "a\n\n# B", ["a", "", bold("B")]],
  ["a heading at the top has no blank line before it", "# A\n# B", [bold("A"), "", bold("B")]],
  ["a heading mark inside a code block is no heading", "```\nx\n# y\n```", [dim("x"), dim("# y")]],
  ["a quote stays plain", "> said", ["> said"]],
  ["a lone star stays", "2 * 3", ["2 * 3"]],
  ["Windows line ends are lines too", "a\r\nb", ["a", "b"]],
];

for (const [what, markdown, lines] of cases)
  test(what, () => {
    expect(drawMarkdown(markdown, 80)).toEqual(lines);
  });

test("control codes from outside are removed before any markdown is drawn", () => {
  const evil = "**\x1b]0;owned\x07** `\x1b[2J` [a](https://x.y/\x1b]8;;evil)";
  const drawn = drawMarkdown(`${evil}\n\x9b31m`, 80).join("\n");
  const ours = drawn
    .replaceAll(new RegExp(`${esc}\\[(1|22|36|90|39)m`, "g"), "")
    .replaceAll(new RegExp(`${esc}\\]8;;[^${esc}]*${esc}\\\\`, "g"), "");
  expect(ours.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
});

// Returns markdown drawn at a width, without its styles, as you read it.
const wrapped = (markdown: string, width: number) =>
  drawMarkdown(markdown, width).map((line) => Bun.stripANSI(line));

test("a long line wraps at word boundaries, within its width", () => {
  expect(wrapped("one two three four five six", 13)).toEqual(["one two three", "four five six"]);
});

test("a bullet's wrapped lines start under its text, not under the bullet", () => {
  expect(wrapped("- one two three four five", 12)).toEqual(["• one two", "  three four", "  five"]);
});

test("a nested bullet's wrapped lines start under its own text", () => {
  expect(wrapped("  - one two three four", 12)).toEqual(["  • one two", "    three", "    four"]);
});

test("a numbered item's wrapped lines start under its text, past the number", () => {
  expect(wrapped("10. one two three four", 12)).toEqual(["10. one two", "    three", "    four"]);
});

test("an indented line keeps its indent on every line it wraps to", () => {
  expect(wrapped("```\n    call(one, two)\n```", 13)).toEqual(["    call(one,", "    two)"]);
});

test("code keeps its colour on each line it wraps to", () => {
  const lines = drawMarkdown("see `one two three` here", 10);
  expect(lines).toEqual([`see ${code("one")}`, code("two three"), "here"]);
});

test("no line is wider than its width, long words and wide letters too", () => {
  const markdown = `- ${"word ".repeat(30)}\n${"x".repeat(50)}\n${"日本語 ".repeat(20)}`;
  for (const line of drawMarkdown(markdown, 17))
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(17);
});
