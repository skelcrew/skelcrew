// The screen's sidebar as the list: its stages opening and closing by key and by click, moving
// between sections, and the list's keys on a task's row, which never reach an agent.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { itemSql } from "./harness.ts";
import {
  acted,
  click,
  daemon,
  endTest,
  footer,
  onDetails,
  onLead,
  open,
  press,
  read,
  ready,
  seen,
  selected,
  sidebar,
  sql,
  startTest,
  type,
  until,
} from "./screen.ts";

// Longer than the screen's waits, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
beforeEach(startTest);
afterEach(endTest);

// The sidebar's lines as you read them, without the right side.
const left = () =>
  seen()
    .split("\n")
    .map((line) => line.slice(0, sidebar - 1).trimEnd());
// Returns whether a stage's heading shows with rows under it, so it is open.
const isOpen = (heading: string) => {
  const lines = left();
  const at = lines.findIndex((line) => line.includes(heading));
  return at >= 0 && /^ [▸ ] \S/.test(lines[at + 1] ?? "");
};

test("Alt-1 to Alt-6 open and close the stages from the lead's row, and the lead gets nothing", async () => {
  open("lead");
  await ready("lead");
  await until(() => isOpen("2 Building"), "Building open at the start");
  expect(isOpen("6 Done")).toBe(false);
  press("M-2");
  await until(() => !isOpen("2 Building"), "Building to close");
  // Opening a stage moves you to its first row, whose details show on the right.
  press("M-6");
  await until(() => isOpen("6 Done") && selected().includes("APP-3"), "Done to open on APP-3");
  await until(onDetails, "app-3's details");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});

test("on a task's row plain 1 to 6 open and close the stages, and no agent gets them", async () => {
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(() => selected().includes("APP-12") && onDetails(), "APP-12's details");
  type("6");
  await until(() => isOpen("6 Done"), "Done to open");
  type("6");
  await until(() => !isOpen("6 Done"), "Done to close");
  type("q");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
  expect(read("app-12.typed")).toBe("");
  expect(seen()).toContain("2 Building");
});

test("a click on a stage's heading opens or closes it, and on Needs you does nothing", async () => {
  sql("UPDATE threads SET needs_you = 1 WHERE task = 12");
  open("lead");
  await ready("lead");
  await until(() => isOpen("Needs you 1"), "app-12 under Needs you");
  const at = (heading: string) => left().findIndex((line) => line.includes(heading)) + 1;
  click(5, at("Needs you 1"));
  await Bun.sleep(300);
  expect(isOpen("Needs you 1")).toBe(true);
  click(5, at("2 Building"));
  await until(() => !isOpen("2 Building"), "Building to close");
  click(5, at("2 Building"));
  await until(() => isOpen("2 Building"), "Building to open");
});

test("Alt-Shift-Down and Alt-Shift-Up move between the lead, Needs you and the open stages", async () => {
  sql("UPDATE threads SET needs_you = 1 WHERE task = 12");
  open("lead");
  await ready("lead");
  await until(() => isOpen("Needs you 1"), "app-12 under Needs you");
  press("M-S-Down");
  await until(() => selected().includes("APP-12"), "Needs you's first row");
  press("M-S-Down");
  await until(() => selected().includes("APP-7"), "Building's first row");
  press("M-S-Up");
  await until(() => selected().includes("APP-12"), "back to Needs you");
  press("M-S-Up");
  await until(() => onLead(), "back to the lead");
  await until(() => seen().includes("I am lead"), "the lead on the right");
});

test("s on a task in Backlog asks in the footer, any key but y leaves it be, and y starts it", async () => {
  daemon();
  sql(itemSql("app", "task", 31, "Export as CSV", "2026-11-05T10:00:00Z"));
  open("lead");
  await ready("lead");
  press("M-1");
  await until(() => selected().includes("APP-31"), "APP-31 in Backlog");
  await until(onDetails, "app-31's details");
  type("s");
  await until(() => footer().includes("Start APP-31? y/n"), "the question");
  type("n");
  await until(() => !footer().includes("Start APP-31?"), "the question to go");
  type("s");
  await until(() => footer().includes("Start APP-31? y/n"), "the question again");
  type("y");
  await until(() => acted.includes("start simon/app 31"), "the daemon to start app-31");
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
