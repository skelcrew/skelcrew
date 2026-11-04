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

// Your gh login is handed to git for each command, never saved, so no token ends up in a
// clone's .git/config, where the lead could read it. Nobody may be there to type a
// password, so git fails rather than asks.
function git(args: string[]): void {
  const run = Bun.spawnSync(["git", "-c", "credential.helper=!gh auth git-credential", ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success)
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
}

export function cloneRepo(owner: string, repo: string, folder: string): void {
  git(["clone", "--quiet", `https://github.com/${owner}/${repo}.git`, folder]);
}

// Fetching HEAD gets whatever the default branch is now, even after it was renamed.
export function updateClone(folder: string): void {
  git(["-C", folder, "fetch", "--quiet", "origin", "HEAD"]);
  git(["-C", folder, "reset", "--quiet", "--hard", "FETCH_HEAD"]);
}
