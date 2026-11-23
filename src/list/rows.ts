// The rows of the list: what `sc` shows of one repository, read from Skelcrew's database and its
// copy of the tracker, never the tracker itself, as the list reads them again each second. Its
// lead, then its tasks by section: Needs you, Task queue, then the stages Backlog, Building,
// Reviewing, Checks, Ready and Done, with how many each has. Also a tab for each repository, with
// how many of its threads need you.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { HarnessName, harnessNamed } from "../agents/harness.ts";
import { threadLimit } from "../config.ts";
import { backlogOf } from "../flow/backlog.ts";
import { issueRef, openTasks, prOf } from "../flow/copy.ts";
import { reviewCheck } from "../flow/decide.ts";
import { type Item, itemOf, itemsOf } from "../flow/inbox.ts";
import { leadOf } from "../flow/lead.ts";
import { limitOf, nextRound, passedReviewStage, roundOf } from "../flow/ledger.ts";
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
import { type Act, type OwnItem, ownItem } from "../flow/own-items.ts";
import { findRepository } from "../flow/repo.ts";
import type { DaemonRequest } from "../flow/requests.ts";
import { type ListStage, listStage } from "../flow/stage.ts";
import { stillAsks } from "../flow/status.ts";
import { counted, ordinal } from "../flow/task-queue.ts";
import { Thread, taskLabel, taskName, typedTask } from "../flow/thread.ts";
import { forgeOf } from "../plugins/ask.ts";
import { removeControlCodes } from "../screen/look.ts";
import { agentProgress, builderProgress } from "../screen/progress.ts";

// What y does on a row once its question is answered: the question the bottom line asks, what it
// says while the daemon works, and the request the daemon gets. `queues` says a yes is expected
// to put the task in the queue of limits.threads, which the key's name says.
export type Question = { ask: string; working: string; request: DaemonRequest; queues: boolean };
// What m does on a task ready for review: asks, or says why it can't, such as for a PR whose
// forge plugin is too old to merge.
type Action = Question | { refused: string };

// The sections of the list, in the order it shows them: Needs you, then the stages, with Task queue
// between Backlog and Building. Task queue holds what waits for a builder: the tasks queued under
// limits.threads, in the order they start, then the threads paused with sc stop.
export type Section = "needs you" | "task queue" | ListStage;
export const sections: Section[] = [
  "needs you",
  "backlog",
  "task queue",
  "building",
  "reviewing",
  "checks",
  "ready",
  "done",
];
// The sections a number key opens and closes, each by its place here: Backlog is 0, Task queue 1.
// Needs you has no key, as it never closes.
export const numbered = sections.filter((section) => section !== "needs you");

// The item a row shows under Needs you: its short title, its text and its options, in letter
// order. `acts` is what each option of Skelcrew's own item does, and null on the lead's item,
// whose pick goes to the lead. `merging` is the PR you saw, by its number, when its thread
// started and its head as Skelcrew's copy had it, on an item that offers a merge without
// approval, which merges only that PR at that commit. `skipping` is what that merge asks y/n of
// first, as sc merge --skip-review does: what the review still asks, and whether it changes
// .agents/.
export type Ask = {
  title: string;
  text: string;
  options: string[];
  acts: Act[] | null;
  merging?: Seen;
  skipping?: string;
};

// A PR as you saw it, for a merge without approval.
type Seen = { pr: number; started: number | null; head: string };

// The mark of a row with the lead's item, which waits on your answer, whatever else it shows.
const answerMark: Mark = { sign: "●", colour: "yellow" };

// One row of the list. `part` is where it is: the lead, the stage of its task, the lead's item on
// the repository, or a section's heading, which you can stand on too, so Enter there opens or closes it. `section` is the section
// it shows under: Needs you while the task waits on you, Task queue while it is queued or paused,
// its stage otherwise. Its mark is a sign and the colour that says what kind of state it is in,
// `label` is the name the row shows, such as 139, without the repository its tab already names,
// or an issue no task has yet as its tracker writes it, such as #12, while `name`, such as
// APP-139 or APP#12, is what everything else goes by. `says` is its short word, in
// `colour`, and `step` what its builder is doing, such as `Editing rows.ts`. Then its PR, such as
// `#41`, what its CI says, its review's round and the colour of where that review stands, and how
// long ago it last changed, such as `4m`. Each is empty or null where it has none. `changed` is
// that moment in milliseconds, or null, which the details pane gives by the clock, so the two
// always agree. `needsYou` is whether it waits on you for
// something other than a merge. `session` is the agent's session, which Enter attaches to,
// `running` whether its agent runs, `working` whether its builder or the lead is at work this
// moment, by what its harness last said, even while the task needs you or something failed, and `tmux` whether Enter attaches to it on tmux, where
// Ctrl-\ comes back, rather than on a runtime plugin's host, which has a key of its own. `start` is what
// Enter does on an issue, `startNow` what f does on a queued task, or on an issue while every
// builder is busy, which starts it at once over limits.threads, and `merge` what m does on a task ready for review. `link` is its PR's,
// which Enter opens, and `branch` the branch a task that is ready without a forge waits on. Each is
// null where it doesn't apply. `more` is how many issues the row stands for on the `… more` row at
// the end of a cut Backlog, which Enter shows, and 0 on every other row. `task` is the task's ID,
// such as t12, which the details pane reads it by, or null on a row that isn't a task. `place` is a
// queued task's place in its repository's queue, 1 for the one that starts next, or null. `waits`
// says what a queued or paused task waits on, such as `3rd in line: 4 of 4 builders busy`, for the
// details pane, and is empty on every other row. `ask` is the lead's item on it, which a letter or a
// reply answers, or null with none.
export type Row = {
  part: "lead" | "heading" | "ask" | ListStage;
  section: "lead" | Section;
  name: string;
  label: string;
  task: string | null;
  title: string;
  mark: { sign: string; colour: Colour };
  says: string;
  colour: Colour;
  step: string;
  pr: string;
  ci: Ci | null;
  review: { round: number; colour: Colour } | null;
  when: string;
  changed: number | null;
  needsYou: boolean;
  session: string | null;
  running: boolean;
  working: boolean;
  tmux: boolean;
  start: Question | null;
  startNow: Question | null;
  merge: Action | null;
  link: string | null;
  branch: string | null;
  more: number;
  place: number | null;
  waits: string;
  ask: Ask | null;
};

// What a task's CI says, by its checks as the last poll saved them.
export type Ci = "passed" | "running" | "failed";

// The repository the list shows, by its owner/name.
export type Open = { owner: string; repo: string };

// A repository's tab: its name in Skelcrew, its owner/name, and its badge.
export type Tab = Badge & { name: string; fullName: string };

// Returns when something happened as a clock time, such as 14:32, with the date before it for a
// day before today, such as 12 Nov 23:59, in this machine's time zone. The details pane says when
// a task last changed with it, beside how long ago.
export function changedAt(at: number, now: number): string {
  const when = new Date(at);
  const clock = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  if (when.toDateString() === new Date(now).toDateString()) return clock;
  return `${when.getDate()} ${when.toLocaleString("en-GB", { month: "short" })} ${clock}`;
}

// Returns how long ago a moment was, before `now`, both in milliseconds, in its largest whole
// unit, such as `4m ago`, `2h ago` or `3d ago`, or `just now` within a minute. The details pane
// says when things happened this way, as a clock time makes you work out how long it has been.
// `short` leaves out the words, as `4m` or `now`, for a row, where room is tight. A moment after
// `now` counts as just now, as another machine's clock can run ahead.
export function ago(at: number, now: number, short = false): string {
  const minutes = Math.floor(Math.max(now - at, 0) / 60_000);
  if (minutes < 1) return short ? "now" : "just now";
  const unit =
    minutes < 60
      ? `${minutes}m`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / (24 * 60))}d`;
  return short ? unit : `${unit} ago`;
}

// Returns the time a row shows: how long ago its task last changed, short, such as 4m, and that
// moment, which the details pane gives by the clock. Both come from here, so a row and its details
// always agree. A task with no time, or one that can't be read, shows none.
const shownTime = (at: number | null, now: number) =>
  at === null || Number.isNaN(at)
    ? { when: "", changed: null }
    : { when: ago(at, now, true), changed: at };

// What the list reads of a lead beyond leadOf: what its hooks last said it does, and whether you
// closed its tab by exiting it.
const LeadState = z.object({ lead_state: z.string().nullable(), tab_closed: z.coerce.boolean() });

// Returns the lead's row, which heads the list. It says whether the lead runs, and when it does,
// what its hooks last said it is doing, or that it is starting before they said anything, and
// what it is doing while it works. Its title is its harness. A lead you exited asks nothing,
// whatever its hooks last said. Its mark is filled and
// yellow while it asks you something, red on an error, bright while it works and dim otherwise.
// The daemon keeps the lead of every open tab running, so a lead runs unless you exited it, which
// closed its tab. Enter has the daemon start it either way.
function leadRow(db: Database, open: Open, now: number): Row {
  const lead = leadOf(db, open.owner, open.repo);
  const { lead_state: state, tab_closed: closed } = LeadState.parse(
    db
      .query("SELECT lead_state, tab_closed FROM repositories WHERE owner = ? AND repo = ?")
      .get(open.owner, open.repo),
  );
  const runs = !closed;
  const said = runs ? state : null;
  const word = !runs ? "stopped" : said === "asking" ? "waiting on you" : (said ?? "starting");
  const working = said === "working";
  const harness = HarnessName.safeParse(lead.harness);
  const step =
    working && harness.success
      ? agentProgress(
          {
            name: lead.name,
            harness: harness.data,
            folder: () => lead.folder,
            session: lead.session,
          },
          now,
        ).step
      : null;
  const colour: Colour =
    said === "asking" ? "yellow" : said === "error" ? "red" : working ? "bright" : "dim";
  return {
    ...emptyRow,
    name: "lead",
    label: "lead",
    title: harness.success ? harnessNamed(harness.data).title : "",
    mark: { sign: said === "asking" || said === "error" ? "●" : "○", colour },
    says: word,
    colour,
    step: removeControlCodes(step ?? ""),
    needsYou: said === "asking",
    session: lead.name,
    running: runs,
    working,
    tmux: true,
  };
}

// Returns the lead's item as a row shows it.
const askOf = (item: Item): Ask => ({
  title: item.title,
  text: item.text,
  options: item.options,
  acts: null,
});

// Returns Skelcrew's own item as a row shows it, with the PR you see when it offers a merge
// without approval.
const ownAsk = (own: OwnItem, skip: { merging: Seen; skipping: string } | null): Ask => ({
  title: own.title,
  text: own.text,
  options: own.options.map((option) => option.label),
  acts: own.options.map((option) => option.act),
  ...(skip !== null && own.options.some((option) => option.act === "skip review") ? skip : {}),
});

// What the list reads of a task beyond what Thread has: its PR's link, saved as the forge's copy
// last had it, for a task whose PR has left the copy.
const SavedLink = z.object({ pr_link: z.string().nullable() });

function taskRow(
  db: Database,
  open: Open,
  repoName: string,
  thread: Thread,
  saved: unknown,
  stage: ListStage,
  now: number,
): Row {
  const name = taskName(repoName, thread.task);
  const shown = shownOf(thread, limitOf(thread), now);
  const ended = stage === "done";
  const item = ended ? null : itemOf(db, open.owner, open.repo, thread.task);
  const own = ended ? null : ownItem(thread, item !== null);
  const mark: Mark = ended ? { sign: "○", colour: "dim" } : item ? answerMark : shown.mark;
  const unreviewed = shown.word === "not reviewed" ? ", not reviewed" : "";
  const live = readyToMerge(mark) ? `ready to merge${unreviewed}` : shown.word;
  const word = ended ? (thread.merged ? "merged" : "closed") : live;
  const needsYou = needsDecision(mark);
  const ready = stage === "ready" && !needsYou;
  const pr = thread.pr === null ? "" : `#${thread.pr}`;
  const copy = thread.pr === null ? null : prOf(db, open.owner, open.repo, thread.pr);
  const noCi = copy !== null && copy.head !== null && thread.no_ci === copy.head;
  const changed = thread.changed ?? thread.started;
  const reviewed = word === "reviewing" || word === "queued for review";
  const stepping = word === "working" || (reviewed && shown.status === "working");
  const step = stepping ? removeControlCodes(builderProgress(thread, now).step ?? "") : "";
  let merge: Action | null = null;
  if (ready && thread.pr !== null && copy !== null) {
    const named = `${repoName}#${thread.pr}`;
    const approved = passedReviewStage(thread) ? roundOf(thread).reviewed_commit : null;
    const unreviewed = roundOf(thread).verdict === "not reviewed";
    const which = unreviewed ? "submitted" : "approved";
    const wait = unreviewed ? "wait for its builder to submit it" : "wait for its review";
    const ci = copy.checks.filter((check) => check.name !== reviewCheck);
    if (copy.head === null)
      merge = {
        refused: `${named} needs a newer forge plugin to merge here: run sc plugin update -g`,
      };
    else if (approved === null)
      merge = {
        refused: `${named}'s approval has no commit saved: merge it on the forge, or run sc review ${name}`,
      };
    else if (approved !== copy.head)
      merge = {
        refused: `${named} has a newer commit than the one ${which}: ${wait}`,
      };
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
  const runs = thread.status === "working" || thread.status === "waiting";
  return {
    part: stage,
    section:
      item !== null || own !== null
        ? "needs you"
        : thread.status === "queued" || thread.status === "stopped"
          ? "task queue"
          : stage,
    name,
    label: taskLabel(thread.task),
    task: thread.task,
    title: removeControlCodes(thread.short ?? thread.title ?? ""),
    mark,
    says: word,
    colour: mark.colour,
    step,
    pr,
    ci: thread.checks === null ? null : ciOf[thread.checks],
    review: reviewOf(thread),
    ...shownTime(changed, now),
    needsYou,
    session: ended ? null : thread.folder,
    running: runs,
    working:
      !ended &&
      runs &&
      !thread.asking &&
      !thread.erred &&
      (thread.state ?? thread.status) === "working",
    tmux: !ended && !ready && (thread.host ?? "tmux") === "tmux",
    start: null,
    startNow: null,
    merge,
    link: copy?.link ?? (thread.pr === null ? null : SavedLink.parse(saved).pr_link),
    branch: thread.branch,
    more: 0,
    place: null,
    waits: "",
    ask: item
      ? askOf(item)
      : own &&
        ownAsk(
          own,
          thread.pr !== null && copy?.head
            ? {
                merging: { pr: thread.pr, started: thread.started, head: copy.head },
                skipping: [
                  `Merge #${thread.pr} (${name} ${removeControlCodes(thread.title ?? "")}) without Skelcrew's approval? CI must still pass.`,
                  removeControlCodes(stillAsks(thread)),
                  agentsSaid(db, open.owner, open.repo, copy, copy.head),
                  "y/n",
                ]
                  .filter(Boolean)
                  .join(" "),
              }
            : null,
        ),
  };
}

// What a task's CI says, by its checks as the last poll saved them. A PR on which no CI runs
// has none, as has one with no checks yet.
const ciOf: Record<NonNullable<Thread["checks"]>, Ci> = {
  passing: "passed",
  failing: "failed",
  pending: "running",
};

// The colour of a finished review, by its verdict.
const verdictColours: Record<Exclude<NonNullable<Thread["verdict"]>, "not reviewed">, Colour> = {
  approve: "green",
  changes: "yellow",
  failed: "red",
  "timed out": "red",
};

// Returns a task's review as its row shows it: its round, green once approved, yellow while it
// runs or after it asked for changes, and red when it failed. A round under way is the next
// one, and a task its flow doesn't review, or none reviewed yet, has none. Only the thread is
// read, as the list draws every second.
function reviewOf(thread: Thread): Row["review"] {
  const round = roundOf(thread);
  if (round.verdict === "not reviewed") return null;
  const live = thread.status === "working" || thread.status === "waiting";
  if (live && (round.submitting !== null || round.reviewing !== null))
    return { round: nextRound(thread), colour: round.review_failed ? "red" : "yellow" };
  if (round.verdict === null || round.review_round === null) return null;
  return { round: round.review_round, colour: verdictColours[round.verdict] };
}

// How many ended tasks Done shows at least, when fewer than that ended today.
const doneShown = 10;

// Returns how full the repository's builders are: how many run, how many may run at once under
// its limits.threads, and how many tasks wait in its queue. A limit that can't be read is null
// here, as the list must still draw.
function buildersOf(db: Database, open: Open) {
  let limit: number | null = null;
  try {
    limit = threadLimit(open);
  } catch {}
  return { ...counted(db, open), limit };
}

export type BuildersNote = { text: string; full: boolean };

export function buildersNote(db: Database, open: Open): BuildersNote | null {
  const { running, queued, limit } = buildersOf(db, open);
  if (limit === null) return null;
  return {
    text: `${running}/${limit} threads${queued > 0 ? ` · ${queued} queued` : ""}`,
    full: running >= limit,
  };
}

// Returns the repository's rows as the database has them now, at a moment in milliseconds: its
// lead, then its tasks in the order of their sections. Needs you comes first, so the list
// reaches what waits on you fastest. Task queue has the queued tasks in the order they start, each
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
      issues.some((issue) => issue.id === thread.issue),
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
  const held = queue.findIndex((thread) => thread.issue !== null && claimed.has(thread.issue));
  const holder = queue[held];
  const claim = holder
    ? `${taskName(repository.name, holder.task)} waits for its issue's claim to reach the tracker`
    : "";
  // Returns what the task at a place in the queue, counted from 0, waits on.
  const waitsOn = (at: number) => (holder && at >= held ? claim : busy);
  // Returns the question f asks of a task, which starts it now over limits.threads, as sc start
  // --now does. It says the limit it goes over, as that is what you decide.
  const over = builders.limit === null ? "limits.threads" : `the limit of ${builders.limit}`;
  const startNow = (task: string): Question => {
    const name = taskName(repository.name, task);
    return {
      ask: `Start ${name} now, over ${over}? y/n`,
      working: `Starting ${name}…`,
      request: {
        command: "start",
        repo: `${open.owner}/${open.repo}`,
        task: typedTask(task),
        now: true,
      },
      queues: false,
    };
  };
  // A queued or paused task says where it is in line, or that it is paused, and the pane says
  // what it waits on, under Needs you too. Task queue's rows say it in their word as well. One
  // under Needs you keeps its word, as it says what you must do.
  for (const row of tasks) {
    const thread = threads.find(({ thread: t }) => taskName(repository.name, t.task) === row.name);
    const at = queue.findIndex((queued) => taskName(repository.name, queued.task) === row.name);
    if (at >= 0) {
      row.place = at + 1;
      if (row.task !== null) row.startNow = startNow(row.task);
      row.waits = `${at === 0 ? "Starts next" : `${ordinal(at + 1)} in line`}: ${waitsOn(at)}`;
      if (row.section === "task queue")
        row.says = at === 0 ? "starts next" : `${ordinal(at + 1)} in line`;
    } else if (thread?.thread.status === "stopped") {
      row.waits = `Paused with sc stop: sc start ${row.name} brings it back`;
      if (row.section !== "task queue") continue;
      row.says = "paused";
      row.colour = "dim";
      row.mark = { sign: "○", colour: "dim" };
    }
  }
  // A start while every builder is busy, or while tasks already wait, queues the task at the end
  // of the queue, as the daemon decides, so the question says so, and what the queue waits on.
  const full =
    builders.limit !== null && (builders.queued > 0 || builders.running >= builders.limit);
  // f offers a start over the limit only while no builder's place is free. Tasks can wait with
  // a place free, such as behind a claim the tracker hasn't taken, and a start then isn't over
  // the limit.
  const noPlace = builders.limit !== null && builders.running >= builders.limit;
  // Returns the row of a task not started yet, which Enter asks to start, as sc start does.
  const notStarted = (task: string, label: string, title: string, changed: number): Row => {
    const name = taskName(repository.name, task);
    const after = builders.queued > 0 ? ` after the ${builders.queued} queued` : "";
    const item = itemOf(db, open.owner, open.repo, task);
    return {
      part: "backlog",
      section: item === null ? "backlog" : "needs you",
      name,
      label,
      task,
      title: removeControlCodes(title),
      mark: { sign: "○", colour: "dim" },
      says: "",
      colour: "dim",
      step: "",
      pr: "",
      ci: null,
      review: null,
      ...shownTime(changed, now),
      needsYou: false,
      session: null,
      running: false,
      working: false,
      tmux: false,
      start: full
        ? {
            ask: `Queue ${name}? ${waitsOn(queue.length)}, so it starts${after}. y/n`,
            working: `Queueing ${name}…`,
            request: {
              command: "start",
              repo: `${open.owner}/${open.repo}`,
              task: typedTask(task),
            },
            queues: true,
          }
        : {
            ask: `Start ${name}? y/n`,
            working: `Starting ${name}…`,
            request: {
              command: "start",
              repo: `${open.owner}/${open.repo}`,
              task: typedTask(task),
            },
            queues: false,
          },
      startNow: noPlace ? startNow(task) : null,
      merge: null,
      link: null,
      branch: null,
      more: 0,
      place: null,
      waits: "",
      ask: item && askOf(item),
    };
  };
  // The open issues no thread works on, and the tasks filed in the backlog, newest first. An
  // issue whose task is back in Backlog goes by that task.
  const waiting = [
    ...issues
      .filter(
        (issue) =>
          !threads.some(
            ({ thread }) => thread.issue === issue.id && listStage(thread, true) !== "backlog",
          ),
      )
      .map((issue) => {
        const task = threads.find(({ thread }) => thread.issue === issue.id)?.thread.task;
        const label = task === undefined ? issueRef(issue.id, issue) : taskLabel(task);
        const changed = Date.parse(issue.updated);
        return {
          created: issue.created,
          row: notStarted(task ?? `#${issue.id}`, label, issue.title, changed),
        };
      }),
    ...backlogOf(db, open.owner, open.repo).map((t) => ({
      created: t.created,
      row: notStarted(t.task, taskLabel(t.task), t.title, Date.parse(t.created)),
    })),
  ]
    .sort((a, b) => b.created.localeCompare(a.created))
    .map(({ row }) => row);
  // When each task last changed. For an ended task that is when it ended, as nothing changes
  // it after.
  const changedOf = (row: Row) => {
    const thread = threads.find(
      ({ thread: candidate }) => taskName(repository.name, candidate.task) === row.name,
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
  // Task queue has the queued tasks by their place, then the paused ones, the newest task first.
  // A paused thread's last change can come from a poll, such as its CI, so it orders nothing.
  const startedOf = (row: Row) =>
    threads.find(({ thread }) => taskName(repository.name, thread.task) === row.name)?.thread
      .started ?? 0;
  const upNext = tasks
    .filter((row) => row.section === "task queue")
    .sort(
      (a, b) =>
        (a.place ?? Number.POSITIVE_INFINITY) - (b.place ?? Number.POSITIVE_INFINITY) ||
        startedOf(b) - startedOf(a),
    );
  // The lead's item on the repository itself, apart from any task.
  const aboutRepository = itemsOf(db, open.owner, open.repo).flatMap((item): Row[] =>
    item.task === ""
      ? [
          {
            ...emptyRow,
            part: "ask",
            section: "needs you",
            name: "ask",
            label: repository.name,
            title: "",
            mark: answerMark,
            colour: "yellow",
            needsYou: true,
            ask: askOf(item),
          },
        ]
      : [],
  );
  return [
    leadRow(db, open, now),
    ...aboutRepository,
    ...live("needs you"),
    ...waiting.filter((row) => row.section === "needs you"),
    ...upNext,
    ...waiting.filter((row) => row.section === "backlog"),
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
  const backlog = rows.filter((row) => row.section === "backlog");
  const rest = backlog.length - backlogShown;
  if (whole || rest <= 0) return rows;
  const hidden = new Set(backlog.slice(backlogShown));
  const more: Row = {
    ...emptyRow,
    part: "backlog",
    section: "backlog",
    name: `${rest} more`,
    label: `${rest} more`,
    mark: { sign: "…", colour: "dim" },
    more: rest,
  };
  // The `… more` row goes where the first issue it stands for was, so it ends Backlog.
  return rows.flatMap((row) =>
    row === backlog[backlogShown] ? [more] : hidden.has(row) ? [] : [row],
  );
}

// What a row that isn't a task has: no title, word, agent or action.
const emptyRow: Row = {
  part: "lead",
  section: "lead",
  name: "",
  label: "",
  task: null,
  title: "",
  mark: { sign: "", colour: "dim" },
  says: "",
  colour: "dim",
  step: "",
  pr: "",
  ci: null,
  review: null,
  when: "",
  changed: null,
  needsYou: false,
  session: null,
  running: false,
  working: false,
  tmux: false,
  start: null,
  startNow: null,
  merge: null,
  link: null,
  branch: null,
  more: 0,
  place: null,
  waits: "",
  ask: null,
};

// Returns the rows the list shows, in the order it shows them: the lead's, then each section's
// heading, with an open section's rows under it. Needs you shows only while a task needs you, so
// an empty heading never asks for a look. Backlog is cut as cutBacklog says, unless
// `wholeBacklog`. A heading is a row of its own, so the arrows stop on it, and Enter there opens or
// closes its section, as a click does. Its name is no task's, nor the `… more` row's.
export function shownRows(all: Row[], opened: Set<Section>, wholeBacklog: boolean): Row[] {
  const cut = cutBacklog(all, wholeBacklog);
  const needing = cut.some((row) => row.section === "needs you");
  const heading = (section: Section): Row => ({
    ...emptyRow,
    part: "heading",
    section,
    name: `heading ${section}`,
  });
  return [
    ...cut.filter((row) => row.section === "lead"),
    ...sections.flatMap((section) => [
      ...(section === "needs you" && !needing ? [] : [heading(section)]),
      ...(opened.has(section) ? cut.filter((row) => row.section === section) : []),
    ]),
  ];
}

export type Heading = {
  section: Section;
  count: number;
  open: boolean;
  note: BuildersNote | null;
};

export function sectionHeadings(
  rows: Row[],
  opened: Set<Section>,
  builders: BuildersNote | null = null,
): Heading[] {
  return sections.flatMap((section) => {
    const ours = rows.filter((row) => row.section === section);
    if (section === "needs you" && ours.length === 0) return [];
    const note = section === "task queue" ? builders : null;
    const count = ours.length;
    return [{ section, count, open: opened.has(section), note }];
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
// as one repository's lead never mentions another's threads. Each of the lead's items needs you,
// whether on a thread, a task not started or the repository. A repository whose lead you exited
// has no tab until you open it again, except `keep`, the one the list shows, so the list never
// loses what it shows. The screen's sidebar keeps none: a tab that goes there is how it learns
// to move to another repository.
export function repositoryTabs(db: Database, keep: Open | null): Tab[] {
  const repositories = db
    .query(`SELECT name, owner, repo FROM repositories
      WHERE tab_closed = 0 OR (owner = ? AND repo = ?) ORDER BY name`)
    .all(keep?.owner ?? null, keep?.repo ?? null)
    .map((row) => TabRow.parse(row));
  // Each thread that isn't done gets the mark its row would have.
  const threads = db
    .query("SELECT * FROM task_threads WHERE status != 'done'")
    .all()
    .map((row) => Thread.parse(row));
  return repositories.map(({ name, owner, repo }) => {
    const ours = threads.filter((thread) => thread.owner === owner && thread.repo === repo);
    const items = itemsOf(db, owner, repo);
    const has = (thread: Thread) => items.some((item) => item.task === thread.task);
    const marks = ours.map((thread) =>
      has(thread) ? answerMark : shownOf(thread, limitOf(thread)).mark,
    );
    const apart = items.filter((item) => !ours.some((thread) => thread.task === item.task));
    const badge = badgeOf([...marks, ...apart.map(() => answerMark)]);
    return { name, fullName: `${owner}/${repo}`, ...badge };
  });
}
