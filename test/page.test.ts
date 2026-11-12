// The page shown for an issue or PR: what it says of an item in Skelcrew's copy, as a tracker or
// forge sends it, and how it is drawn.
import { expect, test } from "bun:test";
import { Item } from "../src/flow/copy.ts";
import { type Page, pageOf } from "../src/flow/page.ts";
import { drawPage } from "../src/screen/page.ts";
import { prItem, taskItem } from "./harness.ts";

const esc = "\x1b";
const issueUrl = "https://github.com/simon/app/issues/31";

const issue = taskItem("31", "Add CSV export", {
  body: "Export threads.\n\nKeep it small.",
  labels: ["skelcrew", "good first issue"],
});

const check = (name: string, state: string) => ({ name, id: "1", state });
const review = (verdict: string, text: string, login = "codex-bot") => ({
  id: "1",
  verdict,
  text,
  author: { login, bot: false, you: false, push: null },
  lines: [],
});
const pull = (more: object = {}) =>
  prItem("34", "Fix the login redirect", {
    body: "Sign-in landed on a 404.",
    branch: "skelcrew/12",
    ...more,
  });

// Returns the page of an issue or PR, as its tracker or forge sends it and Skelcrew's copy keeps
// it.
const pageFor = (item: object): Page => pageOf(Item.parse(item));

test("an issue's page has its title, state, author, labels and description", () => {
  expect(pageFor(issue)).toEqual({
    title: "Add CSV export",
    facts: [
      ["State", "open"],
      ["Author", "simon"],
      ["Labels", "skelcrew, good first issue"],
    ],
    body: "Export threads.\n\nKeep it small.",
  });
});

test("an issue with no description, labels or author still has a page", () => {
  const bare = { ...issue, body: "", labels: [], author: null };
  expect(pageFor(bare)).toEqual({
    title: "Add CSV export",
    facts: [
      ["State", "open"],
      ["Author", "unknown"],
      ["Labels", "none"],
    ],
    body: "",
  });
});

test("a PR's page has its title, state, branch, checks, latest review and description", () => {
  const pr = pull({
    checks: [check("test", "passed")],
    reviews: [review("changes requested", "No."), review("approved", "Fine.", "ana")],
  });
  expect(pageFor(pr)).toEqual({
    title: "Fix the login redirect",
    facts: [
      ["State", "open"],
      ["Branch", "skelcrew/12 → main"],
      ["Checks", "passing"],
      ["Review", "approved · ana"],
    ],
    body: "Sign-in landed on a 404.",
  });
});

test("a PR with no checks or reviews says so", () => {
  const { facts } = pageFor(pull());
  expect(facts).toContainEqual(["Checks", "none"]);
  expect(facts).toContainEqual(["Review", "none"]);
});

test("checks read as the strip reads them, leaving out Skelcrew's own check", () => {
  const running = [check("test", "passed"), check("lint", "running")];
  const pr = pull({ checks: [...running, check("skelcrew/check", "failed")] });
  expect(pageFor(pr).facts).toContainEqual(["Checks", "running"]);
  const failing = pull({ checks: [check("test", "failed"), check("lint", "running")] });
  expect(pageFor(failing).facts).toContainEqual(["Checks", "failing"]);
});

test("a review Skelcrew posted says its verdict, as a forge may only have it as a comment", () => {
  const pr = pull({ reviews: [review("commented", "**Approved.**\n\nLooks right.")] });
  expect(pageFor(pr).facts).toContainEqual(["Review", "Approved. · codex-bot"]);
});

const page: Page = {
  title: "Add CSV export",
  facts: [
    ["State", "open"],
    ["Labels", "skelcrew"],
  ],
  body: "Export threads.\n\nKeep it small.",
};
const read = (lines: string[]) => lines.map((line) => Bun.stripANSI(line).trimEnd());

test("a page reads from the title down, two columns in, with the link among the facts", () => {
  expect(read(drawPage(page, issueUrl, 80, "click to open"))).toEqual([
    "",
    "  Add CSV export",
    "",
    "  State   open",
    "  Labels  skelcrew",
    `  GitHub  ${issueUrl}  click to open`,
    "",
    "  Export threads.",
    "",
    "  Keep it small.",
  ]);
});

test("the link to GitHub is a terminal link, with only its text inside, and the hint dim after it", () => {
  const line = drawPage(page, issueUrl, 80, "click to copy").find((text) =>
    text.includes("GitHub"),
  );
  expect(line).toContain(
    `\x1b]8;;${issueUrl}\x1b\\${issueUrl}\x1b]8;;\x1b\\  \x1b[90mclick to copy`,
  );
});

test("the hint gives way when the link wouldn't fit whole beside it", () => {
  const line = read(drawPage(page, issueUrl, 60, "click to open")).find((text) =>
    text.includes("GitHub"),
  );
  expect(line).toBe(`  GitHub  ${issueUrl}`);
});

test("a page with no description says so", () => {
  expect(read(drawPage({ ...page, body: "" }, issueUrl, 60, "click to open")).at(-1)).toBe(
    "  No description.",
  );
});

test("every line stops two columns before the edge, wide letters and long words too", () => {
  const long = {
    title: "日本語のタイトル ".repeat(10),
    facts: [["Labels", "a-rather-long-label ".repeat(8)] satisfies [string, string]],
    body: `${"word ".repeat(40)}\n${"x".repeat(120)}`,
  };
  for (const line of drawPage(long, issueUrl, 40, "click to open"))
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(38);
});

test("a fact too long for a line goes on under its value", () => {
  const facts: [string, string][] = [["Labels", "one two three four five six seven eight"]];
  const lines = read(drawPage({ ...page, facts }, issueUrl, 30, "click to open"));
  expect(lines[3]).toBe("  Labels  one two three four");
  expect(lines[4]).toBe("          five six seven");
});

test("control codes from GitHub never reach your terminal, on any line", () => {
  const evil = "\x1b]0;owned\x07\x1b[2J\x9b31mtext\rover\x1b]8;;http://evil\x1b\\";
  const shown = drawPage(
    { title: evil, facts: [["Author", evil]], body: `${evil}\nnext line` },
    issueUrl,
    200,
    "click to open",
  ).join("\n");
  const ours = shown
    .replaceAll(new RegExp(`${esc}\\[[\\d;]*m`, "g"), "")
    .replaceAll(`\x1b]8;;${issueUrl}\x1b\\`, "")
    .replaceAll("\x1b]8;;\x1b\\", "");
  expect(ours.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
  expect(shown).toContain("next line");
});

test("a page so narrow it has no room still draws", () => {
  expect(drawPage(page, issueUrl, 3, "click to open").length).toBeGreaterThan(0);
});

test("the description is drawn from its markdown, and a long link still wraps", () => {
  const body = "## Steps\n- **one** [the docs](https://example.com/docs) and more words";
  const lines = drawPage({ ...page, body }, issueUrl, 24, "click to open");
  expect(read(lines).slice(-3)).toEqual(["  Steps", "  • one the docs and", "    more words"]);
  expect(lines.join("\n")).toContain("\x1b[1mSteps\x1b[22m");
  expect(lines.join("\n")).toContain("\x1b]8;;https://example.com/docs");
});

test("on a wide pane, text wraps at 80 columns, past the two columns of margin", () => {
  const words = "word ".repeat(60).trim();
  const lines = read(drawPage({ ...page, title: words, body: words }, issueUrl, 200, "x"));
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(82);
  expect(lines[1]).toBe(`  ${"word ".repeat(16).trim()}`);
  expect(lines.at(-1)).toBe(`  ${"word ".repeat(12).trim()}`);
});

test("a narrower pane still wraps at its own width", () => {
  const body = "word ".repeat(30).trim();
  const lines = read(drawPage({ ...page, body }, issueUrl, 50, "x"));
  expect(lines.at(-2)).toBe(`  ${"word ".repeat(9).trim()}`);
});

test("the link to GitHub stays on the line it was drawn on, however the page wraps", () => {
  const body = "word ".repeat(200);
  const lines = drawPage({ ...page, body }, issueUrl, 200, "click to open");
  expect(lines.findIndex((line) => line.includes(`\x1b]8;;${issueUrl}`))).toBe(5);
});
