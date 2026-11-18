// Lists and pages that follow Skelcrew's copy as it changes, and what the screen writes to
// your terminal while nothing changes.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stillRunning } from "../src/agents/sessions.ts";
import { itemSql, threadSql } from "./harness.ts";
import {
  agent,
  agents,
  clickRow,
  endTest,
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
// empty, once the screen has settled. tmux redraws a pane's border a moment after the pane
// opens, so the screen has settled once it has written nothing for half a second.
async function copyOnceSettled(): Promise<string> {
  const written = join(home, "written");
  tmux(terminal, "pipe-pane", "-O", "-t", "=one:", `cat >> ${written}`);
  const size = () => (existsSync(written) ? statSync(written).size : 0);
  let last = size();
  let quietSince = Date.now();
  // A screen that never settles fails the test once the copy starts, as it writes there too.
  const deadline = Date.now() + 5000;
  while (Date.now() - quietSince < 500 && Date.now() < deadline) {
    await Bun.sleep(50);
    if (size() === last) continue;
    last = size();
    quietSince = Date.now();
  }
  // Emptied rather than removed: tmux's cat keeps writing to the file it opened, and adds to its
  // end.
  writeFileSync(written, "");
  return written;
}

// The list and the sidebar read Skelcrew's copy again each second, so two seconds see each of
// them do it at least once.
const twoRefreshes = () => Bun.sleep(2000);

test("a list or page left open writes nothing", async () => {
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
  sql(`UPDATE threads SET status = 'waiting', started = ${Date.now()} WHERE status = 'working'`);
  open("lead");
  await ready("lead");
  await until(() => seen().includes("checks · claude"), "the threads");
  const written = await copyOnceSettled();
  // Half a second short of a minute, so a time shown on any row would change during the wait.
  // Under a minute, such a time would show the same either way, so this alone writes nothing.
  sql(`UPDATE threads SET started = ${Date.now() - 59_500} WHERE status = 'waiting'`);
  await twoRefreshes();
  expect(readFileSync(written, "utf8")).toBe("");
});

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
