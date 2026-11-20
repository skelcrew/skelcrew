// A merge when ready, against a running daemon: armed only by you, at your own terminal, after
// a y, it waits for Skelcrew's approval and green checks, then merges the head that was approved.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answer, asked, git, insideSandbox, prItem, runSkelInTerminal } from "./harness.ts";
import {
  approved,
  approvedApp12,
  arm,
  askOn,
  builderSocket,
  changes,
  changesApp12,
  check,
  clone,
  daemonLog,
  data,
  env,
  headOf,
  home,
  issue12,
  leadSocket,
  leadTyped,
  login,
  main,
  merges,
  morePolls,
  notLet,
  plugin,
  polls,
  pr,
  prAgents,
  pushed,
  question,
  read,
  running,
  serve,
  setUp,
  skelReview,
  socket,
  submitRound2,
  tearDown,
  thread,
  until,
} from "./polling.ts";

beforeEach(setUp);
afterEach(tearDown);

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("polling a forge", () => {
  describe("merge when ready", () => {
    // Merging approves no change to .agents/, so the question says when the PR's head makes one,
    // as a poll found it. Someone else's push to the branch, which Skelcrew's clone lacks, counts too.
    test("the question says when the PR changes .agents/, and not when it doesn't", async () => {
      const work = await approvedApp12();
      const head = pushed();
      pr({ head, reviews: [skelReview], checks: [approved] });
      await until(() => prAgents("7")?.head === head);
      const plain = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--when-ready", "app-12"],
        `${question} [y/N]`,
        "n",
      );
      expect(plain).not.toContain(".agents/");
      // A push to the PR's branch that adds a role.
      const branch = String(thread().branch);
      git(work, "fetch", "-q", join(home, "github", "simon", "app.git"), `${branch}:${branch}`);
      git(work, "checkout", "-q", branch);
      mkdirSync(join(work, ".agents", "roles"), { recursive: true });
      writeFileSync(join(work, ".agents", "roles", "builder.md"), "Build it my way.\n");
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", "roles");
      git(work, "push", "-q", join(home, "github", "simon", "app.git"), branch);
      const moved = headOf(work);
      changes([
        issue12(),
        prItem("7", "Add export", {
          head: moved,
          branch,
          reviews: [skelReview],
          checks: [approved],
        }),
      ]);
      await until(() => prAgents("7")?.head === moved);
      expect(prAgents("7")).toEqual({ head: moved, changed: 1 });
      const warned = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--when-ready", "app-12"],
        `${question} It changes .agents/ (roles, flows or skills): the changes wait for sc repo trust. [y/N]`,
        "n",
      );
      expect(warned).toContain("Not merging: app-12 waits for you to merge it.");
    });

    test("n arms nothing, y arms it, and no agent or script without a terminal can", async () => {
      await approvedApp12();
      const kept = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--when-ready", "app-12"],
        question,
        "n",
      );
      expect(kept).toContain("Not merging: app-12 waits for you to merge it.");
      expect(thread().merge_plan).toBeNull();
      // Only y arms it: any other answer, even Y or yes, arms nothing.
      for (const other of ["Y", "yes", "maybe"]) {
        const said = await runSkelInTerminal(
          socket,
          env(),
          ["merge", "--when-ready", "app-12"],
          question,
          other,
        );
        expect(said).toContain("Not merging");
        expect(thread().merge_plan).toBeNull();
      }
      // Only the PR and thread you said y to are armed, never one started over meanwhile.
      const yours = join(home, "run", "skelcrew.sock");
      const started = Number(thread().started);
      const changed = {
        error:
          "app-12 changed since you said y, so it won't merge by itself: run sc merge --when-ready app-12 again",
      };
      const arming = { command: "merge when ready", repo: "app", task: "12" };
      expect(await askOn(yours, arming)).toEqual(changed);
      expect(await askOn(yours, { ...arming, seen: { pr: 8, started } })).toEqual(changed);
      expect(await askOn(yours, { ...arming, seen: { pr: 7, started: started - 1 } })).toEqual(
        changed,
      );
      expect(thread().merge_plan).toBeNull();

      // Without a terminal nothing asks, so nothing arms.
      const piped = Bun.spawnSync([process.execPath, main, "merge", "--when-ready", "app-12"], {
        env: env(),
        stdin: "pipe",
        stderr: "pipe",
      });
      expect(piped.stderr.toString()).toContain("run it at your own terminal");
      // The builder's socket doesn't take it at all, and the lead's refuses it unless you let it.
      const request = { command: "merge when ready", repo: "app", task: "12" };
      const unknown = { error: "the daemon doesn't know that request" };
      expect(await askOn(leadSocket(), { ...request, asked: "merge it" })).toEqual({
        error: notLet,
      });
      expect(await askOn(builderSocket(), request)).toEqual(unknown);
      expect(thread().merge_plan).toBeNull();

      expect(await arm()).toContain(
        "Merging #7 as soon as it's approved and green. sc merge --cancel app-12 stops it.",
      );
      expect(thread()).toMatchObject({ merge_plan: "armed", merge_by: login() });
      // Asked again, it asks nothing, so no "no" can sound like it stopped the merge.
      const again = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--when-ready", "app-12"],
        "Already merging #7 as soon as it's approved and green. sc merge --cancel app-12 stops it.",
        "n",
      );
      expect(again).not.toContain(question);
      expect(thread().merge_plan).toBe("armed");
      // Asked for elsewhere while your question is open, a "no" doesn't say it won't merge.
      expect(await askOn(yours, { command: "merge cancel", repo: "app", task: "12" })).toEqual({
        said: "app-12 won't merge by itself. It waits for you to merge it.",
      });
      const meanwhile = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--when-ready", "app-12"],
        question,
        "n",
        () => askOn(yours, { ...arming, seen: { pr: 7, started } }),
      );
      expect(meanwhile).toContain(
        "Already merging #7 as soon as it's approved and green. sc merge --cancel app-12 stops it.",
      );
      expect(meanwhile).not.toContain("Not merging");
      expect(thread().merge_plan).toBe("armed");
      // A y to an older PR, once a plan is on the thread, reports that plan, not a refusal.
      expect(await askOn(yours, { ...arming, seen: { pr: 8, started } })).toEqual({
        said: "Already merging #7 as soon as it's approved and green. sc merge --cancel app-12 stops it.",
      });
      // sc ps says so, and the lead hears it, so it knows you asked.
      const ps = Bun.spawnSync([process.execPath, main, "ps"], { env: env(), stdout: "pipe" });
      expect(ps.stdout.toString()).toContain("merges when ready");
      await until(() =>
        leadTyped().includes(
          "Merging #7 (app-12) as soon as it's approved and green, as you asked at your terminal. sc merge --cancel app-12 stops it.",
        ),
      );
    }, 60_000);

    // You let the lead arm merges in your own config. It then arms one with your words, and
    // nothing else changes: the merge still waits for the approved head to be green.
    test("a lead you let arm merges arms one with your words, and builders still can't", async () => {
      await approvedApp12();
      // Your words as you wrote them: over lines, with a double space, quotes, what a shell would
      // run, and lines that were once heredoc delimiters.
      const ran = join(home, "ran");
      const words = `merge "#7"\nwhen it's  ready, $(touch ${ran}) \`touch ${ran}\`\nHUMAN_WORDS\nWORDS_q7x2k9mf\ntouch ${ran}`;
      // The lead writes them to a file with its file tool, and sc merge, as the lead runs it on
      // its own socket, reads them from there, by the PR's number.
      const file = join(home, "asked.txt");
      writeFileSync(file, words);
      const asLead = () =>
        Bun.spawnSync(
          [process.execPath, main, "merge", "--when-ready", "#7", "--asked-file", file],
          { env: { ...env(), SKELCREW_SOCKET: leadSocket() }, stdout: "pipe", stderr: "pipe" },
        );
      // Off by default: the lead is refused, and nothing is armed.
      expect(asLead().stderr.toString()).toContain(notLet);
      expect(thread().merge_plan).toBeNull();

      const config = join(home, ".config", "skelcrew", "config.yaml");
      writeFileSync(config, `${read(config)}lead: { may_arm_merges: true }\n`);
      // Builders stay refused, the lead must give your words, and --asked-file is never yours.
      const request = { command: "merge when ready", repo: "app", task: "12", asked: words };
      expect(await askOn(builderSocket(), request)).toEqual({
        error: "the daemon doesn't know that request",
      });
      const { asked: _, ...unquoted } = request;
      expect(await askOn(leadSocket(), unquoted)).toEqual({
        error: "give what the human asked with --asked-file, a file holding their exact words",
      });
      expect(await askOn(leadSocket(), { ...request, asked: "  " })).toMatchObject({
        error: expect.stringContaining("give what the human asked"),
      });
      expect(await askOn(join(home, "run", "skelcrew.sock"), request)).toEqual({
        error: "--asked-file is the lead's: at your terminal, sc merge asks you y/N",
      });
      expect(thread().merge_plan).toBeNull();

      // The lead arms it, with no question at a terminal.
      const armed = asLead();
      expect(armed.stderr.toString()).toBe("");
      expect(armed.stdout.toString()).toContain(
        "Merging #7 as soon as it's approved and green. sc merge --cancel app-12 stops it.",
      );
      // The plan keeps your words exactly, as what let it merge.
      expect(thread()).toMatchObject({
        merge_plan: "armed",
        merge_by: `${login()} via the lead`,
        merge_asked: words,
      });
      expect(existsSync(ran)).toBe(false);
      // The thread's log and the daemon's keep your words exactly. The lead tells you itself,
      // so Skelcrew types it no note of its own, which would say it twice in your conversation.
      const why = `the lead asked to merge #7 once it's approved and green, as the human asked: ${JSON.stringify(words)}`;
      // Each line of the thread's log is JSON, so its quotes are escaped there.
      expect(read(join(data(), "threads", "app-12.log"))).toContain(`"why":${JSON.stringify(why)}`);
      await until(() => read(daemonLog()).includes(`app-12: ${why}`));
      await morePolls();
      expect(leadTyped()).not.toContain("approved and green");
      expect(leadTyped()).not.toContain("HUMAN_WORDS");

      // The plan and your words outlast a restart of the daemon.
      const first = running.splice(0, 1)[0];
      first?.kill();
      await first?.exited;
      serve();
      expect(thread()).toMatchObject({ merge_plan: "armed", merge_asked: words });

      // Green at the approved head, it merges, and the PR's record says the lead armed it.
      const head = pushed();
      pr({ head, reviews: [skelReview], checks: [approved] });
      await until(() => thread().status === "done");
      const record = asked(plugin).find(
        (q) => q.ask === "review" && String(q.body).startsWith("Merging when ready"),
      );
      expect(String(record?.body)).toStartWith(
        `Merging when ready, as asked by ${login()} via the lead on `,
      );
      expect(merges()[0]).toMatchObject({ pr: 7, commit: head });
      expect(thread().merge_asked).toBe(words);
    }, 90_000);

    // A forge shows a review's verdict, such as GitHub's "Approved.", so a task whose flow has no
    // review stage gets no record on the PR: nobody approved it. The merge still goes, at the
    // commit last submitted, once CI is green.
    test("a merge when ready of a task its flow didn't review posts no record on the PR", async () => {
      await approvedApp12();
      // The merge goes by the verdict saved on the task, as a no-review flow's submit saves it.
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      db.run("UPDATE tasks SET verdict = 'not reviewed', review_round = NULL WHERE task = 12");
      db.close();
      // Nobody will approve it, so neither the question nor the answer says so.
      const said = await runSkelInTerminal(
        socket,
        env(),
        ["merge", "--when-ready", "app-12"],
        "Merge #7 (app-12 Add export) when its checks pass?",
        "y",
      );
      expect(said).toContain(
        "Merging #7 as soon as its checks pass. sc merge --cancel app-12 stops it.",
      );
      await until(() =>
        leadTyped().includes(
          "Merging #7 (app-12) as soon as its checks pass, as you asked at your terminal.",
        ),
      );
      expect(leadTyped()).not.toContain("approved and green");
      const head = pushed();
      pr({ head, reviews: [], checks: [approved, check(5, "passed")] });
      await until(() => thread().status === "done");
      expect(merges()[0]).toMatchObject({ pr: 7, commit: head });
      const records = asked(plugin).filter(
        (q) => q.ask === "review" && String(q.body).startsWith("Merging"),
      );
      expect(records).toEqual([]);
    }, 90_000);

    test("an armed merge waits on a new push and failing CI, then merges the approved head", async () => {
      await approvedApp12();
      await arm();
      const head = pushed();
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      // A push nobody reviewed is never merged. A review is what it waits on, so the lead hears
      // nothing.
      pr({ head: "b".repeat(40), reviews: [skelReview], checks: [approved] });
      await until(() => thread().merge_waits === "a review of its newest commit");
      await morePolls();
      expect(leadTyped()).not.toContain("Still merging");
      // Failing CI waits on the builder, so the lead hears it, once a round.
      pr({ head, reviews: [skelReview], checks: [approved, check(5, "failed")] });
      await until(() => thread().merge_waits === "its failing checks to be fixed");
      await until(() =>
        leadTyped().includes(
          "Still merging #7 (app-12) once it's approved and green, waiting on its failing checks to be fixed.",
        ),
      );
      await morePolls();
      expect(merges()).toEqual([]);
      expect(thread().merge_plan).toBe("armed");
      expect(leadTyped().split("Still merging #7").length - 1).toBe(1);

      // Green at the approved head, it first posts a review on that commit saying who asked.
      // The forge decides whether it merges cleanly: a refusal keeps it armed, and says why.
      const records = () =>
        asked(plugin).filter(
          (q) => q.ask === "review" && String(q.body).startsWith("Merging when ready"),
        );
      // A forge that fails to merge, such as when it is down, keeps the plan armed and says why.
      answer(plugin, "merge pr", { refused: "Pull Request is not mergeable" });
      writeFileSync(join(plugin, "fail-merge-pr"), "GitHub is down");
      pr({ head, reviews: [skelReview], checks: [approved, check(6, "passed")] });
      await until(
        () => thread().merge_waits === "the forge, which failed: github failed: GitHub is down",
      );
      expect(thread()).toMatchObject({ merge_plan: "armed" });
      expect(thread().status).not.toBe("done");
      rmSync(join(plugin, "fail-merge-pr"));
      await until(
        () => thread().merge_waits === "the forge, which refused: Pull Request is not mergeable",
      );
      await morePolls();
      expect(thread().merge_plan).toBe("armed");
      expect(merges().length).toBeGreaterThan(1);
      expect(merges()[0]).toMatchObject({
        ask: "merge pr",
        repository: "simon/app",
        pr: 7,
        commit: head,
      });
      // The record is posted once for the plan, however often the forge fails or refuses.
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({ pr: 7, commit: head, verdict: "approve" });
      expect(String(records()[0]?.body)).toStartWith(
        `Merging when ready, as asked by ${login()} on `,
      );

      // Cancelled and armed again, the same commit is a new plan, with a record of its own. The
      // forge keeps refusing, so each poll asks it to merge again, and a cancel meanwhile is
      // refused. So the cancel goes while the next poll is held before it asks anything: the
      // polls before it, and their merges, are done by then.
      const cancel = { command: "merge cancel", repo: "app", task: "12" };
      rmSync(join(plugin, "held-changed"), { force: true });
      writeFileSync(join(plugin, "hold-changed"), "");
      await until(() => existsSync(join(plugin, "held-changed")));
      expect(await askOn(join(home, "run", "skelcrew.sock"), cancel)).toEqual({
        said: "app-12 won't merge by itself. It waits for you to merge it.",
      });
      expect(thread().merge_plan).toBeNull();
      rmSync(join(plugin, "hold-changed"));
      await arm();
      await until(() => records().length === 2);
      await morePolls();
      expect(records()).toHaveLength(2);

      // While the forge merges, a cancel is refused, as it could no longer stop the merge. The
      // forge is told to agree only once a merge is held. A merge asked before the hold ended
      // before the held one began, as one poll runs at a time, so none merges unheld.
      writeFileSync(join(plugin, "hold-merge-pr"), "");
      await until(() => existsSync(join(plugin, "held-merge-pr")));
      answer(plugin, "merge pr", null);
      expect(
        await askOn(join(home, "run", "skelcrew.sock"), {
          command: "merge cancel",
          repo: "app",
          task: "12",
        }),
      ).toEqual({ error: "app-12 is merging on its forge right now, so it can't be cancelled" });
      rmSync(join(plugin, "hold-merge-pr"));
      await until(() => thread().status === "done" && !existsSync(clone()));
      await until(() =>
        leadTyped().includes("app-12 is done: #7 merged into main when ready, as the human asked"),
      );
    }, 90_000);

    // CI on another PR means CI may still be starting on this one, so an approved PR with no CI
    // check waits for its first check, as a review does. CI that never shows, as on a docs-only
    // PR it skips with a paths filter, ends the wait: no CI runs on it, and it merges.
    test("a merge when ready waits for CI's first check, then merges a PR no CI runs on", async () => {
      await approvedApp12(undefined, 6_000);
      const head = pushed();
      await arm();
      // The wait starts once a poll sees the approved PR, with CI on another PR.
      const other = prItem("20", "Fix a typo", { base: "main", checks: [check(8, "passed")] });
      const pr7 = prItem("7", "Add export", { head, reviews: [skelReview], checks: [approved] });
      changes([issue12(), pr7, other]);
      await until(() => thread().merge_waits === "its checks");
      expect(merges()).toEqual([]);
      expect(thread()).toMatchObject({ needs_you: 0, no_ci: null });
      await until(() => merges().length === 1, 30_000);
      expect(merges()[0]).toMatchObject({ pr: 7, commit: head });
      expect(thread().no_ci).toBe(head);
      await until(() => thread().status === "done");
    }, 90_000);

    // Once the wait ended with no check, sc ps says "no CI" and the PR is ready. A check that
    // shows after that still counts: a failing one stops the merge.
    test("sc ps says no CI after the wait, and a check that fails later stops the merge", async () => {
      await approvedApp12(undefined, 1_000);
      const head = pushed();
      const other = prItem("20", "Fix a typo", { base: "main", checks: [check(8, "passed")] });
      const pr7 = (checks: object[]) =>
        prItem("7", "Add export", { head, reviews: [skelReview], checks });
      changes([issue12(), pr7([approved]), other]);
      await until(() => thread().no_ci === head && thread().needs_you === 1);
      const ps = () =>
        Bun.spawnSync([process.execPath, main, "ps"], {
          env: env(),
          stdout: "pipe",
        }).stdout.toString();
      expect(ps()).toContain("no CI");
      // CI shows late and fails, before the merge is armed.
      changes([issue12(), pr7([approved, check(9, "failed")]), other]);
      await until(() => thread().checks === "failing");
      expect(ps()).not.toContain("no CI");
      await arm();
      await until(() => thread().merge_waits === "its failing checks to be fixed");
      await morePolls();
      expect(merges()).toEqual([]);
      expect(thread().merge_plan).toBe("armed");
    }, 90_000);

    // The thread or its checks can change while the forge takes the record. The PR stays green
    // in Skelcrew's copy in each case below, so only the change itself can stop the merge.
    test("a failing check, a pending review or a stop while the record is posted stops the merge", async () => {
      await approvedApp12();
      const head = pushed();
      // CI passed too: once the check below fails, the repository has had CI, so a PR with only
      // Skelcrew's check would wait for CI rather than be green.
      const green = () =>
        pr({ head, reviews: [skelReview], checks: [approved, check(10, "passed")] });
      const sc = (...words: string[]) =>
        Bun.spawnSync([process.execPath, main, ...words], { env: env(), stderr: "pipe" });
      // Arms a new plan, which posts a record of its own, and holds that record.
      const holdRecord = async () => {
        rmSync(join(plugin, "held-review"), { force: true });
        writeFileSync(join(plugin, "hold-review"), "");
        await arm();
        green();
        await until(() => existsSync(join(plugin, "held-review")));
      };

      // A check that fails on the same commit: the merge acts on the checks the forge reports
      // after the record, so it waits for the check to be fixed.
      await holdRecord();
      pr({ head, reviews: [skelReview], checks: [approved, check(9, "failed")] });
      rmSync(join(plugin, "hold-review"));
      await until(() => thread().merge_waits === "its failing checks to be fixed");
      await morePolls();
      expect(merges()).toEqual([]);
      expect(thread().merge_plan).toBe("armed");
      // With a check failing, no poll asks the forge to merge, so the cancel is never refused.
      expect(sc("merge", "--cancel", "app-12").stderr.toString()).toBe("");

      // A pending review, with the PR green all along: the plan stays armed and waits for it.
      // Its record is posted and the forge refuses the merge first, so the plan is ready but
      // for the review, which is kept pending by holding its post on the PR. A review after the
      // first edits Skelcrew's review there first, so that is held too.
      answer(plugin, "merge pr", { refused: "Not yet" });
      await arm();
      green();
      await until(() => thread().merge_waits === "the forge, which refused: Not yet");
      writeFileSync(join(plugin, "hold-review"), "");
      writeFileSync(join(plugin, "hold-edit-review"), "");
      expect(sc("review", "app-12").stderr.toString()).toBe("");
      // A poll that began before the review can still be asking the forge to merge. The first
      // poll to wait on the review comes after it, as one poll runs at a time, so only then is
      // the count of merges asked settled, and the forge may agree.
      await until(() => thread().merge_waits === "its review");
      const tried = merges().length;
      answer(plugin, "merge pr", null);
      await morePolls();
      expect(thread().reviewing).not.toBeNull();
      expect(merges()).toHaveLength(tried);
      expect(thread().merge_plan).toBe("armed");
      // Once the review ends, the PR stops being green, so this phase merges nothing after it.
      pr({ head, reviews: [skelReview], checks: [{ ...approved, state: "running" }] });
      rmSync(join(plugin, "hold-review"));
      rmSync(join(plugin, "hold-edit-review"));
      await until(() => thread().reviewing === null && thread().submitting === null, 30_000);
      await morePolls();
      expect(merges()).toHaveLength(tried);

      // A stop, with the PR green: the plan stays armed, for when the thread starts again.
      // Its checks still run, so no merge is under way to refuse the cancel.
      expect(sc("merge", "--cancel", "app-12").stderr.toString()).toBe("");
      await holdRecord();
      expect(sc("stop", "app-12").stderr.toString()).toBe("");
      rmSync(join(plugin, "hold-review"));
      await morePolls();
      expect(merges()).toHaveLength(tried);
      expect(thread()).toMatchObject({ status: "stopped", merge_plan: "armed" });
    }, 150_000);

    // A review asked for while the record is posted keeps the plan waiting until it ends, with
    // the PR green all along. The review is kept pending by holding its pending check, so the
    // record can go through on its own.
    test("a review started while the record is posted holds the merge until it ends", async () => {
      await approvedApp12();
      const head = pushed();
      writeFileSync(join(plugin, "hold-review"), "");
      await arm();
      pr({ head, reviews: [skelReview], checks: [approved] });
      await until(() => existsSync(join(plugin, "held-review")));
      writeFileSync(join(plugin, "hold-status-pending"), "");
      const sc = Bun.spawnSync([process.execPath, main, "review", "app-12"], {
        env: env(),
        stderr: "pipe",
      });
      expect(sc.stderr.toString()).toBe("");
      await until(() => thread().reviewing !== null && existsSync(join(plugin, "held-status")));
      const reviewedAt = thread().review_at;
      // The record goes through while the review is still pending: nothing merges.
      rmSync(join(plugin, "hold-review"));
      await until(() => thread().merge_waits === "its review");
      await morePolls();
      expect(thread().reviewing).not.toBeNull();
      expect(merges()).toEqual([]);
      expect(thread().merge_plan).toBe("armed");
      // Once the review ends, approved, the next poll merges the approved commit.
      rmSync(join(plugin, "hold-status-pending"));
      await until(() => merges().length === 1, 30_000);
      expect(merges()[0]).toMatchObject({ pr: 7, commit: head });
      expect(thread().review_at).not.toBe(reviewedAt);
      await until(() => thread().status === "done");
    }, 120_000);

    // A poll asks the forge, then acts on its answer. A review that ends while the forge
    // answers makes that answer stale: the new round's checks may not be in it. The merge then
    // waits for a poll that began after the review.
    test("a review that ends while the forge answers a poll waits for the next poll", async () => {
      await approvedApp12();
      const head = pushed();
      const green = () => pr({ head, reviews: [skelReview], checks: [approved] });
      // The record is posted and the forge refuses the merge, so the plan is armed and ready.
      answer(plugin, "merge pr", { refused: "Not yet" });
      await arm();
      green();
      await until(() => thread().merge_waits === "the forge, which refused: Not yet");
      // A poll holds on the forge while a review runs and ends. The polls before it, and the
      // merges they asked, are done once it holds, as one poll runs at a time.
      rmSync(join(plugin, "held-changed"), { force: true });
      writeFileSync(join(plugin, "hold-changed"), "");
      await until(() => existsSync(join(plugin, "held-changed")));
      const tried = merges().length;
      const heldPoll = polls();
      const reviewedAt = thread().review_at;
      const sc = Bun.spawnSync([process.execPath, main, "review", "app-12"], {
        env: env(),
        stderr: "pipe",
      });
      expect(sc.stderr.toString()).toBe("");
      await until(() => thread().reviewing === null && thread().review_at !== reviewedAt, 30_000);
      // The poll is still held: no poll has asked since.
      expect(polls()).toBe(heldPoll);
      // The held poll gets the PR green, as it was before the review. Every later poll gets
      // its new check still running, which the forge would show for the new round.
      green();
      writeFileSync(
        join(plugin, "changed.once.json"),
        readFileSync(join(plugin, "changed.json"), "utf8"),
      );
      pr({ head, reviews: [skelReview], checks: [{ ...approved, state: "running" }] });
      answer(plugin, "merge pr", null);
      rmSync(join(plugin, "hold-changed"));
      await until(() => !existsSync(join(plugin, "changed.once.json")));
      await morePolls();
      expect(merges()).toHaveLength(tried);
      expect(thread().merge_plan).toBe("armed");
    }, 120_000);

    // A forge that fails to post the record says so on the plan it was posted for, never on a
    // plan cancelled meanwhile.
    test("a record that fails after the plan was cancelled leaves nothing behind", async () => {
      await approvedApp12();
      writeFileSync(join(plugin, "hold-review"), "");
      writeFileSync(join(plugin, "fail-review"), "GitHub is down");
      await arm();
      pr({ head: pushed(), reviews: [skelReview], checks: [approved] });
      await until(() => existsSync(join(plugin, "held-review")));
      const cancel = { command: "merge cancel", repo: "app", task: "12" };
      expect(await askOn(join(home, "run", "skelcrew.sock"), cancel)).toEqual({
        said: "app-12 won't merge by itself. It waits for you to merge it.",
      });
      rmSync(join(plugin, "hold-review"));
      await morePolls();
      expect(thread()).toMatchObject({ merge_plan: null, merge_waits: null });
      expect(merges()).toEqual([]);
      expect(leadTyped()).not.toContain("Still merging");
    }, 90_000);

    test("sc rm while the record is posted stops the merge and drops the plan", async () => {
      await approvedApp12();
      writeFileSync(join(plugin, "hold-review"), "");
      await arm();
      pr({ head: pushed(), reviews: [skelReview], checks: [approved] });
      await until(() => existsSync(join(plugin, "held-review")));
      const removing = Bun.spawn([process.execPath, main, "rm", "app-12"], {
        env: { ...env(), SKELCREW_SOCKET: leadSocket() },
        stderr: "pipe",
      });
      await until(() => thread().status === "stopped" || thread().status === "done");
      rmSync(join(plugin, "hold-review"));
      await removing.exited;
      await until(() => thread().status === "done");
      await morePolls();
      expect(merges()).toEqual([]);
      expect(thread().merge_plan).toBeNull();
    }, 90_000);

    test("an armed merge waits on a conflict, and once cancelled or its thread removed, never merges", async () => {
      await approvedApp12();
      await arm();
      // A conflict waits for the builder to fix it in a new round.
      pr({ head: pushed(), conflicts: true, reviews: [skelReview], checks: [approved] });
      await until(() => thread().merge_waits === "its conflict with main to be fixed");
      expect(merges()).toEqual([]);
      // The lead may cancel without asking, as cancelling is always safe.
      const cancel = { command: "merge cancel", repo: "app", task: "12" };
      expect(await askOn(leadSocket(), cancel)).toEqual({
        said: "app-12 won't merge by itself. It waits for you to merge it.",
      });
      expect(thread().merge_plan).toBeNull();
      pr({ head: pushed(), reviews: [skelReview], checks: [approved] });
      await morePolls();
      expect(merges()).toEqual([]);

      // Removing the thread disarms it. A green PR would merge two polls after arming, which
      // can come before sc rm, so the PR conflicts again and the plan waits on that.
      pr({ head: pushed(), conflicts: true, reviews: [skelReview], checks: [approved] });
      await arm();
      await until(() => thread().merge_waits === "its conflict with main to be fixed");
      expect(thread().merge_plan).toBe("armed");
      const removed = Bun.spawnSync([process.execPath, main, "rm", "app-12"], {
        env: { ...env(), SKELCREW_SOCKET: leadSocket() },
        stderr: "pipe",
      });
      expect(removed.stderr.toString()).toBe("");
      await until(() => thread().status === "done");
      expect(thread().merge_plan).toBeNull();
      expect(merges()).toEqual([]);
    }, 90_000);

    // Waiting on an approval, a builder's round being pushed or a review running needs nobody,
    // so the lead hears nothing, however many rounds it takes. Each phase is held open through
    // polls, so the merge is checked while it is under way.
    test("an armed merge sends the lead no note while its builder resubmits and its review runs", async () => {
      // The PR shows no CI, so the next round's review starts at once rather than waiting for
      // CI's first check on its commit.
      await changesApp12([]);
      await arm();
      await until(() => thread().merge_waits === "an approval");
      await morePolls();
      expect(leadTyped()).not.toContain("Still merging");
      // The forge holds the builder's push while a file is there, so the round stays submitting.
      const holdPush = join(home, "hold-push");
      const heldPush = join(home, "held-push");
      const hook = join(home, "github", "simon", "app.git", "hooks", "pre-receive");
      writeFileSync(
        hook,
        `#!/bin/sh\ntouch '${heldPush}'\nwhile [ -e '${holdPush}' ]; do sleep 0.1; done\n`,
      );
      chmodSync(hook, 0o755);
      writeFileSync(holdPush, "");
      // The review's pending check is held too, so the review stays running once it starts.
      writeFileSync(join(plugin, "hold-status-pending"), "");
      submitRound2();
      await until(() => existsSync(heldPush));
      await until(() => thread().merge_waits === "its review");
      await morePolls();
      expect(thread().submitting).not.toBeNull();
      expect(leadTyped()).not.toContain("Still merging");
      // The push goes through, and the review runs, held on its check.
      rmSync(holdPush);
      await until(
        () =>
          thread().submitting === null &&
          thread().reviewing !== null &&
          existsSync(join(plugin, "held-status")),
      );
      await morePolls();
      expect(thread().reviewing).not.toBeNull();
      expect(thread().merge_waits).toBe("its review");
      expect(leadTyped()).not.toContain("Still merging");
      // The reviewer asks for changes again, and the merge waits on an approval, quietly.
      rmSync(join(plugin, "hold-status-pending"));
      await until(
        () => thread().rounds === 2 && thread().submitting === null && thread().reviewing === null,
        30_000,
      );
      await until(() => thread().merge_waits === "an approval");
      await morePolls();
      expect(leadTyped()).not.toContain("Still merging");
      expect(thread().merge_plan).toBe("armed");
    }, 120_000);
  });
});
