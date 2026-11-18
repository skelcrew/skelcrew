// Acting on a thread's PR events: telling its builder of them. Also ending the builder for a
// merge, sc stop or sc rm, which must cancel any typing still under way.
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { stopSession } from "../agents/sessions.ts";
import { cloneDir } from "../paths.ts";
import { closePr, failedLog } from "../plugins/ask.ts";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { unassignIssue } from "./assign.ts";
import { baseOf } from "./builder.ts";
import type { Check, Decision } from "./decide.ts";
import { deleteBranch, fetchInto, onRemote } from "./git.ts";
import { endWake } from "./limits.ts";
import {
  noteForLead,
  noticeRound,
  queueMessage,
  stopDelivering,
  typeLeadNotes,
} from "./messages.ts";
import { refreshClone } from "./repo.ts";
import { endRound } from "./round.ts";
import { cloneOf, readThread, record, repositoryOf, type Thread, threadName } from "./thread.ts";

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

// Brings the base branch up to date in Skelcrew's clone of the repository, and returns the
// commit it is on, as the forge has it. The builder's clone has Skelcrew's clone as origin, so
// its next fetch gets the latest base. Each poll keeps the default branch current, but the
// builder is told of the conflict before the next one, and any other base is fetched only here.
async function refreshBase(db: Database, thread: Thread, base: string): Promise<string> {
  const repository = repositoryOf(db, thread);
  const clone = cloneDir(thread.owner, thread.repo);
  // Refreshing brings the default branch up to date. Any other base is fetched on its own.
  await refreshClone(db, repository);
  if (base !== baseOf({ ...thread, base: null })) await fetchInto(db, repository, clone, base);
  const read = await quietly(["git", "-C", clone, "rev-parse", "--verify", `refs/heads/${base}`]);
  if (!read.ok) throw new Error(`git rev-parse ${base} failed: ${read.err.trim()}`);
  return read.out.trim();
}

// The threads whose events are being made into a message for the builder, by folder. A poll
// leaves such a thread alone, so its events are never told twice.
export const tellingEvents = new Set<string>();

// The threads sc rm is removing, by folder. Only sc rm ends them. Without a forge, sc rm deletes
// the branch before it ends the thread, and a poll in between would end it as one whose branch
// someone deleted. With one, a poll would tell the lead the PR sc rm closed was closed.
export const removing = new Set<string>();

// Cancels the round, any typing under way into the thread's builder and any wake after a usage
// limit, ends its session, and waits for the builder to exit, so nothing types into it or
// changes the thread afterwards. Messages still waiting for it are dropped once the thread
// ends, with `drop`, and otherwise kept for when sc start brings the builder back.
async function endBuilder(db: Database, sessions: string, folder: string, drop: boolean) {
  stopDelivering(db, folder, drop);
  endWake(folder);
  endRound(folder);
  // Claude Code can outlive the end of its session for a few seconds, still writing in the
  // clone.
  await stopSession(sessions, folder);
}

// Stops the thread for sc stop: marks it stopped, then ends its builder as a merge would,
// but keeps its clone, branch and PR, so sc start can bring the builder back where it was.
// A submit, review or review's changes under way stay saved and carry on once it starts
// again. It no longer needs you: you stopped it, and its builder's question ended with it.
// It takes you off its issue, if Skelcrew assigned you. Marked first, so a builder that
// submits while it exits is refused. Refuses a thread that has no builder to stop, or whose
// builder hasn't started yet.
export async function stopThread(db: Database, sessions: string, thread: Thread): Promise<void> {
  const name = threadName(db, thread);
  if (thread.status === "stopped") throw new Error(`${name} is stopped already`);
  if (thread.status !== "working" && thread.status !== "waiting")
    throw new Error(`${name} is ${thread.status}, so it has no builder to stop`);
  // Its setup would go on to start the builder after the stop.
  if (thread.session === null)
    throw new Error(`${name} is still setting up: stop it once its builder has started`);
  record(
    db,
    thread.folder,
    {
      status: "stopped",
      needs_you: false,
      asking: false,
      stalled: false,
      erred: false,
      limited: false,
      limit_reset: null,
    },
    "stopped",
  );
  // Asked as it is marked stopped, before anything is waited on: an sc start that finds it
  // stopped meanwhile asks to assign you, and that must come after.
  unassignIssue(db, thread.folder);
  await endBuilder(db, sessions, thread.folder, false);
}

// Ends the thread once its PR is merged or closed, or for sc rm: ends its builder, and removes
// its clone by deleting the folder, never running git in it. `why` goes in the thread's log.
// `note`, such as "is done: #7 merged into main", goes to its repository's lead after the
// thread's name, so the lead stops listing it as open. With null, as when the lead removed it,
// the lead hears nothing. `removal` is true only for sc rm's own end: a thread sc rm is
// removing is its to end, even when a poll saw its PR merged or closed first.
export async function endThread(
  db: Database,
  sessions: string,
  thread: Thread,
  why: string,
  note: string | null,
  removal = false,
): Promise<void> {
  // A thread ends once, so the lead hears of it once. A poll and sc rm can both end the same
  // thread, and the thread can even start over while a slow end waits. So this end goes on only
  // while the thread is still the one it was asked to end, by when it started, and not done
  // yet. And while sc rm is removing it, only sc rm's own end goes on: the lead hears what sc rm
  // says, or nothing when the lead ran it. It is checked before anything is stopped or deleted,
  // and again after waiting for the builder, with nothing waited on from there to removing the
  // thread's clone.
  const ours = () => {
    const now = readThread(db, thread.folder);
    if (now.started !== thread.started || now.status === "done") return false;
    return removal || !removing.has(thread.folder);
  };
  if (!ours()) return;
  await endBuilder(db, sessions, thread.folder, true);
  if (!ours()) return;
  // The thread is marked done and its note saved in one transaction. A daemon that stops
  // between the two, or a note that fails to save, would otherwise leave a done thread, which no
  // poll looks at again, and a lead that never hears of it. The note is saved first: marking
  // the thread done also writes its log, which a failed transaction can't take back, so a note
  // that fails to save leaves no end in the log either. The note is typed only after: typing
  // starts on a promise, once this has returned. Every note to the lead is one line, as a reason
  // given to sc rm may not be.
  db.transaction(() => {
    if (note !== null) {
      const line = `${threadName(db, thread)} ${note}`.replace(/\s+/g, " ").slice(0, 200);
      noteForLead(db, sessions, thread, line, thread.folder);
    }
    // A merge when ready ends with its thread, so nothing armed outlives it.
    const ended = { status: "done" as const, needs_you: false, merge_plan: null };
    record(db, thread.folder, ended, `${why}: ended the thread`);
  })();
  // Its clone goes only once the end is saved, so a thread whose end failed keeps it. Nothing
  // is waited on since the checks above, so a thread started over in this folder meanwhile
  // can't lose its clone.
  rmSync(cloneOf(thread), { recursive: true, force: true });
}

// Removes the thread for sc rm: ends its builder, closes its PR with the reason as a comment,
// deletes its branch on the forge, removes its clone, takes you off its issue if Skelcrew
// assigned you, and marks it done. The lead hears of it, unless `byLead`: it ran sc rm, so it
// knows already. Its task stays open,
// so sc start can start the thread over on it. Without a PR, the branch is deleted with git,
// but only if Skelcrew pushed it for this thread. A running thread is marked stopped first, so
// a builder that submits while it exits is refused. If the forge fails, the thread stays
// short of done, so sc rm can run again. Refuses a thread that is done, and one still setting
// up, whose setup would go on to start its builder.
export async function removeThread(
  db: Database,
  sessions: string,
  thread: Thread,
  reason: string | undefined,
  byLead: boolean,
): Promise<void> {
  // Refuse what can't be removed, then stop a thread still running.
  const name = threadName(db, thread);
  if (thread.status === "done") throw new Error(`${name} is done already`);
  const live = thread.status === "working" || thread.status === "waiting";
  if (live && thread.session === null)
    throw new Error(`${name} is still setting up: remove it once its builder has started`);
  if (live)
    record(
      db,
      thread.folder,
      {
        status: "stopped",
        needs_you: false,
        asking: false,
        stalled: false,
        erred: false,
        limited: false,
        limit_reset: null,
      },
      "removing",
    );
  // Asked before anything is waited on, so an sc start meanwhile assigns you after it, as for
  // sc stop. A forge that fails leaves the thread stopped, which takes you off too.
  unassignIssue(db, thread.folder);
  // Until it ends, a poll leaves the thread to sc rm, which deletes its branch first.
  removing.add(thread.folder);
  try {
    // A push under way would put back the branch, or open a PR after none was closed, so it is
    // waited for, and the thread read again for the PR it may have opened.
    const pushing = endRound(thread.folder);
    await endBuilder(db, sessions, thread.folder, true);
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
    const closing = pr === null ? "" : `, closing #${pr}`;
    const note = `ended: you removed it${closing}${reason ? `: ${reason}` : ""}`;
    const why = reason ? `removed: ${reason}` : "removed";
    await endThread(db, sessions, thread, why, byLead ? null : note, true);
  } finally {
    removing.delete(thread.folder);
  }
}

// Makes what the decision tells into messages for the builder, saved to be typed in as soon as
// the builder can take it, however long that takes, and saves the decision. A thread approved
// and ready to merge whose PR now conflicts leaves ready to merge before anything is fetched,
// as GitHub can't merge it, and a slow or failing fetch would leave it advertised as ready.
// People's reviews and comments go in one message,
// which the forge marks seen once it is typed in. Skelcrew's own notices, the failed checks and
// a conflict, go in another, which a new round drops as stale. Fetching a failed check's log or
// the base branch can fail, such as on a network error: then no message is saved and no event
// counts as handled, and the next poll tries again.
export async function tellBuilder(
  db: Database,
  sessions: string,
  thread: Thread,
  decision: Exclude<Decision, { end: string }>,
): Promise<void> {
  // Mark the events as being told, so a poll meanwhile leaves the thread alone.
  tellingEvents.add(thread.folder);
  const { seen, change, why } = decision;
  // Read before fetching, as a new round may start meanwhile.
  const round = noticeRound(thread.folder);
  // The conflict is saved first, so an approval stops being ready to merge before any wait. Its
  // status stays as it is, so while a fetch keeps failing, each poll finds the conflict again
  // and tries again.
  const unready = decision.conflict !== null && thread.needs_you && !change.needs_you;
  const conflicts = decision.conflict ?? thread.conflicts;
  const before =
    conflicts !== thread.conflicts || unready
      ? record(
          db,
          thread.folder,
          unready ? { conflicts, needs_you: false } : { conflicts },
          `its PR conflicts with ${conflicts}, so it isn't ready to merge`,
        )
      : thread;
  try {
    // The conflict notice names the commit the forge's base is on. A builder that checks its
    // own origin/ unfetched would otherwise say its branch already has the base.
    const base = decision.conflict;
    const at = base === null ? null : await refreshBase(db, thread, base);
    const told =
      at === null
        ? decision.notice
        : decision.notice.map(
            (text) =>
              `${text} The forge's ${base} is at ${at}. After git fetch origin, git rev-parse origin/${base} gives the same commit.`,
          );
    const checks = await failedCheckMessages(db, thread, decision.failed);
    // Fetching can take a while, and the thread may have stopped or ended meanwhile, whose
    // events stay unhandled. Or a newer round may have moved it on, such as to approved. Its
    // state then stands, and only the events count as handled.
    const now = readThread(db, thread.folder);
    if (now.status !== "working" && now.status !== "waiting") return;
    const moved =
      now.status !== before.status ||
      now.needs_you !== before.needs_you ||
      now.rounds !== before.rounds ||
      now.submitting !== before.submitting ||
      now.reviewing !== before.reviewing;
    // A round submitted meanwhile is a new commit, so the notices of the older one would send
    // the builder after a problem it may have fixed, even once that round's push is done and
    // its review runs. People's words still hold.
    const notices = noticeRound(thread.folder) !== round ? [] : [...checks, ...told];
    // Saves one message of these texts, unless there are none. The thread's log gets the first
    // line of each.
    const firstLines = (texts: string[]) => texts.map((t) => t.split("\n")[0]).join("; ");
    const send = (texts: string[], typedIn: typeof decision.typedIn) => {
      if (texts.length === 0) return;
      queueMessage(db, sessions, thread.folder, {
        sender: "skelcrew",
        text: texts.join("\n\n---\n\n"),
        said: firstLines(texts),
        typed_in: typedIn,
      });
    };
    send(notices, []);
    send(decision.tell, decision.typedIn);
    record(db, thread.folder, moved ? { seen } : { seen, ...change }, why);
    typeLeadNotes(db, sessions);
  } catch (error) {
    console.log(
      `couldn't tell ${threadName(db, thread)}'s builder, trying again: ${errorText(error)}`,
    );
  } finally {
    tellingEvents.delete(thread.folder);
  }
}
