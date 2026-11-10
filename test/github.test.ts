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
  readRepository,
  removeWebhook,
  setReviewStatus,
  setWebhook,
} from "../src/github.ts";
import { issueNode, pollAnswer, pullNode } from "./harness.ts";

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

test("creates an issue and returns it as a task for skel's copy", async () => {
  gh(
    JSON.stringify({
      number: 12,
      title: "Add export",
      body: "As JSON",
      user: { login: "simon", type: "User" },
      labels: [],
      html_url: "https://github.com/simon/app/issues/12",
      created_at: "2026-11-05T10:00:00Z",
      updated_at: "2026-11-05T10:00:00Z",
    }),
  );
  expect(await createIssue("simon/app", "Add export", "As JSON")).toEqual({
    kind: "task",
    id: "12",
    title: "Add export",
    body: "As JSON",
    state: "open",
    author: { login: "simon", bot: false, you: true },
    labels: [],
    link: "https://github.com/simon/app/issues/12",
    created: "2026-11-05T10:00:00Z",
    updated: "2026-11-05T10:00:00Z",
    closes: "Closes #12",
  });
  expect(sent()).toEqual({
    args: ["api", "repos/simon/app/issues", "--method", "POST", "--input", "-"],
    input: { title: "Add export", body: "As JSON" },
  });
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

test("opens a pull request", async () => {
  gh('{"number":40}');
  const number = await openPullRequest("simon/app", {
    branch: "skel/12-add-export",
    base: "main",
    title: "Add export",
    body: "Exports as JSON.\n\nCloses #12",
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
  await expect(findPullRequest("simon/app", "skel/99")).rejects.toThrow(
    "Couldn't look for a pull request from skel/99 in simon/app: HTTP 404: Not Found",
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

test("without a since, reads every open issue and PR as items, page by page", async () => {
  const first = pollAnswer([
    issueNode(12, "Add export", {
      body: "As JSON",
      labels: { nodes: [{ name: "skel" }] },
      updatedAt: "2026-11-06T10:00:00Z",
    }),
  ]);
  // The first answer says more issues follow, and the second brings them.
  first.data.repository.issues.pageInfo = { hasNextPage: true, endCursor: "c1" };
  const second = pollAnswer([issueNode(13, "Fix login")]);
  writeFileSync(join(home, "pages"), "");
  writeFileSync(join(home, "page1"), JSON.stringify(first));
  writeFileSync(join(home, "page2"), JSON.stringify(second));
  const script = `#!/bin/sh
cat >> "${home}/stdin"
echo >> "${home}/stdin"
n=$(( $(wc -l < "${home}/pages") + 1 )); echo >> "${home}/pages"
cat "${home}/page$n"
`;
  writeFileSync(join(home, "gh"), script, { mode: 0o755 });
  const read = await readRepository("simon/app", [], null);
  expect(read.items.map((item) => item.id)).toEqual(["12", "13"]);
  expect(read.items[0]).toEqual({
    kind: "task",
    id: "12",
    title: "Add export",
    body: "As JSON",
    state: "open",
    author: { login: "simon", bot: false, you: true },
    labels: ["skel"],
    link: "https://github.com/simon/app/issues/12",
    created: "2026-11-05T10:00:00Z",
    updated: "2026-11-06T10:00:00Z",
    closes: "Closes #12",
  });
  expect(read.next).toBe("2026-11-06T10:00:00Z");
  const [asked, more] = readFileSync(join(home, "stdin"), "utf8").trim().split("\n");
  expect(asked).toContain("issues(first: 100, states: [OPEN]");
  expect(asked).toContain("pullRequests(first: 50, states: [OPEN]");
  // The second page asks only for the list that goes on, from where the first stopped.
  expect(more).toContain('after: \\"c1\\"');
  expect(more).not.toContain("pullRequests");
});

test("with a since, reads only what changed, closed issues and merged PRs too", async () => {
  gh(
    JSON.stringify(
      pollAnswer(
        [issueNode(12, "Add export", { state: "CLOSED", updatedAt: "2026-11-07T10:00:00Z" })],
        [pullNode(34, "Bump deps", { state: "MERGED", updatedAt: "2026-11-07T11:00:00Z" })],
      ),
    ),
  );
  const read = await readRepository("simon/app", [], "2026-11-06T10:00:00Z");
  expect(read.items.map((item) => [item.id, item.state])).toEqual([
    ["12", "closed"],
    ["34", "merged"],
  ]);
  expect(read.next).toBe("2026-11-07T11:00:00Z");
  const query = JSON.stringify(sent().input);
  expect(query).toContain('filterBy: { since: \\"2026-11-06T10:00:00Z\\" }');
  expect(query).not.toContain("states: [OPEN]");
});

// A list that has more pages may hold changes the answer didn't bring, so the next poll asks
// for everything open again.
test("with a since, a full page of changes means the next poll reads everything", async () => {
  const answer = pollAnswer([], [pullNode(34, "Bump deps", { updatedAt: "2026-11-07T11:00:00Z" })]);
  answer.data.repository.pulls.pageInfo = { hasNextPage: true, endCursor: "c1" };
  gh(JSON.stringify(answer));
  expect((await readRepository("simon/app", [], "2026-11-06T10:00:00Z")).next).toBeNull();
  // Older PRs beyond the page didn't change, so nothing was missed.
  const older = pollAnswer([], [pullNode(34, "Bump deps", { updatedAt: "2026-11-01T11:00:00Z" })]);
  older.data.repository.pulls.pageInfo = { hasNextPage: true, endCursor: "c1" };
  gh(JSON.stringify(older));
  expect((await readRepository("simon/app", [], "2026-11-06T10:00:00Z")).next).toBe(
    "2026-11-06T10:00:00Z",
  );
});

test("a PR becomes an item with its branch, checks and reviews, in skel's words", async () => {
  const pr = pullNode(7, "Add export", {
    headRefName: "skel/12-add-export",
    mergeable: "CONFLICTING",
    author: { __typename: "Bot", login: "skel" },
    reviews: {
      nodes: [
        {
          databaseId: 1,
          state: "CHANGES_REQUESTED",
          body: "No.",
          author: { __typename: "User", login: "ana" },
          comments: { nodes: [{ path: "a.ts", line: 3, body: "Here." }] },
        },
        { databaseId: 2, state: "PENDING", body: "", author: null, comments: { nodes: [] } },
      ],
    },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    databaseId: 900,
                    name: "test",
                    status: "COMPLETED",
                    conclusion: "FAILURE",
                    detailsUrl: null,
                  },
                  {
                    __typename: "StatusContext",
                    context: "skel/review",
                    state: "PENDING",
                    targetUrl: null,
                  },
                ],
              },
            },
          },
        },
      ],
    },
  });
  gh(JSON.stringify(pollAnswer([], [], { pr7: pr })));
  const read = await readRepository("simon/app", [7], "2026-11-06T10:00:00Z");
  expect(read.prs.get(7)?.mergeable).toBe("CONFLICTING");
  expect(read.items).toEqual([
    expect.objectContaining({
      kind: "pr",
      id: "7",
      branch: "skel/12-add-export",
      base: "main",
      conflicts: true,
      author: { login: "skel", bot: true, you: false },
      checks: [
        { name: "test", id: "900", state: "failed" },
        { name: "skel/review", id: null, state: "running" },
      ],
      reviews: [
        {
          id: "1",
          text: "No.",
          author: { login: "ana", bot: false, you: false },
          verdict: "changes requested",
          lines: [{ path: "a.ts", line: 3, text: "Here." }],
        },
      ],
      comments: [],
    }),
  ]);
  expect(JSON.stringify(sent().input)).toContain("pr7: pullRequest(number: 7)");
});

// An issue can carry many labels, and skel must always see its own among them.
test("asks for as many labels as GitHub gives in one answer", async () => {
  gh(JSON.stringify(pollAnswer([])));
  await readRepository("simon/app", [], null);
  const query = JSON.stringify(sent().input);
  expect(query).toContain("labels(first: 100)");
  expect(query).not.toMatch(/labels\(first: (?!100\))/);
});

test("an issue in a shape skel doesn't expect is refused, not saved", async () => {
  gh(JSON.stringify(pollAnswer([issueNode(12, "x", { number: "12" })])));
  await expect(readRepository("simon/app", [], null)).rejects.toThrow();
});

test("a link that could end a terminal link early is refused", async () => {
  const url = "https://github.com/simon/app/issues/12\u001b]8;;";
  gh(JSON.stringify(pollAnswer([issueNode(12, "x", { url })])));
  await expect(readRepository("simon/app", [], null)).rejects.toThrow();
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
