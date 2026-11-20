// What the list's details pane says of a task: what sc show gives, from Skelcrew's database and its
// copy of the forge alone, with the latest review's findings and the task's recent events.
import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readTask, type TaskView } from "../flow/list.ts";
import { threadOn } from "../flow/thread.ts";
import { threadsDir } from "../paths.ts";
import { changedAt } from "../screen/lists.ts";
import { removeControlCodes } from "../screen/look.ts";
import type { Open } from "./rows.ts";

// A task's details: sc show's view of it without the logs of failed checks, what its latest
// review found, each in a line, and its recent events, oldest first, such as `13:40 submitted`.
export type Details = { view: TaskView; findings: string[]; events: string[] };

// How much of the end of a thread's log is read for its events. Each line of the log holds the
// whole thread, so a long log is never read whole: the list reads it again each second.
const logTail = 128 * 1024;

// How many events the pane shows at most.
const eventsShown = 6;

// What the events are found from in a line of a thread's log, which holds the thread as it was
// then. A field Skelcrew can't read counts as empty, so an odd line never hides the others.
const LogLine = z.object({
  at: z.string(),
  status: z.string().catch(""),
  submitting: z.string().nullable().catch(null),
  verdict: z.string().nullable().catch(null),
  review_round: z.number().nullable().catch(null),
  reviewed_commit: z.string().nullable().catch(null),
  merged: z.boolean().catch(false),
});
type LogLine = z.infer<typeof LogLine>;

// Returns the lines at the end of a thread's log, at most logTail bytes of it, as the thread was
// at each, oldest first, and whether they start at the log's start. A line cut by where the read
// starts is left out. A log that isn't there, such as for a task never started, has none.
function logEnd(folder: string): { lines: LogLine[]; whole: boolean } {
  let fd: number;
  try {
    fd = openSync(join(threadsDir(), `${folder}.log`), "r");
  } catch {
    return { lines: [], whole: true };
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(size - logTail, 0);
    const bytes = Buffer.alloc(size - from);
    readSync(fd, bytes, 0, bytes.length, from);
    const texts = bytes.toString().split("\n");
    if (from > 0) texts.shift();
    const lines = texts.flatMap((text) => {
      try {
        const line = LogLine.safeParse(JSON.parse(text));
        return line.success ? [line.data] : [];
      } catch {
        return [];
      }
    });
    return { lines, whole: from === 0 };
  } finally {
    closeSync(fd);
  }
}

// Returns a task's recent events from its thread's log, oldest first, each with when it
// happened, at a moment `now` in milliseconds: started, submitted, reviewed, merged and closed.
// Each is found where the thread changed from one line of the log to the next, such as a submit
// waiting where none did, so the words Skelcrew logged with them never matter.
function eventsOf(folder: string, now: number): string[] {
  const { lines, whole } = logEnd(folder);
  const reviewOf = (line: LogLine) =>
    line.verdict === null ? null : `${line.review_round} ${line.verdict} ${line.reviewed_commit}`;
  const events = lines.flatMap((line, i) => {
    const before = lines[i - 1];
    const said: string[] = [];
    if (!before) {
      if (whole) said.push("started");
    } else {
      if (line.submitting !== null && before.submitting === null) said.push("submitted");
      const review = reviewOf(line);
      if (review !== null && review !== reviewOf(before)) said.push("reviewed");
      if (line.merged && !before.merged) said.push("merged");
      else if (line.status === "done" && before.status !== "done" && !line.merged)
        said.push("closed");
    }
    const at = Date.parse(line.at);
    const when = Number.isNaN(at) ? "" : `${changedAt(at, now)} `;
    return said.map((word) => `${when}${word}`);
  });
  return events.slice(-eventsShown);
}

// Returns the details of a task of the open repository, by its ID, such as 12, at a moment `now`
// in milliseconds, or null when Skelcrew has no such task, such as one removed a moment ago. It
// reads the database, its copy of the forge and the thread's log, never the forge itself.
export function readDetails(db: Database, open: Open, task: string, now: number): Details | null {
  const repository = `${open.owner}/${open.repo}`;
  let view: TaskView;
  try {
    view = readTask(db, { repo: repository, task });
  } catch {
    return null;
  }
  const thread = threadOn(db, repository, task);
  // The findings are those the latest review saved, posted or not. A task from before Skelcrew
  // saved them has those of its review posted on this PR, as one opened again after sc rm has
  // none yet.
  const post = thread?.review_post;
  const posted = post && post.pr === thread.pr ? post.findings : [];
  const findings = (thread?.review_findings ?? posted).map((finding) =>
    removeControlCodes(finding),
  );
  return { view, findings, events: thread ? eventsOf(thread.folder, now) : [] };
}
