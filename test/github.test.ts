// The calls the flow makes to GitHub, against a fake gh that logs what skel sent it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIssue,
  findPullRequest,
  openPullRequest,
  postReview,
  readIssue,
  setReviewStatus,
} from "../src/github.ts";

let home = "";
const path = process.env.PATH;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-github-test-")));
  process.env.PATH = `${home}:${path ?? ""}`;
});
afterEach(() => {
  process.env.PATH = path;
  rmSync(home, { recursive: true, force: true });
});

// The fake gh writes its arguments, one per line, then what it read on stdin, and answers
// with `answer`. A non-zero `code` makes it fail with `answer` on stderr instead.
function gh(answer: string, code = 0) {
  writeFileSync(join(home, "answer"), answer);
  const reply = code ? `cat "${home}/answer" >&2; exit ${code}` : `cat "${home}/answer"`;
  const script = `#!/bin/sh
printf '%s\\n' "$@" > "${home}/args"
cat > "${home}/stdin"
${reply}
`;
  writeFileSync(join(home, "gh"), script, { mode: 0o755 });
}

function sent(): { args: string[]; input: unknown } {
  const args = readFileSync(join(home, "args"), "utf8").trimEnd().split("\n");
  const stdin = readFileSync(join(home, "stdin"), "utf8");
  return { args, input: stdin ? JSON.parse(stdin) : null };
}

test("creates an issue and returns its number", async () => {
  gh('{"number":12,"title":"Add export"}');
  expect(await createIssue("simon/app", "Add export", "As JSON")).toBe(12);
  expect(sent()).toEqual({
    args: ["api", "repos/simon/app/issues", "--method", "POST", "--input", "-"],
    input: { title: "Add export", body: "As JSON" },
  });
});

test("reads an issue's title and body", async () => {
  gh('{"number":12,"title":"Add export","body":"As JSON"}');
  expect(await readIssue("simon/app", 12)).toEqual({ title: "Add export", body: "As JSON" });
  expect(sent().args).toEqual(["api", "repos/simon/app/issues/12"]);
});

test("reads an issue with no body as an empty body", async () => {
  gh('{"number":12,"title":"Add export","body":null}');
  expect(await readIssue("simon/app", 12)).toEqual({ title: "Add export", body: "" });
});

test("finds the open pull request for a branch", async () => {
  gh('[{"number":40,"head":{"ref":"skel/12-add-export"}}]');
  expect(await findPullRequest("simon/app", "skel/12-add-export")).toBe(40);
  expect(sent().args).toEqual([
    "api",
    "repos/simon/app/pulls?state=open&head=simon%3Askel%2F12-add-export",
  ]);
});

test("finds no pull request for a branch without one", async () => {
  gh("[]");
  expect(await findPullRequest("simon/app", "skel/12-add-export")).toBeNull();
});

test("opens a pull request that closes the issue", async () => {
  gh('{"number":40}');
  const number = await openPullRequest("simon/app", {
    branch: "skel/12-add-export",
    base: "main",
    title: "Add export",
    body: "Exports as JSON.",
    issue: 12,
  });
  expect(number).toBe(40);
  expect(sent()).toEqual({
    args: ["api", "repos/simon/app/pulls", "--method", "POST", "--input", "-"],
    input: {
      head: "skel/12-add-export",
      base: "main",
      title: "Add export",
      body: "Exports as JSON.\n\nCloses #12",
    },
  });
});

test("posts an approving review as a comment that states the verdict", async () => {
  gh('{"id":7}');
  await postReview("simon/app", 40, "approve", "Looks right.");
  expect(sent()).toEqual({
    args: ["api", "repos/simon/app/pulls/40/reviews", "--method", "POST", "--input", "-"],
    input: { event: "COMMENT", body: "**Approved.**\n\nLooks right." },
  });
});

test("posts a review asking for changes as a comment that states the verdict", async () => {
  gh('{"id":7}');
  await postReview("simon/app", 40, "changes", "The test is missing.");
  expect(sent().input).toEqual({
    event: "COMMENT",
    body: "**Changes requested.**\n\nThe test is missing.",
  });
});

test("sets the skel/review check on a commit", async () => {
  gh('{"id":3,"state":"pending"}');
  await setReviewStatus("simon/app", "abc123", "pending", "Reviewing");
  expect(sent()).toEqual({
    args: ["api", "repos/simon/app/statuses/abc123", "--method", "POST", "--input", "-"],
    input: { state: "pending", context: "skel/review", description: "Reviewing" },
  });
});

test("cuts a long check description to what GitHub accepts", async () => {
  gh('{"id":3,"state":"failure"}');
  await setReviewStatus("simon/app", "abc123", "failure", "x".repeat(200));
  const input = sent().input;
  expect(input).toMatchObject({ state: "failure", context: "skel/review" });
  expect(JSON.stringify(input)).toContain(`"description":"${"x".repeat(140)}"`);
  expect(JSON.stringify(input)).not.toContain("x".repeat(141));
});

test("says what it tried and what gh said when gh fails", async () => {
  gh("HTTP 404: Not Found", 1);
  await expect(readIssue("simon/app", 99)).rejects.toThrow(
    "Couldn't read issue #99 in simon/app: HTTP 404: Not Found",
  );
});

test("refuses an answer from gh that isn't what GitHub sends", async () => {
  gh('{"title":"no number"}');
  await expect(createIssue("simon/app", "Add export", "As JSON")).rejects.toThrow();
});
