// Polling: the daemon asks each repository's tracker and forge what changed, brings Skelcrew's
// copy of its tasks and PRs and its clone's default branch up to date, starts threads on tasks labeled to start, and hands what
// each thread's PR means for it to the code that acts on it. In a repository with no forge, it
// ends a thread once its branch is merged or gone.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
import { hasSession } from "../agents/sessions.ts";
import { agentsOnDefaultBranch, agentsWaiting, markApproved } from "../approved-agents.ts";
import { roundLimit } from "../config.ts";
import type { Repository } from "../db.ts";
import { cloneDir } from "../paths.ts";
import {
  askWhatChanged,
  claimTask,
  forgeOf,
  repositoryPlugins,
  trackerOf,
} from "../plugins/ask.ts";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { assignIssue, unassignIssue } from "./assign.ts";
import { baseOf, startThread } from "./builder.ts";
import { type Item, openPrs, openTasks, prOf, saveItems } from "./copy.ts";
import {
  allGreen,
  ciOnHead,
  ciState,
  decide,
  decideBranch,
  labeledToStart,
  type PullRequest,
} from "./decide.ts";
import { endThread, noticeEndedBuilder, removing, tellBuilder, tellingEvents } from "./events.ts";
import { fetchCommit, fetchInto, onRemote } from "./git.ts";
import { approvedFlowsTold, leadSession } from "./lead.ts";
import { finishSkippedMerge, mergeIfReady } from "./merging.ts";
import { briefsNote, noteForLead, skelcrewNoteForLead, typeLeadNotes } from "./messages.ts";
import { forgeKnown, fullNameIs, hasNoCommits, refreshClone, repositories } from "./repo.ts";
import { ciShowedIn, ciWaitEnded, lastPushed, retryPost } from "./round.ts";
import { needsYou } from "./status.ts";
import { claimUnderWay } from "./task-queue.ts";
import { readThread, record, Thread, taskName, threadName } from "./thread.ts";

// The label that starts a thread on a task, added in its tracker by someone who may.
const startLabel = "skelcrew";

// Starts a thread, as sc start does, on each open task in Skelcrew's copy that is labeled to
// start and has no thread, once Skelcrew has claimed it in the tracker, and tells the
// repository's lead. The claim comes first so that when two machines run Skelcrew on one
// repository, such as a laptop and a server, only one starts the task. Thread rows are read
// after the tracker says what changed, so a thread sc start made meanwhile counts. A task in
// `starting`, named as owner/repo#task, is left to the sc start starting it, which has options
// of its own, such as the branch to start from. A task in `passed`, named the same way, is one
// this daemon won't start by its label: someone else claimed it, or its claim was this
// daemon's but the thread failed to start. Kept in memory, so the tracker isn't asked about it
// on every poll. Nothing starts until Skelcrew's clone has a commit. Each claim is saved before
// it is asked for, until its outcome is known. A claim whose ask failed, or that the engine's
// stop cut short, may have been granted to this machine, so when the tracker then says the issue
// is taken, Skelcrew can't tell by whom: it starts nothing, so no task starts twice, and tells
// the lead, so none is lost without a word. So does one whose label is gone since.
async function startLabeled(
  db: Database,
  sessions: string,
  repository: Repository,
  setUpAndStart: (thread: Thread) => Promise<void>,
  starting: Set<string>,
  passed: Set<string>,
): Promise<void> {
  const { owner, repo } = repository;
  const fullName = `${owner}/${repo}`;
  // Every thread the repository ever had counts, ended ones too, so the tasks to start are
  // those labeled with no thread at all, and not being started by sc start.
  const threads = db
    .query("SELECT * FROM task_threads WHERE owner = ? AND repo = ?")
    .all(owner, repo)
    .map((row) => Thread.parse(row));
  const labeled = openTasks(db, owner, repo).filter((task) => {
    const key = `${fullName}#${task.id}`;
    return task.labels.includes(startLabel) && !starting.has(key) && !passed.has(key);
  });
  const toStart = labeledToStart(threads, labeled);
  // A repository with no commits yet has nothing for a thread to start from, and a claim made
  // now would keep its label from starting it once it has some. Until Skelcrew's clone is made,
  // as while the daemon starts, nothing tells, so labeled tasks wait for it.
  if (
    toStart.length > 0 &&
    (!existsSync(cloneDir(owner, repo)) || (await hasNoCommits(db, repository)))
  )
    return;
  // A claim saved for a task that has a thread at work now was granted, and the engine stopped
  // before it was forgotten. One for a queued task is the claim it still owes, which the queue
  // makes. One for a task sc rm removed, as done, is left to the step below.
  db.run(
    `DELETE FROM claims WHERE owner = ? AND repo = ? AND EXISTS (SELECT 1 FROM threads t
      WHERE t.owner = claims.owner AND t.repo = claims.repo AND CAST(t.task AS TEXT) = claims.task
        AND t.status NOT IN ('queued', 'done'))`,
    [owner, repo],
  );
  const claimWhere = "WHERE owner = ? AND repo = ? AND task = ?";
  const forget = (id: string) => db.run(`DELETE FROM claims ${claimWhere}`, [owner, repo, id]);
  // A claim saved for a task nothing asks to start now was cut short by the engine's stop: one
  // with no thread whose label was removed or whose issue was closed since, or one for a task
  // sc rm removed while it was asked. It may be this machine's, so the lead hears of it, and
  // Skelcrew doesn't ask the tracker again, as that would claim an issue nobody asks for now. The
  // claim is forgotten as the note is saved. A removed task's claim whose answer is still coming
  // is left to it.
  const asked = new Set(toStart.map((task) => task.id));
  const stranded = db
    .query(`SELECT c.task AS id, t.folder FROM claims c LEFT JOIN task_threads t ON t.owner = c.owner
        AND t.repo = c.repo AND CAST(t.task AS TEXT) = c.task
      WHERE c.owner = ? AND c.repo = ? AND (t.folder IS NULL OR t.status = 'done')`)
    .all(owner, repo)
    .map((row) => z.object({ id: z.string(), folder: z.string().nullable() }).parse(row))
    .filter(({ id, folder }) => {
      if (asked.has(id) || starting.has(`${fullName}#${id}`)) return false;
      return folder === null || !claimUnderWay(readThread(db, folder));
    })
    .map(({ id }) => id);
  for (const id of stranded) {
    const name = taskName(repository.name, id);
    const note = `${name}'s claim was cut short, and nothing asks Skelcrew to start it now, so Skelcrew can't tell if this machine holds it. To start it, sc start ${name}.`;
    console.log(note);
    db.transaction(() => {
      forget(id);
      noteForLead(db, sessions, { owner, repo }, note);
    })();
  }
  for (const task of toStart) {
    const key = `${fullName}#${task.id}`;
    // Whether an earlier ask for this claim has no known outcome.
    const unsure =
      db.query(`SELECT 1 FROM claims ${claimWhere}`).get(owner, repo, task.id) !== null;
    db.run("INSERT OR IGNORE INTO claims (owner, repo, task) VALUES (?, ?, ?)", [
      owner,
      repo,
      task.id,
    ]);
    // A claim that fails, such as on a network error, starts nothing and is tried again on the
    // next poll, so a task is never started without its claim.
    const claimed = await claimTask(db, repository, task.id).catch((error) => {
      console.log(`couldn't claim ${task.id} in ${fullName}, trying again: ${errorText(error)}`);
      return null;
    });
    if (claimed === null) continue;
    const name = taskName(repository.name, task.id);
    // The claim is forgotten in the same transaction as the note is saved, so a stop between the
    // two can't leave the claim forgotten and the lead never told.
    const forgetAndTell = (note: string, urgent = false) =>
      db.transaction(() => {
        forget(task.id);
        const line = note.replace(/\s+/g, " ").slice(0, 200);
        noteForLead(db, sessions, { owner, repo }, line, null, urgent);
      })();
    if (!claimed && unsure) {
      const note = `${name}'s claim was cut short, so Skelcrew can't tell if this machine holds it. If no other machine works on it, sc start ${name}.`;
      console.log(note);
      forgetAndTell(note);
      passed.add(key);
      continue;
    }
    if (!claimed) {
      forget(task.id);
      // Claimed by another machine, or by this one before a restart, when its thread failed
      // to start.
      console.log(
        `not starting ${task.id} in ${fullName}: it was claimed already; sc start still does`,
      );
      passed.add(key);
      continue;
    }
    // An sc start that came in while the tracker answered starts the task itself, with its own
    // options, such as the branch to start from, so the poll leaves it be.
    if (starting.has(key)) {
      forget(task.id);
      continue;
    }
    // The claim is this daemon's now, so a thread that fails to start isn't started by a
    // later poll either: on another machine, or after a restart, its claim reads as taken. So
    // the lead hears why, and can start it with sc start once that is fixed.
    const thread = await startThread(db, { repo: fullName, task: task.id }, true).catch((error) => {
      console.log(
        `couldn't start ${task.id} in ${fullName}, and its label won't start it again; sc start does: ${errorText(error)}`,
      );
      forgetAndTell(
        `couldn't start ${name} from its label; once fixed, sc start ${name}: ${errorText(error)}`,
        true,
      );
      passed.add(key);
      return null;
    });
    if (thread === null) continue;
    // Claimed already, so only assigned.
    assignIssue(db, thread, false);
    // The lead hears first, then the builder starts, or for a task over the repository's
    // limits.threads, that it waits in the queue. The note is one line, as every note to the
    // lead is.
    const queued = thread.status === "queued";
    const note = `${queued ? "queued" : "started"} ${threadName(db, thread)} from ${trackerOf(db, repository)}: ${task.title}`;
    noteForLead(db, sessions, { owner, repo }, note.replace(/\s+/g, " ").slice(0, 200));
    // Not waited on, as for sc start: setup can take minutes.
    if (!queued) setUpAndStart(thread);
  }
}

// Returns whether the branch's head on its remote holds commits Skelcrew never pushed for the
// thread, such as a PR merged into it, or someone else's push. Its builder must merge them, as
// its next push would be refused. Just after a push the forge's copy can still show an older
// commit Skelcrew pushed, which holds nothing new.
async function movedOnRemote(thread: Thread, head: string | null): Promise<boolean> {
  const pushed = lastPushed(thread);
  if (head === null || pushed === null || head === pushed) return false;
  // A commit Skelcrew's clone never fetched is no ancestor either, so git failing counts.
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const older = await quietly([
    "git",
    "-C",
    skelcrewClone,
    "merge-base",
    "--is-ancestor",
    head,
    pushed,
  ]);
  return !older.ok;
}

// Tells the builder of a thread with no PR to poll when its branch on the remote, at `head`,
// holds commits Skelcrew never pushed. Only a thread at work or waiting is told, and one whose
// events are being told is left to that, as for a PR.
async function actOnMovedBranch(
  db: Database,
  sessions: string,
  before: Thread,
  head: string,
): Promise<void> {
  if (!(await movedOnRemote(before, head))) return;
  const thread = readThread(db, before.folder);
  if (!["working", "waiting"].includes(thread.status) || tellingEvents.has(thread.folder)) return;
  const maxRounds = roundLimit(thread);
  const decision = decideBranch(thread, head, { maxRounds, moved: true });
  // Not waited on, as for a PR's events.
  if (decision !== null) tellBuilder(db, sessions, thread, decision);
}

// Fetches the branch of a thread with no PR to show its head, and tells the builder if it moved
// on the remote. That is a thread with a forge whose push went through but whose PR failed to
// open, or one with no forge whose submit is still pending, such as after a failed push. A
// branch the remote won't give, as before the first push, is left be.
async function actOnBranchHead(
  db: Database,
  sessions: string,
  repository: Repository,
  thread: Thread,
): Promise<void> {
  if (!["working", "waiting"].includes(thread.status) || lastPushed(thread) === null) return;
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const ref = `refs/skelcrew/remote/${thread.folder}`;
  const fetched = await fetchInto(db, repository, skelcrewClone, thread.branch, ref).then(
    () => true,
    () => false,
  );
  if (!fetched) return;
  const head = await quietly(["git", "-C", skelcrewClone, "rev-parse", "--verify", ref]);
  if (head.ok) await actOnMovedBranch(db, sessions, thread, head.out.trim());
}

// Acts on what the thread's PR, as its forge just returned it, means for the thread. `before`
// is the thread as it was when the poll began: a round that moved on while the forge answered
// may have pushed a newer commit, and what the forge said about the checks would be the older
// one's, so the next poll acts on it instead.
async function actOnPr(
  db: Database,
  sessions: string,
  before: Thread,
  pr: PullRequest,
): Promise<void> {
  // Act on the thread as it is now, since it may have ended or moved on while the forge
  // answered. One already done or failed has nothing left to act on.
  const { folder } = before;
  const moved = await movedOnRemote(before, pr.head);
  // What CI says of the PR's head is saved first, so the decision and the merge go by it.
  const current = readThread(db, folder);
  const ci = ciOnHead(current, pr, () => ciWaitEnded(db, current, pr));
  if (ci !== null) {
    const why = ci.no_ci ? `no CI check showed on ${pr.head}: no CI runs on it` : undefined;
    record(db, folder, ci, why);
  }
  const thread = readThread(db, folder);
  if (!["queued", "working", "waiting", "stopped"].includes(thread.status)) return;
  // Read only for a thread with a PR, so a bad max_rounds never fails the copy's update, nor
  // sc start, which polls first.
  const maxRounds = roundLimit(thread);
  // The decision is pure; what follows carries it out. The poll is stale when a round
  // changed the thread since it began.
  const decision = decide(thread, pr, { maxRounds, moved });
  const stale =
    thread.submitting !== before.submitting ||
    thread.reviewing !== before.reviewing ||
    thread.rounds !== before.rounds;
  // Saved ahead of what the decision does, so a thread never needs you for an approval while
  // its saved checks still say otherwise. A commit on its way has no checks to speak of yet.
  // Whether every check is green, Skelcrew's own included, is saved on each poll too, even while
  // an earlier event is still being told: a check run again can fail, pass or vanish, and an
  // approval is ready to merge only while they all pass.
  const checks = ciState(pr);
  const green = allGreen(thread, pr);
  const ciChanged = checks !== thread.checks || green !== thread.ci_passed;
  if (!stale && thread.submitting === null && ciChanged)
    record(db, folder, { checks, ci_passed: green });
  // A merge or close ends the thread whatever else is going on. Otherwise new events go to
  // the builder, and with none, only what is seen and what changed is saved.
  if ("end" in decision) {
    // A PR sc rm closed is its to end, and to take you off its issue. endThread checks again,
    // as sc rm can start while this waits.
    if (removing.has(folder)) return;
    // A merge leaves you assigned, as the closed issue's record of who did it. Asked before
    // the thread ends, so an sc start that starts it over once it is done assigns you after.
    if (pr.state === "closed") unassignIssue(db, folder);
    // A merge without approval the forge did before the daemon could finish it, such as across
    // a restart, still gets its record edited and its findings filed, with its own note.
    const skipped = pr.state === "merged" ? await finishSkippedMerge(db, thread, pr) : null;
    const note = skipped ?? decision.note;
    await endThread(db, sessions, thread, decision.end, note, pr.state === "merged");
  }
  // Left unhandled, so a stopped or queued thread's events reach its builder once it starts.
  else if (["stopped", "queued"].includes(thread.status) || tellingEvents.has(folder) || stale)
    return;
  else if (decision.tell.length > 0 || decision.notice.length > 0 || decision.failed.length > 0)
    // Not waited on, so fetching a check's log holds up neither the other threads nor the
    // next poll.
    tellBuilder(db, sessions, thread, decision);
  else {
    const { seen, change, why } = decision;
    const moved = JSON.stringify(seen) !== JSON.stringify(thread.seen);
    // Most polls find nothing new, and the log stays free of them.
    if (moved || Object.keys(change).length > 0) {
      record(db, folder, { seen, ...change }, why);
      typeLeadNotes(db, sessions);
    }
  }
}

// Saves, for each open PR in Skelcrew's copy, whether its changes touch .agents/ at its head, so
// the merge confirms can say so while reading only the database. Merging approves no change
// there. It looks again at every poll, from where the head left its base now, as retargeting
// the PR or moving its base can change that with the same head. That is git in Skelcrew's clone
// alone, unless the base isn't the default branch, or this poll couldn't bring the default
// branch up to date (`refreshed`), or the head isn't in the clone yet, such as someone else's
// push or a PR from a fork: those are fetched, the head by its commit, as a fork's branch isn't
// on the repository's remote. A PR it can't check, such as while the remote is out of reach,
// loses what was saved for it, so its confirm says it isn't checked, and is logged once per
// head.
async function saveAgentsChanges(
  db: Database,
  repository: Repository,
  refreshed: boolean,
): Promise<void> {
  const { owner, repo } = repository;
  const skelcrewClone = cloneDir(owner, repo);
  const git = (...args: string[]) => quietly(["git", "-C", skelcrewClone, ...args]);
  const prs = openPrs(db, owner, repo);
  // PRs that left the copy need nothing saved.
  const open = prs.map((pr) => pr.id);
  db.run(
    `DELETE FROM pr_agents WHERE owner = ? AND repo = ?
      AND pr NOT IN (SELECT value FROM json_each(?))`,
    [owner, repo, JSON.stringify(open)],
  );
  // The clone is on the default branch, which this poll brought up to date unless it failed. A
  // stale one could hide a change to .agents/ the PR now brings, so it is fetched then.
  const onDefault = (await git("symbolic-ref", "--short", "HEAD")).out.trim();
  for (const pr of prs) {
    if (pr.head === null) continue;
    const forget = () =>
      db.run("DELETE FROM pr_agents WHERE owner = ? AND repo = ? AND pr = ?", [owner, repo, pr.id]);
    try {
      let base = "HEAD";
      if (!refreshed || pr.base !== onDefault) {
        base = `refs/skelcrew/pr-bases/${pr.id}`;
        await fetchInto(db, repository, skelcrewClone, pr.base, base);
      }
      if (!(await git("cat-file", "-e", `${pr.head}^{commit}`)).ok)
        await fetchCommit(db, repository, skelcrewClone, pr.head, `refs/skelcrew/prs/${pr.id}`);
      // The PR's own changes are those since the head left its base, which is what a merge brings.
      const from = await git("merge-base", base, pr.head);
      if (!from.ok) throw new Error(`git merge-base failed: ${from.err.trim()}`);
      const files = await git("diff", "--name-only", from.out.trim(), pr.head, "--", ".agents");
      if (!files.ok) throw new Error(`git diff failed: ${files.err.trim()}`);
      db.run(
        `INSERT OR REPLACE INTO pr_agents (owner, repo, pr, head, base, changed)
          VALUES (?, ?, ?, ?, ?, ?)`,
        [owner, repo, pr.id, pr.head, pr.base, files.out.trim() === "" ? 0 : 1],
      );
    } catch (error) {
      forget();
      const which = `${owner}/${repo}#${pr.id} at ${pr.head}`;
      if (uncheckable.has(which)) continue;
      uncheckable.add(which);
      console.log(`couldn't tell whether ${which} changes .agents/: ${errorText(error)}`);
    }
  }
}

// The PRs, each at a head, that saveAgentsChanges couldn't check and logged, so a PR from a fork
// isn't logged at every poll.
const uncheckable = new Set<string>();

// Ends a thread of a repository with no forge once its branch is done with: when merging it
// into its base would change nothing, which a merge, a squash and a rebase all leave, or when
// it is gone from the remote. Only a branch Skelcrew has pushed counts, as before that it isn't on
// the remote at all. A branch still open that moved on the remote without its builder is told
// to the builder, even while a submit is pending.
async function actOnBranch(db: Database, sessions: string, repository: Repository, thread: Thread) {
  const skelcrewClone = cloneDir(thread.owner, thread.repo);
  const ref = (kind: string) => `refs/skelcrew/${kind}/${thread.folder}`;
  const git = (...args: string[]) => quietly(["git", "-C", skelcrewClone, ...args]);
  // A push under way has saved its local ref before the remote has the branch, and a failed
  // one keeps its submit, so only a thread with nothing being pushed can end. Its branch can
  // still have moved, which a push that failed may never have told the builder.
  if (thread.submitting !== null) return actOnBranchHead(db, sessions, repository, thread);
  if (!(await git("rev-parse", "--verify", "--quiet", ref("threads"))).ok) return;
  // Asking git takes a while, and sc rm may meanwhile have deleted the branch and ended the
  // thread, or the thread started over. Only the thread as it was is ended. A thread sc rm is
  // still removing is its to end, as it deleted the branch.
  const unchanged = () => {
    const now = readThread(db, thread.folder);
    const same = now.status === thread.status && now.started === thread.started;
    return same && !removing.has(thread.folder);
  };
  if (!(await onRemote(db, repository, thread.branch))) {
    if (unchanged())
      await endThread(
        db,
        sessions,
        thread,
        `its branch ${thread.branch} was deleted`,
        `ended: its branch ${thread.branch} was deleted`,
        false,
      );
    return;
  }
  // Merge the remote branch into its base without touching any files, and compare the result
  // with the base. The same tree means the base already has everything on the branch.
  const base = baseOf(thread);
  await fetchInto(db, repository, skelcrewClone, base, ref("bases"));
  await fetchInto(db, repository, skelcrewClone, thread.branch, ref("remote"));
  const merged = await git("merge-tree", "--write-tree", ref("bases"), ref("remote"));
  const tree = await git("rev-parse", `${ref("bases")}^{tree}`);
  const done = merged.ok && tree.ok && merged.out.trim().split("\n")[0] === tree.out.trim();
  if (done && unchanged())
    await endThread(
      db,
      sessions,
      thread,
      `its branch ${thread.branch} is merged into ${base}`,
      `is done: its branch ${thread.branch} merged into ${base}`,
      true,
    );
  // A branch still open may have moved on the remote without its builder, such as by someone
  // else's push, which the builder must merge.
  if (done) return;
  const head = await git("rev-parse", "--verify", ref("remote"));
  if (head.ok) await actOnMovedBranch(db, sessions, thread, head.out.trim());
}

// Tells the repository's lead, once, when its default branch has an .agents/ other than the one
// you approved, so it asks you to run sc repo trust. Until then new tasks keep the approved
// version, so the repository needs you. Only you can approve, in your own terminal, so the lead
// is told what to ask for rather than given a way to do it.
function noteUnapprovedAgents(db: Database, sessions: string, repository: Repository): void {
  const where = "WHERE owner = ? AND repo = ?";
  // What to remember as told: the waiting tree, `none` for a removed .agents/, or nothing when
  // the default branch has what you approved.
  const waiting = agentsWaiting(repository) ? (agentsOnDefaultBranch(repository) ?? "none") : null;
  const row = db
    .query(`SELECT agents_noted FROM repositories ${where}`)
    .get(repository.owner, repository.repo);
  const noted = z.object({ agents_noted: z.string().nullable() }).nullable().parse(row);
  if (noted === null || noted.agents_noted === waiting) return;
  db.run(`UPDATE repositories SET agents_noted = ? ${where}`, [
    waiting,
    repository.owner,
    repository.repo,
  ]);
  if (waiting !== null)
    noteForLead(
      db,
      sessions,
      repository,
      `${repository.name}'s .agents/ on its default branch isn't the version the human approved. It steers agents, so new tasks keep the approved version, or the built-in roles, until the human runs sc repo trust ${repository.name} in their own terminal, which shows what changed. Tell the human.`,
    );
}

// Tells a lead that was already running when Skelcrew learned of something new what its
// instructions now say of it, once, as a running lead keeps the instructions it started with
// until its session starts again. `told` is the repository's column that marks it told: flows,
// or briefing another repository's lead. A lead that starts later gets it in its instructions,
// which marks it told, so it gets no note. A repository with no lead running is left untold
// until one is.
async function tellRunningLead(
  db: Database,
  sessions: string,
  repository: Repository,
  told: "lead_flows" | "lead_briefs",
  text: string,
): Promise<void> {
  const where = "WHERE owner = ? AND repo = ?";
  const row = db
    .query(`SELECT ${told} AS told FROM repositories ${where}`)
    .get(repository.owner, repository.repo);
  const known = z.object({ told: z.coerce.boolean() }).nullable().parse(row);
  if (known === null || known.told) return;
  const lead = await leadSession(db, sessions, repository.owner, repository.repo);
  if (lead === null || !(await hasSession(lead.host, lead.id))) return;
  db.run(`UPDATE repositories SET ${told} = 1 ${where}`, [repository.owner, repository.repo]);
  skelcrewNoteForLead(db, sessions, repository, text);
}

// What a lead already running when Skelcrew learned of flows is told of them.
const flowsNote = (repository: Repository) =>
  `Skelcrew was updated: each thread now runs a flow, default unless sc start --flow <name> names another. ${approvedFlowsTold(cloneDir(repository.owner, repository.repo))} When the approved .agents/ has flows other than default, pick the one that fits each thread you start or propose, read from there, not from .agents/flows/ in the clone, and add --flow <name> to sc start. Whenever you pick one other than default, tell the human, naming the flow and why. A thread keeps its flow from start to end. A thread started from the skelcrew label runs default, and you can switch it with sc start app-12 --flow <name> until its builder first submits, unless the flow builds with another role, which is another agent: then start it over with sc rm app-12 and sc start app-12 --flow <name>.`;

// Polls one repository. Asks its tracker and its forge what changed since the `next` each
// plugin last gave, kept in `nexts`, or for everything open when there is none. Brings
// Skelcrew's copy up to date, taking tasks only from its tracker and PRs only from its forge,
// and Skelcrew's clone's default branch with it. Then starts threads on its tasks labeled to start. Then acts on what each thread's PR means
// for it, or, with no forge or no PR, on each thread's branch. Thread rows are read again once the
// answers are in, since a round can change them meanwhile.
async function pollRepository(
  db: Database,
  sessions: string,
  repository: Repository,
  threads: Thread[],
  setUpAndStart: (thread: Thread) => Promise<void>,
  nexts: Map<string, string | null>,
  starting: Set<string>,
  passed: Set<string>,
): Promise<void> {
  const { owner, repo } = repository;
  // Whether Skelcrew's clone's default branch is up to date with the remote as of this poll.
  let refreshed = false;
  // Ask each plugin in turn, telling a forge which PRs Skelcrew watches: those of this
  // repository's threads. A plugin's answer only updates the kinds its jobs cover. A first
  // poll, with no `next`, replaces those kinds in the copy outright, so what closed while the
  // daemon was down goes. Skelcrew's clone is refreshed after, even when a plugin fails, as git
  // can still reach the remote while a tracker or forge is down.
  try {
    for (const { plugin, jobs } of repositoryPlugins(db, repository)) {
      const next = nexts.get(plugin) ?? null;
      const watched = jobs.includes("forge")
        ? threads.flatMap((t) => (t.pr === null ? [] : [t.pr]))
        : [];
      const answer = await askWhatChanged(db, plugin, repository, jobs, next, watched);
      const kinds: Item["kind"][] = [
        ...(jobs.includes("tracker") ? ["task" as const] : []),
        ...(jobs.includes("forge") ? ["pr" as const] : []),
      ];
      const items = answer.items.filter((item) => kinds.includes(item.kind));
      saveItems(db, owner, repo, items, next === null ? kinds : []);
      if (items.some((item) => item.kind === "pr" && ciState(item) !== null))
        ciShowedIn(`${owner}/${repo}`);
      nexts.set(plugin, answer.next);
    }
  } finally {
    // Bring Skelcrew's clone's default branch up to date once the forge answered, so a PR it
    // says merged, whoever merged it, or a push straight to the default branch, reaches
    // builders fetching from the clone by this poll. Cheap when nothing changed. A failed fetch
    // leaves the clone as it was until the next poll, and holds up nothing else. A repository
    // with no clone yet is left to the daemon's start, sc and a thread's setup, which make
    // it: a remote that can't be cloned would otherwise be tried at every poll.
    if (existsSync(cloneDir(owner, repo))) {
      await refreshClone(db, repository)
        .then(() => {
          refreshed = true;
          noteUnapprovedAgents(db, sessions, repository);
        })
        .catch((error) =>
          console.log(`couldn't update Skelcrew's clone of ${owner}/${repo}: ${errorText(error)}`),
        );
      // What you approved is in the clone already, so the lead learns how to read it even while
      // the remote can't be reached, rather than start every thread on default meanwhile.
      try {
        markApproved(repository);
        await tellRunningLead(db, sessions, repository, "lead_flows", flowsNote(repository));
      } catch (error) {
        console.log(`couldn't tell ${owner}/${repo}'s lead of its flows: ${errorText(error)}`);
      }
      await tellRunningLead(db, sessions, repository, "lead_briefs", briefsNote).catch((error) =>
        console.log(`couldn't tell ${owner}/${repo}'s lead of briefs: ${errorText(error)}`),
      );
    }
  }
  // With the copy and the clone up to date, find which open PRs change .agents/, for the merge
  // confirms. A repository with no clone yet has nothing to look in.
  if (forgeOf(db, repository) !== null && existsSync(cloneDir(owner, repo)))
    await saveAgentsChanges(db, repository, refreshed);
  // With the copy up to date, start labeled tasks, then act on each thread: by its PR with a
  // forge, or by its branch without one, or without a PR.
  if (trackerOf(db, repository) !== null)
    await startLabeled(db, sessions, repository, setUpAndStart, starting, passed);
  const hasForge = forgeOf(db, repository) !== null;
  for (const before of threads) {
    if (!hasForge) await actOnBranch(db, sessions, repository, readThread(db, before.folder));
    else {
      // A verdict whose post failed goes on the PR first, so the merge goes by it.
      await retryPost(db, sessions, before.folder);
      // From the copy, just brought up to date, rather than from the answer: a forge answers
      // only what changed, and events held back for a thread, such as one stopped, were left
      // out of its `seen`, so its PR is acted on again until they are handed over.
      const pr = before.pr === null ? null : prOf(db, owner, repo, before.pr);
      if (!pr) {
        if (before.pr === null) await actOnBranchHead(db, sessions, repository, before);
        continue;
      }
      await actOnPr(db, sessions, before, pr);
      // Once the PR's events are acted on, an armed merge when ready merges it if it is ready.
      // A thread sc rm is removing is its to end.
      // One that fails is logged, so the poll's other threads still get their events.
      if (!removing.has(before.folder))
        await mergeIfReady(db, sessions, before, pr).catch((error) =>
          console.log(`couldn't merge ${before.folder} when ready: ${errorText(error)}`),
        );
    }
  }
}

// Polls each repository's tracker and forge for what changed in its tasks and PRs. The PRs of
// stopped threads are polled too, so a stopped thread's merge still ends it. Each tick also
// stops every thread whose builder ended outside Skelcrew, and tells its lead. A repository is
// polled every `every` milliseconds while one of its threads is working or waits on review or
// CI, and half as often otherwise, so a label or your comment is seen within a minute. The
// first poll runs at once, to pick up what happened while the daemon was down. A failed poll,
// such as a forge answering with an error, is logged and tried again at the next one. Polls
// run in the background, so they never hold up the daemon. `setUpAndStart` sets up a thread
// started from a label and starts its builder, as the daemon does for sc start. `starting`
// holds the tasks sc start is starting right now, which no poll starts by their label.
// Returns a function that polls one repository at once, named by its owner/name, for sc
// start. It settles once that poll is done, and fails if the poll fails.
export function pollRepositories(
  db: Database,
  sessions: string,
  every: number,
  setUpAndStart: (thread: Thread) => Promise<void>,
  starting: Set<string>,
): (fullName: string) => Promise<void> {
  // How many ticks in a row each repository has gone without a poll, by owner/name.
  const ticksSkipped = new Map<string, number>();
  // The labeled tasks this daemon won't start by their label, kept for its lifetime.
  const passed = new Set<string>();
  // The poll under way for each repository, and the one that follows it.
  const running = new Map<string, Promise<void>>();
  const following = new Map<string, Promise<void>>();
  // Where each repository's next poll starts from, for each of its plugins. The daemon starts
  // with none, so its first poll brings everything open, and what closed while it was down
  // leaves the copy.
  const nexts = new Map<string, Map<string, string | null>>();
  // The threads a poll looks after. A stopped thread's PR or branch still merges or closes, and
  // so does one queued to come back.
  const threadsToPoll = () =>
    db
      .query(
        "SELECT * FROM task_threads WHERE status IN ('queued', 'working', 'waiting', 'stopped')",
      )
      .all()
      .map((row) => Thread.parse(row));
  const poll = (owner: string, repo: string): Promise<void> => {
    const fullName = `${owner}/${repo}`;
    ticksSkipped.set(fullName, 0);
    const underWay = running.get(fullName);
    if (underWay) {
      // A delivery that comes in while its repository is being polled may be about an event
      // the poll's query was too early to see, and sc start must see every change up to its
      // asking, so one more poll follows. Everyone who asks meanwhile shares it.
      const next =
        following.get(fullName) ??
        underWay
          .catch(() => {})
          .then(() => {
            following.delete(fullName);
            return poll(owner, repo);
          });
      following.set(fullName, next);
      return next;
    }
    // No poll is under way, so start one, and keep it as running until it settles. A
    // repository removed meanwhile has nothing to poll.
    const threads = threadsToPoll().filter((t) => t.owner === owner && t.repo === repo);
    const repository = repositories(db).find((r) => r.owner === owner && r.repo === repo);
    if (!repository) return Promise.resolve();
    const pluginNexts = nexts.get(fullName) ?? new Map<string, string | null>();
    nexts.set(fullName, pluginNexts);
    const done = pollRepository(
      db,
      sessions,
      repository,
      threads,
      setUpAndStart,
      pluginNexts,
      starting,
      passed,
    )
      .then(
        () => {},
        (error) => {
          console.log(`couldn't poll ${fullName}: ${errorText(error)}`);
          throw error;
        },
      )
      .finally(() => running.delete(fullName));
    running.set(fullName, done);
    return done;
  };
  // Each tick polls a repository with work under way, and one without every other tick. A
  // repository whose forge isn't known yet waits, and one still being polled is skipped.
  // The threads whose builder is being looked for on its host, by folder, so a slow host is
  // never asked twice at once for the same one.
  const looking = new Set<string>();
  const tick = () => {
    const live = threadsToPoll();
    // Each tick stops the threads whose builder ended outside Skelcrew, in every repository,
    // apart from its polls: only the host can tell, so a tracker or forge that fails, or a forge
    // not known yet, never hides one. One whose stop fails, such as on a host that can't end
    // what an ended builder left, is logged, and tried again on the next tick.
    for (const thread of live) {
      if (looking.has(thread.folder)) continue;
      looking.add(thread.folder);
      noticeEndedBuilder(db, sessions, thread)
        .catch((error) =>
          console.log(`couldn't stop ${thread.folder}, whose builder ended: ${errorText(error)}`),
        )
        .finally(() => looking.delete(thread.folder));
    }
    for (const repository of repositories(db)) {
      const { owner, repo } = repository;
      const fullName = `${owner}/${repo}`;
      if (!forgeKnown(db, repository)) continue;
      const threads = live.filter((t) => t.owner === owner && t.repo === repo);
      const active = threads.some(
        (t) => t.status === "working" || (t.status === "waiting" && !needsYou(t)),
      );
      const waited = ticksSkipped.get(fullName) ?? Number.POSITIVE_INFINITY;
      if (running.has(fullName) || (!active && waited < 1)) {
        ticksSkipped.set(fullName, waited + 1);
        continue;
      }
      // Already logged.
      poll(owner, repo).catch(() => {});
    }
  };
  tick();
  setInterval(tick, every);
  return async (fullName) => {
    const found = repositories(db).find((r) => fullNameIs(r, fullName));
    if (found) await poll(found.owner, found.repo);
  };
}
