// Every call skel makes to GitHub goes through here, with your gh login, so another tracker
// or forge could be added in one place.
import { z } from "zod";
import { quietly } from "./run.ts";

// Owner and name become folders, so neither may climb out of skel's.
export const Name = z.string().regex(/^(?!\.\.?$)[\w.-]+$/);

const View = z.object({
  name: Name,
  owner: z.object({ login: Name }),
  viewerPermission: z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]).catch("READ"),
  isFork: z.boolean(),
});

export type GitHubRepo = { owner: string; repo: string; canPush: boolean; isFork: boolean };

// Returns the repository's GitHub name, push access and fork status so skel can judge
// trust. Takes owner/repo, as skel names it from a checkout's origin: in a fork with an
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

// Clones a GitHub repository into skel's chosen folder, away from your checkout.
export async function cloneRepo(owner: string, repo: string, folder: string): Promise<void> {
  await git(["clone", "--quiet", `https://github.com/${owner}/${repo}.git`, folder]);
}

// Resets skel's clone to the latest default branch so the lead reads current code. Fetching
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

// Brings a branch of a GitHub repository into skel's clone in the folder, as a branch of its
// own, so a builder whose clone has skel's as origin can fetch it. Never the branch skel's
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

// Pushes a commit from skel's clone in the folder to a branch of a GitHub repository. Never
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

// Returns what gh printed, sending a body when supplied. Failures name what skel was trying,
// so you can tell which GitHub operation failed.
async function ghText(args: string[], doing: string, input?: object): Promise<string> {
  // Bun finds gh on the PATH skel started with unless given the env, so a PATH changed
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

// Creates an issue in owner/name and returns its number so the lead can start a thread.
export async function createIssue(fullName: string, title: string, body: string): Promise<number> {
  const made = await api(`repos/${fullName}/issues`, `create an issue in ${fullName}`, {
    title,
    body,
  });
  return Numbered.parse(made).number;
}

const Issue = z.object({ title: z.string(), body: z.string().nullable() });

// Returns an issue's title and body for the builder, the reviewer and skel task show, using
// empty text for no body. Says plainly when the issue doesn't exist, as gh's own words for
// that are GitHub's HTTP status.
export async function readIssue(
  fullName: string,
  issue: number,
): Promise<{ title: string; body: string }> {
  let got: unknown;
  try {
    got = await api(`repos/${fullName}/issues/${issue}`, `read issue #${issue} in ${fullName}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("(HTTP 404)"))
      throw new Error(`there is no issue #${issue} in ${fullName}`);
    throw error;
  }
  const { title, body } = Issue.parse(got);
  return { title, body: body ?? "" };
}

const IssueDetails = z.object({
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  labels: z.array(z.object({ name: z.string() })),
});

// Returns what an issue's page shows.
export async function readIssueDetails(fullName: string, issue: number) {
  return IssueDetails.parse(await api(`repos/${fullName}/issues/${issue}`, `read issue #${issue}`));
}

const OpenIssue = z.object({ number: z.number(), title: z.string(), createdAt: z.string() });

// Returns the open issues in owner/name, newest first, for skel task ls. gh issue list leaves
// out pull requests, which GitHub's API counts as issues. It lists 30 unless told more, and
// a thousand open tasks is more than anyone reads in a terminal.
export async function openIssues(fullName: string): Promise<z.infer<typeof OpenIssue>[]> {
  const listed = await gh(
    [
      "issue",
      "list",
      "--repo",
      fullName,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,title,createdAt",
    ],
    `list the open issues in ${fullName}`,
  );
  return z.array(OpenIssue).parse(listed);
}

// Creates the skel label in owner/name, so you can add it to an issue to start a thread.
// GitHub answers 422 when the repository has the label already, which is fine as it is.
export async function createLabel(fullName: string): Promise<void> {
  try {
    await api(`repos/${fullName}/labels`, `create the skel label in ${fullName}`, {
      name: "skel",
      color: "5319e7",
      description: "skel starts a thread on this issue",
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("(HTTP 422)")) return;
    throw error;
  }
}

const Hook = z.object({ id: z.number(), config: z.object({ url: z.string().optional() }) });

// Returns the IDs of the repository's webhooks to the URL. A repository with more than 100
// webhooks is not one skel expects.
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
  const doing = `set the webhook that wakes skel in ${fullName}`;
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

// Removes the repository's webhooks to the URL, for skel repo rm.
export async function removeWebhook(fullName: string, url: string): Promise<void> {
  for (const id of await hooksTo(fullName, url))
    await ghText(
      ["api", `repos/${fullName}/hooks/${id}`, "--method", "DELETE"],
      `remove the webhook that wakes skel from ${fullName}`,
    );
}

// Reacts to an issue with 👀, so you can see on GitHub that skel took it, without a comment.
export async function reactToIssue(fullName: string, issue: number): Promise<void> {
  const reacted = await api(`repos/${fullName}/issues/${issue}/reactions`, `react to #${issue}`, {
    content: "eyes",
  });
  z.object({ content: z.string() }).parse(reacted);
}

// Returns the open PR number for a branch, or null so skel knows it must open one. GitHub
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

// Opens the thread's PR and returns its number, linking the issue so merging closes it.
export async function openPullRequest(
  fullName: string,
  pr: { branch: string; base: string; title: string; body: string; issue: number },
): Promise<number> {
  const opened = await api(`repos/${fullName}/pulls`, `open a pull request from ${pr.branch}`, {
    head: pr.branch,
    base: pr.base,
    title: pr.title,
    body: `${pr.body}\n\nCloses #${pr.issue}`,
  });
  return Numbered.parse(opened).number;
}

// Posts the reviewer's verdict and explanation on the PR for you and the builder to read.
// GitHub refuses to let you approve or request changes on your own pull request, and skel
// opens and reviews it with the same gh login. So the verdict goes in a comment review, and
// the skel/review check is what branch protection can require. The review names the commit
// it covers, since a newer one can reach the PR while it is posted. Returns the review's ID:
// posted with your login, it looks like your own review on GitHub, and skel must know it
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

// Sets the commit's skel/review check so branch protection can require the reviewer's
// verdict. GitHub rejects a status whose description is longer than 140 characters.
export async function setReviewStatus(
  fullName: string,
  sha: string,
  state: "pending" | "success" | "failure",
  description: string,
): Promise<void> {
  const set = await api(
    `repos/${fullName}/statuses/${sha}`,
    `set the skel/review check on ${sha}`,
    {
      state,
      context: "skel/review",
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
// as events older than the last one skel handled mean nothing to it.
const pullFields = `state mergeable baseRefName
  reviews(last: 50) { nodes { databaseId state body author { __typename login }
    comments(first: 50) { nodes { path line body } } } }
  comments(last: 50) { nodes { databaseId body author { __typename login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { databaseId name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl } } } } } } }`;

const PullHead = z.object({ title: z.string(), body: z.string(), headRefName: z.string() });
const PullDetails = z.object({
  data: z.object({ repository: z.object({ pullRequest: PullHead.and(Pull) }) }),
});

// Returns what a PR's page shows, from the same fields a poll reads, so the page says what the
// strip says.
export async function readPullDetails(fullName: string, pr: number) {
  const [owner, name] = fullName.split("/");
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { title body headRefName ${pullFields} } } }`;
  const got = await gh(["api", "graphql", "--input", "-"], `read PR #${pr}`, {
    query,
    variables: { owner, name, number: pr },
  });
  return PullDetails.parse(got).data.repository.pullRequest;
}

const Labeled = z.object({ number: z.number(), title: z.string() });
export type Labeled = z.infer<typeof Labeled>;

// The newest open issues or PRs, and how many there are in all, which can be far more.
const OpenList = z
  .object({
    totalCount: z.number(),
    nodes: z.array(z.object({ number: z.number(), title: z.string(), createdAt: z.string() })),
  })
  .transform((list) => ({ total: list.totalCount, items: list.nodes }));
export type OpenList = z.infer<typeof OpenList>;

// A hundred is the most GitHub gives in one answer, and more than a sidebar can show.
const openFields = `first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
  totalCount nodes { number title createdAt } }`;
const openLists = `openIssues: issues(states: [OPEN], ${openFields}
  openPulls: pullRequests(states: [OPEN], ${openFields}`;

// Returns your gh login, the repository's open issues labeled skel, and each of
// its given PRs, with their reviews, comments, head checks and merge state, in one GraphQL
// query, so the number of requests doesn't grow with the number of threads. A PR GitHub
// doesn't find is left out. With `lists`, the same query brings the open issues and PRs the
// sidebar shows, so showing them costs no request of its own.
export async function readRepository(
  fullName: string,
  numbers: number[],
  lists: boolean,
): Promise<{
  you: string;
  labeled: Labeled[];
  prs: Map<number, PullRequest>;
  open: { issues: OpenList; prs: OpenList } | null;
}> {
  const [owner, name] = fullName.split("/");
  const pulls = numbers.map((n) => `pr${n}: pullRequest(number: ${n}) { ${pullFields} }`);
  // Issues with threads keep their label, so the oldest labeled issues could fill every
  // answer. Adding a label updates an issue, so one just labeled is always among the newest.
  const labeled = `labeled: issues(labels: ["skel"], states: [OPEN], first: 100,
    orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title } }`;
  const query = `query($owner: String!, $name: String!) { viewer { login }
    repository(owner: $owner, name: $name) {
      ${labeled}\n${lists ? openLists : ""}\n${pulls.join("\n")} } }`;
  const got = await gh(["api", "graphql", "--input", "-"], `poll ${fullName}`, {
    query,
    variables: { owner, name },
  });
  const { data } = z
    .object({
      data: z.object({
        viewer: z.object({ login: z.string() }),
        repository: z
          .object({
            labeled: nodes(Labeled),
            openIssues: OpenList.optional(),
            openPulls: OpenList.optional(),
          })
          .catchall(Pull.nullable()),
      }),
    })
    .parse(got);
  const { labeled: issues, openIssues, openPulls, ...found } = data.repository;
  const prs = new Map<number, PullRequest>();
  for (const n of numbers) {
    const pr = found[`pr${n}`];
    if (pr) prs.set(n, pr);
  }
  const open = openIssues && openPulls ? { issues: openIssues, prs: openPulls } : null;
  return { you: data.viewer.login, labeled: issues, prs, open };
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
