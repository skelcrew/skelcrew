// sc ps, sc issue ls, sc issue show and sc attach, run as you or the lead would run
// them, against a running daemon, a fake gh, a fake Claude Code and a fake tmux for attaching.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { homeEnv, itemSql, read, runSkel, source, startDaemon, until } from "./harness.ts";

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
INSERT INTO threads (owner, repo, task, folder, branch, status, needs_you, session, title, short) VALUES
  ('simon', 'app', 3, 'app-3', 'skelcrew/3', 'done', 0, NULL, 'Fix typo', 'Typo'),
  ('simon', 'site', 7, 'site-7', 'skelcrew/7', 'waiting', 1, 's7', 'Add docs', NULL),
  ('simon', 'app', 12, 'app-12', 'skelcrew/12', 'working', 0, 's12', 'Add export', 'JSON export'),
  ('simon', 'app', 9, 'app-9', 'skelcrew/9', 'failed', 0, NULL, 'Send people back to the page they came from after signing in', NULL);`);
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
  // to the room the sidebar gives it, so a long title doesn't push the other columns away.
  test("lists live threads newest first, with their short title, status and whether they need you", async () => {
    threads();
    serve();
    await untilAnswers();
    const listed = await skel(["ps"]);
    expect(listed.err).toBe("");
    expect(listed.out).toBe(
      "THREAD  TITLE                            STATUS   NEEDS YOU\n" +
        "app-9   Send people back to the page t…  failed\n" +
        "app-12  JSON export                      working\n" +
        "site-7  Add docs                         waiting  yes\n",
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
      "THREAD  TITLE                            STATUS   NEEDS YOU\n" +
        "app-9   Send people back to the page t…  failed\n" +
        "app-12  JSON export                      working\n" +
        "site-7  Add docs                         waiting  yes\n" +
        "app-3   Typo                             done\n",
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
      { thread: "site-7", short: null, title: "Add docs", status: "waiting", needsYou: true },
    ]);
    expect(JSON.parse((await skel(["ps", "--json", "app"])).out)).toHaveLength(2);
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
      { thread: "app-12", short: null, title: null, status: "working", needsYou: false },
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
      "ISSUE   THREAD              TITLE\n" +
        "app-12  working             Add export\n" +
        "site-7  waiting, needs you  New landing page\n" +
        "app-10                      Fix login\n",
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
      { issue: "app-12", title: "Add export", thread: { status: "working", needsYou: false } },
      { issue: "app-10", title: "Fix login", thread: null },
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
  });

  test("shows a task's title and body, and the thread on it", async () => {
    serve();
    await untilAnswers();
    const shown = await skel(["issue", "show", "site-7"]);
    expect(shown.err).toBe("");
    expect(shown.out).toBe(
      "site-7  New landing page\nThread: waiting, needs you\n\nMake it calm.\n",
    );
    expect(read(join(home, "calls"))).not.toContain("issues");
    expect((await skel(["issue", "show", "app-10"])).out).toBe("app-10  Fix login\n");
  });

  test("shows a task as JSON for tools", async () => {
    serve();
    await untilAnswers();
    const shown = await skel(["issue", "show", "app-12", "--json"]);
    expect(shown.err).toBe("");
    expect(JSON.parse(shown.out)).toEqual({
      issue: "app-12",
      title: "Add export",
      body: "Export threads as JSON.\n\nKeep it small.",
      thread: { status: "working", needsYou: false },
    });
    expect(JSON.parse((await skel(["issue", "show", "--json", "app-10"])).out)).toEqual({
      issue: "app-10",
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
describe.skipIf(process.env.SKELCREW_SANDBOX === "1")("from the lead", () => {
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
      { issue: "app-12", title: "Add export", thread: { status: "working", needsYou: false } },
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
