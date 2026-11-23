// What the tests of polling share: a home with fake programs, a daemon polling the fake plugin,
// and the stand-ins for the builder and the reviewer, each test's own.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { leadPlaces } from "../src/paths.ts";
import {
  answer,
  asked,
  fakePlugin,
  git,
  homeEnv,
  numberedBefore,
  prItem,
  runSkelInTerminal,
  source,
  taskItem,
  until as wait,
  writeScript,
} from "./harness.ts";

export const main = source("main.ts");
export const daemon = source("flow/daemon.ts");
export let home = "";
export let socket = "";
// The fake plugin's settings folder, where it keeps what it is asked and its answers.
export let plugin = "";
export const running: Subprocess[] = [];

export const data = () => join(home, ".local", "share", "skelcrew");
export const codexHome = () => join(data(), "codex");
export const builder = () => join(data(), "claude", "app-12");
export const clone = () => join(data(), "threads", "app-12");
export const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
export const typed = () => read(join(builder(), "typed"));

// Puts a program of the test's on its PATH.
export const script = (name: string, body: string) => writeScript(home, name, body);

// Stands in for Claude Code. As the builder, it commits a round and runs sc submit, then
// waits at a ❯ prompt, keeping what is typed into it. While the file hold-submit is in its
// config folder, it waits before it submits. Told to merge a branch, for a conflict or
// its own branch that moved, it fetches origin and merges it, as Claude Code would, keeping
// what git said, unless the file no-merge is in its config folder. While the file
// busy is in its config folder, it looks busy, as Claude Code does mid-turn.
export function fakeClaude(): void {
  script(
    "claude",
    `case "$CLAUDE_CONFIG_DIR" in */lead-*) stty -echo; echo "❯"; exec cat > "$CLAUDE_CONFIG_DIR/typed" ;; esac
echo 1 > change
git add -A && git commit -qm "round 1"
while test -e "$CLAUDE_CONFIG_DIR/hold-submit"; do sleep 0.1; done
sc submit "Round 1" >> "$CLAUDE_CONFIG_DIR/submitted" 2>&1
while test -e "$CLAUDE_CONFIG_DIR/busy"; do echo "esc to interrupt"; sleep 0.2; done
clear
printf '\\033[?2004h'
stty -echo
echo "❯"
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$CLAUDE_CONFIG_DIR/typed"
  test -e "$CLAUDE_CONFIG_DIR/no-merge" && continue
  case "$line" in *"merge origin/"*)
    { touch "$(git remote get-url origin)/written" && echo "origin is writable"
      base=$(printf '%s' "$line" | sed -n 's|.*merge origin/\\([^ ]*\\) into.*|\\1|p')
      git fetch -q origin && git merge --no-edit "origin/$base"; } > "$CLAUDE_CONFIG_DIR/merged" 2>&1 ;;
  esac
done
exec sleep 300`,
  );
}

// Stands in for Codex, approving every review.
export function fakeCodex(): void {
  script(
    "codex",
    `for a; do [ "$prev" = -o ] && out=$a; prev=$a; done
cat > /dev/null
echo '{"verdict":"approve","body":"Ready to merge.","findings":[]}' > "$out"`,
  );
}

// Gives each test a home of its own, with the fake programs Skelcrew finds there, and a tmux
// socket of its own.
export function setUp(): void {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-polling-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(join(codexHome(), "auth.json"), "{}");
  fakeClaude();
  fakeCodex();
  script("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    "harness: claude\nreviewer: { harness: codex }\n",
  );
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${join(home, "github")}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Simon\n\temail = simon@example.com\n`,
  );
  plugin = fakePlugin(home);
}
// Ends what the test started: its daemons and tmux server, and removes its home.
export async function tearDown(): Promise<void> {
  for (const serve of running.splice(0)) {
    serve.kill();
    await serve.exited;
  }
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
}

// What this test's processes run with.
export const env = () => homeEnv(home);

// Where the daemon this test runs writes its log.
export const daemonLog = () => join(home, "daemon.log");

// Runs the daemon, polling every 200 milliseconds rather than every 30 seconds, and every
// 400 rather than every minute while threads only wait on you, unless a test says otherwise.
// `wait` is how long it waits for CI's first check where CI shows on another PR.
export function serve(every = 200, wait = 2 * 60_000): Subprocess {
  const code = `import { serve } from ${JSON.stringify(daemon)};
await serve(${JSON.stringify(socket)}, ${every});`;
  // Reviews start at once on app, which has no CI, rather than waiting for a first check.
  const run = Bun.spawn([process.execPath, "-e", code], {
    env: { ...env(), SKELCREW_CHECK_WAIT_MS: "0", SKELCREW_CI_WAIT_MS: String(wait) },
    stdout: Bun.file(daemonLog()),
    stderr: "ignore",
  });
  running.push(run);
  return run;
}

// app's lead's session and config folder.
export const leadName = leadPlaces("simon", "app").name;

// A daemon's work takes its time here, so a wait lasts 15 seconds unless a test says otherwise.
export const until = (done: () => boolean, timeout = 15_000) => wait(done, { timeout });

// Puts simon/app on the fake GitHub and tells Skelcrew about it, as a repository you have opened,
// whose lead the daemon starts, with the fake plugin as its tracker and forge. Returns a
// checkout to push from. An empty one is on GitHub with no commits yet, as a repository just
// created is, and the checkout's commit is its first to push.
export function addApp(empty = false): string {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  writeFileSync(
    join(work, "skelcrew.yaml"),
    "tracker: github\nsetup: []\ntest: []\nlimits: { threads: 9 }\n",
  );
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  const bare = join(home, "github", "simon", "app.git");
  if (empty) git(home, "init", "-q", "--bare", "-b", "main", bare);
  else git(home, "clone", "-q", "--bare", work, bare);
  // Its task on issue #12 is APP-12.
  if (!empty) numberedBefore(bare, 11);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo, opened, forge, remote, claimed) VALUES ('app', 'simon', 'app', 1, 'github', 'https://github.com/simon/app.git', 1)");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  return work;
}

export function thread(): Record<string, unknown> {
  const db = new Database(join(data(), "skelcrew.db"));
  // The daemon may be writing, and a read that meets a write fails without a wait.
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const row = db.query("SELECT * FROM task_threads").get();
    return row && typeof row === "object" ? { ...row } : {};
  } finally {
    db.close();
  }
}

// How many messages wait to be typed into the builder.
export function waiting(): number {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    return (
      Object.values(Object(db.query("SELECT COUNT(*) FROM messages").get())).map(Number)[0] ?? 0
    );
  } finally {
    db.close();
  }
}

// The processes running this test's fake builder. Its own process ID would be one inside
// its sandbox, so they are found by the script they run.
export function fakeBuilders(): string[] {
  const claude = join(home, "bin", "claude");
  return readdirSync("/proc").filter(
    (pid) => /^\d+$/.test(pid) && read(join("/proc", pid, "cmdline")).includes(claude),
  );
}

// How many times the daemon has asked what changed.
export const polls = () => asked(plugin).filter((q) => q.ask === "changed").length;

// The reviews and comments the daemon asked the forge to mark seen.
export const marked = () => asked(plugin).filter((q) => q.ask === "seen");

// What the daemon asked the tracker to assign or claim, as the plugin was asked it.
export const assigns = () => asked(plugin).filter((q) => q.ask === "assign");
export const claims = () => asked(plugin).filter((q) => q.ask === "took");
export const assignOn = { ask: "assign", repository: "simon/app", task: "12", on: true };
export const assignOff = { ...assignOn, on: false };
export const claim12 = { ask: "took", repository: "simon/app", task: "12" };

// Waits for the number of polls to grow by a few, so anything they would do is done. A
// repository's polls run one at a time, and each asks what changed first. So by the third new
// ask, a poll that began after this call has ended, with all it asked the forge.
export async function morePolls(n = 3) {
  const before = polls();
  await until(() => polls() >= before + n);
}

export const you = { login: "simon", bot: false, you: true, push: true };
export const ana = { login: "ana", bot: false, you: false, push: true };
export const mallory = { login: "mallory", bot: false, you: false, push: false };
export const skelBot = { login: "skelcrew[bot]", bot: true, you: false, push: false };
export const skelReview = {
  id: "1001",
  author: skelBot,
  text: "**Approved.**\n\nReady.",
  verdict: "commented",
  lines: [],
};

// Issue 12, as the tracker answers it, labeled to start when told.
export const issue12 = (labeled = false) =>
  taskItem("12", "Add export", { body: "As JSON", labels: labeled ? ["skelcrew"] : [] });

// Has the fake plugin answer the next polls with these items, and a `next` to ask from.
export const changes = (items: object[], next = "2026-11-06T10:00:00Z") =>
  answer(plugin, "changed", { items, next });

// The commit Skelcrew last pushed for app-12, as Skelcrew's clone keeps it, or "" before its
// first push.
export const pushed = () =>
  Bun.spawnSync(
    [
      "git",
      "-C",
      join(data(), "repos", "simon", "app"),
      "rev-parse",
      "refs/skelcrew/threads/app-12",
    ],
    { stdout: "pipe", stderr: "ignore" },
  )
    .stdout.toString()
    .trim();

// Has the fake plugin answer the next polls with issue 12, and PR 7 in the given state. Its head
// is the commit Skelcrew last pushed, as a forge sends it, unless `head` says otherwise.
export function pr(given: {
  state?: string;
  conflicts?: boolean;
  base?: string;
  reviews?: object[];
  comments?: { id: string; author: object | null; text: string }[];
  checks?: object[];
  labeled?: boolean;
  head?: string;
}): void {
  const head = given.head ?? pushed();
  const pr7 = prItem("7", "Add export", {
    ...(head ? { head } : {}),
    state: given.state ?? "open",
    conflicts: given.conflicts ?? false,
    base: given.base ?? "main",
    reviews: given.reviews ?? [],
    comments: given.comments ?? [],
    checks: given.checks ?? [],
  });
  changes([issue12(given.labeled), pr7]);
}

export const approved = { name: "skelcrew/check", id: null, state: "passed" };
export const check = (id: number, state: string) => ({ name: "test", id: String(id), state });

// Returns whether the thread has handled the event with this ID.
export const handled = (id: string) => String(thread().seen ?? "").includes(`"${id}"`);

// Starts the thread on app-12, and waits until Skelcrew's reviewer has approved its first round,
// so the thread waits on CI. `ciWait` is how long the daemon waits for CI's first check where CI
// shows on another PR.
export async function approvedApp12(from?: string, ciWait?: number): Promise<string> {
  const work = addApp();
  if (from) {
    git(work, "checkout", "-q", "-b", from);
    git(work, "push", "-q", join(home, "github", "simon", "app.git"), from);
  }
  // sc start reads the task from Skelcrew's copy, which it brings up to date first.
  changes([issue12()]);
  serve(200, ciWait);
  await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
  const started = Bun.spawnSync(
    [process.execPath, main, "start", "app-12", ...(from ? ["--from", from] : [])],
    {
      env: env(),
      stderr: "pipe",
    },
  );
  expect(started.stderr.toString()).toBe("");
  // A builder and then a reviewer start in sandboxes of their own, which CI's busy machine can
  // take many seconds to do, so the limit only ends a test that hangs. One that hangs says how
  // far the thread got, from its log and the daemon's.
  await wait(
    () => thread().pr === 7 && thread().reviewing === null && thread().submitting === null,
    {
      timeout: 45_000,
      what: () =>
        `${read(join(data(), "threads", "app-12.log"))}\n${read(daemonLog()).slice(-4000)}`,
    },
  );
  await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
  // The approval is saved before it goes on the PR, so wait for it there too, as a test may
  // then hold what goes on the PR.
  await until(() => thread().posting === null);
  expect(thread()).toMatchObject({ status: "waiting", needs_you: 0 });
  return work;
}

// Sends one request to the daemon on a socket, yours or an agent's, and returns its reply.
export function askOn(path: string, request: object): Promise<unknown> {
  return new Promise((done) => {
    const connection = new Socket();
    connection.on("error", () => {});
    let reply = "";
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (data) => {
      reply += data.toString();
    });
    connection.on("close", () => done(reply ? JSON.parse(reply) : null));
    connection.connect(path);
  });
}

// What Skelcrew's copy holds open, as kind and ID, and the totals the sidebar counts with.
export function copied(): { rows: string[]; totals: unknown } {
  const db = new Database(join(data(), "skelcrew.db"), { readonly: true });
  // The daemon can be saving a poll just as this reads, which would otherwise fail the test.
  db.run("PRAGMA busy_timeout = 5000");
  const rows = db.query("SELECT kind, id FROM items WHERE state = 'open' ORDER BY kind, id").all();
  const totals = db.query("SELECT open_issues, open_prs FROM repositories").get();
  db.close();
  return { rows: rows.map((row) => Object.values(Object(row)).join(" ")), totals };
}

// PR 7 as Skelcrew's copy holds it, as JSON, or nothing before a poll brought it. A test looks
// here for what the forge sent, since the forge sends each change only once.
export function copiedPr(): string {
  const db = new Database(join(data(), "skelcrew.db"), { readonly: true });
  // The daemon can be saving a poll just as this reads, which would otherwise fail the test.
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query("SELECT item FROM items WHERE kind = 'pr' AND id = '7'").get();
  db.close();
  return row ? JSON.stringify(row) : "";
}

// What the latest poll saved about whether a PR changes .agents/: the head it looked at and
// whether the PR's changes there touch .agents/, or nothing.
export function prAgents(id: string): { head: string; changed: number } | null {
  const db = new Database(join(data(), "skelcrew.db"), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const row = db.query("SELECT head, changed FROM pr_agents WHERE pr = ?").get(id);
    return row && typeof row === "object" && "head" in row && "changed" in row
      ? { head: String(row.head), changed: Number(row.changed) }
      : null;
  } finally {
    db.close();
  }
}

// Returns the commit a checkout is on.
export const headOf = (work: string) =>
  Bun.spawnSync(["git", "-C", work, "rev-parse", "HEAD"], { stdout: "pipe" })
    .stdout.toString()
    .trim();

// Someone else moves app-12's branch on the forge, as merging a PR stacked on it does, and
// returns the commit it is on now.
export function moveBranch(work: string): string {
  const bare = join(home, "github", "simon", "app.git");
  const branch = String(thread().branch);
  git(work, "fetch", "-q", bare, branch);
  git(work, "checkout", "-q", "-B", "stacked", "FETCH_HEAD");
  writeFileSync(join(work, "STACKED"), "stacked\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "Merge the stacked PR");
  git(work, "push", "-q", bare, `HEAD:refs/heads/${branch}`);
  return git(work, "rev-parse", "HEAD");
}

// Returns whether the branch of app-12 on the forge holds the commit.
export const onForge = (commit: string) =>
  Bun.spawnSync([
    "git",
    "-C",
    join(home, "github", "simon", "app.git"),
    "merge-base",
    "--is-ancestor",
    commit,
    String(thread().branch),
  ]).success;

// Runs sc as an agent would, inside its sandbox, from the socket of app-12's builder or of
// app's lead.
export function asAgent(agent: "builder" | "lead", args: string[], cwd = home) {
  const hashed = (name: string) =>
    new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 16);
  const runDir = join(home, "run", "skelcrew");
  const sockets = {
    builder: join(runDir, "threads", hashed("app-12"), "skelcrew.sock"),
    lead: join(runDir, "leads", hashed("simon/app"), "skelcrew.sock"),
  };
  const run = Bun.spawnSync([process.execPath, main, ...args], {
    env: { ...env(), SKELCREW_SANDBOX: "1", SKELCREW_SOCKET: sockets[agent] },
    cwd,
    stderr: "pipe",
  });
  return run.stderr.toString();
}

// Has app-12's builder commit a change and submit round 2, as it would once it fixed what it
// was told.
export function submitRound2(): void {
  writeFileSync(join(clone(), "change"), "2\n");
  git(clone(), "add", "-A");
  git(clone(), "commit", "-qm", "round 2");
  expect(asAgent("builder", ["submit", "Round 2"], clone())).toBe("");
}

// Waits until the fake builder's merge of its moved branch is committed. Its merged files show
// in the clone before git moves HEAD, and a commit made meanwhile would find HEAD locked.
export async function untilMerged(): Promise<void> {
  const merged = () =>
    Bun.spawnSync(["git", "-C", clone(), "cat-file", "-e", "HEAD:STACKED"]).success &&
    !existsSync(join(clone(), ".git", "index.lock"));
  await until(merged);
}

// Your login name, as the system has it: the daemon runs without USER, which Bun's userInfo
// reads.
export const login = () =>
  Bun.spawnSync(["id", "-un"], { stdout: "pipe" }).stdout.toString().trim();
export const hashed = (name: string) =>
  new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 16);
export const runDir = () => join(home, "run", "skelcrew");
export const leadSocket = () => join(runDir(), "leads", hashed("simon/app"), "skelcrew.sock");
export const builderSocket = () => join(runDir(), "threads", hashed("app-12"), "skelcrew.sock");
// Where the question starts: what it says of .agents/ follows, as a poll last saw the PR.
export const question = "Merge #7 (APP-12 Add export) when it's approved and green?";
export const notLet =
  "the human turned off your arming merges: ask them to run sc merge --when-ready in their own terminal, or to turn it on with lead: { can_merge: true } in ~/.config/skelcrew/config.yaml";
// Writes your config with `lead`, your line for whether the lead may arm merges, or none.
export const leadMerging = (lead: string) =>
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    `harness: claude\nreviewer: { harness: codex }\n${lead}`,
  );
export const merges = () => asked(plugin).filter((q) => q.ask === "merge pr");
export const leadTyped = () => read(join(data(), "claude", leadName, "typed"));
// Arms a new plan, and checks sc said so. A plan still armed, such as after a cancel that
// was refused, would otherwise carry on as if it were the new one.
export const arm = async () => {
  const said = await runSkelInTerminal(
    socket,
    env(),
    ["merge", "--when-ready", "app-12"],
    question,
    "y",
  );
  expect(said).toContain(
    "Merging #7 as soon as it's approved and green. sc merge --cancel APP-12 stops it.",
  );
  return said;
};

// Starts app-12 with a reviewer that asks for changes, and waits until its review is in and
// the forge's copy of its PR shows the reviewed commit, with `checks` on it: CI still
// running unless a test gives others.
export const changesApp12 = async (checks: object[] = [check(5, "running")], ciWait?: number) => {
  script(
    "codex",
    `for a; do [ "$prev" = -o ] && out=$a; prev=$a; done
cat > /dev/null
echo '{"verdict":"changes","body":"Not yet.","findings":[{"finding":"Handle an empty file","severity":"P1","blocking":true},{"finding":"Test the error","severity":"P1","blocking":true}]}' > "$out"`,
  );
  addApp();
  changes([issue12()]);
  serve(200, ciWait);
  await until(() => existsSync(join(data(), "repos", "simon", "app", "README")));
  const started = Bun.spawnSync([process.execPath, main, "start", "app-12"], {
    env: env(),
    stderr: "pipe",
  });
  expect(started.stderr.toString()).toBe("");
  // As in approvedApp12, a builder and a reviewer start in sandboxes of their own, which CI's
  // busy machine can take many seconds to do. One that hangs says how far the thread got.
  await wait(
    () =>
      thread().verdict === "changes" &&
      thread().pr === 7 &&
      thread().reviewing === null &&
      String(thread().review_post).includes("Test the error"),
    {
      timeout: 45_000,
      what: () =>
        `${read(join(data(), "threads", "app-12.log"))}\n${read(daemonLog()).slice(-4000)}`,
    },
  );
  const head = pushed();
  pr({ head, reviews: [skelReview], checks });
  await morePolls();
  return head;
};

export const skipQuestion =
  "Merge #7 (APP-12 Add export) without Skelcrew's approval? CI must still pass. It still asks: 1) Handle an empty file 2) Test the error";
export const skipSaid =
  "Merging #7 without Skelcrew's approval once its checks pass. sc merge --cancel APP-12 stops it.";
