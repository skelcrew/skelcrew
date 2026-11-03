// Every call skel makes to GitHub goes through here, with your gh login, so another
// tracker or forge could be added in one place.
import { z } from "zod";

const View = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });

export function githubRepoAt(path: string): { owner: string; repo: string } {
  const run = Bun.spawnSync(["gh", "repo", "view", "--json", "name,owner"], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success) {
    const said = run.stderr.toString().trim();
    throw new Error(`${path} isn't on GitHub, or your gh login can't reach it: ${said}`);
  }
  const view = View.parse(JSON.parse(run.stdout.toString()));
  return { owner: view.owner.login, repo: view.name };
}
