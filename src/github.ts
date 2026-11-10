// Every call Skelcrew makes to GitHub goes through here, with your gh login, so another tracker
// or forge could be added in one place.
import { z } from "zod";
import { Item, type Task } from "./flow/copy.ts";
import { quietly } from "./run.ts";

// Owner and name become folders, so neither may climb out of Skelcrew's.
export const Name = z.string().regex(/^(?!\.\.?$)[\w.-]+$/);

const View = z.object({
  name: Name,
  owner: z.object({ login: Name }),
  viewerPermission: z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]).catch("READ"),
  isFork: z.boolean(),
});

export type GitHubRepo = { owner: string; repo: string; canPush: boolean; isFork: boolean };

// Returns the repository's GitHub name, push access and fork status so Skelcrew can judge
// trust. Takes owner/repo, as Skelcrew names it from a checkout's origin: in a fork with an
// upstream remote, gh on its own would answer for the upstream. The daemon asks while it
// answers other commands, so it must not wait on gh. Its failure has words of its own, so
// it doesn't go through gh below.
export async function githubRepo(given: string): Promise<GitHubRepo> {
  const { out, err, ok } = await quietly([
    "gh",
    "repo",
    "view",
    given,
    "--json",
    "name,owner,viewerPermission,isFork",
  ]);
  if (!ok)
    throw new Error(`${given} isn't on GitHub, or your gh login can't reach it: ${err.trim()}`);
  const view = View.parse(JSON.parse(out));
  const canPush = ["ADMIN", "MAINTAIN", "WRITE"].includes(view.viewerPermission);
  return { owner: view.owner.login, repo: view.name, canPush, isFork: view.isFork };
}

// Runs git with your gh login and throws on failure, keeping GitHub access outside agents.
// Your gh login is handed to git for each command, never saved, so no token ends up in a
// clone's .git/config, where the lead could read it. Nobody may be there to type a
// password, so git fails rather than asks.
async function git(args: string[]): Promise<void> {
  const { err, ok } = await quietly(
    ["git", "-c", "credential.helper=!gh auth git-credential", ...args],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "ignore" },
  );
  if (!ok) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
}

// Clones a GitHub repository into Skelcrew's chosen folder, away from your checkout.
export async function cloneRepo(owner: string, repo: string, folder: string): Promise<void> {
  await git(["clone", "--quiet", `https://github.com/${owner}/${repo}.git`, folder]);
}

// Resets Skelcrew's clone to the latest default branch so the lead reads current code. Fetching
// HEAD follows the default branch even after it is renamed.
export async function updateClone(folder: string): Promise<void> {
  await git(["-C", folder, "fetch", "--quiet", "origin", "HEAD"]);
  await git(["-C", folder, "reset", "--quiet", "--hard", "FETCH_HEAD"]);
}

// Fetches a branch of a GitHub repository, or its default branch when none is given, into
// the folder's FETCH_HEAD, for a thread's clone to start from. Fetched by URL, so no remote
// holding it is saved in the folder's .git/config.
export async function fetchBranch(
  folder: string,
  fullName: string,
  branch: string | null,
): Promise<void> {
  await git([
    "-C",
    folder,
    "fetch",
    "--quiet",
    `https://github.com/${fullName}.git`,
    branch ? `refs/heads/${branch}` : "HEAD",
  ]);
}

// Brings a branch of a GitHub repository into Skelcrew's clone in the folder, as a branch of its
// own, so a builder whose clone has Skelcrew's as origin can fetch it. Never the branch Skelcrew's
// clone has checked out, which updateClone keeps current with its files.
export async function fetchIntoClone(
  folder: string,
  fullName: string,
  branch: string,
): Promise<void> {
  await git([
    "-C",
    folder,
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    `https://github.com/${fullName}.git`,
    `+refs/heads/${branch}:refs/heads/${branch}`,
  ]);
}

// Pushes a commit from Skelcrew's clone in the folder to a branch of a GitHub repository. Never
// forced, so a push can only add to what the branch already holds.
export async function pushCommit(
  folder: string,
  fullName: string,
  sha: string,
  branch: string,
): Promise<void> {
  await git([
    "-C",
    folder,
    "push",
    "--quiet",
    `https://github.com/${fullName}.git`,
    `${sha}:refs/heads/${branch}`,
  ]);
}

// Returns what gh printed, sending a body when supplied. Failures name what Skelcrew was trying,
// so you can tell which GitHub operation failed.
async function ghText(args: string[], doing: string, input?: object): Promise<string> {
  // Bun finds gh on the PATH Skelcrew started with unless given the env, so a PATH changed
  // since would be ignored.
  const { out, err, ok } = await quietly(["gh", ...args], {
    env: process.env,
    stdin: new Blob([input ? JSON.stringify(input) : ""]),
  });
  if (!ok) throw new Error(`Couldn't ${doing}: ${err.trim()}`);
  return out;
}

// Returns JSON from GitHub through gh, sending a body when supplied.
const gh = async (args: string[], doing: string, input?: object): Promise<unknown> =>
  JSON.parse(await ghText(args, doing, input));

// Returns JSON from GitHub's REST API, posting the body when supplied.
const api = (endpoint: string, doing: string, input?: object) =>
  gh(["api", endpoint, ...(input ? ["--method", "POST", "--input", "-"] : [])], doing, input);

const Numbered = z.object({ number: z.number() });

const Made = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
  labels: z.array(z.object({ name: z.string() })),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

// Creates an issue in owner/name and returns it as a task, for Skelcrew's copy, so the lead sees it
// in sc task ls at once and can start a thread on it. Your login wrote it.
export async function createIssue(fullName: string, title: string, body: string): Promise<Task> {
  const made = Made.parse(
    await api(`repos/${fullName}/issues`, `create an issue in ${fullName}`, { title, body }),
  );
  return {
    kind: "task",
    id: String(made.number),
    title: made.title,
    body: made.body ?? "",
    state: "open",
    author: made.user && { login: made.user.login, bot: made.user.type === "Bot", you: true },
    labels: made.labels.map((label) => label.name),
    link: made.html_url,
    created: made.created_at,
    updated: made.updated_at,
    closes: `Closes #${made.number}`,
  };
}

// Creates the skelcrew label in owner/name, so you can add it to an issue to start a thread.
// GitHub answers 422 when the repository has the label already, which is fine as it is.
export async function createLabel(fullName: string): Promise<void> {
  try {
    await api(`repos/${fullName}/labels`, `create the skelcrew label in ${fullName}`, {
      name: "skelcrew",
      color: "5319e7",
      description: "Skelcrew starts a thread on this issue",
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("(HTTP 422)")) return;
    throw error;
  }
}

const Hook = z.object({ id: z.number(), config: z.object({ url: z.string().optional() }) });

// Returns the IDs of the repository's webhooks to the URL. A repository with more than 100
// webhooks is not one Skelcrew expects.
async function hooksTo(fullName: string, url: string): Promise<number[]> {
  const listed = await api(
    `repos/${fullName}/hooks?per_page=100`,
    `list the webhooks of ${fullName}`,
  );
  return z
    .array(Hook)
    .parse(listed)
    .filter((hook) => hook.config.url === url)
    .map((hook) => hook.id);
}

// Makes the repository send GitHub's deliveries for the events a thread's poll reads to the
// URL, signed with the secret. A webhook to the URL already there is updated, not added
// again, which would send each delivery twice.
export async function setWebhook(fullName: string, url: string, secret: string): Promise<void> {
  const hook = {
    config: { url, content_type: "json", secret, insecure_ssl: "0" },
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
  const [id] = await hooksTo(fullName, url);
  const doing = `set the webhook that wakes Skelcrew in ${fullName}`;
  if (id === undefined)
    await ghText(["api", `repos/${fullName}/hooks`, "--method", "POST", "--input", "-"], doing, {
      name: "web",
      ...hook,
    });
  else
    await ghText(
      ["api", `repos/${fullName}/hooks/${id}`, "--method", "PATCH", "--input", "-"],
      doing,
      hook,
    );
}

// Removes the repository's webhooks to the URL, for sc repo rm.
export async function removeWebhook(fullName: string, url: string): Promise<void> {
  for (const id of await hooksTo(fullName, url))
    await ghText(
      ["api", `repos/${fullName}/hooks/${id}`, "--method", "DELETE"],
      `remove the webhook that wakes Skelcrew from ${fullName}`,
    );
}

// Reacts to an issue with 👀, so you can see on GitHub that Skelcrew took it, without a comment.
export async function reactToIssue(fullName: string, issue: number): Promise<void> {
  const reacted = await api(`repos/${fullName}/issues/${issue}/reactions`, `react to #${issue}`, {
    content: "eyes",
  });
  z.object({ content: z.string() }).parse(reacted);
}

// Returns the open PR number for a branch, or null so Skelcrew knows it must open one. GitHub
// only matches a branch named with its owner: "owner:branch".
export async function findPullRequest(fullName: string, branch: string): Promise<number | null> {
  const owner = fullName.split("/")[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  const found = await api(
    `repos/${fullName}/pulls?state=open&head=${head}`,
    `look for a pull request from ${branch} in ${fullName}`,
  );
  return z.array(Numbered).parse(found)[0]?.number ?? null;
}

// Opens the thread's PR and returns its number.
export async function openPullRequest(
  fullName: string,
  pr: { branch: string; base: string; title: string; body: string },
): Promise<number> {
  const opened = await api(`repos/${fullName}/pulls`, `open a pull request from ${pr.branch}`, {
    head: pr.branch,
    base: pr.base,
    title: pr.title,
    body: pr.body,
  });
  return Numbered.parse(opened).number;
}

// Posts the reviewer's verdict and explanation on the PR for you and the builder to read.
// GitHub refuses to let you approve or request changes on your own pull request, and Skelcrew
// opens and reviews it with the same gh login. So the verdict goes in a comment review, and
// the skelcrew/check check is what branch protection can require. The review names the commit
// it covers, since a newer one can reach the PR while it is posted. Returns the review's ID:
// posted with your login, it looks like your own review on GitHub, and Skelcrew must know it
// wrote it.
export async function postReview(
  fullName: string,
  pr: number,
  commit: string,
  verdict: "approve" | "changes",
  body: string,
): Promise<number> {
  const said = verdict === "approve" ? "**Approved.**" : "**Changes requested.**";
  const posted = await api(`repos/${fullName}/pulls/${pr}/reviews`, `post a review on #${pr}`, {
    event: "COMMENT",
    commit_id: commit,
    body: `${said}\n\n${body}`,
  });
  return z.object({ id: z.number() }).parse(posted).id;
}

// Sets the commit's skelcrew/check check so branch protection can require the reviewer's
// verdict. GitHub rejects a status whose description is longer than 140 characters.
export async function setReviewStatus(
  fullName: string,
  sha: string,
  state: "pending" | "success" | "failure",
  description: string,
): Promise<void> {
  const set = await api(
    `repos/${fullName}/statuses/${sha}`,
    `set the skelcrew/check check on ${sha}`,
    {
      state,
      context: "skelcrew/check",
      description: description.slice(0, 140),
    },
  );
  z.object({ state: z.string() }).parse(set);
}

const Author = z
  .object({ __typename: z.string(), login: z.string() })
  .nullable()
  .transform((a) => a && { login: a.login, bot: a.__typename === "Bot" });

export type Check =
  | {
      kind: "run";
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      url: string | null;
    }
  | { kind: "status"; name: string; state: string; url: string | null };

const Context = z.discriminatedUnion("__typename", [
  z
    .object({
      __typename: z.literal("CheckRun"),
      databaseId: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      detailsUrl: z.string().nullable(),
    })
    .transform(
      (c): Check => ({
        kind: "run",
        id: c.databaseId,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        url: c.detailsUrl,
      }),
    ),
  z
    .object({
      __typename: z.literal("StatusContext"),
      context: z.string(),
      state: z.string(),
      targetUrl: z.string().nullable(),
    })
    .transform(
      (c): Check => ({
        kind: "status",
        name: c.context,
        state: c.state,
        url: c.targetUrl,
      }),
    ),
]);

const nodes = <T extends z.ZodType>(item: T) =>
  z.object({ nodes: z.array(item) }).transform((list) => list.nodes);

const Pull = z
  .object({
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    baseRefName: z.string(),
    reviews: nodes(
      z
        .object({
          databaseId: z.number(),
          state: z.string(),
          body: z.string(),
          author: Author,
          comments: nodes(
            z.object({ path: z.string(), line: z.number().nullable(), body: z.string() }),
          ),
        })
        .transform(({ databaseId, ...review }) => ({ id: databaseId, ...review })),
    ),
    comments: nodes(
      z
        .object({ databaseId: z.number(), body: z.string(), author: Author })
        .transform(({ databaseId, ...comment }) => ({ id: databaseId, ...comment })),
    ),
    commits: nodes(
      z.object({
        commit: z.object({
          statusCheckRollup: z.object({ contexts: nodes(Context) }).nullable(),
        }),
      }),
    ),
  })
  .transform((p) => ({
    state: p.state,
    mergeable: p.mergeable,
    base: p.baseRefName,
    reviews: p.reviews,
    comments: p.comments,
    // Only the head commit is asked for, and only its checks count.
    checks: p.commits[0]?.commit.statusCheckRollup?.contexts ?? [],
  }));
export type PullRequest = z.infer<typeof Pull>;

// Enough of each list for what can happen between two polls. Only the newest are asked for,
// as events older than the last one Skelcrew handled mean nothing to it. A thread's PR is asked
// for with its last 50 reviews. Other PRs, which Skelcrew only shows, are asked for with their
// last 10: GitHub charges a poll for every review it may send, times the PRs asked for.
const pullFields = (reviews: number) => `state mergeable baseRefName headRefName
  reviews(last: ${reviews}) { nodes { databaseId state body author { __typename login }
    comments(first: 50) { nodes { path line body } } } }
  comments(last: 50) { nodes { databaseId body author { __typename login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { databaseId name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl } } } } } } }`;

// What an issue or a PR has as an item, besides what a poll reads of a PR.
const itemFields = `number title body url createdAt updatedAt author { __typename login }
  labels(first: 100) { nodes { name } }`;

const Head = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: Author,
  labels: nodes(z.object({ name: z.string() })),
});
const IssueNode = Head.extend({ state: z.enum(["OPEN", "CLOSED"]) });
const PullNode = Head.extend({ headRefName: z.string() }).and(Pull);

// A page of issues or PRs, and where the next page starts if there is one.
const page = <T extends z.ZodType>(node: T) =>
  z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    nodes: z.array(node),
  });

type Verdict = Extract<Item, { kind: "pr" }>["reviews"][number]["verdict"];
// A review still being written isn't one yet, so it has no verdict and is left out.
const verdicts = new Map<string, Verdict>([
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "changes requested"],
  ["COMMENTED", "commented"],
  ["DISMISSED", "dismissed"],
]);

// Returns how a check stands in Skelcrew's words. A check run cancelled, or left stale by a newer
// commit, is no failure for the builder to fix.
function checkState(check: Check): "running" | "passed" | "failed" | "cancelled" {
  if (check.kind === "status") {
    if (["PENDING", "EXPECTED"].includes(check.state)) return "running";
    return check.state === "SUCCESS" ? "passed" : "failed";
  }
  if (check.status !== "COMPLETED") return "running";
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? "")) return "passed";
  return ["CANCELLED", "STALE"].includes(check.conclusion ?? "") ? "cancelled" : "failed";
}

// Returns who wrote something, in Skelcrew's words. `you` is your gh login.
const authorOf = (a: { login: string; bot: boolean } | null, you: string) =>
  a && { ...a, you: a.login === you };

// Returns what an issue and a PR share as items, in Skelcrew's words.
const itemOf = (node: z.infer<typeof Head>, you: string) => ({
  id: String(node.number),
  title: node.title,
  body: node.body,
  author: authorOf(node.author, you),
  labels: node.labels.map((label) => label.name),
  link: node.url,
  created: node.createdAt,
  updated: node.updatedAt,
});

// Returns an issue as a task, for Skelcrew's copy.
function issueItem(node: z.infer<typeof IssueNode>, you: string): Task {
  const state = node.state === "OPEN" ? "open" : "closed";
  return { kind: "task", ...itemOf(node, you), state, closes: `Closes #${node.number}` };
}

// Returns a PR as an item, for Skelcrew's copy.
function pullItem(node: z.infer<typeof PullNode>, you: string): Item {
  return {
    kind: "pr",
    ...itemOf(node, you),
    state: node.state === "OPEN" ? "open" : node.state === "MERGED" ? "merged" : "closed",
    branch: node.headRefName,
    base: node.base,
    conflicts: node.mergeable === "CONFLICTING",
    checks: node.checks.map((check) => ({
      name: check.name,
      id: check.kind === "run" ? String(check.id) : null,
      state: checkState(check),
    })),
    reviews: node.reviews.flatMap((review) => {
      const verdict = verdicts.get(review.state);
      if (!verdict) return [];
      const lines = review.comments.map(({ body, ...line }) => ({ ...line, text: body }));
      const author = authorOf(review.author, you);
      return [{ id: String(review.id), text: review.body, author, verdict, lines }];
    }),
    comments: node.comments.map((c) => ({
      id: String(c.id),
      text: c.body,
      author: authorOf(c.author, you),
    })),
  };
}

// Returns the query for one page of the repository's issues and PRs, newest updated first:
// with `since`, those updated since then, closed ones too; without, every open one. Each list
// goes on from its cursor, starts at its beginning with null, and isn't asked for with false.
// Values go in the query itself, as GitHub refuses a query declaring one it doesn't use.
function listsQuery(
  since: string | null,
  issues: string | null | false,
  pulls: string | null | false,
): string {
  const order = "orderBy: { field: UPDATED_AT, direction: DESC }";
  const from = (cursor: string | null) => (cursor ? `, after: ${JSON.stringify(cursor)}` : "");
  const states = since ? "" : ", states: [OPEN]";
  const filter = since ? `, filterBy: { since: ${JSON.stringify(since)} }` : "";
  const info = "pageInfo { hasNextPage endCursor }";
  // Each PR asked for costs more than an issue, and few change between two polls.
  const many = since ? 10 : 50;
  return [
    issues === false
      ? ""
      : `issues: issues(first: 100${from(issues)}${states}${filter}, ${order}) {
        ${info} nodes { ${itemFields} state } }`,
    pulls === false
      ? ""
      : `pulls: pullRequests(first: ${many}${from(pulls)}${states}, ${order}) {
        ${info} nodes { ${itemFields} ${pullFields(10)} } }`,
  ].join("\n");
}

// Returns what changed in the repository since `since`, as items for Skelcrew's copy, or with no
// `since` everything open, page by page. Also returns your gh login, and each of the given PRs
// with its reviews, comments, head checks and merge state, whether it changed or not: a check
// that finished doesn't count as a change to its PR. They come in the same GraphQL query, so
// the number of requests doesn't grow with the number of threads. A PR GitHub doesn't find is
// left out. `next` is the `since` of the next poll: the newest change seen, or null when more
// may have changed than one answer brings, so the next poll asks for everything open again.
export async function readRepository(
  fullName: string,
  numbers: number[],
  since: string | null,
): Promise<{ you: string; prs: Map<number, PullRequest>; items: Item[]; next: string | null }> {
  const [owner, name] = fullName.split("/");
  const threads = numbers.map(
    (n) => `pr${n}: pullRequest(number: ${n}) { ${itemFields} ${pullFields(50)} }`,
  );
  const prs = new Map<number, PullRequest>();
  const items: Item[] = [];
  const theirs: Item[] = [];
  let you = "";
  let more = false;
  // Returns where a list goes on, or false once it is done. Without `since` every page is
  // read. With it, a full page whose oldest change is still new may hide more beyond it.
  const goesOn = (list?: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { updatedAt: string }[];
  }) => {
    if (!list?.pageInfo.hasNextPage) return false;
    if (since === null) return list.pageInfo.endCursor ?? false;
    if ((list.nodes.at(-1)?.updatedAt ?? "") >= since) more = true;
    return false;
  };
  let issues: string | null | false = null;
  let pulls: string | null | false = null;
  for (let first = true; issues !== false || pulls !== false; first = false) {
    const query = `query($owner: String!, $name: String!) { viewer { login }
      repository(owner: $owner, name: $name) {
        ${listsQuery(since, issues, pulls)}\n${first ? threads.join("\n") : ""} } }`;
    const got = await gh(["api", "graphql", "--input", "-"], `poll ${fullName}`, {
      query,
      variables: { owner, name },
    });
    const { data } = z
      .object({
        data: z.object({
          viewer: z.object({ login: z.string() }),
          repository: z
            .object({ issues: page(IssueNode).optional(), pulls: page(PullNode).optional() })
            .catchall(PullNode.nullable()),
        }),
      })
      .parse(got);
    const { issues: issuePage, pulls: pullPage, ...found } = data.repository;
    you = data.viewer.login;
    items.push(...(issuePage?.nodes ?? []).map((node) => issueItem(node, you)));
    items.push(...(pullPage?.nodes ?? []).map((node) => pullItem(node, you)));
    if (first)
      for (const n of numbers) {
        const pr = found[`pr${n}`];
        if (!pr) continue;
        prs.set(n, pr);
        theirs.push(pullItem(pr, you));
      }
    issues = issues === false ? false : goesOn(issuePage);
    pulls = pulls === false ? false : goesOn(pullPage);
  }
  // Each thread's PR comes last, so it wins over the same PR read with fewer reviews.
  items.push(...theirs);
  const newest = [since ?? "", ...items.map((item) => item.updated)].sort().at(-1) ?? "";
  // Checked as Skelcrew's copy will read them back, so one it can't take fails here, not later.
  return {
    you,
    prs,
    items: items.map((item) => Item.parse(item)),
    next: more || newest === "" ? null : newest,
  };
}

// Returns the given issues as tasks, open or closed, in one query: for threads whose task
// Skelcrew's copy lacks, such as after an upgrade, as a poll brings only open ones at first, and
// for sc start, as a poll reads only one page of changes. An issue GitHub doesn't find is
// left out.
export async function readTasks(fullName: string, numbers: number[]): Promise<Task[]> {
  const [owner, name] = fullName.split("/");
  const asked = numbers.map((n) => `task${n}: issue(number: ${n}) { ${itemFields} state }`);
  const got = await gh(["api", "graphql", "--input", "-"], `read the tasks of ${fullName}`, {
    query: `query($owner: String!, $name: String!) { viewer { login }
      repository(owner: $owner, name: $name) { ${asked.join("\n")} } }`,
    variables: { owner, name },
  });
  const { data } = z
    .object({
      data: z.object({
        viewer: z.object({ login: z.string() }),
        repository: z.record(z.string(), z.unknown()),
      }),
    })
    .parse(got);
  // Only what was asked for is read.
  const tasks = numbers.flatMap((n) => {
    const node = IssueNode.nullish().parse(data.repository[`task${n}`]);
    return node ? [issueItem(node, data.viewer.login)] : [];
  });
  // Checked as Skelcrew's copy will read them back, so one it can't take fails here, not later.
  for (const task of tasks) Item.parse(task);
  return tasks;
}

// Returns whether someone can push to the repository: write, maintain or admin access, which
// GitHub reports as write or admin. Throws when GitHub can't be asked, so a failure is never
// taken for a no.
export async function canPush(fullName: string, login: string): Promise<boolean> {
  let got: unknown;
  try {
    got = await api(
      `repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`,
      `check ${login}'s access to ${fullName}`,
    );
  } catch (error) {
    // GitHub answers 404 for a login that is no user, such as a deleted account's.
    if (error instanceof Error && error.message.includes("(HTTP 404)")) return false;
    throw error;
  }
  const { permission } = z.object({ permission: z.string() }).parse(got);
  return ["admin", "write"].includes(permission);
}

// Returns the end of a failed GitHub Actions job's log: the failed steps only, without the
// job and step names and the time gh puts before each line. Kept short, as it is typed into
// the builder, which can ask for more by running the tests itself.
export async function failedLog(fullName: string, job: number): Promise<string> {
  const log = await ghText(
    ["run", "view", "--job", String(job), "--log-failed", "--repo", fullName],
    `read the log of job ${job} in ${fullName}`,
  );
  const lines = log
    .trimEnd()
    .split("\n")
    .map((line) => line.replace(/^[^\t]*\t[^\t]*\t(\S+Z )?/, ""));
  return lines.slice(-30).join("\n").slice(-3000);
}
