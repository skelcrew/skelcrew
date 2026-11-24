// The screen's sidebar as the list: its stages opening and closing by key and by click, a click
// bringing your typing there, moving between sections, and the list's keys on a task's row, which
// never reach an agent.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { itemSql, threadSql } from "./harness.ts";
import {
  acted,
  click,
  daemon,
  endTest,
  footer,
  given,
  holdTmux,
  home,
  onDetails,
  onLead,
  open,
  press,
  read,
  ready,
  release,
  releaseTmux,
  right,
  seen,
  selected,
  sidebar,
  slowTmux,
  sql,
  startTest,
  type,
  typingToSidebar,
  until,
} from "./screen.ts";

beforeEach(startTest);
afterEach(endTest);

// The sidebar's lines as you read them, without the right side.
const left = () =>
  seen()
    .split("\n")
    .map((line) => line.slice(2, sidebar).trimEnd());
// Returns whether a stage's heading shows with rows under it, so it is open.
const isOpen = (heading: string) => {
  const lines = left();
  const at = lines.findIndex((line) => line.includes(heading));
  return at >= 0 && /^ [▸ ] \S/.test(lines[at + 1] ?? "");
};

test("Building, Reviewing and Checks start open, and Backlog, Ready and Done start closed", async () => {
  sql(`${threadSql({ task: "15", title: "Under review", status: "waiting", reviewing: "abc", pr: 45 })}
${threadSql({ task: "16", title: "Approved", status: "waiting", verdict: "approve", checks: "pending", pr: 46 })}
${itemSql("app", "task", 31, "Export as CSV", "2026-11-05T10:00:00Z")}`);
  open("lead");
  await ready("lead");
  await until(
    () => isOpen("2 Building") && isOpen("3 Reviewing") && isOpen("4 Checks"),
    "the stages",
  );
  expect(isOpen("0 Backlog")).toBe(false);
  expect(isOpen("5 Ready")).toBe(false);
  expect(isOpen("6 Done")).toBe(false);
  // They stay toggles: Reviewing closes and opens again, and Checks stays open meanwhile.
  press("M-3");
  await until(() => !isOpen("3 Reviewing"), "Reviewing to close");
  expect(isOpen("4 Checks")).toBe(true);
  press("M-3");
  await until(() => isOpen("3 Reviewing"), "Reviewing to open again");
});

test("Alt-1 to Alt-6 open and close the stages from the lead's row, and the lead gets nothing", async () => {
  open("lead");
  await ready("lead");
  await until(() => isOpen("2 Building"), "Building open at the start");
  expect(isOpen("6 Done")).toBe(false);
  press("M-2");
  await until(() => !isOpen("2 Building"), "Building to close");
  // Opening a stage moves you to its first row, whose details show on the right.
  press("M-6");
  await until(() => isOpen("6 Done") && / 3\b/.test(selected()), "Done to open on APP-3");
  await until(onDetails, "app-3's details");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});

// The task queue is a stage, opened and closed by 1, with Alt or without.
test("Alt-1 and plain 1 open and close the task queue, and the lead gets neither", async () => {
  sql(threadSql({ task: "9", title: "Old work", status: "stopped" }));
  open("lead");
  await ready("lead");
  await until(() => isOpen("1 Task queue"), "the task queue open at the start");
  press("M-1");
  await until(() => !isOpen("1 Task queue"), "the task queue to close");
  press("M-1");
  await until(() => isOpen("1 Task queue") && / 9\b/.test(selected()), "it to open on APP-9");
  await until(onDetails, "app-9's details");
  type("1");
  await until(() => !isOpen("1 Task queue"), "plain 1 to close it");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
  expect(read("app-9.typed")).toBe("");
});

// Needs you shows only while a task needs you, and you stay on your row as it comes and goes.
test("Needs you shows only while a task needs you, and the row you are on stays", async () => {
  open("lead");
  await ready("lead");
  await until(() => isOpen("2 Building"), "the stages");
  expect(left().some((line) => line.includes("Needs you"))).toBe(false);
  press("M-S-Down");
  // The row shows its task's ID alone, after its mark.
  await until(() => /^[▸▹] \S \d+\b/.test(selected()), "Building's first row");
  const [, task = ""] = /^[▸▹] \S (\d+)\b/.exec(selected()) ?? [];
  const name = new RegExp(` ${task}\\b`);
  sql(`UPDATE threads SET needs_you = 1 WHERE task = 't${task}'`);
  await until(() => isOpen("Needs you  1"), "it under Needs you");
  expect(selected()).toMatch(name);
  sql("UPDATE threads SET needs_you = 0");
  await until(() => !left().some((line) => line.includes("Needs you")), "Needs you to go");
  expect(selected()).toMatch(name);
});

test("on a task's row plain 1 to 6 open and close the stages, and no agent gets them", async () => {
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(() => / 12\b/.test(selected()) && onDetails(), "APP-12's details");
  type("6");
  await until(() => isOpen("6 Done"), "Done to open");
  type("6");
  await until(() => !isOpen("6 Done"), "Done to close");
  type("x");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
  expect(read("app-12.typed")).toBe("");
  expect(seen()).toContain("2 Building");
});

test("a click on a stage's heading opens or closes it, and on Needs you does nothing", async () => {
  sql("UPDATE threads SET needs_you = 1 WHERE task = 't12'");
  open("lead");
  await ready("lead");
  await until(() => isOpen("Needs you  1"), "app-12 under Needs you");
  const at = (heading: string) => left().findIndex((line) => line.includes(heading)) + 1;
  click(5, at("Needs you  1"));
  await Bun.sleep(300);
  expect(isOpen("Needs you  1")).toBe(true);
  click(5, at("2 Building"));
  await until(() => !isOpen("2 Building"), "Building to close");
  click(5, at("2 Building"));
  await until(() => isOpen("2 Building"), "Building to open");
});

test("a left click anywhere in the sidebar moves your typing there, and the wheel never does", async () => {
  sql("UPDATE threads SET needs_you = 1 WHERE task = 't12'");
  open("lead");
  await ready("lead");
  await until(() => isOpen("Needs you  1"), "app-12 under Needs you");
  const at = (text: string) => left().findIndex((line) => line.includes(text)) + 1;
  const toLead = async () => {
    click(5, at("◆ Lead"));
    await until(() => !typingToSidebar() && onLead(), "your typing back on the lead");
  };
  const clicked = async (line: number, what: string) => {
    click(5, line);
    await until(typingToSidebar, `a click on ${what} to move your typing`);
    await until(() => !footer().startsWith("  typing to"), `the footer after ${what}`);
    await toLead();
  };
  type("\x1b[<65;5;10M");
  await until(() => !selected().includes("Lead"), "the wheel to move down a row");
  type("\x1b[<64;5;10M");
  await until(() => selected().includes("Lead") && onLead(), "the wheel to move back up");
  await Bun.sleep(300);
  expect(typingToSidebar()).toBe(false);
  const task = left().findIndex((line) => /[○●⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 7\b/.test(line)) + 1;
  await clicked(task, "a task's row");
  await clicked(at("Needs you  1"), "Needs you");
  await clicked(at("2 Building"), "a stage's heading");
  await clicked(25, "empty space");
});

test("Alt-Shift-Down and Alt-Shift-Up move between the lead, Needs you and the open stages", async () => {
  sql("UPDATE threads SET needs_you = 1 WHERE task = 't12'");
  open("lead");
  await ready("lead");
  await until(() => isOpen("Needs you  1"), "app-12 under Needs you");
  press("M-S-Down");
  await until(() => / 12\b/.test(selected()), "Needs you's first row");
  press("M-S-Down");
  await until(() => / 7\b/.test(selected()), "Building's first row");
  press("M-S-Up");
  await until(() => / 12\b/.test(selected()), "back to Needs you");
  press("M-S-Up");
  await until(() => onLead(), "back to the lead");
  await until(() => seen().includes("I am lead"), "the lead on the right");
});

test("s on a task in Backlog asks in the footer, any key but y leaves it be, and y starts it", async () => {
  daemon();
  sql(itemSql("app", "task", 31, "Export as CSV", "2026-11-05T10:00:00Z"));
  open("lead");
  await ready("lead");
  press("M-0");
  await until(() => / #31\b/.test(selected()), "APP#31 in Backlog");
  await until(onDetails, "app#31's details");
  type("s");
  await until(() => footer().includes("Start APP#31? y/n"), "the question");
  type("n");
  await until(() => !footer().includes("Start APP#31?"), "the question to go");
  type("s");
  await until(() => footer().includes("Start APP#31? y/n"), "the question again");
  type("y");
  await until(() => acted.includes("start simon/app #31"), "the daemon to start app#31");
});

// A merge picked on an item asks y/n in the item's box on the right, where you read it: any other
// key leaves the item, and y sends the pick. While the daemon merges, the task leaves Needs you
// for Ready, saying so, and a merge that fails comes back with its reason in the box.
test("a merge picked on an item asks in its box, leaves Needs you on y, and comes back on a failure", async () => {
  daemon();
  const head = "9fc11d177dbffac496ad6b3496b3f91775d9057f";
  const checks = [{ name: "test", id: "1", state: "passed" }];
  sql(`${itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", { head, checks })};
${threadSql({ task: "14", title: "Fix the export header", status: "waiting", needs_you: 1, verdict: "approve", checks: "passing", ci_passed: 1, pr: 41, review_round: 1, reviewed_commit: head })}`);
  open("lead");
  await ready("lead");
  press("C-\\");
  await until(typingToSidebar, "the sidebar's typing");
  for (let presses = 0; presses < 6 && !/ 14\b/.test(selected()); presses++) {
    const before = selected();
    press("Down");
    await until(() => selected() !== before, "a move down");
  }
  await until(() => / 14\b/.test(selected()) && right().includes("a) Merge it"), "APP-14's item");
  press("Enter");
  await until(() => footer().includes("esc back"), "the item open");
  const inBox = () => right().includes("│ Merge app#41 into main?");
  type("a");
  await until(inBox, "the question in the box");
  type("n");
  await until(() => !inBox() && right().includes("a) Merge it"), "the item without the question");
  expect(acted.filter((line) => line.startsWith("pick"))).toEqual([]);
  type("a");
  await until(inBox, "the question in the box again");
  type("y");
  await until(() => acted.includes("pick simon/app 14 a"), "the pick");
  sql("UPDATE threads SET picking = 'merging…' WHERE folder = 'app-14'");
  await until(() => isOpen("5 Ready") && !right().includes("a) Merge it"), "APP-14 under Ready");
  expect(left().join("\n")).not.toContain("Needs you");
  expect(left().join("\n")).toContain("merging…");
  sql(
    "UPDATE threads SET picking = NULL, pick_failed = 'GitHub refused the merge' WHERE folder = 'app-14'",
  );
  await until(
    () => right().includes("GitHub refused the merge") && isOpen("Needs you"),
    "the reason in the box, under Needs you",
  );
});

// y on a picked merge shows your answer at once, before tmux or the daemon answers: the task leaves
// Needs you saying it merges, then the question and the item leave the box. Once the daemon
// answers, the list shows what the database says again, here that the task still needs you, as
// this daemon records nothing.
test("y on a picked merge shows at once, while tmux and the daemon are slow", async () => {
  daemon();
  slowTmux();
  given.holding = true;
  const head = "9fc11d177dbffac496ad6b3496b3f91775d9057f";
  const checks = [{ name: "test", id: "1", state: "passed" }];
  sql(`${itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", { head, checks })};
${threadSql({ task: "14", title: "Fix the export header", status: "waiting", needs_you: 1, verdict: "approve", checks: "passing", ci_passed: 1, pr: 41, review_round: 1, reviewed_commit: head })}`);
  open("lead");
  await ready("lead");
  press("C-\\");
  await until(typingToSidebar, "the sidebar's typing");
  for (let presses = 0; presses < 6 && !/ 14\b/.test(selected()); presses++) {
    const before = selected();
    press("Down");
    await until(() => selected() !== before, "a move down");
  }
  await until(() => / 14\b/.test(selected()) && right().includes("a) Merge it"), "APP-14's item");
  press("Enter");
  await until(() => footer().includes("esc back"), "the item open");
  type("a");
  await until(() => right().includes("│ Merge app#41 into main?"), "the question in the box");
  holdTmux();
  type("y");
  await until(
    () => !left().join("\n").includes("Needs you") && left().join("\n").includes("merging…"),
    "the answer shown while tmux is slow",
  );
  expect(acted).not.toContain("pick simon/app 14 a");
  releaseTmux();
  await until(() => acted.includes("pick simon/app 14 a"), "the pick");
  await until(
    () => !right().includes("Merge app#41 into main?") && !right().includes("a) Merge it"),
    "the box without the question and the item while the daemon merges",
  );
  release();
  await until(
    () => isOpen("Needs you") && right().includes("a) Merge it"),
    "the item back once the daemon answered",
  );
});

// The notice comes from the database, which the daemon writes once it installed a release.
test("a release installed in the background shows as a notice above the lead", async () => {
  sql("INSERT INTO installed (release) VALUES ('9.9.9');");
  open("lead");
  await ready("lead");
  // The notice is cut at words to the sidebar's width, so it is read across its lines.
  const words = () => left().join(" ").replace(/\s+/g, " ");
  await until(() => words().includes("Skelcrew 9.9.9 installed · restart to use it"), "the notice");
  const lines = left();
  const at = lines.findIndex((line) => line.includes("9.9.9 installed"));
  expect(at).toBeLessThan(lines.findIndex((line) => line.includes("lead")));
});

// A queued task shows in the task queue, and Shift-Up there has the daemon move it earlier in the
// queue, with the footer saying its place. No agent gets the key.
test("Shift-Up on a queued task in the task queue moves it in the queue, and the footer says its place", async () => {
  daemon();
  sql(threadSql({ task: "20", title: "Dark mode", status: "queued", queued_since: 1000 }));
  open("lead");
  await ready("lead");
  await until(() => left().some((line) => line.includes("Task queue")), "Task queue");
  press("M-S-Down");
  await until(() => / 20\b/.test(selected()) && onDetails(), "APP-20's details");
  await until(() => footer().includes("⇧↑↓ reorder"), "the key in the footer");
  press("S-Up");
  await until(() => acted.includes("queue move simon/app 20 -1"), "the daemon to move APP-20");
  await until(() => footer().includes("APP-20 starts next"), "its place in the footer");
  expect(read("lead.typed")).toBe("");
});

// f on a queued task in the task queue asks first, as it starts the task over the limit, and y has the
// daemon start it now. No agent gets the keys.
test("f on a queued task in the task queue asks to start it now over the limit, and y starts it", async () => {
  daemon();
  // app's threads 7 and 12 work already, so its one place is taken.
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  writeFileSync(
    join(clone, "skelcrew.yaml"),
    "tracker: github\nsetup: []\ntest: []\nlimits: { threads: 1 }\n",
  );
  sql(threadSql({ task: "20", title: "Dark mode", status: "queued", queued_since: 1000 }));
  // APP-30 was APP-T20 until the daemon renumbered it past a clash. y starts the row's own task,
  // named by its number, never the old name APP-T20, which the daemon takes for APP-30.
  sql(threadSql({ task: "t30", alias: "t20", folder: "app-t20", title: "Old", status: "done" }));
  open("lead");
  await ready("lead");
  await until(() => left().some((line) => line.includes("Task queue")), "Task queue");
  press("M-S-Down");
  await until(() => / 20\b/.test(selected()) && onDetails(), "APP-20's details");
  await until(() => footer().includes("f start now"), "the key in the footer");
  type("f");
  await until(
    () => footer().includes("Start APP-20 now, over the limit of 1? y/n"),
    "the question",
  );
  type("y");
  await until(() => acted.includes("start simon/app 20 now"), "the daemon to start APP-20");
  expect(read("lead.typed")).toBe("");
});

test("an item opened full-size closes with a lone Esc", async () => {
  sql(`INSERT INTO asks (owner, repo, task, title, text, options, posted)
    VALUES ('simon', 'app', 't12', 'Add web?', 'Add simon/web too?', '["yes","no"]', 1)`);
  open("lead");
  await ready("lead");
  press("C-\\");
  await until(typingToSidebar, "the sidebar's typing");
  press("Down");
  press("Down");
  await until(() => /^▸ \S 12\b/.test(selected()), "the item's row");
  press("Enter");
  await until(() => footer().includes("esc back"), "the item open full-size");
  expect(left().join("\n")).toContain("Needs you");
  expect(selected()).toMatch(/^▸ \S 12\b/);
  expect(left().join("\n")).not.toContain("a) yes");
  expect(left().join("\n")).not.toContain("Add simon/web too?");
  await until(() => seen().includes("a) yes"), "the item on the right");
  expect(seen()).toContain("Add simon/web too?");
  press("Escape");
  await until(() => !footer().includes("esc back"), "the item closed");
  expect(footer()).not.toContain("esc back");
});

test("an opened item scrolls on the right while its row stays selected", async () => {
  // Numbered, so each page of it reads differently.
  const text = Array.from({ length: 400 }, (_, at) => `w${at}`).join(" ");
  sql(`INSERT INTO asks (owner, repo, task, text, options, posted)
    VALUES ('simon', 'app', '', '${text}', '["yes","no"]', 1)`);
  open("lead");
  await ready("lead");
  press("C-\\");
  await until(typingToSidebar, "the sidebar's typing");
  press("Down");
  press("Down");
  await until(() => selected().startsWith("▸ ● app"), "the item's row");
  press("Enter");
  await until(() => footer().includes("esc back"), "the item open full-size");
  expect(seen()).not.toContain("r) reply");
  for (let tap = 0; tap < 20 && !seen().includes("r) reply"); tap++) {
    const before = seen();
    press("PageDown");
    await until(() => seen() !== before, "the item to scroll");
  }
  expect(left().join("\n")).toContain("Needs you");
  expect(selected()).toStartWith("▸ ● app");
  expect(seen()).toContain("b) no");
  expect(seen()).toContain("r) reply");
});
