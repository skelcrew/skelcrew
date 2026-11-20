// The rows of the list: what `sc` shows of one repository, read from Skelcrew's database and its
// copy of the tracker, never the tracker itself, as the list reads them again each second. Its
// lead, then its tasks by stage: Backlog, Building, Reviewing, Checks, Ready and Done, with how
// many each has and how many of those need you. Also a tab for each repository, with how many of
// its threads need you.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { openTasks, prOf } from "../flow/copy.ts";
import { reviewCheck } from "../flow/decide.ts";
import { leadOf } from "../flow/lead.ts";
import {
  type Badge,
  badgeOf,
  type Colour,
  type Mark,
  needsDecision,
  shownOf,
} from "../flow/marks.ts";
import { agentsSaid } from "../flow/merging.ts";
import { findRepository } from "../flow/repo.ts";
import type { DaemonRequest } from "../flow/requests.ts";
import { ListStage, listStage } from "../flow/stage.ts";
import { Thread } from "../flow/thread.ts";
import { forgeOf } from "../plugins/ask.ts";
import { changedAt, roundLimit as settingsRoundLimit } from "../screen/lists.ts";
import { removeControlCodes } from "../screen/look.ts";
import { builderProgress } from "../screen/progress.ts";

// What y does on a row once its question is answered: the question the bottom line asks, what it
// says while the daemon works, and the request the daemon gets.
export type Question = { ask: string; working: string; request: DaemonRequest };
// What m does on a task ready for review: asks, or says why it can't, such as for a PR whose
// forge plugin is too old to merge.
type Action = Question | { refused: string };

// One row of the list. `part` is where it is: the lead, or the stage of its task. Its mark is a
// sign and the colour that says what kind of state it is in, `says` is its short word, in
// `colour`, and `step` what its builder is doing, such as `Editing rows.ts`. Then dim its PR,
// such as `#41`, its CI, such as `CI passed`, and when it last changed, such as `14:31`. Each is
// empty where it has none. `needsYou` is whether it waits on you for something other than a
// merge. `session` is the agent's session, which Enter attaches to, `running` whether its agent
// runs, and `tmux` whether Enter attaches to it on tmux, where Ctrl-\ comes back, rather than on
// a runtime plugin's host, which has a key of its own. `start` is what Enter does on an issue,
// and `merge` what m does on a task ready for review. `link` is its PR's, which Enter opens, and
// `branch` the branch a task that is ready without a forge waits on. Each is null where it
// doesn't apply. `more` is how many issues the row stands for on the `… more` row at the end of
// a cut Backlog, which Enter shows, and 0 on every other row.
export type Row = {
  part: "lead" | ListStage;
  name: string;
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
    name: "lead",
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
  const ended = stage === "done";
  const word = ended ? (thread.merged ? "merged" : "closed") : shown.word;
  const mark: Mark = ended ? { sign: "○", colour: "dim" } : shown.mark;
  const needsYou = needsDecision(mark);
  const ready = stage === "ready" && !needsYou;
  const pr = thread.pr === null ? "" : `#${thread.pr}`;
  const copy = thread.pr === null ? null : prOf(db, open.owner, open.repo, thread.pr);
  const changed = thread.changed ?? thread.started;
  // The step comes from the builder's conversation file, read at most every 10 seconds, and only
  // while it works, as the sidebar reads it.
  const reviewed = word === "reviewing" || word === "queued for review";
  const stepping = word === "working" || (reviewed && shown.status === "working");
  const step = stepping ? removeControlCodes(builderProgress(thread, now).step ?? "") : "";
  // m merges the PR only at the commit Skelcrew's reviewer approved, and only while it is the
  // head the forge last sent and CI passed there, as the forge's copy of the PR shows. The thread's own verdict and checks can lag
  // behind a push, so they never stand for a newer head. A forge too old to send the head
  // commit can't merge either, as it lacks the call too.
  let merge: Action | null = null;
  if (ready && thread.pr !== null && copy !== null) {
    const named = `${repoName}#${thread.pr}`;
    // The commit the latest review approved, as the review saved it, so drawing the list asks
    // git nothing. An approval from before Skelcrew saved it has none, and merges on the forge.
    const approved = thread.verdict === "approve" ? thread.reviewed_commit : null;
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
      merge = { refused: `${named} has a newer commit than the one approved: wait for its review` };
    // No checks in the copy is a pass only for a repository whose polls never found CI. Otherwise
    // CI may not have started on the approved commit yet, or its checks went missing.
    else if (
      (ci.length === 0 && (thread.checks !== null || thread.ci_seen)) ||
      !ci.every((check) => check.state === "passed")
    )
      merge = { refused: `${named}'s checks haven't passed on the approved commit yet` };
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
      };
  }
  // A builder runs while its thread works or waits. One that stopped or failed doesn't.
  const runs = thread.status === "working" || thread.status === "waiting";
  return {
    part: stage,
    name,
    title: removeControlCodes(thread.short ?? thread.title ?? ""),
    mark,
    says: word,
    colour: mark.colour,
    step,
    pr,
    checks: thread.checks === null ? "" : ciWords[thread.checks],
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

// Returns the repository's rows as the database has them now, at a moment in milliseconds: its
// lead, then its tasks in the order of their stages. Backlog has its open issues no thread works
// on, newest first. Each other stage has those that need you first, so the list reaches them
// fastest, and within each, the one that changed last first. Done has the tasks that ended
// today, latest first, or the last ten when fewer ended today, so an old repository's history
// never fills the list. It reads the database, and a working builder's conversation file for its
// step, as the sidebar does, never tmux, so the list opens at once and works on any session
// host. Settings are read only for a thread that needs you while a review runs, to tell the
// round limit from another reason.
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
  const waiting = issues
    .map((issue) => ({ issue, name: `${repository.name}-${issue.id}` }))
    .filter(({ name }) => !tasks.some((row) => row.name === name))
    .map(({ issue, name }): Row => {
      const updated = Date.parse(issue.updated);
      return {
        part: "backlog",
        name,
        title: removeControlCodes(issue.title),
        mark: { sign: "○", colour: "dim" },
        says: "",
        colour: "dim",
        step: "",
        pr: "",
        checks: "",
        when: Number.isNaN(updated) ? "" : changedAt(updated, now),
        needsYou: false,
        session: null,
        running: false,
        tmux: false,
        start: {
          ask: `Start ${name}? y/n`,
          working: `Starting ${name}…`,
          request: { command: "start", repo: `${open.owner}/${open.repo}`, task: issue.id },
        },
        merge: null,
        link: null,
        branch: null,
        more: 0,
      };
    });
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
  // Returns a stage's live tasks, those that need you first, each part latest change first.
  const live = (stage: ListStage) => {
    const ours = tasks
      .filter((row) => row.part === stage)
      .sort((a, b) => changedOf(b) - changedOf(a));
    return [...ours.filter((row) => row.needsYou), ...ours.filter((row) => !row.needsYou)];
  };
  return [
    leadRow(db, open),
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
    name: `${rest} more`,
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
  };
  // The `… more` row goes where the first issue it stands for was, so it ends Backlog.
  return rows.flatMap((row) =>
    row === backlog[backlogShown] ? [more] : hidden.has(row) ? [] : [row],
  );
}

// A stage's heading: its stage, how many tasks it has and how many of them need you, and
// whether it is open, which shows its rows.
export type Heading = { stage: ListStage; count: number; needYou: number; open: boolean };

// Returns the heading of every stage, in order, from all the rows, whether their stage is open
// or not, given the stages that are open.
export function stageHeadings(rows: Row[], opened: Set<ListStage>): Heading[] {
  return ListStage.options.map((stage) => {
    const ours = rows.filter((row) => row.part === stage);
    const needYou = ours.filter((row) => row.needsYou).length;
    return { stage, count: ours.length, needYou, open: opened.has(stage) };
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
