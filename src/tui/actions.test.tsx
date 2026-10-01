// The keys that act on tasks. Each runs the same `skelcrew` command as the
// CLI, and the screen shows what the CLI would have printed.

import { expect, test } from "bun:test";
import type { Outcome } from "../cli/cli";
import { lines, loaded, open, task, tick } from "./testing";

const ESC = "\u001B";
const ENTER = "\r";

// A stand-in for the CLI: it remembers each command and answers with
// `answer`.
function cli(answer: Outcome = { code: 0, out: ["Done."], err: [] }) {
  const sent: string[][] = [];
  return {
    sent,
    send: async (args: string[]) => {
      sent.push(args);
      return answer;
    },
  };
}

const said = (...out: string[]): Outcome => ({ code: 0, out, err: [] });
const refused = (...err: string[]): Outcome => ({ code: 1, out: [], err });

const specToApprove = task(14, "CSV export", "spec", { waitingOnYou: "spec_approval" });
const mergeToApprove = task(11, "Retry on 429", "checks", { waitingOnYou: "merge_approval" });
const blocked = task(9, "Dark mode", "in_progress", {
  blocked: "The agent gave up: no API.",
  waitingOnYou: "retry",
});
const idea = task(16, "Keyboard help", "idea");

test("y approves a spec at once, and shows what the CLI said", async () => {
  const { sent, send } = cli(said("Approved #14."));
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), send });
  await tick();
  stdin.write("y");
  await tick();
  expect(sent).toEqual([["approve", "14"]]);
  expect(lines(lastFrame())).toContain("Approved #14.");
});

test("y on a merge asks first, and n cancels it", async () => {
  const { sent, send } = cli();
  const { lastFrame, stdin } = open({ load: loaded([mergeToApprove]), send });
  await tick();
  stdin.write("y");
  await tick();
  expect(lines(lastFrame())).toContain("Merge #11 into main now? y/n");
  stdin.write("n");
  await tick();
  expect(sent).toEqual([]);
  expect(lines(lastFrame())).not.toContain("Merge #11 into main now? y/n");
});

test("y on a merge, then y again, merges it", async () => {
  const { sent, send } = cli(said("Approved #11. It merged into main as abc1234."));
  const { lastFrame, stdin } = open({ load: loaded([mergeToApprove]), send });
  await tick();
  stdin.write("y");
  await tick();
  stdin.write("y");
  await tick();
  expect(sent).toEqual([["approve", "11"]]);
  expect(lines(lastFrame())).toContain("Approved #11. It merged into main as abc1234.");
});

test("esc cancels a question too", async () => {
  const { sent, send } = cli();
  const { stdin } = open({ load: loaded([mergeToApprove]), send });
  await tick();
  stdin.write("y");
  await tick();
  stdin.write(ESC);
  await tick();
  stdin.write("y");
  await tick();
  // The second y asks again. It doesn't answer the question esc closed.
  expect(sent).toEqual([]);
});

test("x asks what to change, and sends the spec back with that note", async () => {
  const { sent, send } = cli(said("Sent #14 back to Spec with your note."));
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), send });
  await tick();
  stdin.write("x");
  await tick();
  expect(lines(lastFrame())).toContain("Send #14 back. What should change?");
  stdin.write("-Split it in two.");
  await tick();
  stdin.write(ENTER);
  await tick();
  // A note that starts with a dash is still a note, after --.
  expect(sent).toEqual([["reject", "14", "--", "-Split it in two."]]);
  expect(lines(lastFrame())).toContain("Sent #14 back to Spec with your note.");
});

test("esc closes the note without sending it", async () => {
  const { sent, send } = cli();
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), send });
  await tick();
  stdin.write("x");
  await tick();
  stdin.write("Split it");
  await tick();
  stdin.write(ESC);
  await tick();
  expect(sent).toEqual([]);
  expect(lines(lastFrame()).join("\n")).not.toContain("What should change?");
});

test("enter with nothing typed sends nothing", async () => {
  const { sent, send } = cli();
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), send });
  await tick();
  stdin.write("x");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(sent).toEqual([]);
  expect(lines(lastFrame()).join("\n")).toContain("What should change?");
});

test("keys typed into a note are text, so q doesn't quit", async () => {
  let quit = 0;
  const { sent, send } = cli();
  const { stdin } = open({ load: loaded([specToApprove]), send, quit: () => quit++ });
  await tick();
  stdin.write("x");
  await tick();
  stdin.write("q");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(quit).toBe(0);
  expect(sent).toEqual([["reject", "14", "--", "q"]]);
});

test("s asks for a spec, and r retries", async () => {
  const { sent, send } = cli();
  const { stdin } = open({ load: loaded([blocked, idea]), send });
  await tick();
  stdin.write("r");
  await tick();
  stdin.write("j");
  await tick();
  stdin.write("s");
  await tick();
  expect(sent).toEqual([
    ["retry", "9"],
    ["spec", "16"],
  ]);
});

test("D asks before it drops, then y drops", async () => {
  const { sent, send } = cli(said("Dropped #9."));
  const { lastFrame, stdin } = open({ load: loaded([blocked]), send });
  await tick();
  stdin.write("D");
  await tick();
  expect(lines(lastFrame())).toContain("Drop #9 Dark mode? y/n");
  stdin.write("y");
  await tick();
  expect(sent).toEqual([["drop", "9"]]);
  expect(lines(lastFrame())).toContain("Dropped #9.");
});

test("a adds an idea with the title typed", async () => {
  const { sent, send } = cli(said("Added #19: CSV export."));
  const { lastFrame, stdin } = open({ load: loaded([idea]), send });
  await tick();
  stdin.write("a");
  await tick();
  expect(lines(lastFrame())).toContain("Add an idea:");
  stdin.write("CSV export");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(sent).toEqual([["add", "--", "CSV export"]]);
  expect(lines(lastFrame())).toContain("Added #19: CSV export.");
});

test("A adds an idea and asks for its spec", async () => {
  const { sent, send } = cli();
  const { lastFrame, stdin } = open({ load: loaded([]), send });
  await tick();
  stdin.write("A");
  await tick();
  expect(lines(lastFrame())).toContain("Add an idea and ask for its spec:");
  stdin.write("CSV export");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(sent).toEqual([["add", "--spec", "--", "CSV export"]]);
});

test("a key that needs a task does nothing when there are none", async () => {
  const { sent, send } = cli();
  const { stdin } = open({ load: loaded([]), send });
  await tick();
  for (const key of ["y", "x", "s", "r", "D"]) stdin.write(key);
  await tick();
  expect(sent).toEqual([]);
});

// The rules live in the daemon, so the screen sends what you ask for and
// shows the refusal, word for word.
test("a refusal shows what the CLI said", async () => {
  const { send } = cli(refused("#16 is an Idea, so there is nothing to approve."));
  const { lastFrame, stdin } = open({ load: loaded([idea]), send });
  await tick();
  stdin.write("y");
  await tick();
  expect(lines(lastFrame())).toContain("#16 is an Idea, so there is nothing to approve.");
});

test("a long answer shows its first four lines", async () => {
  const { send } = cli({
    code: 1,
    out: ["Approved #11, but the merge failed.", "Why:", "one", "two", "three", "four"],
    err: [],
  });
  const { lastFrame, stdin } = open({ load: loaded([mergeToApprove]), send });
  await tick();
  stdin.write("y");
  await tick();
  stdin.write("y");
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toContain("two");
  expect(shown).not.toContain("three");
  expect(shown).toContain("See the rest with: skelcrew log 11");
});

test("while a command runs, the screen says so, and other actions wait", async () => {
  let finish = (_: Outcome) => {};
  const sent: string[][] = [];
  const send = (args: string[]) => {
    sent.push(args);
    return new Promise<Outcome>((resolve) => {
      finish = resolve;
    });
  };
  const { lastFrame, stdin } = open({ load: loaded([specToApprove, idea]), send });
  await tick();
  stdin.write("y");
  await tick();
  expect(lines(lastFrame())).toContain("Approving #14…");
  stdin.write("j");
  stdin.write("s");
  await tick();
  expect(sent).toEqual([["approve", "14"]]);
  expect(lines(lastFrame())).toContain("Wait for #14 first.");
  finish(said("Approved #14."));
  await tick();
  expect(lines(lastFrame())).toContain("Approved #14.");
});

test("after a command, the list is loaded again at once", async () => {
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { ok: true as const, tasks: [specToApprove] };
  };
  const { stdin } = open({ load, send: cli().send });
  await tick();
  const before = loads;
  stdin.write("y");
  await tick();
  expect(loads).toBe(before + 1);
});

test("the next key clears what the last command said", async () => {
  const { send } = cli(said("Approved #14."));
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), send });
  await tick();
  stdin.write("y");
  await tick();
  stdin.write("j");
  await tick();
  expect(lines(lastFrame())).not.toContain("Approved #14.");
});
