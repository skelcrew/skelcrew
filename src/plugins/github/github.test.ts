// The GitHub plugin against recorded replies from git and gh. No test here
// runs gh or reaches GitHub: a scripted runner answers each command the way
// the real one did, and remembers what was asked.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitSha } from "../../core/ids";
import { git, makeRepo } from "../version-control.contract";
import { GitHub, type Ran, runProgram } from "./github";

const head = CommitSha.parse("0123456789abcdef0123456789abcdef01234567");
const show = {
  branch: "task/12-csv-export",
  head,
  base: "main",
  title: "#12 CSV export",
  body: "The body.",
};

const ok = (stdout = ""): Ran => ({ exitCode: 0, stdout, stderr: "" });
const failed = (exitCode: number, stderr: string): Ran => ({ exitCode, stdout: "", stderr });

// Recorded with gh 2.86.0.
const recorded = {
  origin: ok("git@github.com:skelcrew/skelcrew.git\n"),
  noOrigin: failed(2, "error: No such remote 'origin'\n"),
  noOpenPullRequest: ok("[]\n"),
  openPullRequest: ok(
    '[{"headRepositoryOwner":{"id":"O_kgDOE3QLJg","login":"skelcrew"},"isCrossRepository":false,"number":40,"url":"https://github.com/skelcrew/skelcrew/pull/40"}]\n',
  ),
  // Someone's fork has a branch with the same name, and a pull request
  // from it into this repository.
  strangersPullRequest: ok(
    '[{"headRepositoryOwner":{"id":"MDQ6VXNlcjE=","login":"stranger"},"isCrossRepository":true,"number":39,"url":"https://github.com/skelcrew/skelcrew/pull/39"}]\n',
  ),
  loggedOut: failed(
    4,
    "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n",
  ),
  created: ok("https://github.com/skelcrew/skelcrew/pull/41\n"),
  pushed: ok(""),
  closed: ok(""),
};

type Call = { command: string[]; stdin: string | undefined; timeoutMs: number };

// Answers each command by the first entry whose words start it, such as
// "gh pr list". A command nobody scripted fails the test.
function scripted(answers: [string, Ran][]) {
  const calls: Call[] = [];
  const github = new GitHub("/repo", async (command, options) => {
    calls.push({ command, stdin: options.stdin, timeoutMs: options.timeoutMs });
    const line = command.join(" ");
    const found = answers.find(([start]) => line.startsWith(start));
    if (found === undefined) throw new Error(`Nothing scripted for: ${line}`);
    return found[1];
  });
  const ran = (start: string) => calls.filter((call) => call.command.join(" ").startsWith(start));
  return { github, calls, ran };
}

describe("showing a branch as a pull request", () => {
  test("opens a draft pull request when the branch has none, after pushing exactly the head", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", recorded.noOpenPullRequest],
      ["git push", recorded.pushed],
      ["gh pr create", recorded.created],
    ]);
    expect(await github.show(show)).toEqual({
      ok: true,
      value: { number: 41, url: "https://github.com/skelcrew/skelcrew/pull/41" },
    });
    expect(ran("gh pr list")[0]?.command).toEqual([
      "gh",
      "pr",
      "list",
      "--repo",
      "skelcrew/skelcrew",
      "--head",
      "task/12-csv-export",
      "--state",
      "open",
      "--json",
      "number,url,isCrossRepository",
    ]);
    expect(ran("git push")[0]?.command).toEqual([
      "git",
      "push",
      "origin",
      `${head}:refs/heads/task/12-csv-export`,
    ]);
    const create = ran("gh pr create")[0];
    expect(create?.command).toEqual([
      "gh",
      "pr",
      "create",
      "--repo",
      "skelcrew/skelcrew",
      "--draft",
      "--base",
      "main",
      "--head",
      "task/12-csv-export",
      "--title",
      "#12 CSV export",
      "--body-file",
      "-",
    ]);
    expect(create?.stdin).toBe("The body.");
  });

  // Every Skelcrew branch is named like task/12-..., so a stranger's fork
  // can have one too. Their pull request is never taken as Skelcrew's.
  test("ignores a pull request from someone's fork with the same branch name", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", recorded.strangersPullRequest],
      ["git push", recorded.pushed],
      ["gh pr create", recorded.created],
    ]);
    expect(await github.show(show)).toEqual({
      ok: true,
      value: { number: 41, url: "https://github.com/skelcrew/skelcrew/pull/41" },
    });
    expect(ran("gh pr create")).toHaveLength(1);
  });

  test("picks its own pull request when a fork's comes first in the list", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      [
        "gh pr list",
        ok(
          '[{"isCrossRepository":true,"number":39,"url":"https://github.com/skelcrew/skelcrew/pull/39"},{"isCrossRepository":false,"number":40,"url":"https://github.com/skelcrew/skelcrew/pull/40"}]',
        ),
      ],
      ["git push", recorded.pushed],
    ]);
    expect(await github.show(show)).toEqual({
      ok: true,
      value: { number: 40, url: "https://github.com/skelcrew/skelcrew/pull/40" },
    });
    expect(ran("gh pr create")).toHaveLength(0);
  });

  test("refuses a list that doesn't say which pull requests come from a fork", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", ok('[{"number":40,"url":"https://github.com/skelcrew/skelcrew/pull/40"}]')],
    ]);
    const shown = await github.show(show);
    expect(shown.ok).toBe(false);
    expect(!shown.ok && shown.message).toStartWith("gh's list of pull requests didn't make sense:");
    expect(ran("git push")).toHaveLength(0);
  });

  test("gives back the open pull request the branch already has, and opens no second one", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", recorded.openPullRequest],
      ["git push", recorded.pushed],
    ]);
    expect(await github.show(show)).toEqual({
      ok: true,
      value: { number: 40, url: "https://github.com/skelcrew/skelcrew/pull/40" },
    });
    expect(ran("git push")).toHaveLength(1);
    expect(ran("gh pr create")).toHaveLength(0);
  });

  test("says so when the repository has no origin remote, and runs neither gh nor a push", async () => {
    const { github, ran } = scripted([["git remote get-url origin", recorded.noOrigin]]);
    expect(await github.show(show)).toEqual({
      ok: false,
      message: "This repository has no `origin` remote.",
    });
    expect(ran("gh")).toHaveLength(0);
    expect(ran("git push")).toHaveLength(0);
  });

  // On a fork, origin is your fork, and gh on its own would pick the
  // project it came from. So every gh call names the repository behind
  // origin.
  const origins: [string, string][] = [
    ["git@github.com:owner/repo.git", "owner/repo"],
    ["git@github.com:owner/repo", "owner/repo"],
    ["https://github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["https://github.com/owner/repo/", "owner/repo"],
    ["ssh://git@github.com/owner/my.repo.git", "owner/my.repo"],
  ];
  for (const [url, repo] of origins) {
    test(`asks gh about the repository behind origin ${url}`, async () => {
      const { github, calls } = scripted([
        ["git remote get-url origin", ok(`${url}\n`)],
        ["gh pr list", recorded.noOpenPullRequest],
        ["git push", recorded.pushed],
        ["gh pr create", recorded.created],
      ]);
      expect((await github.show(show)).ok).toBe(true);
      const gh = calls.filter((call) => call.command[0] === "gh");
      expect(gh).toHaveLength(2);
      for (const call of gh) expect(call.command.slice(3, 5)).toEqual(["--repo", repo]);
    });
  }

  test("says so when origin isn't on GitHub, and runs neither gh nor a push", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", ok("git@gitlab.com:owner/repo.git\n")],
    ]);
    expect(await github.show(show)).toEqual({
      ok: false,
      message: "The `origin` remote isn't on GitHub: git@gitlab.com:owner/repo.git",
    });
    expect(ran("gh")).toHaveLength(0);
    expect(ran("git push")).toHaveLength(0);
  });

  test("says so when gh isn't installed, and pushes nothing", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh", { missing: true }],
    ]);
    expect(await github.show(show)).toEqual({
      ok: false,
      message: "GitHub's `gh` command isn't installed.",
    });
    expect(ran("git push")).toHaveLength(0);
  });

  test("says so when gh isn't logged in, and pushes nothing", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", recorded.loggedOut],
    ]);
    expect(await github.show(show)).toEqual({
      ok: false,
      message: "`gh` isn't logged in to GitHub. Run `gh auth login`.",
    });
    expect(ran("git push")).toHaveLength(0);
  });

  test("says why a push failed, and opens nothing", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", recorded.noOpenPullRequest],
      ["git push", failed(1, " ! [rejected]        (non-fast-forward)\n")],
    ]);
    expect(await github.show(show)).toEqual({
      ok: false,
      message: "git couldn't push the branch: ! [rejected]        (non-fast-forward)",
    });
    expect(ran("gh pr create")).toHaveLength(0);
  });

  test("refuses a list from gh that isn't the shape it asked for", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", ok('[{"number":"forty"}]')],
    ]);
    const shown = await github.show(show);
    expect(shown.ok).toBe(false);
    expect(!shown.ok && shown.message).toStartWith("gh's list of pull requests didn't make sense:");
    expect(ran("git push")).toHaveLength(0);
  });

  test("refuses an answer from gh pr create that isn't a pull request's link", async () => {
    const { github } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", recorded.noOpenPullRequest],
      ["git push", recorded.pushed],
      ["gh pr create", ok("Warning: 1 uncommitted change\n")],
    ]);
    expect(await github.show(show)).toEqual({
      ok: false,
      message:
        "gh opened something, but didn't give a pull request's link. It said: Warning: 1 uncommitted change",
    });
  });

  test("says why gh couldn't open the pull request", async () => {
    const { github } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", recorded.noOpenPullRequest],
      ["git push", recorded.pushed],
      ["gh pr create", failed(1, "GraphQL: Head sha can't be blank (createPullRequest)\n")],
    ]);
    expect(await github.show(show)).toEqual({
      ok: false,
      message:
        "gh couldn't open the pull request: GraphQL: Head sha can't be blank (createPullRequest)",
    });
  });
});

// Closing, with real git. A local bare repository stands in for GitHub as
// origin, and gh is scripted. Only reading origin's URL is scripted too, so
// Skelcrew still sees a GitHub repository.
describe("closing a pull request", () => {
  const branch = "task/12-csv-export";
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // A repository whose origin is a bare repository, with the task's branch
  // pushed there. Gives back the pushed commit.
  async function pushedBranch(whileClosing: () => Promise<void> = async () => {}) {
    const repo = await makeRepo();
    const bare = mkdtempSync(join(tmpdir(), "skelcrew-origin-"));
    dirs.push(repo.dir, bare);
    await git(bare, "init", "-q", "--bare");
    await git(repo.dir, "remote", "add", "origin", bare);
    const pushed = CommitSha.parse(await git(repo.dir, "rev-parse", "HEAD"));
    await git(repo.dir, "push", "-q", "origin", `${pushed}:refs/heads/${branch}`);
    const calls: Call[] = [];
    const github = new GitHub(repo.dir, async (command, options) => {
      calls.push({ command, stdin: options.stdin, timeoutMs: options.timeoutMs });
      const line = command.join(" ");
      if (line === "git remote get-url origin") return recorded.origin;
      if (line.startsWith("gh pr close")) {
        await whileClosing();
        return recorded.closed;
      }
      if (command[0] === "git") return runProgram(command, options);
      throw new Error(`Nothing scripted for: ${line}`);
    });
    const onOrigin = async () =>
      (await git(bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`)) || null;
    const comment = () => calls.find((call) => call.command[1] === "pr")?.command.at(-1);
    return { repo, pushed, github, onOrigin, comment };
  }

  test("closes it with the comment, then deletes the branch it pushed", async () => {
    const { pushed, github, onOrigin, comment } = await pushedBranch();
    const closed = await github.close({ number: 41, branch, head: pushed, comment: "Merged." });
    expect(closed).toEqual({ ok: true, value: null });
    expect(comment()).toBe("Merged.");
    expect(await onOrigin()).toBeNull();
  });

  // For example, a reviewer used "Commit suggestion" on the draft. approve
  // merged only your local branch, so that commit is only on GitHub.
  test("keeps the branch when it has commits Skelcrew didn't push, and says so", async () => {
    const { repo, pushed, github, onOrigin, comment } = await pushedBranch();
    await git(repo.dir, "commit", "-q", "--allow-empty", "-m", "Suggestion from review");
    const suggestion = await git(repo.dir, "rev-parse", "HEAD");
    await git(repo.dir, "push", "-q", "origin", `${suggestion}:refs/heads/${branch}`);

    const closed = await github.close({ number: 41, branch, head: pushed, comment: "Merged." });
    expect(closed).toEqual({ ok: true, value: null });
    expect(await onOrigin()).toBe(suggestion);
    expect(comment()).toBe(
      "Merged.\n\nThe branch `task/12-csv-export` here has commits that weren't merged, such as a committed suggestion. Skelcrew left it in place, so they aren't lost.",
    );
  });

  // The suggestion lands after Skelcrew looked at the branch, but before
  // it deletes it. git itself refuses the delete.
  test("keeps the branch when a commit lands on it while the pull request closes", async () => {
    let suggestion = "";
    let repoDir = "";
    const { pushed, github, onOrigin } = await pushedBranch(async () => {
      await git(repoDir, "commit", "-q", "--allow-empty", "-m", "Suggestion from review");
      suggestion = await git(repoDir, "rev-parse", "HEAD");
      await git(repoDir, "push", "-q", "origin", `${suggestion}:refs/heads/${branch}`);
    }).then((made) => {
      repoDir = made.repo.dir;
      return made;
    });
    const closed = await github.close({ number: 41, branch, head: pushed, comment: "Merged." });
    expect(closed).toEqual({ ok: true, value: null });
    expect(suggestion).not.toBe("");
    expect(await onOrigin()).toBe(suggestion);
  });

  test("still counts as closed when the pushed branch is already gone", async () => {
    const { repo, pushed, github, onOrigin, comment } = await pushedBranch();
    await git(repo.dir, "push", "-q", "origin", `:refs/heads/${branch}`);
    const closed = await github.close({ number: 41, branch, head: pushed, comment: "Merged." });
    expect(closed).toEqual({ ok: true, value: null });
    expect(comment()).toBe("Merged.");
    expect(await onOrigin()).toBeNull();
  });

  test("says why gh couldn't close it, and deletes nothing", async () => {
    const close = { number: 41, branch, head, comment: "Merged." };
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["git ls-remote", ok(`${head}\trefs/heads/${branch}\n`)],
      ["gh pr close", recorded.loggedOut],
    ]);
    expect(await github.close(close)).toEqual({
      ok: false,
      message: "`gh` isn't logged in to GitHub. Run `gh auth login`.",
    });
    expect(ran("git push")).toHaveLength(0);
  });
});

// A call that never answers would stop all pull-request work until the
// daemon restarts. So each call has a time limit, and status says which
// one ran out.
describe("time limits", () => {
  test("gives each call a time limit: three minutes for a push, one for gh", async () => {
    const { github, calls } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", recorded.noOpenPullRequest],
      ["git push", recorded.pushed],
      ["gh pr create", recorded.created],
    ]);
    await github.show(show);
    expect(calls.map((call) => [call.command.slice(0, 3).join(" "), call.timeoutMs])).toEqual([
      ["git remote get-url", 10_000],
      ["gh pr list", 60_000],
      ["git push origin", 180_000],
      ["gh pr create", 60_000],
    ]);
  });

  test("says so when gh didn't answer in time, and pushes nothing", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", { timedOut: true }],
    ]);
    expect(await github.show(show)).toEqual({
      ok: false,
      message: "`gh pr list` didn't answer within 1 minute, so Skelcrew stopped it.",
    });
    expect(ran("git push")).toHaveLength(0);
  });

  test("says so when the push didn't finish in time, and opens nothing", async () => {
    const { github, ran } = scripted([
      ["git remote get-url origin", recorded.origin],
      ["gh pr list", recorded.noOpenPullRequest],
      ["git push", { timedOut: true }],
    ]);
    expect(await github.show(show)).toEqual({
      ok: false,
      message:
        "git couldn't push the branch: it didn't finish within 3 minutes, so Skelcrew stopped it.",
    });
    expect(ran("gh pr create")).toHaveLength(0);
  });
});

// The real runner, on harmless local programs. Nothing here runs git or gh.
describe("running a program", () => {
  test("stops a program that runs past its time limit", async () => {
    const started = Date.now();
    expect(await runProgram(["sleep", "10"], { cwd: "/", timeoutMs: 100 })).toEqual({
      timedOut: true,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // git starts ssh, and a hook may start more. One of them can keep the
  // output open after the program itself is stopped.
  test("doesn't wait for a program it started that keeps the output open", async () => {
    const started = Date.now();
    const ran = await runProgram(["sh", "-c", "sleep 10 & sleep 10"], {
      cwd: "/",
      timeoutMs: 100,
    });
    expect(ran).toEqual({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("gives back the output of a program that finishes in time", async () => {
    const ran = await runProgram(["sh", "-c", "echo out; echo err >&2; exit 3"], {
      cwd: "/",
      timeoutMs: 5_000,
    });
    expect(ran).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  // ssh would otherwise wait for a passphrase or a host key answer that
  // nobody can give, since the daemon has no terminal.
  test("tells git and ssh never to ask for anything", async () => {
    const saved = { command: process.env.GIT_SSH_COMMAND, ssh: process.env.GIT_SSH };
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    try {
      const ran = await runProgram(
        ["sh", "-c", 'printf "%s|%s" "$GIT_SSH_COMMAND" "$GIT_TERMINAL_PROMPT"'],
        { cwd: "/", timeoutMs: 5_000 },
      );
      expect(ran).toEqual({ exitCode: 0, stdout: "ssh -o BatchMode=yes|0", stderr: "" });
    } finally {
      if (saved.command !== undefined) process.env.GIT_SSH_COMMAND = saved.command;
      if (saved.ssh !== undefined) process.env.GIT_SSH = saved.ssh;
    }
  });

  // Your own ssh command, such as one that picks a key, is kept. The time
  // limit still stops it if it waits for an answer.
  test("keeps an ssh command you set yourself", async () => {
    const saved = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "ssh -i ~/.ssh/work";
    try {
      const ran = await runProgram(["sh", "-c", 'printf "%s" "$GIT_SSH_COMMAND"'], {
        cwd: "/",
        timeoutMs: 5_000,
      });
      expect(ran).toEqual({ exitCode: 0, stdout: "ssh -i ~/.ssh/work", stderr: "" });
    } finally {
      if (saved === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = saved;
    }
  });

  // Decided with the developer: a repository's own ssh command, such as
  // one that goes through a password manager's ssh agent, is kept too.
  // Skelcrew's setting would otherwise replace it.
  test("keeps the repository's core.sshCommand", async () => {
    const repo = await makeRepo();
    const saved = { command: process.env.GIT_SSH_COMMAND, ssh: process.env.GIT_SSH };
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    try {
      await git(repo.dir, "config", "core.sshCommand", "ssh -i ~/.ssh/work");
      const ran = await runProgram(["sh", "-c", 'printf "%s" "$GIT_SSH_COMMAND"'], {
        cwd: repo.dir,
        timeoutMs: 5_000,
      });
      expect(ran).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    } finally {
      if (saved.command !== undefined) process.env.GIT_SSH_COMMAND = saved.command;
      if (saved.ssh !== undefined) process.env.GIT_SSH = saved.ssh;
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});
