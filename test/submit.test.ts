// sc submit and the build ⇄ review loop, against a running daemon: a shell script stands in
// for the builder and runs sc submit like an agent would, another stands in for Codex, a
// fake plugin for the repository's tracker and forge, and a folder of bare repositories for
// what Skelcrew pushes to.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { leadPlaces } from "../src/paths.ts";
import {
  answer,
  asked,
  fakePlugin,
  git,
  homeEnv,
  insideSandbox,
  prItem,
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
// into it. As the builder, it commits a round and runs sc submit, then ends its turn, running
// the Stop hooks its settings give, and waits at a ❯ prompt, keeping what is typed into it. Each
// typed message ends in a paste mark and an Enter, and it runs the UserPromptSubmit hooks, then
// answers it with another round, as a builder fixing a review would. `submits` false leaves the
// first round to the test. While the file busy is in its config folder after a round, it looks
// busy, as Claude Code does mid-turn, and its turn ends once the file is gone. Once a round's
// Stop hooks have run, the file ended holds its number. A ci.yml there goes into each round as
// the repository's first workflow. With docs-only there, a round changes only the file it names, else docs/change.md,
// and with code-to-docs there, it moves src/app.ts to docs/app.md. As a reviewer, run with -p,
// it approves, unless the file claude-limit beside it holds a moment in seconds since 1970
// still to come: until then it says its usage limit is reached, as Claude Code did. Its
// arguments are written aside and moved into place, so a test that sees the file never reads
// them half written.
function fakeClaude(submits = true): void {
  script(
    "claude",
    `case "$CLAUDE_CONFIG_DIR" in */lead-*) stty -echo; echo "❯"; exec cat > "$CLAUDE_CONFIG_DIR/typed" ;; esac
case " $* " in *" -p "*)
  cat > /dev/null
  reset=$(cat "$(dirname "$0")/claude-limit" 2>/dev/null)
  if [ -n "$reset" ] && [ "$(date +%s)" -lt "$reset" ]; then
    echo '{"type":"result","is_error":true,"result":"Claude AI usage limit reached|'"$reset"'"}'
    exit 1
  fi
  echo '{"type":"result","structured_output":{"verdict":"approve","body":"Ready to merge."}}'
  exit 0 ;;
esac
printf '%s\\n' "$@" > "$CLAUDE_CONFIG_DIR/args.part"; mv "$CLAUDE_CONFIG_DIR/args.part" "$CLAUDE_CONFIG_DIR/args"
for a; do [ "$prev" = --settings ] && settings=$a; prev=$a; done
hook() {
  bun -e 'for (const group of JSON.parse(process.argv[1]).hooks?.[process.argv[2]] ?? [])
  for (const hook of group.hooks) console.log(hook.command);' "$settings" "$1" |
  while IFS= read -r command; do echo '{}' | sh -c "$command" >> "$CLAUDE_CONFIG_DIR/hooks" 2>&1; done
}
n=0
round() {
  n=$((n+1))
  if test -e "$CLAUDE_CONFIG_DIR/docs-only"; then
    f=$(cat "$CLAUDE_CONFIG_DIR/docs-only"); f=\${f:-docs/change.md}
    mkdir -p "$(dirname "$f")"; echo "$n" > "$f"
  else echo "$n" > change; fi
  test -e "$CLAUDE_CONFIG_DIR/code-to-docs" && mkdir -p docs && git mv src/app.ts docs/app.md
  test -e "$CLAUDE_CONFIG_DIR/ci.yml" && mkdir -p .github/workflows && cp "$CLAUDE_CONFIG_DIR/ci.yml" .github/workflows/
  git add -A && git commit -qm "round $n"
  sc submit "Round $n" >> "$CLAUDE_CONFIG_DIR/submitted" 2>&1
  while test -e "$CLAUDE_CONFIG_DIR/busy"; do echo "esc to interrupt"; sleep 0.2; done
  hook Stop
  echo "$n" > "$CLAUDE_CONFIG_DIR/ended"
  clear
}
${submits ? "round" : ""}
printf '\\033[?2004h'
stty -echo
echo "❯"
end=$(printf '\\033[201~')
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$CLAUDE_CONFIG_DIR/typed"
  case "$line" in *"$end"*) hook UserPromptSubmit; round; echo "❯" ;; esac
done
exec sleep 300`,
  );
}

// Stands in for Codex. Review n answers with the verdict in Skelcrew's Codex folder's verdict-n,
// and fails without one. It sleeps first when slow-n is there, and while held-n is there it
// waits for the test to put go-n in the sessions folder. With error-n there, it echoes its
// prompt and then that error, as codex exec does, and fails. What it was given, and the
// branches it saw, go in the sessions folder, the one place a review writes that lasts. Each
// file is written aside and renamed in, since tests read a file as soon as it shows, and the
// prompt comes last, so a test that sees it can read all three.
function fakeCodex(): void {
  script(
    "codex",
    `for a; do [ "$prev" = -o ] && out=$a; prev=$a; done
s="$CODEX_HOME/sessions"
n=$(( $(cat "$s/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$s/count"
git branch -r > "$s/branches-$n.new"; mv "$s/branches-$n.new" "$s/branches-$n"
git rev-parse origin/main > "$s/main-$n.new" 2>&1; mv "$s/main-$n.new" "$s/main-$n"
cat > "$s/prompt-$n.new"; mv "$s/prompt-$n.new" "$s/prompt-$n"
test -e "$CODEX_HOME/slow-$n" && sleep 30
i=0; while test -e "$CODEX_HOME/held-$n" && ! test -e "$s/go-$n" && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done
test -e "$CODEX_HOME/error-$n" && { cat "$s/prompt-$n" "$CODEX_HOME/error-$n" >&2; exit 1; }
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

// A daemon's work takes its time here, and longer on a busy CI runner, so a wait lasts 30
// seconds unless a test says otherwise.
const until = (done: () => boolean, timeout = 30_000) => wait(done, { timeout });

const github = () => join(home, "github");

// Puts simon/app on the fake GitHub and tells Skelcrew about it, as a repository you have opened,
// whose lead the daemon starts, with the fake plugin as its tracker and forge, and `bun test` as
// its test command. Returns a checkout to push from. `files` are more files its first commit holds, by path.
function addApp(files: Record<string, string> = {}): string {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  writeFileSync(join(work, "skelcrew.yaml"), "tracker: github\ntest: [bun test]\n");
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

// Waits until the thread no longer holds a review. The forge gets the review's check before
// the daemon saves the thread, so a test that waited only for the check could read the thread
// mid-review.
const untilReviewSaved = () => until(() => thread().reviewing === null);

function thread(): Record<string, unknown> {
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
describe.skipIf(insideSandbox)("sc submit", () => {
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

  // The lead's message changes the task after the thread started, such as a design you agreed
  // to, so the reviewer judges the round by it rather than asking to undo it.
  test("the reviewer gets the lead's messages to the builder after the task", async () => {
    fakeClaude(false);
    addApp();
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => read(join(builder(), "args")) !== "", 30_000);
    const short = new Bun.CryptoHasher("sha256").update("simon/app").digest("hex").slice(0, 16);
    const leadSocket = join(home, "run", "skelcrew", "leads", short, "skelcrew.sock");
    await until(() => existsSync(leadSocket));
    // The builder answers the message with its first round.
    const told = await skel(["tell", "app-12", "Keep the CSV export too."], {
      SKELCREW_SANDBOX: "1",
      SKELCREW_SOCKET: leadSocket,
    });
    expect(told.err).toBe("");
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toMatch(
      /# Add export\n\nAs JSON\n\n## Changes to the task from the lead, after the thread started\n\nThese override the task above where they differ\. The latest comes last\.\n\n### .* UTC\n\nKeep the CSV export too\.\n/,
    );
  }, 60_000);

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
    // Each turn ended with a submit, so the builder never waited on you.
    expect(thread()).toMatchObject({
      status: "waiting",
      needs_you: 0,
      rounds: 1,
      pr: 7,
      stalled: 0,
    });
    expect(read(join(builder(), "hooks"))).toBe("");
    expect(read(join(data(), "threads", "app-12.log"))).not.toContain("without submitting");
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

  // CI runs the whole test suite once per commit, so the reviewer leaves it to CI. The PR's own
  // check on its commit shows CI runs on it, even on a repository's first PR.
  test("once CI shows a check on the PR's commit, the reviewer reads CI's result rather than running the suite", async () => {
    addApp({ ".github/workflows/ci.yml": "on: pull_request\n" });
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => opened() !== undefined, 30_000);
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          checks: [{ name: "test", id: "900", state: "running" }],
        }),
      ],
      next: null,
    });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 60_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain(
      "CI runs the whole test suite on this commit, so don't run it yourself",
    );
    expect(prompt).toContain("ci.md");
  }, 100_000);

  // A workflow can run on other PRs and skip this one, such as with a branch or paths filter.
  // CI elsewhere then proves nothing about this commit, and the reviewer runs the suite.
  test("when CI shows on another PR but never on this one, the reviewer runs the whole suite", async () => {
    addApp({ ".github/workflows/ci.yml": "on: { pull_request: { branches: [next] } }\n" });
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("8", "Other work", {
          branch: "other",
          head: "0123456789abcdef0123456789abcdef01234567",
          checks: [{ name: "test", id: "901", state: "passed" }],
        }),
      ],
      next: null,
    });
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 180_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("No CI runs on this commit, so run the repository's whole test suite");
    expect(prompt).not.toContain("CI is still running");
    expect(prompt).not.toContain("ci.md");
  }, 240_000);

  // CI the PR adds runs on the PR too, but shows no check until the forge starts it.
  test("on a PR that adds the first workflow, the review waits for CI's check, then reads its result", async () => {
    addApp();
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "ci.yml"), "on: pull_request\n");
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => opened() !== undefined, 30_000);
    // No check yet, so no review either.
    await Bun.sleep(5_000);
    expect(existsSync(join(codexHome(), "sessions", "prompt-1"))).toBe(false);
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          checks: [{ name: "test", id: "900", state: "running" }],
        }),
      ],
      next: null,
    });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 60_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain(
      "CI runs the whole test suite on this commit, so don't run it yourself",
    );
  }, 100_000);

  // CI outside GitHub, such as Buildkite, leaves no workflows in the repository, yet shows a
  // check on the commit soon after the push.
  test("without workflows or CI on other PRs, the review waits for an outside check, then reads its result", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    startDaemon(socket, { ...env(), SKELCREW_CHECK_WAIT_MS: "60000" }, running);
    await untilCloned();
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => opened() !== undefined, 30_000);
    // No check yet, so no review either.
    await Bun.sleep(5_000);
    expect(existsSync(join(codexHome(), "sessions", "prompt-1"))).toBe(false);
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", {
          branch: "skelcrew/12-add-export",
          head: pushed(),
          checks: [{ name: "buildkite/test", id: null, state: "running" }],
        }),
      ],
      next: null,
    });
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 60_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain(
      "CI runs the whole test suite on this commit, so don't run it yourself",
    );
  }, 100_000);

  // A workflow that runs only on a release never shows a check on a PR. Once a review has waited
  // for one in vain, the repository's next reviews start at once.
  test("with a release-only workflow, only the first review waits for CI, then the reviewer runs the suite", async () => {
    addApp({ ".github/workflows/release.yml": "on: release\n" });
    verdict(1, "changes", "The export has no test.");
    verdict(2, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 180_000);
    const first = read(join(codexHome(), "sessions", "prompt-1"));
    expect(first).toContain("No CI runs on this commit, so run the repository's whole test suite");
    // The second round's review would wait 2 minutes more if it waited again.
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-2")), 60_000);
    const second = read(join(codexHome(), "sessions", "prompt-2"));
    expect(second).toContain("No CI runs on this commit, so run the repository's whole test suite");
  }, 280_000);

  // CI skips a change to docs and Markdown alone, so the review neither waits for it nor runs
  // the tests.
  test("on a change to docs alone, the review starts at once and runs no tests", async () => {
    addApp({ ".github/workflows/ci.yml": "on: pull_request\n" });
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "");
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("The change only touches docs and Markdown, so don't run the tests.");
    expect(prompt).not.toContain("run the repository's whole test suite");
    expect(prompt).not.toContain("ci.md");
  }, 60_000);

  // git quotes a name with letters outside ASCII, unless asked not to.
  test("a change to a Markdown file with an accented name runs no tests", async () => {
    addApp();
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "résumé.md");
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 60_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("The change only touches docs and Markdown, so don't run the tests.");
  }, 100_000);

  // A file moved from code to docs removes code, though git would show only its new name.
  test("a change that moves code into docs is no docs-only change, and its tests run", async () => {
    addApp({ "src/app.ts": "export const app = 1;\n" });
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "");
    writeFileSync(join(builder(), "code-to-docs"), "");
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("No CI runs on this commit, so run the repository's whole test suite");
    expect(prompt).not.toContain("only touches docs and Markdown");
  }, 60_000);

  test("without CI, the reviewer runs the whole test suite itself", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain(
      "No CI runs on this commit, so run the repository's whole test suite, with `bun test`.",
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
  }, 60_000);

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
      "app-12's push was refused: it changes .github/workflows/ci.yml, which Skelcrew can't push. Undo that change, or a person must make it.";
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
    await until(() => thread().needs_you === 1, 30_000);
    // The note reaches the lead a piece at a time, so the test waits for all of it.
    const said =
      "app-12 needs you: review failed: codex exited with 1: stream disconnected before completion";
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
    // Claude Code says when its limit resets, in seconds since 1970. Far enough off that the
    // first review meets it however slowly the builder starts.
    const reset = Math.ceil(Date.now() / 1000) + 30;
    writeFileSync(join(home, "bin", "claude-limit"), `${reset}\n`);
    await startApp12();
    await until(() => thread().review_limited === 1, 30_000);
    expect(thread()).toMatchObject({ needs_you: 0, review_reset: reset * 1000 });
    await until(() => finished("success").length === 1, 45_000);
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
    expect(log).toContain("app-12's review timed out after 0.1m; retrying");
    await until(() =>
      read(join(lead(), "typed")).includes("app-12's review timed out after 0.1m; retrying"),
    );
    await untilReviewSaved();
    expect(thread()).toMatchObject({ needs_you: 0, verdict: "approve" });
  }, 60_000);

  test("a review that times out twice needs you, and the lead hears why", async () => {
    addApp();
    config("review: { timeout_minutes: 0.1 }\n");
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    writeFileSync(join(codexHome(), "slow-2"), "");
    verdict(3, "approve", "A third review should never run.");
    await startApp12();
    await until(() => thread().needs_you === 1, 30_000);
    expect(thread()).toMatchObject({ verdict: "timed out", reviewing: null });
    expect(finished("failure")[0]?.description).toBe("review timed out");
    expect(reviews()).toEqual([]);
    await until(() =>
      read(join(lead(), "typed")).includes("app-12 needs you: its review timed out twice (0.1m)"),
    );
    expect(read(join(lead(), "typed"))).toContain("app-12's review timed out after 0.1m; retrying");
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

  // Moves main on the fake GitHub with a commit of its own, then merges it into the thread's
  // clone, as a builder brings in main when its PR falls behind.
  function mergeMain(work: string): void {
    writeFileSync(join(work, "OTHER"), "other\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "main moved");
    git(work, "push", "-q", "origin", "main");
    git(clone(), "fetch", "-q", join(github(), "simon", "app.git"), "main");
    git(clone(), "merge", "-q", "--no-ff", "--no-edit", "FETCH_HEAD");
  }

  // Makes the forge show PR 7 with its head at the commit, with the checks given, from the next
  // poll on. These tests' daemons poll every second, as they wait on what the forge shows.
  function showPr(head: string, checks: { name: string; id: null; state: string }[]): void {
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        prItem("7", "Add export", { branch: "skelcrew/12-add-export", head, checks }),
      ],
      next: null,
    });
  }
  const ciCheck = (state: string) => ({ name: "buildkite/test", id: null, state });
  // Runs this test's daemon, polling the forge every second rather than every 30 seconds.
  const servePolling = (more: Record<string, string> = {}) =>
    startDaemon(socket, { ...env(), ...more }, running, 1_000);

  // Starts the daemon, has round 1 approved, then merges main into the branch as `mergeMain`
  // does and submits that. With `ci`, the forge shows CI passed on the approved commit, and on
  // the merge once it is pushed, in the state `merge` gives. Returns the commit submitted and
  // the daemon.
  async function approveThenMerge(
    work: string,
    more: { ci?: boolean; merge?: string } = {},
  ): Promise<{ merged: string; daemon: Subprocess }> {
    const { ci = true, merge = "running" } = more;
    const daemon = servePolling();
    await untilCloned();
    expect((await skel(["start", "app-12"])).err).toBe("");
    await until(() => opened() !== undefined, 60_000);
    if (ci) showPr(pushed(), [ciCheck("passed")]);
    await until(() => finished("success").length === 1, 60_000);
    await untilReviewSaved();
    // The round after waits for CI's first check only once Skelcrew has seen CI on the PR, which
    // comes with a poll. Tests set the wait for a first check without that to 0.
    if (ci) await until(() => thread().checks === "passing", 60_000);
    mergeMain(work);
    const again = await skel(["submit", "Merged main"], { SKELCREW_SOCKET: builderSocket() });
    expect(again.err).toBe("");
    const merged = git(clone(), "rev-parse", "HEAD");
    await until(() => pushed() === merged, 60_000);
    if (ci) showPr(merged, [ciCheck(merge)]);
    return { merged, daemon };
  }

  test("a submit that only merges main keeps the approval once every CI check on it passed", async () => {
    const work = addApp();
    verdict(1, "approve", "Ready to merge.");
    const { merged } = await approveThenMerge(work, { merge: "passed" });
    await until(() => finished("success").length === 2, 60_000);
    await untilReviewSaved();

    // No reviewer ran for the merge, and the check and a comment on the PR say why.
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("1");
    expect(finished("success")[1]).toEqual({
      sha: merged,
      state: "success",
      description: "approval kept: only merged main",
    });
    const kept = reviews()[1];
    expect(kept).toMatchObject({ commit: merged, verdict: "approve" });
    expect(String(kept?.body)).toContain("only merges main");
    // It stays approved, with no round counted.
    expect(thread()).toMatchObject({ status: "waiting", rounds: 0, verdict: "approve" });
    expect(read(join(data(), "threads", "app-12.log"))).toContain("approval kept");
  }, 180_000);

  test("a submit that only merges main is reviewed when a CI check on it fails", async () => {
    const work = addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "changes", "The merge broke the export.");
    const { merged } = await approveThenMerge(work, { merge: "failed" });
    await until(() => reviews().length === 2, 60_000);
    expect(existsSync(join(codexHome(), "sessions", "prompt-2"))).toBe(true);
    expect(reviews()[1]).toEqual({
      commit: merged,
      verdict: "changes",
      body: "The merge broke the export.",
    });
    expect(statuses().some((s) => s.description.startsWith("approval kept"))).toBe(false);
  }, 180_000);

  test("without CI on the merge, a submit that only merges main is reviewed, so its tests run", async () => {
    const work = addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Tests pass.");
    const { merged } = await approveThenMerge(work, { ci: false });
    await until(() => finished("success").length === 2, 60_000);
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("2");
    expect(read(join(codexHome(), "sessions", "prompt-2"))).not.toContain(
      "CI runs the whole test suite on this commit",
    );
    expect(reviews()[1]).toEqual({ commit: merged, verdict: "approve", body: "Tests pass." });
  }, 180_000);

  test("a merge whose wait for CI a restart cut short still keeps the approval", async () => {
    const work = addApp();
    verdict(1, "approve", "Ready to merge.");
    const { merged, daemon } = await approveThenMerge(work, { merge: "running" });
    // CI still runs on the merge, so the approval waits for it to pass.
    await until(
      () => read(join(data(), "threads", "app-12.log")).includes("waiting for CI to pass"),
      60_000,
    );
    // While CI runs, the thread holds the commit as under review: never kept, ready or needing you.
    await Bun.sleep(3_000);
    expect(finished("success").length).toBe(1);
    expect(thread()).toMatchObject({ reviewing: merged, needs_you: 0 });
    daemon.kill();
    await daemon.exited;
    expect(thread().reviewing).toBe(merged);
    servePolling();
    showPr(merged, [ciCheck("passed")]);
    await until(() => finished("success").length === 2, 60_000);
    expect(finished("success")[1]).toMatchObject({
      sha: merged,
      description: "approval kept: only merged main",
    });
    expect(read(join(codexHome(), "sessions", "count")).trim()).toBe("1");
  }, 180_000);

  test("runs again a review the daemon's stop cut short", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "slow-1"), "");
    verdict(2, "approve", "Looks right.");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 60_000);
    first.kill();
    await first.exited;
    expect(thread().reviewing).toBe(pushed());
    serve();
    await until(() => finished("success").length === 1, 30_000);
    expect(finished("success")[0]?.sha).toBe(pushed());
    expect(reviews()).toEqual([{ commit: pushed(), verdict: "approve", body: "Looks right." }]);
    await until(() => thread().reviewing === null);
  }, 130_000);

  // A review the daemon brings back runs before the builders are back, so its changes wait for
  // the builder rather than fail on a session that isn't there yet.
  test("a review brought back that asks for changes types them in once the builder is back", async () => {
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    verdict(2, "changes", "The export has no test.");
    const first = serve();
    await untilCloned();
    await skel(["start", "app-12"]);
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    first.kill();
    await first.exited;
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", "=app-12"]);
    // The builder started again has no round of its own to submit.
    fakeClaude(false);
    serve();
    await until(() => typedMessages() === 1, 30_000);
    expect(read(join(builder(), "typed"))).toContain("The export has no test.");
    await until(() => thread().telling === null);
    expect(thread().needs_you).toBe(0);
  }, 60_000);

  // A review that leaves the queue because its pending check failed never runs, so the thread
  // must not go on saying it is queued.
  test("a review whose pending check fails while it waits is no longer queued, and needs you", async () => {
    config("limits: { reviews: 1 }\n");
    answer(plugin, "changed", {
      items: [
        taskItem("12", "Add export", { body: "As JSON" }),
        taskItem("13", "Add import", { body: "From CSV" }),
      ],
      next: null,
    });
    addApp();
    mkdirSync(codexHome(), { recursive: true });
    writeFileSync(join(codexHome(), "held-1"), "");
    await startApp12();
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 60_000);
    // app-13 gets a PR of its own, and the forge now refuses every check.
    answer(plugin, "open pr", { number: 8 });
    writeFileSync(join(plugin, "fail-status"), "the forge is down");
    expect((await skel(["start", "app-13"])).err).toBe("");
    const app13 = () => {
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      try {
        type Row = { needs_you: number; queued: number | null };
        const query = db.query<Row, [string]>(
          "SELECT needs_you, queued FROM task_threads WHERE folder = ?",
        );
        return query.get("app-13") ?? { needs_you: 0, queued: null };
      } finally {
        db.close();
      }
    };
    await until(() => app13().needs_you === 1, 60_000);
    expect(app13().queued).toBeNull();
    expect((await skel(["ps", "app", "--json"])).out).toContain(
      '"thread":"app-13","short":null,"title":"Add import","status":"waiting","needsYou":true,"queued":false',
    );
  }, 120_000);

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
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 60_000);
    first.kill();
    await first.exited;
    const db = new Database(join(data(), "skelcrew.db"));
    db.run("DELETE FROM items");
    db.close();
    answer(plugin, "changed", { items: [], next: null });
    serve();
    await until(() => finished("success").length + finished("failure").length === 1, 60_000);
    expect(finished("success")[0]?.sha).toBe(pushed());
  }, 120_000);

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
    // The review set the thread working again before the builder's turn ended, but that turn
    // had its submit, so the builder never waited on you.
    expect(read(join(data(), "threads", "app-12.log"))).not.toContain("without submitting");
  }, 60_000);

  // Typing the changes in while the builder asks you a question would answer it for you.
  test("a review's changes wait while the builder asks a question, and go in once it is over", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await startApp12();
    await until(() => thread().telling !== null, 30_000);
    const asBuilder = { SKELCREW_SOCKET: builderSocket() };
    expect((await skel(["question", "asked"], asBuilder)).code).toBe(0);
    rmSync(join(builder(), "busy"));
    await Bun.sleep(6000);
    expect(read(join(builder(), "typed"))).not.toContain("The export has no test.");
    expect(String(thread().telling)).toContain("The export has no test.");
    expect((await skel(["question", "closed"], asBuilder)).code).toBe(0);
    await until(() => read(join(builder(), "typed")).includes("The export has no test."));
    await until(() => thread().telling === null);
  }, 60_000);

  test("keeps a review it couldn't type in, and needs you", async () => {
    addApp();
    verdict(1, "changes", "The export has no test.");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "busy"), "");
    await startApp12();
    await until(() => thread().telling !== null, 30_000);
    // Skelcrew watches a builder for a second after it starts, and one that ends within it
    // failed to start. With no CI to wait for, the review can come back within that second, so
    // the session ends only once the watch is over, as for a builder that ended mid-work.
    await until(() => Date.now() > Number(thread().working_since) + 2000);
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
    await until(() => existsSync(join(plugin, "held-status")), 60_000);
    expect((await skel(["submit", "Again"], { SKELCREW_SOCKET: builderSocket() })).err).toBe("");
    await Bun.sleep(1000);
    rmSync(join(plugin, "hold-status-success"));
    await until(() => statuses().length === 3, 60_000);
    expect(statuses().map((s) => s.state)).toEqual(["pending", "success", "pending"]);
  }, 120_000);

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

  // Skelcrew's clone holds the default branch, and another base only once Skelcrew fetches it.
  // Measured against main, the code next adds would make the change more than docs.
  test("a change to docs alone on another base branch runs no tests", async () => {
    const work = addApp();
    git(work, "checkout", "-q", "-b", "next");
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src", "next.ts"), "export const next = 1;\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "Start next");
    git(work, "push", "-q", "origin", "next");
    mkdirSync(builder(), { recursive: true });
    writeFileSync(join(builder(), "docs-only"), "");
    verdict(1, "approve", "Fine.");
    serve();
    await untilCloned();
    expect((await skel(["start", "app-12", "--from", "next"])).err).toBe("");
    await until(() => existsSync(join(codexHome(), "sessions", "prompt-1")), 30_000);
    const prompt = read(join(codexHome(), "sessions", "prompt-1"));
    expect(prompt).toContain("The change only touches docs and Markdown, so don't run the tests.");
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

describe.skipIf(insideSandbox)("sc review", () => {
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

  // sc review, like sc submit, leaves the builder's turn waiting on a review, not on you.
  test("a builder that asks for another review and ends its turn doesn't need you", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Still ready.");
    await startApp12();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"), 30_000);
    // The first turn's own end must come before the turn the test plays, or it would end that.
    await until(() => read(join(builder(), "ended")).trim() === "1", 30_000);
    const asBuilder = { SKELCREW_SOCKET: builderSocket() };
    // You ask the builder for another review: a new turn, in which it runs sc review.
    expect((await skel(["question", "answered"], asBuilder)).code).toBe(0);
    expect((await skel(["review", "app-12"], asBuilder)).err).toBe("");
    expect((await skel(["turn", "ended"], asBuilder)).code).toBe(0);
    await until(() => finished("success").length === 2, 45_000);
    expect(thread().stalled).toBe(0);
    expect(read(join(data(), "threads", "app-12.log"))).not.toContain("without submitting");
  }, 90_000);

  // Only the builder's own sc review is a submit in its turn.
  test("a review the lead asks for doesn't hide a builder that then stops without submitting", async () => {
    addApp();
    verdict(1, "approve", "Ready to merge.");
    verdict(2, "approve", "Still ready.");
    await startApp12();
    await until(() => read(join(data(), "threads", "app-12.log")).includes("waits on CI"), 30_000);
    // The first turn's own end must come before the turn the test plays, or it would end that.
    await until(() => read(join(builder(), "ended")).trim() === "1", 30_000);
    const asBuilder = { SKELCREW_SOCKET: builderSocket() };
    // Something typed in starts the builder's turn, and meanwhile the lead asks for a review.
    expect((await skel(["question", "answered"], asBuilder)).code).toBe(0);
    expect((await skel(["review", "app-12"], { SKELCREW_SOCKET: leadSocketPath() })).err).toBe("");
    expect((await skel(["turn", "ended"], asBuilder)).code).toBe(0);
    await until(() => thread().stalled === 1);
    await until(() => finished("success").length === 2, 45_000);
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
  }, 60_000);

  test("the lead and the thread's own builder can ask, and a review already running is refused", async () => {
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
    // Refused only as already running, so the builder may ask for its own thread.
    const fromBuilder = await skel(["review", "app-12"], { SKELCREW_SOCKET: builderSocket() });
    expect(fromBuilder.code).not.toBe(0);
    expect(fromBuilder.err).toContain(
      "a review of app-12's last commit is already waiting or running",
    );
    const another = await skel(["review", "app-13"], { SKELCREW_SOCKET: builderSocket() });
    expect(another.code).not.toBe(0);
    expect(another.err).toContain("you may ask for a review of app-12 only");
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
    expect(started.out).toBe("Started app-t1.\n");
    const log = () => read(join(data(), "threads", "app-t1.log"));
    await until(() => log().includes("app-t1 is ready on branch skelcrew/t1-add-export"), 30_000);
    expect(git(bare, "show", "skelcrew/t1-add-export:change")).toBe("1");
    expect(read(join(data(), "claude", "app-t1", "args"))).toContain("Add export\n\nAs JSON");
    const row = () => {
      const db = new Database(join(data(), "skelcrew.db"));
      db.run("PRAGMA busy_timeout = 5000");
      try {
        return db.query("SELECT task, status, needs_you, pr FROM task_threads").get();
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
    // The thread's row changes a moment before its log has the line, so the test waits on the
    // log, which comes last.
    await until(() => log().includes("is merged into main"), 30_000);
    expect(row()).toMatchObject({ status: "done" });
    await until(() =>
      read(join(lead(), "typed")).includes(
        "app-t1 is done: its branch skelcrew/t1-add-export merged into main",
      ),
    );
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
    git(bare, "branch", "skelcrew/t1-add-export", "main");
    serveOutsideCheckout();
    await untilCloned();
    expect((await skel(["start", "app", "Add export", "As JSON"])).err).toBe("");
    await until(() => read(join(data(), "claude", "app-t1", "args")) !== "");
    const removed = await skel(["rm", "app-t1"]);
    expect(removed.err).toBe("");
    // A thread with no issue has nothing that stays open, so the message names none.
    expect(removed.out).toBe("Removed app-t1. sc start app-t1 starts it over.\n");
    expect(git(bare, "branch", "--list", "skelcrew/t1-add-export")).not.toBe("");
    expect(existsSync(join(data(), "threads", "app-t1"))).toBe(false);
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
      await until(() => queued("app-t2"), 30_000);
      await start("Third");
      await until(() => queued("app-t3"), 30_000);
      // Only the first review runs. sc ps and the sidebar say the others wait.
      expect(reviewsRun()).toBe(1);
      const listed = (await skel(["ps"])).out;
      expect(listed).toMatch(/app-t2 .*queued for review/);
      expect(listed).toMatch(/app-t3 .*queued for review/);
      // As each ends, the one that came next starts.
      letGo(1);
      await until(() => prompt(2) !== "", 30_000);
      expect(prompt(2)).toContain("# Second");
      expect(queued("app-t2")).toBe(false);
      expect(queued("app-t3")).toBe(true);
      letGo(2);
      await until(() => prompt(3) !== "", 30_000);
      expect(prompt(3)).toContain("# Third");
      letGo(3);
      await until(() => ["app-t1", "app-t2", "app-t3"].every(ready), 30_000);
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
      await until(() => queued("app-t2"), 30_000);
      expect((await skel(["stop", "app-t2"])).err).toBe("");
      expect((await skel(["ps"])).out).toMatch(/app-t2 .* stopped/);
      letGo(1);
      await until(() => ready("app-t1"), 30_000);
      await Bun.sleep(1500);
      expect(reviewsRun()).toBe(1);
      expect((await skel(["ps"])).out).toMatch(/app-t2 .* stopped/);
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
      await until(() => queued("app-t2"), 30_000);
      first?.kill();
      await first?.exited;
      // Both reviews are still to do, and the second still waits.
      expect(row("app-t1").reviewing).not.toBeNull();
      expect(row("app-t1").queued).toBeNull();
      expect(queued("app-t2")).toBe(true);
      serveOutsideCheckout();
      // The review that was running starts again first, and the one that waited waits again
      // until it ends.
      await until(() => prompt(2) !== "", 30_000);
      expect(prompt(2)).toContain("# First");
      await Bun.sleep(1000);
      expect(reviewsRun()).toBe(2);
      expect(queued("app-t1")).toBe(false);
      expect(queued("app-t2")).toBe(true);
      letGo(2);
      await until(() => prompt(3) !== "", 30_000);
      expect(prompt(3)).toContain("# Second");
      letGo(3);
      await until(() => ready("app-t1") && ready("app-t2"), 30_000);
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
      await until(() => queued("app-t2"), 30_000);
      letGo(1);
      const second = () => read(join(data(), "threads", "app-t2.log"));
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
      await until(() => ready("app-t1"), 30_000);
      // The limit holds: a new thread's review never runs Codex.
      expect(limits()).toBe(1);
      await start("Third");
      const third = () => read(join(data(), "threads", "app-t3.log"));
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
    const log = () => read(join(data(), "threads", "app-t1.log"));
    await until(() => log().includes("app-t1 is ready on branch skelcrew/t1-add-export"), 30_000);
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
    const removing = skel(["rm", "app-t1"]);
    await until(() => existsSync(join(home, "deleted")), 30_000);
    // sc rm's own look came before it deleted the branch, so a look from now on is a poll's.
    // Polls of a repository never overlap, so once a second has begun, the first one has
    // decided what the gone branch means for the thread.
    const before = looks();
    await until(() => looks() >= before + 2, 30_000);
    writeFileSync(join(home, "go"), "");
    const removed = await removing;
    expect(removed.err).toBe("");
    expect(removed.out).toContain("Removed app-t1.");
    expect(log()).not.toContain("was deleted");
    expect(log()).toContain('"why":"removed: ended the thread"');
  }, 60_000);
});
