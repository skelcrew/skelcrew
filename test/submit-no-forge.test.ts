// A repository on a remote no forge claims, with no tracker, against a running daemon: its threads
// are pushed with git, reviewed in Skelcrew, and end once merged.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asked, git, insideSandbox, read, runSkelInTerminal, source } from "./harness.ts";
import {
  codexHome,
  config,
  data,
  env,
  fakeClaude,
  home,
  lead,
  longWait,
  plugin,
  running,
  script,
  setUp,
  skel,
  socket,
  tearDown,
  until,
  untilCloned,
  verdict,
} from "./submit.ts";

beforeEach(setUp);
afterEach(tearDown);

// Puts simon/app on a remote no forge claims, with no tracker, and tells Skelcrew about it, as a
// repository you have opened. Returns the bare repository, as its remote.
function addAppOnGit(): string {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  const bare = join(home, "elsewhere", "simon", "app.git");
  git(home, "clone", "-q", "--bare", work, bare);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo, opened, remote, claimed) VALUES ('app', 'simon', 'app', 1, ?, 1)", [${JSON.stringify(`file://${bare}`)}]);`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  return bare;
}

// A repository with neither: you tell the lead what to do, and the branch is what you get.
describe.skipIf(insideSandbox)("with no tracker and no forge", () => {
  test("a thread on what you said is pushed with git, reviewed in Skelcrew, and ends once merged", async () => {
    const bare = addAppOnGit();
    verdict(1, "approve", "Ready to merge.");
    // Polling every 200 milliseconds, so the merge is seen soon.
    const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)}, 200);`;
    running.push(
      Bun.spawn([process.execPath, "-e", code], { env: env(), stdout: "ignore", stderr: "ignore" }),
    );
    await untilCloned();
    // It has no tracker to create a task in.
    const create = await skel(["issue", "create", "app", "Add export", "As JSON"]);
    expect(create.err).toContain("app has no tracker");
    const started = await skel(["start", "app", "Add export", "As JSON"]);
    expect(started.err).toBe("");
    expect(started.out).toBe(`Started app-t100.\n`);
    const log = () => read(join(data(), "threads", `app-t100.log`));
    await until(
      () => log().includes(`app-t100 is ready on branch skelcrew/t100-add-export`),
      30_000,
    );
    expect(git(bare, "show", `skelcrew/t100-add-export:change`)).toBe("1");
    expect(read(join(data(), "claude", `app-t100`, "args"))).toContain("Add export\n\nAs JSON");
    const row = () => {
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      try {
        return db.query("SELECT task, status, needs_you, pr FROM task_threads").get();
      } finally {
        db.close();
      }
    };
    expect(row()).toEqual({ task: `t100`, status: "waiting", needs_you: 1, pr: null });
    // No forge, so no PR, check or review was asked for.
    expect(asked(plugin).filter((q) => q.ask !== "claims")).toEqual([]);
    // You merge it yourself, with a squash, and Skelcrew sees the branch has nothing left.
    const work = join(home, "work", "app");
    git(work, "pull", "-q", bare, "main");
    git(work, "fetch", "-q", bare, `skelcrew/t100-add-export`);
    git(work, "merge", "--squash", "-q", "FETCH_HEAD");
    git(work, "commit", "-q", "-m", "Add export");
    git(work, "push", "-q", bare, "main");
    // The thread's row changes a moment before its log has the line, so the test waits on the
    // log, which comes last.
    await until(() => log().includes("is merged into main"), 30_000);
    expect(row()).toMatchObject({ status: "done" });
    await until(() =>
      read(join(lead(), "typed")).includes(
        `app-t100 is done: its branch skelcrew/t100-add-export merged into main`,
      ),
    );
  }, 60_000);

  // With no forge, someone else's push to the thread's branch still reaches its builder, and
  // the branch it had ready to merge isn't ready any more.
  test("a thread's branch that moved on a remote with no forge is told to its builder", async () => {
    const bare = addAppOnGit();
    verdict(1, "approve", "Ready to merge.");
    const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)}, 200);`;
    running.push(
      Bun.spawn([process.execPath, "-e", code], { env: env(), stdout: "ignore", stderr: "ignore" }),
    );
    await untilCloned();
    const started = await skel(["start", "app", "Add export", "As JSON"]);
    expect(started.err).toBe("");
    const log = () => read(join(data(), "threads", `app-t100.log`));
    await until(
      () => log().includes(`app-t100 is ready on branch skelcrew/t100-add-export`),
      30_000,
    );
    // Someone else pushes to the thread's branch.
    const work = join(home, "work", "app");
    git(work, "fetch", "-q", bare, `skelcrew/t100-add-export`);
    git(work, "checkout", "-q", "-B", "other", "FETCH_HEAD");
    writeFileSync(join(work, "OTHER"), "other\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "Someone else's change");
    git(work, "push", "-q", bare, `HEAD:refs/heads/skelcrew/t100-add-export`);
    const moved = git(work, "rev-parse", "HEAD");
    const typed = () => read(join(data(), "claude", `app-t100`, "typed"));
    await until(() => typed().includes(`moved on the remote to ${moved}`), 30_000);
    expect(log()).toContain(
      `its branch moved on the remote to ${moved}, so it isn't ready to merge`,
    );
  }, 60_000);

  // A push that fails, such as while the remote can't be reached, leaves its submit pending.
  // The branch may have moved meanwhile, and the builder still learns of it once the remote is
  // back.
  test("a thread with no forge whose push failed is told once its remote is back that its branch moved", async () => {
    const bare = addAppOnGit();
    verdict(1, "approve", "Ready to merge.");
    const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)}, 200);`;
    running.push(
      Bun.spawn([process.execPath, "-e", code], { env: env(), stdout: "ignore", stderr: "ignore" }),
    );
    await untilCloned();
    const started = await skel(["start", "app", "Add export", "As JSON"]);
    expect(started.err).toBe("");
    const log = () => read(join(data(), "threads", `app-t100.log`));
    await until(
      () => log().includes(`app-t100 is ready on branch skelcrew/t100-add-export`),
      30_000,
    );
    // The remote goes out of reach, and someone else's push moves the thread's branch there.
    const away = `${bare}.away`;
    renameSync(bare, away);
    const work = join(home, "work", "app");
    git(work, "fetch", "-q", away, `skelcrew/t100-add-export`);
    git(work, "checkout", "-q", "-B", "other", "FETCH_HEAD");
    writeFileSync(join(work, "OTHER"), "other\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "Someone else's change");
    git(work, "push", "-q", away, `HEAD:refs/heads/skelcrew/t100-add-export`);
    const moved = git(work, "rev-parse", "HEAD");
    // The builder submits a round, whose push fails.
    const clone = join(data(), "threads", `app-t100`);
    writeFileSync(join(clone, "change"), "2\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "round 2");
    const short = new Bun.CryptoHasher("sha256").update(`app-t100`).digest("hex").slice(0, 16);
    const t1Socket = join(home, "run", "skelcrew", "threads", short, "skelcrew.sock");
    const submitted = await skel(["submit", "Round 2"], {
      SKELCREW_SANDBOX: "1",
      SKELCREW_SOCKET: t1Socket,
    });
    expect(submitted.err).toBe("");
    await until(() => log().includes("the round failed"), 30_000);
    const typed = () => read(join(data(), "claude", `app-t100`, "typed"));
    expect(typed()).not.toContain("moved on the remote");
    // Back in reach, a poll sees the branch moved, though the submit is still pending.
    renameSync(away, bare);
    await until(() => typed().includes(`moved on the remote to ${moved}`), 30_000);
  }, 60_000);

  // Runs the daemon from a folder that isn't a git checkout, as the service does, polling every
  // 200 milliseconds. git that runs outside Skelcrew's clone then fails. `more` adds to its
  // environment, such as a GIT_TRACE file that shows what git the daemon runs.
  const serveOutsideCheckout = (more: Record<string, string> = {}) => {
    const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)}, 200);`;
    running.push(
      Bun.spawn([process.execPath, "-e", code], {
        cwd: home,
        env: { ...env(), ...more },
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
  };

  // A branch of the same name that the thread never pushed isn't the thread's to delete.
  test("sc rm before the first submit leaves a branch of the same name on the remote", async () => {
    fakeClaude(false);
    const bare = addAppOnGit();
    git(bare, "branch", `skelcrew/t100-add-export`, "main");
    serveOutsideCheckout();
    await untilCloned();
    expect((await skel(["start", "app", "Add export", "As JSON"])).err).toBe("");
    await until(() => read(join(data(), "claude", `app-t100`, "args")) !== "");
    const removed = await skel(["rm", `app-t100`]);
    expect(removed.err).toBe("");
    // A thread with no issue has nothing that stays open, so the message names none.
    expect(removed.out).toBe(`Removed app-t100. sc start app-t100 starts it over.\n`);
    expect(git(bare, "branch", "--list", `skelcrew/t100-add-export`)).not.toBe("");
    expect(existsSync(join(data(), "threads", `app-t100`))).toBe(false);
  }, 60_000);

  // Each review runs the repository's tests, so the limit keeps them from slowing each other.
  describe("with limits.reviews at 1", () => {
    // Holds reviews 1 to 3 until the test lets each go, so it can see which wait.
    const holdReviews = () => {
      mkdirSync(join(codexHome(), "sessions"), { recursive: true });
      for (const n of [1, 2, 3]) {
        writeFileSync(join(codexHome(), `held-${n}`), "");
        verdict(n, "approve", "Ready to merge.");
      }
    };
    const letGo = (n: number) => writeFileSync(join(codexHome(), "sessions", `go-${n}`), "");
    const prompt = (n: number) => read(join(codexHome(), "sessions", `prompt-${n}`));
    const reviewsRun = () => Number(read(join(codexHome(), "sessions", "count")) || 0);
    // The thread's row as the database has it now.
    const row = (folder: string) => {
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      try {
        type Row = { reviewing: string | null; queued: number | null };
        const query = db.query<Row, [string]>(
          "SELECT reviewing, queued FROM task_threads WHERE folder = ?",
        );
        return query.get(folder) ?? { reviewing: null, queued: null };
      } finally {
        db.close();
      }
    };
    const queued = (folder: string) => row(folder).queued !== null;
    const ready = (folder: string) =>
      read(join(data(), "threads", `${folder}.log`)).includes(`${folder} is ready on branch`);
    // Starts a thread on what you said, whose builder submits at once.
    const start = async (title: string) =>
      expect((await skel(["start", "app", title, "Do it"])).err).toBe("");

    test("a review waits while another runs, and they run in the order they came", async () => {
      config("limits: { reviews: 1 }\n");
      addAppOnGit();
      holdReviews();
      serveOutsideCheckout();
      await untilCloned();
      await start("First");
      await until(() => prompt(1) !== "", 30_000);
      await start("Second");
      await until(() => queued(`app-t101`), 30_000);
      await start("Third");
      await until(() => queued(`app-t102`), 30_000);
      // Only the first review runs. sc ps and the sidebar say the others wait.
      expect(reviewsRun()).toBe(1);
      const listed = (await skel(["ps"])).out;
      expect(listed).toMatch(/app-t101 .*queued for review/);
      expect(listed).toMatch(/app-t102 .*queued for review/);
      // As each ends, the one that came next starts.
      letGo(1);
      await until(() => prompt(2) !== "", 30_000);
      expect(prompt(2)).toContain("# Second");
      expect(queued(`app-t101`)).toBe(false);
      expect(queued(`app-t102`)).toBe(true);
      letGo(2);
      await until(() => prompt(3) !== "", 30_000);
      expect(prompt(3)).toContain("# Third");
      letGo(3);
      await until(() => [`app-t100`, `app-t101`, `app-t102`].every(ready), 30_000);
    }, 60_000);

    test("a thread stopped while its review waits is stopped, and its review never runs", async () => {
      config("limits: { reviews: 1 }\n");
      addAppOnGit();
      holdReviews();
      serveOutsideCheckout();
      await untilCloned();
      await start("First");
      await until(() => prompt(1) !== "", 30_000);
      await start("Second");
      await until(() => queued(`app-t101`), 30_000);
      expect((await skel(["stop", `app-t101`])).err).toBe("");
      expect((await skel(["ps"])).out).toMatch(/app-t101 .* stopped/);
      letGo(1);
      await until(() => ready(`app-t100`), 30_000);
      await Bun.sleep(1500);
      expect(reviewsRun()).toBe(1);
      expect((await skel(["ps"])).out).toMatch(/app-t101 .* stopped/);
    }, 60_000);

    test("after a restart, the review that was running goes first, and the one that waited waits again", async () => {
      config("limits: { reviews: 1 }\n");
      addAppOnGit();
      holdReviews();
      serveOutsideCheckout();
      const first = running.at(-1);
      await untilCloned();
      await start("First");
      await until(() => prompt(1) !== "", 30_000);
      await start("Second");
      await until(() => queued(`app-t101`), 30_000);
      first?.kill();
      await first?.exited;
      // Both reviews are still to do, and the second still waits.
      expect(row(`app-t100`).reviewing).not.toBeNull();
      expect(row(`app-t100`).queued).toBeNull();
      expect(queued(`app-t101`)).toBe(true);
      serveOutsideCheckout();
      // The review that was running starts again first, and the one that waited waits again
      // until it ends.
      await until(() => prompt(2) !== "", 30_000);
      expect(prompt(2)).toContain("# First");
      await Bun.sleep(1000);
      expect(reviewsRun()).toBe(2);
      expect(queued(`app-t100`)).toBe(false);
      expect(queued(`app-t101`)).toBe(true);
      letGo(2);
      await until(() => prompt(3) !== "", 30_000);
      expect(prompt(3)).toContain("# Second");
      letGo(3);
      await until(() => ready(`app-t100`) && ready(`app-t101`), 30_000);
    }, 60_000);

    // Giving back the first review's place starts the queued one at once, so the limit the
    // first met must already be saved by then, or the second would run on the limited harness.
    test("a review queued behind one that meets the usage limit is held, not run", async () => {
      config("limits: { reviews: 1 }\n");
      addAppOnGit();
      holdReviews();
      writeFileSync(
        join(codexHome(), "error-1"),
        "ERROR: You've hit your usage limit. Try again at Dec 31st, 2099 11:59 PM.\n",
      );
      serveOutsideCheckout();
      await untilCloned();
      await start("First");
      await until(() => prompt(1) !== "", 30_000);
      await start("Second");
      await until(() => queued(`app-t101`), 30_000);
      letGo(1);
      const second = () => read(join(data(), "threads", `app-t101.log`));
      await until(() => second().includes("usage limit holds the review"), 30_000);
      expect(reviewsRun()).toBe(1);
    }, 60_000);

    // Two reviews run at once. The second meets Codex's limit while the first still runs, and
    // the first then ends cleanly, as its last call came before the limit. That says nothing
    // of the limit, so it holds, and a later review waits for its reset.
    test("a review that started before the usage limit doesn't end it by finishing", async () => {
      config("limits: { reviews: 2 }\n");
      addAppOnGit();
      holdReviews();
      rmSync(join(codexHome(), "held-2"));
      writeFileSync(
        join(codexHome(), "error-2"),
        "ERROR: You've hit your usage limit. Try again at Dec 31st, 2099 11:59 PM.\n",
      );
      serveOutsideCheckout();
      await untilCloned();
      await start("First");
      await until(() => prompt(1) !== "", 30_000);
      await start("Second");
      // The limit is met, and saved, while the first review still runs.
      const limits = () => {
        const db = new Database(join(data(), "skelcrew.db"));
        db.run("PRAGMA busy_timeout = 5000");
        try {
          return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM limits").get()?.n ?? 0;
        } finally {
          db.close();
        }
      };
      await until(() => limits() === 1, 30_000);
      letGo(1);
      await until(() => ready(`app-t100`), 30_000);
      // The limit holds: a new thread's review never runs Codex.
      expect(limits()).toBe(1);
      await start("Third");
      const third = () => read(join(data(), "threads", `app-t102.log`));
      await until(() => third().includes("usage limit holds the review"), 30_000);
      expect(reviewsRun()).toBe(2);
    }, 60_000);
  });

  // Without a forge there is no PR to close, but Skelcrew pushed the branch, so it deletes it.
  test("sc rm deletes the thread's branch from the remote and its clone, and the thread can start over", async () => {
    const bare = addAppOnGit();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Ready again.");
    serveOutsideCheckout();
    await untilCloned(longWait);
    expect((await skel(["start", "app", "Add export", "As JSON"])).err).toBe("");
    const log = () => read(join(data(), "threads", `app-t100.log`));
    const ready = `app-t100 is ready on branch skelcrew/t100-add-export`;
    await until(() => log().includes(ready), longWait);
    const onRemote = () => git(bare, "branch", "--list", `skelcrew/t100-add-export`) !== "";
    expect(onRemote()).toBe(true);

    // With no PR, the question names what goes: the branch and the clone.
    const removed = await runSkelInTerminal(
      socket,
      env(),
      ["rm", `app-t100`, "wrong approach"],
      `Remove app-t100? This deletes its branch and clone. [y/N]`,
      "y",
    );
    expect(removed).toContain(`Removed app-t100.`);
    expect(onRemote()).toBe(false);
    expect(existsSync(join(data(), "threads", `app-t100`))).toBe(false);
    expect(log()).toContain("wrong approach");
    expect(asked(plugin).filter((q) => q.ask !== "claims")).toEqual([]);

    // Skelcrew's clone still has the refs of the first thread's push, as after a daemon that
    // stopped part way through an end. Started over, it isn't taken for a thread whose branch
    // was deleted, and gets as far as the first did.
    const refs = () => git(join(data(), "repos", "simon", "app"), "for-each-ref", "refs/skelcrew/");
    expect(refs()).toContain("refs/skelcrew/threads/");
    const before = log().split(ready).length;
    expect((await skel(["start", `app-t100`])).out).toBe(`Started app-t100.\n`);
    await until(() => log().split(ready).length > before, longWait);
    expect(log()).not.toContain("was deleted");
    expect(onRemote()).toBe(true);
  }, 200_000);

  // Starting a done thread over deletes the old thread's refs first. Two starts at once must
  // not let the second delete the refs of the thread the first started: without its push ref,
  // a poll never sees its branch merged. The stand-in for git holds every later deletion of a
  // push ref until the new thread has pushed, as a slow deletion would.
  test("two starts over at once start one thread, whose merge still ends it", async () => {
    const bare = addAppOnGit();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Ready again.");
    serveOutsideCheckout();
    await untilCloned();
    expect((await skel(["start", "app", "Add export", "As JSON"])).err).toBe("");
    const log = () => read(join(data(), "threads", `app-t100.log`));
    const ready = `app-t100 is ready on branch skelcrew/t100-add-export`;
    await until(() => log().includes(ready), 30_000);
    expect((await skel(["rm", `app-t100`])).err).toBe("");
    const realGit = Bun.which("git");
    const clone = join(data(), "repos", "simon", "app");
    const first = join(home, "first-deletion");
    script(
      "git",
      `case "$*" in *"update-ref -d refs/skelcrew/threads/app-t100"*)
  if ! mkdir "${first}" 2>/dev/null; then
    for i in $(seq 300); do
      "${realGit}" -C "${clone}" rev-parse --verify --quiet refs/skelcrew/threads/app-t100 >/dev/null && break
      sleep 0.1
    done
  fi ;;
esac
exec "${realGit}" "$@"`,
    );
    const before = log().split(ready).length;
    const starts = await Promise.all([skel(["start", `app-t100`]), skel(["start", `app-t100`])]);
    expect(starts.map((s) => s.out).filter((out) => out === `Started app-t100.\n`)).toHaveLength(1);
    expect(starts.map((s) => s.err).join("")).toContain(`app-t100 has a thread already`);
    await until(() => log().split(ready).length > before, 30_000);
    // You merge the new thread's branch, and Skelcrew sees it.
    const work = join(home, "work", "app");
    git(work, "pull", "-q", bare, "main");
    git(work, "fetch", "-q", bare, `skelcrew/t100-add-export`);
    git(work, "merge", "--squash", "-q", "FETCH_HEAD");
    git(work, "commit", "-q", "-m", "Add export");
    git(work, "push", "-q", bare, "main");
    await until(() => log().includes("is merged into main"), 30_000);
  }, 90_000);

  // sc rm deletes the branch before it ends the thread. A poll in between must not take the
  // thread for one whose branch someone else deleted. The fake remote holds the deletion open
  // after the branch is gone, so the polls see that moment.
  test("a poll while sc rm deletes the branch leaves the thread to sc rm", async () => {
    const bare = addAppOnGit();
    verdict(1, "approve", "Ready to merge.");
    // Each look a poll takes at whether the branch is on the remote is a git ls-remote.
    const trace = join(home, "git-trace");
    const looks = () => read(trace).split("trace: built-in: git ls-remote").length - 1;
    serveOutsideCheckout({ GIT_TRACE: trace });
    await untilCloned();
    expect((await skel(["start", "app", "Add export", "As JSON"])).err).toBe("");
    const log = () => read(join(data(), "threads", `app-t100.log`));
    await until(
      () => log().includes(`app-t100 is ready on branch skelcrew/t100-add-export`),
      30_000,
    );
    const hook = join(bare, "hooks", "post-receive");
    writeFileSync(
      hook,
      `while read old new ref; do
  case "$new" in *[!0]*) ;; *)
    : > "${home}/deleted"
    i=0; while ! test -e "${home}/go" && test -d "${home}" && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done ;;
  esac
done`,
    );
    chmodSync(hook, 0o755);
    const removing = skel(["rm", `app-t100`]);
    await until(() => existsSync(join(home, "deleted")), 30_000);
    // sc rm's own look came before it deleted the branch, so a look from now on is a poll's.
    // Polls of a repository never overlap, so once a second has begun, the first one has
    // decided what the gone branch means for the thread.
    const before = looks();
    await until(() => looks() >= before + 2, 30_000);
    writeFileSync(join(home, "go"), "");
    const removed = await removing;
    expect(removed.err).toBe("");
    expect(removed.out).toContain(`Removed app-t100.`);
    expect(log()).not.toContain("was deleted");
    expect(log()).toContain('"why":"removed: ended the thread"');
  }, 60_000);
});
