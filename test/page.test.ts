// The page shown for an issue or PR: what the daemon makes of a fake gh's answer, and how it
// is drawn, given that answer.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, readPage } from "../src/flow/page.ts";
import { drawPage } from "../src/screen/page.ts";

const esc = "\x1b";
const issueUrl = "https://github.com/simon/app/issues/31";
const pullUrl = "https://github.com/simon/app/pull/34";
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

const issue = {
  title: "Add CSV export",
  body: "Export threads.\n\nKeep it small.",
  state: "open",
  user: { login: "simon" },
  labels: [{ name: "skel" }, { name: "good first issue" }],
};

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
const pull = (more: object = {}) => ({
  data: {
    repository: {
      pullRequest: {
        title: "Fix the login redirect",
        body: "Sign-in landed on a 404.",
        headRefName: "skel/12",
        baseRefName: "main",
        state: "OPEN",
        mergeable: "MERGEABLE",
        reviews: { nodes: [] },
        comments: { nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        ...more,
      },
    },
  },
});
const rolledUp = (...nodes: object[]) => ({
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] },
});

test("an issue's page has its title, state, author, labels and description", async () => {
  gh(issue);
  expect(await readPage(issueUrl)).toEqual({
    title: "Add CSV export",
    facts: [
      ["State", "open"],
      ["Author", "simon"],
      ["Labels", "skel, good first issue"],
    ],
    body: "Export threads.\n\nKeep it small.",
  });
  expect(readFileSync(join(home, "args"), "utf8")).toContain("repos/simon/app/issues/31");
});

test("an issue with no description, labels or author still has a page", async () => {
  gh({ ...issue, body: null, labels: [], user: null });
  expect(await readPage(issueUrl)).toEqual({
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
  gh(
    pull({
      ...rolledUp(check("test", "SUCCESS")),
      reviews: { nodes: [review("CHANGES_REQUESTED", "No."), review("APPROVED", "Fine.", "ana")] },
    }),
  );
  expect(await readPage(pullUrl)).toEqual({
    title: "Fix the login redirect",
    facts: [
      ["State", "open"],
      ["Branch", "skel/12 → main"],
      ["Checks", "passing"],
      ["Review", "approved · ana"],
    ],
    body: "Sign-in landed on a 404.",
  });
  const { variables } = JSON.parse(readFileSync(join(home, "stdin"), "utf8"));
  expect(variables).toEqual({ owner: "simon", name: "app", number: 34 });
});

test("a PR with no checks or reviews says so", async () => {
  gh(pull());
  const { facts } = await readPage(pullUrl);
  expect(facts).toContainEqual(["Checks", "none"]);
  expect(facts).toContainEqual(["Review", "none"]);
});

test("checks read as the strip reads them, leaving out skel's own review check", async () => {
  const running = [check("test", "SUCCESS"), check("lint", null)];
  gh(pull(rolledUp(...running, check("skel/review", "FAILURE"))));
  expect((await readPage(pullUrl)).facts).toContainEqual(["Checks", "running"]);
  gh(pull(rolledUp(check("test", "FAILURE"), check("lint", null))));
  expect((await readPage(pullUrl)).facts).toContainEqual(["Checks", "failing"]);
});

test("a review skel posted says its verdict, as GitHub only has it as a comment", async () => {
  gh(pull({ reviews: { nodes: [review("COMMENTED", "**Approved.**\n\nLooks right.")] } }));
  expect((await readPage(pullUrl)).facts).toContainEqual(["Review", "Approved. · codex-bot"]);
});

test("a review still being written isn't the latest one", async () => {
  const nodes = [review("APPROVED", ""), review("PENDING", "half a thought", "ana")];
  gh(pull({ reviews: { nodes } }));
  expect((await readPage(pullUrl)).facts).toContainEqual(["Review", "approved · codex-bot"]);
});

test("an answer from gh in an unexpected shape is refused", async () => {
  gh({ title: 7 });
  await expect(readPage(issueUrl)).rejects.toThrow();
  gh({ data: { repository: { pullRequest: null } } });
  await expect(readPage(pullUrl)).rejects.toThrow();
});

const page: Page = {
  title: "Add CSV export",
  facts: [
    ["State", "open"],
    ["Labels", "skel"],
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
    "  Labels  skel",
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
