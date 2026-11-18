// Lists and pages that follow Skelcrew's copy as it changes, and what the screen writes to
// your terminal while nothing changes.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stillRunning } from "../src/agents/sessions.ts";
import { itemSql, threadSql } from "./harness.ts";
import {
  agent,
  agents,
  clickRow,
  endTest,
  given,
  home,
  issueUrl,
  leaving,
  listsRunning,
  onRight,
  open,
  openIssue,
  openList,
  openOnGitHub,
  press,
  read,
  ready,
  right,
  screen,
  seen,
  sidebar,
  sql,
  startTest,
  terminal,
  tmux,
  until,
  wheel,
} from "./screen.ts";

// Longer than the screen's waits, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
beforeEach(startTest);
afterEach(endTest);

// Has tmux copy what the screen writes to your terminal into a file, and gives back the file,
// empty, once the screen has settled. The sidebar takes in what just changed, such as a page
// opening, at its next refresh, and tmux redraws its border after that. On a busy machine that
// can come after half a second of quiet. So the screen has settled once the sidebar has
// refreshed twice from now, and then nothing was written for half a second. The test must call
// noteRefreshes first.
async function copyOnceSettled(): Promise<string> {
  const written = join(home, "written");
  tmux(terminal, "pipe-pane", "-O", "-t", "=one:", `cat >> ${written}`);
  await sidebarRefreshedTwice();
  await untilQuiet(written);
  // Emptied rather than removed: tmux's cat keeps writing to the file it opened, and adds to its
  // end.
  writeFileSync(written, "");
  return written;
}

// Returns once the copy of what the screen writes has grown by nothing for half a second.
async function untilQuiet(written: string): Promise<void> {
  const size = () => (existsSync(written) ? statSync(written).size : 0);
  let last = size();
  let quietSince = Date.now();
  // A screen still writing after five seconds never settles, and fails the test.
  const deadline = Date.now() + 5000;
  while (Date.now() - quietSince < 500) {
    if (Date.now() > deadline) throw new Error("the screen kept writing for five seconds");
    await Bun.sleep(50);
    if (size() === last) continue;
    last = size();
    quietSince = Date.now();
  }
}

// Puts a tmux in front of the real one that notes each time the sidebar asks for the agents'
// panes, as it does first in every refresh. A refresh that changes nothing writes nothing, so
// this is how a test sees one. It must be set before the screen opens.
function noteRefreshes(): void {
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
async function sidebarRefreshedTwice(): Promise<void> {
  const before = refreshesStarted();
  await until(() => refreshesStarted() >= before + 2, "the sidebar to refresh twice");
}

// Returns once the list and the sidebar have each read Skelcrew's copy again at least once. The
// list does so each second, but when nothing changed it writes nothing and asks tmux nothing,
// so nothing shows that it did: two seconds see it do so twice. The sidebar's refreshes in that
// time show that the screen wasn't held up meanwhile.
async function twoRefreshes(): Promise<void> {
  const before = refreshesStarted();
  await Bun.sleep(2000);
  await until(() => refreshesStarted() >= before + 2, "the sidebar to refresh twice");
}

test("a list or page left open writes nothing", async () => {
  noteRefreshes();
  sql("UPDATE threads SET status = 'waiting', changed = 0 WHERE status = 'working'");
  await openList("Threads");
  const written = await copyOnceSettled();
  await twoRefreshes();
  expect(readFileSync(written, "utf8")).toBe("");
  clickRow("Issues");
  await onRight("Not started");
  press("Enter");
  await onRight("line 1 of the description");
  await copyOnceSettled();
  await twoRefreshes();
  expect(readFileSync(written, "utf8")).toBe("");
});

test("a list follows Skelcrew's copy as it changes", async () => {
  await openList("Issues");
  sql(itemSql("app", "task", 40, "A new issue", "2026-11-06T10:00:00Z"));
  await onRight("A new issue");
  await until(() => /Issues +3/.test(seen()), "the count");
});

test("a row that moves out of view as the list changes is scrolled back into view", async () => {
  const many = Array.from({ length: 40 }, (_, n) =>
    itemSql(
      "app",
      "task",
      100 + n,
      `Issue ${100 + n}`,
      `2026-11-06T10:${String(n).padStart(2, "0")}:00Z`,
    ),
  );
  sql(many.join("\n"));
  await openList("Issues");
  await onRight("app-139");
  // The issue you are on gets a thread, which moves it under Started, far below.
  sql(threadSql({ task: "139" }));
  await until(() => right().includes("Started") && right().includes("app-139"), "the row in view");
  press("Enter");
  await onRight("← back");
  expect(right()).toContain("Issue 139");
});

test("a list scrolled with the wheel stays where you put it as it reads the copy again", async () => {
  const many = Array.from({ length: 40 }, (_, n) =>
    itemSql(
      "app",
      "task",
      100 + n,
      `Issue ${100 + n}`,
      `2026-11-06T10:${String(n).padStart(2, "0")}:00Z`,
    ),
  );
  sql(many.join("\n"));
  noteRefreshes();
  await openList("Issues");
  for (let i = 0; i < 4; i++) wheel(65);
  // Four notches reach the list's end, where app-124 is the first issue. The first notch alone
  // already hides app-139, and the last moves fewer lines, so the wait is for the end.
  await until(() => !right().includes("app-125"), "the list to scroll to its end");
  const scrolled = right();
  await twoRefreshes();
  expect(right()).toBe(scrolled);
});

// Returns the process running the right pane, which is the list while one shows.
const rightPane = () =>
  tmux(screen, "list-panes", "-a", "-F", "#{pane_pid}").out.trim().split("\n").at(-1);

test("clicking the entry of the list you are on doesn't start it again", async () => {
  await openList("Issues");
  const list = rightPane();
  clickRow("Issues");
  await Bun.sleep(300);
  expect(rightPane()).toBe(list);
});

test("a page Skelcrew's copy no longer has says so, and you can still move on", async () => {
  await openList("Issues");
  sql("DELETE FROM items WHERE id = '31'");
  press("Enter");
  await onRight("Skelcrew has no open issue or PR at this link now");
  expect(seen()).toContain(`GitHub  ${issueUrl}`);
  press("M-S-Down");
  await until(() => seen().includes("I am app-12"), "the thread");
});

test("a page follows a resize, and the sidebar stays as wide", async () => {
  await openIssue();
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "80", "-y", "24");
  await until(() => seen().split("\n").length <= 25, "the terminal");
  await onRight("line 1 of the description");
  expect(tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out).toContain(`${sidebar}\n`);
});

test("the wheel over an agent still scrolls it after a list came and went", async () => {
  openOnGitHub();
  agent("app-5", "seq 1 200");
  sql(threadSql({ task: "5" }));
  open("app-5");
  await ready("app-5");
  clickRow("Issues");
  await onRight("Not started");
  clickRow("app-5");
  await until(() => seen().includes("I am app-5"), "the agent");
  wheel(64);
  await until(() => !seen().includes("I am app-5"), "the agent's history");
});

test("Ctrl-Q leaves from a page, and no list is left running", async () => {
  await openIssue();
  expect(listsRunning()).toBe(1);
  const panes = tmux(screen, "list-panes", "-a", "-F", "#{pane_pid}").out.trim().split("\n");
  press("C-q");
  await until(() => seen().includes(leaving), "Skelcrew to say goodbye");
  await until(() => stillRunning(panes.map(Number)).length === 0, "the panes' processes to end");
});

test("leaving a list for an agent ends the list, and no client is left behind it", async () => {
  await openIssue();
  press("M-S-Up");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => listsRunning() === 0, "the list to end");
  expect(tmux(agents, "list-clients").out.trim().split("\n")).toHaveLength(1);
});

test("two terminals can each be on a list of their own", async () => {
  await openIssue();
  open("lead", "two");
  await ready("lead", "two");
  expect(seen("two")).toContain("I am lead");
  expect(right()).toContain("line 1 of the description");
});

test("with nothing working, an open screen sends your terminal nothing at all", async () => {
  noteRefreshes();
  sql(`UPDATE threads SET status = 'waiting', started = ${Date.now()} WHERE status = 'working'`);
  open("lead");
  await ready("lead");
  await until(() => seen().includes("checks · claude"), "the threads");
  const written = await copyOnceSettled();
  // The threads started three seconds short of a minute ago, so a time shown on a row would change
  // during the wait. The sidebar must read that before the minute, so a busy machine that
  // refreshed only after it tries again with a minute further on.
  let minute = 0;
  for (let tries = 0; tries < 5 && Date.now() >= minute; tries++) {
    minute = Date.now() + 3000;
    sql(`UPDATE threads SET started = ${minute - 60_000} WHERE status = 'waiting'`);
    await sidebarRefreshedTwice();
  }
  expect(Date.now()).toBeLessThan(minute);
  // Past the minute, the sidebar reads the threads again and draws what it read. A time it drew
  // reaches the copy a moment later.
  await Bun.sleep(minute - Date.now());
  await sidebarRefreshedTwice();
  await untilQuiet(written);
  expect(readFileSync(written, "utf8")).toBe("");
  const rows = seen().split("\n");
  const row = rows.findIndex((line) => line.includes("app-12"));
  expect(rows[row + 1]?.split("│")[0]?.trim()).toBe("checks · claude");
}, 60_000);

test("a working thread's time moves on by itself, and writes when it does", async () => {
  sql(`UPDATE threads SET started = ${Date.now() - 58_000} WHERE folder = 'app-12'`);
  open("lead");
  await ready("lead");
  await until(() => seen().includes("claude · <1m"), "the time to start");
  const written = join(home, "written");
  tmux(terminal, "pipe-pane", "-O", "-t", "=one:", `cat >> ${written}`);
  await until(() => seen().includes("claude · 1m"), "the time to move on");
  await until(() => existsSync(written) && readFileSync(written, "utf8") !== "", "the write");
});
