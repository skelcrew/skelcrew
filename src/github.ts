// Every call skel makes to GitHub goes through here, with your gh login, so another
// tracker or forge could be added in one place.
import { z } from "zod";

const View = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  viewerPermission: z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]).catch("READ"),
  isFork: z.boolean(),
});

// Asks about origin by name: in a fork with an upstream remote, gh on its own would
// answer for the upstream, where skel can't push.
export function githubRepoAt(path: string): {
  owner: string;
  repo: string;
  canPush: boolean;
  isFork: boolean;
} {
  const origin = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!origin.success) throw new Error(`${path} has no origin remote on GitHub`);
  const url = origin.stdout.toString().trim();
  const run = Bun.spawnSync(
    ["gh", "repo", "view", url, "--json", "name,owner,viewerPermission,isFork"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!run.success) {
    const said = run.stderr.toString().trim();
    throw new Error(`${path} isn't on GitHub, or your gh login can't reach it: ${said}`);
  }
  const view = View.parse(JSON.parse(run.stdout.toString()));
  const canPush = ["ADMIN", "MAINTAIN", "WRITE"].includes(view.viewerPermission);
  return { owner: view.owner.login, repo: view.name, canPush, isFork: view.isFork };
}

// Runs `gh api` on `endpoint`, sending `input` as the JSON body when there is one. `doing`
// says what skel was trying, for the error when gh fails.
async function api(endpoint: string, doing: string, input?: object): Promise<unknown> {
  const args = input ? ["--method", "POST", "--input", "-"] : [];
  // Bun finds gh on the PATH skel started with unless given the env, so a PATH changed
  // since would be ignored.
  const run = Bun.spawn(["gh", "api", endpoint, ...args], {
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

const Numbered = z.object({ number: z.number() });

// `repo` is always "owner/name".
export async function createIssue(repo: string, title: string, body: string): Promise<number> {
  const made = await api(`repos/${repo}/issues`, `create an issue in ${repo}`, { title, body });
  return Numbered.parse(made).number;
}

const Issue = z.object({ title: z.string(), body: z.string().nullable() });

export async function readIssue(
  repo: string,
  issue: number,
): Promise<{ title: string; body: string }> {
  const got = await api(`repos/${repo}/issues/${issue}`, `read issue #${issue} in ${repo}`);
  const { title, body } = Issue.parse(got);
  return { title, body: body ?? "" };
}

// GitHub only matches a branch named with its owner: "owner:branch".
export async function findPullRequest(repo: string, branch: string): Promise<number | null> {
  const owner = repo.split("/")[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  const found = await api(
    `repos/${repo}/pulls?state=open&head=${head}`,
    `look for a pull request from ${branch} in ${repo}`,
  );
  return z.array(Numbered).parse(found)[0]?.number ?? null;
}

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

// GitHub refuses to let you approve or request changes on your own pull request, and skel
// opens and reviews it with the same gh login. So the verdict goes in a comment review, and
// the skel/review check is what branch protection can require.
export async function postReview(
  repo: string,
  pr: number,
  verdict: "approve" | "changes",
  body: string,
): Promise<void> {
  const said = verdict === "approve" ? "**Approved.**" : "**Changes requested.**";
  const posted = await api(`repos/${repo}/pulls/${pr}/reviews`, `post a review on #${pr}`, {
    event: "COMMENT",
    body: `${said}\n\n${body}`,
  });
  z.object({ id: z.number() }).parse(posted);
}

// GitHub rejects a status whose description is longer than 140 characters.
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
