// Skelcrew's copy of each repository's open tasks, from its tracker, and open PRs, from its forge,
// as items. The sidebar, pages, sc issue and a builder's first message read it, so none of
// them waits on the tracker.
import type { Database } from "bun:sqlite";
import { z } from "zod";

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

// A task's ID in its tracker, or Skelcrew's own for a thread with no task there, such as t1. It
// names the thread's folder, which setup deletes, and its branch, so it holds only letters,
// digits, underscores and dashes, starting with a letter or digit: never a / or a .. that
// would reach outside Skelcrew's threads folder.
export const TaskId = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][\w-]*$/);

// What an item has whatever its kind. An ID is the tracker's own, such as "12" on GitHub, and
// is checked as the plugin answers, so one that isn't a plain name is refused once, there.
// Times are as the tracker wrote them, which for GitHub sort as text. The link becomes a
// terminal link, so it may hold only printable characters, with no space.
const common = {
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
// that closes it when a PR's body holds it. A cancelled check isn't the builder's to fix.
export const Item = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), ...common, closes: z.string() }),
  z.object({
    kind: z.literal("pr"),
    ...common,
    branch: z.string(),
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

// Brings the copy of a repository up to date with what its tracker or forge just said. For each
// kind in `everything`, the items are all of that kind that is open, so one the copy has that isn't
// among them is no longer open. A closed item stays while a thread that isn't over points to it, as
// its builder and reviewer still read its task. Also saves how many tasks and PRs are open, for the
// sidebar's count of the rows it has no room for. All at once, so no reader sees half.
export function saveItems(
  db: Database,
  owner: string,
  repo: string,
  items: Item[],
  everything: Item["kind"][],
): void {
  db.transaction(() => {
    // Mark every open item of each kind the answer covers closed, then save the answer over
    // them, so what is still open ends up open again.
    for (const kind of everything)
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
    // Forget the items that are no longer open, unless a thread still working, waiting or
    // stopped points to one by its task or PR.
    db.run(
      `DELETE FROM items WHERE owner = ? AND repo = ? AND state != 'open' AND NOT EXISTS (
        SELECT 1 FROM threads t WHERE t.owner = items.owner AND t.repo = items.repo
          AND t.status IN ('working', 'waiting', 'stopped')
          AND items.id = CAST((CASE items.kind WHEN 'task' THEN t.task ELSE t.pr END) AS TEXT))`,
      [owner, repo],
    );
    // Count what is left open, for the sidebar.
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
// older Skelcrew.
const parsed = (rows: unknown[]) =>
  rows.map((row) => Item.parse(JSON.parse(z.object({ item: z.string() }).parse(row).item)));

// Returns a task from the copy, open or kept for its thread, for its builder, its reviewer and
// sc issue show. Throws when the copy doesn't have it.
export function taskOf(db: Database, owner: string, repo: string, task: string): Task {
  const [found] = parsed(
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
  const [found] = parsed(
    db
      .query("SELECT item FROM items WHERE owner = ? AND repo = ? AND kind = 'pr' AND id = ?")
      .all(owner, repo, String(pr)),
  );
  return found?.kind === "pr" ? found : null;
}

// Returns a repository's open tasks, newest first, for sc issue ls and for starting a thread
// on each one labeled to start.
export function openTasks(db: Database, owner: string, repo: string): Task[] {
  // Tasks made at the same moment sort by ID as numbers, as a longer number is the larger one.
  return parsed(
    db
      .query(`SELECT item FROM items WHERE owner = ? AND repo = ? AND kind = 'task'
        AND state = 'open' ORDER BY created DESC, length(id) DESC, id DESC`)
      .all(owner, repo),
  ).flatMap((item) => (item.kind === "task" ? [item] : []));
}

// Returns the item a sidebar row links to, for its page, or null when the copy has none there.
export function itemAt(db: Database, link: string): Item | null {
  const rows = db.query("SELECT item FROM items WHERE json_extract(item, '$.link') = ?").all(link);
  return parsed(rows)[0] ?? null;
}

// Returns the task a thread works on, for its reviewer and its PR: its item in Skelcrew's copy,
// where the tracker's latest words are, or else what the thread saved as it started, as for a
// thread with no task in the tracker. Only a task from the copy has a line that closes it.
export function threadTask(
  db: Database,
  thread: { owner: string; repo: string; task: string; title: string | null; body: string | null },
): { title: string; body: string; closes: string | null } {
  // taskOf throws when the copy has no such task, which is the sign to use the thread's own.
  try {
    const { title, body, closes } = taskOf(db, thread.owner, thread.repo, thread.task);
    return { title, body, closes };
  } catch {
    return { title: thread.title ?? "", body: thread.body ?? "", closes: null };
  }
}
