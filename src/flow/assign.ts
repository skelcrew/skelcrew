// Assigning a thread's issue to you in its tracker as the thread starts, and taking you off
// again when it stops, is removed, or its PR closes without merging.
import type { Database } from "bun:sqlite";
import { assignTask, claimTask, trackerOf } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { readThread, record, repositoryOf, type Thread, threadName } from "./thread.ts";

// The assignments under way, by thread folder, so taking you off first waits for one still
// being made. Otherwise a thread stopped just after it started would leave you assigned.
const assigning = new Map<string, Promise<void>>();

// Claims the thread's issue, when `claim` says to, and assigns it to you, then saves that
// Skelcrew assigned you, when it did. sc start claims as a labeled start does, so the issue shows
// Skelcrew took it, but starts the thread whatever the answer. A thread with no issue, such as
// app-t1, or in a repository with no tracker, has nothing to assign. Not waited on: both only
// change what the tracker shows, so a failure is logged, never tried again, and never holds
// up the start.
export function assignIssue(db: Database, thread: Thread, claim: boolean): void {
  const assign = async () => {
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
  };
  const work = assign()
    .catch((error) =>
      console.log(`couldn't assign you ${thread.folder}'s issue: ${errorText(error)}`),
    )
    .finally(() => {
      if (assigning.get(thread.folder) === work) assigning.delete(thread.folder);
    });
  assigning.set(thread.folder, work);
}

// Takes you off the thread's issue, but only if Skelcrew assigned you, so an issue that was
// yours before stays yours. A failure is logged and not tried again, and never stops the
// thread from stopping or ending.
export async function unassignIssue(db: Database, folder: string): Promise<void> {
  await assigning.get(folder);
  try {
    const thread = readThread(db, folder);
    if (!thread.assigned) return;
    await assignTask(db, repositoryOf(db, thread), thread.task, false);
    record(db, folder, { assigned: false }, "took you off its issue");
  } catch (error) {
    console.log(`couldn't take you off ${folder}'s issue: ${errorText(error)}`);
  }
}
