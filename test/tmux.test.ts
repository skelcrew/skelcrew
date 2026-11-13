// Skelcrew's tmux sessions, against a fake harness on a tmux server of the test's own.
import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { claude } from "../src/agents/claude.ts";
import { codex } from "../src/agents/codex.ts";
import {
  agentRuns,
  endSession,
  exitedCleanly,
  hasSession,
  startSession,
  stillRunning,
  stopSession,
} from "../src/agents/tmux.ts";
import { isIdle, type Marks, typeInto } from "../src/agents/typing.ts";
import { source, until as wait } from "./harness.ts";

const moment = 100;
let home = "";
let socket = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skelcrew-tmux-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
});
afterEach(() => {
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  // tmux leaves the socket file behind after kill-server.
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
});

// A stand-in for a harness, Claude Code unless other marks are given: busy for a while
// (losing what is typed then, as the real one can), then its prompt, which logs every byte it
// receives. It turns on bracketed paste mode, since tmux only sends the paste marks to an app
// that asked for them. The space in its name would break it if tmux ran it through a shell.
function harness(busySeconds = 0, marks: Marks = claude.marks): string[] {
  const script = join(home, `fake harness ${busySeconds}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
if [ ${busySeconds} -gt 0 ]; then
  echo "Thinking (${marks.busy})"
  timeout ${busySeconds} cat > lost.txt
  clear
fi
printf '\\033[?2004h'
# Like Claude Code, it draws its own screen, which may not change at once when text arrives.
stty -echo
echo "${marks.prompt}"
cat > received.txt
`,
    { mode: 0o755 },
  );
  return [script];
}

function start(name: string, command: string[], env: Record<string, string> = {}) {
  startSession(socket, name, { folder: home, command, env });
}

// Waits for what a session does in its own time, looking often. A busy machine can take
// many seconds to start a session, so the limit is generous: it only ends a test that hangs.
const until = (done: () => boolean) => wait(done, { timeout: 30_000, every: 20 });

// Waits until a session shows this text. A check of how a harness's screen reads waits for
// the screen to be drawn first, as a fixed wait can end before a slow start has drawn it.
const showing = (name: string, text: string) =>
  until(() =>
    Bun.spawnSync(["tmux", "-L", socket, "capture-pane", "-p", "-t", `=${name}:`])
      .stdout.toString()
      .includes(text),
  );

const read = (file: string) =>
  existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8") : "";

test("a typed message with several lines arrives whole, as one paste and one Enter", async () => {
  start("lead", harness());
  await typeInto(socket, "lead", claude.marks, "fix the bug\nthen run the tests", { moment });
  // The terminal turns the Enter tmux sends into a newline, so one newline means one Enter.
  await until(() => read("received.txt").endsWith("\n"));
  await Bun.sleep(moment * 3);
  expect(read("received.txt")).toBe("\x1b[200~fix the bug\nthen run the tests\x1b[201~\n");
});

test("a message arrives whole while someone is scrolled back, and the agent reads as idle", async () => {
  start("lead", harness());
  await showing("lead", claude.marks.prompt);
  Bun.spawnSync(["tmux", "-L", socket, "copy-mode", "-t", "=lead:"]);
  expect(await isIdle(socket, "lead", claude.marks, { moment })).toBe(true);
  await typeInto(socket, "lead", claude.marks, "fix the bug", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~fix the bug\x1b[201~\n");
});

test("typing waits while the harness is busy, then goes through", async () => {
  start("lead", harness(1));
  await typeInto(socket, "lead", claude.marks, "hello", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("lost.txt")).toBe("");
  expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
});

test("typing goes by the busy and ready marks of the harness it types into", async () => {
  const marks = { busy: "esc to stop", prompt: "›" };
  start("lead", harness(1, marks));
  await typeInto(socket, "lead", marks, "hello", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("lost.txt")).toBe("");
  expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
});

test("typing gives up when the harness stays busy", async () => {
  start("lead", harness(30));
  await showing("lead", claude.marks.busy);
  const typing = typeInto(socket, "lead", claude.marks, "hello", { moment, timeout: 500 });
  await expect(typing).rejects.toThrow("esc to interrupt");
  expect(read("lost.txt")).toBe("");
});

test("a message cancelled while the harness is busy is never typed", async () => {
  start("lead", harness(1));
  const cancel = new AbortController();
  const typing = typeInto(socket, "lead", claude.marks, "stale", { moment, signal: cancel.signal });
  await Bun.sleep(300);
  cancel.abort();
  await typing;
  typeInto(socket, "lead", claude.marks, "fresh", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~fresh\x1b[201~\n");
});

test("typing says so when it gives up because there is no prompt", async () => {
  start("lead", ["sh", "-c", "echo starting; sleep 30"]);
  await showing("lead", "starting");
  const typing = typeInto(socket, "lead", claude.marks, "hello", { moment, timeout: 300 });
  await expect(typing).rejects.toThrow("prompt");
});

test("two messages typed at once both arrive whole, in order, each sent", async () => {
  start("lead", harness());
  await Promise.all([
    typeInto(socket, "lead", claude.marks, "first\nmessage", { moment }),
    typeInto(socket, "lead", claude.marks, "second", { moment }),
  ]);
  await until(() => read("received.txt").endsWith("second\x1b[201~\n"));
  expect(read("received.txt")).toBe("\x1b[200~first\nmessage\x1b[201~\n\x1b[200~second\x1b[201~\n");
});

// A stand-in harness with a person's unsent draft. While the test leaves a file named draft,
// its prompt line shows what the file holds, as a harness shows text typed but not sent. Once
// the file is gone it shows the bare prompt. It keeps every byte typed into it, as harness()
// does. A background job of a script reads /dev/null unless told otherwise, so the terminal
// is kept on fd 3 for it.
function drafting(marks: Marks): string[] {
  const script = join(home, "drafting harness.sh");
  writeFileSync(
    script,
    `#!/bin/sh
printf '\\033[?2004h'
stty -echo
exec 3<&0
cat <&3 > received.txt &
shown=""
while :; do
  line="${marks.prompt}"
  [ -f draft ] && line="$(cat draft)"
  if [ "$line" != "$shown" ]; then clear; echo "$line"; shown="$line"; fi
  sleep 0.02
done
`,
    { mode: 0o755 },
  );
  return [script];
}

// Each harness's prompt with a draft on it: Claude Code's mark with text after it, and
// Codex's, whose placeholder the draft replaces.
const drafts: [string, Marks, string][] = [
  ["Claude Code", claude.marks, "❯ half-typed"],
  ["Codex", codex.marks, "› half-typed"],
];

// Returns what the test's session shows.
const shown = () =>
  Bun.spawnSync(["tmux", "-L", socket, "capture-pane", "-p", "-t", "=lead:"]).stdout.toString();

for (const [title, marks, draft] of drafts) {
  test(`typing waits while a draft sits at ${title}'s prompt, then goes through`, async () => {
    writeFileSync(join(home, "draft"), draft);
    start("lead", drafting(marks));
    await showing("lead", draft);
    const typing = typeInto(socket, "lead", marks, "hello", { moment });
    // Long enough for several looks at the screen, each of which must leave the draft alone.
    await Bun.sleep(moment * 8);
    expect(read("received.txt")).toBe("");
    expect(shown()).toContain(draft);
    // The person sends or clears the draft, and the message goes in.
    rmSync(join(home, "draft"));
    await typing;
    await until(() => read("received.txt").endsWith("\n"));
    expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
  });

  test(`typing says a draft at ${title}'s prompt is in the way when it gives up`, async () => {
    writeFileSync(join(home, "draft"), draft);
    start("lead", drafting(marks));
    await showing("lead", draft);
    const typing = typeInto(socket, "lead", marks, "hello", { moment, timeout: 500 });
    await expect(typing).rejects.toThrow("unsent draft");
    expect(read("received.txt")).toBe("");
  });
}

test("a draft started just before the paste is left alone, and the message waits for it", async () => {
  // A tmux in front of the real one starts a person's draft once Skelcrew has found the prompt
  // ready and loads its message, and lets the message on only once the draft shows. That
  // makes the moment between the last look and the paste happen every time.
  const real = Bun.which("tmux") ?? "tmux";
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(home, "race"), "❯ half-typed");
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/sh
case " $* " in *" load-buffer "*)
  if [ -f "${home}/race" ]; then
    mv "${home}/race" "${home}/draft"
    until "${real}" -L ${socket} capture-pane -p -t =lead: | grep -q half-typed; do sleep 0.02; done
  fi
esac
exec "${real}" "$@"
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    start("lead", drafting(claude.marks));
    const typing = typeInto(socket, "lead", claude.marks, "hello", { moment });
    await until(() => existsSync(join(home, "draft")));
    await Bun.sleep(moment * 8);
    expect(read("received.txt")).toBe("");
    expect(shown()).toContain("❯ half-typed");
    rmSync(join(home, "draft"));
    await typing;
    await until(() => read("received.txt").endsWith("\n"));
    expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
  } finally {
    process.env.PATH = path;
  }
});

test("a session runs its command in its folder, with its environment", async () => {
  start("builder", ["sh", "-c", 'echo "$SKELCREW_THREAD $(pwd)" > seen.txt; sleep 30'], {
    SKELCREW_THREAD: "app-12",
  });
  await until(() => read("seen.txt") !== "");
  expect(read("seen.txt")).toBe(`app-12 ${home}\n`);
});

// tmux reads a word ending in ";" as the end of a command.
test("a first message and an environment value ending in ; arrive as given", async () => {
  start("builder", ["sh", "-c", 'printf "%s|%s" "$1" "$X" > seen.txt; sleep 30', "sh", "fix it;"], {
    X: "a;",
  });
  await until(() => read("seen.txt") !== "");
  expect(read("seen.txt")).toBe("fix it;|a;");
});

// The tmux server hands its own environment to every session, so a token in the daemon's
// environment would reach every agent.
test("a session gets only the environment it is given, and tmux's TERM", async () => {
  const tmux = source("agents/tmux.ts");
  const script = `import { startSession } from ${JSON.stringify(tmux)};
startSession(${JSON.stringify(socket)}, "builder", {
  folder: ${JSON.stringify(home)},
  command: ["sh", "-c", "env > env.txt; sleep 30"],
  env: { PATH: process.env.PATH, KEPT: "yes", TERM: "dumb" },
});`;
  const run = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, GH_TOKEN: "secret", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1" },
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  await until(() => read("env.txt").includes("KEPT="));
  const names = read("env.txt")
    .split("\n")
    .flatMap((line) => (/^[A-Z_]+=/.test(line) ? [line.slice(0, line.indexOf("="))] : []));
  expect(names.filter((name) => !["PWD", "SHLVL", "_"].includes(name)).sort()).toEqual([
    "KEPT",
    "PATH",
    "TERM",
  ]);
  expect(read("env.txt")).not.toContain("TERM=dumb");
});

test("a name tmux would change is refused", () => {
  expect(() => start("app.1", ["sleep", "30"])).toThrow("app.1");
  expect(() => start("app:1", ["sleep", "30"])).toThrow("app:1");
  expect(hasSession(socket, "app_1")).toBe(false);
});

test("ending a session ends its process", async () => {
  start("builder", ["sh", "-c", "echo $$ > pid.txt; sleep 30"]);
  await until(() => read("pid.txt") !== "");
  expect(hasSession(socket, "builder")).toBe(true);
  endSession(socket, "builder");
  expect(hasSession(socket, "builder")).toBe(false);
  const pid = Number(read("pid.txt").trim());
  await until(() => !alive(pid));
});

// Claude Code can outlive its session for a few seconds, still writing in its folder.
test("stopping a session waits until what it started has exited", async () => {
  const slow = `trap 'sleep 1; echo out > gone.txt; exit' HUP TERM; echo $$ > pid.txt; sleep 30 & wait`;
  start("builder", ["sh", "-c", slow]);
  await until(() => read("pid.txt") !== "");
  await stopSession(socket, "builder");
  expect(hasSession(socket, "builder")).toBe(false);
  expect(read("gone.txt")).toBe("out\n");
  expect(alive(Number(read("pid.txt").trim()))).toBe(false);
});

test("stopping a session that doesn't run does nothing", async () => {
  await stopSession(socket, "nobody");
});

test("stopping a session kills what won't exit", async () => {
  start("builder", [
    "sh",
    "-c",
    "trap '' HUP TERM; echo $$ > pid.txt; for i in $(seq 300); do sleep 0.1; done",
  ]);
  await until(() => read("pid.txt") !== "");
  await stopSession(socket, "builder", 500);
  expect(alive(Number(read("pid.txt").trim()))).toBe(false);
});

// Returns whether a process is still running. One that exited stays a zombie until the test
// run ends, as the run adopts orphans, so asking the system for its ID would still find it.
const alive = (pid: number) => stillRunning([pid]).length > 0;

test("Ctrl-Q detaches with no prefix, and there is no status bar", () => {
  start("lead", ["sleep", "30"]);
  const tmux = (args: string[]) => Bun.spawnSync(["tmux", "-L", socket, ...args]).stdout.toString();
  expect(tmux(["show-options", "-g", "status"])).toBe("status off\n");
  expect(tmux(["list-keys", "-T", "root", "C-q"])).toContain("detach-client");
  expect(tmux(["list-keys", "-T", "root", "C-]"])).toBe("");
});

// Without it, tmux draws Claude Code's redraws in pieces, and over a slow link such as a
// Sprite's the prompt visibly flickers.
test("tmux passes synchronized output through to your terminal", () => {
  start("lead", ["sleep", "30"]);
  const features = Bun.spawnSync(["tmux", "-L", socket, "show-options", "-s", "terminal-features"]);
  expect(features.stdout.toString()).toContain("*:sync");
});

test("a session that was never started doesn't exist", () => {
  expect(hasSession(socket, "nobody")).toBe(false);
});

test("an agent runs only while its session lives and its command hasn't failed", async () => {
  expect(agentRuns(socket, "builder")).toBe(false);
  start("builder", ["sh", "-c", "sleep 30"]);
  expect(agentRuns(socket, "builder")).toBe(true);
  // The next session starts before this one ends. The tmux server exits once it has no
  // session left, and a command that reaches it while it exits fails.
  start("failed", ["sh", "-c", "exit 3"]);
  endSession(socket, "builder");
  expect(agentRuns(socket, "builder")).toBe(false);
  await until(() => !agentRuns(socket, "failed"));
  // A failed command leaves its session behind, showing its last screen.
  expect(hasSession(socket, "failed")).toBe(true);
});

// A lead's tab closes when its lead exits cleanly, and stays when it fails, so its session must
// keep how it ended.
test("a session kept on exit tells an agent that exited cleanly from one that failed", async () => {
  const keep = (name: string, code: number) =>
    startSession(socket, name, {
      folder: home,
      command: ["sh", "-c", `while [ ! -e ${name}.done ]; do sleep 0.05; done; exit ${code}`],
      env: {},
      keepOnExit: true,
    });
  keep("clean", 0);
  keep("crashed", 1);
  expect(exitedCleanly(socket, "clean")).toBe(false);
  writeFileSync(join(home, "clean.done"), "");
  writeFileSync(join(home, "crashed.done"), "");
  await until(() => !agentRuns(socket, "clean") && !agentRuns(socket, "crashed"));
  expect(exitedCleanly(socket, "clean")).toBe(true);
  expect(exitedCleanly(socket, "crashed")).toBe(false);
  expect(exitedCleanly(socket, "nobody")).toBe(false);
  // A session not kept on exit goes as its agent exits cleanly, as a builder's does.
  start("builder", ["sh", "-c", "exit 0"]);
  await until(() => !hasSession(socket, "builder"));
});

test("idle means a quiet pane showing the prompt, and not busy", async () => {
  start("waiting", harness());
  start("busy", harness(30));
  start("drawing", ["sh", "-c", 'echo "❯"; for i in $(seq 1500); do date +%N; sleep 0.02; done']);
  start("other", ["sh", "-c", "echo ready; sleep 30"]);
  await showing("waiting", claude.marks.prompt);
  await showing("busy", claude.marks.busy);
  await showing("drawing", "❯");
  await showing("other", "ready");
  expect(await isIdle(socket, "waiting", claude.marks, { moment })).toBe(true);
  expect(await isIdle(socket, "busy", claude.marks, { moment })).toBe(false);
  expect(await isIdle(socket, "drawing", claude.marks, { moment })).toBe(false);
  expect(await isIdle(socket, "other", claude.marks, { moment })).toBe(false);
});
