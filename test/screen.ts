import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Labels, processTree, startSession, stillRunning } from "../src/agents/sessions.ts";
import { sidebarFor } from "../src/screen/screen.ts";
import { fakePlugin, source, threadSql, until as wait } from "./harness.ts";

const dbFile = source("db.ts");

export const screenFile = source("screen/screen.ts");
export const pathNow = process.env.PATH ?? "";
// How wide the sidebar is in the 120 columns the tests' terminal has, unless a test resizes it.
export const sidebar = sidebarFor(120);
export const leaving = "Your agents keep running. Run sc to come back.";
// The labels the sessions these tests start carry, as the lead of the repository they add.
export const labels: Labels = { repository: "simon/app", role: "lead" };
export let home = "";
let standIn: Server | null = null;
export let agents = "";
export let screen = "";
export let terminal = "";

// The sockets are the test's own too, as a sidebar tells whatever daemon it finds that it opened.
export const env = () => ({ ...process.env, HOME: home, XDG_RUNTIME_DIR: join(home, "run") });
// Runs tmux on one of the test's servers, never on Skelcrew's own. A tmux that never returns
// would block the whole test file, Bun's own timeout included, until the run's limit ends its
// worker without a word. So past 10 seconds it is ended, and the test fails naming the command.
export function tmux(socket: string, ...args: string[]) {
  const run = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args], {
    env: { ...env(), TMUX: "" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (run.exitedDueToTimeout)
    throw new Error(`tmux ${args.join(" ")} on ${socket} didn't return within 10 seconds`);
  return { ok: run.success, out: run.stdout.toString() };
}

// Says what it waited for and shows the window it watched, if it gives up.
export const until = (done: () => boolean, what: string, window = "one") =>
  wait(done, { every: 30, what: () => `${what}:\n${seen(window)}` });

// What an agent's script logged in a file of the test's folder, or nothing before it has.
export const read = (file: string) => {
  const path = join(home, file);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

// What you see in the first terminal, or a second one.
export const seen = (window = "one") =>
  tmux(terminal, "capture-pane", "-p", "-t", `=${window}:`).out;
// Returns how wide the sidebar is now, from how wide the terminal is, as a test may resize it.
const sidebarNow = (window = "one") =>
  sidebarFor(Number(tmux(terminal, "display", "-p", "-t", `=${window}:`, "#{window_width}").out));
// The top row as you see it: Skelcrew above the sidebar, then the tabs above the right side.
export const tabRow = () => (seen().split("\n")[0] ?? "").trimEnd();
// The row you are looking at, as the sidebar shows it: the line it starts with ▸, lit while your
// typing goes to the sidebar, or the outline ▹ while it goes to the right side, or a heading with
// the grey background. Below the status line, where the open tab has the same grey, and left of
// the sidebar's edge. Empty until the sidebar has drawn one.
export function selected(window = "one"): string {
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", `=${window}:`).out;
  const width = sidebarNow(window) - 1;
  const lines = colours.split("\n").slice(1);
  const line = lines.find((text) => {
    const plain = Bun.stripANSI(text).slice(0, width).trim();
    return /^[▸▹] /.test(plain) || (text.split(/[▏▕]/)[0] ?? "").includes("48;5;238");
  });
  return Bun.stripANSI(line ?? "")
    .slice(0, width)
    .trim();
}
// Returns whether your typing goes to the sidebar, as the row you are on is lit there with ▸.
export const typingToSidebar = (window = "one") => selected(window).startsWith("▸");
export const screenSessions = () =>
  tmux(screen, "list-sessions", "-F", "#{session_name}").out.trim().split("\n").filter(Boolean);

// Starts an agent that sets a title of its own, as Claude Code does, says its name, and logs
// what you type and the size of its window. It first runs `before`, such as printing a long
// history.
export function agent(name: string, before = ""): void {
  const script = join(home, `${name}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
cd ${JSON.stringify(home)}
trap 'stty size > ${name}.size' WINCH
stty size > ${name}.size
${before}
printf '\\033]0;title of ${name}\\007'
echo "I am ${name}"
# A resize cuts read short, which must not end the agent.
while test -d ${JSON.stringify(home)}; do read -r line && echo "$line" >> ${name}.typed; done
`,
    { mode: 0o755 },
  );
  startSession(agents, name, { folder: home, command: [script], env: { PATH: pathNow }, labels });
}

// The load the footer shows in these tests, in place of the machine's, which changes on its own.
export const fixedLoad = "cpu 12%  mem 3.4/16G";
// What a test can change for itself, set back before each test. `before` goes ahead of Skelcrew
// in a terminal's command, such as a PATH that changes what it finds. `extendedKeys` says whether
// the terminals send Shift+Enter and other modified keys as keys of their own when asked, as
// Ghostty, kitty and WezTerm do. Terminal.app never does. `mergeAnswer` and `holding` are how the
// stand-in daemon answers, below.
export const given: {
  before: string;
  extendedKeys: boolean;
  mergeAnswer: object;
  holding: boolean;
} = { before: "", extendedKeys: false, mergeAnswer: {}, holding: false };

// Puts a tmux in front of the real one that notes each time the sidebar asks for the agents'
// panes, as it does first in every refresh. A refresh that changes nothing writes nothing, so
// this is how a test sees one. It must be set before the screen opens.
export function noteRefreshes(): void {
  const folder = join(home, "noting");
  mkdirSync(folder);
  writeFileSync(
    join(folder, "tmux"),
    `#!/bin/sh\ncase "$*" in *"list-panes -a -F #{pane_dead}"*) echo >> ${join(home, "refreshes")} ;; esac\nexec ${Bun.which("tmux") ?? "tmux"} "$@"\n`,
    { mode: 0o755 },
  );
  given.before = `PATH=${folder}:$PATH `;
}

// How many refreshes the sidebar has started.
const refreshesStarted = () => read("refreshes").split("\n").length - 1;

// Returns once the sidebar has started two refreshes from now. The first reads Skelcrew's copy
// as it is now, and the second starts only once the first has drawn what it read.
export async function sidebarRefreshedTwice(): Promise<void> {
  const before = refreshesStarted();
  await until(() => refreshesStarted() >= before + 2, "the sidebar to refresh twice");
}

// Opens the screen on an agent in a terminal of its own, whose title until then is "my shell",
// and which logs how Skelcrew exited. `where` is the name a laptop's sc --remote passes along.
export function open(
  session: string,
  window = "one",
  term = "xterm-256color",
  width = "120",
  where = "",
): void {
  const script = join(home, `open-${window}.ts`);
  writeFileSync(
    script,
    `import { openScreen } from ${JSON.stringify(screenFile)};
await openScreen(${JSON.stringify(agents)}, ${JSON.stringify(session)}, "lead", "simon/app");
await Bun.write(${JSON.stringify(join(home, `left-${window}`))}, "left");`,
  );
  const named = `${where ? `SKELCREW_REMOTE_NAME=${where} ` : ""}${given.before}`;
  const title = `printf '\\033]2;my shell\\007'`;
  // The footer shows a fixed load, so a quiet screen writes nothing at all. `before` comes after
  // it, so a test can set it empty to see the machine's own.
  const load = `SKELCREW_FIXED_LOAD='${fixedLoad}' `;
  const command = `${title}; ${load}${named}TERM=${term} ${process.execPath} ${script}; sleep 300`;
  const start = ["new-session", "-d", "-s", window, "-x", width, "-y", "30", command];
  // The terminal must already send extended keys when the screen asks for them, as tmux ignores
  // a request it got while they were off.
  const extended = given.extendedKeys ? [";", "set", "-s", "extended-keys", "on"] : [];
  tmux(terminal, ...start, ...extended);
}

// Presses keys in a terminal. Text goes as it would from a real one, including escape codes.
export const type = (text: string, window = "one") =>
  tmux(terminal, "send-keys", "-t", `=${window}:`, "-l", text);
export const press = (key: string, window = "one") =>
  tmux(terminal, "send-keys", "-t", `=${window}:`, key);
// A press and release of the left button at a place on screen, counted from 1.
export const click = (x: number, y: number) => type(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);

export function sql(statements: string): void {
  const script = `import { openDb } from ${JSON.stringify(dbFile)};
openDb().run(${JSON.stringify(statements)});`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
}

// Gives a test a home of its own and its own tmux servers, with app's lead and two threads
// running. Every screen test file runs it before each test.
export function startTest(): void {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-screen-test-")));
  given.before = "";
  given.extendedKeys = false;
  given.mergeAnswer = { merged: "Merged app#35." };
  agents = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  screen = `${agents}-screen`;
  terminal = `${agents}-terminal`;
  // app's lead is the one Skelcrew kept from before, as its session is named lead. It has started,
  // so its row names its harness.
  // The fake plugin is app's tracker and forge, so its tasks have issues and PRs.
  fakePlugin(home);
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: github\n");
  sql(`INSERT INTO repositories (name, owner, repo, kept_lead, lead_session, forge)
  VALUES ('app', 'simon', 'app', 1, 's', 'github');
${threadSql({ task: "3", status: "done" })}
${threadSql({ task: "7" })}
${threadSql({ task: "12" })}`);
  agent("lead");
  agent("app-7");
  agent("app-12");
}

// Ends what a test started: the stand-in daemon, the tmux servers and the test's home. Every
// screen test file runs it after each test, one that failed or timed out included. It returns
// once every process the servers' panes ran has exited, such as the sidebar and a host's attach.
// tmux only hangs up on them as its server ends, and on a busy machine they could still be
// exiting when the check for leftover processes looks. One still running after 15 seconds fails
// the test, and is killed.
export async function endTest(): Promise<void> {
  standIn?.close();
  standIn = null;
  asked.length = 0;
  acted.length = 0;
  release();
  // Each server is ended, and the home removed, even when a tmux command hangs, so one stuck
  // server leaves nothing else behind. The first failure is thrown once all is done.
  const failures: unknown[] = [];
  const tree: number[] = [];
  for (const socket of [terminal, screen, agents]) {
    // A server's panes' processes are found before it goes, as nothing names them after.
    const panes: number[] = [];
    let hung = false;
    try {
      const listed = tmux(socket, "list-panes", "-a", "-F", "#{pane_pid}").out;
      for (const pid of listed.split("\n").filter(Boolean)) panes.push(...processTree(Number(pid)));
    } catch (error) {
      failures.push(error);
      hung = true;
    }
    tree.push(...panes);
    try {
      tmux(socket, "kill-server");
    } catch (error) {
      failures.push(error);
      hung = true;
    }
    // A server that doesn't answer is killed, with every process under it, before its socket
    // goes, as nothing could reach it after. It runs as the command that started it, with the
    // test's own socket after -L, so the match finds only this test's server and clients. Its
    // panes' processes are found under it, as list-panes may be what hung, and they would ignore
    // the server's end if they ignore its hangup. They are waited for below like the rest.
    if (hung) {
      const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,args="], { stdout: "pipe" });
      const ours = ps.stdout
        .toString()
        .split("\n")
        .filter((line) => ` ${line} `.includes(` -L ${socket} `))
        .map((line) => Number(line.trim().split(/\s+/)[0]))
        // A pid of 0 would signal the test run's own process group.
        .filter((pid) => pid > 0)
        .flatMap((pid) => processTree(pid));
      tree.push(...ours);
      for (const pid of [...ours, ...panes])
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
    }
    // tmux leaves the socket file behind after kill-server.
    const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    rmSync(join(folder, socket), { force: true });
  }
  // One still running at the deadline fails the test, and is killed so it can't reach the next.
  await wait(() => stillRunning(tree).length === 0, {
    timeout: 15_000,
    what: () => `the screen's panes to end: ${stillRunning(tree).join(" ")}`,
  }).catch((error) => {
    failures.push(error);
    for (const pid of stillRunning(tree))
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
  });
  rmSync(home, { recursive: true, force: true });
  if (failures.length > 0) throw failures[0];
}

// Returns whether the right side shows a task's details, which have a line with its stage and
// word, such as `Building · working`.
export const onDetails = () =>
  /^\s*(Up next|Backlog|Building|Reviewing|Checks|Ready|Done)( · .*)?$/m.test(right());

// Presses Enter on the task you are on, once its details show, as only then does your typing go
// to the sidebar, and waits until its builder takes the right side, named by its row.
export async function attachTo(name: string): Promise<void> {
  await until(onDetails, `the details of ${name}`);
  press("Enter");
  await until(() => !onDetails() && seen().includes(`I am ${name}`), `${name} attached`);
}

// Moves from the lead to the first task under Building, app-12, or to the one after it, app-7,
// and attaches to its builder, so what you type reaches it.
export async function toFirstThread(): Promise<void> {
  press("M-S-Down");
  await attachTo("app-12");
}
export async function toSecondThread(): Promise<void> {
  press("M-S-Down");
  press("M-Down");
  await attachTo("app-7");
}

// Returns whether the row you are on is the lead's, which alone starts with its mark and lead.
export const onLead = (window = "one") => /^[▸▹] \S lead\b/.test(selected(window));

// Waits until the screen shows the agent you opened it on, and the sidebar has drawn, on the
// lead's row, where the screen starts whichever agent it opened on.
export const ready = (name: string, window = "one") =>
  until(() => seen(window).includes(`I am ${name}`) && onLead(window), "the screen", window);

// A column of the terminal over the agent's 21st, past the sidebar and the border beside it.
export const agentColumn = sidebar + 22;

// The wheel, as a terminal sends it, turned up or down over the agent.
export const wheel = (button: 64 | 65) => type(`\x1b[<${button};${agentColumn};5M`);

export const scrolledBack = () => tmux(agents, "list-panes", "-a", "-F", "#{pane_in_mode}").out;

// The bottom row as you see it, across the whole screen, without the load at its right end. A
// screen fewer than 30 rows high names its own last row.
export const footer = (row = 29) =>
  (seen().split("\n")[row] ?? "").replace(/ +cpu \d+% {2}mem [\d.]+\/\d+G *$/, "").trimEnd();

// Stands in for the daemon on the test's own socket: it logs each repository asked to open,
// saying when a tab asked, which must never open a tab you closed, and answers with nothing to
// say.
// It also logs each thread started, PR merged and request of the lead's answered, in `acted`, answering a merge with
// `given.mergeAnswer`. While `given.holding`, those wait for `release`, so a test sees what the screen says
// meanwhile.
export const asked: string[] = [];
export const acted: string[] = [];
const waiting: (() => void)[] = [];
export const release = () => {
  given.holding = false;
  for (const reply of waiting.splice(0)) reply();
};
export function daemon(): void {
  const answer = (connection: Socket) =>
    connection.on("data", (data) => {
      const { command, from, tab, repo, task, pr, commit, by, id, yes, now } = z
        .object({
          command: z.string(),
          from: z.string().default(""),
          tab: z.boolean().default(false),
          repo: z.string().default(""),
          task: z.string().default(""),
          pr: z.number().default(0),
          commit: z.string().default(""),
          by: z.number().default(0),
          id: z.number().default(0),
          yes: z.boolean().default(false),
          now: z.boolean().default(false),
        })
        .parse(JSON.parse(data.toString()));
      if (command === "lead") asked.push(`open ${from}${tab ? " from a tab" : ""}`);
      if (command === "answer") {
        acted.push(`answer ${repo} ${id} ${yes ? "yes" : "no"}`);
        connection.end(
          `${JSON.stringify({ said: yes ? "Started APP-31." : "Told the lead no." })}\n`,
        );
        return;
      }
      if (command === "queue move") {
        acted.push(`queue move ${repo} ${task} ${by}`);
        connection.end(`${JSON.stringify({ said: `APP-${task} starts next` })}\n`);
        return;
      }
      if (command !== "start" && command !== "merge") {
        connection.end("{}\n");
        return;
      }
      acted.push(
        command === "start"
          ? `start ${repo} ${task}${now ? " now" : ""}`
          : `merge ${repo} ${pr} ${commit}`,
      );
      const said = command === "start" ? { started: `Started app-${task}.` } : given.mergeAnswer;
      const reply = () => connection.end(`${JSON.stringify(said)}\n`);
      if (given.holding) waiting.push(reply);
      else reply();
    });
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  standIn = createServer(answer).listen(join(home, "run", "skelcrew.sock"));
}

// What the right side shows, without the sidebar.
export const right = () =>
  seen()
    .split("\n")
    .map((line) => line.slice(sidebarNow() + 1))
    .join("\n");
