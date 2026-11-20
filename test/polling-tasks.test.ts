// A thread's life as polls of the tracker and forge see it, against a running daemon: a merge
// that ends it, sc stop, sc start and sc rm, labels that start a task, and who is assigned.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answer, asked, git, insideSandbox, runSkelInTerminal, taskItem } from "./harness.ts";
import {
  addApp,
  approved,
  approvedApp12,
  askOn,
  assignOff,
  assignOn,
  assigns,
  builder,
  changes,
  check,
  claim12,
  claims,
  clone,
  copied,
  copiedPr,
  data,
  env,
  fakeBuilders,
  handled,
  home,
  issue12,
  leadName,
  main,
  marked,
  morePolls,
  plugin,
  pr,
  read,
  running,
  script,
  serve,
  setUp,
  skelReview,
  socket,
  tearDown,
  thread,
  typed,
  until,
  waiting,
  you,
} from "./polling.ts";

beforeEach(setUp);
afterEach(tearDown);

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(insideSandbox)("polling a forge", () => {
  test("a merged PR ends the builder, removes the thread's clone and marks it done", async () => {
    await approvedApp12();
    expect(fakeBuilders()).toHaveLength(1);
    pr({ state: "merged", reviews: [skelReview], checks: [approved] });
    // The thread is saved as done before its clone goes, so the test waits for both.
    await until(() => thread().status === "done" && !existsSync(clone()));
    expect(Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", "=app-12"]).success).toBe(
      false,
    );
    expect(fakeBuilders()).toEqual([]);
    expect(thread().needs_you).toBe(0);
    // The lead hears it is done, so it stops listing the PR as ready to merge.
    const leadTyped = () => read(join(data(), "claude", leadName, "typed"));
    await until(() => leadTyped().includes("app-12 is done: #7 merged into main"));
    // A thread that is done isn't polled again. Its repository still is, for labeled issues.
    await morePolls();
    expect(asked(plugin).at(-1)).toMatchObject({ ask: "changed", prs: [] });
    expect(leadTyped().split("app-12 is done").length - 1).toBe(1);
  }, 60_000);

  // m on the screen's list of PRs asks on your socket. The lead's and builders' sockets refuse it,
  // so merging stays your choice, and no sc command an agent runs can merge.
  test("a merge asked on your socket goes to the forge at the commit you saw, and agents can't ask", async () => {
    await approvedApp12();
    const merge = { command: "merge", repo: "app", pr: 7, commit: "c".repeat(40) };
    const hashed = (name: string) =>
      new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 16);
    const runDir = join(home, "run", "skelcrew");
    const unknown = { error: "the daemon doesn't know that request" };
    const lead = join(runDir, "leads", hashed("simon/app"), "skelcrew.sock");
    const builder = join(runDir, "threads", hashed("app-12"), "skelcrew.sock");
    expect(await askOn(lead, merge)).toEqual(unknown);
    expect(await askOn(builder, merge)).toEqual(unknown);
    const merges = () => asked(plugin).filter((q) => q.ask === "merge pr");
    expect(merges()).toEqual([]);

    // The forge says why it won't merge, such as a rule on the branch, and that is the error.
    answer(plugin, "merge pr", { refused: "At least 2 approving reviews are required" });
    expect(await askOn(join(home, "run", "skelcrew.sock"), merge)).toEqual({
      error: "At least 2 approving reviews are required",
    });
    expect(merges()).toEqual([
      { ask: "merge pr", repository: "simon/app", pr: 7, commit: "c".repeat(40) },
    ]);

    // An older plugin doesn't know the question, and its own error says so.
    writeFileSync(join(plugin, "fail-merge-pr"), "the GitHub plugin doesn't answer merge pr");
    expect(await askOn(join(home, "run", "skelcrew.sock"), merge)).toEqual({
      error: "github failed: the GitHub plugin doesn't answer merge pr",
    });
    rmSync(join(plugin, "fail-merge-pr"));

    // Once the forge merged, the next poll ends the thread, as a merge on GitHub does.
    answer(plugin, "merge pr", null);
    pr({ state: "merged", reviews: [skelReview], checks: [approved] });
    expect(await askOn(join(home, "run", "skelcrew.sock"), merge)).toEqual({
      merged: "Merged app#7.",
    });
    await until(() => thread().status === "done");
    expect(merges()).toHaveLength(3);
  }, 60_000);

  test("a PR merged while the daemon was down leaves its thread done, not failed", async () => {
    await approvedApp12();
    const first = running[0];
    first?.kill();
    await first?.exited;
    // With its session gone too, the daemon brings the builder back as it starts, and its
    // first poll ends that builder while the daemon still watches it start.
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    pr({ state: "merged", reviews: [skelReview], checks: [approved] });
    serve();
    await until(() => thread().status === "done");
    // Watching a builder start takes a second, and only then could it call the thread failed.
    await Bun.sleep(1500);
    expect(thread().status).toBe("done");
    expect(Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", "=app-12"]).success).toBe(
      false,
    );
    expect(fakeBuilders()).toEqual([]);
    // The merge leaves you assigned, as the closed issue's record of who did it.
    expect(assigns()).toEqual([assignOn]);
    expect(thread().assigned).toBe(1);
  }, 60_000);

  test("a stopped thread holds your comment until it starts again, and its merge still ends it", async () => {
    await approvedApp12();
    const stopped = Bun.spawnSync([process.execPath, main, "stop", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(stopped.stderr.toString()).toBe("");
    expect(thread().status).toBe("stopped");
    expect(fakeBuilders()).toEqual([]);
    pr({ reviews: [skelReview], comments: [{ id: "50", author: you, text: "Also CSV." }] });
    await morePolls();
    expect(typed()).not.toContain("Also CSV.");
    expect(thread()).toMatchObject({ status: "stopped" });
    expect(handled("50")).toBe(false);
    // Marked seen only once it is typed in.
    expect(marked()).toEqual([]);

    const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    await until(() => typed().includes("Also CSV."), 30_000);
    await until(() => marked().length === 1);

    Bun.spawnSync([process.execPath, main, "stop", "app-12"], { env: env() });
    expect(thread().status).toBe("stopped");
    pr({ state: "merged", reviews: [skelReview], checks: [approved] });
    // The thread is saved as done before its clone goes, so the test waits for both.
    await until(() => thread().status === "done" && !existsSync(clone()));
  }, 60_000);

  // The lead may remove a thread, as it may stop one, and a builder may not. The task stays
  // open, so the thread starts over on it.
  test("sc rm closes the thread's PR with the reason, ends its builder, removes its clone, tells the lead only when you ran it, and the task can start over", async () => {
    await approvedApp12();
    const branch = String(thread().branch);
    // Runs sc rm as an agent would, with its own socket.
    const rmFrom = (agent: string, ...reason: string[]) =>
      Bun.spawnSync([process.execPath, main, "rm", "app-12", ...reason], {
        env: { ...env(), SKELCREW_SOCKET: agent },
        stderr: "pipe",
        stdout: "pipe",
      });
    const hashed = (name: string) =>
      new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 16);
    const runDir = join(home, "run", "skelcrew");
    // At a terminal, sc rm says what it will do and asks first, and anything but y changes
    // nothing.
    const question = "Remove app-12? This closes PR #7 and deletes its branch and clone. [y/N]";
    const kept = await runSkelInTerminal(socket, env(), ["rm", "app-12"], question, "n");
    expect(kept).toContain("Skelcrew didn't remove app-12.");
    expect(asked(plugin).filter((q) => q.ask === "close pr")).toEqual([]);
    expect(thread().status).toBe("waiting");
    expect(fakeBuilders()).toHaveLength(1);

    // An agent has no terminal, so it isn't asked.
    const fromBuilder = rmFrom(join(runDir, "threads", hashed("app-12"), "skelcrew.sock"));
    expect(fromBuilder.stderr.toString()).toContain("doesn't know that request");
    expect(thread().status).toBe("waiting");

    const fromLead = rmFrom(
      join(runDir, "leads", hashed("simon/app"), "skelcrew.sock"),
      "started over as app-14",
    );
    expect(fromLead.stderr.toString()).toBe("");
    expect(fromLead.stdout.toString()).toBe(
      "Removed app-12. Issue #12 stays open, and sc start app-12 starts it over.\n",
    );
    expect(asked(plugin).filter((q) => q.ask === "close pr")).toEqual([
      {
        ask: "close pr",
        repository: "simon/app",
        pr: 7,
        branch,
        comment: "Closed by Skelcrew: started over as app-14",
      },
    ]);
    // Skelcrew assigned you as the thread started, so removing it takes you off.
    await until(() => assigns().length === 2);
    expect(assigns()).toEqual([assignOn, assignOff]);
    expect(thread()).toMatchObject({ status: "done", needs_you: 0 });
    expect(existsSync(clone())).toBe(false);
    expect(Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", "=app-12"]).success).toBe(
      false,
    );
    expect(fakeBuilders()).toEqual([]);
    // Its issue is still open, so the task goes back to stage issue.
    const listed = Bun.spawnSync([process.execPath, main, "issue", "ls", "app", "--json"], {
      env: env(),
    });
    expect(JSON.parse(listed.stdout.toString())).toMatchObject([
      { task: "app-12", issue: "#12", stage: "issue" },
    ]);
    const again = Bun.spawnSync([process.execPath, main, "rm", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(again.stderr.toString()).toContain("app-12 is done already");
    // The lead removed it itself, so it hears nothing of it: not even the closed PR a poll sees.
    await morePolls();
    const leadTyped = () => read(join(data(), "claude", leadName, "typed"));
    expect(leadTyped()).not.toContain("app-12 ended");
    // The forge deletes the branch as it closes the PR, which the fake plugin leaves to the test.
    git(join(home, "github", "simon", "app.git"), "branch", "-D", branch);

    // The task is still open, so sc start starts the thread over, and its builder opens a PR
    // again. Removed with no reason, that PR closes with no comment.
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
      env: env(),
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    expect(started.stdout.toString()).toBe("Started app-12.\n");
    await until(() => thread().pr === 7 && thread().submitting === null, 30_000);
    const removed = await runSkelInTerminal(socket, env(), ["rm", "app-12"], question, "y");
    expect(removed).toContain("Removed app-12.");
    expect(
      asked(plugin)
        .filter((q) => q.ask === "close pr")
        .at(-1),
    ).toEqual({
      ask: "close pr",
      repository: "simon/app",
      pr: 7,
      branch,
      comment: null,
    });
    expect(thread().status).toBe("done");
    // Removed by you, it is news to the lead.
    await until(() => leadTyped().includes("app-12 ended: you removed it, closing #7"));
    expect(leadTyped().split("app-12 ended").length - 1).toBe(1);
  }, 60_000);

  // A forge answers what changed since the last poll, and nothing changes on the PR while
  // the thread is stopped, so the comment held back must come from Skelcrew's copy.
  test("a comment held for a stopped thread reaches it once it starts, though the forge never sends it again", async () => {
    await approvedApp12();
    Bun.spawnSync([process.execPath, main, "stop", "app-12"], { env: env() });
    expect(thread().status).toBe("stopped");
    pr({ reviews: [skelReview], comments: [{ id: "50", author: you, text: "Also CSV." }] });
    // The forge stops sending the comment only once Skelcrew's copy has it. A poll counts as
    // soon as the forge is asked, which is before its answer is read.
    await until(() => copiedPr().includes("Also CSV."));
    changes([]);
    await morePolls();
    expect(handled("50")).toBe(false);
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    await until(() => typed().includes("Also CSV."), 30_000);
  }, 60_000);

  test("a comment still waiting for a busy builder when it is stopped goes in once it starts again", async () => {
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await approvedApp12();
    pr({ reviews: [skelReview], comments: [{ id: "50", author: you, text: "Also CSV." }] });
    await until(() => handled("50"));
    const stopped = Bun.spawnSync([process.execPath, main, "stop", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(stopped.stderr.toString()).toBe("");
    expect(thread()).toMatchObject({ status: "stopped", needs_you: 0 });
    expect(waiting()).toBe(1);
    rmSync(join(builder(), "busy"));
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    await until(() => typed().includes("Also CSV."), 30_000);
    await until(() => waiting() === 0);
  }, 60_000);

  // sc start polls first, and that poll can find the label and start the thread itself.
  test("sc start on a labeled issue starts it itself, from the branch it names", async () => {
    const work = addApp();
    git(work, "checkout", "-q", "-b", "next");
    git(work, "push", "-q", join(home, "github", "simon", "app.git"), "next");
    changes([issue12()]);
    // An hour between polls, so only sc start brings another.
    serve(3_600_000);
    await until(() => copied().rows.includes("task 12"));
    changes([issue12(true)]);
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12", "--from", "next"], {
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    expect(started.stdout.toString()).toBe("Started app-12.\n");
    expect(thread()).toMatchObject({ task: 12, status: "working", base: "next" });
  }, 60_000);

  // The tracker can take its time to answer a claim, and an sc start that comes in meanwhile
  // must still start the task with its own options.
  test("sc start that comes in while a labeled task is being claimed starts it from the branch it names", async () => {
    const work = addApp();
    git(work, "checkout", "-q", "-b", "next");
    git(work, "push", "-q", join(home, "github", "simon", "app.git"), "next");
    const hold = join(plugin, "hold-took");
    writeFileSync(hold, "");
    changes([issue12(true)]);
    serve(3_600_000);
    await until(() => existsSync(join(plugin, "held-took")));
    const started = Bun.spawn([process.execPath, main, "start", "app-12", "--from", "next"], {
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Nothing outside the daemon shows that sc start's request has arrived, so give it a
    // moment before the tracker answers. Too short a moment fails the test, never passes it.
    await Bun.sleep(2000);
    rmSync(hold);
    expect(await new Response(started.stderr).text()).toBe("");
    expect(await new Response(started.stdout).text()).toBe("Started app-12.\n");
    await started.exited;
    expect(thread()).toMatchObject({ task: 12, status: "working", base: "next" });
  }, 30_000);

  // sc start polls first, so a builder never starts from an old title or body.
  test("sc start reads its task as it is now", async () => {
    addApp();
    changes([issue12()]);
    // An hour between polls, so only sc start brings another.
    serve(3_600_000);
    await until(() => copied().rows.includes("task 12"));
    changes([taskItem("12", "Add export as CSV", { body: "With headers" })]);
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    expect(thread()).toMatchObject({ task: 12, title: "Add export as CSV", body: "With headers" });
  }, 60_000);

  // The fake tracker answers the claim with nothing, as a plugin not yet updated does, and
  // that counts as taking it.
  test("a task labeled skelcrew starts a thread once, and one that failed isn't started again", async () => {
    // A builder that can't start, so the thread fails.
    script(
      "claude",
      `case "$CLAUDE_CONFIG_DIR" in */lead-*) stty -echo; echo "❯"; exec cat > "$CLAUDE_CONFIG_DIR/typed" ;; esac
echo "Not logged in"; exit 1`,
    );
    addApp();
    pr({ labeled: true });
    serve();
    const lead = () => read(join(data(), "claude", leadName, "typed"));
    await until(() => lead().includes("started app-12 from github: Add export"));
    const took = () => asked(plugin).filter((q) => q.ask === "took");
    await until(() => took().length > 0);
    expect(took()).toEqual([{ ask: "took", repository: "simon/app", task: "12" }]);
    await until(() => thread().status === "failed");
    // The label is still there, after a restart too.
    await morePolls();
    const first = running[0];
    first?.kill();
    await first?.exited;
    serve();
    await morePolls();
    expect(thread().status).toBe("failed");
    expect(took()).toHaveLength(1);
    expect(lead().split("started app-12").length - 1).toBe(1);
  }, 60_000);

  test("a labeled task whose claim the tracker grants starts a thread", async () => {
    addApp();
    answer(plugin, "took", { took: true });
    pr({ labeled: true });
    serve();
    await until(() => thread().task === 12);
    // Assigning you comes after the thread started, and the claim isn't asked twice.
    await until(() => thread().assigned === 1);
    expect(claims()).toEqual([claim12]);
    expect(assigns()).toEqual([assignOn]);
  }, 30_000);

  // The tracker is where tasks come from and where Skelcrew shows how they go: an open issue is a
  // task in stage issue, its label starts it, and the issue is claimed, assigned and closed by
  // the PR's merge, through the tracker's own signals.
  test("an open issue is a task in stage issue, its label starts it, and its merge closes the issue", async () => {
    addApp();
    answer(plugin, "took", { took: true });
    changes([issue12()]);
    serve();
    // Runs sc issue ls for app as a tool would, with `more` words such as --all, and returns its
    // rows, or none while the daemon isn't listening yet.
    const listed = (...more: string[]) => {
      const done = Bun.spawnSync(
        [process.execPath, main, "issue", "ls", "app", "--json", ...more],
        {
          env: env(),
          stderr: "pipe",
        },
      );
      return done.success ? JSON.parse(done.stdout.toString()) : [];
    };
    await until(() => listed().length === 1);
    expect(listed()).toEqual([
      {
        task: "app-12",
        stage: "issue",
        title: "Add export",
        short: null,
        issue: "#12",
        thread: null,
        pr: null,
        checks: null,
        review: null,
      },
    ]);
    // Nothing starts until the label is added.
    await morePolls();
    expect(claims()).toEqual([]);
    changes([issue12(true)]);
    await until(() => thread().task === 12);
    expect(listed()).toMatchObject([{ task: "app-12", issue: "#12", stage: "working" }]);
    expect(thread().issue_link).toBe("https://github.com/simon/app/issues/12");
    // A task from a label runs the default flow, unless the lead switches it.
    expect(thread().flow).toBe("default");
    await until(() => thread().assigned === 1);
    expect(claims()).toEqual([claim12]);
    expect(assigns()).toEqual([assignOn]);
    // The PR the builder opens holds the line that closes the issue on merge.
    await until(
      () => thread().pr === 7 && thread().reviewing === null && thread().submitting === null,
      30_000,
    );
    const opened = asked(plugin).find((q) => q.ask === "open pr");
    expect(String(opened?.body)).toEndWith("\n\nCloses #12");
    // Approved with every check green, it waits for you to merge.
    pr({ labeled: true, reviews: [skelReview], checks: [approved, check(900, "passed")] });
    await until(() => thread().needs_you === 1);
    expect(listed()).toMatchObject([{ task: "app-12", issue: "#12", stage: "ready for review" }]);
    // Merged, the task is too, and you stay assigned. The tracker then closes the issue.
    pr({
      labeled: true,
      state: "merged",
      reviews: [skelReview],
      checks: [approved, check(900, "passed")],
    });
    await until(() => thread().status === "done");
    // A merged task leaves the list at once, though its issue is still open, and only --all
    // shows it.
    expect(listed()).toEqual([]);
    expect(listed("--all")).toMatchObject([{ task: "app-12", issue: "#12", stage: "merged" }]);
    changes([taskItem("12", "Add export", { state: "closed", labels: ["skelcrew"] })]);
    await until(() => listed("--all")[0]?.issue === null);
    expect(listed("--all")).toMatchObject([{ task: "app-12", stage: "merged" }]);
    expect(assigns()).toEqual([assignOn]);
  }, 60_000);

  // The claim only keeps two daemons from both starting by the label. You decide by hand, and
  // sc start claims it too, so the issue shows Skelcrew took it.
  test("sc start starts a labeled task claimed elsewhere, claiming it without looking at the answer", async () => {
    addApp();
    answer(plugin, "took", { took: false });
    changes([issue12(true)]);
    serve();
    const took = () => asked(plugin).filter((q) => q.ask === "took");
    await until(() => took().length > 0);
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    expect(started.stdout.toString()).toBe("Started app-12.\n");
    expect(thread()).toMatchObject({ task: 12, status: "working" });
    await until(() => took().length === 2);
    expect(took()).toEqual([claim12, claim12]);
  }, 30_000);

  // You are assigned so the tracker shows which issues Skelcrew works on, and for whom. Each
  // start claims the issue too, as a labeled start does.
  test("sc start claims the issue and assigns you, sc stop takes you off, and starting again puts you back", async () => {
    await approvedApp12();
    await until(() => thread().assigned === 1);
    expect(claims()).toEqual([claim12]);
    expect(assigns()).toEqual([assignOn]);
    const stopped = Bun.spawnSync([process.execPath, main, "stop", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(stopped.stderr.toString()).toBe("");
    await until(() => thread().assigned === 0);
    expect(assigns()).toEqual([assignOn, assignOff]);
    expect(thread()).toMatchObject({ status: "stopped", assigned: 0 });
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    await until(() => thread().assigned === 1);
    expect(claims()).toEqual([claim12, claim12]);
    expect(assigns()).toEqual([assignOn, assignOff, assignOn]);
  }, 60_000);

  // A tracker can take up to a minute to answer, as long as sc stop waits for its answer, and
  // the assignment changes only what the tracker shows, so the stop doesn't wait on it.
  test("sc stop answers at once while the tracker takes its time to take you off", async () => {
    await approvedApp12();
    await until(() => thread().assigned === 1);
    writeFileSync(join(plugin, "hold-assign"), "");
    const began = Date.now();
    const stopped = Bun.spawnSync([process.execPath, main, "stop", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(stopped.stderr.toString()).toBe("");
    // The fake holds its answer up to 20 seconds, so a stop that waited on it takes that long.
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(thread().status).toBe("stopped");
    await until(() => existsSync(join(plugin, "held-assign")));
    rmSync(join(plugin, "hold-assign"));
    await until(() => thread().assigned === 0);
    expect(assigns()).toEqual([assignOn, assignOff]);
  }, 60_000);

  // Starting again right after a stop must not have its assignment overtaken by the stop's
  // removal, which would leave a running thread's issue with nobody assigned.
  test("sc start right after sc stop ends with you assigned", async () => {
    await approvedApp12();
    await until(() => thread().assigned === 1);
    writeFileSync(join(plugin, "hold-assign-false"), "");
    Bun.spawnSync([process.execPath, main, "stop", "app-12"], { env: env() });
    await until(() => existsSync(join(plugin, "held-assign")));
    const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(started.stderr.toString()).toBe("");
    // Time for the start's assignment to reach the tracker first, if it could. Too short a
    // moment passes the test without proving the order, never fails it.
    await Bun.sleep(2000);
    rmSync(join(plugin, "hold-assign-false"));
    const log = () => read(join(data(), "threads", "app-12.log"));
    await until(() => log().includes("took you off its issue"));
    await until(() => thread().assigned === 1);
    expect(assigns()).toEqual([assignOn, assignOff, assignOn]);
    expect(existsSync(join(plugin, "assigned"))).toBe(true);
  }, 60_000);

  // sc stop waits for its builder to exit, and an sc start meanwhile finds the thread stopped
  // already, so it must not assign you before the stop takes you off.
  test("sc start while a stopped builder is still exiting ends with you assigned", async () => {
    // Agents start through nice, outside their sandbox, so this one makes each agent's session
    // take 4 seconds to end, as Claude Code can.
    script("nice", "shift 2\ntrap 'sleep 4; exit 0' HUP TERM\n\"$@\"");
    await approvedApp12();
    await until(() => thread().assigned === 1);
    const stopping = Bun.spawn([process.execPath, main, "stop", "app-12"], {
      env: env(),
      stdout: "ignore",
      stderr: "ignore",
    });
    await until(() => thread().status === "stopped");
    Bun.spawnSync([process.execPath, main, "start", "app-12"], { env: env() });
    const log = () => read(join(data(), "threads", "app-12.log"));
    await stopping.exited;
    // The old builder takes up to 10 seconds to be killed, as it ignores its session's end.
    await until(() => log().includes("took you off its issue"), 30_000);
    await until(() => thread().assigned === 1);
    expect(assigns()).toEqual([assignOn, assignOff, assignOn]);
    expect(existsSync(join(plugin, "assigned"))).toBe(true);
    // Stopped again, so its builder is gone before the test ends.
    Bun.spawnSync([process.execPath, main, "stop", "app-12"], { env: env() });
  }, 90_000);

  // The tracker answers that you were assigned already, so the issue was yours before.
  test("an issue you were assigned already stays yours when its thread stops", async () => {
    answer(plugin, "assign", { assigned: false });
    await approvedApp12();
    await until(() => assigns().length === 1);
    Bun.spawnSync([process.execPath, main, "stop", "app-12"], { env: env() });
    expect(thread()).toMatchObject({ status: "stopped", assigned: 0 });
    expect(assigns()).toEqual([assignOn]);
  }, 60_000);

  // An older plugin, which knows no assign, fails it, and so may a tracker that won't assign
  // you. Neither claim nor assignment changes only what the tracker shows.
  test("a tracker that fails to claim or assign changes nothing about starting and stopping", async () => {
    writeFileSync(join(plugin, "fail-assign"), "the GitHub plugin doesn't answer assign");
    writeFileSync(join(plugin, "fail-took"), "network is down");
    await approvedApp12();
    await until(() => assigns().length === 1);
    const stopped = Bun.spawnSync([process.execPath, main, "stop", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(stopped.stderr.toString()).toBe("");
    expect(thread()).toMatchObject({ status: "stopped", assigned: 0 });
    expect(assigns()).toEqual([assignOn]);
  }, 60_000);

  test("a PR closed without merging takes you off its issue and tells the lead", async () => {
    await approvedApp12();
    await until(() => thread().assigned === 1);
    pr({ state: "closed", reviews: [skelReview], checks: [approved] });
    await until(() => thread().status === "done");
    await until(() => assigns().length === 2);
    expect(assigns()).toEqual([assignOn, assignOff]);
    await until(() => thread().assigned === 0);
    const leadTyped = () => read(join(data(), "claude", leadName, "typed"));
    await until(() => leadTyped().includes("app-12 ended: #7 closed without merging"));
  }, 60_000);

  // A thread that failed still holds its issue, so you stay assigned, and starting it over
  // keeps that Skelcrew assigned you, though the tracker now says you were already.
  test("a failed thread keeps you assigned, and sc rm takes you off once it started over", async () => {
    script(
      "claude",
      `case "$CLAUDE_CONFIG_DIR" in */lead-*) stty -echo; echo "❯"; exec cat > "$CLAUDE_CONFIG_DIR/typed" ;; esac
echo "Not logged in"; exit 1`,
    );
    addApp();
    changes([issue12()]);
    serve();
    await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
    Bun.spawnSync([process.execPath, main, "start", "app-12"], { env: env() });
    await until(() => thread().status === "failed" && thread().assigned === 1);
    answer(plugin, "assign", { assigned: false });
    Bun.spawnSync([process.execPath, main, "start", "app-12"], { env: env() });
    await until(() => assigns().length === 2);
    await until(() => thread().status === "failed");
    expect(thread().assigned).toBe(1);
    const removed = Bun.spawnSync([process.execPath, main, "rm", "app-12"], {
      env: env(),
      stderr: "pipe",
    });
    expect(removed.stderr.toString()).toBe("");
    await until(() => thread().assigned === 0);
    expect(assigns()).toEqual([assignOn, assignOn, assignOff]);
    expect(thread()).toMatchObject({ status: "done", assigned: 0 });
  }, 60_000);

  test("a thread with no issue claims and assigns nothing", async () => {
    addApp();
    serve();
    await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
    const started = Bun.spawnSync(
      [process.execPath, main, "start", "app", "Add export", "As JSON"],
      {
        env: env(),
        stderr: "pipe",
      },
    );
    expect(started.stderr.toString()).toBe("");
    await until(() => thread().status === "waiting", 30_000);
    Bun.spawnSync([process.execPath, main, "stop", `app-t100`], { env: env() });
    expect(thread().status).toBe("stopped");
    expect([...claims(), ...assigns()]).toEqual([]);
  }, 60_000);

  // The test above stops the daemon as the review of app-t100's first round starts. bubblewrap
  // starts its sandbox's first process in its own time, and that process only asks to die with
  // bwrap once it runs. A stop that ends bwrap in between leaves it waiting forever on a bwrap
  // that is gone, with bwrap's own command line, and no longer under the daemon. Here bwrap
  // stands in for that, for the review only, so the stop always lands in between. Told to end,
  // it starts a process that can't be ended with SIGTERM, and goes. As it starts, it also leaves
  // one that is under the daemon no more, as bwrap's would be had bwrap ended before the stop.
  // The next daemon brings the review back, and is stopped as soon as its bwrap starts. Each
  // time, nothing is left running once the daemon has exited. bubblewrap is Linux's sandbox, so
  // a Mac never starts it.
  test.skipIf(process.platform === "darwin")(
    "a thread with no issue whose daemon stops as its review starts leaves no sandbox running",
    async () => {
      const bwrap = Bun.which("bwrap") ?? "bwrap";
      // A process that can't be ended with SIGTERM, which says its ID in the file it is given.
      script("stuck", 'trap "" TERM; echo $$ > "$1"; exec sleep 300');
      // Each bwrap of a review writes its own ID, and those of what it leaves, in pids, and
      // says it started with a file of its own in started.
      const pids = join(home, "pids");
      const started = join(home, "started");
      mkdirSync(pids);
      mkdirSync(started);
      script(
        "bwrap",
        `case "$*" in *" codex "*)
  echo $$ > ${pids}/outer-$$
  trap 'stuck ${pids}/late-$$ & until test -s ${pids}/late-$$; do sleep 0.01; done; exit 1' TERM
  (stuck ${pids}/early-$$ &)
  until test -s ${pids}/early-$$; do sleep 0.01; done
  touch ${started}/$$
  while :; do sleep 0.05; done ;;
esac
exec ${bwrap} "$@"`,
      );
      // A process that ended but nobody reaped yet shows as Z, and runs nothing. ps works on a
      // Mac too, which has no /proc.
      const runs = (pid: number) => {
        const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" });
        const state = ps.stdout.toString().trim();
        return state !== "" && !state.startsWith("Z");
      };
      // What every review's bwrap started that still runs. Asked as soon as the daemon has
      // exited, without a wait, so the daemon's stop must have ended them.
      const leftRunning = () =>
        readdirSync(pids)
          .map((file) => Number(read(join(pids, file))))
          .filter(runs);
      addApp();
      const first = serve();
      await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
      const sc = Bun.spawnSync([process.execPath, main, "start", "app", "Add export", "As JSON"], {
        env: env(),
        stderr: "pipe",
      });
      expect(sc.stderr.toString()).toBe("");
      await until(() => readdirSync(started).length === 1, 30_000);
      first.kill();
      await first.exited;
      expect(leftRunning()).toEqual([]);
      expect(readdirSync(pids).length).toBe(3);
      // The review the stop cut short comes back with the next daemon.
      const second = serve();
      await until(() => readdirSync(started).length === 2, 30_000);
      second.kill();
      await second.exited;
      expect(leftRunning()).toEqual([]);
      expect(readdirSync(pids).length).toBe(6);
    },
    90_000,
  );

  // A task's ID names the thread's folder, which setup deletes before it clones, so an ID
  // from a tracker that climbs out of Skelcrew's threads folder must never reach it.
  test("a task ID from the tracker that isn't a plain name is refused, and nothing is deleted", async () => {
    addApp();
    const victim = join(data(), "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep"), "mine\n");
    changes([
      taskItem("../../victim", "Climb out", { labels: ["skelcrew"] }),
      taskItem("13", "Fix login"),
    ]);
    serve();
    await morePolls();
    expect(thread()).toEqual({});
    expect(copied().rows).toEqual([]);
    expect(read(join(victim, "keep"))).toBe("mine\n");
  }, 60_000);
});
