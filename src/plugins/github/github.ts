// The GitHub plugin, for reading only: it pushes a task's branch and opens
// a draft pull request for it with GitHub's `gh` command. Skelcrew still
// merges locally. Nothing here merges on GitHub.
//
// git and gh run as separate programs. Every reply from gh is checked with
// Zod before it is used. Neither may stop to ask a person anything, so
// both are told not to prompt: a missing login fails at once instead.

import * as z from "zod";
import type { CloseRequest, PullRequest, PullRequests, ShowRequest } from "../pull-requests";
import type { Done } from "../version-control";

// What a program did: its exit code and output, that it isn't installed,
// or that it ran past its time limit and was stopped.
export type Ran =
  | { exitCode: number; stdout: string; stderr: string }
  | { missing: true }
  | { timedOut: true };
export type RunOptions = { cwd: string; stdin?: string; timeoutMs: number };
export type Runner = (command: string[], options: RunOptions) => Promise<Ran>;

// How long each call may take before it is stopped. A call that never
// answers, such as ssh waiting on a network that has gone, would otherwise
// hold up every pull request until the daemon restarts.
// - Reading origin's URL is local, so a few seconds is plenty.
// - A gh call is one to a few requests to GitHub, usually done in seconds.
//   A minute leaves room for a slow network.
// - A push sends the task's commits and runs any pre-push hook, which may
//   run tests. Three minutes leaves room for both.
const LOCAL_MS = 10_000;
const GH_MS = 60_000;
const PUSH_MS = 180_000;

// gh exits with 4 when it needs a login.
const NEEDS_LOGIN = 4;

// `gh pr list --json number,url,isCrossRepository`: a list, empty when
// there is none. `--head` matches the branch name in any repository, so a
// pull request from someone's fork with a branch of the same name is in it
// too, marked as cross-repository.
const listed = z.array(
  z.object({
    number: z.number().int().positive(),
    url: z.url(),
    isCrossRepository: z.boolean(),
  }),
);

// `gh pr create` prints the new pull request's link last, such as
// https://github.com/owner/repo/pull/41.
const createdLink = /^(https?:\/\/\S+\/pull\/(\d+))$/;

export class GitHub implements PullRequests {
  constructor(
    private readonly repo: string,
    private readonly runner: Runner = runProgram,
  ) {}

  // Finds the open pull request first, before pushing: that one call also
  // shows whether gh is installed, logged in and pointed at GitHub. So
  // without gh, nothing is pushed.
  async show(request: ShowRequest): Promise<Done<PullRequest>> {
    const repo = await this.originRepo();
    if (!repo.ok) return repo;

    const list = await this.gh(
      [
        "pr",
        "list",
        "--repo",
        repo.value,
        "--head",
        request.branch,
        "--state",
        "open",
        "--json",
        "number,url,isCrossRepository",
      ],
      "gh couldn't list the pull requests",
    );
    if (!list.ok) return list;
    const found = parseList(list.value);
    if (!found.ok) return found;

    // Never forced: a branch that moved on GitHub is refused, not replaced.
    const pushed = await this.run(
      ["git", "push", "origin", `${request.head}:refs/heads/${request.branch}`],
      PUSH_MS,
    );
    if (!pushed.ok) {
      return { ok: false, message: `git couldn't push the branch: ${failed(pushed)}` };
    }
    if (found.value !== null) return { ok: true, value: found.value };

    const created = await this.gh(
      [
        "pr",
        "create",
        "--repo",
        repo.value,
        "--draft",
        "--base",
        request.base,
        "--head",
        request.branch,
        "--title",
        request.title,
        "--body-file",
        "-",
      ],
      "gh couldn't open the pull request",
      request.body,
    );
    if (!created.ok) return created;
    return parseCreated(created.value);
  }

  // Closes the pull request, then deletes the branch Skelcrew pushed, but
  // only if nobody added to it. For example, a reviewer's "Commit
  // suggestion" on the draft adds a commit on GitHub only. `approve` merged
  // the local branch, so deleting the pushed one would lose that commit.
  //
  // The branch is looked at before closing, so the comment can say it was
  // kept. It is deleted after closing, since GitHub closes a pull request
  // whose branch is deleted, and the comment would then be lost.
  //
  // Deleting is tidying up: the local branch keeps the work. So a branch
  // that can't be deleted, such as one already gone, doesn't count as a
  // failure. `gh pr close --delete-branch` isn't used, since it deletes the
  // local branch too.
  async close(request: CloseRequest): Promise<Done<null>> {
    const repo = await this.originRepo();
    if (!repo.ok) return repo;
    const ref = `refs/heads/${request.branch}`;
    const listed = await this.run(["git", "ls-remote", "origin", ref], GH_MS);
    // "<commit>\trefs/heads/<branch>", or nothing when it's gone. A branch
    // that couldn't be looked at is left alone.
    const onOrigin = listed.ok ? (listed.out.split("\t")[0]?.trim() ?? "") : null;
    const moved = onOrigin !== null && onOrigin !== "" && onOrigin !== request.head;
    const comment = moved
      ? `${request.comment}\n\nThe branch \`${request.branch}\` here has commits that weren't merged, such as a committed suggestion. Skelcrew left it in place, so they aren't lost.`
      : request.comment;

    const closed = await this.gh(
      ["pr", "close", String(request.number), "--repo", repo.value, "--comment", comment],
      "gh couldn't close the pull request",
    );
    if (!closed.ok) return closed;
    if (onOrigin === request.head) {
      // Not a forced push. For a delete, --force-with-lease only adds a
      // check: git refuses unless the branch on origin is still at the
      // commit Skelcrew pushed. So a commit added since, even in the moment
      // since the look above, is never deleted.
      await this.run(
        ["git", "push", `--force-with-lease=${ref}:${request.head}`, "origin", `:${ref}`],
        PUSH_MS,
      );
    }
    return { ok: true, value: null };
  }

  // The GitHub repository behind origin, such as "owner/repo". Skelcrew
  // pushes to origin, so gh must look there too. Left to itself, gh picks
  // an `upstream` remote first, which on a fork is someone else's project.
  private async originRepo(): Promise<Done<string>> {
    const origin = await this.run(["git", "remote", "get-url", "origin"], LOCAL_MS);
    if (!origin.ok) {
      return origin.why === "failed"
        ? { ok: false, message: "This repository has no `origin` remote." }
        : { ok: false, message: `git couldn't read the \`origin\` remote: ${failed(origin)}` };
    }
    const url = origin.out.trim();
    const repo = githubRepo(url);
    if (repo === null) {
      return { ok: false, message: `The \`origin\` remote isn't on GitHub: ${url}` };
    }
    return { ok: true, value: repo };
  }

  private async gh(args: string[], failure: string, stdin?: string): Promise<Done<string>> {
    const ran = await this.run(["gh", ...args], GH_MS, stdin);
    if (ran.ok) return { ok: true, value: ran.out };
    switch (ran.why) {
      case "missing":
        return { ok: false, message: "GitHub's `gh` command isn't installed." };
      case "timedOut": {
        const call = ["gh", ...args.slice(0, 2)].join(" ");
        return {
          ok: false,
          message: `\`${call}\` didn't answer within ${duration(GH_MS)}, so Skelcrew stopped it.`,
        };
      }
      case "failed":
        if (ran.exitCode === NEEDS_LOGIN) {
          return { ok: false, message: "`gh` isn't logged in to GitHub. Run `gh auth login`." };
        }
        return { ok: false, message: `${failure}: ${ran.err}` };
    }
  }

  private async run(command: string[], timeoutMs: number, stdin?: string): Promise<Outcome> {
    const options: RunOptions = { cwd: this.repo, timeoutMs };
    if (stdin !== undefined) options.stdin = stdin;
    const ran = await this.runner(command, options);
    if ("missing" in ran) return { ok: false, why: "missing" };
    if ("timedOut" in ran) return { ok: false, why: "timedOut", timeoutMs };
    if (ran.exitCode === 0) return { ok: true, out: ran.stdout };
    const err = ran.stderr.trim() || `exit code ${ran.exitCode}`;
    return { ok: false, why: "failed", exitCode: ran.exitCode, err };
  }
}

type Outcome =
  | { ok: true; out: string }
  | { ok: false; why: "missing" }
  | { ok: false; why: "timedOut"; timeoutMs: number }
  | { ok: false; why: "failed"; exitCode: number; err: string };

// Why a git call failed, in words.
function failed(outcome: Exclude<Outcome, { ok: true }>): string {
  switch (outcome.why) {
    case "missing":
      return "git isn't installed.";
    case "timedOut":
      return `it didn't finish within ${duration(outcome.timeoutMs)}, so Skelcrew stopped it.`;
    case "failed":
      return outcome.err;
  }
}

// A time limit in words, such as "1 minute" or "10 seconds".
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

// The ways a GitHub remote is written: git@github.com:owner/repo.git,
// ssh://git@github.com/owner/repo.git and https://github.com/owner/repo,
// each with or without ".git".
const githubRemotes = [
  /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
  /^(?:https|ssh):\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
];

function githubRepo(url: string): string | null {
  for (const pattern of githubRemotes) {
    const [, owner, name] = pattern.exec(url) ?? [];
    if (owner !== undefined && name !== undefined) return `${owner}/${name}`;
  }
  return null;
}

function parseList(out: string): Done<PullRequest | null> {
  let data: unknown;
  try {
    data = JSON.parse(out);
  } catch {
    data = out;
  }
  const parsed = listed.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      message: `gh's list of pull requests didn't make sense: ${z.prettifyError(parsed.error)}`,
    };
  }
  const own = parsed.data.find((found) => !found.isCrossRepository);
  return { ok: true, value: own === undefined ? null : { number: own.number, url: own.url } };
}

function parseCreated(out: string): Done<PullRequest> {
  const last = out.trim().split("\n").at(-1)?.trim() ?? "";
  const match = createdLink.exec(last);
  const url = match?.[1];
  const number = z.coerce.number().int().positive().safeParse(match?.[2]);
  if (url === undefined || !number.success) {
    return {
      ok: false,
      message: `gh opened something, but didn't give a pull request's link. It said: ${out.trim()}`,
    };
  }
  return { ok: true, value: { number: number.data, url } };
}

// Runs a program with no terminal to ask on. git won't ask for a
// password, ssh won't ask for a passphrase or about a new host, and gh
// won't prompt or check for updates. A program still running at its time
// limit is killed.
// Whether git has an ssh command set for the folder, in any of its config
// files. Any failure, such as no git, counts as none.
function hasSshCommand(cwd: string): boolean {
  try {
    const ran = Bun.spawnSync(["git", "config", "--get", "core.sshCommand"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    return ran.exitCode === 0 && ran.stdout.toString().trim() !== "";
  } catch {
    return false;
  }
}

export async function runProgram(command: string[], options: RunOptions): Promise<Ran> {
  // Your own ssh command, such as one that picks a key or goes through a
  // password manager's agent, is kept: in the environment, or as the
  // repository's core.sshCommand. The time limit still stops it if it waits
  // for an answer.
  const ownSsh =
    process.env.GIT_SSH_COMMAND !== undefined ||
    process.env.GIT_SSH !== undefined ||
    hasSshCommand(options.cwd);
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    child = Bun.spawn(command, {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...(ownSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
      },
    });
  } catch {
    // Starting a program that isn't installed throws.
    return { missing: true };
  }
  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  await child.stdin.end();
  const finished = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.timeoutMs);
  });
  const done = await Promise.race([finished, late]);
  clearTimeout(timer);
  if (done === null) {
    // Not waiting for the output: a program it started, such as ssh or a
    // hook's, may keep it open after this one is killed.
    child.kill("SIGKILL");
    finished.catch(() => {});
    return { timedOut: true };
  }
  const [stdout, stderr, exitCode] = done;
  return { exitCode, stdout, stderr };
}
