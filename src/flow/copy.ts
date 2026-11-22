// Skelcrew's copy of each repository's open tasks, from its tracker, and open PRs, from its forge,
// as items. The sidebar, pages, sc ls, sc show and a builder's first message read it, so none of
// them waits on the tracker.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { hasTasks, readJson } from "../db.ts";

// Who wrote an item, review or comment. `you` is whether it is you, as signed in to the
// tracker or forge. `push` is whether they can push to the repository, or null where the
// plugin didn't ask, which an item saved before Skelcrew asked holds too.
const Author = z.object({
  login: z.string(),
  bot: z.boolean(),
  you: z.boolean(),
  push: z.boolean().nullable().default(null),
});

// A comment on an item, or the text of a review on a PR.
const Comment = z.object({ id: z.string(), text: z.string(), author: Author.nullable() });

// An issue's ID in its tracker, such as 12, or a task's own ID, such as t1. It holds only
// letters, digits, underscores and dashes, starting with a letter or digit: never a / or a ..
// that would reach outside Skelcrew's folders.
export const TaskId = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][\w-]*$/);

// What an item has whatever its kind. An ID is the tracker's own, such as "12" on GitHub, and
// is checked as the plugin answers, so one that isn't a plain name is refused once, there. An
// issue's `ref` is its ID as the tracker writes it, such as #12, which an older plugin leaves out.
// Times are as the tracker wrote them, which for GitHub sort as text. The link becomes a
// terminal link, so it may hold only printable characters, with no space.
const itemFields = {
  id: TaskId,
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  author: Author.nullable(),
  labels: z.array(z.string()),
  link: z.string().regex(/^https:\/\/[!-~]+$/),
  created: z.string(),
  updated: z.string(),
};

// A task or a PR in Skelcrew's words, whichever tracker or forge it came from. A task has the line
// that closes it when a PR's body holds it. A PR has its head commit, which m on the screen merges
// only while it is still the head, or null from a forge too old to send it. A cancelled check
// isn't the builder's to fix.
export const Item = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task"),
    ...itemFields,
    closes: z.string(),
    ref: z
      .string()
      .regex(/^[!-~]+$/)
      .optional(),
  }),
  z.object({
    kind: z.literal("pr"),
    ...itemFields,
    branch: z.string(),
    head: z.string().nullable().default(null),
    base: z.string(),
    conflicts: z.boolean(),
    checks: z.array(
      z.object({
        name: z.string(),
        id: z.string().nullable(),
        state: z.enum(["running", "passed", "failed", "cancelled"]),
      }),
    ),
    reviews: z.array(
      Comment.extend({
        verdict: z.enum(["approved", "changes requested", "commented", "dismissed"]),
        lines: z.array(
          z.object({ path: z.string(), line: z.number().nullable(), text: z.string() }),
        ),
      }),
    ),
    comments: z.array(Comment),
  }),
]);
export type Item = z.infer<typeof Item>;
export type Task = Extract<Item, { kind: "task" }>;

// Brings Skelcrew's copy of a repository up to date with what its tracker or forge just
// answered. For each kind in `completeKinds`, `items` holds every open item of that kind, so
// an item of it in the copy that isn't among them is closed. A closed item is kept while a
// thread that isn't over points to it, as its builder and reviewer still read its task. Also
// saves how many tasks and PRs are open with the repository. It is one transaction, so no reader sees half of it.
export function saveItems(
  db: Database,
  owner: string,
  repo: string,
  items: Item[],
  completeKinds: Item["kind"][],
): void {
  db.transaction(() => {
    // Mark every open item of each kind the answer covers closed, then save the answer over
    // them, so what is still open ends up open again.
    for (const kind of completeKinds)
      db.run(
        `UPDATE items SET state = 'closed', item = json_set(item, '$.state', 'closed')
          WHERE owner = ? AND repo = ? AND kind = ? AND state = 'open'`,
        [owner, repo, kind],
      );
    for (const item of items)
      db.run(
        `INSERT OR REPLACE INTO items (owner, repo, kind, id, state, created, item)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [owner, repo, item.kind, item.id, item.state, item.created, JSON.stringify(item)],
      );
    // Each task keeps its PR's link, as the copy forgets a closed PR once its thread is done, and
    // the list still opens the PR of a task that ended. Written only when it changed, as this
    // runs at every poll. A database whose threads haven't moved onto tasks yet keeps the task's
    // columns on its threads.
    const table = hasTasks(db) ? "tasks" : "threads";
    const link = `(SELECT json_extract(i.item, '$.link') FROM items i
      WHERE i.owner = ${table}.owner AND i.repo = ${table}.repo AND i.kind = 'pr'
        AND i.id = CAST(${table}.pr AS TEXT) AND json_valid(i.item))`;
    db.run(
      `UPDATE ${table} SET pr_link = ${link}
        WHERE owner = ? AND repo = ? AND ${link} IS NOT NULL AND pr_link IS NOT ${link}`,
      [owner, repo],
    );
    // A task named after its issue before every task took a number kept its name in lowercase,
    // which the upgrade made its issue, such as jott-12. It takes the tracker's own spelling,
    // such as JOTT-12, so it matches its issue wherever Skelcrew looks.
    const spelled = `(SELECT i.id FROM items i WHERE i.owner = ${table}.owner AND i.repo = ${table}.repo
      AND i.kind = 'task' AND lower(i.id) = lower(${table}.issue))`;
    db.run(
      `UPDATE ${table} SET issue = ${spelled}
        WHERE owner = ? AND repo = ? AND ${spelled} IS NOT NULL AND issue IS NOT ${spelled}`,
      [owner, repo],
    );
    // Forget the items that are no longer open, unless a thread still queued, working, waiting
    // or stopped points to one by its issue or PR.
    db.run(
      `DELETE FROM items WHERE owner = ? AND repo = ? AND state != 'open' AND NOT EXISTS (
        SELECT 1 FROM task_threads t WHERE t.owner = items.owner AND t.repo = items.repo
          AND t.status IN ('queued', 'working', 'waiting', 'stopped')
          AND items.id = CAST((CASE items.kind WHEN 'task' THEN t.issue ELSE t.pr END) AS TEXT))`,
      [owner, repo],
    );
    // Count what is left open.
    db.run(
      `UPDATE repositories SET
        open_issues = (SELECT COUNT(*) FROM items i WHERE i.owner = repositories.owner
          AND i.repo = repositories.repo AND i.kind = 'task' AND i.state = 'open'),
        open_prs = (SELECT COUNT(*) FROM items i WHERE i.owner = repositories.owner
          AND i.repo = repositories.repo AND i.kind = 'pr' AND i.state = 'open')
        WHERE owner = ? AND repo = ?`,
      [owner, repo],
    );
  })();
}

// Returns the items that the query's rows hold, checked, as what was saved could come from an
// older Skelcrew. An item it can't read is left out until the next poll saves it again.
const parseItems = (rows: unknown[]) =>
  rows.flatMap(
    (row) =>
      readJson("items.item", z.object({ item: z.string() }).parse(row).item, Item, null) ?? [],
  );

// Returns an issue as its tracker writes it, such as #12 or JOTT-12: as the copy has it, else as
// the task saved it as it started, as a closed issue leaves the copy. A plugin that doesn't say
// how its tracker writes it, such as an older one, has its ID shown as it is.
export const issueRef = (
  id: string,
  inCopy?: { ref?: string | undefined },
  saved?: string | null,
) => inCopy?.ref ?? saved ?? id;

// Returns a task from the copy, open or kept for its thread, for its builder, its reviewer and
// sc show. Throws when the copy doesn't have it.
export function taskOf(db: Database, owner: string, repo: string, task: string): Task {
  const [found] = parseItems(
    db
      .query("SELECT item FROM items WHERE owner = ? AND repo = ? AND kind = 'task' AND id = ?")
      .all(owner, repo, task),
  );
  if (found?.kind !== "task") throw new Error(`there is no open issue ${task} in ${owner}/${repo}`);
  return found;
}

// Returns a thread's PR from the copy, as its forge last answered it, or null when the copy
// doesn't have it. A forge answers only what changed since the last poll, so a PR whose events
// were held back, such as for a stopped thread, comes from here until it changes again.
export function prOf(
  db: Database,
  owner: string,
  repo: string,
  pr: number,
): Extract<Item, { kind: "pr" }> | null {
  const [found] = parseItems(
    db
      .query("SELECT item FROM items WHERE owner = ? AND repo = ? AND kind = 'pr' AND id = ?")
      .all(owner, repo, String(pr)),
  );
  return found?.kind === "pr" ? found : null;
}

// Returns a repository's open tasks, newest first, for sc ls and for starting a thread
// on each one labeled to start.
export function openTasks(db: Database, owner: string, repo: string): Task[] {
  // Tasks made at the same moment sort by ID as numbers, as a longer number is the larger one.
  return parseItems(
    db
      .query(`SELECT item FROM items WHERE owner = ? AND repo = ? AND kind = 'task'
        AND state = 'open' ORDER BY created DESC, length(id) DESC, id DESC`)
      .all(owner, repo),
  ).flatMap((item) => (item.kind === "task" ? [item] : []));
}

// Returns a repository's open PRs, newest first, for the list of PRs.
export function openPrs(
  db: Database,
  owner: string,
  repo: string,
): Extract<Item, { kind: "pr" }>[] {
  return parseItems(
    db
      .query(`SELECT item FROM items WHERE owner = ? AND repo = ? AND kind = 'pr'
        AND state = 'open' ORDER BY created DESC, length(id) DESC, id DESC`)
      .all(owner, repo),
  ).flatMap((item) => (item.kind === "pr" ? [item] : []));
}

// Returns the item a list's row links to, for its page, or null when the copy has none there.
// Each item is read and checked here, not picked by SQLite's json_extract, which stops on any
// item that isn't JSON, however good the one at the link. It runs only as a page opens.
export function itemAt(db: Database, link: string): Item | null {
  const items = parseItems(db.query("SELECT item FROM items").all());
  return items.find((item) => item.link === link) ?? null;
}

// Returns the task a thread works on, for its builder, its reviewer, its PR and sc show:
// the title and body saved as it started. Later edits to the issue never reach a started task,
// so the reviewer checks against what the builder was given, and the lead passes on what
// matters as a message. A row from before Skelcrew saved them falls back on the copy's words.
// The line that closes its issue is the one saved as it started too, so its PR closes the issue
// though the tracker or the copy changed since, and an empty one closes nothing, whatever the
// copy says now. A row from before Skelcrew saved it takes the copy's. The lead's messages to the builder follow
// the body, oldest first, as changes to the task: a reviewer that didn't see them would ask the
// builder to undo what you agreed.
export function threadTask(
  db: Database,
  thread: {
    owner: string;
    repo: string;
    issue: string | null;
    title: string | null;
    body: string | null;
    closes: string | null;
    updates: { at: number; text: string }[];
  },
): { title: string; body: string; closes: string | null } {
  // taskOf throws when the copy has no such issue.
  let issue: Task | null = null;
  try {
    if (thread.issue !== null) issue = taskOf(db, thread.owner, thread.repo, thread.issue);
  } catch {}
  const task = {
    title: thread.title ?? issue?.title ?? "",
    body: thread.title === null ? (issue?.body ?? "") : (thread.body ?? ""),
    closes: thread.closes ?? issue?.closes ?? null,
  };
  if (thread.updates.length === 0) return task;
  // Each message under the time it was typed in, in UTC, as the reviewer has no time zone.
  const updates = thread.updates.map(
    ({ at, text }) =>
      `### ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC\n\n${text.trim()}`,
  );
  const heading =
    "## Changes to the task from the lead, after the thread started\n\nThese override the task above where they differ. The latest comes last.";
  const body = [task.body.trimEnd(), heading, ...updates].filter((part) => part !== "");
  return { ...task, body: body.join("\n\n") };
}
