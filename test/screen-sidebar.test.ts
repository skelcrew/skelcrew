// The screen's sidebar as the list: its stages opening and closing by key and by click, moving
// between sections, and the list's keys on a task's row, which never reach an agent.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { panes } from "../src/screen/screen.ts";
import { itemSql, threadSql } from "./harness.ts";
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
  right,
  screen,
  screenSessions,
  seen,
  selected,
  sidebar,
  sql,
  startTest,
  tmux,
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
  expect(isOpen("1 Backlog")).toBe(false);
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

// A queued task shows under Up next, and Shift-Up there has the daemon move it earlier in the
// queue, with the footer saying its place. No agent gets the key.
test("Shift-Up on a queued task in Up next moves it in the queue, and the footer says its place", async () => {
  daemon();
  sql(threadSql({ task: "20", title: "Dark mode", status: "queued", queued_since: 1000 }));
  open("lead");
  await ready("lead");
  await until(() => left().some((line) => line.includes("Up next")), "Up next");
  press("M-S-Down");
  await until(() => selected().includes("APP-20") && onDetails(), "APP-20's details");
  await until(() => footer().includes("⇧↑↓ reorder"), "the key in the footer");
  press("S-Up");
  await until(() => acted.includes("queue move simon/app 20 -1"), "the daemon to move APP-20");
  await until(() => footer().includes("APP-20 starts next"), "its place in the footer");
  expect(read("lead.typed")).toBe("");
});

// A request of the lead's shows under the lead, and on its row the lead shows live on the right,
// but your typing stays with the sidebar: y and n answer the request, and the lead gets nothing.
test("on a request of the lead's, the lead shows read-only on the right, and y and n answer it", async () => {
  daemon();
  sql(`INSERT INTO lead_requests (owner, repo, action, says, made) VALUES
  ('simon', 'app', '{"kind":"start","task":"31"}', 'Start APP-31 Export as CSV?', 1),
  ('simon', 'app', '{"kind":"repo add","repository":"simon/site"}', 'Add the repository simon/site?', 2);`);
  open("lead");
  await ready("lead");
  const lines = left();
  const lead = lines.findIndex((line) => line.includes("lead"));
  expect(lines[lead + 2]).toContain("● Add the repository simon/site?");
  expect(lines[lead + 3]).toContain("● Start APP-31 Export as CSV?");
  press("M-Down");
  await until(() => selected().includes("Add the repository"), "the newest request");
  await until(() => footer().includes("y yes  n no"), "the keys in the footer");
  // The right side is the details pane, which reads the lead's screen without attaching to it.
  const rightCommand = () =>
    tmux(
      screen,
      "display",
      "-p",
      "-t",
      `=${screenSessions()[0]}:.${panes.right}`,
      "#{pane_start_command}",
    ).out;
  await until(() => rightCommand().includes("details"), "the details pane");
  await until(() => right().includes("I am lead"), "the lead's screen, read-only");
  type("n");
  await until(() => acted.includes("answer simon/app 2 no"), "the no");
  await until(() => footer().includes("Told the lead no."), "the daemon's answer");
  press("M-Down");
  await until(() => selected().includes("Start APP-31"), "the older request");
  type("y");
  await until(() => acted.includes("answer simon/app 1 yes"), "the yes");
  await until(() => footer().includes("Started APP-31."), "the daemon's answer");
  // Alt-Shift-Down from the lead goes past the requests, to the first section.
  press("M-Up");
  press("M-Up");
  await until(onLead, "back on the lead");
  press("M-S-Down");
  await until(
    () => !onLead() && !selected().includes("● Start") && !selected().includes("● Add"),
    "past the requests",
  );
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});
