// A harness's usage limit: when the reviews held on it may run again, telling each lead once
// when it is reached and once when it is over, and waking a builder that stopped on one.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { HarnessName, harnessNamed } from "../agents/harness.ts";
import { typeInto } from "../agents/typing.ts";
import { errorText } from "../say.ts";
import { noteForLead, typeLeadNotes } from "./lead.ts";
import { builderHarness, readThread, record } from "./thread.ts";

// How long to wait when the harness gave no reset time: 15 minutes after the first try that
// met the limit, 30 after the second, and an hour after each one since.
const backoff = [15, 30, 60].map((minutes) => minutes * 60_000);

// A harness's limit: when its reviews may run again, the reset time it gave, if any, how many
// tries in a row met the limit with no reset time, the repositories whose leads were told, and
// when a review last met it. That moment isn't saved: no run from before a restart ends after.
type Limit = {
  until: number;
  reset: number | null;
  tries: number;
  told: Set<string>;
  reached: number;
};
// Each harness's limit, from the first review that met it until one runs on it again. Each
// change is saved in the database too, and restoreLimits reads them back when the daemon starts,
// so a restart neither runs a limited harness early nor tells the leads again.
const limits = new Map<HarnessName, Limit>();

// A limit as the database keeps it, checked as it is read back. `told` is a JSON list.
const LimitRow = z.object({
  harness: HarnessName,
  until: z.number(),
  reset: z.number().nullable(),
  tries: z.number(),
  told: z.string().transform((saved) => z.array(z.string()).parse(JSON.parse(saved))),
});

// Saves the harness's limit as it now is in the daemon, or removes it once it has none.
function saveLimit(db: Database, harness: HarnessName): void {
  const limit = limits.get(harness);
  if (limit === undefined) {
    db.run("DELETE FROM limits WHERE harness = ?", [harness]);
    return;
  }
  db.run(
    "INSERT OR REPLACE INTO limits (harness, until, reset, tries, told) VALUES (?, ?, ?, ?, ?)",
    [harness, limit.until, limit.reset, limit.tries, JSON.stringify([...limit.told])],
  );
}

// Reads back the limits the database saved, for the daemon's start, before any held review
// carries on.
export function restoreLimits(db: Database): void {
  for (const row of db.query("SELECT * FROM limits").all()) {
    const { harness, until, reset, tries, told } = LimitRow.parse(row);
    limits.set(harness, { until, reset, tries, told: new Set(told), reached: 0 });
  }
}

// Returns the wait after the `tries`-th try in a row that met a limit with no reset time.
const backoffAfter = (tries: number) => backoff[Math.min(tries, backoff.length) - 1] ?? 0;

// Returns a moment as this machine's clock shows it, such as 13:59, with its day before it,
// such as 17 Nov 13:59, when it isn't today. For the sidebar, the lists and the lead's notes.
export function clockTime(at: number, now: number): string {
  const when = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  const time = `${two(when.getHours())}:${two(when.getMinutes())}`;
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
// `reset`. A new reset time is news, so the leads are told again. A reset in the minute just
// gone, as a clock showing only minutes gives, is tried again a minute on, so a limit that
// hasn't quite reset isn't tried again and again. The same past reset given again means the
// limit hasn't reset, such as when the harness's clock runs ahead of this machine's, so it is
// treated as no reset time. With none, reviews try again after a wait that grows with each try
// that meets the limit.
export function reachLimit(
  db: Database,
  harness: HarnessName,
  reset: number | null,
  now: number,
): void {
  const before = limits.get(harness);
  const stale = reset !== null && reset <= now && before?.reset === reset;
  const tries = reset === null || stale ? (before?.tries ?? 0) + 1 : 0;
  const after = tries > 0 ? now + backoffAfter(tries) : now + 60_000;
  limits.set(harness, {
    until: reset !== null && reset > now ? reset : after,
    reset,
    tries,
    told: before !== undefined && before.reset === reset ? before.told : new Set(),
    reached: now,
  });
  saveLimit(db, harness);
}

// Forgets the harness's limit once a review that `started` after a review met it ran on it, and
// tells each lead that heard of the limit that it is over. A review that started before can
// end cleanly after the limit, as its last call came before it, which says nothing of the limit.
export function endLimit(db: Database, tmux: string, harness: HarnessName, started: number): void {
  const limit = limits.get(harness);
  if (limit === undefined || started < limit.reached) return;
  limits.delete(harness);
  saveLimit(db, harness);
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
  saveLimit(db, harness);
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
// folder, which cancels both the wait and the typing of "continue", and how many waits in a row
// had no reset time, so the wait grows, with when it was last woken.
const wakes = new Map<string, () => void>();
const builderTries = new Map<string, Wakes>();

// What a builder's wakes so far were: how many waits in a row had no reset time to go by, when
// it was last woken, and the reset time, already past, it was last woken for.
export type Wakes = { tries: number; woken: number; reset: number | null };

// Decides when to wake a builder its harness's usage limit stopped, given the reset time the
// harness gave, if any, and its wakes so far. Returns the moment, and its wakes from then on.
// - A reset still to come is when.
// - A reset already past wakes it at once, such as after a restart, or at the end of the reset's
//   minute when that is still to come, as a clock showing only minutes names a whole minute.
// - With no reset time, or the same past one again after a wake, the wait is 15 minutes, then
//   30, then an hour. A builder that worked an hour since it was last woken got past that
//   limit, so the wait starts short again.
export function wakeTime(
  reset: number | null,
  now: number,
  before: Wakes | undefined,
): { at: number; wakes: Wakes | undefined } {
  if (reset !== null && reset > now) return { at: reset, wakes: undefined };
  const woken = before?.woken ?? now;
  if (reset !== null && before?.reset !== reset)
    return { at: Math.max(now, reset + 60_000), wakes: { tries: 0, woken, reset } };
  const recovered = before === undefined || now - before.woken > 60 * 60_000;
  const tries = recovered ? 1 : before.tries + 1;
  return { at: now + backoffAfter(tries), wakes: { tries, woken, reset } };
}

// Cancels the wake planned for the thread's builder, for when the error it was planned for ends:
// you typed to the builder, it stopped, or it met another error. Typing still waiting for the
// builder to be idle is cancelled too, so a stale "continue" never lands.
export function endWake(folder: string): void {
  wakes.get(folder)?.();
  wakes.delete(folder);
}

// Plans to type "continue" into the thread's builder once its harness's usage limit resets, or,
// with no reset time, after a wait that grows each time the limit stops it again. The builder
// sits idle on the error until then, and nobody needs to type to it.
export function wakeAfterLimit(db: Database, tmux: string, folder: string): void {
  // Find when, and remember the wakes so far.
  const { limit_reset: reset } = readThread(db, folder);
  const { at, wakes: next } = wakeTime(reset, Date.now(), builderTries.get(folder));
  if (next === undefined) builderTries.delete(folder);
  else builderTries.set(folder, next);
  // One wake per builder: a newer limit replaces the one planned.
  endWake(folder);
  const typing = new AbortController();
  const cancelWait = runAt(at, () => {
    const tried = builderTries.get(folder);
    if (tried !== undefined) builderTries.set(folder, { ...tried, woken: Date.now() });
    continueBuilder(db, tmux, folder, typing.signal)
      .catch((error) =>
        console.log(`couldn't wake ${folder}'s builder after its usage limit: ${errorText(error)}`),
      )
      .finally(() => {
        if (wakes.get(folder) === cancel) wakes.delete(folder);
      });
  });
  const cancel = () => {
    cancelWait();
    typing.abort();
  };
  wakes.set(folder, cancel);
}

// Types "continue" into a builder still idle on its harness's usage limit, whether the thread
// works or waits, such as on CI, since you can talk to a builder in either. The limit is cleared
// before typing, so the row never shows a limit that is over. Typing waits for the builder to be
// idle, and anything else typed to it meanwhile ends the wake, so "continue" never lands on
// top of it. A builder that couldn't be told is idle on its error with nobody to wake it, so
// the thread then needs you. Nothing happens once `signal` aborts, as the error it was for has
// ended.
async function continueBuilder(
  db: Database,
  tmux: string,
  folder: string,
  signal: AbortSignal,
): Promise<void> {
  const thread = readThread(db, folder);
  const live = thread.status === "working" || thread.status === "waiting";
  if (!live || !thread.erred || !thread.limited) return;
  const over = { erred: false, limited: false, limit_reset: null };
  record(db, folder, over, "its harness's usage limit reset, so Skelcrew types continue");
  try {
    const { marks } = builderHarness(thread);
    await typeInto(tmux, folder, marks, "continue", { timeout: 60_000, signal });
  } catch (error) {
    // A builder that met the limit again, or was typed to, since has a newer state to keep.
    if (signal.aborted || readThread(db, folder).erred) return;
    const reason = errorText(error);
    const why = `its harness's usage limit reset, but Skelcrew couldn't type continue: ${reason}`;
    record(db, folder, { erred: true }, why);
    typeLeadNotes(db, tmux);
  }
}
