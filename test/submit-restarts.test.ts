// sc submit as main and the PR's base move, and as the daemon stops and starts, against a running
// daemon: merges of main, retargeted PRs, reviews cut short, and reviews saved for the builder.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { answer, asked, git, insideSandbox, prItem, read, taskItem } from "./harness.ts";
import {
  addApp,
  builder,
  builderSocket,
  clone,
  codexHome,
  config,
  copiedPr,
  data,
  edits,
  fakeClaude,
  finished,
  github,
  lead,
  longWait,
  opened,
  plugin,
  pushed,
  reviews,
  serve,
  setUp,
  skel,
  socket,
  startAgain,
  startApp12,
  statuses,
  tearDown,
  thread,
  typedMessages,
  until,
  untilCloned,
  untilReviewSaved,
  verdict,
} from "./submit.ts";

beforeEach(setUp);
afterEach(tearDown);

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("sc submit", () => {
  // Moves main on the fake GitHub with a commit of its own, then merges it into the thread's
  // clone, as a builder brings in main when its PR falls behind. Main's commit changes `file`.
  function mergeMain(work: string, file = "OTHER"): void {
    writeFileSync(join(work, file), "other\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "main moved");
    git(work, "push", "-q", "origin", "main");
    git(clone(), "fetch", "-q", join(github(), "simon", "app.git"), "main");
    git(clone(), "merge", "-q", "--no-ff", "--no-edit", "FETCH_HEAD");
  }

  // Makes the forge show PR 7 with its head at the commit, with the checks given, from the next
  // poll on. These tests' daemons poll every second, as they wait on what the forge shows.
  function showPr(head: string, checks: { name: string; id: null; state: string }[]): void {
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", { branch: "skelcrew/12-add-export", head, checks }),
      ],
      next: null,
    });
  }
  const ciCheck = (state: string) => ({ name: "buildkite/test", id: null, state });
  // Starts the daemon, has round 1 approved, then merges main into the branch as `mergeMain`
  // does and submits that. With `ci`, the forge shows CI passed on the approved commit, and on
  // the merge once it is pushed, in the state `merge` gives. Returns the commit submitted and
  // the daemon.
  async function approveThenMerge(
    work: string,
    more: { ci?: boolean; merge?: string } = {},
  ): Promise<{ merged: string; daemon: Subprocess }> {
    const { ci = true, merge = "running" } = more;
    const daemon = serve({ every: 1_000 });
    await untilCloned();
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => opened() !== undefined, longWait);
    if (ci) showPr(pushed(), [ciCheck("passed")]);
    await until(() => finished("success").length === 1, longWait);
    await untilReviewSaved();
    // The round after waits for CI's first check only once Skelcrew has seen CI on the PR, which
    // comes with a poll. Tests set the wait for a first check without that to 0.
    if (ci) await until(() => thread().checks === "passing", longWait);
    mergeMain(work);
    const again = await skel(["submit", "Merged main"], { SKELCREW_SOCKET: builderSocket() });
    expect(again.err).toBe("");
    const merged = git(clone(), "rev-parse", "HEAD");
    await until(() => pushed() === merged, longWait);
    if (ci) showPr(merged, [ciCheck(merge)]);
    return { merged, daemon };
  }

  test("a submit that only merges main keeps the approval once every CI check on it passed", async () => {
    const work = addApp();
    verdict(1, "approve", "Ready to merge.");
    answer(plugin, "edit review", { edited: true });
    const { merged } = await approveThenMerge(work, { merge: "passed" });
    await until(() => finished("success").length === 2, longWait);
    await untilReviewSaved();

    // No reviewer ran for the merge, and the check and a comment on the PR say why.
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("1");
    expect(finished("success")[1]).toEqual({
      sha: merged,
      state: "success",
      description: "approval kept: only merged main",
    });
    // The PR's one review is edited to say so.
    expect(reviews()).toHaveLength(1);
    const kept = edits()[0];
    expect(kept).toMatchObject({ pr: 7, id: "1001", verdict: "approve" });
    expect(String(kept?.body)).toContain(`Round 2 · commit ${merged.slice(0, 7)}`);
    expect(String(kept?.body)).toContain("only merges main");
    // It stays approved, with no round of changes counted.
    expect(thread()).toMatchObject({
      status: "waiting",
      rounds: 0,
      verdict: "approve",
      review_round: 2,
    });
    // The daemon saves a thread before it appends the thread to its log.
    await until(() => read(join(data(), "threads", "app-12.log")).includes("approval kept"));
  }, 180_000);

  test("a submit that only merges main is reviewed when a CI check on it fails", async () => {
    const work = addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "changes", "The merge broke the export.");
    const { merged } = await approveThenMerge(work, { merge: "failed" });
    await until(() => reviews().length === 2, longWait);
    expect(existsSync(join(codexHome(), "sessions", "prompt-2"))).toBe(true);
    expect(reviews()[1]).toEqual({
      commit: merged,
      verdict: "changes",
      body: "The merge broke the export.\n\n1. The merge broke the export.",
    });
    expect(statuses().some((s) => s.description.startsWith("approval kept"))).toBe(false);
  }, 180_000);

  test("without CI on the merge, a submit that only merges main is reviewed, so its tests run", async () => {
    const work = addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Tests pass.");
    answer(plugin, "edit review", { edited: true });
    const { merged } = await approveThenMerge(work, { ci: false });
    await until(() => finished("success").length === 2, longWait);
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("2");
    expect(read(join(codexHome(), "sessions", "prompt-2"))).not.toContain(
      "CI runs the whole test suite on this commit",
    );
    // The merge is a round of its own, so its number goes up.
    expect(edits()[0]?.body).toBe(`Round 2 · commit ${merged.slice(0, 7)}\n\nTests pass.`);
  }, 180_000);

  // Each sc start past the round limit decides only the review that reached it, and a merge of
  // main in between is a round like any other. The rounds' own numbers, on the PR's review, only
  // go up, and the limit needs you at each review asking for changes past it.
  test("merges of main between sc starts past the round limit keep the round going up", async () => {
    const work = addApp();
    config("max_rounds: 1\n");
    // The builder submits its first round, then leaves each later one to the test.
    fakeClaude(true, false);
    answer(plugin, "edit review", { edited: true });
    verdict(1, "changes", "First problem.");
    verdict(2, "changes", "Second problem.");
    verdict(3, "changes", "The merge broke the export.");
    verdict(4, "approve", "Ready to merge.");
    verdict(5, "approve", "Tests pass.");
    const asBuilder = { SKELCREW_SOCKET: builderSocket() };
    const submit = async (summary: string) =>
      expect((await skel(["submit", summary], asBuilder)).err).toBe("");
    const fix = async (n: number) => {
      writeFileSync(join(clone(), "change"), `fix ${n}\n`);
      git(clone(), "commit", "-qam", `fix ${n}`);
      await submit(`Fix ${n}`);
    };
    const ps = async () => JSON.parse((await skel(["ps", "--json"])).out)[0];
    const typed = () => read(join(builder(), "typed"));
    await startApp12();
    await until(() => typed().includes("First problem."), longWait);
    await fix(1);
    await until(() => finished("failure").length === 2 && thread().needs_you === 1, longWait);
    expect(thread()).toMatchObject({ review_round: 2 });
    expect(await ps()).toMatchObject({ needsYou: true, needsYouFor: "round limit" });
    expect((await skel(["start", "app-12"])).out).toContain("APP-12 goes on");
    await until(() => typed().includes("Second problem."), longWait);
    expect(await ps()).toMatchObject({ needsYou: false });
    // A merge of main, reviewed as it isn't approved, asks for changes past the limit again.
    mergeMain(work);
    await submit("Merged main");
    await until(() => finished("failure").length === 3 && thread().needs_you === 1, longWait);
    expect(thread()).toMatchObject({ review_round: 3 });
    expect(typed()).not.toContain("The merge broke the export.");
    expect(await ps()).toMatchObject({ needsYou: true, needsYouFor: "round limit" });
    expect((await skel(["start", "app-12"])).out).toContain("APP-12 goes on");
    await until(() => typed().includes("The merge broke the export."), longWait);
    await fix(2);
    await until(() => finished("success").length === 1, longWait);
    await untilReviewSaved();
    expect(thread()).toMatchObject({ needs_you: 0, held: null, review_round: 4 });
    // With no CI on the PR, a merge of main after the approval is reviewed, as round 5.
    mergeMain(work, "OTHER2");
    await submit("Merged main again");
    await until(() => finished("success").length === 2, longWait);
    await untilReviewSaved();
    expect(thread()).toMatchObject({ needs_you: 0, review_round: 5 });
    const posted = asked(plugin)
      .filter((q) => q.ask === "review" || q.ask === "edit review")
      .map((q) => /^Round (\d+)/.exec(String(q.body))?.[1]);
    expect(posted).toEqual(["1", "2", "3", "4", "5"]);
  }, 300_000);

  // The builder merged main as GitHub has it, but its own origin/main is still where the thread
  // started. Diffed against that, main's new commits would read as the PR's.
  test("a merge of main is reviewed against main as the forge has it, not the builder's older copy", async () => {
    const work = addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Tests pass.");
    await approveThenMerge(work, { ci: false });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), longWait);
    const main = git(work, "rev-parse", "HEAD");
    expect(read(join(codexHome(), "sessions", "main-2")).trim()).not.toBe(main);
    expect(read(join(codexHome(), "sessions", "prompt-2"))).toContain(`git diff ${main}...HEAD`);
  }, 180_000);

  // The change was docs alone against main, but next lacks main's code, so against next it
  // changes code, and its tests must run.
  test("a PR retargeted while its review waits is tested as its new diff needs", async () => {
    const work = addApp();
    git(work, "push", "-q", "origin", "main:next");
    writeFileSync(join(work, "app.ts"), "export const app = 1;\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "code on main");
    git(work, "push", "-q", "origin", "main");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "");
    writeFileSync(join(plugin, "hold-status-pending"), "");
    verdict(1, "approve", "Ready to merge.");
    serve({ every: 1_000 });
    await untilCloned();
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => existsSync(join(plugin, "held-status")), longWait);
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          base: "next",
        }),
      ],
      next: null,
    });
    await until(() => copiedPr().includes('"base":"next"'), longWait);
    rmSync(join(plugin, "hold-status-pending"));
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).not.toContain("only touches docs");
    expect(prompt).toContain("run the repository's whole test suite");
  }, 180_000);

  // Someone can change the branch a PR goes into on the forge. Diffed against the base the
  // thread started from, the reviewer would judge commits that aren't the PR's.
  test("a PR retargeted on the forge is reviewed against its new base", async () => {
    const work = addApp();
    git(work, "push", "-q", "origin", "main:next");
    const next = git(work, "rev-parse", "HEAD");
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Fine.");
    serve({ every: 1_000 });
    await untilCloned();
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => finished("success").length === 1, longWait);
    await untilReviewSaved();
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          base: "next",
          body: "Retargeted to next.",
        }),
      ],
      next: null,
    });
    await until(() => copiedPr().includes('"base":"next"'), longWait);
    // main moves and the branch takes it in, so main and next now meet the branch apart.
    mergeMain(work);
    expect((await skel(["submit", "Merged main"], { SKELCREW_SOCKET: builderSocket() })).err).toBe(
      "",
    );
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), longWait);
    expect(read(join(codexHome(), "sessions", "prompt-2"))).toContain(`git diff ${next}...HEAD`);
    // The PR's description is asked of the forge as round 2 starts.
    expect(read(join(codexHome(), "sessions", "prompt-2"))).toContain(
      "It only says which trade-offs the builder stated:\n\nRetargeted to next.",
    );
  }, 180_000);

  // The forge shows the PR retargeted before Skelcrew's next poll does. Round 2 asks the forge
  // for its description, and its base comes from that same answer.
  test("a PR retargeted just before round 2 is reviewed against the base the forge shows now", async () => {
    const work = addApp();
    git(work, "push", "-q", "origin", "main:next");
    const next = git(work, "rev-parse", "HEAD");
    verdict(1, "changes", "The export has no test.");
    verdict(2, "approve", "Fine.");
    fakeClaude(true, false);
    serve();
    await untilCloned();
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => finished("failure").length === 1, longWait);
    await untilReviewSaved();
    mergeMain(work);
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          base: "next",
          body: "Retargeted to next.",
        }),
      ],
      next: null,
    });
    expect((await skel(["submit", "Merged main"], { SKELCREW_SOCKET: builderSocket() })).err).toBe(
      "",
    );
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), longWait);
    const prompt = read(join(codexHome(), "sessions", "prompt-2"));
    expect(prompt).toContain(`git diff ${next}...HEAD`);
    expect(prompt).toContain("the builder stated:\n\nRetargeted to next.");
  }, 180_000);

  // Against next, which lacks main's new commit, the merge brings in more than its base.
  test("a PR retargeted while its merge waits for CI is reviewed, not kept approved", async () => {
    const work = addApp();
    git(work, "push", "-q", "origin", "main:next");
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Reviewed against next.");
    answer(plugin, "edit review", { edited: true });
    const { merged } = await approveThenMerge(work);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waiting for CI"));
    const retargeted = (state: string) =>
      answer(plugin, "changed", {
        items: [
          taskItem("12", "Add export", { body: "As JSON" }),
          prItem("7", "Add export", {
            branch: "skelcrew/12-add-export",
            head: merged,
            base: "next",
            checks: [ciCheck(state)],
          }),
        ],
        next: null,
      });
    retargeted("running");
    await until(() => copiedPr().includes('"base":"next"'), longWait);
    retargeted("passed");
    await until(() => edits().length === 1, longWait);
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("2");
    expect(edits()[0]?.body).toBe(
      `Round 2 · commit ${merged.slice(0, 7)}\n\nReviewed against next.`,
    );
    expect(statuses().some((s) => s.description.startsWith("approval kept"))).toBe(false);
  }, 180_000);

  test("a merge whose wait for CI a restart cut short still keeps the approval", async () => {
    const work = addApp();
    verdict(1, "approve", "Ready to merge.");
    const { merged, daemon } = await approveThenMerge(work, { merge: "running" });
    // CI still runs on the merge, so the approval waits for it to pass.
    await until(
      () => read(join(data(), "threads", "app-12.log")).includes("waiting for CI to pass"),
      longWait,
    );
    // While CI runs, the thread holds the commit as under review: never kept, ready or needing you.
    await Bun.sleep(3_000);
    expect(finished("success").length).toBe(1);
    expect(thread()).toMatchObject({ reviewing: merged, needs_you: 0 });
    daemon.kill();
    await daemon.exited;
    expect(thread().reviewing).toBe(merged);
    serve({ every: 1_000 });
    showPr(merged, [ciCheck("passed")]);
    await until(() => finished("success").length === 2, longWait);
    expect(finished("success")[1]).toMatchObject({
      sha: merged,
      description: "approval kept: only merged main",
    });
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("1");
  }, 180_000);

  test("runs again a review the daemon's stop cut short", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    verdict(2, "approve", "Looks right.");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    first.kill();
    await first.exited;
    expect(thread().reviewing).toBe(pushed());
    serve();
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(pushed());
    expect(reviews()).toEqual([{ commit: pushed(), verdict: "approve", body: "Looks right." }]);
    await until(() => thread().reviewing === null);
  }, 130_000);

  // A review the daemon brings back runs before the builders are back, so its changes wait for
  // the builder rather than fail on a session that isn't there yet.
  test("a review brought back that asks for changes types them in once the builder is back", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    verdict(2, "changes", "The export has no test.");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    first.kill();
    await first.exited;
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    // The builder started again has no round of its own to submit.
    fakeClaude(false);
    serve();
    await until(() => typedMessages() === 1, 30_000);
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");
    await until(() => thread().telling === null);
    expect(thread().needs_you).toBe(0);
  }, 60_000);

  // A review that leaves the queue because its pending check failed never runs, so the thread
  // must not go on saying it is queued.
  test("a review whose pending check fails while it waits is no longer queued, and needs you", async () => {
    config("limits: { reviews: 1 }\n");
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        taskItem("13", "Add import", { body: "From CSV" }),
      ],
      next: null,
    });
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    // app-13 gets a PR of its own, and the forge now refuses every check.
    answer(plugin, "open pr", { number: 8 });
    writeFileSync(join(plugin, "fail-status"), "the forge is down");
    expect((await skel(["start", "app-13"])).err).toBe("");
    const app13 = () => {
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      try {
        type Row = { review_failed: number; queued: number | null };
        const query = db.query<Row, [string]>(
          "SELECT review_failed, queued FROM task_threads WHERE folder = ?",
        );
        return query.get("app-13") ?? { review_failed: 0, queued: null };
      } finally {
        db.close();
      }
    };
    // The round failed, which the lead hears of and can run again, so it doesn't need you.
    await until(() => app13().review_failed === 1, longWait);
    expect(app13().queued).toBeNull();
    expect((await skel(["ps", "app", "--json"])).out).toContain(
      '"thread":"APP-13","short":null,"title":"Add import","status":"waiting","needsYou":false,"needsYouFor":null,"queued":false',
    );
  }, 120_000);

  // Starting the daemon again runs a failed round again, so sc ps says it is reviewing, not
  // failed, while it runs.
  test("a failed round the daemon runs again as it starts shows as reviewing", async () => {
    addApp();
    writeFileSync(join(plugin, "fail-status"), "the forge is down");
    const first = serve();
    await untilCloned();
    expect((await skel(["start", "app-12"])).err).toBe("");
    const review = async () => {
      const rows: { thread: string; review: { state: string } | null }[] = JSON.parse(
        (await skel(["ps", "app", "--json"])).out,
      );
      return rows.find((row) => row.thread === "APP-12")?.review?.state;
    };
    await until(() => thread().review_failed === 1, longWait);
    expect(await review()).toBe("failed");
    first.kill();
    await first.exited;
    rmSync(join(plugin, "fail-status"));
    writeFileSync(join(plugin, "hold-status"), "");
    serve();
    await until(() => existsSync(join(plugin, "held-status")), longWait);
    expect(await review()).toBe("reviewing");
    rmSync(join(plugin, "hold-status"));
  }, 120_000);

  // The first poll brings only open tasks, while the thread's task may have closed: the thread
  // saved its task as it started.
  test("runs again a review cut short by an upgrade, though the thread's task is closed", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    verdict(2, "approve", "Looks right.");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), longWait);
    first.kill();
    await first.exited;
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("DELETE FROM items");
    db.close();
    answer(plugin, "changed", { items: [], next: null });
    serve();
    await until(() => finished("success").length + finished("failure").length === 1, longWait);
    expect(finished("success")[0]?.sha).toBe(pushed());
  }, 120_000);

  test("finishes a submit the daemon's stop cut short while opening the PR", async () => {
    addApp();
    verdict(1, "approve", "Looks right.");
    writeFileSync(join(plugin, "hold-open-pr"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(plugin, "held-open-pr")), 30_000);
    first.kill();
    await first.exited;
    // The call the stopped daemon started ends with it, and the forge answers with the PR
    // already open from the branch when asked again.
    rmSync(join(plugin, "hold-open-pr"));
    serve();
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(pushed());
    expect(reviews()).toEqual([{ commit: pushed(), verdict: "approve", body: "Looks right." }]);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(thread()).toMatchObject({ pr: 7, submitting: null });
  }, 60_000);

  test("types in a review the daemon's stop kept from the builder, without reviewing again", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => thread().telling !== null, 30_000);
    const reviewed = statuses()[0]?.sha;
    first.kill();
    await first.exited;
    serve();
    await Bun.sleep(1000);
    rmSync(join(builder(), "busy"));
    await until(() => typedMessages() === 1, 30_000);
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");
    // One review was posted. The stop may cut short posting it, after the forge took it but
    // before Skelcrew saved its ID, and it is then posted again, the same. A real forge's review
    // is found by its marker instead, which this forge's copy, with no PR, can't show.
    expect(new Set(reviews().map((review) => JSON.stringify(review))).size).toBe(1);
    // No second review ran, so no pending check came after the verdict's. The stop may cut short
    // setting the verdict's check too, which is then set again, the same.
    const states = statuses()
      .filter((s) => s.sha === reviewed)
      .map((s) => s.state);
    expect(states.filter((state, n) => state !== states[n - 1])).toEqual(["pending", "failure"]);
    await until(() => thread().telling === null);
    // The review set the thread working again before the builder's turn ended, but that turn
    // had its submit, so the builder never waited on you.
    expect(read(join(data(), "threads", "app-12.log"))).not.toContain("without submitting");
  }, 60_000);

  // Typing the changes in while the builder asks you a question would answer it for you.
  test("a review's changes wait while the builder asks a question, and go in once it is over", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    // The daemon tries the waiting messages every 200 ms rather than every two seconds.
    await startApp12({ env: { SKELCREW_LOOK_MS: "200" } });
    await until(() => thread().telling !== null, 30_000);
    const asBuilder = { SKELCREW_SOCKET: builderSocket() };
    expect((await skel(["question", "asked"], asBuilder)).code).toBe(0);
    rmSync(join(builder(), "busy"));
    // Long enough for several tries, each finding the question open.
    await Bun.sleep(1500);
    expect(read(join(builder(), "typed"))).not.toContain("The export has no test.");
    expect(String(thread().telling)).toContain("The export has no test.");
    expect((await skel(["question", "closed"], asBuilder)).code).toBe(0);
    await until(() => read(join(builder(), "typed")).includes("The export has no test."));
    await until(() => thread().telling === null);
  }, 60_000);

  test("keeps a review it couldn't type in, and needs you", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await startApp12();
    await until(() => thread().telling !== null, 30_000);
    // Skelcrew watches a builder for a second after it starts, and one that ends within it
    // failed to start. With no CI to wait for, the review can come back within that second, so
    // the session ends only once the watch is over, as for a builder that ended mid-work.
    await until(() => Date.now() > Number(thread().working_since) + 2000);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    await until(
      () => read(join(lead(), "typed")).includes("APP-12's builder isn't running"),
      30_000,
    );
    expect(thread().needs_you).toBe(0);
    expect(String(thread().telling)).toContain("The export has no test.");
  }, 60_000);

  test("types in a saved review once a builder whose session ended is started again", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => thread().telling !== null, 30_000);
    first.kill();
    await first.exited;
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    rmSync(join(builder(), "busy"));
    // The builder started again has no round of its own to submit, as it never saved a
    // conversation to go on with.
    fakeClaude(false);
    serve();
    await until(() => typedMessages() === 1, 30_000);
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");
    await until(() => thread().telling === null);
  }, 60_000);

  test("a builder started again that submits at once drops the saved review", async () => {
    addApp();
    verdict(1, "changes", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => thread().telling !== null, 30_000);
    first.kill();
    await first.exited;
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    rmSync(join(builder(), "busy"));
    serve();
    await until(() => finished("success").length === 1, 30_000);
    await Bun.sleep(2000);
    expect(typedMessages()).toBe(0);
  }, 60_000);

  // A builder can go on after a turn that ended without a submit with nothing typed into it,
  // such as when a background command it started finishes. Its submit then waits on its review.
  test("sc submit after a turn ended without one ends turn ended", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Still ready.");
    await startApp12();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"), 30_000);
    await until(() => read(join(builder(), "ended")).trim() === "1", 30_000);
    const asBuilder = { SKELCREW_SOCKET: builderSocket() };
    // A new turn ends with new work and no submit, so the thread shows turn ended.
    expect((await skel(["question", "answered"], asBuilder)).code).toBe(0);
    writeFileSync(join(clone(), "change"), "newer\n");
    git(clone(), "commit", "-qam", "newer");
    expect((await skel(["turn", "ended"], asBuilder)).code).toBe(0);
    await until(() => thread().turn_ended === 1);
    // The builder submits without anything typed in first.
    expect((await skel(["submit", "Newer"], asBuilder)).err).toBe("");
    expect(thread()).toMatchObject({ turn_ended: 0, needs_you: 0 });
    await until(() => finished("success").length === 2, 45_000);
  }, 90_000);

  test("a newer sc submit drops a review still waiting for the builder", async () => {
    addApp();
    verdict(1, "changes", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await startApp12();
    await until(() => thread().telling !== null, 30_000);
    writeFileSync(join(clone(), "change"), "newer\n");
    git(clone(), "commit", "-qam", "newer");
    expect((await skel(["submit", "Newer"], { SKELCREW_SOCKET: builderSocket() })).err).toBe("");
    expect(thread().telling).toBeNull();
    await until(() => finished("success").length === 1, 30_000);
    rmSync(join(builder(), "busy"));
    await Bun.sleep(2000);
    expect(typedMessages()).toBe(0);
  }, 60_000);

  test("reviews against the default branch as the thread started from it", async () => {
    const work = addApp();
    verdict(1, "approve", "Fine.");
    serve();
    await untilCloned();
    writeFileSync(join(work, "LATER"), "later\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "later");
    git(work, "push", "-q", "origin", "main");
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => finished("success").length === 1, 30_000);
    expect(read(join(codexHome(), "sessions", "main-1"))).toBe(
      `${git(work, "rev-parse", "HEAD")}\n`,
    );
  }, 60_000);

  test("a commit submitted again while its check is being set gets pending after it", async () => {
    addApp();
    verdict(1, "approve", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-2"), "");
    writeFileSync(join(plugin, "hold-status-success"), "");
    await startApp12();
    await until(() => existsSync(join(plugin, "held-status")), longWait);
    expect((await skel(["submit", "Again"], { SKELCREW_SOCKET: builderSocket() })).err).toBe("");
    await Bun.sleep(1000);
    rmSync(join(plugin, "hold-status-success"));
    await until(() => statuses().length === 3, longWait);
    expect(statuses().map((s) => s.state)).toEqual(["pending", "success", "pending"]);
  }, 120_000);

  // A review being posted has its verdict saved already, so it still sets its check, which
  // the PR's review and the thread agree with. The newer submit's pending check comes after it.
  test("a review cancelled while it is posted sets its check before the commit submitted again gets pending", async () => {
    addApp();
    verdict(1, "approve", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-2"), "");
    writeFileSync(join(plugin, "hold-review"), "");
    await startApp12();
    await until(() => existsSync(join(plugin, "held-review")), 60_000);
    expect((await skel(["submit", "Again"], { SKELCREW_SOCKET: builderSocket() })).err).toBe("");
    await Bun.sleep(1000);
    rmSync(join(plugin, "hold-review"));
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), 30_000);
    expect(reviews()).toHaveLength(1);
    await Bun.sleep(1500);
    expect(statuses().map((s) => s.state)).toEqual(["pending", "success", "pending"]);
  }, 120_000);

  // Past the round limit, sc review asks again, and the reviewer approves. sc stop ends the
  // round while the approval is being posted. The PR then shows it, so Skelcrew must have saved
  // it too, rather than the changes that reached the limit.
  test("past the round limit, a review stopped while it is posted is saved as the PR shows it", async () => {
    addApp();
    config("max_rounds: 1\n");
    verdict(1, "changes", "First problem.");
    verdict(2, "changes", "Second problem.");
    verdict(3, "approve", "Ready to merge.");
    await startApp12();
    await until(() => thread().needs_you === 1 && thread().rounds === 2, 45_000);
    writeFileSync(join(plugin, "hold-review"), "");
    expect((await skel(["review", "app-12"])).err).toBe("");
    await until(
      () => existsSync(join(plugin, "held-review")) && reviews().at(-1)?.verdict === "approve",
      60_000,
    );
    expect((await skel(["stop", "app-12"])).err).toBe("");
    rmSync(join(plugin, "hold-review"));
    await until(() => finished("success").length === 1, 30_000);
    expect(thread()).toMatchObject({ verdict: "approve", review_round: 3, held: null });
    expect((await skel(["ps", "--json"])).out).not.toContain("round limit");
  }, 120_000);

  // The daemon can stop after saving a verdict but before the PR has it. As it starts again, it
  // puts it there, so the PR shows what Skelcrew saved and Skelcrew's check doesn't stay pending.
  test("a verdict the daemon's stop kept from the PR is posted as it starts again", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    writeFileSync(join(plugin, "hold-review"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(plugin, "held-review")), 60_000);
    first.kill();
    await first.exited;
    expect(thread()).toMatchObject({ verdict: "approve", reviewing: null });
    rmSync(join(plugin, "hold-review"));
    serve();
    await until(() => finished("success").length === 1, 30_000);
    expect(reviews().at(-1)).toEqual({
      commit: pushed(),
      verdict: "approve",
      body: "Ready to merge.",
    });
    await until(() => thread().posting === null);
  }, 120_000);

  // The forge can take the review just before the daemon stops, with its ID not yet saved. The
  // review is then in Skelcrew's copy of the PR, with its marker, so it isn't posted again.
  test("a review the forge took before the daemon stopped is found by its marker, not posted twice", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    writeFileSync(join(plugin, "hold-review"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(plugin, "held-review")), 60_000);
    first.kill();
    await first.exited;
    // The forge took it: the copy of PR 7 shows it with the body Skelcrew sent.
    const body = String(asked(plugin).find((q) => q.ask === "review")?.body);
    expect(body).toContain("<!-- skelcrew:review thread=app-12 -->");
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          reviews: [{ id: "1001", text: body, author: null, verdict: "commented", lines: [] }],
        }),
      ],
      next: null,
    });
    rmSync(join(plugin, "hold-review"));
    serve({ every: 1_000 });
    await until(() => finished("success").length === 1, 30_000);
    await until(() => thread().posting === null);
    expect(reviews()).toHaveLength(1);
    expect(String(thread().review_post)).toContain('"id":"1001"');
  }, 120_000);

  // The forge can take a review yet fail to answer, so its ID is never saved. The next round
  // can end before any poll shows the review in Skelcrew's copy of the PR. It still finds the
  // review by its marker, and edits it rather than posting a second one.
  test("a review the forge took without answering is edited by the next round, not posted twice", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    verdict(2, "approve", "Ready to merge.");
    writeFileSync(join(plugin, "hold-review"), "");
    writeFileSync(join(plugin, "fail-review"), "connection reset");
    // No poll comes between the two rounds to bring the copy up to date.
    await startApp12({ every: 600_000 });
    await until(() => existsSync(join(plugin, "held-review")), 60_000);
    // The forge took it: from now on PR 7 shows it with the body Skelcrew sent.
    const body = String(asked(plugin).find((q) => q.ask === "review")?.body);
    answer(plugin, "changed", {
      items: [
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          reviews: [{ id: "1001", text: body, author: null, verdict: "commented", lines: [] }],
        }),
      ],
      next: null,
    });
    answer(plugin, "edit review", { edited: true });
    rmSync(join(plugin, "hold-review"));
    await until(() =>
      read(join(data(), "threads", "app-12.log")).includes("couldn't put its review on the forge"),
    );
    rmSync(join(plugin, "fail-review"));
    await until(() => finished("success").length === 1, 60_000);
    expect(reviews()).toHaveLength(1);
    expect(edits().map((e) => [e.id, e.verdict])).toEqual([["1001", "approve"]]);
    expect(String(thread().review_post)).toContain('"id":"1001"');
  }, 120_000);

  // sc stop ends the round while its approval is being posted, and the daemon stops before the
  // post ends. A stopped thread isn't brought back, so the daemon's start posts it anyway.
  test("a stopped thread's verdict the daemon's stop kept from the PR is posted as it starts again", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    writeFileSync(join(plugin, "hold-review"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(plugin, "held-review")), 60_000);
    expect((await skel(["stop", "app-12"])).err).toBe("");
    first.kill();
    await first.exited;
    expect(thread()).toMatchObject({ status: "stopped", verdict: "approve" });
    rmSync(join(plugin, "hold-review"));
    serve();
    await until(() => finished("success").length === 1, 30_000);
    await until(() => thread().posting === null);
    expect(thread().status).toBe("stopped");
  }, 120_000);

  // A forge that fails to take the verdict doesn't stop the round: the lead hears of it, and the
  // changes still reach the builder. The verdict stays saved, and the PR gets it once the forge
  // takes it again, at the next poll or with the next round.
  test("a verdict whose post failed still types its changes in, and is posted once the forge is back", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    verdict(2, "approve", "Ready to merge.");
    writeFileSync(join(plugin, "fail-review"), "GitHub is down");
    await startApp12({ every: 1_000 });
    await until(() => read(join(builder(), "typed")).includes("The export has no test."), 60_000);
    await until(() =>
      read(join(data(), "threads", "app-12.log")).includes("couldn't put its review on the forge"),
    );
    expect(thread().review_failed).toBe(0);
    rmSync(join(plugin, "fail-review"));
    await until(() => finished("success").length === 1, 60_000);
    await until(() => thread().posting === null);
    expect(reviews().at(-1)?.verdict).toBe("approve");
  }, 120_000);

  // A failed review is never posted. So when the forge didn't take the review before it, that
  // review is the one the PR must show once the forge is back.
  test("a failed review keeps the review before it that the forge didn't take yet", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    writeFileSync(join(plugin, "fail-review"), "GitHub is down");
    await startApp12({ every: 1_000 });
    await until(() => thread().verdict === "failed", 60_000);
    rmSync(join(plugin, "fail-review"));
    await until(() => thread().posting === null, 30_000);
    expect(String(thread().review_post)).toContain('"verdict":"changes"');
    expect(finished("failure").at(-1)?.description).toBe("review failed");
  }, 120_000);

  // A review stopped while its pending check waits for an earlier post never sets it, as no
  // review of it would then end it.
  test("a review stopped while its pending check waits behind an earlier post sets none", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    writeFileSync(join(plugin, "hold-review"), "");
    await startApp12();
    await until(() => existsSync(join(plugin, "held-review")), 60_000);
    expect((await skel(["stop", "app-12"])).err).toBe("");
    await startAgain();
    expect((await skel(["review", "app-12"])).err).toBe("");
    expect((await skel(["stop", "app-12"])).err).toBe("");
    rmSync(join(plugin, "hold-review"));
    await until(() => finished("success").length === 1, 30_000);
    await Bun.sleep(1500);
    expect(statuses().map((s) => s.state)).toEqual(["pending", "success"]);
  }, 120_000);

  // sc stop forgets the round while its approval is still being posted. A review asked for
  // after sc start then waits for that post, so the PR ends on the newer verdict, as the thread
  // does, and the newer review's pending check comes after the older one's.
  test("a review asked for after sc stop posts after the stopped round's review", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "changes", "The export has no test.");
    writeFileSync(join(plugin, "hold-review"), "");
    await startApp12();
    await until(() => existsSync(join(plugin, "held-review")), 60_000);
    expect((await skel(["stop", "app-12"])).err).toBe("");
    await startAgain();
    expect((await skel(["review", "app-12"])).err).toBe("");
    await Bun.sleep(2000);
    rmSync(join(plugin, "hold-review"));
    await until(() => finished("failure").length === 1, 60_000);
    expect(statuses().map((s) => s.state)).toEqual(["pending", "success", "pending", "failure"]);
    expect(reviews().map((r) => r.verdict)).toEqual(["approve", "changes"]);
    await until(() => thread().posting === null);
    // The approval was round 1, so the newer review is round 2.
    expect(thread()).toMatchObject({ verdict: "changes", review_round: 2, rounds: 1 });
  }, 120_000);

  test("a thread started from another branch is reviewed against it, and its PR goes into it", async () => {
    const work = addApp();
    git(work, "checkout", "-q", "-b", "next");
    git(work, "push", "-q", "origin", "next");
    verdict(1, "approve", "Fine.");
    serve();
    await untilCloned();
    expect((await skel(["start", "app-12", "--from", "next"])).err).toBe("");
    await until(() => finished("success").length === 1, 30_000);
    expect(opened()?.base).toBe("next");
    const next = git(work, "rev-parse", "next");
    expect(read(join(codexHome(), "sessions", "prompt-1"))).toContain(`git diff ${next}...HEAD`);
    expect(read(join(codexHome(), "sessions", "branches-1"))).toContain("origin/next");
  }, 60_000);

  // Skelcrew's clone holds the default branch, and another base only once Skelcrew fetches it.
  // Measured against main, the code next adds would make the change more than docs.
  test("a change to docs alone on another base branch runs no tests", async () => {
    const work = addApp();
    git(work, "checkout", "-q", "-b", "next");
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src", "next.ts"), "export const next = 1;\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "Start next");
    git(work, "push", "-q", "origin", "next");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "");
    verdict(1, "approve", "Fine.");
    serve();
    await untilCloned();
    expect((await skel(["start", "app-12", "--from", "next"])).err).toBe("");
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 60_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("The change only touches docs and Markdown, so don't run the tests.");
  }, 120_000);
});
