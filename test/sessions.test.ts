// The sessions module on tmux, and the built-in transport on top of it, against a fake harness
// on a tmux server of the test's own.
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
import { dirname, join } from "node:path";
import { claude } from "../src/agents/claude.ts";
import { codex } from "../src/agents/codex.ts";
import {
  agentRuns,
  applyConfig,
  endSession,
  exitedCleanly,
  hasSession,
  interruptSession,
  type Labels,
  listSessions,
  readSession,
  startSession,
  stillRunning,
  stopSession,
} from "../src/agents/sessions.ts";
import { tmuxIsAtLeast } from "../src/agents/tmux.ts";
import { deliver, idle, type Marks, quietSince, whyBusy } from "../src/agents/transport.ts";
import { homeEnv, source, until as wait } from "./harness.ts";

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

// The labels every session in these tests carries.
const labels: Labels = { repository: "simon/app", role: "builder", task: "app-12" };

// Starts a session for a test, in the test's home, with the labels above.
const start = (name: string, command: string[], env: Record<string, string> = {}) =>
  startSession(socket, name, { folder: home, command, env, labels });

// Waits for what a session does in its own time, looking often. A busy machine can take
// many seconds to start a session, so the limit is generous: it only ends a test that hangs.
const until = (done: () => boolean | Promise<boolean>) =>
  wait(done, { timeout: 30_000, every: 20 });

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
  await start("lead", harness());
  await deliver(socket, "lead", claude.marks, "fix the bug\nthen run the tests", { moment });
  // The terminal turns the Enter tmux sends into a newline, so one newline means one Enter.
  await until(() => read("received.txt").endsWith("\n"));
  await Bun.sleep(moment * 3);
  expect(read("received.txt")).toBe("\x1b[200~fix the bug\nthen run the tests\x1b[201~\n");
});

test("a message arrives whole while someone is scrolled back, and the agent reads as idle", async () => {
  await start("lead", harness());
  await showing("lead", claude.marks.prompt);
  Bun.spawnSync(["tmux", "-L", socket, "copy-mode", "-t", "=lead:"]);
  expect(await idle(socket, "lead", claude.marks, { moment })).toBe(true);
  await deliver(socket, "lead", claude.marks, "fix the bug", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~fix the bug\x1b[201~\n");
});

test("typing waits while the harness is busy, then goes through", async () => {
  await start("lead", harness(1));
  await deliver(socket, "lead", claude.marks, "hello", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("lost.txt")).toBe("");
  expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
});

test("typing goes by the busy and ready marks of the harness it types into", async () => {
  const marks = { busy: "esc to stop", prompt: "›" };
  await start("lead", harness(1, marks));
  await deliver(socket, "lead", marks, "hello", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("lost.txt")).toBe("");
  expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
});

test("typing gives up when the harness stays busy", async () => {
  await start("lead", harness(30));
  await showing("lead", claude.marks.busy);
  const typing = deliver(socket, "lead", claude.marks, "hello", { moment, timeout: 500 });
  await expect(typing).rejects.toThrow("esc to interrupt");
  expect(read("lost.txt")).toBe("");
});

test("a message cancelled while the harness is busy is never typed", async () => {
  await start("lead", harness(1));
  const cancel = new AbortController();
  const typing = deliver(socket, "lead", claude.marks, "stale", { moment, signal: cancel.signal });
  await Bun.sleep(300);
  cancel.abort();
  await typing;
  deliver(socket, "lead", claude.marks, "fresh", { moment });
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~fresh\x1b[201~\n");
});

// A reason the caller gives to wait, such as the human scrolled back in the lead, can come up
// while typing already waits on a busy agent, and still holds the message.
test("a caller's reason to hold that comes up while typing waits holds the message until it ends", async () => {
  start("lead", harness(1));
  await showing("lead", claude.marks.busy);
  let held = "";
  const typing = deliver(socket, "lead", claude.marks, "hello", { moment, hold: () => held });
  held = "the human has scrolled back in it";
  await showing("lead", claude.marks.prompt);
  await Bun.sleep(1000);
  expect(read("received.txt")).toBe("");
  held = "";
  expect(await typing).toBe("typed");
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
});

// A message gone stale while typing waited, such as a question answered meanwhile, is never
// typed: the hold cancels it.
test("a hold that cancels the typing leaves the message untyped", async () => {
  start("lead", harness(1));
  const cancel = new AbortController();
  const hold = () => {
    cancel.abort();
    return "";
  };
  const typed = await deliver(socket, "lead", claude.marks, "stale", {
    moment,
    signal: cancel.signal,
    hold,
  });
  expect(typed).toBe("not typed");
  await Bun.sleep(300);
  expect(read("received.txt")).toBe("");
});

// The message can go stale between the hold's first look and its last, right before the paste.
test("a hold that cancels the typing at its last look, before the paste, leaves the message untyped", async () => {
  start("lead", harness());
  await showing("lead", claude.marks.prompt);
  const cancel = new AbortController();
  let looks = 0;
  const hold = () => {
    looks++;
    if (looks === 2) cancel.abort();
    return "";
  };
  const typed = await deliver(socket, "lead", claude.marks, "stale", {
    moment,
    signal: cancel.signal,
    hold,
  });
  expect({ typed, looks }).toEqual({ typed: "not typed", looks: 2 });
  await Bun.sleep(300);
  expect(read("received.txt")).toBe("");
});

// Someone can scroll back in the moment between the paste and its Enter. The Enter would go to
// copy mode instead of the agent, and the message would sit at its prompt unsent, so the Enter
// waits until they are back at the bottom.
test("an Enter after the paste waits while the caller holds it, such as someone scrolled back", async () => {
  start("lead", harness());
  await showing("lead", claude.marks.prompt);
  const inMode = () =>
    Bun.spawnSync([
      "tmux",
      "-L",
      socket,
      "display-message",
      "-p",
      "-t",
      "=lead:",
      "#{pane_in_mode}",
    ])
      .stdout.toString()
      .trim() === "1";
  let looks = 0;
  const hold = () => {
    looks++;
    // The last look before the paste finds nobody scrolled back. Someone scrolls back just
    // after the paste, before its Enter.
    if (looks === 2)
      setTimeout(
        () => Bun.spawnSync(["tmux", "-L", socket, "copy-mode", "-t", "=lead:"]),
        moment / 2,
      );
    return inMode() ? "someone has scrolled back in it" : "";
  };
  const typing = deliver(socket, "lead", claude.marks, "hello", { moment, hold });
  // The stand-in reads whole lines, so nothing shows in what it received before the Enter.
  await until(inMode);
  await Bun.sleep(1000);
  expect(inMode()).toBe(true);
  expect(read("received.txt")).toBe("");
  Bun.spawnSync(["tmux", "-L", socket, "send-keys", "-t", "=lead:", "-X", "cancel"]);
  expect(await typing).toBe("typed");
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
});

// A stand-in for Claude Code that draws the screen given, laid out as Claude Code's: what the
// agent said, then its input between two rules, then its footer. It keeps what is typed in.
// SECONDS in a line is a timer: the screen is then redrawn once a second with it counting, as
// Claude Code's spinner line is mid-turn.
function screen(said: string[]): string[] {
  const footer = ["", "────────", claude.marks.prompt, "────────", "  ⏵⏵ accept edits on"];
  writeFileSync(join(home, "screen.txt"), `${[...said, ...footer].join("\n")}\n`);
  const script = join(home, "screen.sh");
  writeFileSync(
    script,
    `#!/bin/sh
printf '\\033[?2004h'
stty -echo
if grep -q SECONDS screen.txt; then
  i=0
  while true; do clear; sed "s/SECONDS/$i/" screen.txt; i=$((i + 1)); sleep 1; done &
else
  cat screen.txt
fi
cat > received.txt
`,
    { mode: 0o755 },
  );
  return [script];
}

// An idle builder whose last reply, just above its input, quotes the busy mark, as one building
// Skelcrew's own typing does.
const quoting = [
  "● Bash(grep -rn busy src)",
  `  ⎿  src/agents/claude.ts:383:  marks: { busy: "${claude.marks.busy}", prompt: "❯" },`,
  "",
  `● sc interrupt presses Esc while the screen shows "${claude.marks.busy}".`,
];

test("a message goes in though the agent's own reply quotes the busy mark", async () => {
  await start("lead", screen(quoting));
  await showing("lead", "accept edits");
  expect(await whyBusy(socket, "lead", claude.marks, { moment })).toBe("");
  expect(await deliver(socket, "lead", claude.marks, "hello", { moment })).toBe("typed");
  await until(() => read("received.txt").endsWith("\n"));
  expect(read("received.txt")).toBe("\x1b[200~hello\x1b[201~\n");
});

// The status module's screen check looks every two seconds, with no hook to say a turn ended,
// as after Esc. Only a live status line keeps the agent working: a reply quoting the busy mark
// sits still.
test("two looks show the agent out of a turn once its status line is gone or only quoted", () => {
  const { busy, prompt } = claude.marks;
  const at = (lines: string[]) => [...lines, "", prompt].join("\n");
  const replied = at(quoting);
  const spinner = (seconds: number) => `✻ Thinking… (${seconds}s · ${busy})`;
  // The mark gone.
  expect(quietSince(undefined, at(["● Done."]), claude.marks)).toBe(true);
  // The mark quoted in a reply, at a bare prompt, the same as the look before.
  expect(quietSince(replied, replied, claude.marks)).toBe(true);
  // With no look before, a mark can't yet be told from a status line.
  expect(quietSince(undefined, replied, claude.marks)).toBe(false);
  // The spinner redrew since the look before.
  expect(quietSince(at([spinner(3)]), at([spinner(5)]), claude.marks)).toBe(false);
  // The mark with no bare prompt, as a harness shows mid-turn without its input.
  expect(quietSince(busy, busy, claude.marks)).toBe(false);
});

// Claude Code's spinner line counts the seconds of the turn, todo list or not.
const spinning = [
  "● Reading the code.",
  "",
  `✻ Thinking… (SECONDSs · ${claude.marks.busy})`,
  "  ⎿  ☐ Read the code",
  "     ☐ Write the test",
];

// The first two looks, a moment apart, mostly fall between two ticks of the spinner's timer,
// so each look here does. A turn can start with nothing typed in, such as when a background
// task ends, so whatever ended the last turn, only the screen tells.
test("a spinner redrawn once a second shows the agent busy at every look", async () => {
  await start("lead", screen(spinning));
  await showing("lead", "accept edits");
  for (let look = 0; look < 3; look++)
    expect(await whyBusy(socket, "lead", claude.marks, { moment })).toBe(
      "it is mid-turn (it shows esc to interrupt)",
    );
});

test("typing says so when it gives up because there is no prompt", async () => {
  await start("lead", ["sh", "-c", "echo starting; sleep 30"]);
  await showing("lead", "starting");
  const typing = deliver(socket, "lead", claude.marks, "hello", { moment, timeout: 300 });
  await expect(typing).rejects.toThrow("prompt");
});

test("two messages typed at once both arrive whole, in order, each sent", async () => {
  await start("lead", harness());
  await Promise.all([
    deliver(socket, "lead", claude.marks, "first\nmessage", { moment }),
    deliver(socket, "lead", claude.marks, "second", { moment }),
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
    await start("lead", drafting(marks));
    await showing("lead", draft);
    const typing = deliver(socket, "lead", marks, "hello", { moment });
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
    await start("lead", drafting(marks));
    await showing("lead", draft);
    const typing = deliver(socket, "lead", marks, "hello", { moment, timeout: 500 });
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
    await start("lead", drafting(claude.marks));
    const typing = deliver(socket, "lead", claude.marks, "hello", { moment });
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

// A daemon that starts again finds its agents by their labels, and the sidebar shows which run.
test("a session carries its labels, and the list shows them with whether its agent runs", async () => {
  await start("builder", ["sleep", "30"]);
  await startSession(socket, "lead", {
    folder: home,
    command: ["sh", "-c", "exit 1"],
    env: {},
    labels: { repository: "simon/app", role: "lead" },
  });
  // A session started by a release before labels.
  Bun.spawnSync(["tmux", "-L", socket, "new-session", "-d", "-s", "old", "sleep", "30"]);
  await until(async () =>
    (await listSessions(socket)).some(({ name, running }) => name === "lead" && !running),
  );
  const found = (await listSessions(socket)).sort((a, b) => a.name.localeCompare(b.name));
  expect(found).toEqual([
    { name: "builder", running: true, labels },
    { name: "lead", running: false, labels: { repository: "simon/app", role: "lead" } },
    { name: "old", running: true, labels: null },
  ]);
});

test("the list is empty while nothing runs", async () => {
  expect(await listSessions(socket)).toEqual([]);
});

test("reading a session gives what its agent shows", async () => {
  await start("builder", ["sh", "-c", "echo hello there; sleep 30"]);
  await until(async () => (await readSession(socket, "builder")).includes("hello there"));
});

test("interrupting a session sends its agent Esc", async () => {
  await start("builder", ["sh", "-c", "stty raw -echo; echo ready; exec cat > keys.txt"]);
  await showing("builder", "ready");
  await interruptSession(socket, "builder");
  await until(() => read("keys.txt") === "\x1b");
});

// Only the sessions module runs tmux for agents, so another session host can take its place.
// The screen keeps a tmux server of its own, which it may run directly.
test("nothing outside the sessions module runs tmux for agents", () => {
  const src = join(import.meta.dir, "..", "src");
  const module = ["agents/sessions.ts", "agents/tmux.ts"];
  const runner = join(src, "agents", "tmux.ts");
  const found: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(src)) {
    if (module.includes(file)) continue;
    const text = readFileSync(join(src, file), "utf8");
    // tmux() and mustTmux() run a command on any server they are given. Each import's path is
    // resolved from its file, as src/agents/ names the runner ./tmux.ts. A whole module, by
    // import * or a dynamic import, would bring the runner too.
    const imports = text.matchAll(/import\s+([^;]*?)\s+from\s+"([^"]+)"|import\(\s*"([^"]+)"/g);
    for (const [, names = "*", path = "", dynamic = ""] of imports) {
      const resolved = join(src, dirname(file), path || dynamic);
      if (resolved === runner && /\*|\b(tmux|mustTmux)\b/.test(names))
        found.push(`${file} imports the tmux runner`);
    }
    // tmux started directly, on a server named with -L, may only be the screen's own.
    for (const line of text.split("\n"))
      if (/tmux"?,?\s+"?-L/.test(line) && !line.includes("screenSocket("))
        found.push(`${file}: ${line.trim()}`);
  }
  expect(found).toEqual([]);
});

test("a session runs its command in its folder, with its environment", async () => {
  await start("builder", ["sh", "-c", 'echo "$SKELCREW_THREAD $(pwd)" > seen.txt; sleep 30'], {
    SKELCREW_THREAD: "app-12",
  });
  await until(() => read("seen.txt") !== "");
  expect(read("seen.txt")).toBe(`app-12 ${home}\n`);
});

// tmux reads a word ending in ";" as the end of a command.
test("a first message and an environment value ending in ; arrive as given", async () => {
  await start(
    "builder",
    ["sh", "-c", 'printf "%s|%s" "$1" "$X" > seen.txt; sleep 30', "sh", "fix it;"],
    {
      X: "a;",
    },
  );
  await until(() => read("seen.txt") !== "");
  expect(read("seen.txt")).toBe("fix it;|a;");
});

// The tmux server hands its own environment to every session, so a token in the daemon's
// environment would reach every agent. Claude Code needs TERM_PROGRAM=tmux to ask for Shift+Enter.
test("a session gets only the environment it is given, and tmux's TERM and TERM_PROGRAM", async () => {
  const sessions = source("agents/sessions.ts");
  const script = `import { startSession } from ${JSON.stringify(sessions)};
startSession(${JSON.stringify(socket)}, "builder", {
  folder: ${JSON.stringify(home)},
  command: ["sh", "-c", "env > env.txt; sleep 30"],
  env: { PATH: process.env.PATH, KEPT: "yes", TERM: "dumb", TERM_PROGRAM: "ghostty" },
  labels: ${JSON.stringify(labels)},
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
    "TERM_PROGRAM",
  ]);
  expect(read("env.txt")).not.toContain("TERM=dumb");
  expect(read("env.txt")).toContain("TERM_PROGRAM=tmux\n");
});

// A lead or builder started before its session kept TERM_PROGRAM runs on after an upgrade, and
// its Claude Code never asked for extended keys. Opening the screen must still give it
// Shift+Enter as a key of its own, without restarting it.
test("an agent that never asked for extended keys gets Shift+Enter once the settings apply again", async () => {
  await start("new", ["sleep", "30"]);
  const script = join(home, "old.sh");
  writeFileSync(script, "#!/bin/sh\nstty raw -echo\nexec cat > keys.txt\n", { mode: 0o755 });
  const tmux = ["tmux", "-L", socket, "-f", "/dev/null"];
  Bun.spawnSync([
    ...tmux,
    "new-session",
    "-d",
    "-s",
    "old",
    "-c",
    home,
    "env",
    "-u",
    "TERM_PROGRAM",
    script,
  ]);
  await until(() => existsSync(join(home, "keys.txt")));
  applyConfig(socket);
  Bun.spawnSync([...tmux, "send-keys", "-t", "=old:", "a", "S-Enter", "b", "Enter"]);
  await until(() => readFileSync(join(home, "keys.txt"), "utf8").endsWith("\r"));
  // tmux before 3.5 has only the xterm form, which Claude Code reads too.
  const shiftEnter = tmuxIsAtLeast(3, 5) ? "\x1b[13;2u" : "\x1b[27;2;13~";
  expect(readFileSync(join(home, "keys.txt"), "utf8")).toBe(`a${shiftEnter}b\r`);
});

test("a name tmux would change is refused", async () => {
  await expect(start("app.1", ["sleep", "30"])).rejects.toThrow("app.1");
  await expect(start("app:1", ["sleep", "30"])).rejects.toThrow("app:1");
  expect(await hasSession(socket, "app_1")).toBe(false);
});

test("ending a session ends its process", async () => {
  await start("builder", ["sh", "-c", "echo $$ > pid.txt; sleep 30"]);
  await until(() => read("pid.txt") !== "");
  expect(await hasSession(socket, "builder")).toBe(true);
  await endSession(socket, "builder");
  expect(await hasSession(socket, "builder")).toBe(false);
  const pid = Number(read("pid.txt").trim());
  await until(() => !alive(pid));
});

// Claude Code can outlive its session for a few seconds, still writing in its folder.
test("stopping a session waits until what it started has exited", async () => {
  const slow = `trap 'sleep 1; echo out > gone.txt; exit' HUP TERM; echo $$ > pid.txt; sleep 30 & wait`;
  await start("builder", ["sh", "-c", slow]);
  await until(() => read("pid.txt") !== "");
  await stopSession(socket, "builder");
  expect(await hasSession(socket, "builder")).toBe(false);
  expect(read("gone.txt")).toBe("out\n");
  expect(alive(Number(read("pid.txt").trim()))).toBe(false);
});

test("stopping a session that doesn't run does nothing", async () => {
  await stopSession(socket, "nobody");
});

test("stopping a session kills what won't exit", async () => {
  await start("builder", [
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

// Copy mode, where an agent you scrolled back is, has keys of its own, so Ctrl-\ is bound there
// too. Alt-Q and Ctrl-Q, which an older Skelcrew bound, are gone.
test("Ctrl-\\ detaches with no prefix, scrolled back too, and there is no status bar", async () => {
  await start("lead", ["sleep", "30"]);
  const tmux = (args: string[]) => Bun.spawnSync(["tmux", "-L", socket, ...args]).stdout.toString();
  expect(tmux(["show-options", "-g", "status"])).toBe("status off\n");
  expect(tmux(["list-keys", "-T", "root", "C-\\"])).toContain("detach-client");
  expect(tmux(["list-keys", "-T", "copy-mode", "C-\\"])).toContain("detach-client");
  expect(tmux(["list-keys", "-T", "root", "M-q"])).toBe("");
  expect(tmux(["list-keys", "-T", "root", "C-q"])).toBe("");
  expect(tmux(["list-keys", "-T", "copy-mode", "C-q"])).toBe("");
  expect(tmux(["list-keys", "-T", "root", "C-]"])).toBe("");
});

// Without it, tmux draws Claude Code's redraws in pieces, and over a slow link the prompt
// visibly flickers.
test("tmux passes synchronized output through to your terminal", async () => {
  await start("lead", ["sleep", "30"]);
  const features = Bun.spawnSync(["tmux", "-L", socket, "show-options", "-s", "terminal-features"]);
  expect(features.stdout.toString()).toContain("*:sync");
});

test("a session that was never started doesn't exist", async () => {
  expect(await hasSession(socket, "nobody")).toBe(false);
});

test("an agent runs only while its session lives and its command hasn't failed", async () => {
  expect(await agentRuns(socket, "builder")).toBe(false);
  await start("builder", ["sh", "-c", "sleep 30"]);
  expect(await agentRuns(socket, "builder")).toBe(true);
  // The next session starts before this one ends. The tmux server exits once it has no
  // session left, and a command that reaches it while it exits fails.
  await start("failed", ["sh", "-c", "exit 3"]);
  await endSession(socket, "builder");
  expect(await agentRuns(socket, "builder")).toBe(false);
  await until(async () => !(await agentRuns(socket, "failed")));
  // A failed command leaves its session behind, showing its last screen.
  expect(await hasSession(socket, "failed")).toBe(true);
});

// A lead's tab closes when its lead exits cleanly, and stays when it fails, so its session must
// keep how it ended.
test("a session kept on exit tells an agent that exited cleanly from one that failed", async () => {
  const keep = (name: string, code: number) =>
    startSession(socket, name, {
      folder: home,
      command: ["sh", "-c", `while [ ! -e ${name}.done ]; do sleep 0.05; done; exit ${code}`],
      env: {},
      labels,
      keepOnExit: true,
    });
  await keep("clean", 0);
  await keep("crashed", 1);
  expect(exitedCleanly(socket, "clean")).toBe(false);
  writeFileSync(join(home, "clean.done"), "");
  writeFileSync(join(home, "crashed.done"), "");
  await until(
    async () => !(await agentRuns(socket, "clean")) && !(await agentRuns(socket, "crashed")),
  );
  expect(exitedCleanly(socket, "clean")).toBe(true);
  expect(exitedCleanly(socket, "crashed")).toBe(false);
  expect(exitedCleanly(socket, "nobody")).toBe(false);
  // A session not kept on exit goes as its agent exits cleanly, as a builder's does.
  await start("builder", ["sh", "-c", "exit 0"]);
  await until(async () => !(await hasSession(socket, "builder")));
});

// Gives simon/app, opened, a lead on this test's tmux server with its ID saved, running `command`
// unless it is null, as a lead whose session went. With `atStart`, the daemon's start settles the
// lead first. Then the look for exited leads runs, and this returns whether the tab closed.
function tabClosedAfterLook(command: string[] | null, atStart = false): string {
  const script = `import { openDb } from ${JSON.stringify(source("db.ts"))};
const { closeExitedLeads, closeLeadAtStart, leadOf } = await import(${JSON.stringify(source("flow/lead.ts"))});
const { startSession } = await import(${JSON.stringify(source("agents/sessions.ts"))});
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, remote, opened) VALUES ('app', 'simon', 'app', '', 1)");
const { name } = leadOf(db, "simon", "app");
db.run("UPDATE repositories SET lead_host_id = ?", [name]);
const command = ${JSON.stringify(command)};
if (command) {
  await startSession(${JSON.stringify(socket)}, name, { folder: ${JSON.stringify(home)}, command, env: {}, labels: { repository: "simon/app", role: "lead" }, keepOnExit: true });
  await Bun.sleep(500);
}
if (${atStart}) await closeLeadAtStart(db, ${JSON.stringify(socket)}, { owner: "simon", repo: "app" });
await closeExitedLeads(db, ${JSON.stringify(socket)});
console.log(db.query("SELECT tab_closed FROM repositories").get().tab_closed);`;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, ...homeEnv(home) },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim().split("\n").at(-1) ?? "";
}

test("a lead whose tmux session went while the daemon runs is taken as exited", () => {
  expect(tabClosedAfterLook(null)).toBe("1");
});

// As after the machine restarted, when every session is gone. A lead that then can't come back,
// such as one whose clone is missing, keeps its tab through the looks that follow too.
test("a lead whose tmux session went before the daemon started is brought back, not exited", () => {
  expect(tabClosedAfterLook(null, true)).toBe("0");
});

test("a lead on tmux that exited cleanly closes its tab", () => {
  expect(tabClosedAfterLook(["sh", "-c", "exit 0"])).toBe("1");
});

test("a lead on tmux that crashed keeps its tab", () => {
  expect(tabClosedAfterLook(["sh", "-c", "exit 3"])).toBe("0");
});

test("a lead on tmux that still runs keeps its tab", () => {
  expect(tabClosedAfterLook(["sleep", "30"])).toBe("0");
});

test("idle means a quiet pane showing the prompt, and not busy", async () => {
  await start("waiting", harness());
  await start("busy", harness(30));
  await start("drawing", [
    "sh",
    "-c",
    'echo "❯"; for i in $(seq 1500); do date +%N; sleep 0.02; done',
  ]);
  await start("other", ["sh", "-c", "echo ready; sleep 30"]);
  await showing("waiting", claude.marks.prompt);
  await showing("busy", claude.marks.busy);
  await showing("drawing", "❯");
  await showing("other", "ready");
  expect(await idle(socket, "waiting", claude.marks, { moment })).toBe(true);
  expect(await idle(socket, "busy", claude.marks, { moment })).toBe(false);
  expect(await idle(socket, "drawing", claude.marks, { moment })).toBe(false);
  expect(await idle(socket, "other", claude.marks, { moment })).toBe(false);
});
