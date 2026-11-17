// The marks: how a thread's state shows wherever it is listed, as a mark, a colour and a word,
// and the counts the sidebar's entries and the tabs' badges give. Any list of threads uses them.
import { type Status, statusOf, threadWord } from "./status.ts";
import type { Thread } from "./thread.ts";

// The colours a mark can have, by what they mean rather than how a screen draws them.
export type Colour = "green" | "yellow" | "red" | "bright" | "dim";
// A thread's mark: filled when the thread needs you, hollow when it doesn't, and its colour.
export type Mark = { sign: "●" | "○"; colour: Colour };
// What a list shows of a thread's state: its word, its status as a host shows it, and its mark.
export type Shown = { word: string; status: Status; mark: Mark };

// Returns the mark for a thread's status and word. The shape says whether the thread needs you,
// and the colour what kind of state it is in. Red is wrong: the thread failed, its harness
// stopped on an error, or its review couldn't run. Green is approved and ready to merge, and
// yellow any other reason it needs you. Of the hollow ones, a working builder is bright and
// anything that only waits is dim. A review under way shows as waiting even while the builder
// works too, so the row tells you the PR is in review.
export function markOf(status: Status, word: string): Mark {
  if (status === "error" || word === "review failed") return { sign: "●", colour: "red" };
  if (status === "ready") return { sign: "●", colour: "green" };
  if (status === "needs you") return { sign: "●", colour: "yellow" };
  if (word === "reviewing" || word === "queued for review") return { sign: "○", colour: "dim" };
  return { sign: "○", colour: status === "working" ? "bright" : "dim" };
}

// Returns what a list shows of a thread: its word, given the rounds of changes it may have, its
// status and its mark.
export function shownOf(thread: Thread, maxRounds: number, now = Date.now()): Shown {
  const word = threadWord(thread, maxRounds, now);
  const status = statusOf(thread, maxRounds, now);
  return { word, status, mark: markOf(status, word) };
}

// Returns whether a mark says the thread needs you for something other than merging: a
// decision, an answer, or something that went wrong. An approved thread is ready, not this.
export const needsDecision = (mark: Mark) => mark.sign === "●" && mark.colour !== "green";

// Returns whether a mark says the thread is approved and ready to merge.
export const readyToMerge = (mark: Mark) => mark.colour === "green";

// Returns a repository's badge from its threads' marks: how many are filled, and the colour of
// the most urgent of them, red, then yellow, then green, or null when none is.
export function badgeOf(marks: Mark[]): { count: number; colour: Colour | null } {
  const filled = marks.filter((mark) => mark.sign === "●");
  const urgent: Colour[] = ["red", "yellow", "green"];
  const colour = urgent.find((c) => filled.some((mark) => mark.colour === c)) ?? null;
  return { count: filled.length, colour };
}
