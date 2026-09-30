// The GitHub plugin against recorded replies from git and gh. No test here
// runs gh or reaches GitHub: a scripted runner answers each command the way
// the real one did, and remembers what was asked.

import { describe, expect, test } from "bun:test";
import { CommitSha } from "../../core/ids";
import { GitHub, type Ran } from "./github";

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
  openPullRequest: ok('[{"number":40,"url":"https://github.com/skelcrew/skelcrew/pull/40"}]\n'),
  loggedOut: failed(
    4,
    "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n",
  ),
  created: ok("https://github.com/skelcrew/skelcrew/pull/41\n"),
  pushed: ok(""),
  closed: ok(""),
};

type Call = { command: string[]; stdin: string | undefined };

// Answers each command by the first entry whose words start it, such as
// "gh pr list". A command nobody scripted fails the test.
function scripted(answers: [string, Ran][]) {
  const calls: Call[] = [];
  const github = new GitHub("/repo", async (command, options) => {
    calls.push({ command, stdin: options.stdin });
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
      "--head",
      "task/12-csv-export",
      "--state",
      "open",
      "--json",
      "number,url",
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

describe("closing a pull request", () => {
  const close = { number: 41, branch: "task/12-csv-export", comment: "Merged as abc1234." };

  test("closes it with the comment, then deletes the pushed branch on origin", async () => {
    const { github, calls } = scripted([
      ["gh pr close", recorded.closed],
      ["git push origin --delete", recorded.pushed],
    ]);
    expect(await github.close(close)).toEqual({ ok: true, value: null });
    expect(calls.map((call) => call.command)).toEqual([
      ["gh", "pr", "close", "41", "--comment", "Merged as abc1234."],
      ["git", "push", "origin", "--delete", "task/12-csv-export"],
    ]);
  });

  test("still counts as closed when the pushed branch is already gone", async () => {
    const { github } = scripted([
      ["gh pr close", recorded.closed],
      [
        "git push origin --delete",
        failed(1, "error: unable to delete 'x': remote ref does not exist"),
      ],
    ]);
    expect(await github.close(close)).toEqual({ ok: true, value: null });
  });

  test("says why gh couldn't close it, and deletes nothing", async () => {
    const { github, ran } = scripted([["gh pr close", recorded.loggedOut]]);
    expect(await github.close(close)).toEqual({
      ok: false,
      message: "`gh` isn't logged in to GitHub. Run `gh auth login`.",
    });
    expect(ran("git push")).toHaveLength(0);
  });
});
