// What Skelcrew shows you about its work: repositories for sc repo ls, threads for sc ps,
// open tasks for sc issue ls, one task for sc issue show and one PR for sc pr show, as short
// text for a terminal or JSON for tools.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { repositoryTracker } from "../config.ts";
import { colorful } from "../help.ts";
import { cloneDir } from "../paths.ts";
import { failedLog, forgeOf, trackerOf } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { filled, fitted, removeControlCodes } from "../screen/look.ts";
import { type Item, openTasks, prOf, taskOf, threadTask } from "./copy.ts";
import { reviewCheck } from "./decide.ts";
import { ciSummary, reviewVerdict } from "./page.ts";
import { findRepository, noRepositories, repositories, repositoryAt } from "./repo.ts";
import { roundRunning } from "./round.ts";
import { findThread, needsYou, queuedForReview, Thread, threadName, threadOn } from "./thread.ts";

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
// where Skelcrew's reviewer stands: its round, and when it was asked for or ended, as an ISO time.
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
});
export type ThreadRow = z.infer<typeof ThreadRow>;

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
  if (!live && copy) return ciSummary(copy)[0];
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
  const states = { approve: "approved", changes: "changes", failed: "failed" } as const;
  return { state: states[thread.verdict], round: thread.review_round, at };
}

// Returns the threads, or one repository's, newest first, for sc ps. A thread that starts
// over gets a new row, so it counts as started when it last started. Its PR's link comes from
// Skelcrew's copy, which has a PR while it is open or its thread isn't over. The title comes
// from the tracker and the short title from the lead, so tools get them with no control codes.
export function listThreads(db: Database, repository?: string): ThreadRow[] {
  const one = repository ? findRepository(db, repository) : null;
  const all = one
    ? db
        .query("SELECT * FROM threads WHERE owner = ? AND repo = ? ORDER BY rowid DESC")
        .all(one.owner, one.repo)
    : db.query("SELECT * FROM threads ORDER BY rowid DESC").all();
  // A thread whose repository Skelcrew no longer has has no forge either.
  const withForge = repositories(db).filter((r) => forgeOf(db, r) !== null);
  return all.map((row) => {
    const thread = Thread.parse(row);
    const forge = withForge.some((r) => r.owner === thread.owner && r.repo === thread.repo);
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
    };
  });
}

// An open task as sc issue ls shows it, with how its thread stands, or null with no thread.
// `issue` is its name, such as app-12. The key says issue, as the commands do, and is always
// one in the tracker: a thread with no issue, such as app-t1, is never listed here.
export const TaskRow = z.object({
  issue: z.string(),
  title: z.string(),
  thread: z.object({ status: Thread.shape.status, needsYou: z.boolean() }).nullable(),
});
export type TaskRow = z.infer<typeof TaskRow>;

// Returns how the thread on a task stands, or null when it has none.
function threadStatusOf(
  db: Database,
  owner: string,
  repo: string,
  task: string,
): TaskRow["thread"] {
  const row = db
    .query("SELECT * FROM threads WHERE owner = ? AND repo = ? AND task = ?")
    .get(owner, repo, task);
  const thread = Thread.nullable().parse(row);
  return thread && { status: thread.status, needsYou: needsYou(thread) };
}

// Returns the open tasks of every repository, or of one, newest first, with the thread on
// each one that has one, for sc issue ls. They come from Skelcrew's copy, so the tracker isn't
// asked.
export function listTasks(db: Database, repository?: string): TaskRow[] {
  const chosen = repository ? [findRepository(db, repository)] : repositories(db);
  // Each repository's tasks come newest first, but mixing repositories needs a sort of its own,
  // so each row keeps its creation time until the sort is done.
  return chosen
    .flatMap((r) =>
      openTasks(db, r.owner, r.repo).map((task) => ({
        created: task.created,
        issue: `${r.name}-${task.id}`,
        title: task.title,
        thread: threadStatusOf(db, r.owner, r.repo, task.id),
      })),
    )
    .sort((a, b) => b.created.localeCompare(a.created))
    .map(({ created, ...task }) => task);
}

// One task as sc issue show shows it, named under `issue` as in sc issue ls.
export const TaskView = z.object({
  issue: z.string(),
  title: z.string(),
  body: z.string(),
  thread: TaskRow.shape.thread,
});
export type TaskView = z.infer<typeof TaskView>;

// Returns one task's title and body, which is all its builder sees, with the thread on it if
// it has one, for sc issue show. It comes from Skelcrew's copy, so the tracker isn't asked. A
// task with a thread still at work, or stopped, is shown as its reviewer gets it, with the
// lead's messages to the builder after the body, so the lead sees the task the builder is
// judged by. That also shows a thread with no task in the tracker, such as app-t1. A done or
// failed thread's messages aren't shown: starting it over gives a fresh thread without them,
// and a merged thread's issue is closed, which the copy alone can say.
export function showTask(db: Database, repository: string, task: string): TaskView {
  const r = findRepository(db, repository);
  const thread = threadOn(db, repository, task);
  const current = thread && thread.status !== "done" && thread.status !== "failed";
  const { title, body } = current ? threadTask(db, thread) : taskOf(db, r.owner, r.repo, task);
  return {
    issue: `${r.name}-${task}`,
    title,
    body,
    thread: threadStatusOf(db, r.owner, r.repo, task),
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
// its round, such as changes r3.
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
  // wait their turn, so the status says which.
  const rows = threads.map((t) => {
    const review = t.review === null ? "" : t.review.state;
    const round = t.review?.round == null ? "" : ` r${t.review.round}`;
    return [
      t.queued ? "queued for review" : t.status,
      t.pr === null ? "" : `#${t.pr}`,
      t.checks ?? "",
      `${review}${round}`,
      t.needsYou ? "yes" : "",
    ];
  });
  // The name and title share what those columns, and the two spaces after each column but the
  // last, leave of a row. The title keeps at least room for its heading.
  const heading = ["STATUS", "PR", "CI", "REVIEW", "NEEDS YOU"];
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

// Prints open tasks for sc issue ls: as JSON for tools, or else as a table whose thread
// column is empty for a task with no thread.
export function printTasks(tasks: TaskRow[], json: boolean): void {
  if (json) console.log(JSON.stringify(tasks));
  else if (tasks.length === 0) console.log("There are no open issues.");
  else
    table(
      ["ISSUE", "THREAD", "TITLE"],
      tasks.map(({ issue, title, thread }) => {
        const status = thread ? `${thread.status}${thread.needsYou ? ", needs you" : ""}` : "";
        return [issue, status, title];
      }),
    );
}

// Prints one task for sc issue show: as JSON for tools, or else its name and title, the
// thread on it if it has one, and its body after a blank line.
export function printTask(task: TaskView, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(task));
    return;
  }
  console.log(`${task.issue}  ${task.title}`);
  if (task.thread)
    console.log(`Thread: ${task.thread.status}${task.thread.needsYou ? ", needs you" : ""}`);
  if (task.body) console.log(`\n${task.body.trimEnd()}`);
}

// One PR as sc pr show shows it, from Skelcrew's copy: what its page on the screen shows, with
// the thread on it, if any, and its latest review's text. `ci` is what its CI says as a whole,
// and `checks` each CI check, with the end of its log for a failed one, as the forge gives it,
// or null. Everything here that came from the forge has its control codes removed.
export const PrView = z.object({
  pr: z.number(),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  branch: z.string(),
  base: z.string(),
  thread: z.string().nullable(),
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
export type PrView = z.infer<typeof PrView>;

// Returns text from the forge safe to print, line breaks kept. A check's log often colours its
// lines, and those codes are removed whole, so no stray "[31m" is left behind.
function safeText(text: string): string {
  const colours = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  return text.replace(colours, "").split(/\r?\n/).map(removeControlCodes).join("\n");
}

// How long sc pr show waits on the forge for a failed check's log, in milliseconds. sc gives up
// on the daemon after a minute, so a forge that hangs must not keep the PR itself from showing.
const logDeadline = 10_000;

// Returns a PR for sc pr show, named by its number or by its thread's task, in the repository
// `repo` names, or else in the one whose remote is `from`, the checkout sc ran in. It reads
// Skelcrew's copy, so it asks the forge only for the logs of failed checks. A log that can't be
// read says why in its place. Throws when the repository has no forge, and so no PRs, and when
// the copy has no such PR, such as one closed with no thread at work on it. A log the forge takes
// too long on is given up on, so the PR still shows.
export async function showPr(
  db: Database,
  which: {
    repo?: string | undefined;
    from?: string | undefined;
    pr?: number | undefined;
    task?: string | undefined;
  },
): Promise<PrView> {
  // Find the repository, then the PR's number, from its thread when a thread names it.
  const repository =
    which.repo !== undefined
      ? findRepository(db, which.repo)
      : which.from !== undefined
        ? repositoryAt(db, which.from)
        : undefined;
  if (!repository)
    throw new Error(
      "name the PR's thread, such as app-12, or run sc pr show in a checkout of its repository",
    );
  const { owner, repo, name } = repository;
  if (forgeOf(db, repository) === null)
    throw new Error(`${name} has no forge, so there are no PRs`);
  let number = which.pr;
  if (which.task !== undefined) {
    const thread = findThread(db, name, which.task);
    if (thread.pr === null) throw new Error(`${name}-${which.task} has no PR yet`);
    number = thread.pr;
  }
  if (number === undefined) throw new Error("sc pr show needs a PR number or a thread");
  const pr = prOf(db, owner, repo, number);
  if (!pr) throw new Error(`Skelcrew has no PR #${number} in ${owner}/${repo}`);
  // The thread on the PR, the newest, as a thread that starts over keeps its PR's number.
  const row = db
    .query("SELECT * FROM threads WHERE owner = ? AND repo = ? AND pr = ? ORDER BY rowid DESC")
    .get(owner, repo, number);
  const thread = Thread.nullable().parse(row);
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
  const [ci] = ciSummary(pr);
  return PrView.parse({
    pr: number,
    title: removeControlCodes(pr.title),
    state: pr.state,
    branch: removeControlCodes(pr.branch),
    base: removeControlCodes(pr.base),
    thread: thread && threadName(db, thread),
    ci,
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

// Prints one PR for sc pr show: as JSON for tools, or else its number and title, its facts as
// its page shows them, then its latest review, its description and the logs of failed checks,
// each under a heading that says where it came from.
export function printPr(pr: PrView, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(pr));
    return;
  }
  const review = pr.review ? `${pr.review.verdict} · ${pr.review.author}` : "none";
  const facts = [
    ["State", pr.state],
    ["Branch", `${pr.branch} → ${pr.base}`],
    ["Thread", pr.thread ?? "none"],
    ["Checks", pr.ci],
    // Each CI check on a line of its own, under the summary.
    ...pr.checks.map((check) => ["", `${check.name}: ${check.state}`]),
    ["Review", review],
    ["Link", pr.link],
  ];
  console.log(`#${pr.pr}  ${pr.title}`);
  for (const [label = "", value = ""] of facts) console.log(`${label.padEnd(8)}${value}`);
  // The longer texts, each after a blank line, with only those that have something to say.
  const texts: [string, string][] = [
    ["Latest review", pr.review?.body ?? ""],
    ["Description", pr.body],
    ...pr.checks.map((check): [string, string] => [
      `Log of ${check.name}, from the forge`,
      check.log ?? "",
    ]),
  ];
  for (const [heading, text] of texts)
    if (text.trim()) console.log(`\n${heading}\n${text.trimEnd()}`);
}
