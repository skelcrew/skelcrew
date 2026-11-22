// When a round or a review can't go on, against a running daemon: the round limit, a review that
// fails, a push refused, Codex's usage limit, and a review past its time limit.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { answer, asked, git, insideSandbox, read, source, until as waitFor } from "./harness.ts";
import {
  addApp,
  builder,
  builderSocket,
  clone,
  codexHome,
  config,
  data,
  env,
  finished,
  github,
  home,
  lead,
  plugin,
  pushed,
  pushedRound,
  reviews,
  running,
  script,
  setUp,
  skel,
  socket,
  startApp12,
  statuses,
  tearDown,
  thread,
  typedMessages,
  until,
  untilReviewSaved,
  verdict,
} from "./submit.ts";

beforeEach(setUp);
afterEach(tearDown);

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("sc submit", () => {
  // max_rounds counts rounds of review and fixes, so with 2 the builder submits 3 times.
  test("after max_rounds rounds of changes and fixes, the thread needs you and the builder hears no more", async () => {
    addApp();
    config("max_rounds: 2\n");
    verdict(1, "changes", "First problem.");
    verdict(2, "changes", "Second problem.");
    verdict(3, "changes", "Third problem.");
    verdict(4, "approve", "A fourth review should never run.");
    await startApp12();
    await until(() => finished("failure").length === 3, 45_000);
    await until(() => thread().needs_you === 1);
    await Bun.sleep(1500);
    expect(typedMessages()).toBe(2);
    expect(read(join(builder(), "typed"))).not.toContain("Third problem.");
    expect(reviews()).toHaveLength(3);
    expect(thread()).toMatchObject({ status: "waiting", needs_you: 1, rounds: 3 });
    await until(() =>
      read(join(lead(), "typed")).includes("APP-12 needs you: changes asked for after 2 rounds"),
    );
  }, 90_000);

  test("sc start on a thread past the round limit lets it go on with the last review's changes", async () => {
    addApp();
    config("max_rounds: 1\n");
    verdict(1, "changes", "First problem.");
    verdict(2, "changes", "Second problem.");
    verdict(3, "approve", "Ready to merge.");
    await startApp12();
    await until(() => thread().needs_you === 1 && thread().rounds === 2, 45_000);
    expect(read(join(builder(), "typed"))).not.toContain("Second problem.");
    // Naming the flow it runs already is no switch, though its builder has submitted: a short
    // title is given as without --flow, and the thread still needs you.
    const short = await skel(["start", "app-12", "--flow", "default", "--short", "Export"]);
    expect(short.err).toBe("");
    expect(short.out).toBe('Gave APP-12 the short title "Export".\n');
    expect(thread()).toMatchObject({ needs_you: 1, rounds: 2 });
    const started = await skel(["start", "app-12", "--flow", "default"]);
    expect(started.err).toBe("");
    expect(started.out).toContain("APP-12 goes on");
    await until(() => read(join(builder(), "typed")).includes("Second problem."), 30_000);
    await until(() => finished("success").length === 1, 30_000);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(thread()).toMatchObject({ status: "waiting", needs_you: 0, rounds: 1 });
  }, 90_000);

  // Each sc start decides only the review that reached the limit: the next review asking for
  // changes needs you again. The rounds' own numbers, on the PR's review and in sc ps, only go up.
  test("sc start past the round limit, again and again, never takes the round number back", async () => {
    addApp();
    config("max_rounds: 1\n");
    answer(plugin, "edit review", { edited: true });
    verdict(1, "changes", "First problem.");
    verdict(2, "changes", "Second problem.");
    verdict(3, "changes", "Third problem.");
    verdict(4, "approve", "Ready to merge.");
    const ps = async () => JSON.parse((await skel(["ps", "--json"])).out)[0];
    await startApp12();
    await until(() => finished("failure").length === 2 && thread().needs_you === 1, 45_000);
    expect(thread()).toMatchObject({ rounds: 2, review_round: 2 });
    expect((await skel(["start", "app-12"])).out).toContain("APP-12 goes on");
    expect(await ps()).toMatchObject({ needsYou: false });
    // The very next review asking for changes is held, and needs you again.
    await until(() => finished("failure").length === 3 && thread().needs_you === 1, 60_000);
    expect(read(join(builder(), "typed"))).toContain("Second problem.");
    expect(read(join(builder(), "typed"))).not.toContain("Third problem.");
    expect(thread()).toMatchObject({ rounds: 2, review_round: 3 });
    expect(await ps()).toMatchObject({ needsYou: true, needsYouFor: "round limit" });
    expect((await skel(["start", "app-12"])).out).toContain("APP-12 goes on");
    await until(() => finished("success").length === 1, 60_000);
    await untilReviewSaved();
    expect(thread()).toMatchObject({ needs_you: 0, rounds: 1, review_round: 4, held: null });
    // The PR's one review said each round's number in turn.
    const posted = asked(plugin)
      .filter((q) => q.ask === "review" || q.ask === "edit review")
      .map((q) => /^Round (\d+)/.exec(String(q.body))?.[1]);
    expect(posted).toEqual(["1", "2", "3", "4"]);
  }, 240_000);

  // The lead's item on the thread already asks you about it as the next review reaches the
  // limit. A new review is news all the same, so the lead still hears of the limit, each time.
  test("a review reaching the round limit tells the lead though its item on the thread is open", async () => {
    addApp();
    config("max_rounds: 1\n");
    verdict(1, "changes", "First problem.");
    verdict(2, "changes", "Second problem.");
    verdict(3, "changes", "Third problem.");
    await startApp12();
    await until(() => thread().needs_you === 1 && thread().rounds === 2, 45_000);
    const reached = "APP-12 needs you: changes asked for after 1 rounds of changes";
    await until(() => read(join(lead(), "typed")).includes(reached));
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("PRAGMA busy_timeout = 5000");
    db.run(
      "INSERT INTO asks (owner, repo, task, text, options, posted) VALUES ('simon', 'app', '12', 'Go on past the limit?', '[\"yes\",\"no\"]', 0)",
    );
    db.close();
    expect((await skel(["review", "app-12"])).err).toBe("");
    await until(() => finished("failure").length === 3, 30_000);
    await until(() => read(join(lead(), "typed")).split(reached).length - 1 === 2, 30_000);
  }, 90_000);

  test("a review that fails sets the check to review failed, posts nothing, and tells the lead", async () => {
    addApp();
    await startApp12();
    await until(() => finished("failure").length === 1, 30_000);
    expect(finished("failure")[0]?.description).toBe("review failed");
    await until(() => thread().review_failed === 1);
    expect(thread().needs_you).toBe(0);
    expect(reviews()).toEqual([]);
    expect(typedMessages()).toBe(0);
    // The daemon saves a thread before it appends the thread to its log.
    await until(() =>
      read(join(data(), "threads", "app-12.log")).includes("no verdict for review 1"),
    );
  }, 60_000);

  // GitHub refuses a push from Skelcrew's app that changes a workflow file. Here the fake GitHub
  // refuses the first round's commit with GitHub's words, and takes the next.
  test("a push refused for a workflow file says which file to the lead and the builder, and the next submit goes through", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    const hook = join(github(), "simon", "app.git", "hooks", "pre-receive");
    writeFileSync(
      hook,
      `while read old new ref; do
  if [ "$(git show "$new:change" 2>/dev/null)" = 1 ]; then
    echo 'refusing to allow a GitHub App to create or update workflow \`.github/workflows/ci.yml\` without \`workflows\` permission' >&2
    exit 1
  fi
done`,
    );
    chmodSync(hook, 0o755);
    const said =
      "APP-12's push was refused: it changes .github/workflows/ci.yml, which Skelcrew can't push. Undo that change, or a person must make it.";
    await startApp12();
    // The note reaches the lead a piece at a time, so the test waits for all of it.
    await until(() => read(join(lead(), "typed")).includes(said), 30_000);
    await until(() => read(join(builder(), "typed")).includes(said));
    // The builder answers with a second round, which GitHub takes and the reviewer approves.
    await until(() => finished("success").length === 1, 30_000);
    expect(pushedRound()).toBe("2");
    expect(thread()).toMatchObject({ needs_you: 0 });
  }, 60_000);

  // codex exec echoes its prompt before it works, so the end of what it printed is the task.
  test("a failed review's note says the reviewer's own error, never the task it echoed", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "error-1"), "ERROR: stream disconnected before completion\n");
    await startApp12();
    await until(() => thread().review_failed === 1, 30_000);
    // The note reaches the lead a piece at a time, so the test waits for all of it.
    const said =
      "APP-12's review failed: codex exited with 1: stream disconnected before completion. sc review APP-12 runs it again.";
    await until(() => read(join(lead(), "typed")).includes(said));
    expect(read(join(lead(), "typed"))).not.toContain("Add export");
  }, 60_000);

  test("a review that meets Codex's usage limit is held without needing you, and no other review starts on Codex until the reset", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(
      join(codexHome(), "error-1"),
      "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Dec 31st, 2099 11:59 PM.\n",
    );
    await startApp12();
    await until(() => thread().review_limited === 1, 30_000);
    expect(thread()).toMatchObject({
      status: "waiting",
      needs_you: 0,
      review_reset: new Date(2099, 11, 31, 23, 59).getTime(),
    });
    expect(thread().reviewing).not.toBeNull();
    // The check stays pending, nothing is posted, and the builder hears nothing.
    expect(statuses().map((s) => s.state)).toEqual(["pending"]);
    expect(reviews()).toEqual([]);
    expect(typedMessages()).toBe(0);
    const told = "Codex's usage limit is reached until 31 Dec 23:59; reviews resume then.";
    await until(() => read(join(lead(), "typed")).includes(told));

    // A newer submit's review is held on the same limit, without running Codex, and the lead
    // isn't told again.
    writeFileSync(join(clone(), "change"), "newer\n");
    git(clone(), "commit", "-qam", "newer");
    const again = await skel(["submit", "Newer"], { SKELCREW_SOCKET: builderSocket() });
    expect(again.err).toBe("");
    const newer = git(clone(), "rev-parse", "HEAD");
    await until(() => thread().reviewing === newer && thread().review_limited === 1, 30_000);
    await Bun.sleep(1000);
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("1");
    expect(read(join(lead(), "typed")).split(told).length - 1).toBe(1);
    expect(read(join(lead(), "typed"))).not.toContain("needs you");
  }, 60_000);

  test("while Codex is limited, reviews run on the fallback, and say so", async () => {
    addApp();
    writeFileSync(
      join(home, ".config", "skelcrew", "config.yaml"),
      "harness: claude\nreviewer: { harness: codex, fallback: claude }\n",
    );
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(
      join(codexHome(), "error-1"),
      "ERROR: You've hit your usage limit. Try again at Dec 31st, 2099 11:59 PM.\n",
    );
    await startApp12();
    await until(() => finished("success").length === 1, 30_000);
    expect(reviews()).toEqual([
      {
        commit: pushed(),
        verdict: "approve",
        body: "This review ran on Claude Code, as Codex reached its usage limit.\n\nReady to merge.",
      },
    ]);
    await untilReviewSaved();
    expect(thread()).toMatchObject({ reviewed_by: "claude", review_limited: 0, needs_you: 0 });
    await until(() =>
      read(join(lead(), "typed")).includes(
        "Codex's usage limit is reached until 31 Dec 23:59; reviews run on Claude Code until then.",
      ),
    );
  }, 60_000);

  test("a review held on a usage limit runs again by itself once the limit resets", async () => {
    addApp();
    writeFileSync(
      join(home, ".config", "skelcrew", "config.yaml"),
      "harness: claude\nreviewer: { harness: claude }\n",
    );
    // Each review meets the limit until the test lifts it, so the first one does, however
    // slowly the builder starts. The limit is lifted as soon as Skelcrew holds the review,
    // and a review that runs before then meets it once more.
    writeFileSync(join(home, "bin", "claude-limit"), "limit");
    const started = Date.now();
    await startApp12();
    await until(() => thread().review_limited === 1, 30_000);
    expect(thread()).toMatchObject({ needs_you: 0 });
    expect(Number(thread().review_reset)).toBeGreaterThan(started);
    writeFileSync(join(home, "bin", "claude-limit"), "done");
    await until(() => finished("success").length === 1, 30_000);
    await untilReviewSaved();
    expect(thread()).toMatchObject({ review_limited: 0, review_reset: null, needs_you: 0 });
    expect(reviews()).toEqual([{ commit: pushed(), verdict: "approve", body: "Ready to merge." }]);
    await until(() =>
      read(join(lead(), "typed")).includes(
        "Claude Code's usage limit is over; reviews run on it again.",
      ),
    );
    expect(read(join(lead(), "typed"))).toContain("Claude Code's usage limit is reached until");
  }, 90_000);

  test("a review that runs past its time limit is ended and run once more, and the lead hears of it", async () => {
    addApp();
    config("review: { timeout_minutes: 0.1 }\n");
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    verdict(2, "approve", "Ready to merge.");
    await startApp12();
    await until(() => finished("success").length === 1, 30_000);
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("2");
    const log = read(join(data(), "threads", "app-12.log"));
    expect(log).toContain("APP-12's review timed out after 0.1m; retrying");
    await until(() =>
      read(join(lead(), "typed")).includes("APP-12's review timed out after 0.1m; retrying"),
    );
    await untilReviewSaved();
    expect(thread()).toMatchObject({ needs_you: 0, verdict: "approve" });
  }, 60_000);

  test("a review ended at its time limit while its sc check runs frees the check slot", async () => {
    addApp();
    // The suite ends at once in your checkout, which has the file here, and in the reviewer's
    // sandbox runs until something ends it. One slot, so your check waits for the review's.
    const suite = "if [ -e here ]; then touch started; else sleep 600; fi";
    config(
      `review: { timeout_minutes: 0.2 }\nlimits: { checks: 1 }\nrepos: { simon/app: { test: [${JSON.stringify(suite)}] } }\n`,
    );
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "check-1"), "");
    verdict(2, "approve", "Ready to merge.");
    await startApp12();
    await waitFor(
      async () => (await skel(["ps"])).out.includes("APP-12/reviewer holds a check slot"),
      {
        timeout: 30_000,
      },
    );
    // Your own checkout of app, by its remote, runs sc check meanwhile.
    const mine = join(home, "mine");
    mkdirSync(mine);
    git(mine, "init", "-q");
    git(mine, "remote", "add", "origin", "https://github.com/simon/app.git");
    writeFileSync(join(mine, "here"), "");
    const yours = Bun.spawn([process.execPath, source("main.ts"), "check"], {
      cwd: mine,
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Stopped if the test fails before it ends, and its suite with it.
    try {
      const said = new Response(yours.stdout).text();
      // Ending the review ends its check, so yours starts rather than waiting for the suite.
      expect(await yours.exited).toBe(0);
      expect(await said).toContain("number 1 in line");
      expect(existsSync(join(mine, "started"))).toBe(true);
    } finally {
      yours.kill();
      await yours.exited;
    }
    await until(() =>
      read(join(data(), "threads", "app-12.log")).includes("APP-12's review timed out"),
    );
    await until(() => finished("success").length === 1, 30_000);
    expect((await skel(["ps"])).out).not.toContain("check slot");
  }, 90_000);

  // Runs sc check as an agent would, on the given socket, in a folder of its own, from outside
  // the agent's sandbox, so its process runs on after the agent ends. The suite runs until the
  // test ends it.
  function checkOn(agentSocket: string) {
    const folder = join(home, "checking");
    mkdirSync(folder, { recursive: true });
    const run = Bun.spawn([process.execPath, source("main.ts"), "check"], {
      cwd: folder,
      env: { ...env(), SKELCREW_SOCKET: agentSocket },
      stdout: "ignore",
      stderr: "ignore",
    });
    running.push(run);
    return run;
  }
  const holds = async (who: string) =>
    (await skel(["ps"])).out.includes(`${who} holds a check slot`);

  test("a thread stopped while its reviewer holds a check slot gives the slot back", async () => {
    addApp();
    config(`repos: { simon/app: { test: ["sleep 600"] } }\n`);
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
    const check = checkOn(join(home, "run", "skelcrew", "reviews", short, "skelcrew.sock"));
    await waitFor(() => holds("APP-12/reviewer"), { timeout: 30_000 });
    // While the review runs, its reviewer keeps the slot, past the daemon's next look.
    await Bun.sleep(6000);
    expect(await holds("APP-12/reviewer")).toBe(true);
    expect((await skel(["stop", "app-12"])).err).toBe("");
    await waitFor(async () => !(await holds("APP-12/reviewer")), { timeout: 30_000 });
    expect(await check.exited).toBe(1);
    expect(read(join(home, "daemon.log"))).toContain(
      "APP-12/reviewer gave back a check slot in simon/app: its review has ended",
    );
  }, 90_000);

  test("a builder's check slot is given back once its thread is stopped, though its sc check runs on", async () => {
    addApp();
    config(`repos: { simon/app: { test: ["sleep 600"] } }\n`);
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    await startApp12();
    await until(() => thread().status === "waiting", 30_000);
    const check = checkOn(builderSocket());
    await waitFor(() => holds("APP-12/builder"), { timeout: 30_000 });
    expect((await skel(["stop", "app-12"])).err).toBe("");
    await waitFor(async () => !(await holds("APP-12/builder")), { timeout: 30_000 });
    expect(await check.exited).toBe(1);
    expect(read(join(home, "daemon.log"))).toContain(
      "APP-12/builder gave back a check slot in simon/app: its builder has ended",
    );
  }, 90_000);

  test("a reviewer's check slot is given back once its process ends, though its sc check runs on", async () => {
    addApp();
    config(`repos: { simon/app: { test: ["sleep 600"] } }\n`);
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
    const check = checkOn(join(home, "run", "skelcrew", "reviews", short, "skelcrew.sock"));
    await waitFor(() => holds("APP-12/reviewer"), { timeout: 30_000 });
    writeFileSync(join(codexHome(), "sessions", "go-1"), "");
    await waitFor(async () => !(await holds("APP-12/reviewer")), { timeout: 30_000 });
    expect(await check.exited).toBe(1);
    expect(read(join(home, "daemon.log"))).toContain(
      "APP-12/reviewer gave back a check slot in simon/app: its review has ended",
    );
  }, 90_000);

  test("a builder killed while its sc check runs on gives its check slot back", async () => {
    addApp();
    config(`repos: { simon/app: { test: ["sleep 600"] } }\n`);
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    await startApp12();
    await until(() => thread().status === "waiting", 30_000);
    const check = checkOn(builderSocket());
    await waitFor(() => holds("APP-12/builder"), { timeout: 30_000 });
    // Its session ends with no word to Skelcrew, and the thread still waits.
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    await waitFor(async () => !(await holds("APP-12/builder")), { timeout: 30_000 });
    expect(await check.exited).toBe(1);
    expect(read(join(home, "daemon.log"))).toContain(
      "APP-12/builder gave back a check slot in simon/app: its builder has ended",
    );
  }, 90_000);

  test("a builder's check slot is given back once its thread is removed, though its sc check runs on", async () => {
    addApp();
    config(`repos: { simon/app: { test: ["sleep 600"] } }\n`);
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    await startApp12();
    await until(() => thread().status === "waiting", 30_000);
    const check = checkOn(builderSocket());
    await waitFor(() => holds("APP-12/builder"), { timeout: 30_000 });
    expect((await skel(["rm", "app-12", "--keep-issue"])).err).toBe("");
    await waitFor(async () => !(await holds("APP-12/builder")), { timeout: 30_000 });
    expect(await check.exited).toBe(1);
    expect(read(join(home, "daemon.log"))).toContain(
      "APP-12/builder gave back a check slot in simon/app: its builder has ended",
    );
  }, 90_000);

  test("a builder restarted while its sc check runs on gives the old builder's slot back", async () => {
    addApp();
    config(`repos: { simon/app: { test: ["sleep 600"] } }\n`);
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    await startApp12();
    await until(() => thread().status === "waiting", 30_000);
    const check = checkOn(builderSocket());
    await waitFor(() => holds("APP-12/builder"), { timeout: 30_000 });
    // The new builder runs in a session of the same name, and must not keep the old one's slot.
    const restarted = await new Promise<string>((done) => {
      const connection = createConnection(join(home, "run", "skelcrew.sock"));
      let reply = "";
      connection.on("error", () => {});
      connection.on("connect", () =>
        connection.write(
          `${JSON.stringify({ command: "restart", repo: "simon/app", task: "12" })}\n`,
        ),
      );
      connection.on("data", (data) => {
        reply += data.toString();
      });
      connection.on("close", () => done(reply));
    });
    expect(restarted).toContain("Restarted APP-12's builder.");
    await waitFor(async () => !(await holds("APP-12/builder")), { timeout: 30_000 });
    expect(await check.exited).toBe(1);
    expect(read(join(home, "daemon.log"))).toContain(
      "APP-12/builder gave back a check slot in simon/app: its builder has ended",
    );
  }, 90_000);

  test("a review that times out twice needs you, and the lead hears why", async () => {
    addApp();
    config("review: { timeout_minutes: 0.1 }\n");
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    writeFileSync(join(codexHome(), "slow-2"), "");
    verdict(3, "approve", "A third review should never run.");
    await startApp12();
    await until(() => thread().review_failed === 1, 30_000);
    expect(thread()).toMatchObject({ verdict: "timed out", reviewing: null, needs_you: 0 });
    // The verdict is saved before its check is set.
    await until(() => finished("failure").length === 1);
    expect(finished("failure")[0]?.description).toBe("review timed out");
    expect(reviews()).toEqual([]);
    await until(() =>
      read(join(lead(), "typed")).includes(
        "APP-12: its review timed out twice (0.1m). sc review APP-12 runs it again.",
      ),
    );
    expect(read(join(lead(), "typed"))).toContain("APP-12's review timed out after 0.1m; retrying");
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("2");
  }, 60_000);

  test("a newer sc submit cancels the review still running for an older commit", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    verdict(1, "approve", "Stale.");
    verdict(2, "approve", "Fresh.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const older = pushed();
    writeFileSync(join(clone(), "change"), "newer\n");
    git(clone(), "commit", "-qam", "newer");
    const again = await skel(["submit", "Newer"], { SKELCREW_SOCKET: builderSocket() });
    expect(again.err).toBe("");
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(git(clone(), "rev-parse", "HEAD"));
    expect(
      statuses()
        .filter((s) => s.sha === older)
        .map((s) => s.state),
    ).toEqual(["pending"]);
    expect(reviews()).toEqual([
      { commit: git(clone(), "rev-parse", "HEAD"), verdict: "approve", body: "Fresh." },
    ]);
  }, 60_000);
});

// A stand-in for bubblewrap, which runs the command in place with the sandbox's environment and
// folder, and no process list of its own. So a process the reviewer leaves behind outlives it,
// as one could if bubblewrap missed it. The agent's socket is the folder the sandbox would show.
const fakeBwrap = `while [ "$1" != -- ]; do
  case "$1" in
    --die-with-parent|--unshare-pid) shift ;;
    --tmpfs|--dev|--proc|--overlay-src|--tmp-overlay) shift 2 ;;
    --chdir) cd "$2"; shift 2 ;;
    --setenv) [ "$2" = SKELCREW_SOCKET ] || export "$2=$3"; shift 3 ;;
    --ro-bind) [ "$3" = /run/skelcrew ] && export SKELCREW_SOCKET="$2/skelcrew.sock"; shift 3 ;;
    *) shift 3 ;;
  esac
done
shift
exec "$@"`;

// Never inside Skelcrew's sandbox, where a stand-in for bubblewrap would show its agents the real
// daemon. Linux only: a Mac runs sandbox-exec, not bubblewrap, and stops waiting on such output a
// second after the reviewer ends.
test.skipIf(insideSandbox || process.platform === "darwin")(
  "a reviewer that ends while a process it left holds its output open gives its check slot back",
  async () => {
    script("bwrap", fakeBwrap);
    addApp();
    const suite = 'echo $$ > "$HOME/suite"; sleep 600';
    config(`repos: { simon/app: { test: [${JSON.stringify(suite)}] } }\n`);
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    writeFileSync(join(codexHome(), "linger-1"), "");
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    const sessions = join(codexHome(), "sessions");
    await until(() => existsSync(join(sessions, "prompt-1")), 30_000);
    const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
    const check = Bun.spawn([process.execPath, source("main.ts"), "check"], {
      cwd: home,
      env: {
        ...env(),
        SKELCREW_SOCKET: join(home, "run", "skelcrew", "reviews", short, "skelcrew.sock"),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    running.push(check);
    const holds = async () =>
      (await skel(["ps"])).out.includes("APP-12/reviewer holds a check slot");
    try {
      await waitFor(holds, { timeout: 30_000 });
      writeFileSync(join(sessions, "go-1"), "");
      // The reviewer has ended, and the review waits on its output, which the process left holds.
      await until(() => read(join(sessions, "linger-1")).trim() !== "");
      await waitFor(async () => !(await holds()), { timeout: 30_000 });
      // sc check ends with its whole suite, so the next check never runs beside it.
      expect(await check.exited).toBe(1);
      expect(await new Response(check.stderr).text()).toContain(
        "The check ended, as its review has ended.",
      );
      const suitePid = read(join(home, "suite")).trim();
      await until(() => {
        const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", suitePid]).stdout.toString().trim();
        return stat === "" || stat.startsWith("Z");
      });
      expect(thread().reviewing).not.toBeNull();
      expect(read(join(home, "daemon.log"))).toContain(
        "APP-12/reviewer gave back a check slot in simon/app: its review has ended",
      );
    } finally {
      const left = Number(read(join(sessions, "linger-1")).trim());
      if (left > 0) process.kill(left, "SIGKILL");
    }
  },
  90_000,
);
