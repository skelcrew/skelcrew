// The lists: what the right pane shows on landing on the sidebar's Issues, Threads or PRs entry,
// in groups, and the counts beside those entries. Read from Skelcrew's database and its copy of
// the tracker, never the tracker itself, as the sidebar and an open list read them each second.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { threadConfig } from "../config.ts";
import { type Item, itemAt, openPrs, openTasks } from "../flow/copy.ts";
import { repositories } from "../flow/repo.ts";
import { needsYou, Thread, threadName } from "../flow/thread.ts";
import { forgeOf, trackerOf } from "../plugins/ask.ts";
import { grey, red, yellow } from "./look.ts";
import { type Open, threadMark, threadWord } from "./rows.ts";

// The three entries of the sidebar, each of which shows a list.
export type Entry = "issues" | "threads" | "prs";
// One row of a list. Its mark's colour is null when it is plain. `ends` are the columns after
// its title, each in its colour. An issue or PR has the `link` its page opens, and a thread the
// `session` its agent runs in. A stopped thread is `dim`, as it can't be opened.
export type ListRow = {
  mark: [string, number | null];
  name: string;
  title: string;
  ends: [string, number][];
  link: string | null;
  session: string | null;
  dim: boolean;
};
// Rows under a dim heading, such as Ready to merge.
export type Group = { heading: string; rows: ListRow[] };
// An entry of the sidebar: its name, how many its list has, and a note on what you act on,
// such as 2 ready, in yellow when it is `warn`.
export type EntryCount = { entry: Entry; name: string; total: number; note: string; warn: boolean };

// A thread that isn't done, as the lists know it: with its name and the word that says what it
// is doing.
type Known = { thread: Thread; name: string; word: string };

// Returns a thread's round limit, from its repository's skelcrew.yaml or your config. Settings
// that aren't valid already stop rounds, with the reason, and mustn't also take the sidebar or a
// list away. Such a thread then reads as never past the limit.
export function roundLimit(thread: Thread): number {
  try {
    return threadConfig(thread).maxRounds;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Returns the open repository's threads that aren't done, newest first, each with its name and
// word.
function openThreads(db: Database, open: Open): Known[] {
  const found = db.query(`SELECT * FROM threads
      WHERE status != 'done' AND owner = ? AND repo = ? ORDER BY rowid DESC`);
  return found.all(open.owner, open.repo).map((row) => {
    const thread = Thread.parse(row);
    return { thread, name: threadName(db, thread), word: threadWord(thread, roundLimit(thread)) };
  });
}

// Says whether a thread shows as needing you. A thread that failed can still have its needs you
// flag, and its word says failed.
const needing = ({ thread }: Known) => needsYou(thread) && thread.status !== "failed";

// Returns a thread's word as the end of a row, yellow when it needs you and dim otherwise.
const wordEnd = (open: Known): [string, number] => [open.word, needing(open) ? yellow : grey];

// Returns the repository's name in Skelcrew, which names its issues and PRs, such as app-12.
function repositoryName(db: Database, open: Open): string {
  const row = db
    .query("SELECT name FROM repositories WHERE owner = ? AND repo = ?")
    .get(open.owner, open.repo);
  return z.object({ name: z.string() }).nullable().parse(row)?.name ?? open.repo;
}

// Returns the open groups only, as a group with nothing in it isn't shown.
const filled = (groups: Group[]) => groups.filter((group) => group.rows.length > 0);

// Returns the open repository's issues, as `Not started`, the ones no thread works on, then
// `Started`. An issue's mark is ○ with no thread, ◐ while its thread works on it and ● once its
// thread is approved and waits for you to merge. The marks are plain, as an issue never needs
// you on its own. One with a thread ends with its word. A thread that is done is over, so its
// issue counts as not started again.
function issueGroups(db: Database, open: Open, threads: Known[]): Group[] {
  const name = repositoryName(db, open);
  const rows = openTasks(db, open.owner, open.repo).map((task) => {
    const on = threads.find(({ thread }) => thread.task === task.id);
    const sign = !on ? "○" : on.word === "approved" ? "●" : "◐";
    const row: ListRow = {
      mark: [sign, null],
      name: `${name}-${task.id}`,
      title: task.title,
      ends: on ? [wordEnd(on)] : [],
      link: task.link,
      session: null,
      dim: false,
    };
    return { row, started: on !== undefined };
  });
  return filled([
    { heading: "Not started", rows: rows.filter((r) => !r.started).map((r) => r.row) },
    { heading: "Started", rows: rows.filter((r) => r.started).map((r) => r.row) },
  ]);
}

// Says whether the forge says a PR Skelcrew didn't open is approved and every check passed. As on
// GitHub, each reviewer's latest approval or request for changes stands until a dismissal clears
// it, and a comment changes nothing. The PR is approved when someone approves and nobody asks
// for changes.
function approvedOnForge(pr: Extract<Item, { kind: "pr" }>): boolean {
  const standing = new Map<string, string>();
  for (const { author, verdict } of pr.reviews) {
    const who = author?.login ?? "";
    if (verdict === "dismissed") standing.delete(who);
    else if (verdict !== "commented") standing.set(who, verdict);
  }
  const verdicts = [...standing.values()];
  return (
    verdicts.includes("approved") &&
    !verdicts.includes("changes requested") &&
    pr.checks.every((check) => check.state === "passed")
  );
}

// Returns the open repository's PRs, as `Ready to merge`, then `In review`. A PR's mark is ○
// before its first review, ◐ from the moment it runs while the rounds go on, and ● once it is approved and its checks
// pass. A PR Skelcrew didn't open has no rounds, so it is ○ until the forge says it is approved
// and its checks pass. A PR from a thread takes the thread's yellow when it needs you, or red
// when it failed, and ends with its word. One with no thread ends with its author.
function prGroups(db: Database, open: Open, threads: Known[]): Group[] {
  const name = repositoryName(db, open);
  const rows = openPrs(db, open.owner, open.repo).map((pr) => {
    const on = threads.find(({ thread }) => thread.pr === Number(pr.id));
    const ready = on ? on.word === "approved" : approvedOnForge(pr);
    // A review under way counts as a round going on, the first one included.
    const reviewed = on && (on.thread.review_round !== null || on.word === "reviewing");
    const sign = ready ? "●" : reviewed ? "◐" : "○";
    const colour = !on ? null : on.thread.status === "failed" ? red : needing(on) ? yellow : null;
    const row: ListRow = {
      mark: [sign, colour],
      name: `${name}#${pr.id}`,
      title: pr.title,
      ends: [on ? wordEnd(on) : [pr.author?.login ?? "", grey]],
      link: pr.link,
      session: null,
      dim: false,
    };
    return { row, ready };
  });
  return filled([
    { heading: "Ready to merge", rows: rows.filter((r) => r.ready).map((r) => r.row) },
    { heading: "In review", rows: rows.filter((r) => !r.ready).map((r) => r.row) },
  ]);
}

// Returns when a thread last changed as a clock time for a moment today, such as 14:32, and as
// a date for an earlier one, such as 12 Nov, in this machine's time zone. It changes only when
// the thread does, or at midnight, so a list left open writes nothing.
export function changedAt(at: number, now: number): string {
  const when = new Date(at);
  if (when.toDateString() === new Date(now).toDateString())
    return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return `${when.getDate()} ${when.toLocaleString("en-GB", { month: "short" })}`;
}

// Returns the open repository's threads that aren't done, as `Needs you`, those that need you
// or failed, then `Working`, every other one working or waiting, then `Stopped`. Each ends with
// its word, harness, its issue and PR if it has them, such as #12 #31, and when it last changed.
// A stopped thread's agent isn't running, so its row is dim.
function threadGroups(threads: Known[], now: number): Group[] {
  const rows = threads.map((open) => {
    const { thread, word } = open;
    // Only a review is on another harness, and a thread with no harness saved started before
    // Skelcrew saved it, when builders ran only on Claude Code. A thread with no issue in the
    // tracker has a task such as t1.
    const harness = word === "reviewing" ? (thread.reviewer ?? "") : (thread.harness ?? "claude");
    const issue = /^t\d+$/.test(thread.task) ? "" : `#${thread.task}`;
    const refs = [issue, thread.pr === null ? "" : `#${thread.pr}`].filter(Boolean).join(" ");
    const changed = thread.changed ?? thread.started;
    const row: ListRow = {
      mark: threadMark({ status: thread.status, needsYou: needsYou(thread) }),
      name: open.name,
      title: thread.title ?? "",
      ends: [
        wordEnd(open),
        [harness, grey],
        [refs, grey],
        [changed === null ? "" : changedAt(changed, now), grey],
      ],
      link: null,
      session: thread.folder,
      dim: thread.status === "stopped",
    };
    return { row, open };
  });
  const stopped = (r: (typeof rows)[number]) => r.open.thread.status === "stopped";
  const urgent = (r: (typeof rows)[number]) => needing(r.open) || r.open.thread.status === "failed";
  return filled([
    { heading: "Needs you", rows: rows.filter(urgent).map((r) => r.row) },
    { heading: "Working", rows: rows.filter((r) => !urgent(r) && !stopped(r)).map((r) => r.row) },
    { heading: "Stopped", rows: rows.filter(stopped).map((r) => r.row) },
  ]);
}

// Returns an entry's list for the open repository, in its groups, at a moment in milliseconds.
export function listGroups(db: Database, open: Open, entry: Entry, now: number): Group[] {
  const threads = openThreads(db, open);
  if (entry === "issues") return issueGroups(db, open, threads);
  if (entry === "prs") return prGroups(db, open, threads);
  return threadGroups(threads, now);
}

// Returns the sidebar's entries for the open repository, with their counts: Issues when it has a
// tracker, Threads always, and PRs when it has a forge. Issues says how many have no thread yet,
// Threads how many need you or failed, and PRs how many are ready to merge. These last two are
// yellow and only there when there are any.
export function entryCounts(db: Database, open: Open): EntryCount[] {
  const repository = repositories(db).find((r) => r.owner === open.owner && r.repo === open.repo);
  const threads = openThreads(db, open);
  // Returns how many rows a list has, and how many under its first heading if that is `first`.
  const count = (groups: Group[], first: string) => ({
    total: groups.reduce((sum, group) => sum + group.rows.length, 0),
    flagged: groups[0]?.heading === first ? groups[0].rows.length : 0,
  });
  const issues = count(repository ? issueGroups(db, open, threads) : [], "Not started");
  const ours = count(threadGroups(threads, 0), "Needs you");
  const prs = count(repository ? prGroups(db, open, threads) : [], "Ready to merge");
  const needYou = ours.flagged === 1 ? "needs you" : "need you";
  const issuesEntry: EntryCount = {
    entry: "issues",
    name: "Issues",
    total: issues.total,
    note: issues.flagged ? `${issues.flagged} new` : "",
    warn: false,
  };
  const threadsEntry: EntryCount = {
    entry: "threads",
    name: "Threads",
    total: ours.total,
    note: ours.flagged ? `${ours.flagged} ${needYou}` : "",
    warn: true,
  };
  const prsEntry: EntryCount = {
    entry: "prs",
    name: "PRs",
    total: prs.total,
    note: prs.flagged ? `${prs.flagged} ready` : "",
    warn: true,
  };
  return [
    ...(repository && trackerOf(db, repository) ? [issuesEntry] : []),
    threadsEntry,
    ...(repository && forgeOf(db, repository) ? [prsEntry] : []),
  ];
}

// Returns the name and title of the issue or PR at a link, as the strip shows a page, or null
// when Skelcrew's copy has nothing there.
export function pageRow(
  db: Database,
  open: Open,
  link: string,
): { name: string; title: string } | null {
  const item = itemAt(db, link);
  if (!item) return null;
  const name = repositoryName(db, open);
  return { name: `${name}${item.kind === "task" ? "-" : "#"}${item.id}`, title: item.title };
}
