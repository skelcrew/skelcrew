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

// What a program did: its exit code and output, or that it isn't
// installed.
export type Ran = { exitCode: number; stdout: string; stderr: string } | { missing: true };
export type Runner = (command: string[], options: { cwd: string; stdin?: string }) => Promise<Ran>;

// gh exits with 4 when it needs a login.
const NEEDS_LOGIN = 4;

// `gh pr list --json number,url`: a list, empty when there is none.
const listed = z.array(z.object({ number: z.number().int().positive(), url: z.url() }));

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
        "number,url",
      ],
      "gh couldn't list the pull requests",
    );
    if (!list.ok) return list;
    const found = parseList(list.value);
    if (!found.ok) return found;

    // Never forced: a branch that moved on GitHub is refused, not replaced.
    const pushed = await this.run([
      "git",
      "push",
      "origin",
      `${request.head}:refs/heads/${request.branch}`,
    ]);
    if (!pushed.ok) {
      const why = pushed.missing ? "git isn't installed." : pushed.err;
      return { ok: false, message: `git couldn't push the branch: ${why}` };
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

  // Deleting the pushed branch is tidying up: the pull request is already
  // closed, and the local branch keeps the work. So a branch that can't be
  // deleted, such as one already gone, doesn't count as a failure.
  // `gh pr close --delete-branch` isn't used, since it deletes the local
  // branch too.
  async close(request: CloseRequest): Promise<Done<null>> {
    const repo = await this.originRepo();
    if (!repo.ok) return repo;
    const closed = await this.gh(
      ["pr", "close", String(request.number), "--repo", repo.value, "--comment", request.comment],
      "gh couldn't close the pull request",
    );
    if (!closed.ok) return closed;
    await this.run(["git", "push", "origin", "--delete", request.branch]);
    return { ok: true, value: null };
  }

  // The GitHub repository behind origin, such as "owner/repo". Skelcrew
  // pushes to origin, so gh must look there too. Left to itself, gh picks
  // an `upstream` remote first, which on a fork is someone else's project.
  private async originRepo(): Promise<Done<string>> {
    const origin = await this.run(["git", "remote", "get-url", "origin"]);
    if (!origin.ok) {
      return origin.missing
        ? { ok: false, message: "git isn't installed." }
        : { ok: false, message: "This repository has no `origin` remote." };
    }
    const url = origin.out.trim();
    const repo = githubRepo(url);
    if (repo === null)
      return { ok: false, message: `The \`origin\` remote isn't on GitHub: ${url}` };
    return { ok: true, value: repo };
  }

  private async gh(args: string[], failure: string, stdin?: string): Promise<Done<string>> {
    const ran = await this.run(["gh", ...args], stdin);
    if (ran.ok) return { ok: true, value: ran.out };
    if (ran.missing) return { ok: false, message: "GitHub's `gh` command isn't installed." };
    if (ran.exitCode === NEEDS_LOGIN) {
      return { ok: false, message: "`gh` isn't logged in to GitHub. Run `gh auth login`." };
    }
    return { ok: false, message: `${failure}: ${ran.err}` };
  }

  private async run(
    command: string[],
    stdin?: string,
  ): Promise<
    | { ok: true; out: string }
    | { ok: false; missing: true }
    | { ok: false; missing: false; exitCode: number; err: string }
  > {
    const options: { cwd: string; stdin?: string } = { cwd: this.repo };
    if (stdin !== undefined) options.stdin = stdin;
    const ran = await this.runner(command, options);
    if ("missing" in ran) return { ok: false, missing: true };
    if (ran.exitCode === 0) return { ok: true, out: ran.stdout };
    const err = ran.stderr.trim() || `exit code ${ran.exitCode}`;
    return { ok: false, missing: false, exitCode: ran.exitCode, err };
  }
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
  const [first] = parsed.data;
  return { ok: true, value: first === undefined ? null : first };
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
// password, and gh won't prompt or check for updates.
async function runProgram(
  command: string[],
  options: { cwd: string; stdin?: string },
): Promise<Ran> {
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    child = Bun.spawn(command, {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}
