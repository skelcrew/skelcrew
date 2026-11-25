// A merge without Skelcrew's approval, against a running daemon: it pins the head you saw, waits
// for its checks, and files the review's findings once it merges.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answer, asked, insideSandbox, prItem, runSkelInTerminal, taskItem } from "./harness.ts";
import {
  approved,
  approvedApp12,
  askOn,
  builderSocket,
  changes,
  changesApp12,
  check,
  data,
  env,
  home,
  issue12,
  leadMerging,
  leadSocket,
  leadTyped,
  login,
  main,
  merges,
  morePolls,
  plugin,
  pr,
  pushed,
  read,
  running,
  script,
  serve,
  setUp,
  skelReview,
  skipQuestion,
  skipSaid,
  socket,
  tearDown,
  thread,
  until,
} from "./polling.ts";

beforeEach(setUp);
afterEach(tearDown);

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("polling a forge", () => {
  describe("merge when ready", () => {
    test("a merge without approval pins the head you saw, waits for checks, and a push cancels it", async () => {
      const head = await changesApp12();
      const no = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--skip-review", "app-12"],
        skipQuestion,
        "n",
      );
      expect(no).toContain("Not merging: APP-12 waits for you to merge it.");
      expect(thread().merge_plan).toBeNull();
      // Only the head you saw is pinned: a y to any other commit is refused.
      const yours = join(home, "run", "skelcrew.sock");
      const started = Number(thread().started);
      const arming = { command: "merge skip review", repo: "app", task: "12" };
      expect(
        await askOn(yours, { ...arming, seen: { pr: 7, started, head: "e".repeat(40) } }),
      ).toEqual({
        error:
          "APP-12 changed since you said y, so it won't merge by itself: run sc merge --skip-review APP-12 again",
      });
      // Builders never can, and the lead can't once you turn that off.
      leadMerging("lead: { can_merge: false }\n");
      expect(await askOn(builderSocket(), arming)).toEqual({
        error: "the daemon doesn't know that request",
      });
      expect(await askOn(leadSocket(), { ...arming, asked: "force merge it" })).toEqual({
        error:
          "Simon turned off your arming merges: ask them to run sc merge --skip-review in their own terminal, or to turn it on with lead: { can_merge: true } in ~/.config/skelcrew/config.yaml",
      });
      expect(thread().merge_plan).toBeNull();

      const yes = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--skip-review", "app-12"],
        skipQuestion,
        "y",
      );
      expect(yes).toContain(skipSaid);
      expect(thread()).toMatchObject({ merge_plan: "armed", merge_pinned: head });
      // It waits for CI like any merge, and sc ps and the lead say so.
      await until(() => thread().merge_waits === "its checks");
      const ps = Bun.spawnSync([process.execPath, main, "ps"], { env: env(), stdout: "pipe" });
      expect(ps.stdout.toString()).toContain("merges without approval");
      await until(() =>
        leadTyped().includes(
          "Merging #7 (APP-12) without Skelcrew's approval once its checks pass, as you asked at your terminal. sc merge --cancel APP-12 stops it.",
        ),
      );
      // A push after you asked cancels it, even with CI green, and the lead hears it.
      pr({ head: "b".repeat(40), reviews: [skelReview], checks: [check(5, "passed")] });
      await until(() => thread().merge_plan === null);
      expect(thread().merge_pinned).toBeNull();
      await until(() =>
        leadTyped().includes(
          "#7 (APP-12) got a new commit after Simon asked to merge it without Skelcrew's approval, so it won't merge. Ask them again if they still want it.",
        ),
      );
      await morePolls();
      expect(merges()).toEqual([]);
    }, 90_000);

    test("a lead merges without approval with your words, and files its findings once", async () => {
      const head = await changesApp12();
      const words = "Force merge #7, the edge cases\ncan wait.";
      const file = join(home, "asked.txt");
      writeFileSync(file, words);
      const asLead = () =>
        Bun.spawnSync(
          [process.execPath, main, "merge", "--skip-review", "#7", "--asked-file", file],
          { env: { ...env(), SKELCREW_SOCKET: leadSocket() }, stdout: "pipe", stderr: "pipe" },
        );
      leadMerging("lead: { can_merge: false }\n");
      expect(asLead().stderr.toString()).toContain("Simon turned off your arming merges");
      expect(thread().merge_plan).toBeNull();
      // The setting's old name still turns it on.
      leadMerging("lead: { may_arm_merges: true }\n");
      expect(
        await askOn(leadSocket(), { command: "merge skip review", repo: "app", task: "12" }),
      ).toEqual({
        error: "give what Simon asked with --asked-file, a file holding their exact words",
      });
      const armed = asLead();
      expect(armed.stderr.toString()).toBe("");
      expect(armed.stdout.toString()).toContain(skipSaid);
      expect(thread()).toMatchObject({
        merge_plan: "armed",
        merge_pinned: head,
        merge_by: `${login()} via the lead`,
        merge_asked: words,
      });
      const why = `the lead asked to merge #7 without Skelcrew's approval at commit ${head.slice(0, 7)}, as Simon asked: ${JSON.stringify(words)}`;
      expect(read(join(data(), "threads", "app-12.log"))).toContain(`"why":${JSON.stringify(why)}`);

      // Green, it first records who asked on the PR, saying it is merging, as it may still not.
      // A forge that refuses keeps the plan armed, and a restart meanwhile posts no second record.
      answer(plugin, "merge pr", { refused: "Pull Request is not mergeable" });
      pr({ head, reviews: [skelReview], checks: [check(5, "passed")] });
      await until(
        () => thread().merge_waits === "the forge, which refused: Pull Request is not mergeable",
      );
      const records = () =>
        asked(plugin).filter(
          (q) => q.ask === "review" && String(q.body).startsWith("Merging without"),
        );
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({ pr: 7, commit: head, verdict: "changes" });
      const said = `Merging without Skelcrew's approval, as asked by ${login()} via the lead on `;
      expect(String(records()[0]?.body)).toStartWith(said);
      const marker = `<!-- skelcrew:merge-skip-review plan=${String(thread().merge_id)} commit=${head} -->`;
      expect(String(records()[0]?.body)).toEndWith(marker);
      const first = running.splice(0, 1)[0];
      first?.kill();
      await first?.exited;
      serve();
      await morePolls();
      expect(records()).toHaveLength(1);

      // Once the forge agrees, it merges the pinned head, edits the record to say it merged, and
      // files what the review still asked for as one issue.
      answer(plugin, "create task", taskItem("13", "Follow-ups from #7's review"));
      answer(plugin, "merge pr", null);
      await until(() => thread().status === "done");
      expect(records()).toHaveLength(1);
      expect(merges().length).toBeGreaterThan(1);
      expect(merges().every((merge) => merge.commit === head && merge.pr === 7)).toBe(true);
      const edits = asked(plugin).filter((q) => q.ask === "edit review");
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({
        pr: 7,
        verdict: "changes",
        id: String(thread().merge_record_id),
      });
      expect(String(edits[0]?.body)).toStartWith(
        `Merged without Skelcrew's approval, as asked by ${login()} via the lead on `,
      );
      expect(String(edits[0]?.body)).toEndWith(marker);
      const done =
        "APP-12 is done: #7 merged into main without Skelcrew's approval, as Simon asked.";
      const filedLine = "APP-12's open findings are in #13.";
      await until(() => leadTyped().includes(filedLine));
      expect(leadTyped().indexOf(done)).toBeGreaterThan(-1);
      expect(leadTyped().indexOf(done)).toBeLessThan(leadTyped().indexOf(filedLine));
      await morePolls();
      const filed = asked(plugin).filter((q) => q.ask === "create task");
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({
        repository: "simon/app",
        title: "Follow-ups from #7's review",
      });
      expect(String(filed[0]?.body)).toContain("1. Handle an empty file\n2. Test the error");
      expect(String(filed[0]?.body)).toContain("#7");
    }, 90_000);

    // CI on another PR means CI may still be starting on this one, so a merge without approval
    // waits for its first check, as CI is all that guards it. CI that never shows, as on a
    // docs-only PR it skips with a paths filter, ends the wait: no CI runs on it, and it merges.
    test("a merge without approval waits for CI's first check, then merges a PR no CI runs on", async () => {
      const head = await changesApp12([], 6_000);
      const other = prItem("20", "Fix a typo", { base: "main", checks: [check(8, "passed")] });
      const pr7 = prItem("7", "Add export", { head, reviews: [skelReview], checks: [] });
      changes([issue12(), pr7, other]);
      await morePolls();
      const yes = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--skip-review", "app-12"],
        skipQuestion,
        "y",
      );
      expect(yes).toContain(skipSaid);
      // The wait starts once a poll sees the pinned commit.
      await until(() => thread().merge_waits === "its checks");
      expect(merges()).toEqual([]);
      expect(thread().no_ci).toBeNull();
      await until(() => merges().length === 1, 30_000);
      expect(merges()[0]).toMatchObject({ pr: 7, commit: head });
      expect(thread().no_ci).toBe(head);
    }, 90_000);

    // A review that ends after you asked can approve the commit. The record then approves too,
    // never asking for changes the reviewer no longer asks for, and no follow-up issue is filed.
    test("a merge without approval whose next review approves records that approval", async () => {
      const head = await changesApp12();
      const yes = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--skip-review", "app-12"],
        skipQuestion,
        "y",
      );
      expect(yes).toContain(skipSaid);
      script(
        "codex",
        `for a; do [ "$prev" = -o ] && out=$a; prev=$a; done
cat > /dev/null
echo '{"verdict":"approve","body":"Ready.","findings":[]}' > "$out"`,
      );
      const reviewedAt = thread().review_at;
      const review = Bun.spawnSync([process.execPath, main, "review", "app-12"], {
        env: env(),
        stderr: "pipe",
      });
      expect(review.stderr.toString()).toBe("");
      await until(
        () =>
          thread().review_at !== reviewedAt &&
          thread().reviewing === null &&
          thread().verdict === "approve",
        30_000,
      );
      expect(thread()).toMatchObject({ merge_plan: "armed", merge_pinned: head });
      pr({ head, reviews: [skelReview], checks: [approved, check(5, "passed")] });
      await until(() => thread().status === "done", 30_000);
      const records = asked(plugin).filter(
        (q) => q.ask === "review" && String(q.body).startsWith("Merging without"),
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ pr: 7, commit: head, verdict: "approve" });
      // The new review edits Skelcrew's review on the PR too, so only the record's edit counts.
      const edits = asked(plugin).filter(
        (q) => q.ask === "edit review" && String(q.body).startsWith("Merged without"),
      );
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ pr: 7, verdict: "approve" });
      expect(asked(plugin).filter((q) => q.ask === "create task")).toHaveLength(0);
    }, 120_000);

    // Editing the record and filing the findings come after the forge merged, and take a while.
    // A cancel meanwhile is refused, as the PR merged, and a review that ended meanwhile is the
    // one whose findings are filed.
    test("a merge without approval refuses a cancel while it finishes, and files the latest findings", async () => {
      const head = await changesApp12();
      const yes = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--skip-review", "app-12"],
        skipQuestion,
        "y",
      );
      expect(yes).toContain(skipSaid);
      writeFileSync(join(plugin, "hold-edit-review"), "");
      answer(plugin, "create task", taskItem("13", "Follow-ups from #7's review"));
      pr({ head, reviews: [skelReview], checks: [check(5, "passed")] });
      await until(() => existsSync(join(plugin, "held-edit-review")), 30_000);
      expect(merges()).toHaveLength(1);
      const cancel = { command: "merge cancel", repo: "app", task: "12" };
      expect(await askOn(join(home, "run", "skelcrew.sock"), cancel)).toEqual({
        error: "APP-12 is merging on its forge right now, so it can't be cancelled",
      });
      // A review that ended while the forge took the edit, asking for something else.
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      try {
        db.run(
          `UPDATE tasks SET review_post = json_set(review_post, '$.findings', json('["Only this"]')),
            round_log = NULL`,
        );
      } finally {
        db.close();
      }
      rmSync(join(plugin, "hold-edit-review"));
      await until(() => thread().status === "done", 30_000);
      const filed = asked(plugin).filter((q) => q.ask === "create task");
      expect(filed).toHaveLength(1);
      expect(String(filed[0]?.body)).toContain("1. Only this");
      expect(String(filed[0]?.body)).not.toContain("Handle an empty file");
    }, 90_000);

    // The forge can merge the PR before Skelcrew finishes, such as when the daemon stopped right
    // after asking it. The poll that finds it merged still edits the record and files the issue.
    test("a merge without approval the forge finished first still gets its record, and finds an issue already filed", async () => {
      const head = await changesApp12();
      const yes = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--skip-review", "app-12"],
        skipQuestion,
        "y",
      );
      expect(yes).toContain(skipSaid);
      answer(plugin, "merge pr", { refused: "Pull Request is not mergeable" });
      pr({ head, reviews: [skelReview], checks: [check(5, "passed")] });
      await until(
        () => thread().merge_waits === "the forge, which refused: Pull Request is not mergeable",
      );
      // The tracker made the issue just before a stop, so Skelcrew finds it by its marker in its
      // copy and files none.
      const filedBefore = taskItem("13", "Follow-ups from #7's review", {
        body: `Skelcrew's reviewer still asked for these.\n\n<!-- skelcrew:follow-ups plan=${String(thread().merge_id)} -->`,
      });
      const merged = prItem("7", "Add export", {
        head,
        state: "merged",
        conflicts: false,
        base: "main",
        reviews: [skelReview],
        comments: [],
        checks: [check(5, "passed")],
      });
      changes([issue12(), filedBefore, merged]);
      await until(() => thread().status === "done");
      const done =
        "APP-12 is done: #7 merged into main without Skelcrew's approval, as Simon asked.";
      const filedLine = "APP-12's open findings are in #13.";
      await until(() => leadTyped().includes(filedLine));
      expect(leadTyped().indexOf(done)).toBeGreaterThan(-1);
      expect(leadTyped().indexOf(done)).toBeLessThan(leadTyped().indexOf(filedLine));
      await morePolls();
      const edits = asked(plugin).filter((q) => q.ask === "edit review");
      expect(edits).toHaveLength(1);
      expect(String(edits[0]?.body)).toStartWith(
        "Merged without Skelcrew's approval, as asked by ",
      );
      expect(asked(plugin).filter((q) => q.ask === "create task")).toHaveLength(0);
      expect(thread().merge_followup).toBe("13");
    }, 90_000);

    // Only a review that asks for changes, or still runs, can be skipped.
    test("a merge without approval is refused on a PR that is approved", async () => {
      await approvedApp12();
      const head = pushed();
      pr({ head, reviews: [skelReview], checks: [approved] });
      await morePolls();
      const started = Number(thread().started);
      const request = {
        command: "merge skip review",
        repo: "app",
        task: "12",
        seen: { pr: 7, started, head },
      };
      expect(await askOn(join(home, "run", "skelcrew.sock"), request)).toEqual({
        error:
          "APP-12 is approved already: merge it with m in the list, or sc merge --when-ready APP-12",
      });
      expect(thread().merge_plan).toBeNull();
    }, 60_000);
  });
});
