// A task's own screen shows a turning spinner before its state while an
// agent works on it, so it is clear the task is under way.

import { expect, test } from "bun:test";
import type { TaskView } from "../cli/status";
import { lines, loaded, open, task, tick } from "./testing";

const ENTER = "\r";
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

const building = task(12, "Settings page", "in_progress", { session: "you-2", step: "running" });

// The header line of the task's own screen, opened on the one task given.
async function header(shown: TaskView, spinMs = 1000) {
  const screen = open({ load: loaded([shown]), spinMs });
  await tick();
  screen.stdin.write(ENTER);
  await tick();
  return { screen, first: () => lines(screen.lastFrame())[0] ?? "" };
}

test("while an agent builds the task, a spinner turns before its state", async () => {
  const { first } = await header(building, 10);
  expect(first()).toMatch(/^#12 Settings page [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] In progress · you-2$/);
  const seen = new Set<string>();
  for (const _ of [1, 2, 3, 4, 5]) {
    seen.add(first().match(SPINNER)?.[0] ?? "");
    await tick(15);
  }
  expect(seen.size).toBeGreaterThan(1);
});

test("while an agent writes the spec, the spinner turns too", async () => {
  const writing = task(13, "Linear import", "spec", { session: "you-3", step: "running" });
  const { first } = await header(writing);
  expect(first()).toMatch(/^#13 Linear import [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Spec · you-3$/);
});

test("no spinner shows when no agent works on the task", async () => {
  const still: TaskView[] = [
    task(16, "Keyboard help", "idea"),
    task(14, "CSV export", "spec", { waitingOnYou: "spec_approval" }),
    task(15, "Rate limit", "ready", { step: "queued" }),
    // The agent waits for your answer.
    task(18, "Pick a format", "spec", {
      session: "you-4",
      step: "running",
      question: "CSV or Markdown?",
      waitingOnYou: "answer",
    }),
    // The agent waits while the checks run.
    task(19, "Retry on 429", "checks", { session: "you-5", step: "gate" }),
  ];
  for (const shown of still) {
    const { first } = await header(shown);
    expect(first()).not.toMatch(SPINNER);
  }
});

test("the list shows no spinner, even for a task an agent works on", async () => {
  const { lastFrame } = open({ load: loaded([building]), spinMs: 10 });
  await tick(50);
  expect(lastFrame()).not.toMatch(SPINNER);
});
