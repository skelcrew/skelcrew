// sc submit and the build ⇄ review loop, against a running daemon: a shell script stands in
// for the builder and runs sc submit like an agent would, another stands in for Codex, a
// fake plugin for the repository's tracker and forge, and a folder of bare repositories for
// what Skelcrew pushes to.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answer,
  asked,
  git,
  insideSandbox,
  prItem,
  read,
  runSkelInTerminal,
  source,
  taskItem,
} from "./harness.ts";
import {
  addApp,
  builder,
  codexHome,
  copiedPr,
  data,
  edits,
  env,
  fakeClaude,
  finished,
  github,
  home,
  longWait,
  morePolls,
  opened,
  plugin,
  pushed,
  pushedRound,
  reviews,
  serve,
  setUp,
  shown,
  skel,
  socket,
  startApp12,
  startNoReview,
  statuses,
  tearDown,
  thread,
  typedMessages,
  until,
  untilCloned,
  verdict,
} from "./submit.ts";

beforeEach(setUp);
afterEach(tearDown);

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("sc submit", () => {
  test("each review's round, reviewer, verdict and first line go in the thread's log, and the task's title too", async () => {
    addApp();
    verdict(1, "changes", "\n  The export has no test.\n\nMore detail here.");
    verdict(2, "approve", "Ready to merge.");
    await startApp12();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"), 30_000);
    const lines = read(join(data(), "threads", "app-12.log"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const said = lines.filter((line) => line.why?.includes("in round 1"))[0];
    expect(said).toMatchObject({
      review_round: 1,
      reviewed_by: "codex",
      verdict: "changes",
      review_line: "The export has no test.",
      // The reviewer's findings are trimmed as Skelcrew reads them.
      review_findings: ["The export has no test.\n\nMore detail here."],
    });
    expect(lines.at(-1)).toMatchObject({
      title: "Add export",
      review_round: 2,
      reviewed_by: "codex",
      verdict: "approve",
      review_line: "Ready to merge.",
      review_findings: [],
    });
    // The approved commit is saved with its review, so the list can merge it asking git nothing.
    expect(lines.at(-1)?.reviewed_commit).toBe(pushed());
    expect(lines.some((line) => line.reviewer === "codex" && line.submitting !== null)).toBe(true);
  });

  // The list shows what a review found from what Skelcrew saved, so a review the forge refused
  // to take still shows its findings there.
  test("a review's findings are saved though the forge refuses to post it", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.", ["The export has no test.", "Name it."]);
    writeFileSync(join(plugin, "fail-review"), "the forge is down");
    await startApp12();
    const log = () =>
      read(join(data(), "threads", "app-12.log"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    await until(() => log().some((line) => line.why?.includes("the review said")), 30_000);
    // The post was asked for and refused, and the findings were saved all the same.
    await until(() => asked(plugin).some((question) => question.ask === "review"), 30_000);
    expect(log().at(-1)?.review_findings).toEqual(["The export has no test.", "Name it."]);
  });

  // The lead's message changes the task after the thread started, such as a design you agreed
  // to, so the reviewer judges the round by it rather than asking to undo it. The line that
  // closes the issue is saved as the task starts, so the PR still closes it though Skelcrew's
  // copy lost the issue before the first submit, such as after the tracker changed.
  test("the reviewer gets the lead's messages to the builder after the task, and the PR closes the issue the copy lost", async () => {
    fakeClaude(false);
    addApp();
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => read(join(builder(), "args")) !== "", 30_000);
    // The tracker no longer gives the issue, and the copy has lost it.
    answer(plugin, "changed", { items: [], next: null });
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    db.run("DELETE FROM items");
    db.close();
    const short = new Bun.CryptoHasher("sha256").update("simon/app").digest("hex").slice(0, 16);
    const leadSocket = join(home, "run", "skelcrew", "leads", short, "skelcrew.sock");
    await until(() => existsSync(leadSocket));
    // The builder answers the message with its first round.
    const told = await skel(["tell", "app-12", "Keep the CSV export too."], {
      SKELCREW_SANDBOX: "1",
      SKELCREW_SOCKET: leadSocket,
    });
    expect(told.err).toBe("");
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toMatch(
      /# Add export\n\nAs JSON\n\n## Changes to the task from the lead, after the thread started\n\nThese override the task above where they differ\. The latest comes last\.\n\n### .* UTC\n\nKeep the CSV export too\.\n/,
    );
    await until(() => opened() !== undefined);
    expect(opened()?.body).toBe("Round 1\n\nCloses #12");
  }, 60_000);

  test("pushes the round, opens the PR, has it reviewed, types the changes in, and waits on CI once approved", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    verdict(2, "approve", "Ready to merge.");
    await startApp12();
    await until(
      () =>
        finished("success").length === 1 &&
        read(join(data(), "threads", "app-12.log")).includes("waits on CI"),
      30_000,
    );

    expect(read(join(builder(), "submitted"))).toContain("Submitted app-12 for review.");
    expect(pushedRound()).toBe("2");
    const pr = opened();
    expect(pr).toMatchObject({
      branch: "skelcrew/12-add-export",
      base: "main",
      title: "Add export",
    });
    expect(pr?.body).toBe("Round 1\n\nCloses #12");

    const second = pushed();
    const first = git(join(github(), "simon", "app.git"), "rev-parse", `${second}^`);
    expect(statuses().map((s) => [s.sha, s.state])).toEqual([
      [first, "pending"],
      [first, "failure"],
      [second, "pending"],
      [second, "success"],
    ]);
    // The fake forge can't edit, so the second verdict, which differs, is posted anew.
    expect(reviews()).toEqual([
      {
        commit: first,
        verdict: "changes",
        body: "The export has no test.\n\n1. The export has no test.",
      },
      { commit: second, verdict: "approve", body: "Ready to merge." },
    ]);
    expect(shown(asked(plugin).find((q) => q.ask === "review")?.body)).toBe(
      `Round 1 · commit ${first.slice(0, 7)}\n\nThe export has no test.\n\n1. The export has no test.`,
    );
    expect(edits()).toEqual([
      {
        pr: 7,
        id: "1001",
        verdict: "approve",
        body: `Round 2 · commit ${second.slice(0, 7)}\n\nReady to merge.`,
      },
    ]);
    expect(typedMessages()).toBe(1);
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");

    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("Add export");
    // The diff starts where the branch meets main as GitHub has it, which here is main's tip.
    const main = git(join(github(), "simon", "app.git"), "rev-parse", "main");
    expect(prompt).toContain(`git diff ${main}...HEAD`);
    expect(read(join(codexHome(), "sessions", "branches-1"))).toContain("origin/main");

    // Approved, it waits on CI: polling GitHub marks it needs you once every check is green.
    // Each turn ended with a submit, so the builder never waited on you.
    expect(thread()).toMatchObject({
      status: "waiting",
      needs_you: 0,
      rounds: 1,
      pr: 7,
      turn_ended: 0,
    });
    expect(read(join(builder(), "hooks"))).toBe("");
    expect(read(join(data(), "threads", "app-12.log"))).not.toContain("without submitting");
    expect(thread().reviewing).toBeNull();
    // The daemon saves a thread before it appends the thread to its log.
    await until(() => read(join(data(), "threads", "app-12.log")).includes("approved"));
    expect(read(join(data(), "threads", "app-12.log"))).toContain("Round 1");
  }, 60_000);

  // A repository's flow without a review: stage, for changes too small to need one, goes from
  // build straight to CI. Its check says it wasn't reviewed, and the PR stays quiet.
  test("on a flow with no review stage, a submit runs no reviewer, posts nothing on the PR, and waits on CI", async () => {
    addApp({ ".agents/flows/noreview.yaml": "build:\n  role: builder\n" });
    await startNoReview({ every: 1_000 });
    await until(
      () => read(join(data(), "threads", "app-12.log")).includes("so it waits on CI"),
      longWait,
    );
    expect(read(join(data(), "threads", "app-12.log"))).toContain(
      "not reviewed, as its flow has no review stage, so it waits on CI",
    );
    const sha = pushed();
    expect(statuses()).toEqual([
      { sha, state: "pending", description: "waiting for CI's first check" },
      { sha, state: "success", description: "not reviewed: this flow has no review stage" },
    ]);
    expect(opened()).toBeDefined();
    expect(reviews()).toEqual([]);
    expect(edits()).toEqual([]);
    expect(existsSync(join(codexHome(), "sessions", "count"))).toBe(false);
    expect(thread()).toMatchObject({
      flow: "noreview",
      status: "waiting",
      needs_you: 0,
      rounds: 0,
      verdict: "not reviewed",
      review_round: null,
      reviewed_by: null,
      reviewed_commit: sha,
      reviewing: null,
      submitting: null,
    });
    // The flow is fixed once the builder submitted, as in any flow.
    expect((await skel(["start", "app-12", "--flow", "default"])).err).toBe(
      "Skelcrew: app-12 keeps the flow noreview, as its builder has submitted already.\n",
    );
    // There is no review to skip, so a merge skipping it is refused, once the PR's head shows.
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", { branch: "skelcrew/12-add-export", head: sha }),
      ],
      next: null,
    });
    await until(() => copiedPr().includes(sha));
    const skipped = await runSkelInTerminal(
      socket,
      env(),
      ["merge", "--skip-review", "app-12"],
      "without Skelcrew's approval?",
      "y",
    );
    expect(skipped).toContain(
      "app-12's flow has no review stage, so there is no review to skip: merge it with m in the list, or sc merge --when-ready app-12",
    );
    expect(thread().merge_plan).toBeNull();
  }, 90_000);

  // The push went through before Skelcrew's check failed, so the thread says its check failed,
  // never its push. Here no CI shows anywhere, so the submit doesn't wait for a first check.
  test("on a flow with no review stage, a check that can't be set fails the round as a check, not a push", async () => {
    addApp({ ".agents/flows/noreview.yaml": "build:\n  role: builder\n" });
    writeFileSync(join(plugin, "fail-status"), "GitHub is down");
    await startNoReview();
    await until(() => thread().review_failed === 1, longWait);
    expect(thread()).toMatchObject({
      verdict: "not reviewed",
      submitting: null,
      reviewing: pushed(),
      needs_you: 0,
      review_failed: 1,
    });
    // The log line is written just after the thread is saved, so it is waited for too.
    const log = () => read(join(data(), "threads", "app-12.log"));
    await until(() => log().includes("the round failed"), longWait);
    expect(log()).toContain("the round failed");
    // Only the pending check was tried: the round stopped once the forge refused it.
    expect(statuses()).toEqual([
      { sha: pushed(), state: "pending", description: "waiting for CI's first check" },
    ]);
  }, 90_000);

  // The push went through, but the forge couldn't open the PR: the submit failed, as the lead
  // hears with the forge's own words, and no check is set on a commit with no PR.
  test("on a flow with no review stage, a PR the forge can't open fails the submit, with the forge's error", async () => {
    addApp({ ".agents/flows/noreview.yaml": "build:\n  role: builder\n" });
    writeFileSync(join(plugin, "fail-open-pr"), "Base branch was modified");
    await startNoReview();
    await until(() => thread().review_failed === 1, longWait);
    expect(thread()).toMatchObject({
      verdict: "not reviewed",
      submitting: "Round 1",
      pr: null,
      needs_you: 0,
      review_failed: 1,
    });
    expect(read(join(data(), "threads", "app-12.log"))).toContain("Base branch was modified");
    expect(statuses()).toEqual([]);
  }, 90_000);

  // Docs are what such a flow is for, and no reviewer will look at them, so the wait for CI's
  // first check is all that keeps the PR from being ready before CI ran.
  test("on a flow with no review stage, a change to docs alone still waits for CI's first check", async () => {
    addApp({
      ".agents/flows/noreview.yaml": "build:\n  role: builder\n",
      ".github/workflows/ci.yml": "on: pull_request\n",
    });
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "");
    await startNoReview({ env: { SKELCREW_CI_WAIT_MS: "3000" } });
    await until(
      () => read(join(data(), "threads", "app-12.log")).includes("so it waits on CI"),
      longWait,
    );
    expect(read(join(data(), "threads", "app-12.log"))).toContain(
      `waiting for CI's first check on ${pushed()} before marking it not reviewed`,
    );
    expect(existsSync(join(codexHome(), "sessions", "count"))).toBe(false);
  }, 90_000);

  // Ready waits on every check, so CI still running is no reason to ask for changes.
  test("a clean diff while CI runs is approved and counts no round", async () => {
    addApp();
    verdict(1, "approve", "CI pending. I found no code problems.");
    await startApp12();
    await until(() => finished("success").length === 1, 30_000);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(reviews()).toEqual([
      { commit: pushed(), verdict: "approve", body: "CI pending. I found no code problems." },
    ]);
    expect(thread()).toMatchObject({ rounds: 0, verdict: "approve", needs_you: 0 });
    expect(typedMessages()).toBe(0);
  }, 60_000);

  // A review that only waited on CI once asked for changes it couldn't name. That answer is
  // now refused: nothing reaches the PR, and no round counts.
  test("changes with no findings post nothing, count no round, and fail the review", async () => {
    addApp();
    verdict(1, "changes", "CI pending. I found no code problems.", []);
    await startApp12();
    await until(() => finished("failure").length === 1, 30_000);
    expect(finished("failure")[0]?.description).toBe("review failed");
    await until(() => thread().review_failed === 1);
    expect(thread().needs_you).toBe(0);
    expect(reviews()).toEqual([]);
    expect(thread()).toMatchObject({ rounds: 0 });
    expect(typedMessages()).toBe(0);
  }, 60_000);

  // Each round edits the review the first one posted, so the PR shows the latest verdict once.
  test("a second round edits Skelcrew's one review on the PR rather than posting another", async () => {
    addApp();
    answer(plugin, "edit review", { edited: true });
    verdict(1, "changes", "The export has no test.");
    verdict(2, "approve", "Ready to merge.");
    await startApp12();
    await until(() => finished("success").length === 1, 30_000);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(reviews()).toHaveLength(1);
    expect(edits()).toEqual([
      {
        pr: 7,
        id: "1001",
        verdict: "approve",
        body: `Round 2 · commit ${pushed().slice(0, 7)}\n\nReady to merge.`,
      },
    ]);
    expect(read(join(data(), "threads", "app-12.log"))).toContain("edited its review 1001");
    // The PR now shows only round 2, and the log keeps round 1 whole.
    expect(read(join(data(), "threads", "app-12.log"))).toContain(
      "the review said (changes): Round 1 · commit",
    );
    expect(read(join(data(), "threads", "app-12.log"))).toContain("1. The export has no test.");
  }, 60_000);

  // A forge that can't edit gets a new review only when what it says changed, so a round that
  // finds the same problems again adds nothing to the PR.
  test("a forge that can't edit gets no new review when the verdict and findings are the same", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    verdict(2, "changes", "Ran the tests again.", ["The export has no test."]);
    verdict(3, "approve", "Ready to merge.");
    await startApp12();
    await until(() => finished("success").length === 1, 45_000);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(reviews().map((r) => r.verdict)).toEqual(["changes", "approve"]);
    expect(edits()).toHaveLength(2);
    // The builder still hears every round.
    expect(read(join(builder(), "typed"))).toContain("Ran the tests again.");
  }, 90_000);

  // Someone can delete Skelcrew's review from the PR. The next round posts it again, though it
  // says the same, so the PR never goes without one.
  test("a review deleted from the PR is posted again, even when it would say the same", async () => {
    addApp();
    answer(plugin, "edit review", { edited: false, gone: true });
    verdict(1, "changes", "The export has no test.");
    verdict(2, "changes", "Ran the tests again.", ["The export has no test."]);
    verdict(3, "approve", "Ready to merge.");
    await startApp12();
    await until(() => finished("success").length === 1, 45_000);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(reviews().map((r) => r.verdict)).toEqual(["changes", "changes", "approve"]);
    // Each round edits the review the round before posted.
    expect(edits().map((e) => e.id)).toEqual(["1001", "1002"]);
  }, 90_000);

  // So it is always clear on the forge whether you or Skelcrew wrote a commit.
  test("commits are authored by the forge's bot, with you as co-author", async () => {
    addApp();
    const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("UPDATE repositories SET author = 'skelcrew[bot] <1+skelcrew[bot]@users.noreply.github.com>'");`;
    expect(Bun.spawnSync([process.execPath, "-e", code], { env: env() }).success).toBe(true);
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => finished("success").length === 1, 30_000);
    const bare = join(github(), "simon", "app.git");
    expect(git(bare, "log", "-1", "--format=%an <%ae>", "skelcrew/12-add-export")).toBe(
      "skelcrew[bot] <1+skelcrew[bot]@users.noreply.github.com>",
    );
    expect(git(bare, "log", "-1", "--format=%B", "skelcrew/12-add-export")).toContain(
      "Co-authored-by: Simon <simon@example.com>",
    );
  }, 60_000);

  // CI runs the whole test suite once per commit, so the reviewer leaves it to CI. The PR's own
  // check on its commit shows CI runs on it, even on a repository's first PR.
  test("once CI shows a check on the PR's commit, the reviewer reads CI's result rather than running the suite", async () => {
    addApp({ ".github/workflows/ci.yml": "on: pull_request\n" });
    verdict(1, "approve", "Ready to merge.");
    // The check shows at the next poll.
    await startApp12({ every: 1_000 });
    await until(() => opened() !== undefined, 30_000);
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          checks: [{ name: "test", id: "900", state: "running" }],
        }),
      ],
      next: null,
    });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain(
      "CI runs the whole test suite on this commit, so don't run it yourself",
    );
    expect(prompt).toContain("ci.md");
  }, 100_000);

  // A workflow can run on other PRs and skip this one, such as with a branch or paths filter.
  // CI elsewhere then proves nothing about this commit, and the reviewer runs the suite.
  test("when CI shows on another PR but never on this one, the reviewer runs the whole suite", async () => {
    addApp({ ".github/workflows/ci.yml": "on: { pull_request: { branches: [next] } }\n" });
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("8", "Other work", {
          branch: "other",
          head: "0123456789abcdef0123456789abcdef01234567",
          checks: [{ name: "test", id: "901", state: "passed" }],
        }),
      ],
      next: null,
    });
    verdict(1, "approve", "Ready to merge.");
    // The review waits out its wait for CI, so the wait is short.
    await startApp12({ env: { SKELCREW_CI_WAIT_MS: "5000" } });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("No CI runs on this commit, so run the repository's whole test suite");
    expect(prompt).not.toContain("CI is still running");
    expect(prompt).not.toContain("ci.md");
  }, 100_000);

  // CI the PR adds runs on the PR too, but shows no check until the forge starts it.
  test("on a PR that adds the first workflow, the review waits for CI's check, then reads its result", async () => {
    addApp();
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "ci.yml"), "on: pull_request\n");
    verdict(1, "approve", "Ready to merge.");
    // The check shows at the next poll.
    await startApp12({ every: 1_000 });
    await until(() => opened() !== undefined, 30_000);
    // No check yet, so no review either, however many polls find none.
    await morePolls();
    expect(existsSync(join(codexHome(), "sessions", "prompt-1"))).toBe(false);
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          checks: [{ name: "test", id: "900", state: "running" }],
        }),
      ],
      next: null,
    });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain(
      "CI runs the whole test suite on this commit, so don't run it yourself",
    );
  }, 100_000);

  // CI outside GitHub, such as Buildkite, leaves no workflows in the repository, yet shows a
  // check on the commit soon after the push.
  test("without workflows or CI on other PRs, the review waits for an outside check, then reads its result", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    // The check shows at the next poll.
    serve({ every: 1_000, env: { SKELCREW_CHECK_WAIT_MS: "60000" } });
    await untilCloned();
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => opened() !== undefined, 30_000);
    // No check yet, so no review either, however many polls find none.
    await morePolls();
    expect(existsSync(join(codexHome(), "sessions", "prompt-1"))).toBe(false);
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          checks: [{ name: "buildkite/test", id: null, state: "running" }],
        }),
      ],
      next: null,
    });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain(
      "CI runs the whole test suite on this commit, so don't run it yourself",
    );
  }, 100_000);

  // A workflow that runs only on a release never shows a check on a PR. Once a review has waited
  // for one in vain, the repository's next reviews start at once.
  test("with a release-only workflow, only the first review waits for CI, then the reviewer runs the suite", async () => {
    addApp({ ".github/workflows/release.yml": "on: release\n" });
    verdict(1, "changes", "The export has no test.");
    verdict(2, "approve", "Ready to merge.");
    // The first review waits out its wait for CI, so the wait is short.
    await startApp12({ env: { SKELCREW_CI_WAIT_MS: "5000" } });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    const first = read(join(codexHome(), "sessions", "prompt-1"));
    expect(first).toContain("No CI runs on this commit, so run the repository's whole test suite");
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), longWait);
    const second = read(join(codexHome(), "sessions", "prompt-2"));
    expect(second).toContain("No CI runs on this commit, so run the repository's whole test suite");
    // Only the first review waited.
    const waits = read(join(data(), "threads", "app-12.log")).match(
      /waiting for CI's first check/g,
    );
    expect(waits).toHaveLength(1);
  }, 150_000);

  // CI that shows on another PR after a review waited in vain means CI runs here after all. The
  // repository's reviews wait for a first check again, even once that PR closed, so a commit
  // with workflows isn't taken for one no CI runs on before its first check could start.
  test("CI on another PR after a vain wait makes the next review wait again, though that PR closed", async () => {
    addApp({ ".github/workflows/release.yml": "on: release\n" });
    verdict(1, "changes", "The export has no test.");
    verdict(2, "approve", "Ready to merge.");
    // The first review is held once it has waited in vain, while CI shows on PR 20 and it closes.
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    await startApp12({ every: 200, env: { SKELCREW_CI_WAIT_MS: "5000" } });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    const polls = () => asked(plugin).filter((q) => q.ask === "changed").length;
    const answered = async (items: object[]) => {
      answer(plugin, "changed", { items, next: null });
      const before = polls();
      await until(() => polls() >= before + 3, 30_000);
    };
    const issue = taskItem("12", "Add export", { body: "As JSON" });
    const ci = [{ name: "test", id: "8", state: "passed" }];
    await answered([issue, prItem("20", "Fix a typo", { checks: ci })]);
    await answered([issue]);
    writeFileSync(join(codexHome(), "sessions", "go-1"), "");
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), longWait);
    // Both reviews waited for a first check.
    const waits = read(join(data(), "threads", "app-12.log")).match(
      /waiting for CI's first check/g,
    );
    expect(waits).toHaveLength(2);
  }, 150_000);

  // CI skips a change to docs and Markdown alone, so the review neither waits for it nor runs
  // the tests.
  test("on a change to docs alone, the review starts at once and runs no tests", async () => {
    addApp({ ".github/workflows/ci.yml": "on: pull_request\n" });
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "");
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("The change only touches docs and Markdown, so don't run the tests.");
    expect(prompt).not.toContain("run the repository's whole test suite");
    expect(prompt).not.toContain("ci.md");
  }, 60_000);

  // git quotes a name with letters outside ASCII, unless asked not to.
  test("a change to a Markdown file with an accented name runs no tests", async () => {
    addApp();
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "résumé.md");
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("The change only touches docs and Markdown, so don't run the tests.");
  }, 100_000);

  // A file moved from code to docs removes code, though git would show only its new name.
  test("a change that moves code into docs is no docs-only change, and its tests run", async () => {
    addApp({ "src/app.ts": "export const app = 1;\n" });
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "");
    writeFileSync(join(builder(), "code-to-docs"), "");
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("No CI runs on this commit, so run the repository's whole test suite");
    expect(prompt).not.toContain("only touches docs and Markdown");
  }, 60_000);

  test("without CI, the reviewer runs the whole test suite itself", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain(
      "No CI runs on this commit, so run the repository's whole test suite with `sc check`, which runs `bun test` once one of this machine's check slots is free. Never run that command directly, as other agents share this machine.",
    );
  }, 60_000);

  test("tells the builder about sc submit, after the task rather than in it", async () => {
    addApp();
    fakeClaude(false);
    await startApp12();
    await until(() => read(join(builder(), "args")) !== "");
    const args = read(join(builder(), "args"));
    const told = read(join(builder(), "told"));
    expect(told).toContain('sc submit "<summary>"');
    expect(told).toContain(
      "Come back to the human only for new scope, missing access, or a decision that is theirs. Decide everything else yourself.",
    );
    expect(args).not.toContain("sc submit");
    expect(args.endsWith("Add export\n\nAs JSON\n")).toBe(true);
  }, 60_000);

  // tmux refuses a start command past about 16 KB, so instructions that long once stopped
  // agents from starting.
  test("starts a builder with 64 KB of instructions, which it reads to their end", async () => {
    const work = addApp();
    const long = `${"x".repeat(64 * 1024)} the end of the instructions`;
    writeFileSync(
      join(work, "skelcrew.yaml"),
      `tracker: github\ntest: [${JSON.stringify(long)}]\n`,
    );
    git(work, "commit", "-qam", "A long test command");
    git(work, "push", "-q", "origin", "main");
    fakeClaude(false);
    await startApp12();
    await until(() => read(join(builder(), "args")) !== "");
    expect(read(join(builder(), "told"))).toContain(`runs with \`${long}\`.`);
  }, 60_000);
});

test("only a builder can submit, from its thread", async () => {
  addApp();
  serve();
  await until(() => existsSync(join(home, "run", "skelcrew.sock")));
  await Bun.sleep(100);
  const submitted = await skel(["submit", "Done"]);
  expect(submitted.code).not.toBe(0);
  expect(submitted.err).toContain("doesn't know that request");
});
