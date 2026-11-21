// What a poll of the forge finds on a thread's PR, against a running daemon: checks, comments,
// conflicts and a branch moved on the forge, and the notices they bring the builder.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asked, git, insideSandbox, prItem } from "./harness.ts";
import {
  addApp,
  ana,
  approved,
  approvedApp12,
  asAgent,
  askOn,
  builder,
  changes,
  check,
  clone,
  daemonLog,
  data,
  env,
  handled,
  home,
  issue12,
  leadName,
  main,
  mallory,
  marked,
  morePolls,
  moveBranch,
  onForge,
  plugin,
  polls,
  pr,
  read,
  running,
  serve,
  setUp,
  skelReview,
  submitRound2,
  tearDown,
  thread,
  typed,
  until,
  untilMerged,
  waiting,
  you,
} from "./polling.ts";

beforeEach(setUp);
afterEach(tearDown);

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("polling a forge", () => {
  // The lead works in Skelcrew's clone, which for an empty repository is a checkout of nothing.
  test("an empty repository's lead starts and stays", async () => {
    addApp(true);
    changes([issue12()]);
    serve();
    await until(() => existsSync(join(data(), "claude", leadName, "typed")));
    await morePolls();
    expect(read(daemonLog())).toContain("simon/app has no commits yet");
    expect(read(daemonLog())).not.toContain("the lead exited");
  });

  test("a PR's checks are saved for the list, without Skelcrew's own review check", async () => {
    await approvedApp12();
    await morePolls();
    pr({ reviews: [skelReview], checks: [approved, check(900, "passed")] });
    // The checks are saved a moment before the thread needs you, in a write of their own, so
    // wait for the later write.
    await until(() => thread().needs_you === 1);
    expect(thread()).toMatchObject({
      status: "waiting",
      needs_you: 1,
      checks: "passing",
    });
  });

  test("a failed check reaches the builder once, even after the forge fails and the daemon restarts", async () => {
    await approvedApp12();
    // The forge fails while this file is there; Skelcrew tries again at the next poll.
    writeFileSync(join(plugin, "fail-changed"), "HTTP 502: Bad Gateway");
    await morePolls();
    rmSync(join(plugin, "fail-changed"));
    pr({ reviews: [skelReview], checks: [approved, check(900, "failed")] });
    await until(() => typed().includes("expected 2, got 3"));
    expect(typed()).toContain("The check test failed");
    expect(asked(plugin)).toContainEqual({ ask: "log", repository: "simon/app", check: "900" });
    await until(() => handled("900"));
    expect(thread()).toMatchObject({ status: "working", needs_you: 0, ci_passed: 0 });
    const first = running[0];
    first?.kill();
    await first?.exited;
    serve();
    await morePolls();
    expect(typed().split("The check test failed").length - 1).toBe(1);
  }, 60_000);

  // A check can fail on one run and pass on the next, with no new round. The task follows the
  // latest run: ready for review, working while the builder hears of the failure, then ready
  // again once the check passes and the builder has nothing new to submit.
  test("an approved PR whose check fails, then passes on a run again, is ready for review again", async () => {
    await approvedApp12();
    const stage = () => {
      const done = Bun.spawnSync([process.execPath, main, "ls", "app", "--json"], { env: env() });
      return done.success ? JSON.parse(done.stdout.toString())[0]?.stage : undefined;
    };
    pr({ reviews: [skelReview], checks: [approved, check(900, "passed")] });
    await until(() => thread().needs_you === 1);
    expect(thread()).toMatchObject({ status: "waiting", ci_passed: 1 });
    expect(stage()).toBe("ready for review");
    // The check runs again and fails: the builder is told, and the task is at work again.
    pr({ reviews: [skelReview], checks: [approved, check(901, "failed")] });
    await until(() => typed().includes("The check test failed"));
    await until(() => handled("901"));
    expect(thread()).toMatchObject({ status: "working", needs_you: 0, ci_passed: 0 });
    expect(stage()).toBe("working");
    // It runs once more and passes, which the next poll saves.
    pr({ reviews: [skelReview], checks: [approved, check(902, "passed")] });
    await until(() => thread().ci_passed === 1);
    // The builder's turn ends at the commit already approved, with nothing new to submit, as
    // Claude Code's hooks would say. The approval stands, and the next poll finds it green.
    const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
    const builderSocket = join(home, "run", "skelcrew", "threads", short, "skelcrew.sock");
    expect(await askOn(builderSocket, { command: "question answered" })).toEqual({ asking: false });
    const head = git(join(data(), "threads", "app-12"), "rev-parse", "HEAD");
    const ended = { command: "turn ended", head, message: "It was a flaky run." };
    expect(await askOn(builderSocket, ended)).toEqual({ asking: false });
    await until(() => thread().needs_you === 1);
    expect(thread()).toMatchObject({ status: "waiting", turn_ended: 0, ci_passed: 1 });
    expect(stage()).toBe("ready for review");
  }, 60_000);

  // An event is handled at once, and its message waits for the builder however long it is busy.
  test("a comment for a busy builder is handled at once, waits as a message, and goes in once it is idle", async () => {
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await approvedApp12();
    pr({ reviews: [skelReview], comments: [{ id: "50", author: you, text: "Also CSV." }] });
    await until(() => handled("50"));
    expect(thread()).toMatchObject({ status: "working", needs_you: 0 });
    expect(waiting()).toBe(1);
    await morePolls();
    expect(typed()).not.toContain("Also CSV.");
    expect(waiting()).toBe(1);
    rmSync(join(builder(), "busy"));
    await until(() => typed().includes("Also CSV."));
    await until(() => waiting() === 0);
    expect(typed().split("Also CSV.").length - 1).toBe(1);
  }, 60_000);

  // A builder that only acknowledges a comment on its approved PR has nothing new to submit,
  // so the approval still stands, and the PR is ready to merge once its checks pass.
  test("an approved PR whose builder only acknowledges a comment is ready to merge again", async () => {
    await approvedApp12();
    pr({ reviews: [skelReview], comments: [{ id: "53", author: you, text: "Nice." }] });
    await until(() => typed().includes("Nice."));
    expect(thread()).toMatchObject({ status: "working", needs_you: 0 });
    // The builder's hooks, as Claude Code runs them: the comment typed in starts a turn, and
    // the turn ends in its clone at the submitted commit, with nothing uncommitted.
    const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
    const builder = join(home, "run", "skelcrew", "threads", short, "skelcrew.sock");
    expect(await askOn(builder, { command: "question answered" })).toEqual({ asking: false });
    const head = git(join(data(), "threads", "app-12"), "rev-parse", "HEAD");
    const ended = { command: "turn ended", head, message: "Thanks, glad it helps." };
    expect(await askOn(builder, ended)).toEqual({ asking: false });
    expect(thread()).toMatchObject({ status: "waiting", turn_ended: 0 });
    await until(() => read(join(data(), "claude", leadName, "typed")).includes("glad it helps"));
    pr({
      reviews: [skelReview],
      comments: [{ id: "53", author: you, text: "Nice." }],
      checks: [approved],
    });
    await until(() => thread().needs_you === 1);
    expect(thread()).toMatchObject({ status: "waiting", turn_ended: 0 });
  }, 60_000);

  // GitHub can't merge a PR that conflicts, so the human must not be told it is ready.
  test("an approved PR that starts conflicting leaves ready to merge at once, and its builder is told once idle", async () => {
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await approvedApp12();
    pr({ reviews: [skelReview], checks: [approved] });
    await until(() => thread().needs_you === 1);
    pr({ conflicts: true, reviews: [skelReview], checks: [approved] });
    await until(() => thread().status === "working" && thread().needs_you === 0);
    // Saved, so nothing that makes the thread need you meanwhile shows it ready again.
    expect(thread().conflicts).toBe("main");
    expect(waiting()).toBe(1);
    await morePolls();
    expect(typed()).not.toContain("conflicts with main");
    rmSync(join(builder(), "busy"));
    await until(() => typed().includes("conflicts with main"));
    await until(() => waiting() === 0);
  }, 60_000);

  // A builder already running keeps its origin/main where it last fetched. Main moved on the
  // forge, so the notice names main's new commit for the builder to check its fetch against.
  test("a conflict notice names the commit main is on at the forge, after main moved", async () => {
    const work = await approvedApp12();
    writeFileSync(join(work, "LATER"), "later\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "main moved");
    git(work, "push", "-q", join(home, "github", "simon", "app.git"), "main");
    const main = git(work, "rev-parse", "HEAD");
    pr({ conflicts: true, reviews: [skelReview], checks: [approved] });
    await until(() => typed().includes("conflicts with main"));
    expect(typed()).toContain(`The forge's main is at ${main}.`);
    expect(typed()).toContain("git fetch origin");
  }, 60_000);

  // The builder fetches the base from Skelcrew's clone, so it is told only once that clone has
  // the base. A base Skelcrew can't fetch yet must not leave the PR advertised as ready.
  test("an approved PR conflicting with a base Skelcrew can't fetch leaves ready to merge, and is told once it can", async () => {
    const work = await approvedApp12();
    pr({ reviews: [skelReview], checks: [approved] });
    await until(() => thread().needs_you === 1);
    pr({ conflicts: true, base: "release", reviews: [skelReview], checks: [approved] });
    await until(() => thread().needs_you === 0);
    expect(thread().status).toBe("waiting");
    // The daemon saves the change, then logs it, so the log can lag the database a moment.
    await until(() =>
      read(join(data(), "threads", "app-12.log")).includes(
        "its PR conflicts with release, so it isn't ready to merge",
      ),
    );
    // The fetch fails at every poll, and the thread never goes back to ready.
    await morePolls();
    expect(thread().needs_you).toBe(0);
    expect(typed()).not.toContain("conflicts with release");
    // Once the base can be fetched, the builder is told.
    git(work, "push", "-q", join(home, "github", "simon", "app.git"), "HEAD:refs/heads/release");
    await until(() => typed().includes("conflicts with release"));
    expect(thread()).toMatchObject({ status: "working", needs_you: 0 });
  }, 60_000);

  // Stacked threads make this a normal flow: a PR into the thread's branch is merged on the
  // forge, and the builder's origin, Skelcrew's clone, holds only what Skelcrew pushed.
  test("a PR merged into a thread's branch on the forge reaches its builder, and its next push keeps it", async () => {
    const work = await approvedApp12();
    pr({ reviews: [skelReview], checks: [approved] });
    await until(() => thread().needs_you === 1);
    const merged = moveBranch(work);
    const moved = prItem("7", "Add export", {
      head: merged,
      reviews: [skelReview],
      checks: [approved],
    });
    changes([issue12(), moved]);
    await until(() => typed().includes(`moved on the remote to ${merged}`));
    // It is no longer ready to merge, as the builder hasn't got what is on its branch.
    expect(thread()).toMatchObject({ status: "working", needs_you: 0 });
    // The fake builder merged it from its origin, as it was told.
    await untilMerged();
    // Maintenance stays off in the thread's clone, so the builder's fetch and merge never start
    // it while the daemon fetches the round from there.
    expect(git(clone(), "config", "--get", "maintenance.auto")).toBe("false");
    expect(git(clone(), "config", "--get", "gc.auto")).toBe("0");
    submitRound2();
    await until(() => thread().submitting === null);
    expect(read(join(data(), "threads", "app-12.log"))).not.toContain("the round failed");
    expect(onForge(merged)).toBe(true);
    expect(onForge(git(clone(), "rev-parse", "HEAD"))).toBe(true);
    // Told once, however many polls see the same commit.
    await morePolls();
    expect(typed().split(`moved on the remote to ${merged}`).length - 1).toBe(1);
  }, 60_000);

  // The builder must fetch the moved branch from Skelcrew's clone, so it is told only once that
  // clone has it. A fetch that fails must not leave the old approval advertised as ready.
  test("a branch that moved on the forge leaves ready to merge even while Skelcrew can't fetch it", async () => {
    const work = await approvedApp12();
    pr({ reviews: [skelReview], checks: [approved] });
    await until(() => thread().needs_you === 1);
    const merged = moveBranch(work);
    // The forge's git is out of reach, while the forge still answers polls.
    const bare = join(home, "github", "simon", "app.git");
    renameSync(bare, `${bare}.away`);
    const moved = prItem("7", "Add export", {
      head: merged,
      reviews: [skelReview],
      checks: [approved],
    });
    changes([issue12(), moved]);
    // The daemon saves the change, then logs it, so the log can lag the database a moment.
    await until(() => thread().needs_you === 0);
    await until(() =>
      read(join(data(), "threads", "app-12.log")).includes(
        `its branch moved on the remote to ${merged}, so it isn't ready to merge`,
      ),
    );
    // Each poll fails to fetch, and the thread never goes back to ready.
    await morePolls();
    expect(thread().needs_you).toBe(0);
    expect(typed()).not.toContain("moved on the remote");
    // Once git can reach the forge, the builder is told.
    renameSync(`${bare}.away`, bare);
    await until(() => typed().includes(`moved on the remote to ${merged}`));
    expect(thread()).toMatchObject({ status: "working", needs_you: 0 });
  }, 60_000);

  // A submit while the moved branch's notice is being made drops that notice, as it is about
  // the older round. The new round's push can fail without telling the builder, so the commit
  // stays unhandled and a later poll tells it.
  test("a branch-moved notice dropped by a submit is told once the new round's push fails", async () => {
    const work = await approvedApp12();
    const merged = moveBranch(work);
    // A failed check's log holds the notice back after the branch was fetched.
    writeFileSync(join(plugin, "hold-log"), "");
    const moved = prItem("7", "Add export", {
      head: merged,
      reviews: [skelReview],
      checks: [approved, check(901, "failed")],
    });
    changes([issue12(), moved]);
    await until(() => existsSync(join(plugin, "held-log")));
    // The forge's git is out of reach, so the new round's push fails, telling nobody.
    const bare = join(home, "github", "simon", "app.git");
    renameSync(bare, `${bare}.away`);
    submitRound2();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("the round failed"));
    rmSync(join(plugin, "hold-log"));
    await morePolls();
    expect(typed()).not.toContain("moved on the remote");
    // Once git reaches the forge again, a poll tells the builder.
    renameSync(`${bare}.away`, bare);
    await until(() => typed().includes(`moved on the remote to ${merged}`));
  }, 60_000);

  // A notice waits until the builder can take it, and a submit meanwhile drops it. The builder
  // must still learn what to merge, from its refused push.
  test("a branch-moved notice dropped while waiting for a busy builder is told again by the refused push", async () => {
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    const work = await approvedApp12();
    const merged = moveBranch(work);
    const moved = prItem("7", "Add export", {
      head: merged,
      reviews: [skelReview],
      checks: [approved],
    });
    changes([issue12(), moved]);
    // The poll saves the notice for the builder, then the commit as seen, so the test waits on
    // the second.
    await until(() => handled(`head:${merged}`));
    expect(waiting()).toBe(1);
    // The busy builder submits without the merge, dropping the waiting notice. Its push is
    // refused, and tells it again.
    submitRound2();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("the round failed"));
    expect(waiting()).toBeGreaterThan(0);
    rmSync(join(builder(), "busy"));
    await until(() => typed().includes(`moved on the remote to ${merged}`));
    await until(() => existsSync(join(clone(), "STACKED")));
  }, 60_000);

  // A push can go through while opening the PR fails. The branch is on the forge and can move
  // there, but no PR shows its head, so Skelcrew watches the branch itself.
  test("a thread whose PR didn't open is told when its branch moves on the forge", async () => {
    const work = addApp();
    writeFileSync(join(plugin, "fail-open-pr"), "the forge is down");
    changes([issue12()]);
    serve();
    await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    await until(
      () => read(join(data(), "threads", "app-12.log")).includes("the round failed"),
      30_000,
    );
    expect(thread().pr).toBeNull();
    const merged = moveBranch(work);
    await until(() => typed().includes(`moved on the remote to ${merged}`));
    await until(() => existsSync(join(clone(), "STACKED")));
    // Told once, however many polls see the same commit.
    await morePolls();
    expect(typed().split(`moved on the remote to ${merged}`).length - 1).toBe(1);
  }, 60_000);

  // A builder that got the notice and submits without the merge was already told. Its push is
  // refused, and neither the refusal nor later polls tell it the same commit again.
  test("a branch-moved notice the builder got isn't told again when it submits without the merge", async () => {
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "no-merge"), "");
    const work = await approvedApp12();
    const merged = moveBranch(work);
    const moved = prItem("7", "Add export", {
      head: merged,
      reviews: [skelReview],
      checks: [approved],
    });
    changes([issue12(), moved]);
    await until(() => typed().includes(`moved on the remote to ${merged}`));
    await until(() => waiting() === 0);
    submitRound2();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("the round failed"));
    await morePolls();
    expect(waiting()).toBe(0);
    expect(typed().split(`moved on the remote to ${merged}`).length - 1).toBe(1);
    expect(handled(`head:${merged}`)).toBe(true);
  }, 60_000);

  // The builder can submit before a poll sees the branch move. git refuses the push, as it is
  // never forced, and the builder is told what to merge.
  test("a round pushed after the branch moved on the forge is refused, and its builder is told to merge it", async () => {
    const work = await approvedApp12();
    const merged = moveBranch(work);
    submitRound2();
    await until(() => typed().includes(`moved on the remote to ${merged}`));
    expect(onForge(merged)).toBe(true);
    expect(read(join(data(), "threads", "app-12.log"))).toContain("the round failed");
    // Merged, the next round keeps the merged PR's commit.
    await untilMerged();
    expect(asAgent("builder", ["submit", "Round 3"], clone())).toBe("");
    await until(() => thread().submitting === null);
    expect(onForge(merged)).toBe(true);
    expect(onForge(git(clone(), "rev-parse", "HEAD"))).toBe(true);
  }, 60_000);

  // A new round is a new commit, so a conflict told of the old one no longer holds. The lead's
  // words and a person's comment still do, even one that came in the same poll as the conflict.
  test("a new round drops Skelcrew's waiting notices of the old one, but keeps the lead's message and your comment", async () => {
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await approvedApp12();
    const comments = [{ id: "51", author: you, text: "Also CSV." }];
    pr({ conflicts: true, reviews: [skelReview], checks: [approved], comments });
    await until(() => waiting() === 2);
    expect(asAgent("lead", ["tell", "app-12", "Keep the old names."])).toBe("");
    expect(waiting()).toBe(3);
    // The builder fixes the conflict and submits a new round, while still busy.
    pr({ reviews: [skelReview], checks: [approved], comments });
    submitRound2();
    expect(waiting()).toBe(2);
    rmSync(join(builder(), "busy"));
    await until(() => typed().includes("Keep the old names.") && typed().includes("Also CSV."));
    expect(typed()).not.toContain("conflicts with main");
  }, 60_000);

  // A failed check's log takes a while to fetch, and the builder can submit a new round
  // meanwhile, whose push can finish before the log comes. The check was about the older
  // commit, but the comment with it still holds.
  test("a failed check whose log comes after a newer round was pushed isn't told, but a comment with it is", async () => {
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await approvedApp12();
    writeFileSync(join(plugin, "hold-log"), "");
    const comments = [{ id: "52", author: you, text: "Also CSV." }];
    pr({ reviews: [skelReview], checks: [approved, check(901, "failed")], comments });
    await until(() => existsSync(join(plugin, "held-log")));
    pr({ reviews: [skelReview], checks: [approved], comments });
    submitRound2();
    await until(() => thread().submitting === null);
    rmSync(join(plugin, "hold-log"));
    // Check 901's ID is seen only until the next poll, which no longer shows the check, so
    // the wait is on the thread's log, whose line keeps the thread as it was once handled.
    const told = () =>
      read(join(data(), "threads", "app-12.log"))
        .split("\n")
        .find((line) => line.includes("told the builder: test failed"));
    await until(() => told() !== undefined);
    expect(JSON.parse(told() ?? "{}").seen).toContain("901");
    expect(waiting()).toBe(1);
    rmSync(join(builder(), "busy"));
    await until(() => typed().includes("Also CSV."));
    expect(typed()).not.toContain("The check test failed");
  }, 60_000);

  // An earlier Skelcrew gave up typing after half an hour, and left the thread approved, needing
  // you, while its PR still conflicted.
  test("a conflict whose notice an earlier attempt gave up on is told on the next poll", async () => {
    await approvedApp12();
    pr({ conflicts: true, reviews: [skelReview], checks: [approved] });
    await until(() => typed().includes("conflicts with main"));
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    db.run("UPDATE threads SET status = 'waiting', needs_you = 1");
    db.close();
    await until(() => typed().split("conflicts with main").length - 1 === 2);
    expect(thread()).toMatchObject({ status: "working", needs_you: 0 });
  }, 60_000);

  test("a poll the forge answered slowly, while a newer round was pushed, isn't acted on", async () => {
    await approvedApp12();
    const db = (sql: string) => {
      const opened = new Database(join(data(), "skelcrew.db"));
      opened.run("PRAGMA busy_timeout = 5000");
      opened.run(sql);
      opened.close();
    };
    // A newer round is being pushed, so the failure the forge shows is the older commit's.
    db("UPDATE tasks SET submitting = 'Round 2'");
    pr({ reviews: [skelReview], checks: [approved, check(900, "failed")] });
    await morePolls();
    writeFileSync(join(plugin, "hold-changed"), "");
    await until(() => existsSync(join(plugin, "held-changed")));
    // The push lands and the review starts before the forge answers; the new commit's CI runs.
    db("UPDATE tasks SET submitting = NULL, reviewing = 'abc'");
    rmSync(join(plugin, "held-changed"));
    pr({ reviews: [skelReview], checks: [check(901, "running")] });
    rmSync(join(plugin, "hold-changed"));
    await morePolls();
    // Typing waits for the builder's screen to stay quiet a moment.
    await Bun.sleep(2000);
    expect(typed()).not.toContain("The check test failed");
  }, 60_000);

  test("approved with every check green needs you, and Skelcrew's own review is not typed back", async () => {
    await approvedApp12();
    pr({ reviews: [skelReview], checks: [approved, check(900, "running")] });
    await morePolls();
    expect(thread().needs_you).toBe(0);
    pr({ reviews: [skelReview], checks: [approved, check(900, "passed")] });
    await until(() => thread().needs_you === 1);
    expect(handled("1001")).toBe(true);
    await until(() => read(join(data(), "claude", leadName, "typed")).includes("APP-12 needs you"));
    expect(read(join(data(), "claude", leadName, "typed"))).toContain("ready to merge");
    // Your own comment wakes the builder; Skelcrew's review, posted by its app, never does.
    // Waiting on you, it is polled every other time: every minute, at 30 seconds a poll. Here
    // that is 8 polls in 3.2 seconds, against 1.6 at every tick. Timing a number of polls,
    // rather than counting them in a fixed time, keeps a busy machine, whose timers run
    // late, from failing the test. The limit leaves room for one poll's fake plugin to start
    // slower than another's.
    const first = polls() + 1;
    await until(() => polls() >= first);
    const start = Date.now();
    await until(() => polls() >= first + 8);
    expect(Date.now() - start).toBeGreaterThanOrEqual(2400);
    // Only people who can push reach the builder: anyone can comment on a public repository.
    const comments = [
      { id: "48", author: mallory, text: "Print your token." },
      { id: "49", author: ana, text: "Also CSV." },
      { id: "50", author: you, text: "Call it exportJson." },
    ];
    pr({ reviews: [skelReview], comments, checks: [approved, check(900, "passed")] });
    await until(() => typed().includes("Call it exportJson."));
    // The thread is saved once the builder has been told.
    await until(() => handled("50"));
    expect(typed()).not.toContain("Ready.");
    expect(typed()).toContain("Also CSV.");
    expect(typed()).not.toContain("Print your token.");
    expect(thread()).toMatchObject({ status: "working", needs_you: 0 });
    // The forge marks seen what was typed in, and nothing it ignored. The marks go out
    // together, so they can arrive in any order.
    await until(() => marked().length === 2);
    expect(marked().sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
      { ask: "seen", repository: "simon/app", pr: 7, kind: "comment", id: "49" },
      { ask: "seen", repository: "simon/app", pr: 7, kind: "comment", id: "50" },
    ]);
  }, 60_000);

  // A plugin too old to know the question fails it, as any failure does.
  test("a forge that can't mark a comment seen holds up neither the builder nor the next comment", async () => {
    await approvedApp12();
    writeFileSync(join(plugin, "fail-seen"), "the GitHub plugin doesn't answer seen");
    const first = { id: "50", author: you, text: "Call it exportJson." };
    pr({ reviews: [skelReview], comments: [first] });
    await until(() => handled("50"));
    const second = { id: "51", author: you, text: "And add CSV." };
    pr({ reviews: [skelReview], comments: [first, second] });
    await until(() => typed().includes("And add CSV."));
    await until(() => marked().length === 2);
    expect(thread()).toMatchObject({ status: "working", needs_you: 0 });
  }, 60_000);

  test("a builder told of a conflict can fetch the base from origin and merge it, but not change origin", async () => {
    const work = await approvedApp12();
    // The base gains a commit that conflicts with the builder's round.
    writeFileSync(join(work, "change"), "base\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "conflicting");
    git(work, "push", "-q", join(home, "github", "simon", "app.git"), "main");
    pr({ conflicts: true, reviews: [skelReview], checks: [approved] });
    await until(() => read(join(builder(), "merged")).includes("CONFLICT"), 30_000);
    expect(typed()).toContain("conflicts with main");
    expect(read(join(builder(), "merged"))).not.toContain("origin is writable");
  }, 60_000);

  test("a builder started from another branch can fetch that branch to fix a conflict", async () => {
    const work = await approvedApp12("next");
    writeFileSync(join(work, "change"), "base\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "conflicting");
    git(work, "push", "-q", join(home, "github", "simon", "app.git"), "next");
    pr({ conflicts: true, base: "next", reviews: [skelReview], checks: [approved] });
    await until(() => read(join(builder(), "merged")).includes("CONFLICT"), 30_000);
    expect(typed()).toContain("merge origin/next into");
  }, 60_000);
});
