// A harness's usage limit: when the reviews held on it may run again, telling each lead once
// when it is reached and once when it is over, and waking a builder that stopped on one.
import type { Database } from "bun:sqlite";
import { type HarnessName, harnessNamed } from "../agents/harness.ts";
import { typeInto } from "../agents/typing.ts";
import { errorText } from "../say.ts";
import { noteForLead } from "./lead.ts";
import { builderHarness, readThread, record } from "./thread.ts";

// How long to wait when the harness gave no reset time: 15 minutes after the first try that
// met the limit, 30 after the second, and an hour after each one since.
const backoff = [15, 30, 60].map((minutes) => minutes * 60_000);

// A harness's limit: when its reviews may run again, the reset time it gave, if any, how many
// tries in a row met the limit with no reset time, and the repositories whose leads were told.
type Limit = { until: number; reset: number | null; tries: number; told: Set<string> };
// Each harness's limit, from the first review that met it until one runs on it again. Kept in
// the daemon alone: after a restart, the first review to meet the limit again finds it.
const limits = new Map<HarnessName, Limit>();

// Returns the wait after the `tries`-th try in a row that met a limit with no reset time.
const backoffAfter = (tries: number) => backoff[Math.min(tries, backoff.length) - 1] ?? 0;

// Returns a moment as this machine's clock shows it, such as 13:59, with its day before it,
// such as 17 Nov 13:59, when it isn't today. For the sidebar, the lists and the lead's notes.
export function clockTime(at: number, now: number): string {
  const when = new Date(at);
  const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  if (when.toDateString() === new Date(now).toDateString()) return time;
  return `${when.getDate()} ${when.toLocaleString("en-GB", { month: "short" })} ${time}`;
}

// Returns the harness's limit while reviews on it must wait, or null once they may run, such
// as after its reset time, when the next review tries it again.
export function limitOn(harness: HarnessName, now: number): Limit | null {
  const limit = limits.get(harness);
  return limit !== undefined && limit.until > now ? limit : null;
}

// Saves that a review on the harness met its usage limit, so no review starts on it before
// `reset`. A reset in the minute just gone, as a clock showing only minutes gives, is tried
// again a minute on, so a limit that hasn't quite reset isn't tried again and again. With no
// reset time, reviews try again after a wait that grows with each try that meets the limit.
export function reachLimit(harness: HarnessName, reset: number | null, now: number): void {
  const before = limits.get(harness);
  const tries = reset === null ? (before?.tries ?? 0) + 1 : 0;
  const after = reset === null ? now + backoffAfter(tries) : now + 60_000;
  limits.set(harness, {
    until: reset !== null && reset > now ? reset : after,
    reset,
    tries,
    told: before?.told ?? new Set(),
  });
}

// Forgets the harness's limit once a review ran on it, and tells each lead that heard of the
// limit that it is over.
export function endLimit(db: Database, tmux: string, harness: HarnessName): void {
  const limit = limits.get(harness);
  if (limit === undefined) return;
  limits.delete(harness);
  const { title } = harnessNamed(harness);
  for (const fullName of limit.told) {
    const [owner = "", repo = ""] = fullName.split("/");
    noteForLead(
      db,
      tmux,
      { owner, repo },
      `${title}'s usage limit is over; reviews run on it again.`,
    );
  }
}

// Tells the repository's lead that the harness's usage limit holds its reviews, once for each
// limit, however many of its threads wait on it. Says when reviews go on, and where they run
// meanwhile when there is a `fallback`.
export function tellOfLimit(
  db: Database,
  tmux: string,
  harness: HarnessName,
  repository: { owner: string; repo: string },
  fallback: HarnessName | null,
): void {
  // Each lead hears of a limit once.
  const limit = limits.get(harness);
  const fullName = `${repository.owner}/${repository.repo}`;
  if (limit === undefined || limit.told.has(fullName)) return;
  limit.told.add(fullName);
  // Say until when, or when reviews try again if the harness gave no time.
  const now = Date.now();
  const { title } = harnessNamed(harness);
  const at = clockTime(limit.until, now);
  const reached =
    limit.reset === null
      ? `${title}'s usage limit is reached, with no reset time given`
      : `${title}'s usage limit is reached until ${at}`;
  const meanwhile = limit.reset === null ? "meanwhile" : "until then";
  const then =
    fallback !== null
      ? `reviews run on ${harnessNamed(fallback).title} ${meanwhile}`
      : limit.reset === null
        ? `reviews try again at ${at}`
        : "reviews resume then";
  noteForLead(db, tmux, repository, `${reached}; ${then}.`);
}

// Returns once `at` comes, or at once when `signal` aborts, such as when a newer round cancels
// a review held on a usage limit.
export function waitUntil(at: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const cancel = runAt(at, done);
    signal.addEventListener("abort", () => {
      cancel();
      done();
    });
  });
}

// The longest a timer can wait: one set for longer fires at once instead.
const longestTimer = 2 ** 31 - 1;

// Runs `run` once `at` comes, and returns what cancels it. A weekly limit, or a reset dated a
// year ahead, can be further off than a timer can wait, so a long wait is taken in steps.
function runAt(at: number, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    const left = at - Date.now();
    if (left <= 0) return run();
    timer = setTimeout(step, Math.min(left, longestTimer));
  };
  step();
  return () => clearTimeout(timer);
}

// The wake planned for each builder that stopped on its harness's usage limit, by its thread's
// folder, and how many waits in a row had no reset time, so the wait grows.
const wakes = new Map<string, () => void>();
const builderTries = new Map<string, number>();

// Plans to type "continue" into the thread's builder once its harness's usage limit resets, or,
// with no reset time, after a wait that grows each time the limit stops it again. The builder
// sits idle on the error until then, and nobody needs to type to it. A builder you typed to
// meanwhile, or that stopped, is left alone.
export function wakeAfterLimit(db: Database, tmux: string, folder: string): void {
  // Find when: the reset time, or the next wait with none.
  const now = Date.now();
  const { limit_reset: reset } = readThread(db, folder);
  let at = reset ?? 0;
  if (at <= now) {
    const tries = (builderTries.get(folder) ?? 0) + 1;
    builderTries.set(folder, tries);
    at = now + backoffAfter(tries);
  } else builderTries.delete(folder);
  // One wake per builder: a newer limit replaces the one planned.
  wakes.get(folder)?.();
  const cancel = runAt(at, () => {
    wakes.delete(folder);
    continueBuilder(db, tmux, folder).catch((error) =>
      console.log(`couldn't wake ${folder}'s builder after its usage limit: ${errorText(error)}`),
    );
  });
  wakes.set(folder, cancel);
}

// Types "continue" into a builder still idle on its harness's usage limit. The flags are cleared
// first: a builder that meets the limit again sets them again as its turn ends.
async function continueBuilder(db: Database, tmux: string, folder: string): Promise<void> {
  const thread = readThread(db, folder);
  if (!thread.erred || !thread.limited || thread.status !== "working") return;
  const change = { erred: false, limited: false, limit_reset: null };
  record(db, folder, change, "its harness's usage limit reset, so Skelcrew typed continue");
  await typeInto(tmux, folder, builderHarness(thread).marks, "continue", { timeout: 60_000 });
}
