// The lists: what the right pane shows on landing on the sidebar's Issues, Threads or PRs entry,
// in groups, and the counts beside those entries. Read from Skelcrew's database and its copy of
// the tracker, never the tracker itself, as the sidebar and an open list read them each second.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { roundLimit as roundLimitOf } from "../config.ts";
import { type Item, itemAt, openPrs, openTasks, ownTask } from "../flow/copy.ts";
import { needsDecision, readyToMerge, type Shown, shownOf } from "../flow/marks.ts";
import { agentsSaid } from "../flow/merging.ts";
import { repositories } from "../flow/repo.ts";
import type { DaemonRequest } from "../flow/requests.ts";
import { mergeShown } from "../flow/status.ts";
import { Thread, taskName, threadName } from "../flow/thread.ts";
import { forgeOf, trackerOf } from "../plugins/ask.ts";
import { green, grey, markColours, yellow } from "./look.ts";
import { type Open, onReviewer } from "./rows.ts";

// The three entries of the sidebar, each of which shows a list.
export type Entry = "issues" | "threads" | "prs";
// What s does on an issue's row, or m on a PR's row, on its list or its page: the question the
// line at the bottom of the pane asks first, what it says while the daemon works, and what the
// daemon is asked once you press y. On a row it can't act on, it says why instead, such as an
// issue a thread already works on.
export type Action =
  | { key: "s" | "m"; ask: string; working: string; request: DaemonRequest }
  | { key: "s" | "m"; refused: string };
// One row of a list. Its mark's colour is null when it is plain. `ends` are the columns after
// its title, each in its colour. An issue or PR has the `link` its page opens, and a thread the
// `session` its agent runs in. A stopped thread is `dim`, as it can't be opened. An issue or PR
// has the `action` s or m takes on it, and a thread none.
export type ListRow = {
  mark: [string, string | null];
  name: string;
  title: string;
  ends: [string, string][];
  link: string | null;
  session: string | null;
  dim: boolean;
  action: Action | null;
};
// Rows under a dim heading, such as Ready to merge.
export type Group = { heading: string; rows: ListRow[] };
// An entry of the sidebar: its name, how many its list has, and notes on what you act on, each
// with its colour, such as 2 ready in green.
export type EntryCount = {
  entry: Entry;
  name: string;
  total: number;
  notes: [string, string][];
};

// A thread that isn't done, as the lists know it: with its name, and its word, status and mark.
type Known = Shown & { thread: Thread; name: string };

// Returns a thread's round limit, from its repository's skelcrew.yaml or your config. Settings
// that aren't valid already stop rounds, with the reason, and mustn't also take the sidebar or a
// list away. Such a thread then reads as never past the limit.
export function roundLimit(thread: Thread): number {
  try {
    return roundLimitOf(thread);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Returns the open repository's threads that aren't done, newest first, each with its name,
// word, status and mark.
function openThreads(db: Database, open: Open): Known[] {
  const found = db.query(`SELECT * FROM task_threads
      WHERE status != 'done' AND owner = ? AND repo = ? ORDER BY rowid DESC`);
  return found.all(open.owner, open.repo).map((row) => {
    const thread = Thread.parse(row);
    return { thread, name: threadName(db, thread), ...shownOf(thread, roundLimit(thread)) };
  });
}

// Returns the colour a thread's mark is drawn in, as in ACTIVE.
const colourOf = (open: Known) => markColours[open.mark.colour];

// Returns a thread's word as the end of a row, in its mark's colour, as in ACTIVE.
const wordEnd = (open: Known): [string, string] => [open.word, colourOf(open)];

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
// s on an issue starts a thread on it, as sc start does, only while no thread works on it.
function issueGroups(db: Database, open: Open, threads: Known[]): Group[] {
  const name = repositoryName(db, open);
  const rows = openTasks(db, open.owner, open.repo).map((task) => {
    const on = threads.find(({ thread }) => thread.task === task.id);
    const sign = !on ? "○" : on.word === "approved" ? "●" : "◐";
    const action: Action = on
      ? { key: "s", refused: `${name}#${task.id} already has ${on.name}` }
      : {
          key: "s",
          ask: `Start a thread on ${name}#${task.id}? y/n`,
          working: `Starting ${taskName(name, task.id)}…`,
          request: { command: "start", repo: `${open.owner}/${open.repo}`, task: task.id },
        };
    const row: ListRow = {
      mark: [sign, null],
      name: taskName(name, task.id),
      title: task.title,
      ends: on ? [wordEnd(on)] : [],
      link: task.link,
      session: null,
      dim: false,
      action,
    };
    return { row, started: on !== undefined };
  });
  return filled([
    { heading: "Not started", rows: rows.filter((r) => !r.started).map((r) => r.row) },
    { heading: "Started", rows: rows.filter((r) => r.started).map((r) => r.row) },
  ]);
}

// Says whether the forge says a PR Skelcrew didn't open is approved. As on GitHub, each
// reviewer's latest approval or request for changes stands until a dismissal clears it, and a
// comment changes nothing. The PR is approved when someone approves and nobody asks for changes.
function approvedOnForge(pr: Extract<Item, { kind: "pr" }>): boolean {
  const standing = new Map<string, string>();
  for (const { author, verdict } of pr.reviews) {
    const who = author?.login ?? "";
    if (verdict === "dismissed") standing.delete(who);
    else if (verdict !== "commented") standing.set(who, verdict);
  }
  const verdicts = [...standing.values()];
  return verdicts.includes("approved") && !verdicts.includes("changes requested");
}

// Returns the open repository's PRs, as `Ready to merge`, then `In review`. A PR's mark is ○
// before its first review, ◐ from the moment it runs while the rounds go on, and ● once it is approved and its checks
// pass. A PR Skelcrew didn't open has no rounds, so it is ○ until the forge says it is approved
// and its checks pass. A PR from a thread takes its thread's colour when the thread's mark is
// filled: green when approved, yellow when it needs you, red when it failed or hit an error. A
// thread that is only working or waiting leaves the mark plain. A PR from a thread ends with its word,
// and one with no thread with its author.
// m merges a PR ready to merge, at the head commit the forge last sent, which is the one you saw
// approved. On any other PR it says what the PR waits on: an approval, or its checks.
function prGroups(db: Database, open: Open, threads: Known[]): Group[] {
  const name = repositoryName(db, open);
  const rows = openPrs(db, open.owner, open.repo).map((pr) => {
    const on = threads.find(({ thread }) => thread.pr === Number(pr.id));
    const approved = on ? on.thread.verdict === "approve" : approvedOnForge(pr);
    const passing = pr.checks.every((check) => check.state === "passed");
    const ready = on ? on.word === "approved" : approved && passing;
    const named = `${name}#${pr.id}`;
    let action: Action;
    if (!ready && !approved) action = { key: "m", refused: `${named} isn't approved yet` };
    else if (!ready) action = { key: "m", refused: `${named}'s checks haven't passed yet` };
    // A forge too old to send the head commit can't merge either, as it lacks the call too.
    else if (pr.head === null)
      action = {
        key: "m",
        refused: `${named} needs a newer forge plugin to merge here: run sc update -g`,
      };
    else
      action = {
        key: "m",
        ask: [
          `Merge ${named} into ${pr.base}?`,
          agentsSaid(db, open.owner, open.repo, pr, pr.head),
          "y/n",
        ]
          .filter(Boolean)
          .join(" "),
        working: `Merging ${named}…`,
        request: {
          command: "merge",
          repo: `${open.owner}/${open.repo}`,
          pr: Number(pr.id),
          commit: pr.head,
        },
      };
    // A review under way, waiting or held counts as a round going on, the first one included.
    const reviewed = on && (on.thread.review_round !== null || onReviewer(on.thread, on.word));
    const sign = ready ? "●" : reviewed ? "◐" : "○";
    // A hollow mark's bright or dim says nothing of how far the PR is.
    const row: ListRow = {
      mark: [sign, on?.mark.sign === "●" ? colourOf(on) : null],
      name: named,
      title: pr.title,
      ends: [on ? wordEnd(on) : [pr.author?.login ?? "", grey]],
      link: pr.link,
      session: null,
      dim: false,
      action,
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
// or failed, then `Ready to merge`, the approved ones, which wait only for your merge, then
// `Working`, every other one working or waiting, then `Stopped`. Each ends with
// its word, harness, its issue and PR if it has them, such as #12 #31, when it last changed,
// and its merge when ready if it has one, such as "merges when ready · waiting on its checks". A
// stopped thread's agent isn't running, so its row is dim.
function threadGroups(threads: Known[], now: number): Group[] {
  const rows = threads.map((open) => {
    const { thread, word } = open;
    // Only a review is on another harness, held on a usage limit or not, and a thread with no
    // harness saved started before Skelcrew saved it, when builders ran only on Claude Code. A
    // thread with no issue in the tracker has a task such as t1.
    const harness = onReviewer(thread, word)
      ? (thread.reviewer ?? "")
      : (thread.harness ?? "claude");
    const issue = ownTask(thread.task) ? "" : `#${thread.task}`;
    const refs = [issue, thread.pr === null ? "" : `#${thread.pr}`].filter(Boolean).join(" ");
    const changed = thread.changed ?? thread.started;
    const merge = mergeShown(thread);
    const row: ListRow = {
      mark: [open.mark.sign, colourOf(open)],
      name: open.name,
      title: thread.title ?? "",
      ends: [
        wordEnd(open),
        [harness, grey],
        [refs, grey],
        [changed === null ? "" : changedAt(changed, now), grey],
        // Last, so the columns before it line up whether a row has one or not.
        ...(merge === null ? [] : [[merge, grey] as [string, string]]),
      ],
      link: null,
      session: thread.folder,
      dim: thread.status === "stopped",
      action: null,
    };
    return { row, open };
  });
  // A thread goes in the first group it fits.
  type Fits = (r: (typeof rows)[number]) => boolean;
  const urgent: Fits = (r) => needsDecision(r.open.mark);
  const ready: Fits = (r) => readyToMerge(r.open.mark);
  // A thread that failed waits for the lead to start it again, as a stopped one waits for sc
  // start, so the two go together.
  const stopped: Fits = (r) =>
    !urgent(r) && (r.open.thread.status === "stopped" || r.open.thread.status === "failed");
  const working: Fits = (r) => !urgent(r) && !ready(r) && !stopped(r);
  return filled([
    { heading: "Needs you", rows: rows.filter(urgent).map((r) => r.row) },
    { heading: "Ready to merge", rows: rows.filter(ready).map((r) => r.row) },
    { heading: "Working", rows: rows.filter(working).map((r) => r.row) },
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
// tracker, Threads always, and PRs when it has a forge. Issues has only its count, as an issue
// never needs you on its own. Threads says how many need you, in yellow, and PRs how
// many are ready to merge, in green, only when there are any. An approved thread is ready, not
// needing you, so the same thread is never counted twice. With no forge there are no PRs, so
// Threads says how many are ready itself, before how many need you.
export function entryCounts(db: Database, open: Open): EntryCount[] {
  const repository = repositories(db).find((r) => r.owner === open.owner && r.repo === open.repo);
  const threads = openThreads(db, open);
  // Returns how many rows a list has.
  const total = (groups: Group[]) => groups.reduce((sum, group) => sum + group.rows.length, 0);
  // Returns how many rows a list has, and how many under its first heading if that is `first`.
  const count = (groups: Group[], first: string) => ({
    total: total(groups),
    flagged: groups[0]?.heading === first ? groups[0].rows.length : 0,
  });
  const prs = count(repository ? prGroups(db, open, threads) : [], "Ready to merge");
  const forge = Boolean(repository && forgeOf(db, repository));
  const needing = threads.filter((open) => needsDecision(open.mark)).length;
  const ready = forge ? 0 : threads.filter((open) => readyToMerge(open.mark)).length;
  const needYou = needing === 1 ? "needs you" : "need you";
  // Returns a note, or none for nothing to act on.
  const note = (count: number, text: string, colour: string): [string, string][] =>
    count ? [[`${count} ${text}`, colour]] : [];
  const issuesEntry: EntryCount = {
    entry: "issues",
    name: "Issues",
    total: total(repository ? issueGroups(db, open, threads) : []),
    notes: [],
  };
  const threadsEntry: EntryCount = {
    entry: "threads",
    name: "Threads",
    total: threads.length,
    notes: [...note(ready, "ready", green), ...note(needing, needYou, yellow)],
  };
  const prsEntry: EntryCount = {
    entry: "prs",
    name: "PRs",
    total: prs.total,
    notes: note(prs.flagged, "ready", green),
  };
  return [
    ...(repository && trackerOf(db, repository) ? [issuesEntry] : []),
    threadsEntry,
    ...(forge ? [prsEntry] : []),
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
  const shown = item.kind === "task" ? taskName(name, item.id) : `${name}#${item.id}`;
  return { name: shown, title: item.title };
}
