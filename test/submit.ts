// What the tests of sc submit share: a home with fake programs, a daemon, the stand-ins for the
// builder and for Codex, and ways to read what Skelcrew pushed, posted and saved.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  numberedBefore,
  read,
  runSkel,
  source,
  startDaemon,
  taskItem,
  until as wait,
  writeScript,
} from "./harness.ts";

export let home = "";
export let socket = "";
// The fake plugin's settings folder, where it keeps what it is asked and its answers.
export let plugin = "";
export const running: Subprocess[] = [];

export const data = () => join(home, ".local", "share", "skelcrew");
export const codexHome = () => join(data(), "codex");
export const builder = () => join(data(), "claude", "app-12");
export const lead = () => join(data(), "claude", leadPlaces("simon", "app").name);
export const clone = () => join(data(), "threads", "app-12");

// Puts a program of the test's on its PATH.
export const script = (name: string, body: string) => writeScript(home, name, body);

// Stands in for Claude Code. As the lead, it waits at a ❯ prompt and keeps what is typed
// into it. As the builder, it commits a round and runs sc submit, then ends its turn, running
// the Stop hooks its settings give, and waits at a ❯ prompt, keeping what is typed into it. Each
// typed message ends in a paste mark and an Enter, and it runs the UserPromptSubmit hooks, then
// answers it with another round, as a builder fixing a review would. `submits` false leaves the
// first round to the test, and `answers` false keeps what is typed in without answering it.
// While the file busy is in its config folder after a round, it looks busy, as Claude Code does
// mid-turn, and its turn ends once the file is gone. Once a round's
// Stop hooks have run, the file ended holds its number. A ci.yml there goes into each round as
// the repository's first workflow. With docs-only there, a round changes only the file it names, else docs/change.md,
// and with code-to-docs there, it moves src/app.ts to docs/app.md. As a reviewer, run with -p,
// it approves, unless the file claude-limit beside it says limit: then it says its usage
// limit is reached until 3 seconds from when it runs, as Claude Code did. Its
// arguments are written aside and moved into place, so a test that sees the file never reads
// them half written. The instructions it reads from its instructions file go in told, the same
// way and before them, so a test that sees its arguments can read told too.
export function fakeClaude(submits = true, answers = true): void {
  script(
    "claude",
    `case "$CLAUDE_CONFIG_DIR" in */lead-*) stty -echo; echo "❯"; exec cat > "$CLAUDE_CONFIG_DIR/typed" ;; esac
case " $* " in *" -p "*)
  cat > /dev/null
  if [ "$(cat "$(dirname "$0")/claude-limit" 2>/dev/null)" = limit ]; then
    reset=$(( $(date +%s) + 3 ))
    echo '{"type":"result","is_error":true,"result":"Claude AI usage limit reached|'"$reset"'"}'
    exit 1
  fi
  echo '{"type":"result","structured_output":{"verdict":"approve","body":"Ready to merge.","findings":[]}}'
  exit 0 ;;
esac
for a; do [ "$prev" = --settings ] && settings=$a; [ "$prev" = --append-system-prompt-file ] && told=$a; prev=$a; done
cat "$told" > "$CLAUDE_CONFIG_DIR/told.part"; mv "$CLAUDE_CONFIG_DIR/told.part" "$CLAUDE_CONFIG_DIR/told"
printf '%s\\n' "$@" > "$CLAUDE_CONFIG_DIR/args.part"; mv "$CLAUDE_CONFIG_DIR/args.part" "$CLAUDE_CONFIG_DIR/args"
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
  case "$line" in *"$end"*) hook UserPromptSubmit; ${answers ? "round; " : ""}echo "❯" ;; esac
done
exec sleep 300`,
  );
}

// Stands in for Codex. Review n answers with the verdict in Skelcrew's Codex folder's verdict-n,
// and fails without one. With check-n there, it first runs sc check, as a reviewer runs the
// tests, and notes in the sessions folder that it did. With linger-n there, it leaves a process
// in a session of its own that holds its output open, and notes its ID in linger-n there. It sleeps first when slow-n is there, and while held-n is there it
// waits for the test to put go-n in the sessions folder. With error-n there, it echoes its
// prompt and then that error, as codex exec does, and fails. What it was given, the branches it
// saw, and in since-n the diff since the last round, go in the sessions folder, the one place a
// review writes that lasts. Each file is written aside and renamed in, since tests read a file
// as soon as it shows, and the prompt comes last, so a test that sees it can read the others.
export function fakeCodex(): void {
  script(
    "codex",
    `for a; do [ "$prev" = -o ] && out=$a; prev=$a; done
s="$CODEX_HOME/sessions"
n=$(( $(cat "$s/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$s/count"
git branch -r > "$s/branches-$n.new"; mv "$s/branches-$n.new" "$s/branches-$n"
git rev-parse origin/main > "$s/main-$n.new" 2>&1; mv "$s/main-$n.new" "$s/main-$n"
cat > "$s/prompt-$n.new"
f=$(grep -o '/[^ ]*/since-last-round\\.diff' "$s/prompt-$n.new" | head -1)
test -z "$f" || cp "$f" "$s/since-$n"
mv "$s/prompt-$n.new" "$s/prompt-$n"
test -e "$CODEX_HOME/check-$n" && { touch "$s/checking-$n"; sc check > /dev/null 2>&1; }
test -e "$CODEX_HOME/linger-$n" && { setsid sleep 600 & echo $! > "$s/linger-$n"; }
test -e "$CODEX_HOME/slow-$n" && sleep 30
i=0; while test -e "$CODEX_HOME/held-$n" && ! test -e "$s/go-$n" && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done
test -e "$CODEX_HOME/error-$n" && { cat "$s/prompt-$n" "$CODEX_HOME/error-$n" >&2; exit 1; }
test -e "$CODEX_HOME/verdict-$n" || { echo "no verdict for review $n" >&2; exit 1; }
cp "$CODEX_HOME/verdict-$n" "$out"`,
  );
}

// Gives review n's answer. Changes name the body as their one finding, unless `findings` says
// otherwise. Each finding is a P1 that blocks.
export function verdict(
  n: number,
  said: "approve" | "changes",
  body: string,
  findings: string[] = said === "changes" ? [body] : [],
): void {
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(
    join(codexHome(), `verdict-${n}`),
    JSON.stringify({
      verdict: said,
      body,
      findings: findings.map((finding) => ({ finding, severity: "P1", blocking: true })),
    }),
  );
}

// Gives each test a home of its own, with the fake programs Skelcrew finds there, and a tmux
// socket of its own.
export function setUp(): void {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-submit-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  fakeClaude();
  fakeCodex();
  mkdirSync(join(home, ".local", "share", "skelcrew", "codex"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "skelcrew", "codex", "auth.json"), "{}");
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

export function config(more: string): void {
  writeFileSync(
    join(home, ".config", "skelcrew", "config.yaml"),
    `harness: claude\nreviewer: { harness: codex }\n${more}`,
  );
}

// What this test's processes run with.
export const env = () => homeEnv(home);

// Runs this test's daemon, which the test's clean-up stops. `daemon` can add to its
// environment, and say how often it polls the forge, in milliseconds, for a test that waits on
// what the forge shows, rather than every 30 seconds.
export type Daemon = { every?: number; env?: Record<string, string> };
export const serve = (daemon: Daemon = {}) =>
  startDaemon(socket, { ...env(), ...daemon.env }, running, daemon.every);

// Runs sc as you would, or as a builder would with its thread's socket.
export const skel = (args: string[], more: Record<string, string> = {}) =>
  runSkel(args, { ...env(), ...more });

// The socket the daemon opens for app-12's builder.
export const builderSocket = () => {
  const short = new Bun.CryptoHasher("sha256").update("app-12").digest("hex").slice(0, 16);
  return join(home, "run", "skelcrew", "threads", short, "skelcrew.sock");
};

// A daemon's work takes its time here, and longer on a busy CI runner, so a wait lasts 30
// seconds unless a test says otherwise. One that gives up shows the end of the thread's log,
// so a failure on CI says which step the thread stalled at, and when.
// A wait for a step behind a whole round: the builder's turn, a sandbox starting for the
// review, and a poll of the forge or a short wait for CI. Each takes seconds alone, but four
// test files run at once on a small CI runner, so these waits get twice the usual time.
export const longWait = 60_000;

export const until = (done: () => boolean, timeout = 30_000) =>
  wait(done, { timeout, what: () => `the daemon. The thread's last steps were:\n${lastSteps()}` });

// Returns the last steps in the thread's log, each as when and why: app-12's, or for a
// repository with no tracker, the first thread this machine started. A line still being
// written, or one that gives no reason, is left out.
export function lastSteps(): string {
  const threads = join(data(), "threads");
  const log = existsSync(join(threads, "app-12.log")) ? "app-12.log" : `app-1.log`;
  const lines = read(join(threads, log)).split("\n");
  const steps: string[] = [];
  for (const line of lines.slice(-12))
    try {
      const { at, why } = JSON.parse(line);
      if (why) steps.push(`${at} ${why}`);
    } catch {}
  return steps.join("\n");
}

export const github = () => join(home, "github");

// Puts simon/app on the fake GitHub and tells Skelcrew about it, as a repository you have opened,
// whose lead the daemon starts, with the fake plugin as its tracker and forge, and `bun test` as
// its test command. Returns a checkout to push from. `files` are more files its first commit holds, by path.
export function addApp(files: Record<string, string> = {}): string {
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
  // Its task on issue #12 is APP-12.
  numberedBefore(join(github(), "simon", "app.git"), 11);
  git(work, "remote", "add", "origin", join(github(), "simon", "app.git"));
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo, opened, forge, remote, claimed) VALUES ('app', 'simon', 'app', 1, 'github', 'https://github.com/simon/app.git', 1)");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
  return work;
}

// Waits until the daemon has cloned app, which comes once it has started. `timeout` is longer
// for a test whose daemon starts while other test files keep the machine busy.
export const untilCloned = (timeout = 30_000) =>
  until(() => existsSync(join(data(), "repos", "simon", "app", "README")), timeout);

// Waits until the thread no longer holds a review, and its verdict is on the PR. The daemon
// saves the verdict first, then posts it and sets its check, so a test that waited only for
// one of them could read the other mid-way.
export const untilReviewSaved = () =>
  until(() => thread().reviewing === null && thread().posting === null);

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

// The commit on the thread's branch on the fake GitHub, and what is in its round.
export const pushed = (ref = "skelcrew/12-add-export") =>
  git(join(github(), "simon", "app.git"), "rev-parse", ref);
export const pushedRound = () =>
  git(join(github(), "simon", "app.git"), "show", "skelcrew/12-add-export:change");

// The checks Skelcrew set on commits, and the reviews it posted, as it asked the forge.
export type Status = { sha: string; state: string; description: string };
export const statuses = (): Status[] =>
  asked(plugin)
    .filter((q) => q.ask === "status")
    .map((q) => ({
      sha: String(q.commit),
      state: String(q.state),
      description: String(q.description),
    }));
// A review's body as the PR shows it: without the hidden marker Skelcrew puts last, naming the
// thread, which the forge doesn't show.
export const shown = (body: unknown) =>
  String(body).replace(/\n\n<!-- skelcrew:review thread=[\w-]+ -->$/, "");
// A review's body without the line Skelcrew puts first, naming its round and commit, so a test
// reads what the reviewer said and found.
export const said = (body: unknown) => shown(body).replace(/^Round \d+ · commit \w+\n\n/, "");
export const reviews = () =>
  asked(plugin)
    .filter((q) => q.ask === "review")
    .map(({ commit, verdict, body }) => ({ commit, verdict, body: said(body) }));
// The edits Skelcrew asked of its review on the PR, in place of posting another.
export const edits = () =>
  asked(plugin)
    .filter((q) => q.ask === "edit review")
    .map(({ pr, id, verdict, body }) => ({ pr, id, verdict, body: shown(body) }));
// PR 7 as Skelcrew's copy of the forge holds it, or nothing yet.
export function copiedPr(): string {
  const db = new Database(join(data(), "skelcrew.db"));
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const row = db.query("SELECT item FROM items WHERE kind = 'pr' AND id = '7'").get();
    return row && typeof row === "object" && "item" in row ? String(row.item) : "";
  } finally {
    db.close();
  }
}
// The PR Skelcrew opened, as it asked the forge, or nothing.
export const opened = () => asked(plugin).find((q) => q.ask === "open pr");
export const typedMessages = () => read(join(builder(), "typed")).split("\x1b[201~").length - 1;
export const finished = (state: string) => statuses().filter((s) => s.state === state);

// Waits until the daemon has asked the forge what changed three more times. A repository's polls
// run one at a time, each asking that first, so by the third new ask a poll that began after
// this call has ended, with all it decided.
export async function morePolls(): Promise<void> {
  const polls = () => asked(plugin).filter((q) => q.ask === "changed").length;
  const before = polls();
  await until(() => polls() >= before + 3);
}

// Starts app-12 again after sc stop, and waits until its builder is back. The round it had
// carries on only then, so a review asked for before could otherwise start a second time. The
// builder brought back neither submits nor answers what is typed in, so the reviews that follow
// are only those the test asks for.
export async function startAgain() {
  fakeClaude(false, false);
  rmSync(join(builder(), "args"), { force: true });
  expect((await skel(["start", "app-12"])).err).toBe("");
  await until(() => existsSync(join(builder(), "args")), 30_000);
  await Bun.sleep(1000);
}

// Starts the daemon, as `serve` does, and app-12 once Skelcrew has cloned app.
export async function startApp12(daemon: Daemon = {}) {
  serve(daemon);
  await untilCloned();
  expect((await skel(["start", "app-12"])).err).toBe("");
}

// Starts the daemon, approves app's .agents/ as sc repo trust would, and starts app-12 on its
// flow noreview, which has no review stage.
export async function startNoReview(daemon: Daemon = {}) {
  serve(daemon);
  await untilCloned();
  const tree = git(join(data(), "repos", "simon", "app"), "rev-parse", "HEAD:.agents");
  writeFileSync(join(home, ".config", "skelcrew", "approved-agents.yaml"), `simon/app: ${tree}\n`);
  expect((await skel(["start", "app-12", "--flow", "noreview"])).err).toBe("");
}
