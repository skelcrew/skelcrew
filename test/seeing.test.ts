// sc ps, sc issue ls, sc issue show and sc attach, run as you or the lead would run
// them, against a running daemon, a fake gh, a fake Claude Code and a fake tmux for attaching.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  answer,
  asked,
  fakePlugin,
  homeEnv,
  insideSandbox,
  itemSql,
  read,
  runSkel,
  source,
  startDaemon,
  threadSql,
  until,
} from "./harness.ts";

const dbFile = source("db.ts");
let home = "";
let socket = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skelcrew");

function fake(name: string, body: string): void {
  writeFileSync(
    join(home, "bin", name),
    `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`,
    { mode: 0o755 },
  );
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-seeing-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  writeFileSync(join(home, "bin", "claude"), "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
  fake("systemctl", "exit 0");
  fake("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  // The fake GitHub answers nothing, so the daemon's polls fail and Skelcrew's copy keeps what
  // each test puts in it.
  fake("gh", "exit 1");
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
});
afterEach(async () => {
  for (const serve of running.splice(0)) {
    serve.kill();
    await serve.exited;
  }
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
});

// What this test's processes run with.
const env = () => homeEnv(home);

// Runs this test's daemon, which the test's clean-up stops.
const serve = () => startDaemon(socket, env(), running);

// Runs sc as you or the lead would.
const skel = (args: string[], more: Record<string, string> = {}) =>
  runSkel(args, { ...env(), ...more });

async function untilAnswers() {
  await until(() => existsSync(join(home, "run", "skelcrew.sock")));
  await Bun.sleep(100);
}

// Runs SQL against Skelcrew's database as Skelcrew itself would open it, so its tables exist.
function sql(statements: string): void {
  const script = `import { openDb } from ${JSON.stringify(dbFile)};
openDb().run(${JSON.stringify(statements)});`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
}

// Skelcrew has app and site, and four threads, started in this order. The live ones have their
// builders running, so the daemon leaves them be as it starts.
function threads(): void {
  sql(`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app'), ('site', 'simon', 'site');
${threadSql({ task: "3", status: "done", title: "Fix typo", short: "Typo" })}
${threadSql({ repo: "site", task: "7", status: "waiting", needs_you: 1, session: "s7", title: "Add docs" })}
${threadSql({ task: "12", session: "s12", title: "Add export", short: "JSON export" })}
${threadSql({ task: "9", status: "failed", title: "Send people back to the page they came from after signing in" })}`);
  for (const live of ["site-7", "app-12"])
    Bun.spawnSync([
      "tmux",
      "-L",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      live,
      "sleep 300",
    ]);
}

// Runs tmux on this test's own server, where the threads' sessions are.
const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args], { stderr: "pipe" });

// The socket the daemon opens for a repository's lead, named by a short hash of its GitHub name.
const leadSocket = (repo = "app") => {
  const short = new Bun.CryptoHasher("sha256").update(`simon/${repo}`).digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "leads", short, "skelcrew.sock");
};

// Has the daemon open app, as plain sc in its checkout does, which opens its lead's socket
// and starts its lead. Skelcrew's clone of it is there first, as adding it leaves one. Inside
// Skelcrew's own sandbox the lead can't start, but its socket is open all the same.
async function openApp(): Promise<void> {
  const clone = join(data(), "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  Bun.spawnSync(["git", "-C", clone, "init", "-q"]);
  await new Promise<void>((done) => {
    const connection = createConnection(join(home, "run", "skelcrew.sock"));
    connection.on("connect", () => connection.write('{"command":"lead","from":"simon/app"}\n'));
    connection.on("data", () => {});
    connection.on("error", () => done());
    connection.on("close", () => done());
  });
}

describe("sc ps", () => {
  // A thread's short title says what it is in a few words. One with none shows its title, cut
  // so the row fits 80 columns. Without a forge there is no PR, CI or review to show.
  test("lists live threads newest first, with their short title, status, whether they need you and messages waiting", async () => {
    threads();
    sql(
      "INSERT INTO messages (folder, sender, text, said, at) VALUES ('app-12', 'skelcrew', 'Fix it.', 'Fix it.', 0)",
    );
    serve();
    await untilAnswers();
    const listed = await skel(["ps"]);
    expect(listed.err).toBe("");
    expect(listed.out).toBe(
      "THREAD  TITLE                        STATUS   PR  CI  REVIEW  NEEDS YOU  WAITING\n" +
        "app-9   Send people back to the pa…  failed\n" +
        "app-12  JSON export                  working                             1\n" +
        "site-7  Add docs                     waiting                  yes\n",
    );
  });

  // Done threads pile up forever, and would bury the live ones.
  test("shows done threads only with --all", async () => {
    threads();
    serve();
    await untilAnswers();
    const listed = await skel(["ps", "--all"]);
    expect(listed.err).toBe("");
    expect(listed.out).toBe(
      "THREAD  TITLE                                 STATUS   PR  CI  REVIEW  NEEDS YOU\n" +
        "app-9   Send people back to the page they c…  failed\n" +
        "app-12  JSON export                           working\n" +
        "site-7  Add docs                              waiting                  yes\n" +
        "app-3   Typo                                  done\n",
    );
    expect(JSON.parse((await skel(["ps", "app", "--json", "--all"])).out)).toHaveLength(3);
  });

  test("lists one repository's threads, as JSON for tools", async () => {
    threads();
    serve();
    await untilAnswers();
    const listed = await skel(["ps", "site", "--json"]);
    expect(listed.err).toBe("");
    expect(JSON.parse(listed.out)).toEqual([
      {
        thread: "site-7",
        short: null,
        title: "Add docs",
        status: "waiting",
        needsYou: true,
        queued: false,
        branch: "skelcrew/7",
        pr: null,
        prUrl: null,
        checks: null,
        review: null,
        waiting: 0,
      },
    ]);
    expect(JSON.parse((await skel(["ps", "--json", "app"])).out)).toHaveLength(2);
  });

  // A stopped thread can keep the fields of the review its stop cancelled.
  test("says a stopped thread is stopped, not queued for review", async () => {
    sql(`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
${threadSql({ task: "3", status: "stopped", title: "Old", reviewing: "abc", queued: 5 })}`);
    serve();
    await untilAnswers();
    const listed = await skel(["ps"]);
    expect(listed.err).toBe("");
    expect(listed.out).toBe(
      "THREAD  TITLE  STATUS   PR  CI  REVIEW  NEEDS YOU\napp-3   Old    stopped\n",
    );
  });

  test("says when there are no threads, and when the repository isn't Skelcrew's", async () => {
    serve();
    await untilAnswers();
    expect((await skel(["ps"])).out).toBe("There are no threads.\n");
    const unknown = await skel(["ps", "web"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain("no repository named web");
  });

  test("shows threads from a database made before threads could need you", async () => {
    mkdirSync(data(), { recursive: true });
    const old = new Database(join(data(), "skelcrew.db"));
    old.run(`CREATE TABLE threads (owner TEXT NOT NULL, repo TEXT NOT NULL, task INTEGER NOT NULL,
      folder TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, base TEXT, status TEXT NOT NULL,
      session TEXT, PRIMARY KEY (owner, repo, task))`);
    old.run(
      "INSERT INTO threads VALUES ('simon', 'app', 12, 'app-12', 'skelcrew/12', NULL, 'working', 's12')",
    );
    old.close();
    // Its builder runs, so the daemon leaves it be as it starts.
    Bun.spawnSync([
      "tmux",
      "-L",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "app-12",
      "sleep 300",
    ]);
    sql("INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app')");
    serve();
    await untilAnswers();
    expect(JSON.parse((await skel(["ps", "--json"])).out)).toEqual([
      {
        thread: "app-12",
        short: null,
        title: null,
        status: "working",
        needsYou: false,
        queued: false,
        branch: "skelcrew/12",
        pr: null,
        prUrl: null,
        checks: null,
        review: null,
        waiting: 0,
      },
    ]);
  });

  test("says when the daemon isn't running", async () => {
    const listed = await skel(["ps"]);
    expect(listed.code).not.toBe(0);
    expect(listed.err).toContain("run sc");
  });
});

// Puts open issues in Skelcrew's copy of simon's repository, as a poll would.
function issues(repo: string, list: { number: number; title: string; createdAt: string }[]) {
  for (const { number, title, createdAt } of list)
    sql(itemSql(repo, "task", number, title, createdAt));
}

describe("sc issue ls", () => {
  beforeEach(() => {
    threads();
    issues("app", [
      { number: 12, title: "Add export", createdAt: "2026-11-03T12:00:00Z" },
      { number: 10, title: "Fix login", createdAt: "2026-11-01T12:00:00Z" },
    ]);
    issues("site", [{ number: 7, title: "New landing page", createdAt: "2026-11-02T12:00:00Z" }]);
  });

  test("lists every repository's open issues newest first, with the thread on each", async () => {
    serve();
    await untilAnswers();
    const listed = await skel(["issue", "ls"]);
    expect(listed.err).toBe("");
    expect(listed.out).toBe(
      "ISSUE   STAGE    THREAD              TITLE\n" +
        "app-12  working  working             Add export\n" +
        "site-7  working  waiting, needs you  New landing page\n" +
        "app-10  issue                        Fix login\n",
    );
    // They come from Skelcrew's copy, with no call to GitHub.
    expect(read(join(home, "calls"))).not.toContain("issue");
  });

  test("lists one repository's open issues, as JSON for tools", async () => {
    serve();
    await untilAnswers();
    const listed = await skel(["issue", "ls", "app", "--json"]);
    expect(listed.err).toBe("");
    expect(JSON.parse(listed.out)).toEqual([
      {
        issue: "app-12",
        stage: "working",
        title: "Add export",
        thread: { status: "working", needsYou: false },
      },
      { issue: "app-10", stage: "issue", title: "Fix login", thread: null },
    ]);
  });

  test("says when there are no open issues", async () => {
    sql("DELETE FROM items WHERE repo = 'app'");
    serve();
    await untilAnswers();
    expect((await skel(["issue", "ls", "app"])).out).toBe("There are no open issues.\n");
  });
});

// As an agent runs sc: in its sandbox, where Skelcrew's database is hidden under an empty home
// folder, and with its own socket from the daemon.
async function asAgent(args: string[], socket: string) {
  const empty = join(home, "sandbox-home");
  mkdirSync(empty, { recursive: true });
  return skel(args, { HOME: empty, SKELCREW_SANDBOX: "1", SKELCREW_SOCKET: socket });
}

// The socket the daemon opens for app-12's builder, once its thread is live.
async function builderSocket(): Promise<string> {
  const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
  const builder = join(home, "run", "skelcrew", "threads", short, "skelcrew.sock");
  await until(() => existsSync(builder));
  return builder;
}

// Puts one open issue in Skelcrew's copy of simon's repository, with its body, as a poll would.
function issue(repo: string, number: number, title: string, body: string) {
  sql(itemSql(repo, "task", number, title, "2026-11-01T12:00:00Z", { body }));
}

describe("sc issue show", () => {
  beforeEach(() => {
    threads();
    issue("app", 12, "Add export", "Export threads as JSON.\n\nKeep it small.");
    issue("app", 10, "Fix login", "");
    issue("site", 7, "New landing page", "Make it calm.");
    // Each started task saved its issue's words as it started.
    sql(`UPDATE tasks SET title = 'Add export', body = 'Export threads as JSON.

Keep it small.' WHERE repo = 'app' AND task = '12';
UPDATE tasks SET title = 'New landing page', body = 'Make it calm.' WHERE repo = 'site'`);
  });

  // The reviewer checks against what the builder was given, so an edit to the issue after the
  // start never changes the task. The lead passes on what matters as a message.
  test("shows a started task as it started, after its issue was edited", async () => {
    issue("app", 12, "Add export as CSV", "Export threads as CSV.");
    serve();
    await untilAnswers();
    const shown = JSON.parse((await skel(["issue", "show", "app-12", "--json"])).out);
    expect(shown).toMatchObject({
      title: "Add export",
      body: "Export threads as JSON.\n\nKeep it small.",
    });
  });

  test("shows a task's title and body, and the thread on it", async () => {
    serve();
    await untilAnswers();
    const shown = await skel(["issue", "show", "site-7"]);
    expect(shown.err).toBe("");
    expect(shown.out).toBe(
      "site-7  New landing page\nStage: working\nThread: waiting, needs you\n\nMake it calm.\n",
    );
    expect(read(join(home, "calls"))).not.toContain("issues");
    expect((await skel(["issue", "show", "app-10"])).out).toBe("app-10  Fix login\nStage: issue\n");
  });

  test("shows a task as JSON for tools", async () => {
    serve();
    await untilAnswers();
    const shown = await skel(["issue", "show", "app-12", "--json"]);
    expect(shown.err).toBe("");
    expect(JSON.parse(shown.out)).toEqual({
      issue: "app-12",
      link: "https://github.com/simon/app/issues/12",
      stage: "working",
      title: "Add export",
      body: "Export threads as JSON.\n\nKeep it small.",
      thread: { status: "working", needsYou: false },
    });
    expect(JSON.parse((await skel(["issue", "show", "--json", "app-10"])).out)).toEqual({
      issue: "app-10",
      link: "https://github.com/simon/app/issues/10",
      stage: "issue",
      title: "Fix login",
      body: "",
      thread: null,
    });
  });

  test("says when the task or the repository doesn't exist", async () => {
    serve();
    await untilAnswers();
    const missing = await skel(["issue", "show", "app-99"]);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toBe("Skelcrew: there is no open issue 99 in simon/app\n");
    const unknown = await skel(["issue", "show", "web-1"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain("no repository named web");
  });

  // The lead's messages to a builder change its task after the thread started, so they show
  // after the body, oldest first, as the thread's reviewer gets them. A builder's message to
  // the lead never does: a builder must not change what it is reviewed against.
  test("shows the lead's messages to the builder after the task, and not the builder's", async () => {
    // app-12's builder waits at a bare prompt, so the lead's messages are typed in at once.
    tmux("kill-session", "-t", "=app-12");
    tmux("new-session", "-d", "-s", "app-12", "stty -echo; echo ❯; exec sleep 300");
    serve();
    await untilAnswers();
    await openApp();
    const builder = await builderSocket();
    for (const text of ["Keep the CSV export too.", "Name the file export.json."])
      expect((await asAgent(["tell", "app-12", text], leadSocket())).err).toBe("");
    expect((await asAgent(["tell", "lead", "Done with the CSV part."], builder)).err).toBe("");
    const log = () => read(join(data(), "threads", "app-12.log"));
    await until(() => log().includes("export.json"), { timeout: 15_000 });
    const shown = await skel(["issue", "show", "app-12"]);
    expect(shown.err).toBe("");
    expect(shown.out).toMatch(
      /^app-12 {2}Add export\nStage: working\nThread: working\n\nExport threads as JSON\.\n\nKeep it small\.\n\n## Changes to the task from the lead, after the thread started\n\nThese override the task above where they differ\. The latest comes last\.\n\n### \d{4}-\d\d-\d\d \d\d:\d\d UTC\n\nKeep the CSV export too\.\n\n### \d{4}-\d\d-\d\d \d\d:\d\d UTC\n\nName the file export\.json\.\n$/,
    );
    expect(shown.out).not.toContain("Done with the CSV part.");
    // The thread's log keeps each one, with who sent it and when.
    const last = JSON.parse(log().trim().split("\n").at(-1) ?? "{}");
    expect(last.updates).toEqual([
      { from: "lead", at: expect.any(Number), text: "Keep the CSV export too." },
      { from: "lead", at: expect.any(Number), text: "Name the file export.json." },
    ]);
  });

  // A thread with no task in the tracker shows the title and body it started with.
  test("shows a thread with no task in the tracker, with the lead's messages", async () => {
    sql(threadSql({ task: "t1", session: "s1", title: "Add docs", body: "A page." }));
    tmux("new-session", "-d", "-s", "app-t1", "stty -echo; echo ❯; exec sleep 300");
    serve();
    await untilAnswers();
    await openApp();
    expect((await asAgent(["tell", "app-t1", "Two pages."], leadSocket())).err).toBe("");
    await until(() => read(join(data(), "threads", "app-t1.log")).includes("Two pages."), {
      timeout: 15_000,
    });
    const shown = JSON.parse((await skel(["issue", "show", "app-t1", "--json"])).out);
    expect(shown).toMatchObject({ issue: "app-t1", title: "Add docs" });
    expect(shown.body).toMatch(
      /^A page\.\n\n## Changes to the task from the lead.*\n\nTwo pages\.$/s,
    );
  });

  // A done or failed thread starts over with a fresh row, so its builder and reviewer would
  // never see its old messages, and a merged thread's issue is closed.
  test("shows a done thread's task without its messages, and its closed issue as missing", async () => {
    const updates = JSON.stringify([{ from: "lead", at: 0, text: "Keep the CSV export too." }]);
    sql(`UPDATE threads SET status = 'done' WHERE task IN ('12', '3');
UPDATE tasks SET updates = '${updates}' WHERE task IN ('12', '3')`);
    serve();
    await untilAnswers();
    const shown = await skel(["issue", "show", "app-12"]);
    expect(shown.err).toBe("");
    expect(shown.out).toBe(
      "app-12  Add export\nStage: issue\nThread: done\n\nExport threads as JSON.\n\nKeep it small.\n",
    );
    const closed = await skel(["issue", "show", "app-3"]);
    expect(closed.code).not.toBe(0);
    expect(closed.err).toBe("Skelcrew: there is no open issue 3 in simon/app\n");
  });

  // With no issue behind it, a task whose work ended is merged or closed, never back in stage
  // issue.
  test("shows a done task with no issue as merged or closed", async () => {
    sql(`${threadSql({ task: "t1", status: "done", title: "Add docs" })}
${threadSql({ task: "t2", status: "done", title: "Add tests" })}
UPDATE tasks SET merged = 1 WHERE task = 't2'`);
    serve();
    await untilAnswers();
    expect((await skel(["issue", "show", "app-t1"])).out).toBe(
      "app-t1  Add docs\nStage: closed\nThread: done\n",
    );
    expect((await skel(["issue", "show", "app-t2"])).out).toBe(
      "app-t2  Add tests\nStage: merged\nThread: done\n",
    );
  });

  test("the lead can show a task from its sandbox, and a builder can't", async () => {
    serve();
    await untilAnswers();
    await openApp();
    const lead = await asAgent(["issue", "show", "app-12"], leadSocket());
    expect(lead.err).toBe("");
    expect(lead.out).toBe((await skel(["issue", "show", "app-12"])).out);
    const refused = await asAgent(["issue", "show", "app-12"], await builderSocket());
    expect(refused.code).not.toBe(0);
    expect(refused.err).toBe("Skelcrew: the daemon doesn't know that request\n");
  });
});

// app has the fake plugin as its forge, and site has none. The fake forge fails every poll, so
// Skelcrew's copy keeps what each test puts in it. app-14's review is under way, app-12's last
// review asked for changes in round 3 and its CI failed, and app-9 never got a PR.
function forgeThreads(): string {
  const settings = fakePlugin(home);
  writeFileSync(join(settings, "fail-changed"), "no network in tests");
  // The daemon carries on app-14's review as it starts. It waits on the forge to show it under
  // way, so it stays under way.
  writeFileSync(join(settings, "hold-status"), "");
  answer(settings, "log", { log: "\x1b[31mexpected 2, got 3\x1b[0m\r\nat line 4" });
  sql(`INSERT INTO repositories (name, owner, repo, forge, claimed, remote) VALUES
  ('app', 'simon', 'app', 'github', 1, 'https://github.com/simon/app.git'),
  ('site', 'simon', 'site', NULL, 1, 'https://example.com/simon/site.git');
${threadSql({ task: "9", status: "failed", title: "Old" })}
${threadSql({ task: "12", status: "waiting", session: "s12", title: "Add\nexport", short: "JSON export", pr: 31, checks: "failing", rounds: 3, verdict: "changes", review_round: 3, review_at: 1763290800000 })}
${threadSql({ task: "14", status: "waiting", session: "s14", title: "Fix login", pr: 33, checks: "pending", rounds: 1, verdict: "changes", review_round: 1, review_at: 1763294400000, reviewing: "abc" })}
${threadSql({ repo: "site", task: "7", status: "waiting", session: "s7", title: "Add docs", verdict: "approve", review_round: 1, review_at: 1763290800000 })}`);
  const bot = { login: "skelcrew[bot]", bot: true, you: false, push: false };
  sql(
    itemSql("app", "pr", 31, "Add\x07export", "2026-11-05T10:00:00Z", {
      branch: "skelcrew/12",
      body: "Adds export.\r\n\r\nCloses #12",
      checks: [
        { name: "test", id: "501", state: "failed" },
        { name: "lint", id: "502", state: "passed" },
        { name: "skelcrew/check", id: null, state: "failed" },
      ],
      reviews: [
        {
          id: "1",
          text: "**Changes requested**\n\nRename the \x1b[31mflag\x1b[0m.",
          author: bot,
          verdict: "commented",
          lines: [],
        },
      ],
    }),
  );
  sql(itemSql("app", "pr", 33, "Fix login", "2026-11-06T10:00:00Z", { branch: "skelcrew/14" }));
  sql(itemSql("app", "pr", 40, "Bump deps", "2026-11-07T10:00:00Z"));
  for (const live of ["app-12", "app-14", "site-7"])
    tmux("new-session", "-d", "-s", live, "sleep 300");
  return settings;
}

// More of app's threads, beside forgeThreads': app-16's review is under way while its builder
// asks a question, and app-17's while it is past the round limit of 3. app-18's round fails on
// its push, as its clone was never set up. app-19 failed while CI still ran on its PR, and CI
// passed after, which only the copy of its PR has heard.
function moreThreads(): void {
  sql(`${threadSql({ task: "16", status: "waiting", session: "s16", title: "Asks", pr: 35, rounds: 2, asking: 1, verdict: "changes", review_round: 2, reviewing: "def" })}
${threadSql({ task: "17", status: "waiting", session: "s17", title: "Past", pr: 36, rounds: 4, needs_you: 1, verdict: "changes", review_round: 4, reviewing: "ghi" })}
${threadSql({ task: "18", status: "waiting", session: "s18", title: "Push", pr: 37, submitting: "Go" })}
${threadSql({ task: "19", status: "failed", title: "Late CI", pr: 38, checks: "pending" })}`);
  sql(
    itemSql("app", "pr", 38, "Late CI", "2026-11-08T10:00:00Z", {
      checks: [{ name: "test", id: "601", state: "passed" }],
    }),
  );
  for (const live of ["app-16", "app-17", "app-18"])
    tmux("new-session", "-d", "-s", live, "sleep 300");
}

// Runs sc in a folder, as you would in a checkout.
async function skelIn(cwd: string, args: string[]) {
  const run = Bun.spawn([process.execPath, source("main.ts"), ...args], {
    cwd,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return { out, err, code: await run.exited };
}

// What sc pr show prints for app's PR 31, from Skelcrew's copy, with the forge's log of its
// failed check. The colour codes and other control characters from the forge are gone.
const pr31 = `#31  Add export
State   open
Branch  skelcrew/12 → main
Thread  app-12
Checks  failed
        test: failed
        lint: passed
Review  Changes requested · skelcrew[bot]
Link    https://github.com/simon/app/pull/31

Latest review
**Changes requested**

Rename the flag.

Description
Adds export.

Closes #12

Log of test, from the forge
expected 2, got 3
at line 4
`;

describe("with a forge", () => {
  // Each thread's PR, what its CI says and where its review stands, in a row that still fits
  // 80 columns. A repository with no forge has none of them.
  test("sc ps shows each thread's PR, CI and review, with its round", async () => {
    forgeThreads();
    serve();
    await untilAnswers();
    const listed = await skel(["ps"]);
    expect(listed.err).toBe("");
    expect(listed.out).toBe(
      "THREAD  TITLE        STATUS   PR   CI       REVIEW        NEEDS YOU\n" +
        "site-7  Add docs     waiting\n" +
        "app-14  Fix login    waiting  #33  running  reviewing r2\n" +
        "app-12  JSON export  waiting  #31  failed   changes r3\n" +
        "app-9   Old          failed                 none\n",
    );
    for (const line of listed.out.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    const json = JSON.parse((await skel(["ps", "app", "--json"])).out);
    expect(json[1]).toEqual({
      thread: "app-12",
      short: "JSON export",
      title: "Add export",
      status: "waiting",
      needsYou: false,
      queued: false,
      branch: "skelcrew/12",
      pr: 31,
      prUrl: "https://github.com/simon/app/pull/31",
      checks: "failed",
      review: { state: "changes", round: 3, at: "2025-11-16T11:00:00.000Z" },
      waiting: 0,
    });
    expect(json[0].review).toEqual({
      state: "reviewing",
      round: 2,
      at: "2025-11-16T12:00:00.000Z",
    });
    expect(json[2]).toMatchObject({ pr: null, checks: null, review: { state: "none" } });
  });

  // A question or the round limit comes on top of a review under way without changing it. A
  // round that failed says so. A thread polls pass over takes its CI from the copy of its PR.
  test("sc ps shows a review under way whatever else the thread needs, and CI from the copy", async () => {
    forgeThreads();
    moreThreads();
    serve();
    await untilAnswers();
    type Row = { thread: string; checks: string | null; review: { state: string; round: number } };
    const rows = async () => {
      const listed: Row[] = JSON.parse((await skel(["ps", "app", "--json"])).out);
      return Object.fromEntries(listed.map((row) => [row.thread, row]));
    };
    // app-18's push fails a moment after the daemon starts.
    let shown = await rows();
    for (let tries = 0; shown["app-18"]?.review.state !== "failed" && tries < 100; tries++) {
      await Bun.sleep(100);
      shown = await rows();
    }
    expect(shown["app-16"]?.review).toMatchObject({ state: "reviewing", round: 3 });
    expect(shown["app-17"]?.review).toMatchObject({ state: "reviewing", round: 5 });
    expect(shown["app-18"]?.review).toMatchObject({ state: "failed", round: 1 });
    expect(shown["app-19"]?.checks).toBe("passed");
    // A live thread keeps the word its polls keep.
    expect(shown["app-14"]?.checks).toBe("running");
  });

  test("sc pr show shows a thread's PR from Skelcrew's copy, with the log of a failed check", async () => {
    const settings = forgeThreads();
    serve();
    await untilAnswers();
    const shown = await skel(["pr", "show", "app-12"]);
    expect(shown.err).toBe("");
    expect(shown.out).toBe(pr31);
    // Only the log comes from the forge, and only for the failed check with a log.
    const logs = asked(settings).filter((question) => question.ask === "log");
    expect(logs).toEqual([{ ask: "log", repository: "simon/app", check: "501" }]);
  });

  // The forge can hang on a log, and sc gives up on the daemon after a minute, so the log has a
  // deadline of its own, and the PR still shows with why its log is missing.
  test("sc pr show still shows the PR when the forge hangs on a log", async () => {
    const settings = forgeThreads();
    writeFileSync(join(settings, "hold-log"), "");
    serve();
    await untilAnswers();
    const started = Date.now();
    const shown = await skel(["pr", "show", "app-12"]);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(shown.err).toBe("");
    expect(shown.out).toStartWith("#31  Add export\n");
    expect(shown.out).toEndWith(
      "Log of test, from the forge\n(Skelcrew couldn't read its log: github didn't answer within 10 seconds)\n",
    );
  }, 40_000);

  test("sc pr show takes a PR's number, or #N, in a checkout of its repository", async () => {
    forgeThreads();
    const checkout = join(home, "app");
    mkdirSync(checkout);
    Bun.spawnSync(["git", "-C", checkout, "init", "-q"]);
    Bun.spawnSync([
      "git",
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      "git@github.com:simon/app.git",
    ]);
    serve();
    await untilAnswers();
    expect((await skelIn(checkout, ["pr", "show", "#31"])).out).toBe(pr31);
    const bare = await skelIn(checkout, ["pr", "show", "40"]);
    expect(bare.err).toBe("");
    expect(bare.out).toStartWith(
      "#40  Bump deps\nState   open\nBranch  b40 → main\nThread  none\nChecks  none\nReview  none\n",
    );
    // Outside any checkout, a number names no repository.
    const away = await skelIn(home, ["pr", "show", "31"]);
    expect(away.code).not.toBe(0);
    expect(away.err).toContain("name the PR's thread, such as app-12");
    // sc --remote passes the repository of your laptop's checkout as --from.
    const sent = await skelIn(home, ["pr", "show", "31", "--from", "git@github.com:simon/app.git"]);
    expect(sent.out).toBe(pr31);
  });

  test("sc pr show gives JSON for tools", async () => {
    forgeThreads();
    serve();
    await untilAnswers();
    const shown = await skel(["pr", "show", "app-12", "--json"]);
    expect(JSON.parse(shown.out)).toEqual({
      pr: 31,
      title: "Add export",
      state: "open",
      branch: "skelcrew/12",
      base: "main",
      thread: "app-12",
      ci: "failed",
      checks: [
        { name: "test", state: "failed", log: "expected 2, got 3\nat line 4" },
        { name: "lint", state: "passed", log: null },
      ],
      review: {
        verdict: "Changes requested",
        author: "skelcrew[bot]",
        body: "**Changes requested**\n\nRename the flag.",
      },
      body: "Adds export.\n\nCloses #12",
      link: "https://github.com/simon/app/pull/31",
    });
  });

  // The lead has no login to the forge, so it reads PRs here. A number means its own repository,
  // wherever it runs, and it can't read another repository's.
  test("the lead runs sc pr show on its own repository only", async () => {
    forgeThreads();
    serve();
    await untilAnswers();
    await openApp();
    const own = await asAgent(["pr", "show", "31"], leadSocket());
    expect(own.err).toBe("");
    expect(own.out).toBe(pr31);
    const listed = JSON.parse((await asAgent(["ps", "--json"], leadSocket())).out);
    expect(listed.map((row: { thread: string }) => row.thread)).toEqual([
      "app-14",
      "app-12",
      "app-9",
    ]);
    const other = await asAgent(["pr", "show", "site-7"], leadSocket());
    expect(other.code).not.toBe(0);
    expect(other.err).toContain("you are the lead of simon/app only");
  });

  test("sc pr show says a repository with no forge has no PRs, and names what is missing", async () => {
    forgeThreads();
    serve();
    await untilAnswers();
    const none = await skel(["pr", "show", "site-7"]);
    expect(none.code).not.toBe(0);
    expect(none.err).toBe("Skelcrew: site has no forge, so there are no PRs\n");
    const early = await skel(["pr", "show", "app-9"]);
    expect(early.err).toBe("Skelcrew: app-9 has no PR yet\n");
    const gone = await skel(["pr", "show", "app-99"]);
    expect(gone.err).toBe("Skelcrew: there is no thread app-99\n");
    const usage = await skel(["pr", "show"]);
    expect(usage.err).toContain("sc pr was given arguments it doesn't take");
  });
});

describe("sc repo ls", () => {
  test("a lead lists only its own repository, as you see it in your terminal", async () => {
    threads();
    serve();
    await untilAnswers();
    const yours = await skel(["repo", "ls"]);
    expect(yours.out).toContain("site  simon/site");
    await openApp();
    const lead = await asAgent(["repo", "ls"], leadSocket());
    expect(lead.err).toBe("");
    expect(lead.out).toBe(
      `NAME  REPOSITORY  TRACKER  FORGE  CLONE\napp   simon/app   none     none   ${data()}/repos/simon/app\n`,
    );
  });

  test("a builder can't ask the daemon for the repositories", async () => {
    threads();
    serve();
    await untilAnswers();
    const refused = await asAgent(["repo", "ls"], await builderSocket());
    expect(refused.code).not.toBe(0);
    expect(refused.err).toBe("Skelcrew: the daemon doesn't know that request\n");
  });
});

describe("sc peek and sc interrupt", () => {
  // app-12's builder shows a line of its own and keeps every key it gets, as a terminal in raw
  // mode hands them on.
  beforeEach(() => {
    threads();
    const builder = "stty raw -echo; echo 'Writing the export'; exec cat > keys";
    tmux("respawn-pane", "-k", "-c", home, "-t", "=app-12:", "sh", "-c", builder);
  });
  const keys = () => read(join(home, "keys"));

  test("sc peek prints what the builder shows now", async () => {
    serve();
    await untilAnswers();
    await until(() => tmux("capture-pane", "-p", "-t", "=app-12:").stdout.includes("export"));
    const peeked = await skel(["peek", "app-12"]);
    expect(peeked.err).toBe("");
    expect(peeked.out).toBe("Writing the export\n");
  });

  test("sc interrupt sends the builder Esc, and its session goes on", async () => {
    serve();
    await untilAnswers();
    await until(() => tmux("capture-pane", "-p", "-t", "=app-12:").stdout.includes("export"));
    const interrupted = await skel(["interrupt", "app-12"]);
    expect(interrupted.err).toBe("");
    expect(interrupted.out).toBe(
      "Stopped app-12's turn, as Esc does. sc tell app-12 gives it what to do next.\n",
    );
    await until(() => keys() === "\x1b");
    expect(tmux("has-session", "-t", "=app-12").success).toBe(true);
  });

  test("both refuse a builder that isn't running, saying what state its thread is in", async () => {
    serve();
    await untilAnswers();
    const peeked = await skel(["peek", "app-9"]);
    expect(peeked.code).not.toBe(0);
    expect(peeked.err).toBe("Skelcrew: app-9's builder isn't running: the thread is failed\n");
    const interrupted = await skel(["interrupt", "app-9"]);
    expect(interrupted.err).toBe("Skelcrew: app-9's builder isn't running: the thread is failed\n");
    expect((await skel(["peek", "app-99"])).err).toBe("Skelcrew: there is no thread app-99\n");
    expect((await skel(["peek"])).err).toContain("sc peek was given arguments it doesn't take");
  });

  test("the lead can peek at and interrupt its own repository's builders only", async () => {
    serve();
    await untilAnswers();
    await openApp();
    await until(() => existsSync(leadSocket()));
    await until(() => tmux("capture-pane", "-p", "-t", "=app-12:").stdout.includes("export"));
    const peeked = await asAgent(["peek", "app-12"], leadSocket());
    expect(peeked.err).toBe("");
    expect(peeked.out).toBe("Writing the export\n");
    expect((await asAgent(["interrupt", "app-12"], leadSocket())).err).toBe("");
    await until(() => keys() === "\x1b");
    const other = await asAgent(["peek", "site-7"], leadSocket());
    expect(other.err).toContain("you are the lead of simon/app only, so site isn't yours");
    expect((await asAgent(["interrupt", "site-7"], leadSocket())).code).not.toBe(0);
  });

  // A builder has only its own screen, which it already sees.
  test("a builder can't peek or interrupt", async () => {
    serve();
    await untilAnswers();
    const builder = await builderSocket();
    for (const command of ["peek", "interrupt"]) {
      const refused = await asAgent([command, "site-7"], builder);
      expect(refused.code).not.toBe(0);
      expect(refused.err).toBe("Skelcrew: the daemon doesn't know that request\n");
    }
    expect(keys()).toBe("");
  });
});

describe("sc attach", () => {
  // The fake tmux has a session running for each file in ~/sessions, and a dead one, whose
  // builder exited, when that file says dead. It never reaches Skelcrew's real tmux server.
  beforeEach(() => {
    threads();
    mkdirSync(join(home, "sessions"));
    fake(
      "tmux",
      `session=$(printf '%s\\n' "$@" | sed -n 's/^=\\([^:]*\\):*$/\\1/p')
case "$*" in
*has-session*) test -e "$HOME/sessions/$session" ;;
*display-message*) grep -q dead "$HOME/sessions/$session" && echo 1 || echo 0 ;;
*capture-pane*) echo "Claude Code exited" ;;
*" new-session "*) exit 0 ;;
*) exit 1 ;;
esac`,
    );
  });
  const calls = () => read(join(home, "calls"));

  test("opens the screen on the builder's session, named when the thread started", async () => {
    writeFileSync(join(home, "sessions", "site-7"), "");
    sql("UPDATE repositories SET name = 'web' WHERE repo = 'site'");
    // Attaching makes sure the daemon runs, so one answers here, as a daemon would.
    const daemon = createServer((connection) =>
      connection.on("data", () => connection.end('{"running":true,"pid":1}\n')),
    );
    await new Promise<void>((done) => daemon.listen(join(home, "run", "skelcrew.sock"), done));
    const attached = await skel(["attach", "web-7"]).finally(() => daemon.close());
    expect(attached.err).toBe("");
    expect(attached.code).toBe(0);
    expect(calls()).toContain("tmux -L skelcrew-screen -f /dev/null");
    expect(calls()).toMatch(/new-session .* skelcrew site-7 lead-site-[a-p]+ ;/);
  });

  // A lead you exited a moment ago still reads as open until the daemon's next look, which
  // would then close the tab under the screen you just opened. So attaching always has the
  // daemon open the repository, which notices the exit first.
  test("has the daemon open the thread's repository, even one whose tab reads as open", async () => {
    writeFileSync(join(home, "sessions", "site-7"), "");
    const requests: unknown[] = [];
    const daemon = createServer((connection) =>
      connection.on("data", (data) => {
        requests.push(JSON.parse(data.toString()));
        connection.end('{"running":true,"pid":1}\n');
      }),
    );
    await new Promise<void>((done) => daemon.listen(join(home, "run", "skelcrew.sock"), done));
    const attached = await skel(["attach", "site-7"]).finally(() => daemon.close());
    expect(attached.err).toBe("");
    expect(requests).toContainEqual({ command: "lead", from: "simon/site" });
  });

  test("says when there is no such thread", async () => {
    const missing = await skel(["attach", "app-99"]);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toBe("Skelcrew: there is no thread app-99\n");
    expect((await skel(["attach", "web-1"])).err).toContain("no repository named web");
    expect(calls()).not.toContain("new-session");
  });

  test("says when the builder isn't running, and what state its thread is in", async () => {
    writeFileSync(join(home, "sessions", "app-12"), "dead");
    const dead = await skel(["attach", "app-12"]);
    expect(dead.code).not.toBe(0);
    expect(dead.err).toBe("Skelcrew: app-12's builder isn't running: the thread is working\n");
    const gone = await skel(["attach", "app-9"]);
    expect(gone.err).toBe("Skelcrew: app-9's builder isn't running: the thread is failed\n");
    expect(calls()).not.toContain("new-session");
  });

  test("refuses inside Skelcrew's sandbox, since it takes over your terminal", async () => {
    writeFileSync(join(home, "sessions", "app-12"), "");
    const refused = await skel(["attach", "app-12"], { SKELCREW_SANDBOX: "1" });
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("your own terminal");
    expect(calls()).toBe("");
    const sidebar = await skel(["sidebar", "skel", "screen-1", "local"], { SKELCREW_SANDBOX: "1" });
    expect(sidebar.err).toContain("your own terminal");
  });
});

// A list reads Skelcrew's copy in your own terminal, so an agent has nothing to ask the daemon.
test("an agent can't run the list command", async () => {
  const refused = await skel(["list", "a", "s", "issues", "", "simon/app"], {
    SKELCREW_SANDBOX: "1",
  });
  expect(refused.err).toContain("your own terminal");
});

// bubblewrap can't start inside Skelcrew's own sandbox, so only there the lead can't start.
describe.skipIf(insideSandbox)("from the lead", () => {
  test("a lead runs sc ps, sc issue ls, sc issue show and sc repo ls from its sandbox, but can't attach", async () => {
    threads();
    issue("app", 12, "Add export", "As JSON");
    writeFileSync(
      join(home, "bin", "claude"),
      `#!/bin/sh
case "$CLAUDE_CONFIG_DIR" in
*/lead-*) { sc ps app --json; sc issue ls app --json; sc issue show app-12 --json; sc repo ls --json; sc attach app-12; } > out.new 2>&1; mv out.new out ;;
esac
exec sleep 300
`,
      { mode: 0o755 },
    );
    serve();
    await untilAnswers();
    await openApp();
    const out = join(data(), "leads", "simon", "app", "out");
    await until(() => read(out) !== "");
    const [ps, tasks, shown, app, attach] = read(out).trim().split("\n");
    expect(JSON.parse(ps ?? "")).toHaveLength(2);
    expect(JSON.parse(tasks ?? "")).toEqual([
      {
        issue: "app-12",
        stage: "working",
        title: "Add export",
        thread: { status: "working", needsYou: false },
      },
    ]);
    expect(JSON.parse(shown ?? "")).toMatchObject({ issue: "app-12", body: "As JSON" });
    expect(JSON.parse(app ?? "")).toEqual([
      {
        name: "app",
        repository: "simon/app",
        tracker: null,
        forge: null,
        missing: null,
        clone: `${data()}/repos/simon/app`,
        tabClosed: false,
      },
    ]);
    expect(attach).toBe(
      "Skelcrew: attaching to a thread is only for your own terminal, not for agents",
    );
  }, 60_000);
});
