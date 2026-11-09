// skel submit and the build ⇄ review loop, against a running daemon: a shell script stands in
// for the builder and runs skel submit like an agent would, another stands in for Codex, a
// fake gh for GitHub's API, and a folder of bare repositories for what skel pushes to.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { leadPlaces } from "../src/paths.ts";
import {
  git,
  homeEnv,
  issueNode,
  pollAnswer,
  read,
  runSkel,
  source,
  startDaemon,
  until as wait,
  writeScript,
} from "./harness.ts";

let home = "";
let socket = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skel");
const codexHome = () => join(data(), "codex");
const builder = () => join(data(), "claude", "app-12");
const lead = () => join(data(), "claude", leadPlaces("simon", "app").name);
const clone = () => join(data(), "threads", "app-12");

// Puts a program of the test's on its PATH.
const script = (name: string, body: string) => writeScript(home, name, body);

// Stands in for Claude Code. As the lead, it waits at a ❯ prompt and keeps what is typed
// into it. As the builder, it commits a round and runs skel submit, then
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
  skel submit "Round $n" >> "$CLAUDE_CONFIG_DIR/submitted" 2>&1
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

// Stands in for Codex. Review n answers with the verdict in skel's Codex folder's verdict-n,
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
  mkdirSync(join(home, "gh"));
  fakeClaude();
  fakeCodex();
  script("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  // The fake GitHub API: issue 12 in every poll, and as tasks.json says once it is there when
  // asked for by number, pull request 7 once it is opened, and a log of the reviews and checks
  // skel sets.
  writeFileSync(
    join(home, "poll.json"),
    JSON.stringify(pollAnswer([issueNode(12, "Add export", { body: "As JSON" })])),
  );
  script(
    "gh",
    `echo "gh $*" >> "$HOME/gh/calls"
case "$*" in
"api graphql --input -") query=$(cat)
  case "$query" in *"task12: issue("*) cat "$HOME/tasks.json" 2>/dev/null || cat "$HOME/poll.json" ;; *) cat "$HOME/poll.json" ;; esac ;;
"api repos/simon/app/pulls?state=open&head="*) if test -e "$HOME/gh/pr"; then echo '[{"number":7}]'; else echo '[]'; fi ;;
"api repos/simon/app/pulls --method POST --input -") touch "$HOME/gh/opening"; while test -e "$HOME/gh/hold"; do sleep 0.1; done; cat > "$HOME/gh/pr"; echo '{"number":7}' ;;
"api repos/simon/app/pulls/7/reviews --method POST --input -") touch "$HOME/gh/posting"; while test -e "$HOME/gh/hold-review"; do sleep 0.1; done; cat >> "$HOME/gh/reviews"; echo >> "$HOME/gh/reviews"; echo '{"id":1}' ;;
"api repos/simon/app/statuses/"*) body=$(cat)
  case "$body" in *pending*) while test -e "$HOME/gh/hold-pending"; do sleep 0.1; done ;; *) touch "$HOME/gh/finishing"; while test -e "$HOME/gh/hold-status"; do sleep 0.1; done ;; esac
  echo "\${2##*/} $body" >> "$HOME/gh/statuses"; echo '{"state":"set"}' ;;
*) echo "the fake gh doesn't know $*" >&2; exit 1 ;;
esac`,
  );
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  config("");
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skel.service"), "");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${github()}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Simon\n\temail = simon@example.com\n`,
  );
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
    join(home, ".config", "skel", "config.yaml"),
    `harness: claude\nreviewer: { harness: codex }\n${more}`,
  );
}

// What this test's processes run with.
const env = () => homeEnv(home);

// Runs this test's daemon, which the test's clean-up stops.
const serve = () => startDaemon(socket, env(), running);

// Runs skel as you would, or as a builder would with its thread's socket.
const skel = (args: string[], more: Record<string, string> = {}) =>
  runSkel(args, { ...env(), ...more });

// The socket the daemon opens for app-12's builder.
const builderSocket = () => {
  const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
  return join(home, "run", "skel", "threads", short, "skel.sock");
};

// A daemon's work takes its time here, so a wait lasts 15 seconds unless a test says otherwise.
const until = (done: () => boolean, timeout = 15_000) => wait(done, { timeout });

const github = () => join(home, "github");

// Puts simon/app on the fake GitHub and tells skel about it, as a repository you have opened,
// whose lead the daemon starts. Returns a checkout to push from.
function addApp(): string {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(github(), "simon", "app.git"));
  git(work, "remote", "add", "origin", join(github(), "simon", "app.git"));
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo, opened) VALUES ('app', 'simon', 'app', 1)");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  return work;
}

const untilCloned = () => until(() => existsSync(join(data(), "repos", "simon", "app", "README")));

function thread(): Record<string, unknown> {
  const db = new Database(join(data(), "skel.db"));
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
const pushed = (ref = "skel/12-add-export") =>
  git(join(github(), "simon", "app.git"), "rev-parse", ref);
const pushedRound = () =>
  git(join(github(), "simon", "app.git"), "show", "skel/12-add-export:change");

type Status = { sha: string; state: string; context: string; description: string };
function statuses(): Status[] {
  return read(join(home, "gh", "statuses"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...json] = line.split(" ");
      return { sha, ...JSON.parse(json.join(" ")) };
    });
}
const reviews = () =>
  read(join(home, "gh", "reviews"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const typedMessages = () => read(join(builder(), "typed")).split("\x1b[201~").length - 1;
const finished = (state: string) => statuses().filter((s) => s.state === state);

async function startApp12() {
  serve();
  await untilCloned();
  expect((await skel(["start", "app-12"])).err).toBe("");
}

// bubblewrap can't start inside skel's own sandbox, so only there builders can't start.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("skel submit", () => {
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
    const pr = JSON.parse(read(join(home, "gh", "pr")));
    expect(pr).toMatchObject({ head: "skel/12-add-export", base: "main", title: "Add export" });
    expect(pr.body).toBe("Round 1\n\nCloses #12");

    const second = pushed();
    const first = git(join(github(), "simon", "app.git"), "rev-parse", `${second}^`);
    expect(statuses().map((s) => [s.sha, s.state, s.context])).toEqual([
      [first, "pending", "skel/review"],
      [first, "failure", "skel/review"],
      [second, "pending", "skel/review"],
      [second, "success", "skel/review"],
    ]);
    expect(reviews()).toEqual([
      {
        event: "COMMENT",
        commit_id: first,
        body: "**Changes requested.**\n\nThe export has no test.",
      },
      { event: "COMMENT", commit_id: second, body: "**Approved.**\n\nReady to merge." },
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

  test("tells the builder about skel submit, after the task rather than in it", async () => {
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
    ).toContain('skel submit "<summary>"');
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

  test("skel start on a thread past the round limit lets it go on with the last review's changes", async () => {
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

  test("a newer skel submit cancels the review still running for an older commit", async () => {
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
    const again = await skel(["submit", "Newer"], { SKEL_SOCKET: builderSocket() });
    expect(again.err).toBe("");
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(git(clone(), "rev-parse", "HEAD"));
    expect(
      statuses()
        .filter((s) => s.sha === older)
        .map((s) => s.state),
    ).toEqual(["pending"]);
    expect(reviews()).toEqual([
      {
        event: "COMMENT",
        commit_id: git(clone(), "rev-parse", "HEAD"),
        body: "**Approved.**\n\nFresh.",
      },
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
    expect(reviews()).toEqual([
      { event: "COMMENT", commit_id: pushed(), body: "**Approved.**\n\nLooks right." },
    ]);
    await until(() => thread().reviewing === null);
  }, 60_000);

  // A release before skel's copy has no task saved for a thread, and the first poll brings only
  // open issues, while the thread's task may have closed.
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
    const db = new Database(join(data(), "skel.db"));
    db.run("DELETE FROM items");
    db.close();
    const closed = issueNode(12, "Add export", { body: "As JSON", state: "CLOSED" });
    writeFileSync(join(home, "poll.json"), JSON.stringify(pollAnswer([])));
    writeFileSync(
      join(home, "tasks.json"),
      JSON.stringify({ data: { viewer: { login: "simon" }, repository: { task12: closed } } }),
    );
    serve();
    await until(() => finished("success").length + finished("failure").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(pushed());
  }, 60_000);

  test("finishes a submit the daemon's stop cut short while opening the PR", async () => {
    addApp();
    verdict(1, "approve", "Looks right.");
    writeFileSync(join(home, "gh", "hold"), "");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(home, "gh", "opening")), 30_000);
    first.kill();
    await first.exited;
    // The gh the stopped daemon started opens its PR once let go, as GitHub would.
    rmSync(join(home, "gh", "hold"));
    serve();
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(pushed());
    expect(reviews()).toEqual([
      { event: "COMMENT", commit_id: pushed(), body: "**Approved.**\n\nLooks right." },
    ]);
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

  test("a newer skel submit drops a review still waiting for the builder", async () => {
    addApp();
    verdict(1, "changes", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await startApp12();
    await until(() => thread().telling !== null, 30_000);
    writeFileSync(join(clone(), "change"), "newer\n");
    git(clone(), "commit", "-qam", "newer");
    expect((await skel(["submit", "Newer"], { SKEL_SOCKET: builderSocket() })).err).toBe("");
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
    writeFileSync(join(home, "gh", "hold-status"), "");
    await startApp12();
    await until(() => existsSync(join(home, "gh", "finishing")), 30_000);
    expect((await skel(["submit", "Again"], { SKEL_SOCKET: builderSocket() })).err).toBe("");
    await Bun.sleep(1000);
    rmSync(join(home, "gh", "hold-status"));
    await until(() => statuses().length === 3);
    expect(statuses().map((s) => s.state)).toEqual(["pending", "success", "pending"]);
  }, 60_000);

  test("a review cancelled while it is posted doesn't set the check on the commit submitted again", async () => {
    addApp();
    verdict(1, "approve", "Stale.");
    verdict(2, "approve", "Fresh.");
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-2"), "");
    writeFileSync(join(home, "gh", "hold-review"), "");
    await startApp12();
    await until(() => existsSync(join(home, "gh", "posting")), 30_000);
    expect((await skel(["submit", "Again"], { SKEL_SOCKET: builderSocket() })).err).toBe("");
    await Bun.sleep(1000);
    rmSync(join(home, "gh", "hold-review"));
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
    expect(JSON.parse(read(join(home, "gh", "pr"))).base).toBe("next");
    expect(read(join(codexHome(), "sessions", "prompt-1"))).toContain("origin/next...HEAD");
    expect(read(join(codexHome(), "sessions", "branches-1"))).toContain("origin/next");
  }, 60_000);
});

// Lets a test change a thread as merging its PR would, without polling GitHub.
function setThread(change: string): void {
  const db = new Database(join(data(), "skel.db"));
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
  return join(home, "run", "skel", "leads", short, "skel.sock");
};

describe.skipIf(process.env.SKEL_SANDBOX === "1")("skel review", () => {
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
      ["pending", "skel's reviewer is reviewing"],
      ["failure", "review failed"],
      ["pending", "skel's reviewer is reviewing"],
      ["failure", "skel's reviewer asked for changes"],
    ]);
    expect(reviews()[0]).toEqual({
      event: "COMMENT",
      commit_id: first,
      body: "**Changes requested.**\n\nThe export has no test.",
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
    const fromLead = await skel(["review", "app-12"], { SKEL_SOCKET: leadSocketPath() });
    expect(fromLead.code).not.toBe(0);
    expect(fromLead.err).toContain(
      "a review of app-12's last commit is already waiting or running",
    );
    const fromBuilder = await skel(["review", "app-12"], { SKEL_SOCKET: builderSocket() });
    expect(fromBuilder.code).not.toBe(0);
    expect(fromBuilder.err).toContain("doesn't know that request");
  }, 60_000);

  test("a newer skel submit cancels a review asked for again", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-2"), "");
    verdict(2, "approve", "Stale.");
    verdict(3, "approve", "Fresh.");
    await startApp12();
    await until(() => thread().needs_you === 1, 30_000);
    const older = pushed();
    // Held so the second ask comes before the check is pending again.
    writeFileSync(join(home, "gh", "hold-pending"), "");
    expect((await skel(["review", "app-12"], { SKEL_SOCKET: leadSocketPath() })).err).toBe("");
    const twice = await skel(["review", "app-12"]);
    expect(twice.err).toContain("a review of app-12's last commit is already waiting or running");
    rmSync(join(home, "gh", "hold-pending"));
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), 30_000);
    writeFileSync(join(clone(), "change"), "newer\n");
    git(clone(), "commit", "-qam", "newer");
    expect((await skel(["submit", "Newer"], { SKEL_SOCKET: builderSocket() })).err).toBe("");
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(git(clone(), "rev-parse", "HEAD"));
    expect(
      statuses()
        .filter((s) => s.sha === older)
        .map((s) => s.state),
    ).toEqual(["pending", "failure", "pending"]);
    expect(reviews().map((r) => r.body)).toEqual(["**Approved.**\n\nFresh."]);
  }, 60_000);
});

test("only a builder can submit, from its thread", async () => {
  addApp();
  serve();
  await until(() => existsSync(join(home, "run", "skel.sock")));
  await Bun.sleep(100);
  const submitted = await skel(["submit", "Done"]);
  expect(submitted.code).not.toBe(0);
  expect(submitted.err).toContain("doesn't know that request");
});
