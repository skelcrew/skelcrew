// What the screen writes to your terminal while nothing changes, and an agent's scrolling after
// the right side showed something else.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { threadSql } from "./harness.ts";
import {
  agent,
  attachTo,
  endTest,
  fixedLoad,
  home,
  noteRefreshes,
  open,
  press,
  ready,
  seen,
  selected,
  sidebarRefreshedTwice,
  sql,
  startTest,
  terminal,
  tmux,
  until,
  wheel,
} from "./screen.ts";

beforeEach(startTest);
afterEach(endTest);

// Has tmux copy what the screen writes to your terminal into a file, and gives back the file,
// empty, once the screen has settled. The sidebar takes in what just changed, such as a page
// opening, at its next refresh, and tmux redraws its border after that. On a busy machine that
// can come after half a second of quiet. So the screen has settled once the sidebar has
// refreshed twice from now, and then nothing was written for half a second. The test must call
// noteRefreshes first. The footer runs on its own and draws first whenever it has started,
// which a busy machine can put seconds later, so the copy waits for its load to show too.
async function copyOnceSettled(): Promise<string> {
  await until(() => (seen().split("\n")[29] ?? "").includes(fixedLoad), "the footer");
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

test("the wheel over an agent still scrolls it after a task's details came and went", async () => {
  agent("app-5", "seq 1 200");
  sql(threadSql({ task: "5" }));
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(() => / 5\b/.test(selected()), "APP-5's row");
  await attachTo("app-5");
  wheel(64);
  await until(() => !seen().includes("I am app-5"), "the agent's history");
});

test("with nothing working, an open screen sends your terminal nothing at all", async () => {
  noteRefreshes();
  sql("UPDATE threads SET status = 'waiting', changed = 0 WHERE status = 'working'");
  open("lead");
  await ready("lead");
  await until(() => seen().includes("waiting"), "the threads");
  const written = await copyOnceSettled();
  await sidebarRefreshedTwice();
  expect(readFileSync(written, "utf8")).toBe("");
});
