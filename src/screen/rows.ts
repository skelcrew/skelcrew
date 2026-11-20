// The rows: what the sidebar, the strip and the tabs have to show, read from the database. The
// open repository's lead and threads, with the word that says what each is doing, and a tab for
// each repository.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { noProgress } from "../agents/progress.ts";
import { leadOf } from "../flow/lead.ts";
import { type Badge, badgeOf, markOf, shownOf } from "../flow/marks.ts";
import { messagesWaiting, waitingText } from "../flow/messages.ts";
import type { Status } from "../flow/status.ts";
import { fullNameOf, Thread, threadName } from "../flow/thread.ts";
import { builderProgress, tokenText } from "./progress.ts";

// One row of the sidebar, with what the strip says of the agent too. The lead has no status of
// its own, and a row's age is empty unless it shows a running time. `task` is the thread's name
// without its repository's, such as 12 or t5, and `short` the short title the lead gave it, which
// its row shows in place of its title. `harness` names whoever has the thread now, its reviewer
// while a review runs, and `agentHarness` the agent itself, which Esc stops. A working thread
// also has its builder's `tokens`, as text, its `step`, what it is doing, and its `plan`, how
// many steps of its plan are done of how many. A thread under review whose builder works at the
// same time has its `step` too. Each is empty or null on other rows, and when the builder's
// harness doesn't give it. `waiting` says how many messages wait to be typed into the
// builder, such as 1 message waiting, or is empty. `state` is the thread's status as a host shows
// it, which with its word gives its mark.
export type Row = {
  name: string;
  task: string;
  session: string;
  status: Thread["status"] | null;
  state: Status;
  running: boolean;
  word: string;
  harness: string;
  agentHarness: string;
  age: string;
  tokens: string;
  step: string;
  plan: { done: number; total: number } | null;
  waiting: string;
  fullName: string | null;
  title: string | null;
  short: string | null;
  pr: number | null;
  checks: Thread["checks"];
  review: { round: number; reviewer: string; verdict: string } | null;
};
// The repository open in the sidebar, by its owner and name, and its lead's session.
export type Open = { owner: string; repo: string; lead: string };
// A repository's tab: its name in Skelcrew, its owner/name, and its badge.
export type Tab = Badge & { name: string; fullName: string };
// Returns whether the thread's reviewer has it now: a review waiting for a place, running, or
// held on its harness's usage limit when the builder isn't held on one of its own. Then its
// harness is the reviewer's and its PR is in a round.
export const onReviewer = (thread: Thread, word: string) =>
  word === "reviewing" ||
  word === "queued for review" ||
  (word.startsWith("limit") && !(thread.erred && thread.limited));

// What the sidebar reads of a thread beyond what its log keeps: when its builder's current
// stretch of work began. Null before the builder first started.
const Working = z.object({ working_since: z.number().nullable() });

// Returns whether a row is a thread waiting on you, which the sidebar shows under Needs you: its
// mark is filled, for a decision, an answer, something gone wrong, or a merge.
export const waitsOnYou = (row: Row) =>
  row.status !== null && markOf(row.state, row.word).sign === "●";

// Returns how long ago a thread started, in the fewest letters: <1m, then 5m, 2h, 3d. Rounded
// down, so the text changes at most once a minute.
export function threadAge(started: number, now: number): string {
  const minutes = Math.floor((now - started) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

// Returns the open repository's rows as the database and tmux have them now. Its lead comes
// first, then each of its active threads, newest first as in sc ps: working, waiting, needing you
// or failed. Each word takes the thread's round limit from `maxRounds`. A stopped thread needs
// nothing and doesn't change, so it leaves ACTIVE, as a done one does. It runs each second,
// so it reads only what shows. Only a thread whose word is working shows how long its builder
// has worked since it was last started or typed to, its tokens and its plan. Its step shows too
// while a review runs or waits and its builder works meanwhile, as the row then says reviewing.
// Any of them on another row would write to the terminal, which costs over a slow link.
export function sidebarRows(
  db: Database,
  running: string[],
  maxRounds: (thread: Thread) => number,
  now: number,
  open: Open,
): Row[] {
  // ACTIVE has the repository's active threads, after its lead, which has no status, PR or
  // review of its own, only whether its session runs.
  const threads = db.query(`SELECT * FROM task_threads
      WHERE status IN ('queued', 'working', 'waiting', 'failed') AND owner = ? AND repo = ?
      ORDER BY rowid DESC`);
  const leadRuns = running.includes(open.lead);
  // A repository Skelcrew no longer works on has no lead to name a harness for.
  const knownRepository = db.query("SELECT 1 FROM repositories WHERE owner = ? AND repo = ?");
  const lead = knownRepository.get(open.owner, open.repo)
    ? leadOf(db, open.owner, open.repo)
    : null;
  return [
    {
      name: "lead",
      task: "",
      session: open.lead,
      status: null,
      state: leadRuns ? "working" : "idle",
      running: leadRuns,
      word: leadRuns ? "running" : "stopped",
      harness: lead?.harness ?? "",
      agentHarness: lead?.harness ?? "",
      age: "",
      tokens: "",
      step: "",
      plan: null,
      waiting: "",
      fullName: null,
      title: null,
      short: null,
      pr: null,
      checks: null,
      review: null,
    },
    // Each thread's word is worked out first, as its harness and age depend on it.
    ...threads.all(open.owner, open.repo).map((row) => {
      const thread = Thread.parse(row);
      const { review_round: round, reviewer, reviewed_by: by, verdict } = thread;
      // A thread approved and green, with no merge armed, waits on you to merge it, so its word
      // says that action, as every word under Needs you does. One its flow didn't review keeps
      // saying not reviewed, so you know nobody looked at it.
      const shown = shownOf(thread, maxRounds(thread), now);
      const { status } = shown;
      const ready = status === "ready" && shown.word === "approved";
      const word = ready ? "ready to merge" : shown.word;
      const working = word === "working";
      const reviewed = word === "reviewing" || word === "queued for review";
      const stepping = working || (reviewed && status === "working");
      // A thread from before Skelcrew timed stretches of work is timed from its start.
      const since = Working.parse(row).working_since;
      const from = since ?? thread.started;
      const progress = stepping ? builderProgress(thread, now) : noProgress;
      return {
        name: threadName(db, thread),
        task: thread.task,
        session: thread.folder,
        status: thread.status,
        state: status,
        running: running.includes(thread.folder),
        word,
        // Only a review is on another harness, held on a usage limit or not. A submit saves
        // which one, so the empty text is only there for a field that stays null until the
        // first submit. A thread with no harness saved started before Skelcrew saved it, when
        // builders ran only on Claude Code.
        harness: onReviewer(thread, word) ? (reviewer ?? "") : (thread.harness ?? "claude"),
        agentHarness: thread.harness ?? "claude",
        age: working && from !== null ? threadAge(from, now) : "",
        tokens: !working || progress.tokens === null ? "" : `${tokenText(progress.tokens)} tok`,
        // A builder that has run no tool yet has no step to show, so it says only that it works.
        step: stepping ? (progress.step ?? "working") : "",
        plan: working ? progress.plan : null,
        waiting: waitingText(messagesWaiting(db, thread)),
        fullName: fullNameOf(thread),
        title: thread.title,
        short: thread.short,
        pr: thread.pr,
        checks: thread.checks,
        review: round !== null && verdict !== null ? { round, reviewer: by ?? "", verdict } : null,
      };
    }),
  ];
}

// What a tab's row holds as the database gives it, checked, since it is read from disk.
const TabRow = z.object({ name: z.string(), owner: z.string(), repo: z.string() });

// Returns a tab for each repository, in name order, with its badge: how many of its threads
// need you, and how many are ready to merge. The badges are how you hear of other repositories,
// as one repository's lead never mentions another's threads. Each thread's word takes its round
// limit from `maxRounds`. A repository whose lead you exited has no tab, and no badge, until you
// open it again.
export function repositoryTabs(db: Database, maxRounds: (thread: Thread) => number): Tab[] {
  const repositories = db
    .query("SELECT name, owner, repo FROM repositories WHERE tab_closed = 0 ORDER BY name")
    .all()
    .map((row) => TabRow.parse(row));
  // Each thread that isn't done gets the mark ACTIVE would give it.
  const marked = db
    .query("SELECT * FROM task_threads WHERE status != 'done'")
    .all()
    .map((row) => {
      const thread = Thread.parse(row);
      return { thread, mark: shownOf(thread, maxRounds(thread)).mark };
    });
  return repositories.map(({ name, owner, repo }) => {
    const ours = marked.filter((m) => m.thread.owner === owner && m.thread.repo === repo);
    return { name, fullName: `${owner}/${repo}`, ...badgeOf(ours.map((m) => m.mark)) };
  });
}
