// Assigning a thread's issue to you in its tracker as the thread starts, and taking you off
// again when it stops, is removed, or its PR closes without merging.
import type { Database } from "bun:sqlite";
import { assignTask, claimTask, trackerOf } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { readThread, record, repositoryOf, type Thread, threadName } from "./thread.ts";

// The last claim, assignment or removal asked for each thread, by its folder. Each waits for
// the one before it, so they reach the tracker in the order asked. Otherwise sc start right
// after sc stop could assign you before the stop took you off, and leave a running thread's
// issue with nobody assigned.
const queued = new Map<string, Promise<void>>();

// Runs the work once the thread's earlier work with the tracker is done, without waiting for
// it. Nobody waits: the tracker can take up to a minute to answer, as long as sc start, sc stop
// and sc rm wait for theirs, and the work changes only what the tracker shows. So a failure is
// logged with `failed`, never tried again, and never holds up a thread starting or stopping.
function inOrder(folder: string, failed: string, work: () => Promise<void>): void {
  const next = (queued.get(folder) ?? Promise.resolve())
    .then(work)
    .catch((error) => console.log(`${failed}: ${errorText(error)}`))
    .finally(() => {
      if (queued.get(folder) === next) queued.delete(folder);
    });
  queued.set(folder, next);
}

// Claims the thread's issue, when `claim` says to, and assigns it to you, then saves that
// Skelcrew assigned you, when it did. sc start claims as a labeled start does, so the issue shows
// Skelcrew took it, but starts the thread whatever the answer. A thread with no issue, such as
// app-t1, or in a repository with no tracker, has nothing to assign.
export function assignIssue(db: Database, thread: Thread, claim: boolean): void {
  inOrder(thread.folder, `couldn't assign you ${thread.folder}'s issue`, async () => {
    const repository = repositoryOf(db, thread);
    if (/^t\d+$/.test(thread.task) || trackerOf(db, repository) === null) return;
    const name = threadName(db, thread);
    if (claim)
      await claimTask(db, repository, thread.task).catch((error) =>
        console.log(`couldn't claim ${name}'s issue: ${errorText(error)}`),
      );
    // A false answer leaves what the thread had: you were assigned already, which may be
    // Skelcrew's own doing before the thread failed and started over.
    if (await assignTask(db, repository, thread.task, true))
      record(db, thread.folder, { assigned: true }, "assigned you its issue");
  });
}

// Takes you off the thread's issue, but only if Skelcrew assigned you, so an issue that was
// yours before stays yours. Whether it did is read once the work before it is done, as an
// assignment still under way may set it.
export function unassignIssue(db: Database, folder: string): void {
  inOrder(folder, `couldn't take you off ${folder}'s issue`, async () => {
    const thread = readThread(db, folder);
    if (!thread.assigned) return;
    await assignTask(db, repositoryOf(db, thread), thread.task, false);
    record(db, folder, { assigned: false }, "took you off its issue");
  });
}
