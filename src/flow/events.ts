// Acting on what a thread's PR events mean: typing them into its builder, and ending the
// builder for a merge or for sc stop, as both must cancel the events still being typed in.
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { agentRuns, stopSession } from "../agents/tmux.ts";
import { typeInto } from "../agents/typing.ts";
import { type Check, failedLog, fetchIntoClone } from "../github.ts";
import { cloneDir } from "../paths.ts";
import { errorText } from "../say.ts";
import { baseOf } from "./builder.ts";
import type { Decision } from "./decide.ts";
import { tellLead } from "./lead.ts";
import { refreshClones } from "./repo.ts";
import { endRound } from "./round.ts";
import {
  builderHarness,
  cloneOf,
  fullNameOf,
  readThread,
  record,
  type Thread,
  threadName,
} from "./thread.ts";

// The message about failed checks, with the end of each one's log. A check that isn't a
// GitHub Actions job has no log gh can read, so it gets its link instead.
async function aboutChecks(fullName: string, failed: Check[]): Promise<string[]> {
  return Promise.all(
    failed.map(async (c) => {
      const link = c.url ? ` (${c.url})` : "";
      const fix = 'Fix it, commit, and run sc submit "<summary>" again.';
      if (c.kind === "status") return `The check ${c.name} failed${link}. ${fix}`;
      const log = await failedLog(fullName, c.id).catch(
        (error) => `(Skelcrew couldn't read its log: ${errorText(error)})`,
      );
      return `The check ${c.name} failed${link}. The end of its log:\n\n${log}\n\n${fix}`;
    }),
  );
}

// Brings Skelcrew's clone of the repository up to date with the base branch, so the builder,
// whose clone has it as origin, gets the latest base when it fetches. The daemon otherwise
// refreshes it only when you attach or it starts, and holds only the default branch.
async function freshBase(db: Database, thread: Thread, base: string): Promise<void> {
  await refreshClones(db);
  if (base !== baseOf({ ...thread, base: null }))
    await fetchIntoClone(cloneDir(thread.owner, thread.repo), fullNameOf(thread), base);
}

// Typing in progress per thread. A poll leaves a thread alone while its events are typed in,
// so they are never typed twice, and a merge cancels the typing.
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
// Marked first, so a builder that submits while it exits is refused. Refuses a thread that
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
}

// Ends the thread once its PR is merged or closed: ends its builder, and removes its clone by
// deleting the folder, never running git in it.
export async function endThread(
  db: Database,
  tmux: string,
  thread: Thread,
  why: string,
): Promise<void> {
  await endBuilder(tmux, thread.folder);
  rmSync(cloneOf(thread), { recursive: true, force: true });
  record(db, thread.folder, { status: "done", needs_you: false }, `${why}: ended the thread`);
}

// Types what the decision tells into the builder once it is idle, then saves the decision.
// It is saved only after, so a stop of the daemon meanwhile leaves the events to the next
// poll. A builder that isn't running, or stays busy for half an hour, isn't told: the events
// count as handled, and the thread needs you, with what it missed in its log.
export async function tellBuilder(
  db: Database,
  tmux: string,
  thread: Thread,
  decision: Exclude<Decision, { end: string }>,
): Promise<void> {
  const cancel = new AbortController();
  typingEvents.set(thread.folder, cancel);
  const { handled, change, why } = decision;
  try {
    if (decision.conflict !== null) await freshBase(db, thread, decision.conflict);
    const checks = await aboutChecks(fullNameOf(thread), decision.failed);
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
    record(db, thread.folder, moved ? handled : { ...handled, ...change }, why);
  } catch (error) {
    // Ending the session for a stop or a merge can make typing fail, and a stopped thread's
    // events must stay unhandled for its builder to hear once it starts again.
    if (cancel.signal.aborted) return;
    const said = errorText(error);
    record(db, thread.folder, { ...handled, needs_you: true }, `couldn't tell: ${said}. ${why}`);
    tellLead(db, tmux);
  } finally {
    typingEvents.delete(thread.folder);
  }
}
