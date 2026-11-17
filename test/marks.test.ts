// The marks: a thread's mark, colour and word, and the counts the entries and tab badges give.
import { expect, test } from "bun:test";
import { badgeOf, markOf, needsDecision, readyToMerge } from "../src/flow/marks.ts";

test("a filled mark means the thread needs you, and its colour says what kind", () => {
  expect(markOf("ready", "approved")).toEqual({ sign: "●", colour: "green" });
  for (const word of ["question", "round limit", "turn ended", "review timed out", "needs you"])
    expect(markOf("needs you", word)).toEqual({ sign: "●", colour: "yellow" });
  expect(markOf("error", "failed")).toEqual({ sign: "●", colour: "red" });
  expect(markOf("error", "error")).toEqual({ sign: "●", colour: "red" });
  expect(markOf("needs you", "review failed")).toEqual({ sign: "●", colour: "red" });
});

test("a hollow mark is bright while the builder works, and dim while the thread waits", () => {
  expect(markOf("working", "working")).toEqual({ sign: "○", colour: "bright" });
  for (const word of ["checks", "changes", "limit · 13:59", "stopped"])
    expect(markOf("idle", word)).toEqual({ sign: "○", colour: "dim" });
});

test("a review under way is dim even while the builder works at the same time", () => {
  expect(markOf("working", "reviewing")).toEqual({ sign: "○", colour: "dim" });
  expect(markOf("working", "queued for review")).toEqual({ sign: "○", colour: "dim" });
});

test("an approved thread counts as ready, not as needing you", () => {
  const approved = markOf("ready", "approved");
  expect(readyToMerge(approved)).toBe(true);
  expect(needsDecision(approved)).toBe(false);
  expect(needsDecision(markOf("needs you", "question"))).toBe(true);
  expect(needsDecision(markOf("error", "failed"))).toBe(true);
  expect(needsDecision(markOf("working", "working"))).toBe(false);
});

test("a badge counts the filled marks, in the colour of the most urgent", () => {
  const [green, yellow, red, bright] = [
    markOf("ready", "approved"),
    markOf("needs you", "question"),
    markOf("error", "error"),
    markOf("working", "working"),
  ];
  expect(badgeOf([])).toEqual({ count: 0, colour: null });
  expect(badgeOf([bright])).toEqual({ count: 0, colour: null });
  expect(badgeOf([green, bright])).toEqual({ count: 1, colour: "green" });
  expect(badgeOf([green, yellow])).toEqual({ count: 2, colour: "yellow" });
  expect(badgeOf([yellow, red, green])).toEqual({ count: 3, colour: "red" });
});
