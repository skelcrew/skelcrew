// Acting on a thread's PR events: typing them into its builder. Also ending the builder for a
// merge, sc stop or sc rm, which must cancel any typing still under way.
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { agentRuns, stopSession } from "../agents/tmux.ts";
import { typeInto } from "../agents/typing.ts";
import { cloneDir } from "../paths.ts";
import { closePr, failedLog, markSeen } from "../plugins/ask.ts";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { unassignIssue } from "./assign.ts";
import { baseOf } from "./builder.ts";
import type { Check, Decision } from "./decide.ts";
import { deleteBranch, fetchInto, onRemote } from "./git.ts";
import { typeLeadNotes } from "./lead.ts";
import { refreshClones } from "./repo.ts";
import { endRound } from "./round.ts";
import {
  builderHarness,
  cloneOf,
  readThread,
  record,
  repositoryOf,
  type Thread,
  threadName,
} from "./thread.ts";

// Returns a message for each failed check, with the end of its log, for the builder to fix.
// A check with no ID, such as a commit status, has no log to read. A log that can't be read
// is said so in the message, so the builder still hears of the failure.
async function failedCheckMessages(
  db: Database,
  thread: Thread,
  failed: Check[],
): Promise<string[]> {
  const fix = 'Fix it, commit, and run sc submit "<summary>" again.';
  return Promise.all(
    failed.map(async (c) => {
      if (c.id === null) return `The check ${c.name} failed. ${fix}`;
      const log = await failedLog(db, repositoryOf(db, thread), c.id).catch(
        (error) => `(Skelcrew couldn't read its log: ${errorText(error)})`,
      );
      return `The check ${c.name} failed. The end of its log:\n\n${log}\n\n${fix}`;
    }),
  );
}

// Brings the base branch up to date in Skelcrew's clone of the repository. The builder's clone
// has Skelcrew's clone as origin, so its next fetch gets the latest base. Otherwise Skelcrew's
// clone is refreshed only when you attach or the daemon starts, and holds only the default
// branch.
async function refreshBase(db: Database, thread: Thread, base: string): Promise<void> {
  // Refreshing brings the default branch up to date. Any other base is fetched on its own.
  await refreshClones(db);
  if (base !== baseOf({ ...thread, base: null }))
    await fetchInto(db, repositoryOf(db, thread), cloneDir(thread.owner, thread.repo), base);
}

// The typing of events under way, by thread folder, with what cancels it. A poll leaves a
// thread alone while its events are typed in, so they are never typed twice. A merge, sc stop
// or sc rm cancels the typing.
export const typingEvents = new Map<string, AbortController>();

// Cancels the round and the typing under way for the thread, ends its builder's session, and
// waits for the builder to exit, so nothing types into it or changes the thread afterwards.
async function endBuilder(tmux: string, folder: string): Promise<void> {
  typingEvents.get(folder)?.abort();
  endRound(folder);
  // Claude Code can outlive the end of its session for a few seconds, still writing in the
  // clone.
  await stopSession(tmux, folder);
}

// Stops the thread for sc stop: marks it stopped, then ends its builder as a merge would,
// but keeps its clone, branch and PR, so sc start can bring the builder back where it was.
// A submit, review or review's changes under way stay saved and carry on once it starts
// again. It no longer needs you: you stopped it, and its builder's question ended with it.
// It takes you off its issue, if Skelcrew assigned you. Marked first, so a builder that submits while it exits is refused. Refuses a thread that
// has no builder to stop, or whose builder hasn't started yet.
export async function stopThread(db: Database, tmux: string, thread: Thread): Promise<void> {
  const name = threadName(db, thread);
  if (thread.status === "stopped") throw new Error(`${name} is stopped already`);
  if (thread.status !== "working" && thread.status !== "waiting")
    throw new Error(`${name} is ${thread.status}, so it has no builder to stop`);
  // Its setup would go on to start the builder after the stop.
  if (thread.session === null)
    throw new Error(`${name} is still setting up: stop it once its builder has started`);
  record(db, thread.folder, { status: "stopped", needs_you: false, asking: false }, "stopped");
  await endBuilder(tmux, thread.folder);
  await unassignIssue(db, thread.folder);
}

// Ends the thread once its PR is merged or closed, or for sc rm: ends its builder, and removes
// its clone by deleting the folder, never running git in it.
export async function endThread(
  db: Database,
  tmux: string,
  thread: Thread,
  why: string,
): Promise<void> {
  await endBuilder(tmux, thread.folder);
  rmSync(cloneOf(thread), { recursive: true, force: true });
  // Skelcrew's clone keeps refs of the branch it pushed, named by the thread's folder. A thread
  // started over in that folder would be taken for one that pushed already, and without a forge
  // ended at once, as its branch isn't on the remote.
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  for (const kind of ["threads", "bases", "remote"])
    await quietly([
      "git",
      "-C",
      skelcrewClone,
      "update-ref",
      "-d",
      `refs/skelcrew/${kind}/${thread.folder}`,
    ]);
  record(db, thread.folder, { status: "done", needs_you: false }, `${why}: ended the thread`);
}

// Removes the thread for sc rm: ends its builder, closes its PR with the reason as a comment,
// deletes its branch on the forge, removes its clone, takes you off its issue if Skelcrew
// assigned you, and marks it done. Its task stays open,
// so sc start can start the thread over on it. Without a PR, the branch is deleted with git,
// but only if Skelcrew pushed it for this thread. A running thread is marked stopped first, so
// a builder that submits while it exits is refused. If the forge fails, the thread stays
// short of done, so sc rm can run again. Refuses a thread that is done, and one still setting
// up, whose setup would go on to start its builder.
export async function removeThread(
  db: Database,
  tmux: string,
  thread: Thread,
  reason: string | undefined,
): Promise<void> {
  // Refuse what can't be removed, then stop a thread still running.
  const name = threadName(db, thread);
  if (thread.status === "done") throw new Error(`${name} is done already`);
  const live = thread.status === "working" || thread.status === "waiting";
  if (live && thread.session === null)
    throw new Error(`${name} is still setting up: remove it once its builder has started`);
  if (live)
    record(db, thread.folder, { status: "stopped", needs_you: false, asking: false }, "removing");
  // A push under way would put back the branch, or open a PR after none was closed, so it is
  // waited for, and the thread read again for the PR it may have opened.
  const pushing = endRound(thread.folder);
  await endBuilder(tmux, thread.folder);
  await pushing;
  // Close the PR, which deletes its branch on the forge too. With no PR, as a repository with
  // no forge has, delete the branch only if this thread pushed it: Skelcrew keeps a ref of each
  // push in its clone, and a branch of the same name may be someone else's.
  const { pr, branch } = readThread(db, thread.folder);
  const repository = repositoryOf(db, thread);
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const threadPushedBranch = async () =>
    (
      await quietly([
        "git",
        "-C",
        skelcrewClone,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/skelcrew/threads/${thread.folder}`,
      ])
    ).ok;
  if (pr !== null)
    await closePr(db, repository, {
      pr,
      branch,
      comment: reason ? `Closed by Skelcrew: ${reason}` : null,
    });
  else if ((await threadPushedBranch()) && (await onRemote(db, repository, branch)))
    await deleteBranch(db, repository, skelcrewClone, branch);
  await unassignIssue(db, thread.folder);
  await endThread(db, tmux, thread, reason ? `removed: ${reason}` : "removed");
}

// Types what the decision tells into the builder once it is idle, then saves the decision.
// It is saved only after, so a stop of the daemon meanwhile leaves the events to the next
// poll. Then asks the forge to mark the people's reviews and comments seen, so they can see it
// on the PR. A builder that isn't running, or stays busy for half an hour, isn't told: the
// events count as handled, and the thread needs you, with what it missed in its log.
export async function tellBuilder(
  db: Database,
  tmux: string,
  thread: Thread,
  decision: Exclude<Decision, { end: string }>,
): Promise<void> {
  // Mark the typing under way, so a poll leaves the thread alone and a stop or merge can
  // cancel it.
  const cancel = new AbortController();
  typingEvents.set(thread.folder, cancel);
  const { seen, change, why } = decision;
  try {
    // Gather everything to tell into one message: the failed checks first, then the rest.
    if (decision.conflict !== null) await refreshBase(db, thread, decision.conflict);
    const checks = await failedCheckMessages(db, thread, decision.failed);
    const text = [...checks, ...decision.tell].join("\n\n---\n\n");
    if (!agentRuns(tmux, thread.folder)) throw new Error("its builder isn't running");
    // A builder can work long after an event, but one busy this long has likely hung.
    const { marks } = builderHarness(thread);
    await typeInto(tmux, thread.folder, marks, text, {
      timeout: 30 * 60_000,
      signal: cancel.signal,
    });
    if (cancel.signal.aborted) return;
    // Typing can wait a long time, and a newer round may have moved the thread on meanwhile,
    // such as to approved. Its state then stands, and only the events count as handled.
    const now = readThread(db, thread.folder);
    const moved =
      now.status !== thread.status ||
      now.needs_you !== thread.needs_you ||
      now.rounds !== thread.rounds ||
      now.submitting !== thread.submitting ||
      now.reviewing !== thread.reviewing;
    record(db, thread.folder, moved ? { seen } : { seen, ...change }, why);
    // Only now that they are typed in, the forge marks the people's reviews and comments seen.
    // Not waited on, and a failure, such as from a plugin too old to know the question, is
    // only logged: the builder already has them, and nothing waits on the forge.
    const { pr } = thread;
    if (pr !== null)
      // The repository is looked up inside the promise, so one removed meanwhile is only
      // logged too, and never marks the thread as not told.
      for (const { kind, id } of decision.typedIn)
        Promise.resolve()
          .then(() => markSeen(db, repositoryOf(db, thread), { pr, kind, id }))
          .catch((error) =>
            console.log(
              `couldn't mark the ${kind} ${id} seen on ${threadName(db, thread)}'s PR: ${errorText(error)}`,
            ),
          );
  } catch (error) {
    // Ending the session for a stop or a merge can make typing fail, and a stopped thread's
    // events must stay unhandled for its builder to hear once it starts again.
    if (cancel.signal.aborted) return;
    const said = errorText(error);
    record(db, thread.folder, { seen, needs_you: true }, `couldn't tell: ${said}. ${why}`);
    typeLeadNotes(db, tmux);
  } finally {
    typingEvents.delete(thread.folder);
  }
}
