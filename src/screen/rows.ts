// The rows: what the sidebar, the strip and the tabs have to show, read from the database. The
// open repository's lead and threads, with the word that says what each is doing, and a tab for
// each repository.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { noProgress } from "../agents/progress.ts";
import { pastRoundLimit } from "../flow/decide.ts";
import { leadOf } from "../flow/lead.ts";
import { clockTime } from "../flow/limits.ts";
import { messagesWaiting, waitingText } from "../flow/messages.ts";
import { fullNameOf, needsYou, queuedForReview, Thread, threadName } from "../flow/thread.ts";
import { green, grey, red, yellow } from "./look.ts";
import { builderProgress, tokenText } from "./progress.ts";

// One row of the sidebar, with what the strip says of the agent too. The lead has no status of
// its own, and a row's age is empty unless it shows a running time. `task` is the thread's name
// without its repository's, such as 12 or t5, and `short` the short title the lead gave it, which
// its row shows in place of its title. `harness` names whoever has the thread now, its reviewer
// while a review runs, and `agentHarness` the agent itself, which Esc stops. A working thread
// also has its builder's `tokens`, as text, its `step`, what it is doing, and its `plan`, how
// many steps of its plan are done of how many. Each is empty or null on other rows, and when the
// builder's harness doesn't give it. `waiting` says how many messages wait to be typed into the
// builder, such as 1 message waiting, or is empty.
export type Row = {
  name: string;
  task: string;
  session: string;
  status: Thread["status"] | null;
  needsYou: boolean;
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
// A sign, and the colour it is drawn in.
type Mark = [string, string];
// The repository open in the sidebar, by its owner and name, and its lead's session.
export type Open = { owner: string; repo: string; lead: string };
// A repository's tab: its name in Skelcrew, its owner/name, and how many of its threads need you
// or failed.
export type Tab = { name: string; fullName: string; count: number };
// Each thread's mark is a circle in its status's colour. Waiting and stopped look alike, and the
// word under the name tells every status apart, so nothing is told by colour alone.
const marks: Record<Thread["status"], Mark> = {
  working: ["●", green],
  waiting: ["○", grey],
  stopped: ["○", grey],
  failed: ["●", red],
  done: ["●", green],
};
// Returns the mark of a row of ACTIVE, which the lists show too, and whose colour its word takes.
// Green is good, yellow wants you, and red is wrong. So a thread that needs you is yellow, except
// once it is approved, which is good news, and when its harness stopped on an error, which is
// wrong. A thread that failed stays red even if it also needs you. One waiting out a usage
// limit is dim, as it waits and goes on by itself.
export function threadMark(row: Pick<Row, "status" | "needsYou" | "word">): Mark {
  if (row.status === null) return ["◆", grey];
  if (row.status === "failed" || row.word === "error") return ["●", red];
  if (row.word.startsWith("limit")) return ["○", grey];
  if (row.word === "approved") return ["●", green];
  return row.needsYou ? ["●", yellow] : marks[row.status];
}

// Returns the word for what the thread is doing, given the rounds of changes it may have. Its
// status and needs you stay as they are: the word only describes them, from what they and the
// latest review say. Past the limit a thread goes on needing you while its builder submits, so
// that comes before a round under way. A round that failed keeps its submit or review saved.
// A thread can need you for a reason with no word of its own, such as a builder that couldn't be
// told about an event. Its word is then "needs you", rather than something untrue. A review or
// builder waiting out its harness's usage limit says when the limit resets, as this machine's
// clock shows it, such as "limit · 13:59", or only "limit" when the harness didn't say. Anything
// that needs you comes before a limit, which only waits.
export function threadWord(thread: Thread, maxRounds: number, now = Date.now()): string {
  const { status, verdict, checks } = thread;
  // A thread that failed, stopped or is done says just that. Otherwise a question from its builder
  // comes first, then its harness stopping on an error, then why it needs you, then what it is
  // doing.
  if (status === "failed" || status === "stopped" || status === "done") return status;
  const underWay = thread.submitting !== null || thread.reviewing !== null;
  if (thread.asking) return "question";
  if (thread.erred && !thread.limited) return "error";
  // The round limit and an approval say what you must do next, so they stay ahead of a builder
  // that stopped without submitting. Otherwise any reply it gave you, or the lead, would hide
  // that the thread is ready to merge.
  const past = thread.needs_you && pastRoundLimit(thread, maxRounds);
  const failed = underWay || verdict === "failed";
  const green = verdict === "approve" && (checks === "passing" || checks === null);
  if (past) return "round limit";
  if (thread.needs_you && !failed && green) return "approved";
  // Stopping without submitting is a question written as plain text.
  if (thread.stalled) return "question";
  if (thread.needs_you && verdict === "timed out" && !underWay) return "review timed out";
  if (thread.needs_you) return failed ? "review failed" : "needs you";
  // Not needing you: a builder or a review waiting out a usage limit says until when.
  const limitWord = (reset: number | null) =>
    reset === null ? "limit" : `limit · ${clockTime(reset, now)}`;
  if (thread.erred && thread.limited) return limitWord(thread.limit_reset);
  if (thread.review_limited) return limitWord(thread.review_reset);
  // A review waiting for a place shows as queued, any other round under way as reviewing, and
  // a review's changes still waiting to be typed into the builder as changes. Otherwise it
  // works or waits on checks.
  if (queuedForReview(thread)) return "queued for review";
  if (underWay) return "reviewing";
  if (thread.telling !== null) return "changes";
  return status === "working" ? "working" : "checks";
}

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
// has worked since it was last started or typed to, its tokens, its plan and its step. Any of
// them on another row would write to the terminal, which costs over a slow link.
export function sidebarRows(
  db: Database,
  running: string[],
  maxRounds: (thread: Thread) => number,
  now: number,
  open: Open,
): Row[] {
  // ACTIVE has the repository's active threads, after its lead, which has no status, PR or
  // review of its own, only whether its session runs.
  const threads = db.query(`SELECT * FROM threads
      WHERE status IN ('working', 'waiting', 'failed') AND owner = ? AND repo = ?
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
      needsYou: false,
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
      const word = threadWord(thread, maxRounds(thread), now);
      const working = word === "working";
      // A thread from before Skelcrew timed stretches of work is timed from its start.
      const since = Working.parse(row).working_since;
      const from = since ?? thread.started;
      const progress = working ? builderProgress(thread, now) : noProgress;
      return {
        name: threadName(db, thread),
        task: thread.task,
        session: thread.folder,
        status: thread.status,
        needsYou: needsYou(thread),
        running: running.includes(thread.folder),
        word,
        // Only a review is on another harness, held on a usage limit or not. A submit saves
        // which one, so the empty text is only there for a field that stays null until the
        // first submit. A thread with no harness saved started before Skelcrew saved it, when
        // builders ran only on Claude Code.
        harness: onReviewer(thread, word) ? (reviewer ?? "") : (thread.harness ?? "claude"),
        agentHarness: thread.harness ?? "claude",
        age: working && from !== null ? threadAge(from, now) : "",
        tokens: progress.tokens === null ? "" : `${tokenText(progress.tokens)} tok`,
        // A builder that has run no tool yet has no step to show, so it says only that it works.
        step: working ? (progress.step ?? "working") : "",
        plan: progress.plan,
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
const TabRow = z.object({
  name: z.string(),
  owner: z.string(),
  repo: z.string(),
  count: z.number(),
});

// Returns a tab for each repository, in name order, with how many of its threads need you or
// failed, which its badge shows. The badges are how you hear of other repositories, as one
// repository's lead never mentions another's threads. A repository whose lead you exited has
// no tab, and no badge, until you open it again.
export function repositoryTabs(db: Database): Tab[] {
  return db
    .query(
      `SELECT r.name, r.owner, r.repo, (SELECT COUNT(*) FROM threads t
        WHERE t.owner = r.owner AND t.repo = r.repo AND t.status != 'done'
          AND (t.status = 'failed' OR t.needs_you = 1 OR t.asking = 1 OR t.stalled = 1
            OR (t.erred = 1 AND t.limited = 0))) AS count
      FROM repositories r WHERE r.tab_closed = 0 ORDER BY r.name`,
    )
    .all()
    .map((row) => {
      const { name, owner, repo, count } = TabRow.parse(row);
      return { name, fullName: `${owner}/${repo}`, count };
    });
}
