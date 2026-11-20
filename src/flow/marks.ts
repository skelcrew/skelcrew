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
// and the colour what kind of state it is in. Red is wrong: its harness stopped on an error,
// which needs you, or the thread failed or its review, submit or check couldn't run, which the
// lead can start or run again, so those marks are hollow. Green is approved and ready to merge, and
// yellow any other reason it needs you. Of the hollow ones, a working builder is bright and
// anything that only waits is dim. A review under way, or one held on its harness's usage limit,
// shows as waiting even while the builder works too, as the word then says what the thread
// waits on.
export function markOf(status: Status, word: string): Mark {
  // A thread that failed is the lead's to start again, so it doesn't need you unless marked, and
  // then its word is the mark. A review, submit or check that failed is the lead's to run again.
  if (status === "error") return { sign: word === "failed" ? "○" : "●", colour: "red" };
  // Needing you comes before the words below, as a mark from the lead or you can read like one
  // of them, such as "review failed", and is still an action for you. Without a mark, none of
  // those words comes with needing you.
  if (status === "needs you") return { sign: "●", colour: "yellow" };
  const failed = ["review failed", "review timed out", "submit failed", "check failed"];
  if (failed.includes(word)) return { sign: "○", colour: "red" };
  if (status === "ready") return { sign: "●", colour: "green" };
  // Approved, or not reviewed as its flow has no review stage, with a merge armed, it merges by
  // itself, so it is good news that waits on nobody.
  if (word === "approved" || word === "not reviewed") return { sign: "○", colour: "green" };
  const waits = word === "reviewing" || word === "queued for review" || word.startsWith("limit");
  if (waits) return { sign: "○", colour: "dim" };
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

// Returns whether a mark says the thread is approved and waits for you to merge it.
export const readyToMerge = (mark: Mark) => mark.sign === "●" && mark.colour === "green";

// A repository's badge: how many of its threads need you, in red when any of them went wrong
// and yellow otherwise, and how many are ready to merge, in green.
export type Badge = { needYou: number; colour: "red" | "yellow"; ready: number };

// Returns a repository's badge from its threads' marks. Needing you and being ready are counted
// apart, as one is a decision and the other a merge, so a finished thread is never told twice.
export function badgeOf(marks: Mark[]): Badge {
  const needing = marks.filter(needsDecision);
  const colour = needing.some((mark) => mark.colour === "red") ? "red" : "yellow";
  return { needYou: needing.length, colour, ready: marks.filter(readyToMerge).length };
}
