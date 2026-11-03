// Every call skel makes to GitHub goes through here, with your gh login, so another
// tracker or forge could be added in one place.
import { z } from "zod";

const View = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  viewerPermission: z.string(),
});

// Asks about origin by name: in a fork with an upstream remote, gh on its own would
// answer for the upstream, where skel can't push.
export function githubRepoAt(path: string): { owner: string; repo: string; canPush: boolean } {
  const origin = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!origin.success) throw new Error(`${path} has no origin remote on GitHub`);
  const url = origin.stdout.toString().trim();
  const run = Bun.spawnSync(["gh", "repo", "view", url, "--json", "name,owner,viewerPermission"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success) {
    const said = run.stderr.toString().trim();
    throw new Error(`${path} isn't on GitHub, or your gh login can't reach it: ${said}`);
  }
  const view = View.parse(JSON.parse(run.stdout.toString()));
  const canPush = ["ADMIN", "MAINTAIN", "WRITE"].includes(view.viewerPermission);
  return { owner: view.owner.login, repo: view.name, canPush };
}
