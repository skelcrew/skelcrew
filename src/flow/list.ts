// What Skelcrew shows you about its work: repositories for sc repo ls, threads for sc ps, tasks
// for sc ls, and one task with its threads and PR for sc show, as short text
// for a terminal or JSON for tools.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { repositoryTracker } from "../config.ts";
import type { Repository } from "../db.ts";
import { colorful } from "../help.ts";
import { cloneDir } from "../paths.ts";
import { failedLog, forgeOf, trackerOf } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { filled, fitted, removeControlCodes } from "../screen/look.ts";
import { type Item, openTasks, prOf, threadTask } from "./copy.ts";
import { reviewCheck } from "./decide.ts";
import { messagesWaiting } from "./messages.ts";
import { findRepository, noRepositories, repositories } from "./repo.ts";
import { roundRunning } from "./round.ts";
import { Stage, taskStage } from "./stage.ts";
import { needsYou } from "./status.ts";
import { queuedForReview, Thread, threadName, threadOn } from "./thread.ts";

// A repository as sc repo ls shows it. `missing` is a tracker its skelcrew.yaml names that
// isn't installed, so it has none until you install that plugin.
export const RepositoryRow = z.object({
  name: z.string(),
  repository: z.string(),
  tracker: z.string().nullable(),
  forge: z.string().nullable(),
  missing: z.string().nullable(),
  clone: z.string(),
  tabClosed: z.boolean(),
});
export type RepositoryRow = z.infer<typeof RepositoryRow>;

// Returns the repositories Skelcrew works on, in name order, with each one's tracker and forge
// and where Skelcrew keeps its clone, for sc repo ls.
export function listRepositories(db: Database): RepositoryRow[] {
  return repositories(db).map((r) => {
    const tracker = trackerOf(db, r);
    // The tracker skelcrew.yaml names, to say which plugin is missing. A skelcrew.yaml that
    // can't be read names none here, so one bad repository doesn't stop the whole list, and
    // tracker: none misses nothing.
    let named: string | null = null;
    try {
      named = repositoryTracker(r) ?? null;
    } catch {}
    if (named === "none") named = null;
    return {
      name: r.name,
      repository: `${r.owner}/${r.repo}`,
      tracker,
      forge: forgeOf(db, r),
      missing: tracker === null ? named : null,
      clone: cloneDir(r.owner, r.repo),
      tabClosed: tabClosed(db, r),
    };
  });
}

// Returns whether you closed a repository's tab by exiting its lead.
function tabClosed(db: Database, r: { owner: string; repo: string }): boolean {
  const row = db
    .query("SELECT tab_closed FROM repositories WHERE owner = ? AND repo = ?")
    .get(r.owner, r.repo);
  return z.object({ tab_closed: z.coerce.boolean() }).parse(row).tab_closed;
}

// A thread as sc ps shows it, with the short title the lead gave it, if any, and its whole
// title, which an old row may lack. `queued` says its review waits for a place. `pr`, `prUrl`
// and `checks` are null without a PR, and `review` without a forge, where sc ps leaves those
// columns empty. `checks` is what the PR's CI says, without Skelcrew's own check. `review` is
// where Skelcrew's reviewer stands: its round, and when it was asked for or ended, as an ISO
// time. `waiting` is how many messages wait to be typed into its builder.
export const ThreadRow = z.object({
  thread: z.string(),
  short: z.string().nullable(),
  title: z.string().nullable(),
  status: Thread.shape.status,
  needsYou: z.boolean(),
  queued: z.boolean(),
  branch: z.string(),
  pr: z.number().nullable(),
  prUrl: z.string().nullable(),
  checks: z.enum(["passed", "failed", "running", "none"]).nullable(),
  review: z
    .object({
      state: z.enum(["approved", "changes", "reviewing", "failed", "none"]),
      round: z.number().nullable(),
      at: z.string().nullable(),
    })
    .nullable(),
  waiting: z.number(),
});
export type ThreadRow = z.infer<typeof ThreadRow>;

// Returns what a PR's CI says, from Skelcrew's copy, for sc ps and sc show. Skelcrew's own check
// isn't CI, and one failure is enough to say so while the rest still run.
function ciSummary(pr: Extract<Item, { kind: "pr" }>): "none" | "passed" | "failed" | "running" {
  const ci = pr.checks.filter((check) => check.name !== reviewCheck);
  if (ci.length === 0) return "none";
  if (ci.every((check) => check.state === "passed")) return "passed";
  // Anything neither passed nor running, such as failed or cancelled, counts as failed.
  const failed = ci.some((check) => !["passed", "running"].includes(check.state));
  return failed ? "failed" : "running";
}

// Returns what a review's verdict is in words, for sc show. A forge such as GitHub won't let
// Skelcrew approve its own PR, so Skelcrew's verdict is a comment whose first line says it, such
// as "**Approved**". For those, that line is the verdict.
function reviewVerdict(review: Extract<Item, { kind: "pr" }>["reviews"][number]): string {
  const [first = ""] = review.text.split("\n");
  const said = review.verdict === "commented" ? first.replaceAll("*", "").trim() : "";
  return said || review.verdict;
}

// What CI says in sc ps, from the word Skelcrew saved as it last polled the PR.
const ciWords = { passing: "passed", failing: "failed", pending: "running" } as const;

// Returns what a thread's CI says, for sc ps. A working or waiting thread has the word its
// polls keep, which a submit clears until CI starts on the new commit. Polls pass over any
// other thread, such as one that failed, while its PR in Skelcrew's copy still changes, so its
// CI comes from the copy, as on the PR's page, when the copy has it.
function ciOf(
  thread: Thread,
  copy: Extract<Item, { kind: "pr" }> | null,
): NonNullable<ThreadRow["checks"]> {
  const live = thread.status === "working" || thread.status === "waiting";
  if (!live && copy) return ciSummary(copy);
  return thread.checks === null ? "none" : ciWords[thread.checks];
}

// Returns where a thread's review stands, for sc ps. It reads only the thread's own review, as
// a question, an error or the round limit can come on top of a review under way without
// changing it. A saved submit or commit under review is the next round: running while its
// round runs, and failed once the round ended without clearing it, such as on a failed push.
// Otherwise it is the latest review's verdict and round. A stopped or ended thread has no round
// running, so it shows its latest verdict.
function reviewOf(thread: Thread): NonNullable<ThreadRow["review"]> {
  const at = thread.review_at === null ? null : new Date(thread.review_at).toISOString();
  const live = thread.status === "working" || thread.status === "waiting";
  if (live && (thread.submitting !== null || thread.reviewing !== null)) {
    const state = roundRunning(thread.folder) ? "reviewing" : "failed";
    return { state, round: thread.rounds + 1, at };
  }
  if (thread.verdict === null) return { state: "none", round: null, at: null };
  // A review that timed out twice failed its check, so it shows as failed.
  const states = {
    approve: "approved",
    changes: "changes",
    failed: "failed",
    "timed out": "failed",
  } as const;
  return { state: states[thread.verdict], round: thread.review_round, at };
}

// Returns a thread as sc ps shows it, and as sc ls and sc show show its task's PR, CI and
// review. `forge` is whether its repository has one, as without it there are no PRs. Its PR's
// link comes from Skelcrew's copy, which has a PR while it is open or its thread isn't over. The
// title comes from the tracker and the short title from the lead, so tools get them with no
// control codes.
function threadRow(db: Database, thread: Thread, forge: boolean): ThreadRow {
  const pr = forge ? thread.pr : null;
  const copy = pr === null ? null : prOf(db, thread.owner, thread.repo, pr);
  return {
    thread: threadName(db, thread),
    short: thread.short && removeControlCodes(thread.short),
    title: thread.title && removeControlCodes(thread.title),
    status: thread.status,
    needsYou: needsYou(thread),
    queued: queuedForReview(thread),
    branch: thread.branch,
    pr,
    prUrl: copy?.link ?? null,
    checks: pr === null ? null : ciOf(thread, copy),
    review: forge ? reviewOf(thread) : null,
    waiting: messagesWaiting(db, thread),
  };
}

// Returns the threads, or one repository's, newest first, for sc ps. A thread that starts
// over gets a new row, so it counts as started when it last started.
export function listThreads(db: Database, repository?: string): ThreadRow[] {
  const one = repository ? findRepository(db, repository) : null;
  const all = one
    ? db
        .query("SELECT * FROM task_threads WHERE owner = ? AND repo = ? ORDER BY rowid DESC")
        .all(one.owner, one.repo)
    : db.query("SELECT * FROM task_threads ORDER BY rowid DESC").all();
  // A thread whose repository Skelcrew no longer has has no forge either.
  const withForge = repositories(db).filter((r) => forgeOf(db, r) !== null);
  return all.map((row) => {
    const thread = Thread.parse(row);
    const forge = withForge.some((r) => r.owner === thread.owner && r.repo === thread.repo);
    return threadRow(db, thread, forge);
  });
}

// A task as sc ls shows it: its name, such as app-12, its title and the short title the lead
// gave it, its stage, its issue while that is open in Skelcrew's copy, such as #12, and how its
// builder stands, or null with no thread. `pr` and `checks` are as sc ps gives them for its thread, and
// null with none. `review` is where Skelcrew's review stands, with a forge or without one, and
// null with no thread.
export const TaskRow = z.object({
  task: z.string(),
  stage: Stage,
  title: z.string(),
  short: z.string().nullable(),
  issue: z.string().nullable(),
  thread: z
    .object({ status: Thread.shape.status, needsYou: z.boolean(), queued: z.boolean() })
    .nullable(),
  pr: ThreadRow.shape.pr,
  checks: ThreadRow.shape.checks,
  review: ThreadRow.shape.review,
});
export type TaskRow = z.infer<typeof TaskRow>;

// Returns a task's issue as its tracker writes it. GitHub writes a number as #12, while a
// tracker such as Linear has IDs like JOTT-12 that stand alone.
const issueId = (id: string) => (/^\d+$/.test(id) ? `#${id}` : id);

// Returns the tasks of every repository, or of one, for sc ls: each task with a thread, newest
// first, then each open issue with none, newest first, across all the repositories asked for.
// They come from Skelcrew's database and its copy of the tracker, so the tracker isn't asked.
// A task whose work goes on, a failed thread's included, shows the title it started with, as its
// builder and reviewer see it, however the issue was edited since. Text from the tracker and the
// lead has its control codes removed.
export function listTasks(db: Database, repository?: string): TaskRow[] {
  const chosen = repository ? [findRepository(db, repository)] : repositories(db);
  // Each repository's threads and open issues, kept with when each began, so the two lists can
  // be sorted across repositories once all are in.
  const parts = chosen.map((r) => {
    const forge = forgeOf(db, r) !== null;
    const open = openTasks(db, r.owner, r.repo);
    const rows = db
      .query("SELECT rowid AS at, * FROM task_threads WHERE owner = ? AND repo = ?")
      .all(r.owner, r.repo);
    // A task whose thread is done takes its title from the open issue, which has the tracker's
    // latest words. Otherwise it keeps what the thread saved as it started.
    const worked = rows.map((saved) => {
      const thread = Thread.parse(saved);
      const row = threadRow(db, thread, forge);
      const issue = open.find((item) => item.id === thread.task);
      const latest = thread.status === "done" ? issue?.title : undefined;
      const task: TaskRow = {
        task: `${r.name}-${thread.task}`,
        stage: taskStage(thread, issue !== undefined),
        title: removeControlCodes(latest ?? thread.title ?? issue?.title ?? ""),
        short: row.short,
        issue: issue ? issueId(issue.id) : null,
        thread: { status: row.status, needsYou: row.needsYou, queued: row.queued },
        pr: row.pr,
        checks: row.checks,
        // Reviews run without a forge too, on the branch, so their state shows whatever sc ps
        // leaves out.
        review: reviewOf(thread),
      };
      return { at: z.object({ at: z.number() }).parse(saved).at, id: thread.task, task };
    });
    const waiting = open
      .filter((item) => !worked.some((w) => w.id === item.id))
      .map((item) => {
        const task: TaskRow = {
          task: `${r.name}-${item.id}`,
          stage: "issue",
          title: removeControlCodes(item.title),
          short: null,
          issue: issueId(item.id),
          thread: null,
          pr: null,
          checks: null,
          review: null,
        };
        return { created: item.created, task };
      });
    return { worked, waiting };
  });
  // A thread's rowid grows as threads start, across repositories. Issues sort by when the tracker
  // made them, and the sort keeps each repository's own order, newest first, for the same time.
  const worked = parts.flatMap((p) => p.worked).sort((a, b) => b.at - a.at);
  const waiting = parts
    .flatMap((p) => p.waiting)
    .sort((a, b) => b.created.localeCompare(a.created));
  return [...worked.map((w) => w.task), ...waiting.map((w) => w.task)];
}

// One PR as sc show shows it, from Skelcrew's copy, with its latest review's
// text. `ci` is what its CI says as a whole, and `checks` each CI check, with
// the end of its log for a failed one, as the forge gives it, or null. Everything here that
// came from the forge has its control codes removed.
export const PrPage = z.object({
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  branch: z.string(),
  base: z.string(),
  ci: z.enum(["passed", "failed", "running", "none"]),
  checks: z.array(
    z.object({
      name: z.string(),
      state: z.enum(["running", "passed", "failed", "cancelled"]),
      log: z.string().nullable(),
    }),
  ),
  review: z.object({ verdict: z.string(), author: z.string(), body: z.string() }).nullable(),
  body: z.string(),
  link: z.string(),
});
export type PrPage = z.infer<typeof PrPage>;

// One task as sc show shows it, with its stage. `body` is its description as its reviewer gets
// it. `issue` is the issue it came from, such as #12, with the link the task started with, or the
// one in Skelcrew's copy for a task not started, or null for a task with no issue, such as app-t1. `threads` names each of its threads with its role, such
// as app-12/builder. `pr` is its PR's number, as sc ps gives it, and `review` where Skelcrew's
// review stands, with a forge or without one. `prPage` is its PR from Skelcrew's copy, or null once the copy no longer has
// it, as after a merge.
export const TaskView = z.object({
  task: z.string(),
  stage: Stage,
  title: z.string(),
  issue: z.object({ id: z.string(), link: z.string().nullable() }).nullable(),
  threads: z.array(
    z.object({ thread: z.string(), status: Thread.shape.status, needsYou: z.boolean() }),
  ),
  body: z.string(),
  pr: z.number().nullable(),
  review: ThreadRow.shape.review,
  prPage: PrPage.nullable(),
});
export type TaskView = z.infer<typeof TaskView>;

// Returns text from the forge safe to print, line breaks kept. A check's log often colours its
// lines, and those codes are removed whole, so no stray "[31m" is left behind.
function safeText(text: string): string {
  const colours = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  return text.replace(colours, "").split(/\r?\n/).map(removeControlCodes).join("\n");
}

// How long sc show waits on the forge for a failed check's log, in milliseconds. sc gives up on
// the daemon after a minute, so a forge that hangs must not keep the task itself from showing.
const logDeadline = 10_000;

// Returns a PR as its page shows it, from Skelcrew's copy, or null when the copy doesn't have
// it. It asks the forge only for the logs of failed checks. A log that can't be read, or that
// the forge takes too long on, says why in its place, so the PR still shows.
async function prPageOf(db: Database, repository: Repository, number: number) {
  const pr = prOf(db, repository.owner, repository.repo, number);
  if (!pr) return null;
  // Each CI check, with the end of its log when it failed and has one.
  const checks = await Promise.all(
    pr.checks
      .filter((check) => check.name !== reviewCheck)
      .map(async (check) => {
        const log =
          check.state === "failed" && check.id !== null
            ? await failedLog(db, repository, check.id, logDeadline).catch(
                (error) => `(Skelcrew couldn't read its log: ${errorText(error)})`,
              )
            : null;
        return { name: safeText(check.name), state: check.state, log: log && safeText(log) };
      }),
  );
  const latest = pr.reviews.at(-1);
  return PrPage.parse({
    title: removeControlCodes(pr.title),
    state: pr.state,
    branch: removeControlCodes(pr.branch),
    base: removeControlCodes(pr.base),
    ci: ciSummary(pr),
    checks,
    review: latest
      ? {
          verdict: removeControlCodes(reviewVerdict(latest)),
          author: removeControlCodes(latest.author?.login ?? "unknown"),
          body: safeText(latest.text),
        }
      : null,
    body: safeText(pr.body),
    link: pr.link,
  });
}

// Returns one task for sc show, named by its repository and task. A task with a thread still at work, or stopped, is shown as its reviewer gets it, with the
// lead's messages to the builder after the description, so the lead sees what the builder is
// judged by. A thread that is done or failed starts over fresh, without them, so they aren't
// shown then. It reads Skelcrew's database and copy, and asks the forge only for the logs of
// failed checks. Throws when there is no such task.
export async function showTask(
  db: Database,
  which: { repo: string; task: string },
): Promise<TaskView> {
  const repository = findRepository(db, which.repo);
  const { owner, repo, name } = repository;
  const forge = forgeOf(db, repository) !== null;
  const { task } = which;
  // The task's description: as its reviewer gets it while its thread is current. A failed thread
  // still holds its task until it starts over, so it shows the words it started with, though
  // without the lead's messages, which starting over leaves behind. A done thread shows its open
  // issue's latest words, or else what it saved as it started.
  const thread = threadOn(db, name, task);
  const issue = openTasks(db, owner, repo).find((item) => item.id === task);
  if (!thread && !issue) throw new Error(`there is no task ${name}-${task}`);
  const current = thread && thread.status !== "done" && thread.status !== "failed";
  const described =
    thread && (thread.status !== "done" || !issue)
      ? threadTask(db, current ? thread : { ...thread, updates: [] })
      : { title: issue?.title ?? "", body: issue?.body ?? "" };
  // Its issue, unless it is a task of Skelcrew's own, such as t1.
  const own = /^t\d+$/.test(task);
  const row = thread && threadRow(db, thread, forge);
  const pr = row?.pr ?? null;
  return {
    task: `${name}-${task}`,
    stage: taskStage(thread, issue !== undefined),
    title: removeControlCodes(described.title),
    issue: own ? null : { id: issueId(task), link: thread?.issue_link ?? issue?.link ?? null },
    threads: row
      ? [{ thread: `${name}-${task}/builder`, status: row.status, needsYou: row.needsYou }]
      : [],
    body: safeText(described.body),
    pr,
    // Reviews run without a forge too, so their state shows here even then.
    review: thread && reviewOf(thread),
    prPage: pr === null ? null : await prPageOf(db, repository, pr),
  };
}

// Prints rows as columns lined up under their headings, with no spaces left at line ends.
function table(heading: string[], rows: string[][]): void {
  // Each column is as wide as its widest cell, in the columns it takes, not its letters, as a
  // Japanese title takes two for each.
  const widths = heading.map((_, i) => columnWidth([heading, ...rows], i));
  for (const row of [heading, ...rows])
    console.log(
      row
        .map((cell, i) => filled(cell, widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    );
}

// Returns how many terminal columns the widest cell of a table's column takes.
const columnWidth = (rows: string[][], i: number) =>
  Math.max(...rows.map((row) => Bun.stringWidth(row[i] ?? "")));

// Prints repositories for sc repo ls: as JSON for tools, or else as a table, with the
// plugin to install for a tracker a repository's skelcrew.yaml names that isn't installed, or
// how to bring in the first one. A repository whose tab you closed ends in a dim note, as it
// has no tab to find it by. The note goes last, so its colour codes can't put the columns out
// of line.
export function printRepositories(repositories: RepositoryRow[], json: boolean): void {
  if (json) console.log(JSON.stringify(repositories));
  else if (repositories.length === 0) console.log(noRepositories);
  else
    table(
      ["NAME", "REPOSITORY", "TRACKER", "FORGE", "CLONE"],
      repositories.map((r) => [
        r.name,
        r.repository,
        r.tracker ?? (r.missing ? `${r.missing}, not installed` : "none"),
        r.forge ?? "none",
        r.clone,
        ...(r.tabClosed ? [colorful() ? "\x1b[2mtab closed\x1b[0m" : "tab closed"] : []),
      ]),
    );
}

// The width sc ps keeps its rows to, so they fit a terminal of the usual size.
const psWidth = 80;

// The most columns a thread's name takes in sc ps, and the fewest it is cut to when the other
// columns are at their widest, such as a thread queued for review next to one reviewing r12.
const nameRoom = { most: 20, least: 10 };

// Returns a thread's name cut to `room` columns, in its middle, as a repository's name can be
// long. Its task stays whole, such as -t7, as it is what tells a repository's threads apart.
function shortName(name: string, room: number): string {
  if (Bun.stringWidth(name) <= room) return name;
  const task = name.slice(name.lastIndexOf("-"));
  return `${fitted(name.slice(0, name.length - task.length), room - task.length)}${task}`;
}

// Prints threads for sc ps: as JSON for tools, or else as a table that fits 80 columns. The
// thread's name and its title share what the other columns leave of a row: a long name is cut
// first to 20 columns, or fewer when the others are wide, and the title, its short title or
// its title, takes the rest, so a long one doesn't push the rest out of sight. --json has
// both whole. The title comes from the tracker and the short title from the lead, so their
// control codes are removed, which could break a row or reach your terminal. A review shows
// its round, such as changes r3. WAITING counts the messages waiting for each builder.
export function printThreads(threads: ThreadRow[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(threads));
    return;
  }
  if (threads.length === 0) {
    console.log("There are no threads.");
    return;
  }
  // The columns after the title, as they will show. Waiting says little while many reviews
  // wait their turn, so the status says which. WAITING shows only while a message waits for
  // some builder, so it takes no room from the others the rest of the time.
  const waiting = threads.some((t) => t.waiting > 0);
  const rows = threads.map((t) => {
    const review = t.review === null ? "" : t.review.state;
    const round = t.review?.round == null ? "" : ` r${t.review.round}`;
    return [
      t.queued ? "queued for review" : t.status,
      t.pr === null ? "" : `#${t.pr}`,
      t.checks ?? "",
      `${review}${round}`,
      t.needsYou ? "yes" : "",
      ...(waiting ? [t.waiting === 0 ? "" : `${t.waiting}`] : []),
    ];
  });
  // The name and title share what those columns, and the two spaces after each column but the
  // last, leave of a row. The title keeps at least room for its heading.
  const heading = ["STATUS", "PR", "CI", "REVIEW", "NEEDS YOU", ...(waiting ? ["WAITING"] : [])];
  const others = heading.reduce((sum, _, i) => sum + columnWidth([heading, ...rows], i), 0);
  const left = psWidth - others - 2 * (heading.length + 1);
  const room = Math.min(nameRoom.most, Math.max(left - "TITLE".length, nameRoom.least));
  const names = threads.map((t) => shortName(t.thread, room));
  const nameWidth = columnWidth([["THREAD"], ...names.map((n) => [n])], 0);
  const titleWidth = Math.max(left - nameWidth, "TITLE".length);
  table(
    ["THREAD", "TITLE", ...heading],
    threads.map((t, i) => [
      names[i] ?? "",
      fitted(removeControlCodes(t.short ?? t.title ?? ""), titleWidth),
      ...(rows[i] ?? []),
    ]),
  );
}

// Returns what is happening on a task, for its row in sc ls, such as "waiting · #31 · CI failed ·
// changes r3". A task with no thread has nothing yet.
function happening(task: TaskRow): string {
  const { thread, review } = task;
  const parts: string[] = [];
  if (thread) parts.push(thread.queued ? "queued for review" : thread.status);
  if (thread?.needsYou) parts.push("needs you");
  if (task.pr !== null) parts.push(`#${task.pr}`);
  if (task.checks !== null && task.checks !== "none") parts.push(`CI ${task.checks}`);
  if (review && review.state !== "none")
    parts.push(review.round === null ? review.state : `${review.state} r${review.round}`);
  return parts.join(" · ");
}

// The most columns a task's title takes in sc ls, so a long one doesn't push what is happening
// out of sight.
const titleRoom = 40;

// Prints tasks for sc ls: as JSON for tools, or else as a table with each task's name, its stage,
// its short title or its title, and what is happening on it.
export function printTasks(tasks: TaskRow[], json: boolean): void {
  if (json) console.log(JSON.stringify(tasks));
  else if (tasks.length === 0) console.log("There are no tasks.");
  else
    table(
      ["TASK", "STAGE", "TITLE", "STATUS"],
      tasks.map((task) => [
        task.task,
        task.stage,
        fitted(task.short ?? task.title, titleRoom),
        happening(task),
      ]),
    );
}

// Prints one task for sc show: as JSON for tools, or else its name and title, its facts, then
// its description, its PR's latest review and description, and the logs of failed checks, each
// under a heading that says where it came from.
export function printTask(task: TaskView, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(task));
    return;
  }
  const { prPage, review } = task;
  const issue = task.issue && [task.issue.id, task.issue.link ?? ""].join("  ").trimEnd();
  const threads = task.threads.map(
    (t) => `${t.thread}  ${t.status}${t.needsYou ? ", needs you" : ""}`,
  );
  const pr =
    task.pr === null
      ? "none"
      : prPage
        ? `#${task.pr}  ${prPage.state}  ${prPage.branch} → ${prPage.base}`
        : `#${task.pr}`;
  const facts = [
    ["Stage", task.stage],
    ["Issue", issue ?? "none"],
    // Each thread on a line of its own.
    ...(threads.length === 0
      ? [["Thread", "none"]]
      : threads.map((t, i) => [i ? "" : "Thread", t])),
    ["PR", pr],
    ...(prPage
      ? [
          ["Checks", prPage.ci],
          // Each CI check on a line of its own, under the summary.
          ...prPage.checks.map((check) => ["", `${check.name}: ${check.state}`]),
        ]
      : []),
    // A thread with no review yet says nothing of one.
    ...(review && review.state !== "none"
      ? [["Review", review.round === null ? review.state : `${review.state} r${review.round}`]]
      : []),
    ...(prPage ? [["Link", prPage.link]] : []),
  ];
  console.log(`${task.task}  ${task.title}`);
  for (const [label = "", value = ""] of facts) console.log(`${label.padEnd(8)}${value}`);
  // The longer texts, each after a blank line, with only those that have something to say.
  const latest = prPage?.review;
  const texts: [string, string][] = [
    ["Description", task.body],
    [
      latest ? `Latest review on the PR: ${latest.verdict} · ${latest.author}` : "",
      latest?.body ?? "",
    ],
    ["PR description", prPage?.body ?? ""],
    ...(prPage?.checks ?? []).map((check): [string, string] => [
      `Log of ${check.name}, from the forge`,
      check.log ?? "",
    ]),
  ];
  for (const [heading, text] of texts)
    if (text.trim()) console.log(`\n${heading}\n${text.trimEnd()}`);
}
