// The list that sc shows: its rows, read from a database of the test's own, and the list itself in
// a terminal, on tmux servers of the test's own. One holds the agents, and a second stands in for
// your terminal, so a test can press keys and read what you see.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Labels, startSession } from "../src/agents/sessions.ts";
import { drawList } from "../src/screen/layout.ts";
import type { Row } from "../src/screen/rows.ts";
import { fakePlugin, itemSql, read, source, threadSql, until as wait } from "./harness.ts";

// Longer than the waits below, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
let home = "";
let agents = "";
let terminal = "";
let standIn: Server | null = null;
// What the stand-in daemon was asked, as one line each.
const asked: string[] = [];

const env = () => ({ ...process.env, HOME: home, XDG_RUNTIME_DIR: join(home, "run") });

// Runs SQL on the test's database, in a process of its own: homedir() keeps the HOME this
// process started with, so opening the database from here would reach your real one.
function sql(statements: string): void {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run(${JSON.stringify(statements)});`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
}

// app has the fake plugin as its tracker and forge, and its lead is the one Skelcrew kept from
// before, so its session is named lead. site is a second repository, with a thread that needs
// you. In app: issue 31 has no thread, app-7 works, app-12 asks a question, app-9 stopped, and
// app-14 is approved and green on PR 41, ready for review.
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-list-test-")));
  agents = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  terminal = `${agents}-terminal`;
  fakePlugin(home);
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: github\n");
  sql(`INSERT INTO repositories (name, owner, repo, kept_lead, lead_session, lead_harness, forge)
  VALUES ('app', 'simon', 'app', 1, 's', 'claude', 'github');
INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site');
${itemSql("app", "task", 31, "Export as CSV", "2026-11-05T10:00:00Z")}
${itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", { head: "abc123" })}
${threadSql({ task: "7", title: "Login redirect", harness: "claude", started: Date.now() - 300_000 })}
${threadSql({ task: "12", title: "Rate limit the API", harness: "codex", asking: 1, needs_you: 1 })}
${threadSql({ task: "9", title: "Old work", status: "stopped" })}
${threadSql({ task: "14", title: "Fix the export header", status: "waiting", needs_you: 1, verdict: "approve", checks: "passing", pr: 41, review_round: 1 })}
${threadSql({ repo: "site", task: "3", title: "Docs", asking: 1, needs_you: 1 })}`);
});
afterEach(() => {
  standIn?.close();
  standIn = null;
  asked.length = 0;
  for (const socket of [terminal, agents]) {
    Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "ignore" });
    // tmux leaves the socket file behind after kill-server.
    const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    rmSync(join(folder, socket), { force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

// Returns app's rows as the list reads them, with `running` naming the sessions that run.
function rows(running: string[] = []): Row[] {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { listRows } from ${JSON.stringify(source("screen/rows.ts"))};
console.log(JSON.stringify(listRows(openDb(), { owner: "simon", repo: "app" }, ${JSON.stringify(running)}, Date.now())));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

test("the lead comes first, then issues, then working tasks with those that need you first, then those ready for review", () => {
  const shown = rows().map((row) => [row.part, row.name, row.title, row.says]);
  expect(shown).toEqual([
    ["lead", "lead", "", "stopped · claude"],
    ["issue", "app-31", "Export as CSV", ""],
    ["working", "app-12", "Rate limit the API", "needs you: question · codex"],
    ["working", "app-9", "Old work", "stopped · claude"],
    ["working", "app-7", "Login redirect", "working · claude · 5m"],
    ["ready", "app-14", "Fix the export header", "#41 · approved · CI passed"],
  ]);
});

test("an issue whose work ended is back under Issues, to start again", () => {
  sql("UPDATE threads SET status = 'done' WHERE folder = 'app-7';");
  sql(itemSql("app", "task", 7, "Login redirect", "2026-11-01T10:00:00Z"));
  expect(
    rows()
      .filter((row) => row.part === "issue")
      .map((row) => row.name),
  ).toEqual(["app-31", "app-7"]);
});

test("Enter asks to start an issue, and m to merge a ready task at the commit you saw", () => {
  const [issue] = rows().filter((row) => row.part === "issue");
  expect(issue?.start).toEqual({
    ask: "Start app-31? y/n",
    working: "Starting app-31…",
    request: { command: "start", repo: "simon/app", task: "31" },
  });
  const [ready] = rows().filter((row) => row.part === "ready");
  expect(ready?.merge).toEqual({
    ask: "Merge app#41 into main? y/n",
    working: "Merging app#41…",
    request: { command: "merge", repo: "simon/app", pr: 41, commit: "abc123" },
  });
  expect(ready?.link).toBe("https://github.com/simon/app/pull/41");
  // A working task has nothing to merge.
  expect(rows().find((row) => row.name === "app-7")?.merge).toBeNull();
});

test("a ready task whose forge sent no head commit can't be merged here, and says why", () => {
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z"));
  expect(rows().find((row) => row.name === "app-14")?.merge).toEqual({
    refused: "app#41 needs a newer forge plugin to merge here: run sc plugin update",
  });
});

test("a row knows whether its agent runs, and the lead says what its hooks last said", () => {
  sql("UPDATE repositories SET lead_state = 'asking' WHERE repo = 'app';");
  const running = rows(["lead", "app-7"]);
  expect(running.find((row) => row.name === "lead")).toMatchObject({
    says: "asks you · claude",
    colour: "yellow",
    running: true,
  });
  expect(running.find((row) => row.name === "app-7")?.running).toBe(true);
  expect(running.find((row) => row.name === "app-12")?.running).toBe(false);
});

// The list as drawn, given its rows, at 80 columns and 20 lines.
const frame = {
  version: "0.6.0",
  where: "",
  name: "app",
  tabs: [
    { name: "app", fullName: "simon/app", needYou: 1, colour: "yellow" as const, ready: 1 },
    { name: "site", fullName: "simon/site", needYou: 1, colour: "yellow" as const, ready: 0 },
  ],
  notice: "",
  bottom: "↑↓ move  ⏎ open  q quit",
  load: "cpu 12%",
};
const drawn = (here: number, height = 20, width = 80) =>
  drawList(rows(), here, 0, frame, { width, height }).lines.map((line) => Bun.stripANSI(line));

test("each part has its heading, the row you are on has ▸, and every line fits", () => {
  const lines = drawn(2);
  expect(lines[0]).toBe(` Skelcrew v0.6.0 · app${" ".repeat(50)}site •1 `);
  const headings = lines.filter((line) => /^ [A-Z]\w/.test(line) && !line.includes("Skelcrew"));
  expect(headings.map((line) => line.trim())).toEqual(["Issues", "Working", "Ready for review"]);
  // The bottom line has the keys, and the load at its right end.
  expect(lines.at(-1)).toBe(` ↑↓ move  ⏎ open  q quit${" ".repeat(48)}cpu 12% `);
  expect(lines.filter((line) => line.includes("▸"))).toEqual([
    expect.stringMatching(/^ ▸ ● app-12 +Rate limit the API +needs you: question · codex$/),
  ]);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(lines).toHaveLength(20);
});

test("a list taller than the terminal scrolls to keep the row you are on in view", () => {
  const lines = drawn(5, 8);
  expect(lines).toHaveLength(8);
  expect(lines.some((line) => line.includes("▸ ● app-14"))).toBe(true);
});

// Stands in for the daemon on the test's own socket: it logs each request and answers a start or
// a merge as the daemon would.
function daemon(): void {
  const Request = z.object({
    command: z.string(),
    from: z.string().default(""),
    tab: z.boolean().default(false),
    repo: z.string().default(""),
    task: z.string().default(""),
    pr: z.number().default(0),
    commit: z.string().default(""),
  });
  standIn = createServer((connection) =>
    connection.on("data", (data) => {
      const { command, from, tab, repo, task, pr, commit } = Request.parse(
        JSON.parse(data.toString()),
      );
      if (command === "lead") asked.push(`open ${from}${tab ? " from a tab" : ""}`);
      if (command === "start") asked.push(`start ${repo} ${task}`);
      if (command === "merge") asked.push(`merge ${repo} ${pr} ${commit}`);
      const said = command === "start" ? { started: "Started." } : { merged: "Merged." };
      connection.end(`${JSON.stringify(command === "lead" ? {} : said)}\n`);
    }),
  );
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  standIn.listen(join(home, "run", "skelcrew.sock"));
}

// Starts an agent that says its name and logs each line you type into it.
function agent(name: string, labels: Labels): void {
  const script = join(home, `${name}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
cd ${JSON.stringify(home)}
echo "I am ${name}"
while test -d ${JSON.stringify(home)}; do read -r line && echo "$line" >> ${name}.typed; done
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH ?? "";
  startSession(agents, name, { folder: home, command: [script], env: { PATH: path }, labels });
}

// Runs tmux on the test's terminal.
const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-L", terminal, "-f", "/dev/null", ...args], {
    env: { ...env(), TMUX: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
// What you see in the terminal.
const seen = () => tmux("capture-pane", "-p", "-t", "=one:").stdout.toString();
// The row you are on, as the line with ▸ shows it.
const here = () =>
  seen()
    .split("\n")
    .find((line) => line.includes("▸"))
    ?.trim() ?? "";
const until = (done: () => boolean, what: string) =>
  wait(done, { every: 30, what: () => `${what}:\n${seen()}` });
// Presses a key in the terminal, as tmux names it, or types text with `literal`.
const press = (key: string) => tmux("send-keys", "-t", "=one:", key);
const type = (text: string) => tmux("send-keys", "-t", "=one:", "-l", text);

// Opens the list of app in a terminal of its own, 100 columns wide, with the agents app-7,
// app-12 and the lead running. The terminal logs when the list returned.
async function open(): Promise<void> {
  daemon();
  agent("lead", { repository: "simon/app", role: "lead" });
  agent("app-7", { repository: "simon/app", role: "builder", task: "app-7" });
  agent("app-12", { repository: "simon/app", role: "builder", task: "app-12" });
  const script = join(home, "open.ts");
  writeFileSync(
    script,
    `import { runList } from ${JSON.stringify(source("screen/list.ts"))};
await runList(${JSON.stringify(agents)}, "simon/app");
await Bun.write(${JSON.stringify(join(home, "left"))}, "left");
process.exit(0);`,
  );
  const vars = `HOME=${home} XDG_RUNTIME_DIR=${join(home, "run")} SKELCREW_FIXED_LOAD='cpu 12%'`;
  const command = `${vars} TERM=xterm-256color ${process.execPath} ${script}; sleep 300`;
  tmux("new-session", "-d", "-s", "one", "-x", "100", "-y", "24", command);
  await until(() => seen().includes("q quit"), "the list");
}

test("the list opens on the first task that needs you, and q leaves it with every agent running", async () => {
  await open();
  expect(seen()).toContain(" Skelcrew v");
  expect(seen()).toContain("site •1");
  expect(here()).toStartWith("▸ ● app-12");
  type("q");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
  const sessions = Bun.spawnSync(["tmux", "-L", agents, "list-sessions", "-F", "#S"]);
  expect(sessions.stdout.toString().trim().split("\n").sort()).toEqual(["app-12", "app-7", "lead"]);
});

test("Enter attaches to the builder, every key reaches it, and Alt-Q comes back on the same row", async () => {
  await open();
  press("Down");
  press("Down");
  await until(() => here().startsWith("▸ ○ app-7"), "app-7's row");
  press("Enter");
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  // q and m are the list's keys, but the agent has the keyboard now.
  type("q m hello");
  press("Enter");
  await until(() => read(join(home, "app-7.typed")) === "q m hello\n", "what was typed");
  press("M-q");
  await until(() => seen().includes("q quit"), "the list again");
  expect(here()).toStartWith("▸ ○ app-7");
  expect(read(join(home, "left"))).toBe("");
});

test("Enter on the lead attaches to it", async () => {
  await open();
  for (const _ of [1, 2, 3]) press("Up");
  await until(() => here().startsWith("▸ ◆ lead"), "the lead's row");
  press("Enter");
  await until(() => seen().includes("I am lead"), "the lead");
  press("M-q");
  await until(() => here().startsWith("▸ ◆ lead"), "the list on the lead's row");
});

test("Enter on a builder that isn't running says so, and attaches to nothing", async () => {
  await open();
  press("Down");
  await until(() => here().startsWith("▸ ○ app-9"), "app-9's row");
  press("Enter");
  await until(
    () => seen().includes("app-9's builder isn't running: sc start app-9 brings it back"),
    "why it can't attach",
  );
});

test("Enter on an issue asks first: any key but y starts nothing, and y starts it", async () => {
  await open();
  press("Up");
  await until(() => here().startsWith("▸ ○ app-31"), "the issue's row");
  press("Enter");
  await until(() => seen().includes("Start app-31? y/n"), "the question");
  type("n");
  await until(() => seen().includes("q quit"), "the keys again");
  expect(asked.filter((line) => line.startsWith("start"))).toEqual([]);
  press("Enter");
  await until(() => seen().includes("Start app-31? y/n"), "the question again");
  type("y");
  await until(() => asked.includes("start simon/app 31"), "the start");
});

test("m on a task ready for review asks first, and y merges it at the commit you saw", async () => {
  await open();
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ● app-14"), "the ready row");
  expect(seen()).toContain("m merge");
  type("m");
  await until(() => seen().includes("Merge app#41 into main? y/n"), "the question");
  type("y");
  await until(() => asked.includes("merge simon/app 41 abc123"), "the merge");
});

test("Tab moves to the next repository and has the daemon open it, without reopening a closed tab", async () => {
  await open();
  press("Tab");
  await until(() => seen().includes("· site"), "site's list");
  expect(seen()).toContain("site-3");
  await until(() => asked.includes("open simon/site from a tab"), "site opened");
});
