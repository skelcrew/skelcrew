// The calls the flow makes to GitHub, against a fake gh that logs what skel sent it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canPush,
  createIssue,
  createLabel,
  findPullRequest,
  openPullRequest,
  postReview,
  reactToIssue,
  readIssue,
  readRepository,
  removeWebhook,
  setReviewStatus,
  setWebhook,
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
  await postReview("simon/app", 40, "abc123", "approve", "Looks right.");
  expect(sent()).toEqual({
    args: ["api", "repos/simon/app/pulls/40/reviews", "--method", "POST", "--input", "-"],
    input: { event: "COMMENT", commit_id: "abc123", body: "**Approved.**\n\nLooks right." },
  });
});

test("posts a review asking for changes as a comment that states the verdict", async () => {
  gh('{"id":7}');
  await postReview("simon/app", 40, "abc123", "changes", "The test is missing.");
  expect(sent().input).toEqual({
    event: "COMMENT",
    commit_id: "abc123",
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

// githubRepo finds gh on the PATH skel started with, so only a skel started with the fake's
// folder on its PATH reaches the fake.
test("says a repository can't be reached in its own words", () => {
  gh("HTTP 404: Not Found", 1);
  const code = `await import(${JSON.stringify(join(import.meta.dir, "..", "src", "github.ts"))})
    .then((github) => github.githubRepo("simon/app"))
    .catch((error) => console.log(error.message));`;
  const run = Bun.spawnSync(["bun", "-e", code], { env: process.env, stdout: "pipe" });
  expect(run.stdout.toString().trim()).toBe(
    "simon/app isn't on GitHub, or your gh login can't reach it: HTTP 404: Not Found",
  );
});

test("refuses an answer from gh that isn't what GitHub sends", async () => {
  gh('{"title":"no number"}');
  await expect(createIssue("simon/app", "Add export", "As JSON")).rejects.toThrow();
});

test("someone with write, maintain or admin access can push", async () => {
  gh('{"permission":"write","role_name":"maintain"}');
  expect(await canPush("simon/app", "ana")).toBe(true);
  expect(sent().args).toEqual(["api", "repos/simon/app/collaborators/ana/permission"]);
  gh('{"permission":"admin","role_name":"admin"}');
  expect(await canPush("simon/app", "ana")).toBe(true);
});

test("someone with read or triage access, or none, can't push", async () => {
  for (const permission of ["read", "none"]) {
    gh(`{"permission":"${permission}","role_name":"triage"}`);
    expect(await canPush("simon/app", "mallory")).toBe(false);
  }
});

test("someone GitHub doesn't know as a user can't push", async () => {
  gh("gh: Not Found (HTTP 404)", 1);
  expect(await canPush("simon/app", "mallory")).toBe(false);
});

// Taken for a no, a comment skel failed to check would be skipped for good.
test("a failure to ask GitHub is an error, not a no", async () => {
  gh("gh: Bad Gateway (HTTP 502)", 1);
  await expect(canPush("simon/app", "ana")).rejects.toThrow("HTTP 502");
});

test("creates the skel label in a repository", async () => {
  gh('{"name":"skel"}');
  await createLabel("simon/app");
  expect(sent()).toMatchObject({
    args: ["api", "repos/simon/app/labels", "--method", "POST", "--input", "-"],
    input: { name: "skel" },
  });
});

test("a skel label the repository already has is fine", async () => {
  gh("gh: Validation Failed (HTTP 422)", 1);
  await createLabel("simon/app");
});

test("a label skel couldn't create is an error", async () => {
  gh("gh: Resource not accessible by integration (HTTP 403)", 1);
  await expect(createLabel("simon/app")).rejects.toThrow("HTTP 403");
});

test("reacts to an issue with eyes", async () => {
  gh('{"id":1,"content":"eyes"}');
  await reactToIssue("simon/app", 12);
  expect(sent()).toEqual({
    args: ["api", "repos/simon/app/issues/12/reactions", "--method", "POST", "--input", "-"],
    input: { content: "eyes" },
  });
});

// Issues with threads keep their label, so the oldest labeled issues could fill every answer.
// Adding a label updates an issue, so one just labeled is always among the newest.
test("asks for the labeled issues updated last", async () => {
  gh(
    '{"data":{"viewer":{"login":"simon"},"repository":{"labeled":{"nodes":[{"number":12,"title":"Add export"}]}}}}',
  );
  const read = await readRepository("simon/app", [], false);
  expect(read.labeled).toEqual([{ number: 12, title: "Add export" }]);
  expect(JSON.stringify(sent().input)).toContain("orderBy: { field: UPDATED_AT, direction: DESC }");
});

const repository = (more: object) =>
  JSON.stringify({
    data: { viewer: { login: "simon" }, repository: { labeled: { nodes: [] }, ...more } },
  });

test("asks for open issues and PRs in the same query, only when told to", async () => {
  gh(repository({}));
  const quiet = await readRepository("simon/app", [], false);
  expect(quiet.open).toBeNull();
  expect(JSON.stringify(sent().input)).not.toContain("totalCount");
  const issue = { number: 12, title: "Add export", createdAt: "2026-11-05T10:00:00Z" };
  const pull = { number: 34, title: "Bump deps", createdAt: "2026-11-04T10:00:00Z" };
  gh(
    repository({
      openIssues: { totalCount: 240, nodes: [issue] },
      openPulls: { totalCount: 1, nodes: [pull] },
    }),
  );
  const read = await readRepository("simon/app", [], true);
  expect(read.open).toEqual({
    issues: { total: 240, items: [issue] },
    prs: { total: 1, items: [pull] },
  });
  const query = JSON.stringify(sent().input);
  expect(query).toContain("issues(states: [OPEN], first: 100");
  expect(query).toContain("pullRequests(states: [OPEN], first: 100");
  expect(query).toContain("orderBy: { field: CREATED_AT, direction: DESC }");
});

test("an open issue in a shape skel doesn't expect is refused, not saved", async () => {
  gh(
    repository({
      openIssues: { totalCount: 1, nodes: [{ number: "12", title: "x", createdAt: "y" }] },
      openPulls: { totalCount: 0, nodes: [] },
    }),
  );
  await expect(readRepository("simon/app", [], true)).rejects.toThrow();
});

const hookUrl = "https://demo-simon.sprites.app";
const hook = {
  config: { url: hookUrl, content_type: "json", secret: "s3cret", insecure_ssl: "0" },
  events: [
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "check_suite",
    "status",
  ],
  active: true,
};

test("creates the webhook to the Sprite when the repository has none", async () => {
  gh('[{"id":3,"config":{"url":"https://ci.example.com/hook"}}]');
  await setWebhook("simon/app", hookUrl, "s3cret");
  expect(sent()).toEqual({
    args: ["api", "repos/simon/app/hooks", "--method", "POST", "--input", "-"],
    input: { name: "web", ...hook },
  });
});

// A second webhook to the same URL would wake the Sprite twice for every event.
test("updates the webhook to the Sprite rather than adding a second one", async () => {
  gh(
    `[{"id":3,"config":{"url":"https://ci.example.com/hook"}},{"id":5,"config":{"url":"${hookUrl}"}}]`,
  );
  await setWebhook("simon/app", hookUrl, "s3cret");
  expect(sent()).toEqual({
    args: ["api", "repos/simon/app/hooks/5", "--method", "PATCH", "--input", "-"],
    input: hook,
  });
});

test("removes only the webhook to the Sprite", async () => {
  gh(
    `[{"id":3,"config":{"url":"https://ci.example.com/hook"}},{"id":5,"config":{"url":"${hookUrl}"}}]`,
  );
  await removeWebhook("simon/app", hookUrl);
  expect(sent().args).toEqual(["api", "repos/simon/app/hooks/5", "--method", "DELETE"]);
});

test("removing a webhook the repository doesn't have deletes nothing", async () => {
  gh('[{"id":3,"config":{"url":"https://ci.example.com/hook"}}]');
  await removeWebhook("simon/app", hookUrl);
  expect(sent().args).toEqual(["api", "repos/simon/app/hooks?per_page=100"]);
});
