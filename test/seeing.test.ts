// skel ps, skel task ls, skel task show and skel attach, run as you or the lead would run them, against a
// running daemon, a fake gh, a fake Claude Code and a fake tmux for attaching.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const main = join(import.meta.dir, "..", "src", "main.ts");
const daemon = join(import.meta.dir, "..", "src", "daemon.ts");
const dbFile = join(import.meta.dir, "..", "src", "db.ts");
let home = "";
let socket = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skel");
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

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
  // The fake GitHub lists a repository's open issues from ~/issues/<owner>/<repo>.json, and
  // reads one from ~/issues/<owner>/<repo>/issues/<number>.json.
  mkdirSync(join(home, "issues"));
  fake(
    "gh",
    `case "$*" in
"issue list --repo "*" --state open "*) cat "$HOME/issues/$4.json" 2>/dev/null || { echo "Could not resolve to a Repository" >&2; exit 1; } ;;
"api repos/"*"/issues/"*) cat "$HOME/issues/\${2#repos/}.json" 2>/dev/null || { echo '{"message":"Not Found"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
*) exit 1 ;;
esac`,
  );
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skel.service"), "");
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

const env = () => ({
  HOME: home,
  XDG_RUNTIME_DIR: join(home, "run"),
  PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
});

function serve(): void {
  const script = `import { serve } from ${JSON.stringify(daemon)};
await serve(${JSON.stringify(socket)});`;
  running.push(
    Bun.spawn([process.execPath, "-e", script], { env: env(), stdout: "ignore", stderr: "ignore" }),
  );
}

async function skel(args: string[], more: Record<string, string> = {}) {
  const run = Bun.spawn([process.execPath, main, ...args], {
    env: { ...env(), ...more },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { out, err, code };
}

async function until(done: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("gave up waiting");
    await Bun.sleep(50);
  }
}

async function untilAnswers() {
  await until(() => existsSync(join(home, "run", "skel.sock")));
  await Bun.sleep(100);
}

// Runs SQL against skel's database as skel itself would open it, so its tables exist.
function sql(statements: string): void {
  const script = `import { openDb } from ${JSON.stringify(dbFile)};
openDb().run(${JSON.stringify(statements)});`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
}

// skel has app and site, and four threads, started in this order.
function threads(): void {
  sql(`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app'), ('site', 'simon', 'site');
INSERT INTO threads (owner, repo, task, folder, branch, status, needs_you) VALUES
  ('simon', 'app', 3, 'app-3', 'skel/3', 'done', 0),
  ('simon', 'site', 7, 'site-7', 'skel/7', 'waiting', 1),
  ('simon', 'app', 12, 'app-12', 'skel/12', 'working', 0),
  ('simon', 'app', 9, 'app-9', 'skel/9', 'failed', 0);`);
}

describe("skel ps", () => {
  test("lists live threads newest first, with their status and whether they need you", async () => {
    threads();
    serve();
    await untilAnswers();
    const listed = await skel(["ps"]);
    expect(listed.err).toBe("");
    expect(listed.out).toBe(
      "THREAD  STATUS   NEEDS YOU\n" +
        "app-9   failed\n" +
        "app-12  working\n" +
        "site-7  waiting  yes\n",
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
      "THREAD  STATUS   NEEDS YOU\n" +
        "app-9   failed\n" +
        "app-12  working\n" +
        "site-7  waiting  yes\n" +
        "app-3   done\n",
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
      { thread: "site-7", status: "waiting", needsYou: true },
    ]);
    expect(JSON.parse((await skel(["ps", "--json", "app"])).out)).toHaveLength(2);
  });

  test("says when there are no threads, and when the repository isn't skel's", async () => {
    serve();
    await untilAnswers();
    expect((await skel(["ps"])).out).toBe("There are no threads.\n");
    const unknown = await skel(["ps", "web"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain("no repository named web");
  });

  test("shows threads from a database made before threads could need you", async () => {
    mkdirSync(data(), { recursive: true });
    const old = new Database(join(data(), "skel.db"));
    old.run(`CREATE TABLE threads (owner TEXT NOT NULL, repo TEXT NOT NULL, task INTEGER NOT NULL,
      folder TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, base TEXT, status TEXT NOT NULL,
      session TEXT, PRIMARY KEY (owner, repo, task))`);
    old.run(
      "INSERT INTO threads VALUES ('simon', 'app', 12, 'app-12', 'skel/12', NULL, 'working', NULL)",
    );
    old.close();
    sql("INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app')");
    serve();
    await untilAnswers();
    expect(JSON.parse((await skel(["ps", "--json"])).out)).toEqual([
      { thread: "app-12", status: "working", needsYou: false },
    ]);
  });

  test("says when the daemon isn't running", async () => {
    const listed = await skel(["ps"]);
    expect(listed.code).not.toBe(0);
    expect(listed.err).toContain("run skel");
  });
});

// Puts open issues on the fake GitHub, as gh issue list answers: newest first.
function issues(full: string, list: { number: number; title: string; createdAt: string }[]) {
  mkdirSync(join(home, "issues", full.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(join(home, "issues", `${full}.json`), JSON.stringify(list));
}

describe("skel task ls", () => {
  beforeEach(() => {
    threads();
    issues("simon/app", [
      { number: 12, title: "Add export", createdAt: "2026-11-03T12:00:00Z" },
      { number: 10, title: "Fix login", createdAt: "2026-11-01T12:00:00Z" },
    ]);
    issues("simon/site", [
      { number: 7, title: "New landing page", createdAt: "2026-11-02T12:00:00Z" },
    ]);
  });

  test("lists every repository's open tasks newest first, with the thread on each", async () => {
    serve();
    await untilAnswers();
    const listed = await skel(["task", "ls"]);
    expect(listed.err).toBe("");
    expect(listed.out).toBe(
      "TASK    THREAD              TITLE\n" +
        "app-12  working             Add export\n" +
        "site-7  waiting, needs you  New landing page\n" +
        "app-10                      Fix login\n",
    );
    expect(read(join(home, "calls"))).toContain(
      "gh issue list --repo simon/app --state open --limit 1000 --json number,title,createdAt",
    );
  });

  test("lists one repository's open tasks, as JSON for tools", async () => {
    serve();
    await untilAnswers();
    const listed = await skel(["task", "ls", "app", "--json"]);
    expect(listed.err).toBe("");
    expect(JSON.parse(listed.out)).toEqual([
      { task: "app-12", title: "Add export", thread: { status: "working", needsYou: false } },
      { task: "app-10", title: "Fix login", thread: null },
    ]);
  });

  test("says when there are no open tasks, and why GitHub couldn't list them", async () => {
    issues("simon/app", []);
    serve();
    await untilAnswers();
    expect((await skel(["task", "ls", "app"])).out).toBe("There are no open tasks.\n");
    rmSync(join(home, "issues", "simon", "site.json"));
    const failed = await skel(["task", "ls"]);
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain("Could not resolve to a Repository");
  });
});

// As an agent runs skel: in its sandbox, where skel's database is hidden under an empty home
// folder, and with its own socket from the daemon.
async function asAgent(args: string[], socket: string) {
  const empty = join(home, "sandbox-home");
  mkdirSync(empty, { recursive: true });
  return skel(args, { HOME: empty, SKEL_SANDBOX: "1", SKEL_SOCKET: socket });
}

// The socket the daemon opens for app-12's builder, once its thread is live.
async function builderSocket(): Promise<string> {
  const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
  const builder = join(home, "run", "skel", "threads", short, "skel.sock");
  await until(() => existsSync(builder));
  return builder;
}

// Puts one issue on the fake GitHub, as GitHub's API answers for it.
function issue(full: string, number: number, title: string, body: string | null) {
  mkdirSync(join(home, "issues", full, "issues"), { recursive: true });
  writeFileSync(
    join(home, "issues", full, "issues", `${number}.json`),
    JSON.stringify({ number, title, body, state: "open" }),
  );
}

describe("skel task show", () => {
  beforeEach(() => {
    threads();
    issue("simon/app", 12, "Add export", "Export threads as JSON.\n\nKeep it small.");
    issue("simon/app", 10, "Fix login", null);
    issue("simon/site", 7, "New landing page", "Make it calm.");
  });

  test("shows a task's title and body, and the thread on it", async () => {
    serve();
    await untilAnswers();
    const shown = await skel(["task", "show", "site-7"]);
    expect(shown.err).toBe("");
    expect(shown.out).toBe(
      "site-7  New landing page\nThread: waiting, needs you\n\nMake it calm.\n",
    );
    expect(read(join(home, "calls"))).toContain("gh api repos/simon/site/issues/7");
    expect((await skel(["task", "show", "app-10"])).out).toBe("app-10  Fix login\n");
  });

  test("shows a task as JSON for tools", async () => {
    serve();
    await untilAnswers();
    const shown = await skel(["task", "show", "app-12", "--json"]);
    expect(shown.err).toBe("");
    expect(JSON.parse(shown.out)).toEqual({
      task: "app-12",
      title: "Add export",
      body: "Export threads as JSON.\n\nKeep it small.",
      thread: { status: "working", needsYou: false },
    });
    expect(JSON.parse((await skel(["task", "show", "--json", "app-10"])).out)).toEqual({
      task: "app-10",
      title: "Fix login",
      body: "",
      thread: null,
    });
  });

  test("says when the task or the repository doesn't exist", async () => {
    serve();
    await untilAnswers();
    const missing = await skel(["task", "show", "app-99"]);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toBe("skel: there is no issue #99 in simon/app\n");
    const unknown = await skel(["task", "show", "web-1"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain("no repository named web");
  });

  test("the lead can show a task from its sandbox, and a builder can't", async () => {
    serve();
    await untilAnswers();
    const lead = await asAgent(
      ["task", "show", "app-12"],
      join(home, "run", "skel", "lead", "skel.sock"),
    );
    expect(lead.err).toBe("");
    expect(lead.out).toBe((await skel(["task", "show", "app-12"])).out);
    const refused = await asAgent(["task", "show", "app-12"], await builderSocket());
    expect(refused.code).not.toBe(0);
    expect(refused.err).toBe("skel: the daemon doesn't know that request\n");
  });
});

describe("skel repo ls", () => {
  test("the lead lists the daemon's repositories, as you see them in your terminal", async () => {
    threads();
    serve();
    await untilAnswers();
    const yours = await skel(["repo", "ls"]);
    expect(yours.out).toContain("site  simon/site");
    const lead = await asAgent(["repo", "ls"], join(home, "run", "skel", "lead", "skel.sock"));
    expect(lead.err).toBe("");
    expect(lead.out).toBe(yours.out);
  });

  test("a builder can't ask the daemon for the repositories", async () => {
    threads();
    serve();
    await untilAnswers();
    const refused = await asAgent(["repo", "ls"], await builderSocket());
    expect(refused.code).not.toBe(0);
    expect(refused.err).toBe("skel: the daemon doesn't know that request\n");
  });
});

describe("skel attach", () => {
  // The fake tmux has a session running for each file in ~/sessions, and a dead one, whose
  // builder exited, when that file says dead. It never reaches skel's real tmux server.
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
    const attached = await skel(["attach", "web-7"]);
    expect(attached.err).toBe("");
    expect(attached.code).toBe(0);
    expect(calls()).toContain("tmux -L skel-screen -f /dev/null");
    expect(calls()).toMatch(/new-session .* skel site-7 ;/);
  });

  test("says when there is no such thread", async () => {
    const missing = await skel(["attach", "app-99"]);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toBe("skel: there is no thread app-99\n");
    expect((await skel(["attach", "web-1"])).err).toContain("no repository named web");
    expect(calls()).not.toContain("new-session");
  });

  test("says when the builder isn't running, and what state its thread is in", async () => {
    writeFileSync(join(home, "sessions", "app-12"), "dead");
    const dead = await skel(["attach", "app-12"]);
    expect(dead.code).not.toBe(0);
    expect(dead.err).toBe("skel: app-12's builder isn't running: the thread is working\n");
    const gone = await skel(["attach", "app-9"]);
    expect(gone.err).toBe("skel: app-9's builder isn't running: the thread is failed\n");
    expect(calls()).not.toContain("new-session");
  });

  test("refuses inside skel's sandbox, since it takes over your terminal", async () => {
    writeFileSync(join(home, "sessions", "app-12"), "");
    const refused = await skel(["attach", "app-12"], { SKEL_SANDBOX: "1" });
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("your own terminal");
    expect(calls()).toBe("");
    const sidebar = await skel(["sidebar", "skel", "screen-1", "local"], { SKEL_SANDBOX: "1" });
    expect(sidebar.err).toContain("your own terminal");
  });
});

describe("the page of an issue or PR", () => {
  // Asks the daemon for a page as the page command does, over the socket given, if any.
  async function ask(url: string, more: Record<string, string> = {}) {
    const script = `import { pageOf } from ${JSON.stringify(daemon)};
console.log(JSON.stringify(await pageOf(${JSON.stringify(url)})));`;
    const run = Bun.spawn([process.execPath, "-e", script], {
      env: { ...env(), ...more },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    return { out, err };
  }
  const url = "https://github.com/simon/app/issues/31";

  beforeEach(async () => {
    threads();
    mkdirSync(join(home, "issues", "simon", "app", "issues"), { recursive: true });
    writeFileSync(
      join(home, "issues", "simon", "app", "issues", "31.json"),
      JSON.stringify({
        title: "Add CSV export",
        body: "Export threads.",
        state: "open",
        user: { login: "ana" },
        labels: [],
      }),
    );
    serve();
    await untilAnswers();
  });

  test("the daemon asks GitHub, and hands you the page", async () => {
    expect(JSON.parse((await ask(url)).out)).toEqual({
      title: "Add CSV export",
      facts: [
        ["State", "open"],
        ["Author", "ana"],
        ["Labels", "none"],
      ],
      body: "Export threads.",
    });
    expect(read(join(home, "calls"))).toContain("gh api repos/simon/app/issues/31");
  });

  test("the daemon reads nothing but a page on GitHub", async () => {
    const asked = await ask("https://github.com/simon/app/issues/31 --hostname evil");
    expect(asked.err).toContain("doesn't know that request");
    expect(read(join(home, "calls"))).not.toContain("evil");
  });

  test("an agent can't ask for a page, nor run the page command", async () => {
    const lead = join(home, "run", "skel", "lead", "skel.sock");
    expect((await ask(url, { SKEL_SOCKET: lead })).err).toContain("doesn't know that request");
    const refused = await skel(["page", url], { SKEL_SANDBOX: "1" });
    expect(refused.err).toContain("your own terminal");
  });
});

// bubblewrap can't start inside skel's own sandbox, so only there the lead can't start.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("from the lead", () => {
  test("the lead runs skel ps, skel task ls, skel task show and skel repo ls from its sandbox, but can't attach", async () => {
    threads();
    issues("simon/app", [{ number: 12, title: "Add export", createdAt: "2026-11-03T12:00:00Z" }]);
    issue("simon/app", 12, "Add export", "As JSON");
    issues("simon/site", []);
    writeFileSync(
      join(home, "bin", "claude"),
      `#!/bin/sh
case "$CLAUDE_CONFIG_DIR" in
*/lead) { skel ps app --json; skel task ls app --json; skel task show app-12 --json; skel repo ls; skel attach app-12; } > out.new 2>&1; mv out.new out ;;
esac
exec sleep 300
`,
      { mode: 0o755 },
    );
    serve();
    const out = join(data(), "lead", "out");
    await until(() => read(out) !== "");
    const [ps, tasks, shown, app, site, attach] = read(out).trim().split("\n");
    expect(JSON.parse(ps ?? "")).toHaveLength(2);
    expect(JSON.parse(tasks ?? "")).toEqual([
      { task: "app-12", title: "Add export", thread: { status: "working", needsYou: false } },
    ]);
    expect(JSON.parse(shown ?? "")).toMatchObject({ task: "app-12", body: "As JSON" });
    expect([app, site]).toEqual([
      `app   simon/app   ${data()}/repos/simon/app`,
      `site  simon/site  ${data()}/repos/simon/site`,
    ]);
    expect(attach).toBe(
      "skel: attaching to a thread is only for your own terminal, not for agents",
    );
  }, 20_000);
});
