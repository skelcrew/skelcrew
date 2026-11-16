// The lists: what the right pane shows on landing on the sidebar's Issues, Threads or PRs entry,
// in groups, and the counts beside those entries. Read from Skelcrew's database and its copy of
// the tracker, never the tracker itself, as the sidebar and an open list read them each second.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { threadConfig } from "../config.ts";
import { type Item, itemAt, openPrs, openTasks } from "../flow/copy.ts";
import { repositories } from "../flow/repo.ts";
import type { DaemonRequest } from "../flow/requests.ts";
import { needsYou, Thread, threadName } from "../flow/thread.ts";
import { forgeOf, trackerOf } from "../plugins/ask.ts";
import { green, grey, yellow } from "./look.ts";
import { type Open, onReviewer, threadMark, threadWord } from "./rows.ts";

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
// An entry of the sidebar: its name, how many its list has, and a note on what you act on,
// such as 2 ready, and the note's `colour`.
export type EntryCount = {
  entry: Entry;
  name: string;
  total: number;
  note: string;
  colour: string;
};

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

// Returns a thread's mark, as ACTIVE shows it.
const markOf = ({ thread, word }: Known) =>
  threadMark({ status: thread.status, needsYou: needsYou(thread), word });

// Returns a thread's word as the end of a row, in its mark's colour, as in ACTIVE.
const wordEnd = (open: Known): [string, string] => [open.word, markOf(open)[1]];

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
          working: `Starting ${name}-${task.id}…`,
          request: { command: "start", repo: `${open.owner}/${open.repo}`, task: task.id },
        };
    const row: ListRow = {
      mark: [sign, null],
      name: `${name}-${task.id}`,
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
// and its checks pass. A PR from a thread takes its thread's colour where that means something:
// green when approved, yellow when it needs you, red when it failed or hit an error. A thread
// that is only working or waiting leaves the mark plain. A PR from a thread ends with its word,
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
        refused: `${named} needs a newer forge plugin to merge here: run sc plugin update`,
      };
    else
      action = {
        key: "m",
        ask: `Merge ${named} into ${pr.base}? y/n`,
        working: `Merging ${named}…`,
        request: {
          command: "merge",
          repo: `${open.owner}/${open.repo}`,
          pr: Number(pr.id),
          commit: pr.head,
        },
      };
    // A review under way counts as a round going on, the first one included.
    const reviewed = on && (on.thread.review_round !== null || on.word === "reviewing");
    const sign = ready ? "●" : reviewed ? "◐" : "○";
    // A working thread's green and a waiting one's dim say nothing of how far the PR is.
    const colour = on ? markOf(on)[1] : grey;
    const plain = colour === grey || (colour === green && on?.word !== "approved");
    const row: ListRow = {
      mark: [sign, plain ? null : colour],
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
// or failed, then `Working`, every other one working or waiting, then `Stopped`. Each ends with
// its word, harness, its issue and PR if it has them, such as #12 #31, and when it last changed.
// A stopped thread's agent isn't running, so its row is dim.
function threadGroups(threads: Known[], now: number): Group[] {
  const rows = threads.map((open) => {
    const { thread, word } = open;
    // Only a review is on another harness, held on a usage limit or not, and a thread with no
    // harness saved started before Skelcrew saved it, when builders ran only on Claude Code. A
    // thread with no issue in the tracker has a task such as t1.
    const harness = onReviewer(thread, word)
      ? (thread.reviewer ?? "")
      : (thread.harness ?? "claude");
    const issue = /^t\d+$/.test(thread.task) ? "" : `#${thread.task}`;
    const refs = [issue, thread.pr === null ? "" : `#${thread.pr}`].filter(Boolean).join(" ");
    const changed = thread.changed ?? thread.started;
    const row: ListRow = {
      mark: markOf(open),
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
      action: null,
    };
    return { row, open };
  });
  const stopped = (r: (typeof rows)[number]) => r.open.thread.status === "stopped";
  const urgent = (r: (typeof rows)[number]) =>
    needsYou(r.open.thread) || r.open.thread.status === "failed";
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
// tracker, Threads always, and PRs when it has a forge. Issues has only its count, as an issue
// never needs you on its own. Threads says how many need you or failed, in yellow, and PRs how
// many are ready to merge, in green, only when there are any.
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
  const ours = count(threadGroups(threads, 0), "Needs you");
  const prs = count(repository ? prGroups(db, open, threads) : [], "Ready to merge");
  const needYou = ours.flagged === 1 ? "needs you" : "need you";
  const issuesEntry: EntryCount = {
    entry: "issues",
    name: "Issues",
    total: total(repository ? issueGroups(db, open, threads) : []),
    note: "",
    colour: grey,
  };
  const threadsEntry: EntryCount = {
    entry: "threads",
    name: "Threads",
    total: ours.total,
    note: ours.flagged ? `${ours.flagged} ${needYou}` : "",
    colour: yellow,
  };
  const prsEntry: EntryCount = {
    entry: "prs",
    name: "PRs",
    total: prs.total,
    note: prs.flagged ? `${prs.flagged} ready` : "",
    colour: green,
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
