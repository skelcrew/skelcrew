// Every call skel makes to GitHub goes through here, with your gh login, so another tracker
// or forge could be added in one place.
import { z } from "zod";

// Owner and name become folders, so neither may climb out of skel's.
const Name = z.string().regex(/^(?!\.\.?$)[\w.-]+$/);

const View = z.object({
  name: Name,
  owner: z.object({ login: Name }),
  viewerPermission: z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]).catch("READ"),
  isFork: z.boolean(),
});

export type GitHubRepo = { owner: string; repo: string; canPush: boolean; isFork: boolean };

// Returns the repository's GitHub name, push access and fork status so skel can judge
// trust. Takes owner/repo, as skel names it from a checkout's origin: in a fork with an
// upstream remote, gh on its own would answer for the upstream.
export function githubRepo(given: string): GitHubRepo {
  const run = Bun.spawnSync(
    ["gh", "repo", "view", given, "--json", "name,owner,viewerPermission,isFork"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!run.success) {
    const said = run.stderr.toString().trim();
    throw new Error(`${given} isn't on GitHub, or your gh login can't reach it: ${said}`);
  }
  const view = View.parse(JSON.parse(run.stdout.toString()));
  const canPush = ["ADMIN", "MAINTAIN", "WRITE"].includes(view.viewerPermission);
  return { owner: view.owner.login, repo: view.name, canPush, isFork: view.isFork };
}

// Runs git with your gh login and throws on failure, keeping GitHub access outside agents.
// Your gh login is handed to git for each command, never saved, so no token ends up in a
// clone's .git/config, where the lead could read it. Nobody may be there to type a
// password, so git fails rather than asks.
async function git(args: string[]): Promise<void> {
  const run = Bun.spawn(["git", "-c", "credential.helper=!gh auth git-credential", ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
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
  repo: string,
  branch: string | null,
): Promise<void> {
  await git([
    "-C",
    folder,
    "fetch",
    "--quiet",
    `https://github.com/${repo}.git`,
    branch ? `refs/heads/${branch}` : "HEAD",
  ]);
}

// Pushes a commit from skel's clone in the folder to a branch of a GitHub repository. Never
// forced, so a push can only add to what the branch already holds.
export async function pushCommit(
  folder: string,
  repo: string,
  sha: string,
  branch: string,
): Promise<void> {
  await git([
    "-C",
    folder,
    "push",
    "--quiet",
    `https://github.com/${repo}.git`,
    `${sha}:refs/heads/${branch}`,
  ]);
}

// Returns JSON from GitHub through gh, sending a body when supplied. Failures name what
// skel was trying, so you can tell which GitHub operation failed.
async function gh(args: string[], doing: string, input?: object): Promise<unknown> {
  // Bun finds gh on the PATH skel started with unless given the env, so a PATH changed
  // since would be ignored.
  const run = Bun.spawn(["gh", ...args], {
    env: process.env,
    stdin: new Blob([input ? JSON.stringify(input) : ""]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  if (code !== 0) throw new Error(`Couldn't ${doing}: ${err.trim()}`);
  return JSON.parse(out);
}

// Returns JSON from GitHub's REST API, posting the body when supplied.
const api = (endpoint: string, doing: string, input?: object) =>
  gh(["api", endpoint, ...(input ? ["--method", "POST", "--input", "-"] : [])], doing, input);

const Numbered = z.object({ number: z.number() });

// Creates an issue in owner/name and returns its number so the lead can start a thread.
export async function createIssue(repo: string, title: string, body: string): Promise<number> {
  const made = await api(`repos/${repo}/issues`, `create an issue in ${repo}`, { title, body });
  return Numbered.parse(made).number;
}

const Issue = z.object({ title: z.string(), body: z.string().nullable() });

// Returns an issue's title and body for the builder or reviewer, using empty text for no
// body.
export async function readIssue(
  repo: string,
  issue: number,
): Promise<{ title: string; body: string }> {
  const got = await api(`repos/${repo}/issues/${issue}`, `read issue #${issue} in ${repo}`);
  const { title, body } = Issue.parse(got);
  return { title, body: body ?? "" };
}

const OpenIssue = z.object({ number: z.number(), title: z.string(), createdAt: z.string() });

// Returns the open issues in owner/name, newest first, for skel task ls. gh issue list leaves
// out pull requests, which GitHub's API counts as issues. It lists 30 unless told more, and
// a thousand open tasks is more than anyone reads in a terminal.
export async function openIssues(repo: string): Promise<z.infer<typeof OpenIssue>[]> {
  const listed = await gh(
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,title,createdAt",
    ],
    `list the open issues in ${repo}`,
  );
  return z.array(OpenIssue).parse(listed);
}

// Returns the open PR number for a branch, or null so skel knows it must open one. GitHub
// only matches a branch named with its owner: "owner:branch".
export async function findPullRequest(repo: string, branch: string): Promise<number | null> {
  const owner = repo.split("/")[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  const found = await api(
    `repos/${repo}/pulls?state=open&head=${head}`,
    `look for a pull request from ${branch} in ${repo}`,
  );
  return z.array(Numbered).parse(found)[0]?.number ?? null;
}

// Opens the thread's PR and returns its number, linking the issue so merging closes it.
export async function openPullRequest(
  repo: string,
  pr: { branch: string; base: string; title: string; body: string; issue: number },
): Promise<number> {
  const opened = await api(`repos/${repo}/pulls`, `open a pull request from ${pr.branch}`, {
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
// it covers, since a newer one can reach the PR while it is posted.
export async function postReview(
  repo: string,
  pr: number,
  commit: string,
  verdict: "approve" | "changes",
  body: string,
): Promise<void> {
  const said = verdict === "approve" ? "**Approved.**" : "**Changes requested.**";
  const posted = await api(`repos/${repo}/pulls/${pr}/reviews`, `post a review on #${pr}`, {
    event: "COMMENT",
    commit_id: commit,
    body: `${said}\n\n${body}`,
  });
  z.object({ id: z.number() }).parse(posted);
}

// Sets the commit's skel/review check so branch protection can require the reviewer's
// verdict. GitHub rejects a status whose description is longer than 140 characters.
export async function setReviewStatus(
  repo: string,
  sha: string,
  state: "pending" | "success" | "failure",
  description: string,
): Promise<void> {
  const set = await api(`repos/${repo}/statuses/${sha}`, `set the skel/review check on ${sha}`, {
    state,
    context: "skel/review",
    description: description.slice(0, 140),
  });
  z.object({ state: z.string() }).parse(set);
}
