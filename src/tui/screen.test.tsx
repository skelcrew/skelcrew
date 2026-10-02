import { expect, test } from "bun:test";
import type { Loaded } from "./screen";
import { IDEA_KEYS, lines, loaded, open, PLAIN_KEYS, task, tick } from "./testing";

test("tasks are grouped by what you need to do, with what each one needs", async () => {
  const { lastFrame } = open();
  await tick();
  expect(lines(lastFrame())).toEqual([
    "skelcrew ~/code/app 4 wait on you · 2 working",
    "",
    "Waiting on you",
    "› #9 Dark mode ui blocked: Out of attempts. The last failure, in local: bun test",
    "#11 Retry on 429 approve its merge · PR on GitHub",
    "#14 CSV export reports approve its spec",
    "#18 Pick a format question: CSV or Markdown?",
    "",
    "Working",
    "#12 Settings page ui In progress · you-2",
    "#13 Linear import Spec · you-3",
    "",
    "Waiting for an agent",
    "#15 Rate limit Ready · start it with /develop 15",
    "#17 Spec me Spec · start it with /spec 17",
    "",
    "Ideas",
    "#16 Keyboard help Idea",
    "",
    "1 done · 1 dropped",
    "",
    // The cursor is on #9, a blocked task, which y and x can't act on.
    PLAIN_KEYS,
  ]);
});

test("the header says one task in the singular", async () => {
  const one = [
    task(14, "CSV export", "spec", { waitingOnYou: "spec_approval" }),
    task(12, "Settings page", "in_progress", { session: "you-2", step: "working" }),
  ];
  const { lastFrame } = open({ load: loaded(one) });
  await tick();
  expect(lines(lastFrame())[0]).toBe("skelcrew ~/code/app 1 waits on you · 1 working");
});

test("a merge that is merging says so", async () => {
  const merging = task(11, "Retry on 429", "checks", { step: "merging" });
  const { lastFrame } = open({ load: loaded([merging]) });
  await tick();
  expect(lines(lastFrame())).toContain("› #11 Retry on 429 Checks · merging");
});

test("groups with no tasks are left out, and so is the count of none done", async () => {
  const { lastFrame } = open({ load: loaded([task(16, "Keyboard help", "idea")]) });
  await tick();
  expect(lines(lastFrame())).toEqual([
    "skelcrew ~/code/app",
    "",
    "Ideas",
    "› #16 Keyboard help Idea",
    "",
    IDEA_KEYS,
  ]);
});

// The test screen is 100 columns wide.
test("a title uses the room the screen has", async () => {
  const title = "Open a normal pull request, and close it after merge";
  const { lastFrame } = open({ load: loaded([task(9, title, "idea")]) });
  await tick();
  expect(lines(lastFrame())).toContain(`› #9 ${title} Idea`);
});

test("a title too long for the screen is cut, so what the task needs still shows", async () => {
  const title = "A very long title ".repeat(8).trim();
  const { lastFrame } = open({
    load: loaded([task(9, title, "spec", { waitingOnYou: "spec_approval" })]),
  });
  await tick();
  const row = (lastFrame() ?? "").split("\n").find((line) => line.startsWith("›")) ?? "";
  expect(row.trimEnd().endsWith("…  approve its spec")).toBe(true);
  expect(row.length).toBeLessThanOrEqual(100);
});

test("a long repository path is cut from the left, so the header stays one line", async () => {
  const repo = `/tmp/${"deep/".repeat(30)}app`;
  const one = [task(14, "CSV export", "spec", { waitingOnYou: "spec_approval" })];
  const { lastFrame } = open({ repo, load: loaded(one) });
  await tick();
  const [header = "", next] = (lastFrame() ?? "").split("\n");
  expect(header.startsWith("skelcrew  …")).toBe(true);
  expect(header.endsWith("deep/app  1 waits on you")).toBe(true);
  expect(next).toBe("");
});

test("with no tasks, it says which key adds one", async () => {
  const { lastFrame } = open({ load: loaded([]) });
  await tick();
  expect(lines(lastFrame())).toContain("No tasks yet. Press a to add one.");
});

test("j and k move the cursor between tasks, skipping headings", async () => {
  const { lastFrame, stdin } = open();
  await tick();
  stdin.write("j");
  await tick();
  expect(lines(lastFrame())).toContain("› #11 Retry on 429 approve its merge · PR on GitHub");
  stdin.write("j");
  stdin.write("j");
  stdin.write("j");
  await tick();
  // From the last task waiting on you to the first one working.
  expect(lines(lastFrame())).toContain("› #12 Settings page ui In progress · you-2");
  stdin.write("k");
  await tick();
  expect(lines(lastFrame())).toContain("› #18 Pick a format question: CSV or Markdown?");
});

test("the arrow keys move the cursor too", async () => {
  const { lastFrame, stdin } = open();
  await tick();
  stdin.write("\u001B[B");
  await tick();
  expect(lines(lastFrame())).toContain("› #11 Retry on 429 approve its merge · PR on GitHub");
  stdin.write("\u001B[A");
  await tick();
  expect(lines(lastFrame())[3]?.startsWith("› #9 ")).toBe(true);
});

test("g goes to the first task and G to the last, and the cursor stops at both ends", async () => {
  const { lastFrame, stdin } = open();
  await tick();
  stdin.write("G");
  await tick();
  expect(lines(lastFrame())).toContain("› #16 Keyboard help Idea");
  stdin.write("j");
  await tick();
  expect(lines(lastFrame())).toContain("› #16 Keyboard help Idea");
  stdin.write("g");
  await tick();
  stdin.write("k");
  await tick();
  expect(lines(lastFrame())[3]?.startsWith("› #9 ")).toBe(true);
});

test("the list refreshes, and the cursor stays on its task when the task moves", async () => {
  let list = [
    task(15, "Rate limit", "ready", { step: "queued" }),
    task(16, "Keyboard help", "idea"),
  ];
  const { lastFrame, stdin } = open({
    load: async () => ({ ok: true, tasks: list }),
    refreshMs: 10,
  });
  await tick();
  stdin.write("j");
  await tick();
  expect(lines(lastFrame())).toContain("› #16 Keyboard help Idea");
  // #16 gets a spec to approve, so it moves to the top.
  list = [
    task(15, "Rate limit", "ready", { step: "queued" }),
    task(16, "Keyboard help", "spec", { waitingOnYou: "spec_approval" }),
  ];
  await tick(50);
  expect(lines(lastFrame())).toContain("› #16 Keyboard help approve its spec");
});

test("when the cursor's task is gone, the cursor goes to the first task", async () => {
  let list = [
    task(15, "Rate limit", "ready", { step: "queued" }),
    task(16, "Keyboard help", "idea"),
  ];
  const { lastFrame, stdin } = open({
    load: async () => ({ ok: true, tasks: list }),
    refreshMs: 10,
  });
  await tick();
  stdin.write("j");
  await tick();
  list = [task(15, "Rate limit", "ready", { step: "queued" })];
  await tick(50);
  expect(lines(lastFrame())).toContain("› #15 Rate limit Ready · start it with /develop 15");
});

test("when the daemon can't answer, the screen says why and keeps the last list", async () => {
  let answer: Loaded = { ok: true, tasks: [task(16, "Keyboard help", "idea")] };
  const { lastFrame } = open({ load: async () => answer, refreshMs: 10 });
  await tick();
  answer = { ok: false, message: "The daemon stopped." };
  await tick(50);
  const shown = lines(lastFrame());
  expect(shown).toContain("› #16 Keyboard help Idea");
  expect(shown).toContain("The daemon stopped.");
});

test("q closes the screen", async () => {
  let quit = 0;
  const { stdin } = open({ quit: () => quit++ });
  await tick();
  stdin.write("q");
  await tick();
  expect(quit).toBe(1);
});

test("other keys don't close it", async () => {
  let quit = 0;
  const { stdin } = open({ quit: () => quit++ });
  await tick();
  stdin.write("x");
  await tick();
  expect(quit).toBe(0);
});
