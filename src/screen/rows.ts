// The rows: what the sidebar, the strip and the tabs have to show, read from the database. The
// open repository's lead and threads, with the word that says what each is doing, its ISSUES
// and PRS as links, and a tab for each repository.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Item } from "../flow/copy.ts";
import { pastLimit } from "../flow/decide.ts";
import { leadOf } from "../flow/lead.ts";
import { repositories } from "../flow/repo.ts";
import { fullNameOf, needsYou, Thread, threadName } from "../flow/thread.ts";
import { forgeOf, trackerOf } from "../plugins/ask.ts";
import { green, grey, red, yellow } from "./look.ts";

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
  fullName: string | null;
  title: string | null;
  pr: number | null;
  checks: Thread["checks"];
  review: { round: number; reviewer: string; verdict: string } | null;
};
// A sign, and the colour it is drawn in.
type Mark = [string, number];
// One row of ISSUES or PRS: a link to the issue or PR, and a page you can land on. `word` is
// the word of the thread a PR comes from, and `needing` says whether that thread needs you. A
// PR has a mark, and an issue has none, so it starts where the headings do.
export type Link = {
  name: string;
  title: string;
  url: string;
  word: string;
  needing: boolean;
  dim: boolean;
  mark: Mark | null;
};
// The repository open in the sidebar, by its owner and name, and its lead's session.
export type Open = { owner: string; repo: string; lead: string };
// A repository's tab: its name in Skelcrew, its owner/name, and how many of its threads need you
// or failed.
export type Tab = { name: string; fullName: string; count: number };
// The rows to show, and how many are open in all, which can be far more.
export type List = { links: Link[]; total: number };
// ISSUES is there when the repository has a tracker, and PRS when it has a forge.
export type Lists = { issues: List | null; prs: List | null };

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
    if (pastLimit(thread, maxRounds)) return "round limit";
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

// Returns the open repository's rows as the database and tmux have them now: its lead, then
// each of its threads that isn't done, newest first as in sc ps, each with its word by its
// round limit, which `maxRounds` gives. It runs each second, so it reads only what shows.
// Only a thread whose word is working shows its running time. A time on any other row would
// write to the terminal each minute, and on a Sprite a terminal that stays quiet lets it sleep.
// Such a thread keeps the Sprite awake anyway, so its time costs nothing.
export function sidebarRows(
  db: Database,
  running: string[],
  maxRounds: (thread: Thread) => number,
  now: number,
  open: Open,
): Row[] {
  const threads = db.query(
    "SELECT * FROM threads WHERE status != 'done' AND owner = ? AND repo = ? ORDER BY rowid DESC",
  );
  const leadRuns = running.includes(open.lead);
  // A repository Skelcrew no longer works on has no lead to name a harness for.
  const known = db.query("SELECT 1 FROM repositories WHERE owner = ? AND repo = ?");
  const lead = known.get(open.owner, open.repo) ? leadOf(db, open.owner, open.repo) : null;
  return [
    {
      name: "lead",
      session: open.lead,
      status: null,
      needsYou: false,
      running: leadRuns,
      word: leadRuns ? "running" : "stopped",
      harness: lead?.harness ?? "",
      age: "",
      fullName: null,
      title: null,
      pr: null,
      checks: null,
      review: null,
    },
    ...threads.all(open.owner, open.repo).map((row) => {
      const thread = Thread.parse(row);
      const { review_round: round, reviewer, reviewed_by: by, verdict } = thread;
      const word = threadWord(thread, maxRounds(thread));
      return {
        name: threadName(db, thread),
        session: thread.folder,
        status: thread.status,
        needsYou: needsYou(thread),
        running: running.includes(thread.folder),
        word,
        // Only a review is on another harness. A submit saves which one, so the empty text
        // is only there for a field that stays null until the first submit.
        harness: word === "reviewing" ? (reviewer ?? "") : (thread.harness ?? "claude"),
        age: word === "working" && thread.started !== null ? threadAge(thread.started, now) : "",
        fullName: fullNameOf(thread),
        title: thread.title,
        pr: thread.pr,
        checks: thread.checks,
        review: round !== null && verdict !== null ? { round, reviewer: by ?? "", verdict } : null,
      };
    }),
  ];
}

const ListRow = z.object({
  owner: z.string(),
  repo: z.string(),
  name: z.string(),
  threaded: z.coerce.boolean(),
  item: z.string(),
});

// Returns the open repository's ISSUES and PRS from Skelcrew's copy, up to `most` rows of each, or
// none of a list its repository has no tracker or forge for: it reads the database and never
// asks the tracker, as it runs each second. Newest first, with issues
// that have a thread last. A thread that is done has left THREADS, so its issue counts as
// waiting again. A PR from a thread takes the word and mark of its row.
export function sidebarLists(db: Database, rows: Row[], most: number, open: Open): Lists {
  // Returns one list, of tasks or PRs, with the column that counts all of its kind.
  const read = (kind: "task" | "pr", column: string): List => {
    const found = db.query(`SELECT i.owner, i.repo, r.name, i.item,
        EXISTS (SELECT 1 FROM threads t WHERE i.kind = 'task' AND t.owner = i.owner
          AND t.repo = i.repo AND CAST(t.task AS TEXT) = i.id AND t.status != 'done') AS threaded
      FROM items i JOIN repositories r ON r.owner = i.owner AND r.repo = i.repo
      WHERE i.kind = ? AND i.state = 'open' AND i.owner = ? AND i.repo = ?
      ORDER BY threaded, i.created DESC, length(i.id) DESC, i.id DESC LIMIT ?`);
    const links = found.all(kind, open.owner, open.repo, most).map((saved) => {
      const { owner, repo, name, threaded, item } = ListRow.parse(saved);
      const { id, title, link } = Item.parse(JSON.parse(item));
      const thread = rows.find(
        (row) => row.fullName === `${owner}/${repo}` && row.pr === Number(id),
      );
      return {
        name: kind === "pr" ? `${name}#${id}` : `${name}-${id}`,
        title,
        url: link,
        word: thread?.word ?? "",
        needing: thread !== undefined && needing(thread),
        dim: threaded,
        mark: kind === "task" ? null : thread ? threadMark(thread) : noThread,
      };
    });
    const sum = db
      .query(
        `SELECT COALESCE(SUM(${column}), 0) AS total FROM repositories WHERE owner = ? AND repo = ?`,
      )
      .get(open.owner, open.repo);
    return { links, total: z.object({ total: z.number() }).parse(sum).total };
  };
  const repository = repositories(db).find((r) => r.owner === open.owner && r.repo === open.repo);
  return {
    issues: repository && trackerOf(db, repository) ? read("task", "open_issues") : null,
    prs: repository && forgeOf(db, repository) ? read("pr", "open_prs") : null,
  };
}

const TabRow = z.object({
  name: z.string(),
  owner: z.string(),
  repo: z.string(),
  count: z.number(),
});

// Returns a tab for each repository, in name order, with how many of its threads need you or
// failed, which its badge shows. The badges are how you hear of other repositories, as one
// repository's lead never mentions another's threads.
export function repositoryTabs(db: Database): Tab[] {
  return db
    .query(
      `SELECT r.name, r.owner, r.repo, (SELECT COUNT(*) FROM threads t
        WHERE t.owner = r.owner AND t.repo = r.repo AND t.status != 'done'
          AND (t.status = 'failed' OR t.needs_you = 1 OR t.asking = 1)) AS count
      FROM repositories r ORDER BY r.name`,
    )
    .all()
    .map((row) => {
      const { name, owner, repo, count } = TabRow.parse(row);
      return { name, fullName: `${owner}/${repo}`, count };
    });
}
