// Starting a thread on an issue and merging a PR from the screen's lists and pages, and
// opening a page's link.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { itemSql, threadSql } from "./harness.ts";
import {
  acted,
  click,
  clickListRow,
  clickRow,
  daemon,
  endTest,
  footer,
  given,
  home,
  issueUrl,
  listKeys,
  listsRunning,
  onRight,
  open,
  openIssue,
  openList,
  openOnGitHub,
  press,
  read,
  ready,
  release,
  right,
  seen,
  sidebar,
  sql,
  startKeys,
  startTest,
  tabRow,
  terminal,
  tmux,
  type,
  until,
} from "./screen.ts";

// Longer than the screen's waits, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
beforeEach(startTest);
afterEach(endTest);

// What the footer says, as you see it: a line in place of its keys, or its keys back.
const says = (text: string) =>
  until(
    () => footer() === (text.startsWith("  ") ? text : `  ${text}`),
    `the footer to say ${text}`,
  );

// What the footer says under a list or page on a PR that can be merged.
const mergeKeys = `${listKeys}  m merge`;

test("s on an issue asks first, any key but y leaves it be, and y starts a thread on it", async () => {
  daemon();
  await openList("Issues");
  await says(startKeys);
  type("s");
  await says("Start a thread on app#31? y/n");
  type("n");
  await says(startKeys);
  // The key that left it be does nothing else: the list stays on its row.
  type("s");
  await says("Start a thread on app#31? y/n");
  press("Down");
  await says(startKeys);
  expect(acted).toEqual([]);
  type("s");
  await says("Start a thread on app#31? y/n");
  given.holding = true;
  type("y");
  await says("Starting app-31…");
  // The line changes as the request goes out, so it can show before the daemon has it.
  await until(() => acted.length === 1, "the start");
  expect(acted).toEqual(["start simon/app 31"]);
  release();
  await says(startKeys);
});

test("s on an issue a thread works on says which thread, until the next key", async () => {
  daemon();
  await openList("Issues");
  press("Down");
  type("s");
  await says("app#12 already has app-12");
  // The next key does what it does, and the footer's keys come back, with no s on this issue.
  press("Enter");
  await says(listKeys);
  await onRight("← back");
  expect(right()).toContain("Fix login");
  expect(acted).toEqual([]);
});

test("s on an issue's page starts a thread on that issue", async () => {
  daemon();
  await openIssue();
  type("s");
  await says("Start a thread on app#31? y/n");
  type("y");
  await until(() => acted.length === 1, "the start");
  expect(acted).toEqual(["start simon/app 31"]);
  await says(startKeys);
});

// A PR approved with its checks passing, which the forge last sent at a head commit. A poll
// found its changes there leave .agents/ alone.
const readyPr = (id = 35, created = "2026-11-06T10:00:00Z") =>
  sql(
    `INSERT OR REPLACE INTO pr_agents (owner, repo, pr, head, changed)
      VALUES ('simon', 'app', '${id}', '${"c".repeat(40)}', 0);
${itemSql("app", "pr", id, `Add export ${id}`, created, {
  head: "c".repeat(40),
  checks: [{ name: "test", id: "1", state: "passed" }],
  reviews: [
    {
      id: "1",
      text: "Fine.",
      author: { login: "ana", bot: false, you: false },
      verdict: "approved",
      lines: [],
    },
  ],
})}`,
  );

// The forge's reason comes from outside, so it is shown as written: never read as tmux's
// format, which would restyle the row, run a command, or cut it at the comma.
test("m on a ready PR asks first, y merges it at the commit you saw, and a refusal says why", async () => {
  daemon();
  readyPr();
  await openList("PRs");
  await onRight("Ready to merge");
  type("m");
  await says("Merge app#35 into main? y/n");
  given.holding = true;
  given.mergeAnswer = { error: "Blocked, by rule #[fg=red]2 #{pane_index} {main} 100%" };
  type("y");
  await says("Merging app#35…");
  await until(() => acted.length === 1, "the merge");
  expect(acted).toEqual([`merge simon/app 35 ${"c".repeat(40)}`]);
  release();
  await says("Blocked, by rule #[fg=red]2 #{pane_index} {main} 100%");
  // app#34 isn't ready, so the footer has no m on it.
  press("Down");
  await says(listKeys);
  given.mergeAnswer = { merged: "Merged app#35." };
  press("Up");
  type("m");
  await says("Merge app#35 into main? y/n");
  type("y");
  await until(() => acted.length === 2, "the second merge");
  await says(mergeKeys);
});

// A page is read once, but what s and m do follows Skelcrew's copy as it changes meanwhile.
test("m on a PR's page asks to merge once the PR became ready while the page was open", async () => {
  daemon();
  sql(itemSql("app", "pr", 35, "Add export", "2026-11-06T10:00:00Z", { head: "c".repeat(40) }));
  await openList("PRs");
  await onRight("app#35");
  press("Enter");
  await until(() => tabRow().includes("app#35"), "the PR's strip");
  type("m");
  await says("app#35 isn't approved yet");
  press("Down");
  await says(listKeys);
  readyPr();
  // The page's row is read again, so m shows once the PR is ready.
  await says(mergeKeys);
  type("m");
  await says("Merge app#35 into main? y/n");
  type("n");
  await says(mergeKeys);
  expect(acted).toEqual([]);
});

// A page shows one issue or PR, so s and m act on that one, even when the list behind it
// changed and another row took its place.
test("m on the page of a PR that closed meanwhile merges nothing, though another ready PR took its row", async () => {
  daemon();
  readyPr(35, "2026-11-06T10:00:00Z");
  readyPr(36, "2026-11-01T10:00:00Z");
  await openList("PRs");
  await onRight("app#36");
  press("Enter");
  await until(() => tabRow().includes("app#35"), "the PR's strip");
  await says(mergeKeys);
  sql("UPDATE items SET state = 'closed' WHERE kind = 'pr' AND id = '35'");
  await says(listKeys);
  type("m");
  await says("This PR is no longer open");
  await Bun.sleep(300);
  expect(acted).toEqual([]);
  expect(right()).toContain("Add export 35");
});

test("s on the page of an issue that closed meanwhile starts nothing", async () => {
  daemon();
  await openIssue();
  await says(startKeys);
  sql("UPDATE items SET state = 'closed' WHERE kind = 'task' AND id = '31'");
  await says(listKeys);
  type("s");
  await says("This issue is no longer open");
  await Bun.sleep(300);
  expect(acted).toEqual([]);
});

// The question names one PR, and y merges that one, however the list moved meanwhile.
test("y merges the PR the question named, even after the list moved under it", async () => {
  daemon();
  readyPr(35, "2026-11-06T10:00:00Z");
  readyPr(36, "2026-11-01T10:00:00Z");
  await openList("PRs");
  await onRight("app#36");
  type("m");
  await says("Merge app#35 into main? y/n");
  sql("UPDATE items SET state = 'closed' WHERE kind = 'pr' AND id = '35'");
  await until(() => !right().includes("app#35"), "the list to drop app#35");
  type("y");
  await until(() => acted.length === 1, "the merge");
  expect(acted).toEqual([`merge simon/app 35 ${"c".repeat(40)}`]);
});

test("s on an issue's page, once its thread started, says the issue has it", async () => {
  daemon();
  await openIssue();
  type("s");
  await says("Start a thread on app#31? y/n");
  type("y");
  await until(() => acted.length === 1, "the start");
  await says(startKeys);
  // The daemon records the thread, as sc start does.
  sql(threadSql({ task: "31" }));
  type("s");
  await says("app#31 already has app-31");
  expect(acted).toEqual(["start simon/app 31"]);
});

test("m on a PR that isn't ready says what it waits on, and merges nothing", async () => {
  daemon();
  await openList("PRs");
  press("Enter");
  await onRight("← back");
  type("m");
  await says("app#34 isn't approved yet");
  press("Left");
  await says(listKeys);
  expect(acted).toEqual([]);
});

test("a stopped thread is listed under Stopped, and opening it does nothing", async () => {
  sql("UPDATE threads SET status = 'stopped' WHERE task = 7");
  await openList("Threads");
  await onRight("Stopped");
  clickListRow("app-7");
  await Bun.sleep(500);
  expect(right()).toContain("Stopped");
  expect(listsRunning()).toBe(1);
});

test("a PR's page shows its branch, checks and latest review", async () => {
  await openList("PRs");
  press("Enter");
  await onRight("Approved. · codex");
  expect(right()).toContain("skelcrew/12 → main");
  expect(right()).toContain("passed");
  expect(right()).toContain("All of them.");
});

test("the page's link reaches your terminal as a terminal link, through tmux", async () => {
  await openIssue();
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  expect(colours).toContain(`;${issueUrl}\x1b\\`);
  expect(seen()).toContain(`GitHub  ${issueUrl}`);
});

// Puts a stand-in for the command that opens a link in your browser ahead of the real one, on a
// machine with a display, so a test never opens a real browser. It logs each link it gets.
function fakeOpener(): void {
  mkdirSync(join(home, "opener"));
  const log = JSON.stringify(join(home, "opened"));
  for (const name of ["open", "xdg-open"])
    writeFileSync(join(home, "opener", name), `#!/bin/sh\necho "$1" >> ${log}\n`, { mode: 0o755 });
  given.before = `PATH=${join(home, "opener")}:$PATH DISPLAY=:9 `;
}
// Clicks the page's link to GitHub, a few columns into it, where the screen shows it.
function clickLink(): void {
  const lines = seen().split("\n");
  const y = lines.findIndex((line) => line.includes(`GitHub  ${issueUrl}`));
  click((lines[y] ?? "").indexOf(issueUrl) + 4, y + 1);
}

test("a plain click on the page's link opens it in your browser, on the machine you sit at", async () => {
  fakeOpener();
  await openIssue();
  await onRight("click to open");
  // A click elsewhere on the page opens nothing.
  const lines = seen().split("\n");
  click(sidebar + 6, lines.findIndex((line) => line.includes("Author")) + 1);
  clickLink();
  await until(() => read("opened") !== "", "the link to open");
  await Bun.sleep(300);
  expect(read("opened")).toBe(`${issueUrl}\n`);
});

test("on a remote, a click on the page's link copies it to your terminal's clipboard", async () => {
  fakeOpener();
  openOnGitHub();
  open("lead", "one", "xterm-256color", "120", "simon@workbox");
  await ready("lead");
  // Your terminal keeps what a program copies, as Ghostty does.
  tmux(terminal, "set", "-s", "set-clipboard", "on");
  await until(() => /Issues +2/.test(seen()), "the entries");
  clickRow("Issues");
  await onRight("↑↓ move");
  press("Enter");
  await onRight("click to copy");
  clickLink();
  await onRight("copied");
  expect(tmux(terminal, "show-buffer").out).toBe(issueUrl);
  expect(read("opened")).toBe("");
});
