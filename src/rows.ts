// The rows: what the sidebar and the strip have to show, read from the database. The lead and
// each thread, with the word that says what it is doing, and ISSUES and PRS as links.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Name } from "./github.ts";
import { green, grey, red, yellow } from "./look.ts";
import { github, needsYou, Thread, threadName } from "./thread.ts";

// One row of the sidebar, with what the strip says of the agent too. The lead has no status of
// its own, and a row's age is empty unless it shows a running time.
export type Row = {
  name: string;
  session: string;
  status: Thread["status"] | null;
  needsYou: boolean;
  running: boolean;
  word: string;
  harness: string;
  age: string;
  github: string | null;
  title: string | null;
  pr: number | null;
  checks: Thread["checks"];
  review: { round: number; reviewer: string; verdict: string } | null;
};
// A sign, and the colour it is drawn in.
type Mark = [string, number];
// One row of ISSUES or PRS: a link to GitHub, and a page you can land on. `word` is the word of
// the thread a PR comes from, and `needing` says whether that thread needs you. A PR has
// a mark, and an issue has none, so it starts where the headings do.
export type Link = {
  name: string;
  title: string;
  url: string;
  word: string;
  needing: boolean;
  dim: boolean;
  mark: Mark | null;
};
// The rows to show, and how many are open in all, which can be far more.
export type List = { links: Link[]; total: number };
export type Lists = { issues: List; prs: List };

// Claude Code is the only harness offered for the lead and builders.
const builderHarness = "claude";
// Each thread's mark is a circle in its status's colour. Waiting and stopped look alike, and the
// word under the name tells every status apart, so nothing is told by colour alone.
const marks: Record<Thread["status"], Mark> = {
  working: ["●", green],
  waiting: ["○", grey],
  stopped: ["○", grey],
  failed: ["●", red],
  done: ["●", green],
};
// A PR with no thread has nothing to say, so it looks like a thread that is waiting.
const noThread: Mark = ["○", grey];

// Says whether a thread shows as needing you. A thread that failed can still have its needs you
// flag, and its word says failed.
export const needing = (row: Row) => row.needsYou && row.status !== "failed";

// Returns the mark of a row of THREADS, which a PR from that thread shows too.
export function threadMark(row: Row): Mark {
  if (row.status === null) return ["◆", grey];
  return needing(row) ? ["●", yellow] : marks[row.status];
}

// Returns the word for what the thread is doing, given the rounds of changes it may have. Its
// status and needs you stay as they are: the word only describes them, from what they and the
// latest review say. Past the limit a thread goes on needing you while its builder submits, so
// that comes before a round under way. A round that failed keeps its submit or review saved.
// A thread can need you for what the table of words has no word for, such as a builder that
// couldn't be told about an event, and that says just so rather than something untrue.
export function threadWord(thread: Thread, maxRounds: number): string {
  const { status, verdict, checks } = thread;
  if (status === "failed" || status === "stopped" || status === "done") return status;
  const underWay = thread.submitting !== null || thread.reviewing !== null;
  if (thread.asking) return "question";
  if (thread.needs_you) {
    if (thread.rounds > maxRounds) return "round limit";
    if (underWay || verdict === "failed") return "review failed";
    if (verdict === "approve" && (checks === "passing" || checks === null)) return "approved";
    return "needs you";
  }
  if (underWay) return "reviewing";
  if (thread.telling !== null) return "changes";
  return status === "working" ? "working" : "checks";
}

// Returns how long ago a thread started, in the fewest letters: <1m, then 5m, 2h, 3d. Rounded
// down, so the text changes at most once a minute.
export function threadAge(started: number, now: number): string {
  const minutes = Math.floor((now - started) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

// Returns the rows as the database and tmux have them now: the lead, then each thread that
// isn't done, newest first as in skel ps. It runs each second, so it reads only what shows.
// Only a thread whose word is working shows its running time. A time on any other row would
// write to the terminal each minute, and on a Sprite a terminal that stays quiet lets it sleep.
// Such a thread keeps the Sprite awake anyway, so its time costs nothing.
export function sidebarRows(
  db: Database,
  running: string[],
  maxRounds: number,
  now: number,
): Row[] {
  const threads = db.query("SELECT * FROM threads WHERE status != 'done' ORDER BY rowid DESC");
  const leadRuns = running.includes("lead");
  return [
    {
      name: "lead",
      session: "lead",
      status: null,
      needsYou: false,
      running: leadRuns,
      word: leadRuns ? "running" : "stopped",
      harness: builderHarness,
      age: "",
      github: null,
      title: null,
      pr: null,
      checks: null,
      review: null,
    },
    ...threads.all().map((row) => {
      const thread = Thread.parse(row);
      const { review_round: round, reviewer, reviewed_by: by, verdict } = thread;
      const word = threadWord(thread, maxRounds);
      return {
        name: threadName(db, thread),
        session: thread.folder,
        status: thread.status,
        needsYou: needsYou(thread),
        running: running.includes(thread.folder),
        word,
        // Only a review is on another harness. A submit saves which one, so the empty text
        // is only there for a field that stays null until the first submit.
        harness: word === "reviewing" ? (reviewer ?? "") : builderHarness,
        age: word === "working" && thread.started !== null ? threadAge(thread.started, now) : "",
        github: github(thread),
        title: thread.title,
        pr: thread.pr,
        checks: thread.checks,
        review: round !== null && verdict !== null ? { round, reviewer: by ?? "", verdict } : null,
      };
    }),
  ];
}

const OpenRow = z.object({
  owner: Name,
  repo: Name,
  name: z.string(),
  number: z.number(),
  title: z.string(),
  threaded: z.coerce.boolean(),
});

// Returns ISSUES and PRS as the daemon's last poll saved them, up to `most` rows of each: it
// reads the database and never asks GitHub, as it runs each second. Newest first, across
// repositories, with issues that have a thread last. A thread that is done has left THREADS,
// so its issue counts as waiting again. A PR from a thread takes the word and mark of its row.
// GitHub numbers issues and PRs from one counter, so no issue can be taken for a thread's PR.
export function sidebarLists(db: Database, rows: Row[], most: number): Lists {
  // Returns one list, of the kind saved in the database, with the path GitHub shows it at.
  const read = (kind: string, path: string, column: string): List => {
    const found = db.query(`SELECT i.owner, i.repo, r.name, i.number, i.title,
        EXISTS (SELECT 1 FROM threads t WHERE i.kind = 'issue' AND t.owner = i.owner
          AND t.repo = i.repo AND t.task = i.number AND t.status != 'done') AS threaded
      FROM open_items i JOIN repositories r ON r.owner = i.owner AND r.repo = i.repo
      WHERE i.kind = ? ORDER BY threaded, i.created DESC, i.number DESC LIMIT ?`);
    const links = found.all(kind, most).map((saved) => {
      const { owner, repo, name, number, title, threaded } = OpenRow.parse(saved);
      const thread = rows.find((row) => row.github === `${owner}/${repo}` && row.pr === number);
      return {
        name: kind === "pr" ? `${name}#${number}` : `${name}-${number}`,
        title,
        url: `https://github.com/${owner}/${repo}/${path}/${number}`,
        word: thread?.word ?? "",
        needing: thread !== undefined && needing(thread),
        dim: threaded,
        mark: kind === "issue" ? null : thread ? threadMark(thread) : noThread,
      };
    });
    const sum = db.query(`SELECT COALESCE(SUM(${column}), 0) AS total FROM repositories`).get();
    return { links, total: z.object({ total: z.number() }).parse(sum).total };
  };
  return { issues: read("issue", "issues", "open_issues"), prs: read("pr", "pull", "open_prs") };
}
