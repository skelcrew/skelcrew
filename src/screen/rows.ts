// The rows: what the sidebar, the strip and the tabs have to show, read from the database. The
// open repository's lead and threads, with the word that says what each is doing, its ISSUES
// and PRS as links, and a tab for each repository.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Item } from "../flow/copy.ts";
import { pastRoundLimit } from "../flow/decide.ts";
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
// The mark of a PR with no thread. It has nothing to say, so it looks like a thread that is
// waiting.
const noThreadMark: Mark = ["○", grey];

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
// A thread can need you for a reason with no word of its own, such as a builder that couldn't be
// told about an event. Its word is then "needs you", rather than something untrue.
export function threadWord(thread: Thread, maxRounds: number): string {
  const { status, verdict, checks } = thread;
  // A thread that failed, stopped or is done says just that. Otherwise a question from its builder
  // comes first, then why it needs you, then what it is doing.
  if (status === "failed" || status === "stopped" || status === "done") return status;
  const underWay = thread.submitting !== null || thread.reviewing !== null;
  if (thread.asking) return "question";
  if (thread.needs_you) {
    if (pastRoundLimit(thread, maxRounds)) return "round limit";
    if (underWay || verdict === "failed") return "review failed";
    if (verdict === "approve" && (checks === "passing" || checks === null)) return "approved";
    return "needs you";
  }
  // Not needing you: a round under way shows as reviewing, and a review's changes still waiting
  // to be typed into the builder as changes. Otherwise it works or waits on checks.
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

// Returns the open repository's rows as the database and tmux have them now. Its lead comes
// first, then each of its threads that isn't done, newest first as in sc ps. Each word takes the
// thread's round limit from `maxRounds`. Stopped threads come last, newest first too. They need
// nothing and don't change, so they shouldn't sit between threads at work. It runs each second,
// so it reads only what shows. Only a thread whose word is working shows its running time. A
// time on any other row would write to the terminal each minute, and on a Sprite a terminal that
// stays quiet lets it sleep. A working thread keeps the Sprite awake anyway, so its time costs
// nothing.
export function sidebarRows(
  db: Database,
  running: string[],
  maxRounds: (thread: Thread) => number,
  now: number,
  open: Open,
): Row[] {
  // THREADS has the repository's threads that aren't done, after its lead, which has no status,
  // PR or review of its own, only whether its session runs. In SQLite a comparison is 0 or 1, so
  // ordering by it puts stopped threads after the rest.
  const threads = db.query(`SELECT * FROM threads WHERE status != 'done' AND owner = ? AND repo = ?
      ORDER BY status = 'stopped', rowid DESC`);
  const leadRuns = running.includes(open.lead);
  // A repository Skelcrew no longer works on has no lead to name a harness for.
  const knownRepository = db.query("SELECT 1 FROM repositories WHERE owner = ? AND repo = ?");
  const lead = knownRepository.get(open.owner, open.repo)
    ? leadOf(db, open.owner, open.repo)
    : null;
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
    // Each thread's word is worked out first, as its harness and age depend on it.
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
        // is only there for a field that stays null until the first submit. A thread with no
        // harness saved started before Skelcrew saved it, when builders ran only on Claude Code.
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

// What a row of ISSUES or PRS holds as the database gives it, checked, since it is read from disk.
const ListRow = z.object({
  name: z.string(),
  threaded: z.coerce.boolean(),
  item: z.string(),
});

// Returns the open repository's ISSUES and PRS from Skelcrew's copy, up to `most` rows of each.
// A list is null when the repository has no tracker or forge for it. It reads only the database
// and never asks the tracker, as it runs each second. Rows are newest first. Issues that have a
// thread go last, and so do PRs whose thread is stopped, as THREADS already shows those threads.
// A thread that is done has left THREADS, so its issue counts as waiting again. A PR from a
// thread takes the word and mark of its row. The lists and the rows are of the open repository
// alone, so a PR's number is enough to find its thread.
export function sidebarLists(db: Database, rows: Row[], most: number, open: Open): Lists {
  // Returns one list, of tasks or PRs, with the column that counts all of its kind.
  const readList = (kind: "task" | "pr", column: string): List => {
    // The open items of one kind, and for a task whether it has a thread that isn't done, which
    // puts it last and dims it. A PR whose thread is stopped goes last, but isn't dim, as its
    // thread's word already says stopped.
    const found = db.query(`SELECT r.name, i.item,
        EXISTS (SELECT 1 FROM threads t WHERE i.kind = 'task' AND t.owner = i.owner
          AND t.repo = i.repo AND CAST(t.task AS TEXT) = i.id AND t.status != 'done') AS threaded,
        EXISTS (SELECT 1 FROM threads t WHERE i.kind = 'pr' AND t.owner = i.owner
          AND t.repo = i.repo AND CAST(t.pr AS TEXT) = i.id AND t.status = 'stopped') AS stopped
      FROM items i JOIN repositories r ON r.owner = i.owner AND r.repo = i.repo
      WHERE i.kind = ? AND i.state = 'open' AND i.owner = ? AND i.repo = ?
      ORDER BY threaded, stopped, i.created DESC, length(i.id) DESC, i.id DESC LIMIT ?`);
    // Each is named as Skelcrew names it, app-12 for an issue and app#34 for a PR. A PR takes the
    // word and mark of its thread's row, if it has one.
    const links = found.all(kind, open.owner, open.repo, most).map((saved) => {
      const { name, threaded, item } = ListRow.parse(saved);
      const { id, title, link } = Item.parse(JSON.parse(item));
      const thread = rows.find((row) => row.pr === Number(id));
      return {
        name: kind === "pr" ? `${name}#${id}` : `${name}-${id}`,
        title,
        url: link,
        word: thread?.word ?? "",
        needing: thread !== undefined && needing(thread),
        dim: threaded,
        mark: kind === "task" ? null : thread ? threadMark(thread) : noThreadMark,
      };
    });
    // The total is every open one in Skelcrew's copy, counted when the copy was saved, while the
    // rows stop at `most`.
    const sum = db
      .query(
        `SELECT COALESCE(SUM(${column}), 0) AS total FROM repositories WHERE owner = ? AND repo = ?`,
      )
      .get(open.owner, open.repo);
    return { links, total: z.object({ total: z.number() }).parse(sum).total };
  };
  // A list is there only when the repository has a tracker for ISSUES or a forge for PRS.
  const repository = repositories(db).find((r) => r.owner === open.owner && r.repo === open.repo);
  return {
    issues: repository && trackerOf(db, repository) ? readList("task", "open_issues") : null,
    prs: repository && forgeOf(db, repository) ? readList("pr", "open_prs") : null,
  };
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
          AND (t.status = 'failed' OR t.needs_you = 1 OR t.asking = 1)) AS count
      FROM repositories r WHERE r.tab_closed = 0 ORDER BY r.name`,
    )
    .all()
    .map((row) => {
      const { name, owner, repo, count } = TabRow.parse(row);
      return { name, fullName: `${owner}/${repo}`, count };
    });
}
