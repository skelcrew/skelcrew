// sc submit and the build ⇄ review loop, against a running daemon: a shell script stands in
// for the builder and runs sc submit like an agent would, another stands in for Codex, a
// fake plugin for the repository's tracker and forge, and a folder of bare repositories for
// what Skelcrew pushes to.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  read,
  runSkel,
  runSkelInTerminal,
  source,
  startDaemon,
  taskItem,
  until as wait,
  writeScript,
} from "./harness.ts";

let home = "";
let socket = "";
// The fake plugin's settings folder, where it keeps what it is asked and its answers.
let plugin = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skelcrew");
const codexHome = () => join(data(), "codex");
const builder = () => join(data(), "claude", "app-12");
const lead = () => join(data(), "claude", leadPlaces("simon", "app").name);
const clone = () => join(data(), "threads", "app-12");

// Puts a program of the test's on its PATH.
const script = (name: string, body: string) => writeScript(home, name, body);

// Stands in for Claude Code. As the lead, it waits at a ❯ prompt and keeps what is typed
// into it. As the builder, it commits a round and runs sc submit, then
// waits at a ❯ prompt, keeping what is typed into it. Each typed message ends in a paste mark
// and an Enter, and it answers each one with another round, as a builder fixing a review
// would. `submits` false leaves the first round to the test. While the file busy is in its
// config folder after a round, it looks busy, as Claude Code does mid-turn.
function fakeClaude(submits = true): void {
  script(
    "claude",
    `case "$CLAUDE_CONFIG_DIR" in */lead-*) stty -echo; echo "❯"; exec cat > "$CLAUDE_CONFIG_DIR/typed" ;; esac
printf '%s\\n' "$@" > "$CLAUDE_CONFIG_DIR/args"
n=0
round() {
  n=$((n+1))
  echo "$n" > change
  git add -A && git commit -qm "round $n"
  sc submit "Round $n" >> "$CLAUDE_CONFIG_DIR/submitted" 2>&1
  while test -e "$CLAUDE_CONFIG_DIR/busy"; do echo "esc to interrupt"; sleep 0.2; done
  clear
}
${submits ? "round" : ""}
printf '\\033[?2004h'
stty -echo
echo "❯"
end=$(printf '\\033[201~')
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$CLAUDE_CONFIG_DIR/typed"
  case "$line" in *"$end"*) round; echo "❯" ;; esac
done
exec sleep 300`,
  );
}

// Stands in for Codex. Review n answers with the verdict in Skelcrew's Codex folder's verdict-n,
// and fails without one. It sleeps first when slow-n is there. What it was given, and the
// branches it saw, go in the sessions folder, the one place a review writes that lasts.
function fakeCodex(): void {
  script(
    "codex",
    `for a; do [ "$prev" = -o ] && out=$a; prev=$a; done
s="$CODEX_HOME/sessions"
n=$(( $(cat "$s/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$s/count"
cat > "$s/prompt-$n"
git branch -r > "$s/branches-$n"
git rev-parse origin/main > "$s/main-$n" 2>&1
test -e "$CODEX_HOME/slow-$n" && sleep 30
test -e "$CODEX_HOME/verdict-$n" || { echo "no verdict for review $n" >&2; exit 1; }
cp "$CODEX_HOME/verdict-$n" "$out"`,
  );
}

function verdict(n: number, said: "approve" | "changes", body: string): void {
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(join(codexHome(), `verdict-${n}`), JSON.stringify({ verdict: said, body }));
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-submit-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  fakeClaude();
  fakeCodex();
  script("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  config("");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${github()}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Simon\n\temail = simon@example.com\n`,
  );
  // The tracker has issue 12 in every poll, and the forge opens PR 7.
  plugin = fakePlugin(home);
  answer(plugin, "changed", {
    items: [taskItem("12", "Add export", { body: "As JSON" })],
    next: null,
  });
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

function config(more: string): void {
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    `harness: claude\nreviewer: { harness: codex }\n${more}`,
  );
}

// What this test's processes run with.
const env = () => homeEnv(home);

// Runs this test's daemon, which the test's clean-up stops.
const serve = () => startDaemon(socket, env(), running);

// Runs sc as you would, or as a builder would with its thread's socket.
const skel = (args: string[], more: Record<string, string> = {}) =>
  runSkel(args, { ...env(), ...more });

// The socket the daemon opens for app-12's builder.
const builderSocket = () => {
  const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "threads", short, "skelcrew.sock");
};

// A daemon's work takes its time here, so a wait lasts 15 seconds unless a test says otherwise.
const until = (done: () => boolean, timeout = 15_000) => wait(done, { timeout });

const github = () => join(home, "github");

// Puts simon/app on the fake GitHub and tells Skelcrew about it, as a repository you have opened,
// whose lead the daemon starts, with the fake plugin as its tracker and forge. Returns a
// checkout to push from.
function addApp(): string {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  writeFileSync(join(work, "skelcrew.yaml"), "tracker: github\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(github(), "simon", "app.git"));
  git(work, "remote", "add", "origin", join(github(), "simon", "app.git"));
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo, opened, forge, remote, claimed) VALUES ('app', 'simon', 'app', 1, 'github', 'https://github.com/simon/app.git', 1)");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  return work;
}

const untilCloned = () => until(() => existsSync(join(data(), "repos", "simon", "app", "README")));

function thread(): Record<string, unknown> {
  const db = new Database(join(data(), "skelcrew.db"));
  // The daemon may be writing, and a read that meets a write fails without a wait.
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const row = db.query("SELECT * FROM threads").get();
    return row && typeof row === "object" ? { ...row } : {};
  } finally {
    db.close();
  }
}

// The commit on the thread's branch on the fake GitHub, and what is in its round.
const pushed = (ref = "skelcrew/12-add-export") =>
  git(join(github(), "simon", "app.git"), "rev-parse", ref);
const pushedRound = () =>
  git(join(github(), "simon", "app.git"), "show", "skelcrew/12-add-export:change");

// The checks Skelcrew set on commits, and the reviews it posted, as it asked the forge.
type Status = { sha: string; state: string; description: string };
const statuses = (): Status[] =>
  asked(plugin)
    .filter((q) => q.ask === "status")
    .map((q) => ({
      sha: String(q.commit),
      state: String(q.state),
      description: String(q.description),
    }));
const reviews = () =>
  asked(plugin)
    .filter((q) => q.ask === "review")
    .map(({ commit, verdict, body }) => ({ commit, verdict, body }));
// The PR Skelcrew opened, as it asked the forge, or nothing.
const opened = () => asked(plugin).find((q) => q.ask === "open pr");
const typedMessages = () => read(join(builder(), "typed")).split("\x1b[201~").length - 1;
const finished = (state: string) => statuses().filter((s) => s.state === state);

async function startApp12() {
  serve();
  await untilCloned();
  expect((await skel(["start", "app-12"])).err).toBe("");
}

// bubblewrap can't start inside Skelcrew's own sandbox, so only there builders can't start.
describe.skipIf(process.env.SKELCREW_SANDBOX === "1")("sc submit", () => {
  test("each review's round, reviewer, verdict and first line go in the thread's log, and the task's title too", async () => {
    addApp();
    verdict(1, "changes", "\n  The export has no test.\n\nMore detail here.");
    verdict(2, "approve", "Ready to merge.");
    await startApp12();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"), 30_000);
    const lines = read(join(data(), "threads", "app-12.log"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const said = lines.filter((line) => line.why?.includes("in round 1"))[0];
    expect(said).toMatchObject({
      review_round: 1,
      reviewed_by: "codex",
      verdict: "changes",
      review_line: "The export has no test.",
    });
    expect(lines.at(-1)).toMatchObject({
      title: "Add export",
      review_round: 2,
      reviewed_by: "codex",
      verdict: "approve",
      review_line: "Ready to merge.",
    });
    expect(lines.some((line) => line.reviewer === "codex" && line.submitting !== null)).toBe(true);
  });

  test("pushes the round, opens the PR, has it reviewed, types the changes in, and waits on CI once approved", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    verdict(2, "approve", "Ready to merge.");
    await startApp12();
    await until(
      () =>
        finished("success").length === 1 &&
        read(join(data(), "threads", "app-12.log")).includes("waits on CI"),
      30_000,
    );

    expect(read(join(builder(), "submitted"))).toContain("Submitted app-12 for review.");
    expect(pushedRound()).toBe("2");
    const pr = opened();
    expect(pr).toMatchObject({
      branch: "skelcrew/12-add-export",
      base: "main",
      title: "Add export",
    });
    expect(pr?.body).toBe("Round 1\n\nCloses #12");

    const second = pushed();
    const first = git(join(github(), "simon", "app.git"), "rev-parse", `${second}^`);
    expect(statuses().map((s) => [s.sha, s.state])).toEqual([
      [first, "pending"],
      [first, "failure"],
      [second, "pending"],
      [second, "success"],
    ]);
    expect(reviews()).toEqual([
      { commit: first, verdict: "changes", body: "The export has no test." },
      { commit: second, verdict: "approve", body: "Ready to merge." },
    ]);
    expect(typedMessages()).toBe(1);
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");

    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("Add export");
    expect(prompt).toContain("git diff origin/main...HEAD");
    expect(read(join(codexHome(), "sessions", "branches-1"))).toContain("origin/main");

    // Approved, it waits on CI: polling GitHub marks it needs you once every check is green.
    expect(thread()).toMatchObject({ status: "waiting", needs_you: 0, rounds: 1, pr: 7 });
    expect(thread().reviewing).toBeNull();
    // The daemon saves a thread before it appends the thread to its log.
    await until(() => read(join(data(), "threads", "app-12.log")).includes("approved"));
    expect(read(join(data(), "threads", "app-12.log"))).toContain("Round 1");
  }, 60_000);

  // So it is always clear on the forge whether you or Skelcrew wrote a commit.
  test("commits are authored by the forge's bot, with you as co-author", async () => {
    addApp();
    const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("UPDATE repositories SET author = 'skelcrew[bot] <1+skelcrew[bot]@users.noreply.github.com>'");`;
    expect(Bun.spawnSync([process.execPath, "-e", code], { env: env() }).success).toBe(true);
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => finished("success").length === 1, 30_000);
    const bare = join(github(), "simon", "app.git");
    expect(git(bare, "log", "-1", "--format=%an <%ae>", "skelcrew/12-add-export")).toBe(
      "skelcrew[bot] <1+skelcrew[bot]@users.noreply.github.com>",
    );
    expect(git(bare, "log", "-1", "--format=%B", "skelcrew/12-add-export")).toContain(
      "Co-authored-by: Simon <simon@example.com>",
    );
  }, 60_000);

  test("tells the builder about sc submit, after the task rather than in it", async () => {
    addApp();
    fakeClaude(false);
    await startApp12();
    await until(() => read(join(builder(), "args")) !== "");
    const args = read(join(builder(), "args"));
    const told = args.split("\n").indexOf("--append-system-prompt");
    expect(told).toBeGreaterThan(-1);
    expect(
      args
        .split("\n")
        .slice(told + 1)
        .join("\n"),
    ).toContain('sc submit "<summary>"');
    expect(args).toContain(
      "Come back to the human only for new scope, missing access, or a decision that is theirs. Decide everything else yourself.",
    );
    expect(args.endsWith("Add export\n\nAs JSON\n")).toBe(true);
  }, 30_000);

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
      read(join(lead(), "typed")).includes("app-12 needs you: changes asked for after 2 rounds"),
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
    const started = await skel(["start", "app-12"]);
    expect(started.err).toBe("");
    expect(started.out).toContain("app-12 goes on");
    await until(() => read(join(builder(), "typed")).includes("Second problem."), 30_000);
    await until(() => finished("success").length === 1, 30_000);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(thread()).toMatchObject({ status: "waiting", needs_you: 0, rounds: 0 });
  }, 90_000);

  test("a review that fails sets the check to review failed, posts nothing, and needs you", async () => {
    addApp();
    await startApp12();
    await until(() => finished("failure").length === 1, 30_000);
    expect(finished("failure")[0]?.description).toBe("review failed");
    await until(() => thread().needs_you === 1);
    expect(reviews()).toEqual([]);
    expect(typedMessages()).toBe(0);
    // The daemon saves a thread before it appends the thread to its log.
    await until(() =>
      read(join(data(), "threads", "app-12.log")).includes("no verdict for review 1"),
    );
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

  test("runs again a review the daemon's stop cut short", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    verdict(2, "approve", "Looks right.");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    first.kill();
    await first.exited;
    expect(thread().reviewing).toBe(pushed());
    serve();
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(pushed());
    expect(reviews()).toEqual([{ commit: pushed(), verdict: "approve", body: "Looks right." }]);
    await until(() => thread().reviewing === null);
  }, 60_000);

  // The first poll brings only open tasks, while the thread's task may have closed: the thread
  // saved its task as it started.
  test("runs again a review cut short by an upgrade, though the thread's task is closed", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    verdict(2, "approve", "Looks right.");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    first.kill();
    await first.exited;
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("DELETE FROM items");
    db.close();
    answer(plugin, "changed", { items: [], next: null });
    serve();
    await until(() => finished("success").length + finished("failure").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(pushed());
  }, 60_000);

  test("finishes a submit the daemon's stop cut short while opening the PR", async () => {
    addApp();
    verdict(1, "approve", "Looks right.");
    writeFileSync(join(plugin, "hold-open-pr"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(plugin, "held-open-pr")), 30_000);
    first.kill();
    await first.exited;
    // The call the stopped daemon started ends with it, and the forge answers with the PR
    // already open from the branch when asked again.
    rmSync(join(plugin, "hold-open-pr"));
    serve();
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(pushed());
    expect(reviews()).toEqual([{ commit: pushed(), verdict: "approve", body: "Looks right." }]);
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(thread()).toMatchObject({ pr: 7, submitting: null });
  }, 60_000);

  test("types in a review the daemon's stop kept from the builder, without reviewing again", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => thread().telling !== null, 30_000);
    const reviewed = statuses()[0]?.sha;
    first.kill();
    await first.exited;
    serve();
    await Bun.sleep(1000);
    rmSync(join(builder(), "busy"));
    await until(() => typedMessages() === 1, 30_000);
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");
    expect(reviews()).toHaveLength(1);
    expect(
      statuses()
        .filter((s) => s.sha === reviewed)
        .map((s) => s.state),
    ).toEqual(["pending", "failure"]);
    await until(() => thread().telling === null);
  }, 60_000);

  test("keeps a review it couldn't type in, and needs you", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await startApp12();
    await until(() => thread().telling !== null, 30_000);
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    await until(() => thread().needs_you === 1, 30_000);
    expect(String(thread().telling)).toContain("The export has no test.");
  }, 60_000);

  test("types in a saved review once a builder whose session ended is started again", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => thread().telling !== null, 30_000);
    first.kill();
    await first.exited;
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    rmSync(join(builder(), "busy"));
    // The builder started again has no round of its own to submit, as it never saved a
    // conversation to go on with.
    fakeClaude(false);
    serve();
    await until(() => typedMessages() === 1, 30_000);
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");
    await until(() => thread().telling === null);
  }, 60_000);

  test("a builder started again that submits at once drops the saved review", async () => {
    addApp();
    verdict(1, "changes", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => thread().telling !== null, 30_000);
    first.kill();
    await first.exited;
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    rmSync(join(builder(), "busy"));
    serve();
    await until(() => finished("success").length === 1, 30_000);
    await Bun.sleep(2000);
    expect(typedMessages()).toBe(0);
  }, 60_000);

  test("a newer sc submit drops a review still waiting for the builder", async () => {
    addApp();
    verdict(1, "changes", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await startApp12();
    await until(() => thread().telling !== null, 30_000);
    writeFileSync(join(clone(), "change"), "newer\n");
    git(clone(), "commit", "-qam", "newer");
    expect((await skel(["submit", "Newer"], { SKELCREW_SOCKET: builderSocket() })).err).toBe("");
    expect(thread().telling).toBeNull();
    await until(() => finished("success").length === 1, 30_000);
    rmSync(join(builder(), "busy"));
    await Bun.sleep(2000);
    expect(typedMessages()).toBe(0);
  }, 60_000);

  test("reviews against the default branch as the thread started from it", async () => {
    const work = addApp();
    verdict(1, "approve", "Fine.");
    serve();
    await untilCloned();
    writeFileSync(join(work, "LATER"), "later\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "later");
    git(work, "push", "-q", "origin", "main");
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => finished("success").length === 1, 30_000);
    expect(read(join(codexHome(), "sessions", "main-1"))).toBe(
      `${git(work, "rev-parse", "HEAD")}\n`,
    );
  }, 60_000);

  test("a commit submitted again while its check is being set gets pending after it", async () => {
    addApp();
    verdict(1, "approve", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-2"), "");
    writeFileSync(join(plugin, "hold-status-success"), "");
    await startApp12();
    await until(() => existsSync(join(plugin, "held-status")), 30_000);
    expect((await skel(["submit", "Again"], { SKELCREW_SOCKET: builderSocket() })).err).toBe("");
    await Bun.sleep(1000);
    rmSync(join(plugin, "hold-status-success"));
    await until(() => statuses().length === 3);
    expect(statuses().map((s) => s.state)).toEqual(["pending", "success", "pending"]);
  }, 60_000);

  test("a review cancelled while it is posted doesn't set the check on the commit submitted again", async () => {
    addApp();
    verdict(1, "approve", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-2"), "");
    writeFileSync(join(plugin, "hold-review"), "");
    await startApp12();
    await until(() => existsSync(join(plugin, "held-review")), 30_000);
    expect((await skel(["submit", "Again"], { SKELCREW_SOCKET: builderSocket() })).err).toBe("");
    await Bun.sleep(1000);
    rmSync(join(plugin, "hold-review"));
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), 30_000);
    expect(reviews()).toHaveLength(1);
    await Bun.sleep(1500);
    expect(statuses().map((s) => s.state)).toEqual(["pending", "pending"]);
  }, 60_000);

  test("a thread started from another branch is reviewed against it, and its PR goes into it", async () => {
    const work = addApp();
    git(work, "checkout", "-q", "-b", "next");
    git(work, "push", "-q", "origin", "next");
    verdict(1, "approve", "Fine.");
    serve();
    await untilCloned();
    expect((await skel(["start", "app-12", "--from", "next"])).err).toBe("");
    await until(() => finished("success").length === 1, 30_000);
    expect(opened()?.base).toBe("next");
    expect(read(join(codexHome(), "sessions", "prompt-1"))).toContain("origin/next...HEAD");
    expect(read(join(codexHome(), "sessions", "branches-1"))).toContain("origin/next");
  }, 60_000);
});

// Lets a test change a thread as merging its PR would, without polling GitHub.
function setThread(change: string): void {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    db.run(`UPDATE threads SET ${change}`);
  } finally {
    db.close();
  }
}

// app's lead's socket, named by a short hash of its GitHub name.
const leadSocketPath = () => {
  const short = new Bun.CryptoHasher("sha256").update("simon/app").digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "leads", short, "skelcrew.sock");
};

describe.skipIf(process.env.SKELCREW_SANDBOX === "1")("sc review", () => {
  test("reviews a failed review's commit again: posts the verdict, sets the check, and types changes in as a round", async () => {
    addApp();
    verdict(2, "changes", "The export has no test.");
    verdict(3, "approve", "Ready to merge.");
    await startApp12();
    await until(() => thread().needs_you === 1, 30_000);
    const first = pushed();
    const again = await skel(["review", "app-12"]);
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
    expect(again.out).toContain("app-12");
    await until(() => finished("success").length === 1, 45_000);
    expect(
      statuses()
        .filter((s) => s.sha === first)
        .map((s) => [s.state, s.description]),
    ).toEqual([
      ["pending", "Skelcrew's reviewer is reviewing"],
      ["failure", "review failed"],
      ["pending", "Skelcrew's reviewer is reviewing"],
      ["failure", "Skelcrew's reviewer asked for changes"],
    ]);
    expect(reviews()[0]).toEqual({
      commit: first,
      verdict: "changes",
      body: "The export has no test.",
    });
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"));
    expect(thread()).toMatchObject({ status: "waiting", needs_you: 0, rounds: 1 });
  }, 90_000);

  test("refuses a thread with nothing submitted yet, and a thread that is done", async () => {
    addApp();
    fakeClaude(false);
    await startApp12();
    await until(() => read(join(builder(), "args")) !== "");
    const early = await skel(["review", "app-12"]);
    expect(early.code).not.toBe(0);
    expect(early.err).toContain("app-12 has no submitted commit to review yet");
    setThread("status = 'done'");
    const done = await skel(["review", "app-12"]);
    expect(done.code).not.toBe(0);
    expect(done.err).toContain("app-12 is done");
    expect(statuses()).toEqual([]);
  }, 30_000);

  test("the lead can ask, a builder can't, and a review already running is refused", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const fromLead = await skel(["review", "app-12"], { SKELCREW_SOCKET: leadSocketPath() });
    expect(fromLead.code).not.toBe(0);
    expect(fromLead.err).toContain(
      "a review of app-12's last commit is already waiting or running",
    );
    const fromBuilder = await skel(["review", "app-12"], { SKELCREW_SOCKET: builderSocket() });
    expect(fromBuilder.code).not.toBe(0);
    expect(fromBuilder.err).toContain("doesn't know that request");
  }, 60_000);

  test("a newer sc submit cancels a review asked for again", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-2"), "");
    verdict(2, "approve", "Stale.");
    verdict(3, "approve", "Fresh.");
    await startApp12();
    await until(() => thread().needs_you === 1, 30_000);
    const older = pushed();
    // Held so the second ask comes before the check is pending again.
    writeFileSync(join(plugin, "hold-status-pending"), "");
    expect((await skel(["review", "app-12"], { SKELCREW_SOCKET: leadSocketPath() })).err).toBe("");
    const twice = await skel(["review", "app-12"]);
    expect(twice.err).toContain("a review of app-12's last commit is already waiting or running");
    rmSync(join(plugin, "hold-status-pending"));
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), 30_000);
    writeFileSync(join(clone(), "change"), "newer\n");
    git(clone(), "commit", "-qam", "newer");
    expect((await skel(["submit", "Newer"], { SKELCREW_SOCKET: builderSocket() })).err).toBe("");
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(git(clone(), "rev-parse", "HEAD"));
    expect(
      statuses()
        .filter((s) => s.sha === older)
        .map((s) => s.state),
    ).toEqual(["pending", "failure", "pending"]);
    expect(reviews().map((r) => r.body)).toEqual(["Fresh."]);
  }, 60_000);
});

test("only a builder can submit, from its thread", async () => {
  addApp();
  serve();
  await until(() => existsSync(join(home, "run", "skelcrew.sock")));
  await Bun.sleep(100);
  const submitted = await skel(["submit", "Done"]);
  expect(submitted.code).not.toBe(0);
  expect(submitted.err).toContain("doesn't know that request");
});

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
describe.skipIf(process.env.SKELCREW_SANDBOX === "1")("with no tracker and no forge", () => {
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
    const create = await skel(["task", "create", "app", "Add export", "As JSON"]);
    expect(create.err).toContain("app has no tracker");
    const started = await skel(["start", "app", "Add export", "As JSON"]);
    expect(started.err).toBe("");
    expect(started.out).toBe("Started app-t1.\n");
    const log = () => read(join(data(), "threads", "app-t1.log"));
    await until(() => log().includes("app-t1 is ready on branch skelcrew/t1-add-export"), 30_000);
    expect(git(bare, "show", "skelcrew/t1-add-export:change")).toBe("1");
    expect(read(join(data(), "claude", "app-t1", "args"))).toContain("Add export\n\nAs JSON");
    const row = () => {
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      try {
        return db.query("SELECT task, status, needs_you, pr FROM threads").get();
      } finally {
        db.close();
      }
    };
    expect(row()).toEqual({ task: "t1", status: "waiting", needs_you: 1, pr: null });
    // No forge, so no PR, check or review was asked for.
    expect(asked(plugin).filter((q) => q.ask !== "claims")).toEqual([]);
    // You merge it yourself, with a squash, and Skelcrew sees the branch has nothing left.
    const work = join(home, "work", "app");
    git(work, "pull", "-q", bare, "main");
    git(work, "fetch", "-q", bare, "skelcrew/t1-add-export");
    git(work, "merge", "--squash", "-q", "FETCH_HEAD");
    git(work, "commit", "-q", "-m", "Add export");
    git(work, "push", "-q", bare, "main");
    await until(() => JSON.stringify(row()).includes('"done"'), 30_000);
    expect(log()).toContain("is merged into main");
  }, 60_000);

  // Without a forge there is no PR to close, but Skelcrew pushed the branch, so it deletes it.
  test("sc rm deletes the thread's branch from the remote and its clone, and the thread can start over", async () => {
    const bare = addAppOnGit();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Ready again.");
    const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)}, 200);`;
    running.push(
      Bun.spawn([process.execPath, "-e", code], { env: env(), stdout: "ignore", stderr: "ignore" }),
    );
    await untilCloned();
    expect((await skel(["start", "app", "Add export", "As JSON"])).err).toBe("");
    const log = () => read(join(data(), "threads", "app-t1.log"));
    const ready = "app-t1 is ready on branch skelcrew/t1-add-export";
    await until(() => log().includes(ready), 30_000);
    const onRemote = () => git(bare, "branch", "--list", "skelcrew/t1-add-export") !== "";
    expect(onRemote()).toBe(true);

    // With no PR, the question names what goes: the branch and the clone.
    const removed = await runSkelInTerminal(
      socket,
      env(),
      ["rm", "app-t1", "wrong approach"],
      "Remove app-t1? This deletes its branch and clone. [y/N]",
      "y",
    );
    expect(removed).toContain("Removed app-t1.");
    expect(onRemote()).toBe(false);
    expect(existsSync(join(data(), "threads", "app-t1"))).toBe(false);
    expect(log()).toContain("wrong approach");
    expect(asked(plugin).filter((q) => q.ask !== "claims")).toEqual([]);

    // Started over, it isn't taken for a thread whose branch was deleted, and gets as far as
    // the first did.
    const before = log().split(ready).length;
    expect((await skel(["start", "app-t1"])).out).toBe("Started app-t1.\n");
    await until(() => log().split(ready).length > before, 30_000);
    expect(log()).not.toContain("was deleted");
    expect(onRemote()).toBe(true);
  }, 60_000);
});
