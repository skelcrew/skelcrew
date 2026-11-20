// The rows of the list: what `sc` shows of one repository, read from Skelcrew's database and its
// copy of the tracker, never the tracker itself, as the list reads them again each second. Its
// lead, then its tasks by section: Needs you, Up next, then the stages Backlog, Building,
// Reviewing, Checks, Ready and Done, with how many each has. Also a tab for each repository, with
// how many of its threads need you.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { threadLimit } from "../config.ts";
import { backlogOf } from "../flow/backlog.ts";
import { openTasks, prOf } from "../flow/copy.ts";
import { passedReviewStage, reviewCheck } from "../flow/decide.ts";
import { leadOf } from "../flow/lead.ts";
import {
  type Badge,
  badgeOf,
  type Colour,
  type Mark,
  needsDecision,
  readyToMerge,
  shownOf,
} from "../flow/marks.ts";
import { agentsSaid } from "../flow/merging.ts";
import { findRepository } from "../flow/repo.ts";
import type { DaemonRequest } from "../flow/requests.ts";
import { ListStage, listStage } from "../flow/stage.ts";
import { counted, ordinal } from "../flow/task-queue.ts";
import { Thread } from "../flow/thread.ts";
import { forgeOf } from "../plugins/ask.ts";
import { changedAt, roundLimit as settingsRoundLimit } from "../screen/lists.ts";
import { removeControlCodes } from "../screen/look.ts";
import { builderProgress } from "../screen/progress.ts";

// What y does on a row once its question is answered: the question the bottom line asks, what it
// says while the daemon works, and the request the daemon gets. `queues` says a yes is expected
// to put the task in the queue of limits.threads, which the key's name says.
export type Question = { ask: string; working: string; request: DaemonRequest; queues: boolean };
// What m does on a task ready for review: asks, or says why it can't, such as for a PR whose
// forge plugin is too old to merge.
type Action = Question | { refused: string };

// The sections of the list, in the order it shows them: Needs you, Up next, then each stage. Up
// next holds what waits for a builder: the tasks queued under limits.threads, in the order they
// start, then the threads paused with sc stop.
export type Section = "needs you" | "up next" | ListStage;
export const sections: Section[] = ["needs you", "up next", ...ListStage.options];

// One row of the list. `part` is where it is: the lead, or the stage of its task. `section` is
// the section it shows under: Needs you while the task waits on you, Up next while it is queued
// or paused, its stage otherwise. Its mark is a sign and the colour that says what kind of state it is in, `says` is its short word, in
// `colour`, and `step` what its builder is doing, such as `Editing rows.ts`. Then dim its PR,
// such as `#41`, its CI, such as `CI passed`, and when it last changed, such as `14:31`. Each is
// empty where it has none. `needsYou` is whether it waits on you for something other than a
// merge. `session` is the agent's session, which Enter attaches to, `running` whether its agent
// runs, and `tmux` whether Enter attaches to it on tmux, where Ctrl-\ comes back, rather than on
// a runtime plugin's host, which has a key of its own. `start` is what Enter does on an issue,
// and `merge` what m does on a task ready for review. `link` is its PR's, which Enter opens, and
// `branch` the branch a task that is ready without a forge waits on. Each is null where it
// doesn't apply. `more` is how many issues the row stands for on the `… more` row at the end of
// a cut Backlog, which Enter shows, and 0 on every other row. `task` is the task's ID, such as 12,
// which the details pane reads it by, or null on a row that isn't a task. `place` is a queued
// task's place in its repository's queue, 1 for the one that starts next, or null. `waits` says
// what a queued or paused task waits on, such as `3rd in line: 4 of 4 builders busy`, for the
// details pane, and is empty on every other row.
export type Row = {
  part: "lead" | ListStage;
  section: "lead" | Section;
  name: string;
  task: string | null;
  title: string;
  mark: { sign: string; colour: Colour };
  says: string;
  colour: Colour;
  step: string;
  pr: string;
  checks: string;
  when: string;
  needsYou: boolean;
  session: string | null;
  running: boolean;
  tmux: boolean;
  start: Question | null;
  merge: Action | null;
  link: string | null;
  branch: string | null;
  more: number;
  place: number | null;
  waits: string;
};

// The repository the list shows, by its owner/name.
export type Open = { owner: string; repo: string };

// A repository's tab: its name in Skelcrew, its owner/name, and its badge.
export type Tab = Badge & { name: string; fullName: string };

// Returns the round limit the list judges a thread's word by. A thread holding the changes of a
// review past the limit says so by itself. Past the limit, sc submit and sc review drop those
// changes but keep the thread needing you while its round runs, and so can other reasons, such
// as a message that couldn't be typed in. Only the thread's real round limit tells them apart,
// so for such a thread alone the list reads its settings, and settings that aren't valid read as
// no limit. Any other thread reads none, so drawing the list stays fast.
const roundLimit = (thread: Thread) => {
  const underWay = thread.submitting !== null || thread.reviewing !== null;
  return thread.needs_you && underWay ? settingsRoundLimit(thread) : Number.POSITIVE_INFINITY;
};

// What the list reads of a lead beyond leadOf: what its hooks last said it does, and whether you
// closed its tab by exiting it.
const LeadState = z.object({ lead_state: z.string().nullable(), tab_closed: z.coerce.boolean() });

// Returns the lead's row, drawn as a task's is, so it reads as a row you can open. It says
// whether the lead runs, and when it does, what its hooks last said it is doing, and its title is
// its harness. Its mark is filled and yellow while it asks you something, bright while it runs
// and dim once you exited it. The daemon keeps the lead of every open tab running, so a
// lead runs unless you exited it, which closed its tab. Enter has the daemon start it either way.
function leadRow(db: Database, open: Open): Row {
  const lead = leadOf(db, open.owner, open.repo);
  const { lead_state: state, tab_closed: closed } = LeadState.parse(
    db
      .query("SELECT lead_state, tab_closed FROM repositories WHERE owner = ? AND repo = ?")
      .get(open.owner, open.repo),
  );
  const runs = !closed;
  // The hooks say asking while a question waits on you, and nothing before the first one ran.
  // A lead you exited asks nothing, whatever its hooks last said.
  const asking = runs && state === "asking";
  const word = !runs ? "stopped" : asking ? "asks you" : (state ?? "running");
  return {
    part: "lead",
    section: "lead",
    name: "lead",
    task: null,
    title: lead.harness ?? "",
    mark: asking ? { sign: "●", colour: "yellow" } : { sign: "○", colour: runs ? "bright" : "dim" },
    says: word,
    colour: asking ? "yellow" : "dim",
    step: "",
    pr: "",
    checks: "",
    when: "",
    needsYou: asking,
    session: lead.name,
    running: runs,
    tmux: true,
    start: null,
    merge: null,
    link: null,
    branch: null,
    more: 0,
    place: null,
    waits: "",
  };
}

// What the list reads of a task beyond what Thread has: its PR's link, saved as the forge's copy
// last had it, for a task whose PR has left the copy.
const SavedLink = z.object({ pr_link: z.string().nullable() });

// Returns the row of a task with a thread, given the thread and the stage it is in. Its word says
// in one or two words what is happening, or when the thread needs you, why, in its mark's colour.
// An ended task says whether it merged. A builder at work, or at work while its review runs, also
// has the step it is on, as the sidebar shows it. Then come its PR, its CI and when it last
// changed. The rest, such as a merge when ready or messages waiting, is for sc show, so a row
// stays short. A task ready for review offers m when it has a PR to merge.
function taskRow(
  db: Database,
  open: Open,
  repoName: string,
  thread: Thread,
  saved: unknown,
  stage: ListStage,
  now: number,
): Row {
  const name = `${repoName}-${thread.task}`;
  const shown = shownOf(thread, roundLimit(thread), now);
  // An ended thread shows no state: its word is whether it merged, and its mark is quiet.
  // A task approved and green, with no merge armed, waits on you to merge it, so its word says
  // that action, as every word under Needs you does. One its flow didn't review says so after
  // it, so you know nobody looked at it before you merge it.
  const ended = stage === "done";
  const mark: Mark = ended ? { sign: "○", colour: "dim" } : shown.mark;
  const unreviewed = shown.word === "not reviewed" ? ", not reviewed" : "";
  const live = readyToMerge(mark) ? `ready to merge${unreviewed}` : shown.word;
  const word = ended ? (thread.merged ? "merged" : "closed") : live;
  const needsYou = needsDecision(mark);
  const ready = stage === "ready" && !needsYou;
  const pr = thread.pr === null ? "" : `#${thread.pr}`;
  const copy = thread.pr === null ? null : prOf(db, open.owner, open.repo, thread.pr);
  // No CI runs on the PR's head once the wait for CI's first check on it ended with none. Its
  // checks then count as passed, and the row says "no CI".
  const noCi = copy !== null && copy.head !== null && thread.no_ci === copy.head;
  const changed = thread.changed ?? thread.started;
  // The step comes from the builder's conversation file, read at most every 10 seconds, and only
  // while it works, as the sidebar reads it.
  const reviewed = word === "reviewing" || word === "queued for review";
  const stepping = word === "working" || (reviewed && shown.status === "working");
  const step = stepping ? removeControlCodes(builderProgress(thread, now).step ?? "") : "";
  // m merges the PR only at the commit Skelcrew's reviewer approved, or for a flow with no review
  // stage the one last submitted, and only while it is the
  // head the forge last sent and CI passed there, as the forge's copy of the PR shows. The thread's own verdict and checks can lag
  // behind a push, so they never stand for a newer head. A forge too old to send the head
  // commit can't merge either, as it lacks the call too.
  let merge: Action | null = null;
  if (ready && thread.pr !== null && copy !== null) {
    const named = `${repoName}#${thread.pr}`;
    // The commit the latest review approved, as the review saved it, so drawing the list asks
    // git nothing. An approval from before Skelcrew saved it has none, and merges on the forge.
    const approved = passedReviewStage(thread) ? thread.reviewed_commit : null;
    const unreviewed = thread.verdict === "not reviewed";
    const which = unreviewed ? "submitted" : "approved";
    const wait = unreviewed ? "wait for its builder to submit it" : "wait for its review";
    const ci = copy.checks.filter((check) => check.name !== reviewCheck);
    if (copy.head === null)
      merge = {
        refused: `${named} needs a newer forge plugin to merge here: run sc plugin update`,
      };
    else if (approved === null)
      merge = {
        refused: `${named}'s approval has no commit saved: merge it on the forge, or run sc review ${name}`,
      };
    else if (approved !== copy.head)
      merge = {
        refused: `${named} has a newer commit than the one ${which}: ${wait}`,
      };
    // No checks in the copy is a pass only once the wait for CI's first check on that commit
    // ended with none. Until then CI may not have started on it yet.
    else if ((ci.length === 0 && !noCi) || !ci.every((check) => check.state === "passed"))
      merge = { refused: `${named}'s checks haven't passed on the ${which} commit yet` };
    else
      merge = {
        ask: [
          `Merge ${named} into ${removeControlCodes(copy.base)}?`,
          agentsSaid(db, open.owner, open.repo, copy, approved),
          "y/n",
        ]
          .filter(Boolean)
          .join(" "),
        working: `Merging ${named}…`,
        request: {
          command: "merge",
          repo: `${open.owner}/${open.repo}`,
          pr: thread.pr,
          commit: approved,
        },
        queues: false,
      };
  }
  // A builder runs while its thread works or waits. One that stopped or failed doesn't.
  const runs = thread.status === "working" || thread.status === "waiting";
  return {
    part: stage,
    // A filled mark waits on you: a decision, an answer, something gone wrong, or a merge. A
    // task that waits for a builder, queued or paused, is up next.
    section:
      mark.sign === "●"
        ? "needs you"
        : thread.status === "queued" || thread.status === "stopped"
          ? "up next"
          : stage,
    name,
    task: thread.task,
    title: removeControlCodes(thread.short ?? thread.title ?? ""),
    mark,
    says: word,
    colour: mark.colour,
    step,
    pr,
    checks: thread.checks === null ? (noCi ? "no CI" : "") : ciWords[thread.checks],
    when: changed === null ? "" : changedAt(changed, now),
    needsYou,
    session: ended ? null : thread.folder,
    running: runs,
    // Enter attaches to the builder of a task at work, or of a ready one that needs you.
    tmux: !ended && !ready && (thread.host ?? "tmux") === "tmux",
    start: null,
    merge,
    // The saved link stands in only for this attempt's PR: a task started over has none until
    // it opens one, and must never open the previous attempt's.
    link: copy?.link ?? (thread.pr === null ? null : SavedLink.parse(saved).pr_link),
    branch: thread.branch,
    more: 0,
    place: null,
    waits: "",
  };
}

// What a task's CI says, by its checks as the last poll saved them, in sc ps's words.
const ciWords: Record<NonNullable<Thread["checks"]>, string> = {
  passing: "CI passed",
  failing: "CI failed",
  pending: "CI running",
};

// How many ended tasks Done shows at least, when fewer than that ended today.
const doneShown = 10;

// Returns how full the repository's builders are: how many run, how many may run at once under
// its limits.threads, or null with no limit, and how many tasks wait in its queue. A limit whose
// file can't be read counts as none here, as the list must still draw.
function buildersOf(db: Database, open: Open) {
  let limit: number | null = null;
  try {
    limit = threadLimit(open) ?? null;
  } catch {}
  return { ...counted(db, open), limit };
}

// Returns what Up next's heading says of the builders, such as `Building 4/4 · 3 queued`: how
// many run of how many may, and how many tasks wait. Without limits.threads nothing waits, so it
// says nothing.
export function buildersNote(db: Database, open: Open): string {
  const { running, queued, limit } = buildersOf(db, open);
  if (limit === null) return "";
  return `Building ${running}/${limit}${queued > 0 ? ` · ${queued} queued` : ""}`;
}

// Returns the repository's rows as the database has them now, at a moment in milliseconds: its
// lead, then its tasks in the order of their sections. Needs you comes first, so the list
// reaches what waits on you fastest. Up next has the queued tasks in the order they start, each
// with its place, then the paused ones, the newest task first. Backlog has its open issues
// no thread works on and the tasks filed in its backlog, newest first. Needs you and each other
// stage have the one that changed last first. Done has the tasks that ended today, latest first,
// or the last ten when fewer ended today, so an old repository's history never fills the list.
// It reads the database, and a working builder's conversation file for its step, as the sidebar
// does, never tmux, so the list opens at once and works on any session host. Settings are read
// for the repository's limits.threads, and for a thread that needs you while a review runs, to
// tell the round limit from another reason.
export function listRows(db: Database, open: Open, now: number): Row[] {
  const repository = findRepository(db, `${open.owner}/${open.repo}`);
  const issues = openTasks(db, open.owner, open.repo);
  const threads = db
    .query("SELECT * FROM task_threads WHERE owner = ? AND repo = ? ORDER BY rowid DESC")
    .all(open.owner, open.repo)
    .map((saved) => ({ saved, thread: Thread.parse(saved) }));
  // A thread whose work ended without a merge while its issue is open is back in Backlog, where
  // its issue's row stands for it, to start again.
  const tasks = threads.flatMap(({ saved, thread }) => {
    const stage = listStage(
      thread,
      issues.some((issue) => issue.id === thread.task),
    );
    return stage === "backlog"
      ? []
      : [taskRow(db, open, repository.name, thread, saved, stage, now)];
  });
  // The queue in the order it starts, by when each task joined it, as the daemon takes them.
  const builders = buildersOf(db, open);
  const queue = threads
    .map(({ thread }) => thread)
    .filter((thread) => thread.status === "queued")
    .sort((a, b) => (a.queued_since ?? 0) - (b.queued_since ?? 0));
  const busy =
    builders.limit === null
      ? "its repository's limits.threads can't be read"
      : `${builders.running} of ${builders.limit} builders busy`;
  // A queued task whose issue's claim hasn't reached the tracker yet holds back itself and every
  // task after it, free builders or not, as the daemon keeps the queue first come first served.
  // So from the first such task on, that claim is what they wait on.
  const claimed = new Set(
    db
      .query("SELECT task FROM claims WHERE owner = ? AND repo = ?")
      .all(open.owner, open.repo)
      .map((row) => z.object({ task: z.string() }).parse(row).task),
  );
  const held = queue.findIndex((thread) => claimed.has(thread.task));
  const holder = queue[held];
  const claim = holder
    ? `${repository.name}-${holder.task} waits for its issue's claim to reach the tracker`
    : "";
  // Returns what the task at a place in the queue, counted from 0, waits on.
  const waitsOn = (at: number) => (holder && at >= held ? claim : busy);
  // A queued or paused task says where it is in line, or that it is paused, and the pane says
  // what it waits on, under Needs you too. Up next's rows say it in their word as well. One
  // under Needs you keeps its word, as it says what you must do.
  for (const row of tasks) {
    const thread = threads.find(({ thread: t }) => `${repository.name}-${t.task}` === row.name);
    const at = queue.findIndex((queued) => `${repository.name}-${queued.task}` === row.name);
    if (at >= 0) {
      row.place = at + 1;
      row.waits = `${at === 0 ? "Starts next" : `${ordinal(at + 1)} in line`}: ${waitsOn(at)}`;
      if (row.section === "up next")
        row.says = at === 0 ? "starts next" : `${ordinal(at + 1)} in line`;
    } else if (thread?.thread.status === "stopped") {
      row.waits = `Paused with sc stop: sc start ${row.name} brings it back`;
      if (row.section !== "up next") continue;
      row.says = "paused";
      row.colour = "dim";
      row.mark = { sign: "○", colour: "dim" };
    }
  }
  // A start while every builder is busy, or while tasks already wait, queues the task at the end
  // of the queue, as the daemon decides, so the question says so, and what the queue waits on.
  const full =
    builders.limit !== null && (builders.queued > 0 || builders.running >= builders.limit);
  // Returns the row of a task not started yet, which Enter asks to start, as sc start does.
  const notStarted = (task: string, title: string, changed: number): Row => {
    const name = `${repository.name}-${task}`;
    const after = builders.queued > 0 ? ` after the ${builders.queued} queued` : "";
    return {
      part: "backlog",
      section: "backlog",
      name,
      task,
      title: removeControlCodes(title),
      mark: { sign: "○", colour: "dim" },
      says: "",
      colour: "dim",
      step: "",
      pr: "",
      checks: "",
      when: Number.isNaN(changed) ? "" : changedAt(changed, now),
      needsYou: false,
      session: null,
      running: false,
      tmux: false,
      start: full
        ? {
            ask: `Queue ${name}? ${waitsOn(queue.length)}, so it starts${after}. y/n`,
            working: `Queueing ${name}…`,
            request: { command: "start", repo: `${open.owner}/${open.repo}`, task },
            queues: true,
          }
        : {
            ask: `Start ${name}? y/n`,
            working: `Starting ${name}…`,
            request: { command: "start", repo: `${open.owner}/${open.repo}`, task },
            queues: false,
          },
      merge: null,
      link: null,
      branch: null,
      more: 0,
      place: null,
      waits: "",
    };
  };
  // The open issues no thread works on, and the tasks filed in the backlog, newest first.
  const waiting = [
    ...issues
      .filter((issue) => !tasks.some((row) => row.name === `${repository.name}-${issue.id}`))
      .map((issue) => ({
        created: issue.created,
        row: notStarted(issue.id, issue.title, Date.parse(issue.updated)),
      })),
    ...backlogOf(db, open.owner, open.repo).map((t) => ({
      created: t.created,
      row: notStarted(t.task, t.title, Date.parse(t.created)),
    })),
  ]
    .sort((a, b) => b.created.localeCompare(a.created))
    .map(({ row }) => row);
  // When each task last changed. For an ended task that is when it ended, as nothing changes
  // it after.
  const changedOf = (row: Row) => {
    const thread = threads.find(
      ({ thread: candidate }) => `${repository.name}-${candidate.task}` === row.name,
    )?.thread;
    return thread?.changed ?? thread?.started ?? 0;
  };
  const today = new Date(now).toDateString();
  const done = tasks
    .filter((row) => row.part === "done")
    .sort((a, b) => changedOf(b) - changedOf(a))
    .filter((row, at) => at < doneShown || new Date(changedOf(row)).toDateString() === today);
  // Returns a section's live tasks, the one that changed last first.
  const live = (section: Section) =>
    tasks.filter((row) => row.section === section).sort((a, b) => changedOf(b) - changedOf(a));
  // Up next has the queued tasks by their place, then the paused ones, the newest task first.
  // A paused thread's last change can come from a poll, such as its CI, so it orders nothing.
  const startedOf = (row: Row) =>
    threads.find(({ thread }) => `${repository.name}-${thread.task}` === row.name)?.thread
      .started ?? 0;
  const upNext = tasks
    .filter((row) => row.section === "up next")
    .sort(
      (a, b) =>
        (a.place ?? Number.POSITIVE_INFINITY) - (b.place ?? Number.POSITIVE_INFINITY) ||
        startedOf(b) - startedOf(a),
    );
  return [
    leadRow(db, open),
    ...live("needs you"),
    ...upNext,
    ...waiting,
    ...live("building"),
    ...live("reviewing"),
    ...live("checks"),
    ...live("ready"),
    ...done,
  ];
}

// How many issues Backlog shows before its `… more` row, as a long backlog would fill the list.
const backlogShown = 10;

// Returns the rows with Backlog cut to its newest 10 issues and a `… more` row after them, which
// stands for the rest, unless `whole` asks for every issue. A Backlog of 10 or fewer is whole.
export function cutBacklog(rows: Row[], whole: boolean): Row[] {
  const backlog = rows.filter((row) => row.part === "backlog");
  const rest = backlog.length - backlogShown;
  if (whole || rest <= 0) return rows;
  const hidden = new Set(backlog.slice(backlogShown));
  const more: Row = {
    part: "backlog",
    section: "backlog",
    name: `${rest} more`,
    task: null,
    title: "",
    mark: { sign: "…", colour: "dim" },
    says: "",
    colour: "dim",
    step: "",
    pr: "",
    checks: "",
    when: "",
    needsYou: false,
    session: null,
    running: false,
    tmux: false,
    start: null,
    merge: null,
    link: null,
    branch: null,
    more: rest,
    place: null,
    waits: "",
  };
  // The `… more` row goes where the first issue it stands for was, so it ends Backlog.
  return rows.flatMap((row) =>
    row === backlog[backlogShown] ? [more] : hidden.has(row) ? [] : [row],
  );
}

// A section's heading: its section, how many tasks it has, whether it is open, which shows its
// rows, and what it says after its count, dim, which only Up next has: how full the builders are.
export type Heading = { section: Section; count: number; open: boolean; note: string };

// Returns the heading of every section, in order, from all the rows, whether their section is
// open or not, given the sections that are open. `builders` is what Up next's heading says of
// the builders, from buildersNote.
export function sectionHeadings(rows: Row[], opened: Set<Section>, builders = ""): Heading[] {
  return sections.map((section) => {
    const count = rows.filter((row) => row.section === section).length;
    const note = section === "up next" ? builders : "";
    return { section, count, open: opened.has(section), note };
  });
}

// Returns whether a repository has a forge, which merging and PRs need.
export function hasForge(db: Database, open: Open): boolean {
  return forgeOf(db, findRepository(db, `${open.owner}/${open.repo}`)) !== null;
}

// What a tab's row holds as the database gives it, checked, since it is read from disk.
const TabRow = z.object({ name: z.string(), owner: z.string(), repo: z.string() });

// Returns a tab for each repository, in name order, with its badge: how many of its threads
// need you, and how many are ready to merge. The badges are how you hear of other repositories,
// as one repository's lead never mentions another's threads. A repository whose lead you exited
// has no tab until you open it again, except the open one, so the list never loses what it shows.
export function repositoryTabs(db: Database, open: Open): Tab[] {
  const repositories = db
    .query(`SELECT name, owner, repo FROM repositories
      WHERE tab_closed = 0 OR (owner = ? AND repo = ?) ORDER BY name`)
    .all(open.owner, open.repo)
    .map((row) => TabRow.parse(row));
  // Each thread that isn't done gets the mark its row would have.
  const marked = db
    .query("SELECT * FROM task_threads WHERE status != 'done'")
    .all()
    .map((row) => {
      const thread = Thread.parse(row);
      return { thread, mark: shownOf(thread, roundLimit(thread)).mark };
    });
  return repositories.map(({ name, owner, repo }) => {
    const ours = marked.filter((m) => m.thread.owner === owner && m.thread.repo === repo);
    return { name, fullName: `${owner}/${repo}`, ...badgeOf(ours.map((m) => m.mark)) };
  });
}
