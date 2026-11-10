// The page shown for an issue or PR: what it says of an item, as a poll brings it into Skelcrew's
// copy from a fake gh's answer, and how it is drawn.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, pageOf } from "../src/flow/page.ts";
import { readRepository } from "../src/github.ts";
import { drawPage } from "../src/screen/page.ts";
import { issueNode, pollAnswer, pullNode } from "./harness.ts";

const esc = "\x1b";
const issueUrl = "https://github.com/simon/app/issues/31";
let home = "";
const path = process.env.PATH;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-page-test-")));
  process.env.PATH = `${home}:${path ?? ""}`;
});
afterEach(() => {
  process.env.PATH = path;
  rmSync(home, { recursive: true, force: true });
});

// The fake gh writes its arguments, one per line, then what it read on stdin, and answers.
function gh(answer: object) {
  writeFileSync(join(home, "answer"), JSON.stringify(answer));
  const script = `#!/bin/sh
printf '%s\\n' "$@" > "${home}/args"
cat > "${home}/stdin"
cat "${home}/answer"
`;
  writeFileSync(join(home, "gh"), script, { mode: 0o755 });
}

const issue = issueNode(31, "Add CSV export", {
  body: "Export threads.\n\nKeep it small.",
  labels: { nodes: [{ name: "skelcrew" }, { name: "good first issue" }] },
});

const check = (name: string, conclusion: string | null) => ({
  __typename: "CheckRun",
  databaseId: 1,
  name,
  status: conclusion ? "COMPLETED" : "IN_PROGRESS",
  conclusion,
  detailsUrl: null,
});
const review = (state: string, body: string, login = "codex-bot") => ({
  databaseId: 1,
  state,
  body,
  author: { __typename: "User", login },
  comments: { nodes: [] },
});
const pull = (more: object = {}) =>
  pullNode(34, "Fix the login redirect", {
    body: "Sign-in landed on a 404.",
    headRefName: "skelcrew/12",
    ...more,
  });
const rolledUp = (...nodes: object[]) => ({
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] },
});

// Returns the page of an issue or PR, as GitHub sends it in a poll and Skelcrew's copy keeps it.
async function pageFor(node: object, kind: "issue" | "pr"): Promise<Page> {
  gh(kind === "issue" ? pollAnswer([node]) : pollAnswer([], [node]));
  const [item] = (await readRepository("simon/app", [], null)).items;
  if (!item) throw new Error("the poll brought no item");
  return pageOf(item);
}

test("an issue's page has its title, state, author, labels and description", async () => {
  expect(await pageFor(issue, "issue")).toEqual({
    title: "Add CSV export",
    facts: [
      ["State", "open"],
      ["Author", "simon"],
      ["Labels", "skelcrew, good first issue"],
    ],
    body: "Export threads.\n\nKeep it small.",
  });
});

test("an issue with no description, labels or author still has a page", async () => {
  const bare = { ...issue, body: "", labels: { nodes: [] }, author: null };
  expect(await pageFor(bare, "issue")).toEqual({
    title: "Add CSV export",
    facts: [
      ["State", "open"],
      ["Author", "unknown"],
      ["Labels", "none"],
    ],
    body: "",
  });
});

test("a PR's page has its title, state, branch, checks, latest review and description", async () => {
  const pr = pull({
    ...rolledUp(check("test", "SUCCESS")),
    reviews: { nodes: [review("CHANGES_REQUESTED", "No."), review("APPROVED", "Fine.", "ana")] },
  });
  expect(await pageFor(pr, "pr")).toEqual({
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

test("a PR with no checks or reviews says so", async () => {
  const { facts } = await pageFor(pull(), "pr");
  expect(facts).toContainEqual(["Checks", "none"]);
  expect(facts).toContainEqual(["Review", "none"]);
});

test("checks read as the strip reads them, leaving out Skelcrew's own review check", async () => {
  const running = [check("test", "SUCCESS"), check("lint", null)];
  const pr = pull(rolledUp(...running, check("skelcrew/check", "FAILURE")));
  expect((await pageFor(pr, "pr")).facts).toContainEqual(["Checks", "running"]);
  const failing = pull(rolledUp(check("test", "FAILURE"), check("lint", null)));
  expect((await pageFor(failing, "pr")).facts).toContainEqual(["Checks", "failing"]);
});

test("a review Skelcrew posted says its verdict, as GitHub only has it as a comment", async () => {
  const pr = pull({ reviews: { nodes: [review("COMMENTED", "**Approved.**\n\nLooks right.")] } });
  expect((await pageFor(pr, "pr")).facts).toContainEqual(["Review", "Approved. · codex-bot"]);
});

test("a review still being written isn't the latest one", async () => {
  const nodes = [review("APPROVED", ""), review("PENDING", "half a thought", "ana")];
  const pr = pull({ reviews: { nodes } });
  expect((await pageFor(pr, "pr")).facts).toContainEqual(["Review", "approved · codex-bot"]);
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
  expect(read(drawPage(page, issueUrl, 60))).toEqual([
    "",
    "  Add CSV export",
    "",
    "  State   open",
    "  Labels  skelcrew",
    `  GitHub  ${issueUrl}`,
    "",
    "  Export threads.",
    "",
    "  Keep it small.",
  ]);
});

test("the link to GitHub is a terminal link, with only its text inside", () => {
  const line = drawPage(page, issueUrl, 60).find((text) => text.includes("GitHub"));
  expect(line).toContain(`\x1b]8;;${issueUrl}\x1b\\`);
  expect(line).toEndWith("\x1b]8;;\x1b\\");
});

test("a page with no description says so", () => {
  expect(read(drawPage({ ...page, body: "" }, issueUrl, 60)).at(-1)).toBe("  No description.");
});

test("every line stops two columns before the edge, wide letters and long words too", () => {
  const long = {
    title: "日本語のタイトル ".repeat(10),
    facts: [["Labels", "a-rather-long-label ".repeat(8)] satisfies [string, string]],
    body: `${"word ".repeat(40)}\n${"x".repeat(120)}`,
  };
  for (const line of drawPage(long, issueUrl, 40))
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(38);
});

test("a fact too long for a line goes on under its value", () => {
  const facts: [string, string][] = [["Labels", "one two three four five six seven eight"]];
  const lines = read(drawPage({ ...page, facts }, issueUrl, 30));
  expect(lines[3]).toBe("  Labels  one two three four");
  expect(lines[4]).toBe("          five six seven");
});

test("control codes from GitHub never reach your terminal, on any line", () => {
  const evil = "\x1b]0;owned\x07\x1b[2J\x9b31mtext\rover\x1b]8;;http://evil\x1b\\";
  const shown = drawPage(
    { title: evil, facts: [["Author", evil]], body: `${evil}\nnext line` },
    issueUrl,
    200,
  ).join("\n");
  const ours = shown
    .replaceAll(new RegExp(`${esc}\\[[\\d;]*m`, "g"), "")
    .replaceAll(`\x1b]8;;${issueUrl}\x1b\\`, "")
    .replaceAll("\x1b]8;;\x1b\\", "");
  expect(ours.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
  expect(shown).toContain("next line");
});

test("a page so narrow it has no room still draws", () => {
  expect(drawPage(page, issueUrl, 3).length).toBeGreaterThan(0);
});

test("the description is drawn from its markdown, and a long link still wraps", () => {
  const body = "## Steps\n- **one** [the docs](https://example.com/docs) and more words";
  const lines = drawPage({ ...page, body }, issueUrl, 24);
  expect(read(lines).slice(-3)).toEqual(["  Steps", "  • one the docs and", "  more words"]);
  expect(lines.join("\n")).toContain("\x1b[1mSteps\x1b[22m");
  expect(lines.join("\n")).toContain("\x1b]8;;https://example.com/docs");
});
