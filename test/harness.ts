// What skel's tests share: finding skel's source files, waiting, and running skel and its
// daemon as a user would. Each test file keeps its own home folder and tmux socket and hands
// them in, so a test that outlives its file can never reach another file's home.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

// Returns the path of a file in src/, or of src/ itself, for a test that runs skel or hands
// its code to a process of its own.
export const source = (file = "") => join(import.meta.dir, "..", "src", file);

// Waits until `done` holds, for what a daemon or a session does in its own time, looking every
// `every` milliseconds. Past `timeout` it throws, naming `what` if given. `what` is a function
// so a test can show what is on screen at that moment, and pays for that only on failure.
export async function until(
  done: () => boolean,
  options: { timeout?: number; every?: number; what?: () => string } = {},
): Promise<void> {
  const { timeout = 10_000, every = 50, what } = options;
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error(what ? `gave up waiting for ${what()}` : "gave up waiting");
    await Bun.sleep(every);
  }
}

// Returns the environment for a process of a test with this home. skel, its daemon and what
// they start find their state, their socket and the test's fake programs through it, and so
// never reach the real ones.
export const homeEnv = (home: string) => ({
  HOME: home,
  XDG_RUNTIME_DIR: join(home, "run"),
  PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
});

// Returns what a file holds, or nothing before it exists, for a test watching a file appear.
export const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

// Writes a shell script into the home's bin folder, where it stands in for a real program.
export function writeScript(home: string, name: string, body: string): void {
  writeFileSync(join(home, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// Runs git in a folder as a test's own user and returns what it printed, without the line end.
// A failure throws what git said, so a test's setup can't quietly go wrong.
export function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

// Starts a daemon on a test's tmux socket and adds it to `running` for the test to stop. It
// takes a process of its own, as homedir() keeps the HOME this process started with, so a
// daemon here would open your real database.
export function startDaemon(
  socket: string,
  env: Record<string, string>,
  running: Subprocess[],
): Subprocess {
  const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)});`;
  const run = Bun.spawn([process.execPath, "-e", code], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  running.push(run);
  return run;
}

// Runs skel with these arguments and environment, and gives back what it printed and its code.
export async function runSkel(args: string[], env: Record<string, string>) {
  const run = Bun.spawn([process.execPath, source("main.ts"), ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { out, err, code };
}

// Returns an issue as GitHub's GraphQL API sends it in a poll, open and labeled as given.
export function issueNode(number: number, title: string, more: object = {}): object {
  return {
    number,
    title,
    body: "",
    url: `https://github.com/simon/app/issues/${number}`,
    createdAt: "2026-11-05T10:00:00Z",
    updatedAt: "2026-11-05T10:00:00Z",
    author: { __typename: "User", login: "simon" },
    labels: { nodes: [] },
    state: "OPEN",
    ...more,
  };
}

// Returns a PR as GitHub's GraphQL API sends it in a poll, open with no reviews, comments or
// checks unless given.
export function pullNode(number: number, title: string, more: object = {}): object {
  return {
    number,
    title,
    body: "",
    url: `https://github.com/simon/app/pull/${number}`,
    createdAt: "2026-11-05T10:00:00Z",
    updatedAt: "2026-11-05T10:00:00Z",
    author: { __typename: "User", login: "simon" },
    labels: { nodes: [] },
    state: "OPEN",
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: `skel/${number}`,
    reviews: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...more,
  };
}

// Returns GitHub's answer to a poll, as its GraphQL API sends it: one page holding the issues
// and PRs given, and `more`, such as a thread's PR as pr7.
export function pollAnswer(issues: object[], pulls: object[] = [], more: object = {}) {
  const page = (nodes: object[]) => ({
    pageInfo: { hasNextPage: false, endCursor: null as string | null },
    nodes,
  });
  return {
    data: {
      viewer: { login: "simon" },
      repository: { issues: page(issues), pulls: page(pulls), ...more },
    },
  };
}

// Returns SQL that puts an open issue or PR into skel's copy, as a poll would have saved it, for
// a test that reads the copy without a daemon. The repository's owner is simon. `more` sets
// the item's other fields, such as its body.
export function itemSql(
  repo: string,
  kind: "task" | "pr",
  id: number,
  title: string,
  created: string,
  more: object = {},
): string {
  const link = `https://github.com/simon/${repo}/${kind === "task" ? "issues" : "pull"}/${id}`;
  const common = { id: String(id), title, body: "", state: "open", author: null, labels: [] };
  const item =
    kind === "task"
      ? { kind, ...common, link, created, updated: created, closes: `Closes #${id}` }
      : { kind, ...common, link, created, updated: created, branch: `b${id}`, base: "main" };
  const pr = kind === "pr" ? { conflicts: false, checks: [], reviews: [], comments: [] } : {};
  const json = JSON.stringify({ ...item, ...pr, ...more }).replaceAll("'", "''");
  return `INSERT OR REPLACE INTO items (owner, repo, kind, id, state, created, item)
    VALUES ('simon', '${repo}', '${kind}', '${id}', 'open', '${created}', '${json}');`;
}
